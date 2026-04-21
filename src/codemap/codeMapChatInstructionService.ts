import * as path from 'path';
import * as vscode from 'vscode';
import type {
	ChatMemoryCodemapInstructionSummary,
	ChatMemoryCodemapRepositorySummary,
	ChatMemoryCodemapSummary,
	Prompt,
} from '../types/prompt.js';
import { summarizeUncommittedProjects } from '../utils/uncommittedChangesSummary.js';
import { resolveEffectiveProjectNames } from '../utils/projectScope.js';
import type { StorageService } from '../services/storageService.js';
import type { WorkspaceService } from '../services/workspaceService.js';
import type { GitService } from '../services/gitService.js';
import type {
	CodeMapArtifactKind,
	CodeMapInstructionKind,
	CodeMapMaterializationTarget,
	CodeMapRealtimeScheduledRefresh,
	StoredCodeMapInstruction,
} from '../types/codemap.js';
import { CodeMapDatabaseService } from './codeMapDatabaseService.js';
import { CodeMapBranchResolverService } from './codeMapBranchResolverService.js';
import { CodeMapInstructionService } from './codeMapInstructionService.js';
import { CodeMapMaterializerService } from './codeMapMaterializerService.js';
import { CodeMapOrchestratorService } from './codeMapOrchestratorService.js';
import { CODEMAP_CHAT_INSTRUCTION_FILE_NAME, getCodeMapSettings } from './codeMapConfig.js';
import { buildCodeMapGenerationFingerprint, isInstructionFreshForResolution } from './codeMapRefreshPolicy.js';
import { computeRealtimeRefreshTargetTime, shouldIgnoreRealtimeRefreshPath } from './codeMapRealtimeRefresh.js';

export class CodeMapChatInstructionService {
	private readonly realtimeTimers = new Map<string, NodeJS.Timeout>();
	private readonly realtimeLastQueuedAt = new Map<string, number>();
	private readonly realtimeScheduledRefreshes = new Map<string, CodeMapRealtimeScheduledRefresh>();

	constructor(
		private readonly storageService: StorageService,
		private readonly workspaceService: WorkspaceService,
		private readonly gitService: GitService,
		private readonly db: CodeMapDatabaseService,
		private readonly branchResolver: CodeMapBranchResolverService,
		private readonly instructionService: CodeMapInstructionService,
		private readonly materializer: CodeMapMaterializerService,
		private readonly orchestrator: CodeMapOrchestratorService,
	) { }

	dispose(): void {
		for (const timer of this.realtimeTimers.values()) {
			clearTimeout(timer);
		}
		this.realtimeTimers.clear();
		this.realtimeScheduledRefreshes.clear();
	}

	async prepareInstruction(prompt: Pick<Prompt, 'projects'>): Promise<ChatMemoryCodemapSummary | null> {
		const settings = getCodeMapSettings();
		const locale = vscode.env.language;
		const filePath = this.getInstructionFilePath();
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(filePath)));

		if (!settings.enabled) {
			await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from('', 'utf-8'));
			return null;
		}

		const projectPaths = this.workspaceService.getWorkspaceFolderPaths();
		const effectiveProjectNames = resolveEffectiveProjectNames(prompt.projects, Array.from(projectPaths.keys()));
		const resolutions = await this.branchResolver.resolveProjects(projectPaths, effectiveProjectNames, settings.trackedBranches);
		const uncommittedSnapshots = await this.gitService.getUncommittedProjectData(projectPaths, effectiveProjectNames);
		const materializationTargets: CodeMapMaterializationTarget[] = [];

		for (const resolution of resolutions) {
			const baseInstruction = this.db.getLatestInstruction(resolution.repository, resolution.resolvedBranchName, 'base', locale);
			const currentInstruction = resolution.currentBranch !== resolution.resolvedBranchName
				? this.db.getLatestInstruction(resolution.repository, resolution.currentBranch, 'delta', locale)
				: null;

			const queuedBaseRefresh = Boolean(settings.aiModel) && await this.shouldQueueBaseRefresh(resolution, baseInstruction)
				? this.orchestrator.queueInstruction(resolution, 'base', 'start-chat', settings.updatePriority)
				: false;
			const queuedCurrentRefresh = Boolean(settings.aiModel)
				&& resolution.currentBranch !== resolution.resolvedBranchName
				&& await this.shouldQueueCurrentRefresh(resolution, currentInstruction)
				? this.orchestrator.queueInstruction(resolution, 'delta', 'start-chat', settings.updatePriority)
				: false;

			const uncommittedSummary = buildUncommittedSummary(uncommittedSnapshots, resolution.repository);
			materializationTargets.push({
				resolution,
				baseInstruction,
				currentInstruction,
				uncommittedSummary,
				queuedBaseRefresh,
				queuedCurrentRefresh,
			});
		}

		const content = this.materializer.compose(materializationTargets, new Date().toISOString(), locale);
		await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(content, 'utf-8'));
		return this.buildChatMemoryCodemapSummary(materializationTargets, locale);
	}

	/** Build a compact codemap summary for the editor memory block. */
	private buildChatMemoryCodemapSummary(
		targets: CodeMapMaterializationTarget[],
		locale: string,
	): ChatMemoryCodemapSummary {
		const generationFingerprint = buildCodeMapGenerationFingerprint(getCodeMapSettings());
		const repositories = targets.map(target => this.buildChatMemoryCodemapRepositorySummary(target, locale, generationFingerprint));
		const sections = repositories.flatMap(repository => repository.sections);

		return {
			repositoryCount: repositories.length,
			instructionCount: sections.filter(section => section.exists || section.queuedRefresh).length,
			queuedRefreshCount: sections.filter(section => section.queuedRefresh).length,
			totalFileCount: sections.reduce((sum, section) => sum + section.fileCount, 0),
			describedFilesCount: sections.reduce((sum, section) => sum + section.describedFilesCount, 0),
			describedSymbolsCount: sections.reduce((sum, section) => sum + section.describedSymbolsCount, 0),
			describedMethodLikeCount: sections.reduce((sum, section) => sum + section.describedMethodLikeCount, 0),
			totalSizeBytes: sections.reduce((sum, section) => sum + section.sizeBytes, 0),
			totalCompressedSizeBytes: sections.reduce((sum, section) => sum + section.compressedSizeBytes, 0),
			repositories,
		};
	}

	/** Summarize codemap sections that can appear for a repository in the materialized chat file. */
	private buildChatMemoryCodemapRepositorySummary(
		target: CodeMapMaterializationTarget,
		locale: string,
		generationFingerprint: string,
	): ChatMemoryCodemapRepositorySummary {
		const sections: ChatMemoryCodemapInstructionSummary[] = [];
		const baseSection = this.buildChatMemoryCodemapInstructionSummary(
			target,
			target.baseInstruction,
			'base',
			target.queuedBaseRefresh,
			locale,
			generationFingerprint,
		);
		if (baseSection) {
			sections.push(baseSection);
		}

		if (target.resolution.currentBranch !== target.resolution.resolvedBranchName) {
			const currentSection = this.buildChatMemoryCodemapInstructionSummary(
				target,
				target.currentInstruction,
				'delta',
				target.queuedCurrentRefresh,
				locale,
				generationFingerprint,
			);
			if (currentSection) {
				sections.push(currentSection);
			}
		}

		return {
			repository: target.resolution.repository,
			currentBranch: target.resolution.currentBranch,
			resolvedBranchName: target.resolution.resolvedBranchName,
			baseBranchName: target.resolution.baseBranchName,
			sections,
		};
	}

	/** Summarize one codemap instruction section using persisted instruction metadata and branch artifacts. */
	private buildChatMemoryCodemapInstructionSummary(
		target: CodeMapMaterializationTarget,
		instruction: StoredCodeMapInstruction | null,
		fallbackKind: CodeMapInstructionKind,
		queuedRefresh: boolean,
		locale: string,
		generationFingerprint: string,
	): ChatMemoryCodemapInstructionSummary | null {
		if (!instruction && fallbackKind === 'delta' && !queuedRefresh) {
			return null;
		}

		const artifact = instruction
			? this.getBranchArtifactForInstruction(instruction, generationFingerprint)
			: null;
		const fileSummaries = artifact?.payload.codeDescription.fileSummaries || [];
		const describedSymbolsCount = fileSummaries.reduce((sum, file) => sum + file.symbols.length, 0);
		const describedMethodLikeCount = fileSummaries.reduce(
			(sum, file) => sum + file.symbols.filter(symbol => isMethodLikeCodemapSymbol(symbol.kind)).length,
			0,
		);

		return {
			branchName: instruction?.branchName || (fallbackKind === 'base'
				? target.resolution.resolvedBranchName
				: target.resolution.currentBranch),
			resolvedBranchName: instruction?.resolvedBranchName || target.resolution.resolvedBranchName,
			instructionKind: instruction?.instructionKind || fallbackKind,
			exists: Boolean(instruction),
			queuedRefresh,
			fileCount: instruction?.fileCount || 0,
			describedFilesCount: fileSummaries.length,
			describedSymbolsCount,
			describedMethodLikeCount,
			sizeBytes: instruction?.uncompressedSize || 0,
			compressedSizeBytes: instruction?.compressedSize || 0,
			generatedAt: instruction?.generatedAt,
			sourceCommitSha: instruction?.sourceCommitSha,
		};
	}

	/** Resolve the persisted branch artifact that matches the stored instruction. */
	private getBranchArtifactForInstruction(
		instruction: StoredCodeMapInstruction,
		fallbackGenerationFingerprint: string,
	) {
		const metadataGenerationFingerprint = typeof instruction.metadata?.generationFingerprint === 'string'
			? instruction.metadata.generationFingerprint.trim()
			: '';
		const generationFingerprint = metadataGenerationFingerprint || fallbackGenerationFingerprint;
		const metadataArtifactKind = typeof instruction.metadata?.artifactKind === 'string'
			? instruction.metadata.artifactKind.trim()
			: '';
		const artifactKind: CodeMapArtifactKind = metadataArtifactKind === 'delta' || metadataArtifactKind === 'full'
			? metadataArtifactKind
			: instruction.instructionKind === 'delta'
				? 'delta'
				: 'full';

		return this.db.getBranchArtifact(
			instruction.repository,
			instruction.branchName,
			artifactKind,
			instruction.locale,
			generationFingerprint,
		);
	}

	queueWorkspaceRefresh(): void {
		const settings = getCodeMapSettings();
		if (!settings.enabled || !settings.autoUpdate || !String(settings.aiModel || '').trim()) {
			return;
		}

		void this.queueTrackedBranchSnapshots(settings.trackedBranches, settings.updatePriority);
	}

	scheduleRealtimeRefreshForFile(fileUri: vscode.Uri): void {
		const settings = getCodeMapSettings();
		if (!settings.enabled || !settings.autoUpdate || !String(settings.aiModel || '').trim()) {
			return;
		}

		const target = this.resolveProjectForRealtimeFile(fileUri.fsPath);
		if (!target) {
			return;
		}

		const relativePath = normalizeRealtimePath(path.relative(target.projectPath, fileUri.fsPath));
		if (!relativePath || shouldIgnoreRealtimeRefreshPath(relativePath, settings.excludedPaths)) {
			return;
		}

		const nowMs = Date.now();
		const lastQueuedAtMs = this.realtimeLastQueuedAt.get(target.repository) || 0;
		const targetAtMs = computeRealtimeRefreshTargetTime(nowMs, lastQueuedAtMs);
		const existingTimer = this.realtimeTimers.get(target.repository);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		const delayMs = Math.max(0, targetAtMs - nowMs);
		this.realtimeScheduledRefreshes.set(target.repository, {
			repository: target.repository,
			changedAt: new Date(nowMs).toISOString(),
			dueAt: new Date(targetAtMs).toISOString(),
		});
		const timer = setTimeout(() => {
			this.realtimeTimers.delete(target.repository);
			this.realtimeScheduledRefreshes.delete(target.repository);
			void this.queueRealtimeRefreshForRepository(target.repository);
		}, delayMs);
		this.realtimeTimers.set(target.repository, timer);
	}

	getScheduledRealtimeRefreshes(): CodeMapRealtimeScheduledRefresh[] {
		return Array.from(this.realtimeScheduledRefreshes.values())
			.sort((left, right) => left.dueAt.localeCompare(right.dueAt));
	}

	private async shouldQueueBaseRefresh(resolution: CodeMapMaterializationTarget['resolution'], baseInstruction: CodeMapMaterializationTarget['baseInstruction']): Promise<boolean> {
		const settings = getCodeMapSettings();
		const fastFresh = isInstructionFreshForResolution({
			instruction: baseInstruction,
			resolution,
			instructionKind: 'base',
			settings,
		});
		if (fastFresh) {
			return false;
		}

		const expectedSnapshotToken = await this.instructionService.resolveSourceSnapshotToken(resolution.projectPath, resolution.resolvedBranchName);
		return !isInstructionFreshForResolution({
			instruction: baseInstruction,
			resolution: {
				...resolution,
				resolvedSourceSnapshotToken: expectedSnapshotToken,
			},
			instructionKind: 'base',
			settings,
		});
	}

	private async shouldQueueCurrentRefresh(resolution: CodeMapMaterializationTarget['resolution'], currentInstruction: CodeMapMaterializationTarget['currentInstruction']): Promise<boolean> {
		const settings = getCodeMapSettings();
		const fastFresh = isInstructionFreshForResolution({
			instruction: currentInstruction,
			resolution,
			instructionKind: 'delta',
			settings,
		});
		if (fastFresh) {
			return false;
		}

		const expectedSnapshotToken = await this.instructionService.resolveSourceSnapshotToken(resolution.projectPath, resolution.currentBranch);
		return !isInstructionFreshForResolution({
			instruction: currentInstruction,
			resolution: {
				...resolution,
				currentSourceSnapshotToken: expectedSnapshotToken,
			},
			instructionKind: 'delta',
			settings,
		});
	}

	private getInstructionFilePath(): string {
		return path.join(this.storageService.getStorageDirectoryPath(), 'chat-memory', CODEMAP_CHAT_INSTRUCTION_FILE_NAME);
	}

	private resolveProjectForRealtimeFile(filePath: string): { repository: string; projectPath: string } | null {
		const normalizedFilePath = path.resolve(filePath);
		let bestMatch: { repository: string; projectPath: string } | null = null;

		for (const [repository, projectPath] of this.workspaceService.getWorkspaceFolderPaths().entries()) {
			const normalizedProjectPath = path.resolve(projectPath);
			const relativePath = path.relative(normalizedProjectPath, normalizedFilePath);
			if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
				continue;
			}

			if (!bestMatch || normalizedProjectPath.length > bestMatch.projectPath.length) {
				bestMatch = {
					repository,
					projectPath: normalizedProjectPath,
				};
			}
		}

		return bestMatch;
	}

	private async queueRealtimeRefreshForRepository(repository: string): Promise<void> {
		const settings = getCodeMapSettings();
		if (!settings.enabled || !settings.autoUpdate || !String(settings.aiModel || '').trim()) {
			return;
		}

		this.realtimeScheduledRefreshes.delete(repository);

		const projectPaths = this.workspaceService.getWorkspaceFolderPaths();
		if (!projectPaths.has(repository)) {
			return;
		}

		const resolutions = await this.branchResolver.resolveProjects(projectPaths, [repository], settings.trackedBranches);
		const resolution = resolutions[0];
		if (!resolution) {
			return;
		}

		const instructionKind: CodeMapInstructionKind = resolution.currentBranch === resolution.resolvedBranchName
			? 'base'
			: 'delta';
		const queued = this.orchestrator.queueInstruction(
			resolution,
			instructionKind,
			'realtime',
			settings.updatePriority,
		);
		if (queued) {
			this.realtimeLastQueuedAt.set(repository, Date.now());
		}
	}

	private async queueTrackedBranchSnapshots(trackedBranches: string[], updatePriority: ReturnType<typeof getCodeMapSettings>['updatePriority']): Promise<void> {
		if (trackedBranches.length === 0) {
			return;
		}

		const locale = vscode.env.language;
		const projectPaths = this.workspaceService.getWorkspaceFolderPaths();
		const resolutions = await this.branchResolver.resolveTrackedBranchSnapshots(projectPaths, trackedBranches);
		for (const resolution of resolutions) {
			const latestInstruction = this.db.getLatestInstruction(resolution.repository, resolution.resolvedBranchName, 'base', locale);
			if (await this.shouldQueueBaseRefresh(resolution, latestInstruction)) {
				this.orchestrator.queueInstruction(resolution, 'base', 'startup', updatePriority);
			}
		}
	}
}

function normalizeRealtimePath(value: string): string {
	return String(value || '')
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\.\/+/, '')
		.replace(/^\/+/, '')
		.replace(/\/+$/g, '');
}

function buildUncommittedSummary(
	snapshots: Awaited<ReturnType<GitService['getUncommittedProjectData']>>,
	repository: string,
): string {
	const projectSnapshot = snapshots.find(item => item.project === repository);
	if (!projectSnapshot) {
		return '';
	}

	const summary = summarizeUncommittedProjects([projectSnapshot], {
		maxProjects: 1,
		maxFilesPerProject: 6,
		maxAreasPerFile: 3,
		maxSymbolsPerFile: 3,
	});

	return JSON.stringify(summary, null, 2);
}

/** Heuristic grouping for symbol kinds that behave like methods or functions in UI copy. */
function isMethodLikeCodemapSymbol(kind: string): boolean {
	const normalizedKind = String(kind || '').trim().toLowerCase();
	if (!normalizedKind) {
		return false;
	}

	return /(method|function|constructor|hook|procedure|callback|handler|getter|setter)/.test(normalizedKind);
}
