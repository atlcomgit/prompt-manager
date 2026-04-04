import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ignore from 'ignore';
import { buildAsciiTree, type AsciiTreeItem } from '../utils/asciiTree.js';
import type {
	CodeMapAreaSummary as CodeAreaSummary,
	CodeMapBranchArtifactPayload,
	CodeMapBranchResolution,
	CodeMapFileSummary as FileSummary,
	CodeMapFileSymbolSummary as FileSymbolSummary,
	CodeMapFrontendBlockSummary as FrontendBlockSummary,
	CodeMapInstructionKind,
	CodeMapInstructionRecord,
	CodeMapProjectDescription as ProjectCodeDescription,
	CodeMapRefDiffEntry,
	StoredCodeMapBranchArtifact,
} from '../types/codemap.js';
import type { AiService } from '../services/aiService.js';
import { normalizeOptionalCopilotModelFamily } from '../constants/ai.js';
import { getCodeMapSettings } from './codeMapConfig.js';
import { buildCodeMapGenerationFingerprint, resolveInstructionSnapshotToken } from './codeMapRefreshPolicy.js';
import { buildCodeMapRelationBlock, buildLegacyRelationsFromRelationBlock } from './codeMapRelationBuilder.js';
import type { CodeMapDatabaseService } from './codeMapDatabaseService.js';

const execFileAsync = promisify(execFile);
const MAX_TREE_ITEMS = 400;
const MAX_DEPENDENCY_ITEMS = 20;
const MAX_SCRIPT_ITEMS = 12;
const MAX_AREA_COUNT = 6;
const MAX_FILES_PER_AREA = 3;
const MAX_SYMBOLS_PER_AREA = 6;
const MAX_FILE_SNIPPET_BYTES = 12 * 1024;
const MAX_SYMBOLS_PER_FILE = 10;
const MAX_FRONTEND_BLOCKS_PER_FILE = 8;
const MAX_RELATIONS = 24;
const MAX_RECENT_CHANGES = 10;
const MAX_FILE_SUMMARY_COUNT = 36;
const MAX_SYMBOL_SNIPPET_CHARS = 900;
const MAX_REUSE_CHANGED_FILES = 200;
const MAX_REUSE_CHANGED_RATIO = 0.35;
const ANONYMOUS_CLASS_SYMBOL_NAME = '__anonymous_class__';
const VOID_HTML_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

interface PackageManifest {
	name?: string;
	description?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

interface ComposerManifest {
	name?: string;
	description?: string;
	scripts?: Record<string, string | string[]>;
	require?: Record<string, string>;
	requireDev?: Record<string, string>;
}

export interface CodeMapAreaDescriptionBatchItem {
	id: string;
	area: string;
	manifestDescription?: string;
	representativeFiles: string[];
	symbols: string[];
	snippets: Array<{ filePath: string; snippet: string }>;
}

interface PreparedCodeMapAreaDescription extends CodeMapAreaDescriptionBatchItem {
	fileCount: number;
	fallback: string;
}

interface PreparedFileSymbolSummary extends FileSymbolSummary {
	id: string;
	filePath: string;
	fileRole: string;
	excerpt: string;
	fallbackDescription: string;
}

interface CodeMapFileBatchItem {
	id: string;
	filePath: string;
	fileRole: string;
	lineCount: number;
	imports: string[];
	frontendContract: string[];
	frontendBlockNames: string[];
	excerpt: string;
	fallbackDescription: string;
	symbols: CodeMapSymbolBatchItem[];
}

interface PreparedFrontendBlockSummary extends FrontendBlockSummary {
	id: string;
	filePath: string;
	fileRole: string;
	framework: 'vue' | 'html' | 'blade';
	excerpt: string;
	linkedScriptSnippets: string[];
	fallbackDescription: string;
}

interface PreparedFileSummary extends FileSummary {
	description: string;
	fileDescriptionId: string;
	excerpt: string;
	symbols: PreparedFileSymbolSummary[];
	frontendContract: string[];
	frontendBlocks: PreparedFrontendBlockSummary[];
}

interface CodeMapSymbolBatchItem {
	id: string;
	filePath: string;
	fileRole: string;
	kind: string;
	name: string;
	signature: string;
	excerpt: string;
	fallbackDescription: string;
}

interface CodeMapFrontendBlockBatchItem {
	id: string;
	filePath: string;
	fileRole: string;
	framework: 'vue' | 'html' | 'blade';
	blockKind: string;
	blockName: string;
	purpose: string;
	stateDeps: string[];
	eventHandlers: string[];
	dataSources: string[];
	childComponents: string[];
	conditions: string[];
	routes: string[];
	forms: string[];
	excerpt: string;
	linkedScriptSnippets: string[];
	fallbackDescription: string;
}

interface RoutineSignatureInfo {
	params: string[];
	returnType: string;
}

interface RoutineBodySignals {
	hasBranches: boolean;
	hasLoops: boolean;
	hasAssertions: boolean;
	hasAwait: boolean;
	hasThrows: boolean;
	returnsValue: boolean;
	directReturnParam: string;
	containerClasses: string[];
	callTargets: string[];
	instantiatedClasses: string[];
	touchesPersistence: boolean;
	buildsResponse: boolean;
	validatesInput: boolean;
	dispatchesWork: boolean;
}

interface FrontendFileSections {
	framework: 'vue' | 'html' | 'blade';
	templateSource: string;
	templateOffset: number;
	scriptSource: string;
}

interface FrontendScriptIndex {
	props: string[];
	stateNames: string[];
	eventHandlerSnippets: Map<string, string>;
	handlerDataSources: Map<string, string[]>;
	dataSources: string[];
	routes: string[];
	contract: string[];
}

interface FrontendTemplateCandidate {
	tagName: string;
	attrs: string;
	startIndex: number;
	endIndex: number;
	startTagEnd: number;
	location: { line: number; column: number };
	excerpt: string;
	score: number;
}

interface CodeMapGenerationProgress {
	stage: string;
	detail?: string;
	completed?: number;
	total?: number;
}

interface GitIgnoreMatcherEntry {
	basePath: string;
	depth: number;
	matcher: ReturnType<typeof ignore>;
}

interface RefSnapshot {
	ref: string;
	headSha: string;
	treeSha: string;
	rawFiles: string[];
	filteredFiles: string[];
	analysisFiles: string[];
	blobShaByFile: Map<string, string>;
	sourceSnapshotToken: string;
	manifest: PackageManifest | null;
	composerManifest: ComposerManifest | null;
}

interface ReuseContext {
	sourceArtifact: StoredCodeMapBranchArtifact;
	diffEntries: CodeMapRefDiffEntry[];
	changedFiles: Set<string>;
	deletedFiles: string[];
	renamedFiles: Array<{ from: string; to: string }>;
}

export class CodeMapInstructionService {
	constructor(
		private readonly aiService?: AiService,
		private readonly db?: CodeMapDatabaseService,
	) { }

	async resolveAiModel(aiModel: string): Promise<string> {
		if (this.aiService && typeof (this.aiService as { resolveFreeCopilotModel?: unknown }).resolveFreeCopilotModel === 'function') {
			return this.aiService.resolveFreeCopilotModel(aiModel);
		}

		return normalizeOptionalCopilotModelFamily(aiModel);
	}

	async resolveSourceSnapshotToken(projectPath: string, ref: string): Promise<string> {
		const snapshot = await this.collectRefSnapshot(projectPath, ref);
		return snapshot.sourceSnapshotToken;
	}

	async generateInstruction(
		resolution: CodeMapBranchResolution,
		instructionKind: CodeMapInstructionKind,
		locale: string,
		aiModel: string,
		onProgress?: (progress: CodeMapGenerationProgress) => void,
	): Promise<CodeMapInstructionRecord> {
		const isRussianLocale = locale.toLowerCase().startsWith('ru');
		const resolvedAiModel = await this.resolveAiModel(aiModel);
		const settings = getCodeMapSettings();
		const branchName = instructionKind === 'base'
			? resolution.resolvedBranchName
			: resolution.currentBranch;
		const headSha = instructionKind === 'base'
			? resolution.resolvedHeadSha
			: resolution.currentHeadSha;
		onProgress?.({
			stage: 'collecting-files',
			detail: isRussianLocale
				? `Подготавливается git-снимок ${resolution.repository}:${branchName}`
				: `Preparing git snapshot for ${resolution.repository}:${branchName}`,
		});
		const snapshot = await this.collectRefSnapshot(resolution.projectPath, branchName, headSha);
		const excludedCount = Math.max(0, snapshot.rawFiles.length - snapshot.filteredFiles.length);
		onProgress?.({
			stage: 'collecting-files',
			detail: isRussianLocale
				? `Найдено ${snapshot.rawFiles.length} файлов, после исключений осталось ${snapshot.filteredFiles.length}, к анализу отобрано ${snapshot.analysisFiles.length}${excludedCount > 0 ? ` (исключено ${excludedCount})` : ''}`
				: `Discovered ${snapshot.rawFiles.length} files, ${snapshot.filteredFiles.length} remain after exclusions, selected ${snapshot.analysisFiles.length} for analysis${excludedCount > 0 ? ` (${excludedCount} excluded)` : ''}`,
		});
		const generationFingerprint = buildCodeMapGenerationFingerprint(settings);
		const reuseContext = await this.selectReuseContext({
			repository: resolution.repository,
			projectPath: resolution.projectPath,
			branchName,
			resolution,
			instructionKind,
			locale,
			generationFingerprint,
			snapshot,
		});
		onProgress?.({
			stage: 'describing-areas',
			detail: isRussianLocale
				? `Подготавливаются области кода для ${resolution.repository}:${branchName}${reuseContext ? ` (reuse from ${reuseContext.sourceArtifact.branchName})` : ''}`
				: `Preparing code areas for ${resolution.repository}:${branchName}${reuseContext ? ` (reuse from ${reuseContext.sourceArtifact.branchName})` : ''}`,
			completed: 0,
			total: Math.max(1, Math.min(MAX_AREA_COUNT, buildAreaEntries(
				instructionKind === 'delta' && reuseContext
					? snapshot.analysisFiles.filter(filePath => reuseContext.changedFiles.has(filePath))
					: snapshot.analysisFiles,
			).length)),
		});
		const codeDescription = await this.describeProjectCode({
			repository: resolution.repository,
			projectPath: resolution.projectPath,
			ref: branchName,
			snapshot,
			manifest: snapshot.manifest,
			composerManifest: snapshot.composerManifest,
			locale,
			aiModel: resolvedAiModel,
			instructionKind,
			reuseContext,
			onProgress,
		});
		const sourceSnapshotToken = snapshot.sourceSnapshotToken;
		const generatedAt = new Date().toISOString();
		onProgress?.({
			stage: 'assembling-instruction',
			detail: isRussianLocale
				? 'Собираются итоговые разделы инструкции и дерево структуры проекта'
				: 'Assembling final instruction sections and the project structure tree',
		});
		const content = instructionKind === 'delta' && resolution.currentBranch !== resolution.resolvedBranchName
			? buildCodeMapDeltaInstruction({
				repository: resolution.repository,
				branchName,
				baseBranchName: resolution.resolvedBranchName,
				generatedAt,
				headSha,
				locale,
				files: snapshot.filteredFiles,
				codeDescription,
				diffEntries: reuseContext?.diffEntries || [],
				changedFiles: reuseContext?.changedFiles ? Array.from(reuseContext.changedFiles).sort((left, right) => left.localeCompare(right)) : [],
				deletedFiles: reuseContext?.deletedFiles || [],
				renamedFiles: reuseContext?.renamedFiles || [],
				basedOnBranchName: reuseContext?.sourceArtifact.branchName || resolution.resolvedBranchName,
			})
			: buildCodeMapProjectInstruction({
				repository: resolution.repository,
				branchName,
				resolvedBranchName: resolution.resolvedBranchName,
				baseBranchName: resolution.baseBranchName,
				instructionKind,
				branchRole: instructionKind === 'base' ? resolution.branchRole : 'current',
				generatedAt,
				headSha,
				locale,
				files: snapshot.filteredFiles,
				manifest: snapshot.manifest,
				composerManifest: snapshot.composerManifest,
				codeDescription,
			});
		this.persistBranchArtifact(
			resolution.repository,
			branchName,
			instructionKind === 'delta' ? 'delta' : 'full',
			locale,
			generationFingerprint,
			this.buildBranchArtifactPayload({
				repository: resolution.repository,
				branchName,
				instructionKind,
				snapshot,
				codeDescription,
				reuseContext,
			}),
			{
				sourceSnapshotToken,
				treeSha: snapshot.treeSha,
				headSha: headSha || snapshot.headSha,
				basedOnBranchName: reuseContext?.sourceArtifact.branchName,
				basedOnSnapshotToken: reuseContext?.sourceArtifact.sourceSnapshotToken,
				generatedAt,
			},
		);

		return {
			repository: resolution.repository,
			branchName,
			resolvedBranchName: resolution.resolvedBranchName,
			baseBranchName: resolution.baseBranchName,
			branchRole: instructionKind === 'base' ? resolution.branchRole : 'current',
			instructionKind,
			locale,
			aiModel: resolvedAiModel,
			content,
			contentHash: '',
			generatedAt,
			sourceCommitSha: headSha,
			fileCount: snapshot.filteredFiles.length,
			metadata: {
				manifestName: snapshot.manifest?.name || snapshot.composerManifest?.name || '',
				fileGroups: codeDescription.areas.map(area => ({ group: area.area, count: area.fileCount })),
				sourceSnapshotToken: sourceSnapshotToken || resolveInstructionSnapshotToken(resolution, instructionKind),
				treeSha: snapshot.treeSha,
				headSha: headSha || snapshot.headSha,
				generationFingerprint,
				basedOnBranchName: reuseContext?.sourceArtifact.branchName || undefined,
				basedOnSnapshotToken: reuseContext?.sourceArtifact.sourceSnapshotToken || undefined,
				artifactKind: instructionKind === 'delta' ? 'delta' : 'full',
				generatedBy: 'codemap-bootstrap',
			},
		};
	}

	private async collectRefSnapshot(projectPath: string, ref: string, headSha = ''): Promise<RefSnapshot> {
		const settings = getCodeMapSettings();
		const rawFiles = await this.getFilesAtRef(projectPath, ref);
		const filteredFiles = await this.filterFilesForCodeMap(projectPath, ref, rawFiles, settings.excludedPaths);
		const blobShaByFile = await this.getFileBlobShasAtRef(projectPath, ref, filteredFiles);
		return {
			ref,
			headSha: headSha || await this.getHeadShaAtRef(projectPath, ref),
			treeSha: await this.getTreeShaAtRef(projectPath, ref),
			rawFiles,
			filteredFiles,
			analysisFiles: selectFilesForAnalysis(filteredFiles),
			blobShaByFile,
			sourceSnapshotToken: await this.buildSourceSnapshotTokenForFiles(projectPath, ref, rawFiles, filteredFiles, settings.excludedPaths),
			manifest: await this.readJsonAtRef<PackageManifest>(projectPath, ref, 'package.json'),
			composerManifest: await this.readJsonAtRef<ComposerManifest>(projectPath, ref, 'composer.json'),
		};
	}

	private async getFilesAtRef(projectPath: string, ref: string): Promise<string[]> {
		const snapshot = await this.getGitTreeSnapshot(projectPath, ref);
		return Array.from(snapshot.keys()).sort((left, right) => left.localeCompare(right));
	}

	private async getGitTreeSnapshot(projectPath: string, ref: string): Promise<Map<string, string>> {
		try {
			const { stdout } = await execFileAsync('git', ['ls-tree', '-r', ref], { cwd: projectPath, maxBuffer: 12 * 1024 * 1024 });
			const snapshot = new Map<string, string>();
			for (const line of stdout.split(/\r?\n/)) {
				const match = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t(.+)$/i);
				if (!match?.[1] || !match[2]) {
					continue;
				}
				snapshot.set(match[2], match[1]);
			}
			return snapshot;
		} catch {
			return new Map();
		}
	}

	private async readJsonAtRef<T>(projectPath: string, ref: string, filePath: string): Promise<T | null> {
		try {
			const { stdout } = await execFileAsync('git', ['show', `${ref}:${filePath}`], { cwd: projectPath, maxBuffer: 2 * 1024 * 1024 });
			return JSON.parse(stdout) as T;
		} catch {
			return null;
		}
	}

	private async filterFilesForCodeMap(projectPath: string, ref: string, files: string[], excludedPaths: string[]): Promise<string[]> {
		if (files.length === 0) {
			return [];
		}

		const normalizedExcludedPaths = normalizeExcludedPaths(excludedPaths);
		const gitIgnoreMatchers = await this.readGitIgnoreMatchersAtRef(projectPath, ref, files, normalizedExcludedPaths);
		return files.filter(filePath => !isGitIgnoreFile(filePath) && !matchesConfiguredExclusion(filePath, normalizedExcludedPaths) && !isIgnoredByGitIgnore(filePath, gitIgnoreMatchers));
	}

	private async buildSourceSnapshotTokenForFiles(
		projectPath: string,
		ref: string,
		rawFiles: string[],
		filteredFiles: string[],
		excludedPaths: string[],
	): Promise<string> {
		const normalizedExcludedPaths = normalizeExcludedPaths(excludedPaths);
		const fileBlobShas = await this.getFileBlobShasAtRef(projectPath, ref, filteredFiles);
		const gitIgnoreFiles = collectGitIgnoreFiles(rawFiles, normalizedExcludedPaths);
		const gitIgnoreBlobShas = await this.getFileBlobShasAtRef(projectPath, ref, gitIgnoreFiles);
		return buildCodeMapSourceSnapshotToken(filteredFiles, fileBlobShas, gitIgnoreFiles, gitIgnoreBlobShas);
	}

	private buildSourceSnapshotTokenFromSnapshot(
		rawFiles: string[],
		filteredFiles: string[],
		treeSnapshot: ReadonlyMap<string, string>,
		excludedPaths: string[],
	): string {
		const normalizedExcludedPaths = normalizeExcludedPaths(excludedPaths);
		const gitIgnoreFiles = collectGitIgnoreFiles(rawFiles, normalizedExcludedPaths);
		const fileBlobShas = new Map(filteredFiles.map(filePath => [filePath, String(treeSnapshot.get(filePath) || '').trim()]));
		const gitIgnoreBlobShas = new Map(gitIgnoreFiles.map(filePath => [filePath, String(treeSnapshot.get(filePath) || '').trim()]));
		return buildCodeMapSourceSnapshotToken(filteredFiles, fileBlobShas, gitIgnoreFiles, gitIgnoreBlobShas);
	}

	private async readGitIgnoreMatchersAtRef(
		projectPath: string,
		ref: string,
		files: string[],
		excludedPaths: string[],
	): Promise<GitIgnoreMatcherEntry[]> {
		const matchers: GitIgnoreMatcherEntry[] = [];
		for (const gitIgnoreFile of collectGitIgnoreFiles(files, excludedPaths)) {
			const content = await this.readTextAtRef(projectPath, ref, gitIgnoreFile);
			if (!content.trim()) {
				continue;
			}
			const matcher = ignore();
			matcher.add(content);
			matchers.push({
				basePath: getParentDirectory(gitIgnoreFile),
				depth: gitIgnoreFile.split('/').length,
				matcher,
			});
		}
		return matchers.sort((left, right) => left.depth - right.depth || left.basePath.localeCompare(right.basePath));
	}

	private async getHeadShaAtRef(projectPath: string, ref: string): Promise<string> {
		try {
			const { stdout } = await execFileAsync('git', ['rev-parse', ref], { cwd: projectPath });
			return stdout.trim();
		} catch {
			return '';
		}
	}

	private async getTreeShaAtRef(projectPath: string, ref: string): Promise<string> {
		try {
			const { stdout } = await execFileAsync('git', ['rev-parse', `${ref}^{tree}`], { cwd: projectPath });
			return stdout.trim();
		} catch {
			return '';
		}
	}

	private async getNameStatusDiff(projectPath: string, fromRef: string, toRef: string): Promise<CodeMapRefDiffEntry[]> {
		try {
			const { stdout } = await execFileAsync('git', ['diff', '--name-status', '--find-renames', fromRef, toRef], { cwd: projectPath, maxBuffer: 4 * 1024 * 1024 });
			return stdout
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean)
				.map((line) => {
					const parts = line.split('\t');
					const normalizedStatus = ((parts[0] || '').trim()[0] || 'M') as CodeMapRefDiffEntry['status'];
					if ((normalizedStatus === 'R' || normalizedStatus === 'C') && parts[2]) {
						return {
							status: normalizedStatus,
							oldPath: parts[1] || '',
							path: parts[2] || '',
						};
					}
					return {
						status: normalizedStatus,
						path: parts[1] || '',
					};
				})
				.filter(entry => Boolean(entry.path));
		} catch {
			return [];
		}
	}

	private async selectReuseContext(input: {
		repository: string;
		projectPath: string;
		branchName: string;
		resolution: CodeMapBranchResolution;
		instructionKind: CodeMapInstructionKind;
		locale: string;
		generationFingerprint: string;
		snapshot: RefSnapshot;
	}): Promise<ReuseContext | null> {
		if (!this.db || !input.generationFingerprint || typeof (this.db as { getBranchArtifact?: unknown }).getBranchArtifact !== 'function') {
			return null;
		}

		if (input.instructionKind === 'delta' && input.resolution.currentBranch !== input.resolution.resolvedBranchName) {
			const baseArtifact = this.db.getBranchArtifact(input.repository, input.resolution.resolvedBranchName, 'full', input.locale, input.generationFingerprint);
			if (!baseArtifact) {
				return null;
			}
			const diffEntries = await this.getNameStatusDiff(input.projectPath, baseArtifact.headSha || input.resolution.resolvedBranchName, input.snapshot.headSha || input.branchName);
			return this.buildReuseContext(baseArtifact, diffEntries, input.snapshot.analysisFiles.length);
		}

		const sameBranchArtifact = this.db.getBranchArtifact(input.repository, input.branchName, 'full', input.locale, input.generationFingerprint);
		if (sameBranchArtifact) {
			const diffEntries = await this.getNameStatusDiff(input.projectPath, sameBranchArtifact.headSha || input.branchName, input.snapshot.headSha || input.branchName);
			const context = this.buildReuseContext(sameBranchArtifact, diffEntries, input.snapshot.analysisFiles.length);
			if (context) {
				return context;
			}
		}

		const siblingArtifact = await this.findNearestTrackedArtifact(
			input.repository,
			input.projectPath,
			input.branchName,
			input.locale,
			input.generationFingerprint,
		);
		if (!siblingArtifact) {
			return null;
		}
		const diffEntries = await this.getNameStatusDiff(input.projectPath, siblingArtifact.headSha || siblingArtifact.branchName, input.snapshot.headSha || input.branchName);
		return this.buildReuseContext(siblingArtifact, diffEntries, input.snapshot.analysisFiles.length);
	}

	private async findNearestTrackedArtifact(
		repository: string,
		projectPath: string,
		currentBranch: string,
		locale: string,
		generationFingerprint: string,
	): Promise<StoredCodeMapBranchArtifact | null> {
		if (!this.db) {
			return null;
		}

		const trackedBranches = getCodeMapSettings().trackedBranches;
		const candidates: Array<{ artifact: StoredCodeMapBranchArtifact; distance: number; totalDistance: number }> = [];
		for (const branchName of trackedBranches) {
			if (!branchName || branchName === currentBranch) {
				continue;
			}

			const artifact = this.db.getBranchArtifact(repository, branchName, 'full', locale, generationFingerprint);
			if (!artifact) {
				continue;
			}

			const mergeBase = await this.getMergeBase(projectPath, currentBranch, branchName);
			if (!mergeBase) {
				continue;
			}

			const distance = await this.getRevisionCount(projectPath, `${mergeBase}..${currentBranch}`);
			const totalDistance = distance + await this.getRevisionCount(projectPath, `${mergeBase}..${branchName}`);
			candidates.push({ artifact, distance, totalDistance });
		}

		candidates.sort((left, right) => left.distance - right.distance || left.totalDistance - right.totalDistance);
		return candidates[0]?.artifact || null;
	}

	private buildReuseContext(
		sourceArtifact: StoredCodeMapBranchArtifact,
		diffEntries: CodeMapRefDiffEntry[],
		analysisFileCount: number,
	): ReuseContext | null {
		if (diffEntries.some(entry => this.isReuseBoundaryPath(entry.path) || this.isReuseBoundaryPath(entry.oldPath || ''))) {
			return null;
		}

		const changedFiles = new Set<string>();
		const deletedFiles: string[] = [];
		const renamedFiles: Array<{ from: string; to: string }> = [];
		for (const entry of diffEntries) {
			switch (entry.status) {
				case 'D':
					deletedFiles.push(entry.path);
					break;
				case 'R':
					if (entry.oldPath) {
						renamedFiles.push({ from: entry.oldPath, to: entry.path });
					}
					changedFiles.add(entry.path);
					break;
				default:
					changedFiles.add(entry.path);
					break;
			}
		}

		if (changedFiles.size > MAX_REUSE_CHANGED_FILES) {
			return null;
		}

		const changeRatio = analysisFileCount > 0 ? changedFiles.size / Math.max(analysisFileCount, 1) : 0;
		if (changeRatio > MAX_REUSE_CHANGED_RATIO) {
			return null;
		}

		return {
			sourceArtifact,
			diffEntries,
			changedFiles,
			deletedFiles: deletedFiles.sort((left, right) => left.localeCompare(right)),
			renamedFiles: renamedFiles.sort((left, right) => left.to.localeCompare(right.to)),
		};
	}

	private isReuseBoundaryPath(filePath: string): boolean {
		const normalized = String(filePath || '').trim().toLowerCase();
		return normalized === 'package.json'
			|| normalized === 'composer.json'
			|| normalized === '.gitignore'
			|| /\/\.gitignore$/.test(normalized);
	}

	private async getMergeBase(projectPath: string, left: string, right: string): Promise<string> {
		try {
			const { stdout } = await execFileAsync('git', ['merge-base', left, right], { cwd: projectPath });
			return stdout.trim();
		} catch {
			return '';
		}
	}

	private async getRevisionCount(projectPath: string, revisionRange: string): Promise<number> {
		try {
			const { stdout } = await execFileAsync('git', ['rev-list', '--count', revisionRange], { cwd: projectPath });
			return Number.parseInt(stdout.trim(), 10) || 0;
		} catch {
			return Number.MAX_SAFE_INTEGER;
		}
	}

	private getReusableFileSummary(reuseContext: ReuseContext | null | undefined, filePath: string, blobSha: string): FileSummary | null {
		if (!reuseContext || !blobSha || reuseContext.changedFiles.has(filePath)) {
			return null;
		}

		const sourceBlobSha = String(reuseContext.sourceArtifact.payload.blobShaByFile[filePath] || '').trim();
		if (!sourceBlobSha || sourceBlobSha !== blobSha) {
			return null;
		}

		return normalizeCachedFileSummary(reuseContext.sourceArtifact.payload.codeDescription.fileSummaries.find(item => item.path === filePath) || null);
	}

	private getReusableAreaSummary(
		reuseContext: ReuseContext | null | undefined,
		areaKey: string,
		areaFiles: string[],
		fileBlobShas: ReadonlyMap<string, string>,
	): CodeAreaSummary | null {
		if (!reuseContext || areaFiles.some(filePath => reuseContext.changedFiles.has(filePath))) {
			return null;
		}

		for (const filePath of areaFiles) {
			const targetBlobSha = String(fileBlobShas.get(filePath) || '').trim();
			const sourceBlobSha = String(reuseContext.sourceArtifact.payload.blobShaByFile[filePath] || '').trim();
			if (!targetBlobSha || !sourceBlobSha || targetBlobSha !== sourceBlobSha) {
				return null;
			}
		}

		const areaSummary = reuseContext.sourceArtifact.payload.codeDescription.areas.find(item => item.area === areaKey && item.fileCount === areaFiles.length) || null;
		return normalizeCachedAreaSummary(areaSummary);
	}

	private buildBranchArtifactPayload(input: {
		repository: string;
		branchName: string;
		instructionKind: CodeMapInstructionKind;
		snapshot: RefSnapshot;
		codeDescription: ProjectCodeDescription;
		reuseContext?: ReuseContext | null;
	}): CodeMapBranchArtifactPayload {
		return {
			artifactKind: input.instructionKind === 'delta' ? 'delta' : 'full',
			repository: input.repository,
			branchName: input.branchName,
			headSha: input.snapshot.headSha,
			treeSha: input.snapshot.treeSha,
			sourceSnapshotToken: input.snapshot.sourceSnapshotToken,
			basedOnBranchName: input.reuseContext?.sourceArtifact.branchName || undefined,
			basedOnSnapshotToken: input.reuseContext?.sourceArtifact.sourceSnapshotToken || undefined,
			files: [...input.snapshot.filteredFiles],
			analysisFiles: [...input.snapshot.analysisFiles],
			blobShaByFile: Object.fromEntries(input.snapshot.blobShaByFile.entries()),
			manifest: input.snapshot.manifest as Record<string, unknown> | null,
			composerManifest: input.snapshot.composerManifest as Record<string, unknown> | null,
			codeDescription: {
				projectEssence: [...input.codeDescription.projectEssence],
				architectureSummary: [...input.codeDescription.architectureSummary],
				patterns: [...input.codeDescription.patterns],
				entryPoints: [...input.codeDescription.entryPoints],
				areas: input.codeDescription.areas.map(item => ({ ...item, representativeFiles: [...item.representativeFiles], symbols: [...item.symbols] })),
				fileSummaries: input.codeDescription.fileSummaries.map(item => ({
					...item,
					imports: [...item.imports],
					symbols: item.symbols.map(symbol => ({ ...symbol })),
					frontendContract: Array.isArray(item.frontendContract) ? [...item.frontendContract] : [],
					frontendBlocks: Array.isArray(item.frontendBlocks) ? item.frontendBlocks.map(block => ({
						...block,
						stateDeps: [...block.stateDeps],
						eventHandlers: [...block.eventHandlers],
						dataSources: [...block.dataSources],
						childComponents: [...block.childComponents],
						conditions: [...block.conditions],
						routes: [...block.routes],
						forms: [...block.forms],
					})) : [],
				})),
				relations: [...input.codeDescription.relations],
				relationBlock: input.codeDescription.relationBlock
					? {
						summary: [...input.codeDescription.relationBlock.summary],
						diagramLines: [...input.codeDescription.relationBlock.diagramLines],
						architectureFlows: [...input.codeDescription.relationBlock.architectureFlows],
						fileLinks: input.codeDescription.relationBlock.fileLinks.map(edge => ({ ...edge, details: [...edge.details] })),
						uiDataLinks: input.codeDescription.relationBlock.uiDataLinks.map(edge => ({ ...edge, details: [...edge.details] })),
						symbolLinks: input.codeDescription.relationBlock.symbolLinks.map(edge => ({ ...edge, details: [...edge.details] })),
					}
					: undefined,
				recentChanges: [...input.codeDescription.recentChanges],
			},
			diffEntries: input.reuseContext?.diffEntries.map(entry => ({ ...entry })) || [],
			changedFiles: input.reuseContext ? Array.from(input.reuseContext.changedFiles).sort((left, right) => left.localeCompare(right)) : [],
			deletedFiles: input.reuseContext ? [...input.reuseContext.deletedFiles] : [],
			renamedFiles: input.reuseContext ? input.reuseContext.renamedFiles.map(item => ({ ...item })) : [],
		};
	}

	private persistBranchArtifact(
		repository: string,
		branchName: string,
		artifactKind: 'full' | 'delta',
		locale: string,
		generationFingerprint: string,
		payload: CodeMapBranchArtifactPayload,
		options: {
			sourceSnapshotToken: string;
			treeSha: string;
			headSha: string;
			basedOnBranchName?: string;
			basedOnSnapshotToken?: string;
			generatedAt: string;
		},
	): void {
		if (!this.db || typeof (this.db as { upsertBranchArtifact?: unknown }).upsertBranchArtifact !== 'function') {
			return;
		}
		this.db.upsertBranchArtifact(repository, branchName, artifactKind, locale, generationFingerprint, payload, options);
	}

	private async describeProjectCode(input: {
		repository: string;
		projectPath: string;
		ref: string;
		snapshot: RefSnapshot;
		manifest: PackageManifest | null;
		composerManifest: ComposerManifest | null;
		locale: string;
		aiModel: string;
		instructionKind: CodeMapInstructionKind;
		reuseContext?: ReuseContext | null;
		onProgress?: (progress: CodeMapGenerationProgress) => void;
	}): Promise<ProjectCodeDescription> {
		const { repository, projectPath, ref, snapshot, manifest, composerManifest, locale, aiModel, instructionKind, reuseContext, onProgress } = input;
		const isRussianLocale = locale.toLowerCase().startsWith('ru');
		const settings = getCodeMapSettings();
		const generationFingerprint = buildCodeMapGenerationFingerprint(settings);
		const analysisFiles = instructionKind === 'delta' && reuseContext
			? snapshot.analysisFiles.filter(filePath => reuseContext.changedFiles.has(filePath))
			: snapshot.analysisFiles;
		const areaEntries = buildAreaEntries(analysisFiles).slice(0, MAX_AREA_COUNT);
		const detailFiles = selectFilesForDetailedSummary(analysisFiles);
		const fileBlobShas = snapshot.blobShaByFile;
		const manifestDescription = resolveProjectDescription(manifest, composerManifest, isRussianLocale, '');
		const reusableAreaSummariesByArea = new Map<string, CodeAreaSummary>();
		const cachedAreaSummariesByArea = new Map<string, CodeAreaSummary>();
		const areaEntriesToGenerate: Array<{
			entry: { area: string; files: string[] };
			snapshotToken: string;
		}> = [];
		for (const areaEntry of areaEntries) {
			const snapshotToken = buildAreaSnapshotToken(areaEntry.area, areaEntry.files, fileBlobShas);
			const reusableSummary = this.getReusableAreaSummary(reuseContext, areaEntry.area, areaEntry.files, fileBlobShas);
			if (reusableSummary) {
				reusableAreaSummariesByArea.set(areaEntry.area, reusableSummary);
				continue;
			}
			const cachedSummary = snapshotToken
				? normalizeCachedAreaSummary(this.db?.getCachedAreaSummary<CodeAreaSummary>(repository, areaEntry.area, snapshotToken, locale, generationFingerprint))
				: null;
			if (cachedSummary) {
				cachedAreaSummariesByArea.set(areaEntry.area, cachedSummary);
				continue;
			}
			areaEntriesToGenerate.push({ entry: areaEntry, snapshotToken });
		}

		const reusableFileSummariesByPath = new Map<string, FileSummary>();
		const cachedFileSummariesByPath = new Map<string, FileSummary>();
		const detailFilesToGenerate: Array<{ filePath: string; blobSha: string }> = [];
		for (const filePath of detailFiles) {
			const blobSha = String(fileBlobShas.get(filePath) || '').trim();
			const reusableSummary = this.getReusableFileSummary(reuseContext, filePath, blobSha);
			if (reusableSummary) {
				reusableFileSummariesByPath.set(filePath, reusableSummary);
				continue;
			}
			const cachedSummary = blobSha
				? normalizeCachedFileSummary(this.db?.getCachedFileSummary<FileSummary>(repository, filePath, blobSha, locale, generationFingerprint))
				: null;
			if (cachedSummary) {
				cachedFileSummariesByPath.set(filePath, cachedSummary);
				continue;
			}
			detailFilesToGenerate.push({ filePath, blobSha });
		}

		const filesToRead = uniqueStrings([
			...detailFilesToGenerate.map(item => item.filePath),
			...areaEntriesToGenerate.flatMap(item => item.entry.files.slice(0, MAX_FILES_PER_AREA)),
		]);
		const fileTexts = filesToRead.length > 0
			? await this.readFileTexts(projectPath, ref, filesToRead)
			: new Map<string, string>();

		const preparedAreas: PreparedCodeMapAreaDescription[] = areaEntriesToGenerate.map(({ entry: areaEntry }, index) => {
			const representativeFiles = areaEntry.files.slice(0, MAX_FILES_PER_AREA);
			const symbols = Array.from(new Set(representativeFiles.flatMap(filePath => extractSymbolNames(filePath, fileTexts.get(filePath) || '')))).slice(0, MAX_SYMBOLS_PER_AREA);
			return {
				id: `area-${index + 1}`,
				area: areaEntry.area,
				fileCount: areaEntry.files.length,
				manifestDescription,
				representativeFiles,
				symbols,
				snippets: representativeFiles
					.slice(0, 2)
					.map(filePath => ({
						filePath,
						snippet: trimSnippet(fileTexts.get(filePath) || ''),
					}))
					.filter(item => item.snippet.trim().length > 0),
				fallback: describeArea(areaEntry.area, representativeFiles, symbols, isRussianLocale),
			};
		});
		const areaBatches = buildAreaDescriptionBatches(preparedAreas, settings.batchContextMaxChars, settings.areaBatchMaxItems);
		if (preparedAreas.length > 0) {
			onProgress?.({
				stage: 'describing-areas',
				detail: formatAreaPreparationDetail(isRussianLocale, preparedAreas.length, analysisFiles.length, areaBatches.length, aiModel),
				completed: 0,
				total: Math.max(1, preparedAreas.length),
			});
		} else if (areaEntries.length > 0) {
			onProgress?.({
				stage: 'describing-areas',
				detail: isRussianLocale
					? `Используются готовые описания ${areaEntries.length} областей`
					: `Reusing prepared descriptions for ${areaEntries.length} code areas`,
				completed: areaEntries.length,
				total: areaEntries.length,
			});
		}
		const descriptionsById = await this.buildAreaDescriptions({
			repository,
			ref,
			locale,
			aiModel,
			mode: settings.blockDescriptionMode,
			maxChars: settings.blockMaxChars,
			batchContextMaxChars: settings.batchContextMaxChars,
			maxItemsPerBatch: settings.areaBatchMaxItems,
			areas: preparedAreas,
			onProgress,
		});
		const generatedAreaSummariesByArea = new Map<string, CodeAreaSummary>();
		for (const area of preparedAreas) {
			const summary: CodeAreaSummary = {
				area: area.area,
				fileCount: area.fileCount,
				description: descriptionsById.get(area.id) || area.fallback,
				representativeFiles: area.representativeFiles,
				symbols: area.symbols,
			};
			generatedAreaSummariesByArea.set(area.area, summary);
			const cachedEntry = areaEntriesToGenerate.find(item => item.entry.area === area.area);
			if (cachedEntry?.snapshotToken) {
				this.db?.upsertCachedAreaSummary(repository, area.area, cachedEntry.snapshotToken, locale, generationFingerprint, summary);
			}
		}
		const areaSummaries: CodeAreaSummary[] = areaEntries.map(areaEntry => generatedAreaSummariesByArea.get(areaEntry.area)
			|| reusableAreaSummariesByArea.get(areaEntry.area)
			|| cachedAreaSummariesByArea.get(areaEntry.area)
			|| ({
				area: areaEntry.area,
				fileCount: areaEntry.files.length,
				description: describeArea(areaEntry.area, areaEntry.files.slice(0, MAX_FILES_PER_AREA), [], isRussianLocale),
				representativeFiles: areaEntry.files.slice(0, MAX_FILES_PER_AREA),
				symbols: [],
			}));

		const preparedFileSummaries: PreparedFileSummary[] = [];
		if (detailFiles.length > 0) {
			onProgress?.({
				stage: 'describing-files',
				detail: isRussianLocale
					? `Подготавливаются описания ${detailFiles.length} ключевых файлов (${reusableFileSummariesByPath.size + cachedFileSummariesByPath.size} готовы, ${detailFilesToGenerate.length} к генерации)`
					: `Preparing summaries for ${detailFiles.length} key files (${reusableFileSummariesByPath.size + cachedFileSummariesByPath.size} ready, ${detailFilesToGenerate.length} to generate)`,
				completed: 0,
				total: Math.max(1, detailFilesToGenerate.length),
			});
		}
		for (const [index, item] of detailFilesToGenerate.entries()) {
			preparedFileSummaries.push(buildPreparedFileSummary(item.filePath, fileTexts.get(item.filePath) || '', isRussianLocale));
			onProgress?.({
				stage: 'describing-files',
				detail: isRussianLocale
					? `Файл ${index + 1}/${detailFilesToGenerate.length}: ${item.filePath}`
					: `File ${index + 1}/${detailFilesToGenerate.length}: ${item.filePath}`,
				completed: index + 1,
				total: detailFilesToGenerate.length,
			});
		}
		const { fileDescriptionsById, symbolDescriptionsById } = await this.buildFileSymbolDescriptions({
			repository,
			ref,
			locale,
			aiModel,
			mode: settings.blockDescriptionMode,
			maxChars: Math.min(settings.blockMaxChars, 600),
			batchContextMaxChars: settings.batchContextMaxChars,
			maxItemsPerBatch: settings.symbolBatchMaxItems,
			maxFilesPerBatch: settings.symbolBatchMaxFiles,
			files: preparedFileSummaries,
			onProgress,
		});
		const frontendBlockDescriptionsById = await this.buildFrontendBlockDescriptions({
			repository,
			ref,
			locale,
			aiModel,
			mode: settings.blockDescriptionMode,
			maxChars: Math.min(Math.max(settings.blockMaxChars, 260), 720),
			batchContextMaxChars: Math.min(settings.batchContextMaxChars, 18000),
			maxItemsPerBatch: Math.min(settings.symbolBatchMaxItems, 10),
			maxFilesPerBatch: Math.min(settings.symbolBatchMaxFiles, 3),
			files: preparedFileSummaries,
			onProgress,
		});
		const generatedFileSummariesByPath = new Map<string, FileSummary>();
		for (const preparedFile of preparedFileSummaries) {
			const summary = materializePreparedFileSummary(preparedFile, fileDescriptionsById, symbolDescriptionsById, frontendBlockDescriptionsById);
			generatedFileSummariesByPath.set(preparedFile.path, summary);
			const changedFile = detailFilesToGenerate.find(item => item.filePath === preparedFile.path);
			if (changedFile?.blobSha) {
				this.db?.upsertCachedFileSummary(repository, preparedFile.path, changedFile.blobSha, locale, generationFingerprint, summary);
			}
		}
		const fileSummaries: FileSummary[] = detailFiles.map(filePath => generatedFileSummariesByPath.get(filePath)
			|| reusableFileSummariesByPath.get(filePath)
			|| cachedFileSummariesByPath.get(filePath)
			|| buildFileSummary(filePath, fileTexts.get(filePath) || '', isRussianLocale));
		const relationBlock = buildCodeMapRelationBlock({
			files: snapshot.filteredFiles,
			fileSummaries,
			fileTexts,
			locale,
		});
		const relations = buildLegacyRelationsFromRelationBlock(relationBlock, isRussianLocale);
		const recentChanges = instructionKind === 'delta'
			? buildDeltaRecentChanges(reuseContext?.diffEntries || [], isRussianLocale)
			: await (async () => {
				onProgress?.({
					stage: 'collecting-history',
					detail: isRussianLocale
						? `Читается git history для ${ref}`
						: `Collecting git history for ${ref}`,
				});
				return this.readRecentChanges(projectPath, ref, isRussianLocale);
			})();

		return {
			projectEssence: instructionKind === 'delta' && reuseContext
				? buildDeltaEssence(reuseContext, isRussianLocale)
				: buildProjectEssence(analysisFiles, manifest, composerManifest, isRussianLocale),
			architectureSummary: instructionKind === 'delta' && reuseContext
				? buildDeltaArchitectureSummary(reuseContext, areaSummaries, isRussianLocale)
				: buildArchitectureSummary(analysisFiles, manifest, composerManifest, isRussianLocale),
			patterns: detectPatterns(analysisFiles, manifest, composerManifest, isRussianLocale),
			entryPoints: findEntryPoints(analysisFiles, isRussianLocale),
			areas: areaSummaries,
			fileSummaries,
			relations,
			relationBlock,
			recentChanges,
		};
	}

	private async buildAreaDescriptions(input: {
		repository: string;
		ref: string;
		locale: string;
		aiModel: string;
		mode: 'short' | 'medium' | 'long';
		maxChars: number;
		batchContextMaxChars: number;
		maxItemsPerBatch: number;
		areas: PreparedCodeMapAreaDescription[];
		onProgress?: (progress: CodeMapGenerationProgress) => void;
	}): Promise<Map<string, string>> {
		const descriptions = new Map<string, string>();
		if (input.areas.length === 0) {
			return descriptions;
		}

		if (!this.aiService) {
			for (const [index, area] of input.areas.entries()) {
				descriptions.set(area.id, area.fallback);
				input.onProgress?.({
					stage: 'describing-areas',
					detail: area.area,
					completed: index + 1,
					total: input.areas.length,
				});
			}
			return descriptions;
		}

		const batches = buildAreaDescriptionBatches(input.areas, input.batchContextMaxChars, input.maxItemsPerBatch);
		let completed = 0;

		for (const [batchIndex, batch] of batches.entries()) {
			input.onProgress?.({
				stage: 'describing-areas',
				detail: formatAreaBatchStartDetail(input.locale.toLowerCase().startsWith('ru'), batchIndex, batches.length, batch),
				completed,
				total: input.areas.length,
			});
			let parsedDescriptions: Record<string, string> = {};
			let usedFallback = false;
			try {
				const response = await this.aiService.generateCodeMapAreaDescriptionsBatch({
					repository: input.repository,
					branchName: input.ref,
					locale: input.locale,
					mode: input.mode,
					maxChars: input.maxChars,
					manifestDescription: batch[0]?.manifestDescription,
					areas: batch.map(area => ({
						id: area.id,
						area: area.area,
						repository: input.repository,
						branchName: input.ref,
						locale: input.locale,
						mode: input.mode,
						maxChars: input.maxChars,
						manifestDescription: area.manifestDescription,
						representativeFiles: area.representativeFiles,
						symbols: area.symbols,
						snippets: area.snippets,
					})),
				}, input.aiModel);
				parsedDescriptions = parseCodeMapAreaBatchResponse(response);
			} catch {
				parsedDescriptions = {};
				usedFallback = true;
			}

			for (const area of batch) {
				const normalized = normalizeAreaDescription(parsedDescriptions[area.id] || '', input.maxChars);
				descriptions.set(area.id, normalized || area.fallback);
				completed += 1;
				input.onProgress?.({
					stage: 'describing-areas',
					detail: formatAreaCompletionDetail(input.locale.toLowerCase().startsWith('ru'), completed, input.areas.length, area.area, usedFallback || !normalized),
					completed,
					total: input.areas.length,
				});
			}
		}

		return descriptions;
	}

	private async buildFileSymbolDescriptions(input: {
		repository: string;
		ref: string;
		locale: string;
		aiModel: string;
		mode: 'short' | 'medium' | 'long';
		maxChars: number;
		batchContextMaxChars: number;
		maxItemsPerBatch: number;
		maxFilesPerBatch: number;
		files: PreparedFileSummary[];
		onProgress?: (progress: CodeMapGenerationProgress) => void;
	}): Promise<{ fileDescriptionsById: Map<string, string>; symbolDescriptionsById: Map<string, string> }> {
		const fileDescriptionsById = new Map<string, string>();
		const symbolDescriptionsById = new Map<string, string>();
		const isRussianLocale = input.locale.toLowerCase().startsWith('ru');
		const items: CodeMapFileBatchItem[] = input.files.map(file => ({
			id: file.fileDescriptionId,
			filePath: file.path,
			fileRole: file.role,
			lineCount: file.lineCount,
			imports: [...file.imports],
			frontendContract: [...file.frontendContract],
			frontendBlockNames: file.frontendBlocks.map(block => block.name).filter(Boolean),
			excerpt: file.excerpt,
			fallbackDescription: file.description,
			symbols: file.symbols.map(symbol => ({
				id: symbol.id,
				filePath: file.path,
				fileRole: file.role,
				kind: symbol.kind,
				name: symbol.name,
				signature: symbol.signature,
				excerpt: symbol.excerpt,
				fallbackDescription: symbol.description,
			})),
		}));
		const totalSymbolCount = items.reduce((sum, item) => sum + item.symbols.length, 0);

		if (items.length === 0 || !this.aiService || typeof (this.aiService as { generateCodeMapSymbolDescriptionsBatch?: unknown }).generateCodeMapSymbolDescriptionsBatch !== 'function') {
			return { fileDescriptionsById, symbolDescriptionsById };
		}

		const batches = buildFileSymbolDescriptionBatches(items, input.batchContextMaxChars, input.maxItemsPerBatch, input.maxFilesPerBatch);
		input.onProgress?.({
			stage: 'describing-files',
			detail: isRussianLocale
				? `Подготавливаются AI-батчи описаний файлов и символов: ${items.length} файлов, ${totalSymbolCount} символов, ${batches.length} батчей, модель ${input.aiModel}`
				: `Preparing AI file and symbol batches: ${items.length} files, ${totalSymbolCount} symbols, ${batches.length} batches, model ${input.aiModel}`,
			completed: 0,
			total: items.length,
		});

		let completed = 0;
		for (const [batchIndex, batch] of batches.entries()) {
			input.onProgress?.({
				stage: 'describing-files',
				detail: formatSymbolBatchStartDetail(isRussianLocale, batchIndex, batches.length, batch),
				completed,
				total: items.length,
			});
			let parsedDescriptions: { fileDescriptions: Record<string, string>; symbolDescriptions: Record<string, string> } = {
				fileDescriptions: {},
				symbolDescriptions: {},
			};
			try {
				const response = await this.aiService.generateCodeMapSymbolDescriptionsBatch({
					repository: input.repository,
					branchName: input.ref,
					locale: input.locale,
					mode: input.mode,
					maxChars: input.maxChars,
					files: batch.map(item => ({
						id: item.id,
						filePath: item.filePath,
						fileRole: item.fileRole,
						lineCount: item.lineCount,
						imports: [...item.imports],
						frontendContract: [...item.frontendContract],
						frontendBlockNames: [...item.frontendBlockNames],
						excerpt: item.excerpt,
						fallbackDescription: item.fallbackDescription,
						symbols: item.symbols.map(symbol => ({
							id: symbol.id,
							filePath: symbol.filePath,
							fileRole: symbol.fileRole,
							kind: symbol.kind,
							name: symbol.name,
							signature: symbol.signature,
							excerpt: symbol.excerpt,
							fallbackDescription: symbol.fallbackDescription,
						})),
					})),
				}, input.aiModel);
				parsedDescriptions = parseCodeMapFileSymbolBatchResponse(response);
			} catch {
				parsedDescriptions = {
					fileDescriptions: {},
					symbolDescriptions: {},
				};
			}

			for (const item of batch) {
				const normalizedFileDescription = normalizeFileDescription(parsedDescriptions.fileDescriptions[item.id] || '', input.maxChars);
				if (normalizedFileDescription) {
					fileDescriptionsById.set(item.id, normalizedFileDescription);
				}
				for (const symbol of item.symbols) {
					const normalizedSymbolDescription = normalizeSymbolDescription(parsedDescriptions.symbolDescriptions[symbol.id] || '', input.maxChars);
					if (normalizedSymbolDescription) {
						symbolDescriptionsById.set(symbol.id, normalizedSymbolDescription);
					}
				}
				completed += 1;
				input.onProgress?.({
					stage: 'describing-files',
					detail: formatSymbolBatchCompletionDetail(isRussianLocale, completed, items.length, item.filePath, item.symbols.length, !normalizedFileDescription),
					completed,
					total: items.length,
				});
			}
		}

		return { fileDescriptionsById, symbolDescriptionsById };
	}

	private async buildFrontendBlockDescriptions(input: {
		repository: string;
		ref: string;
		locale: string;
		aiModel: string;
		mode: 'short' | 'medium' | 'long';
		maxChars: number;
		batchContextMaxChars: number;
		maxItemsPerBatch: number;
		maxFilesPerBatch: number;
		files: PreparedFileSummary[];
		onProgress?: (progress: CodeMapGenerationProgress) => void;
	}): Promise<Map<string, string>> {
		const descriptions = new Map<string, string>();
		const isRussianLocale = input.locale.toLowerCase().startsWith('ru');
		const items: CodeMapFrontendBlockBatchItem[] = input.files.flatMap(file => file.frontendBlocks.map(block => ({
			id: block.id,
			filePath: file.path,
			fileRole: file.role,
			framework: block.framework,
			blockKind: block.kind,
			blockName: block.name,
			purpose: block.purpose,
			stateDeps: [...block.stateDeps],
			eventHandlers: [...block.eventHandlers],
			dataSources: [...block.dataSources],
			childComponents: [...block.childComponents],
			conditions: [...block.conditions],
			routes: [...block.routes],
			forms: [...block.forms],
			excerpt: block.excerpt,
			linkedScriptSnippets: [...block.linkedScriptSnippets],
			fallbackDescription: block.description,
		})));

		if (items.length === 0 || !this.aiService || typeof (this.aiService as { generateCodeMapFrontendBlockDescriptionsBatch?: unknown }).generateCodeMapFrontendBlockDescriptionsBatch !== 'function') {
			return descriptions;
		}

		const batches = buildFrontendBlockDescriptionBatches(items, input.batchContextMaxChars, input.maxItemsPerBatch, input.maxFilesPerBatch);
		input.onProgress?.({
			stage: 'describing-files',
			detail: isRussianLocale
				? `Подготавливаются AI-батчи UI-блоков: ${items.length} блоков, ${batches.length} батчей, модель ${input.aiModel}`
				: `Preparing AI frontend-block batches: ${items.length} blocks, ${batches.length} batches, model ${input.aiModel}`,
			completed: 0,
			total: items.length,
		});

		let completed = 0;
		for (const [batchIndex, batch] of batches.entries()) {
			input.onProgress?.({
				stage: 'describing-files',
				detail: formatFrontendBatchStartDetail(isRussianLocale, batchIndex, batches.length, batch),
				completed,
				total: items.length,
			});
			let parsedDescriptions: Record<string, string> = {};
			try {
				const response = await this.aiService.generateCodeMapFrontendBlockDescriptionsBatch({
					repository: input.repository,
					branchName: input.ref,
					locale: input.locale,
					mode: input.mode,
					maxChars: input.maxChars,
					blocks: batch.map(item => ({
						id: item.id,
						filePath: item.filePath,
						fileRole: item.fileRole,
						framework: item.framework,
						blockKind: item.blockKind,
						blockName: item.blockName,
						purpose: item.purpose,
						stateDeps: [...item.stateDeps],
						eventHandlers: [...item.eventHandlers],
						dataSources: [...item.dataSources],
						childComponents: [...item.childComponents],
						conditions: [...item.conditions],
						routes: [...item.routes],
						forms: [...item.forms],
						excerpt: item.excerpt,
						linkedScriptSnippets: [...item.linkedScriptSnippets],
						fallbackDescription: item.fallbackDescription,
					})),
				}, input.aiModel);
				parsedDescriptions = parseCodeMapFrontendBatchResponse(response);
			} catch {
				parsedDescriptions = {};
			}

			for (const item of batch) {
				const normalized = normalizeSymbolDescription(parsedDescriptions[item.id] || '', input.maxChars);
				if (normalized) {
					descriptions.set(item.id, normalized);
				}
				completed += 1;
				input.onProgress?.({
					stage: 'describing-files',
					detail: formatFrontendBatchCompletionDetail(isRussianLocale, completed, items.length, item.filePath, item.blockName, !normalized),
					completed,
					total: items.length,
				});
			}
		}

		return descriptions;
	}

	private async getFileBlobShasAtRef(projectPath: string, ref: string, files: string[]): Promise<Map<string, string>> {
		if (files.length === 0) {
			return new Map();
		}

		try {
			const targets = new Set(files);
			const { stdout } = await execFileAsync('git', ['ls-tree', '-r', ref], { cwd: projectPath, maxBuffer: 12 * 1024 * 1024 });
			const shas = new Map<string, string>();
			for (const line of stdout.split(/\r?\n/)) {
				const match = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t(.+)$/i);
				if (!match?.[1] || !match[2]) {
					continue;
				}
				if (!targets.has(match[2])) {
					continue;
				}
				shas.set(match[2], match[1]);
			}
			return shas;
		} catch {
			return new Map();
		}
	}

	private async readFileTexts(projectPath: string, ref: string, files: string[]): Promise<Map<string, string>> {
		const texts = new Map<string, string>();
		for (const filePath of files) {
			if (isBinaryLikeFile(filePath)) {
				texts.set(filePath, '');
				continue;
			}

			texts.set(filePath, await this.readTextAtRef(projectPath, ref, filePath));
		}

		return texts;
	}

	private async readRecentChanges(projectPath: string, ref: string, isRussianLocale: boolean): Promise<string[]> {
		try {
			const { stdout } = await execFileAsync(
				'git',
				['log', '--date=iso', `-n${MAX_RECENT_CHANGES}`, '--format=%H\t%ad\t%s', '--name-only', ref],
				{ cwd: projectPath, maxBuffer: 4 * 1024 * 1024 },
			);
			return parseRecentChanges(stdout, isRussianLocale);
		} catch {
			return [];
		}
	}

	private async readTextAtRef(projectPath: string, ref: string, filePath: string): Promise<string> {
		try {
			const { stdout } = await execFileAsync('git', ['show', `${ref}:${filePath}`], { cwd: projectPath, maxBuffer: MAX_FILE_SNIPPET_BYTES });
			return stdout;
		} catch {
			return '';
		}
	}
}

export function buildCodeMapProjectInstruction(input: {
	repository: string;
	branchName: string;
	resolvedBranchName: string;
	baseBranchName: string;
	instructionKind: CodeMapInstructionKind;
	branchRole: CodeMapBranchResolution['branchRole'];
	generatedAt: string;
	headSha: string;
	locale: string;
	files: string[];
	manifest: PackageManifest | null;
	composerManifest?: ComposerManifest | null;
	codeDescription?: ProjectCodeDescription;
}): string {
	const isRussianLocale = input.locale.toLowerCase().startsWith('ru');
	const files = input.files;
	const analysisFiles = selectFilesForAnalysis(files);
	const treeSourceFiles = analysisFiles.length > 0 ? analysisFiles : files.filter(filePath => !isBinaryLikeFile(filePath));
	const limitedFiles = treeSourceFiles.slice(0, MAX_TREE_ITEMS);
	const treeItems: AsciiTreeItem[] = limitedFiles.map(filePath => ({
		path: `${input.repository}/${filePath}`,
		kind: 'file',
	}));
	const tree = treeItems.length > 0 ? buildAsciiTree(treeItems) : '';
	const languages = summarizeExtensions(analysisFiles);
	const frameworks = detectFrameworks(input.manifest, input.composerManifest || null, analysisFiles);
	const scripts = collectProjectScripts(input.manifest, input.composerManifest || null).slice(0, MAX_SCRIPT_ITEMS);
	const dependencies = collectProjectDependencies(input.manifest, input.composerManifest || null).slice(0, MAX_DEPENDENCY_ITEMS);
	const heading = isRussianLocale
		? `# Code Map проекта ${input.repository} для ветки ${input.branchName}`
		: `# Project Code Map for ${input.repository} branch ${input.branchName}`;
	const overviewTitle = isRussianLocale ? '## Обзор' : '## Overview';
	const essenceTitle = isRussianLocale ? '## Суть проекта' : '## Project Essence';
	const technologiesTitle = isRussianLocale ? '## Технологии и сигналы проекта' : '## Technologies and Project Signals';
	const codeDescriptionTitle = isRussianLocale ? '## Описание кода' : '## Code Description';
	const fileDetailsTitle = isRussianLocale ? '## Ключевые файлы и элементы' : '## Key Files and Elements';
	const relationsTitle = isRussianLocale ? '## Связи между частями кода' : '## Code Relationships';
	const timelineTitle = isRussianLocale ? '## Временные метки изменений в коде' : '## Code Change Timeline';
	const structureTitle = isRussianLocale ? '## Структура файлов' : '## File Structure';
	const notesTitle = isRussianLocale ? '## Примечания текущей реализации' : '## Current Implementation Notes';
	const manifestDescription = resolveProjectDescription(input.manifest, input.composerManifest || null, isRussianLocale, isRussianLocale ? 'Описание проекта в package.json/composer.json не найдено.' : 'No project description found in package.json/composer.json.');
	const implementationNote = isRussianLocale
		? 'Codemap теперь старается показывать только сигнальные для ИИ файлы: временные, кэшированные и служебно-сгенерированные артефакты исключаются из аналитической части, чтобы инструкция оставалась полезной для навигации.'
		: 'Codemap now focuses on files that carry architectural signal for AI navigation: temporary, cached, and generated artifacts are excluded from the analytical sections to keep the instruction useful.';
	const codeDescription = input.codeDescription || buildFallbackCodeDescription(files, input.manifest, input.composerManifest || null, isRussianLocale);
	const detailedFileOmissions = Math.max(0, analysisFiles.length - codeDescription.fileSummaries.length);
	const filteredTreeOmissions = Math.max(0, files.length - limitedFiles.length);

	return [
		heading,
		'',
		overviewTitle,
		`- ${isRussianLocale ? 'Репозиторий' : 'Repository'}: ${input.repository}`,
		`- ${isRussianLocale ? 'Ветка' : 'Branch'}: ${input.branchName}`,
		`- ${isRussianLocale ? 'Разрешённая ветка' : 'Resolved branch'}: ${input.resolvedBranchName}`,
		`- ${isRussianLocale ? 'Базовая ветка' : 'Base branch'}: ${input.baseBranchName}`,
		`- ${isRussianLocale ? 'Тип инструкции' : 'Instruction kind'}: ${input.instructionKind}`,
		`- ${isRussianLocale ? 'Роль ветки' : 'Branch role'}: ${input.branchRole}`,
		`- ${isRussianLocale ? 'Коммит HEAD' : 'Head commit'}: ${input.headSha || (isRussianLocale ? 'неизвестно' : 'unknown')}`,
		`- ${isRussianLocale ? 'Сгенерировано' : 'Generated at'}: ${input.generatedAt}`,
		`- ${isRussianLocale ? 'Всего файлов' : 'File count'}: ${files.length}`,
		`- ${isRussianLocale ? 'Файлов в анализе' : 'Analysed files'}: ${analysisFiles.length}`,
		`- ${isRussianLocale ? 'Пакет' : 'Package'}: ${resolveProjectName(input.manifest, input.composerManifest || null, input.repository)}`,
		`- ${isRussianLocale ? 'Описание' : 'Description'}: ${manifestDescription}`,
		'',
		essenceTitle,
		...codeDescription.projectEssence.map(item => `- ${item}`),
		'',
		technologiesTitle,
		`- ${isRussianLocale ? 'Языки' : 'Languages'}: ${languages.length > 0 ? languages.join(', ') : (isRussianLocale ? 'не определены' : 'unknown')}`,
		`- ${isRussianLocale ? 'Фреймворки и библиотеки' : 'Frameworks/Libraries'}: ${frameworks.length > 0 ? frameworks.join(', ') : (isRussianLocale ? 'не определены' : 'not detected')}`,
		`- ${isRussianLocale ? 'Скрипты' : 'Scripts'}: ${scripts.length > 0 ? scripts.join(', ') : (isRussianLocale ? 'не определены' : 'not detected')}`,
		`- ${isRussianLocale ? 'Зависимости' : 'Dependencies'}: ${dependencies.length > 0 ? dependencies.join(', ') : (isRussianLocale ? 'не определены' : 'not detected')}`,
		...(codeDescription.patterns.length > 0 ? ['', isRussianLocale ? '### Паттерны и организационные сигналы' : '### Patterns and Organizational Signals'] : []),
		...codeDescription.patterns.map(item => `- ${item}`),
		'',
		codeDescriptionTitle,
		...codeDescription.architectureSummary.map(item => `- ${item}`),
		...(codeDescription.entryPoints.length > 0 ? ['', isRussianLocale ? '### Точки входа и управляющие файлы' : '### Entry Points and Control Files'] : []),
		...codeDescription.entryPoints.map(item => `- ${item}`),
		...(codeDescription.areas.length > 0 ? ['', isRussianLocale ? '### Области кода' : '### Code Areas'] : []),
		...codeDescription.areas.flatMap(area => {
			const areaLines = [
				`#### ${area.area}`,
				`- ${isRussianLocale ? 'Описание' : 'Description'}: ${area.description}`,
				'',
			];

			if (area.representativeFiles.length > 0) {
				areaLines.push(`- ${isRussianLocale ? 'Файлы' : 'Files'}: ${area.representativeFiles.join(', ')}`);
				areaLines.push('');
			}

			if (area.symbols.length > 0) {
				areaLines.push(`- ${isRussianLocale ? 'Ключевые элементы' : 'Key elements'}: ${area.symbols.join(', ')}`);
				areaLines.push('');
			}

			return areaLines;
		}),
		'',
		fileDetailsTitle,
		...(detailedFileOmissions > 0
			? [isRussianLocale
				? `- Показаны ${codeDescription.fileSummaries.length} наиболее сигнальных файлов; ещё ${detailedFileOmissions} файлов опущены как второстепенные или служебные.`
				: `- Showing ${codeDescription.fileSummaries.length} most informative files; ${detailedFileOmissions} additional files were omitted as secondary or operational artifacts.`]
			: []),
		...codeDescription.fileSummaries.flatMap(file => {
			const lines = [
				`### ${file.path}`,
				...(file.description ? [`- ${isRussianLocale ? 'Описание' : 'Description'}: ${file.description}`] : []),
				`- ${isRussianLocale ? 'Роль' : 'Role'}: ${file.role}`,
				`- ${isRussianLocale ? 'Строк в файле' : 'Line count'}: ${file.lineCount}`,
				'',
			];

			if (file.imports.length > 0) {
				lines.push(`- ${isRussianLocale ? 'Внутренние импорты' : 'Internal imports'}: ${file.imports.join(', ')}`);
				lines.push('');
			}

			if ((file.frontendContract || []).length > 0) {
				lines.push(`- ${isRussianLocale ? 'Frontend-контракт' : 'Frontend contract'}:`);
				for (const item of file.frontendContract || []) {
					lines.push(`  - ${item}`);
				}
				lines.push('');
			}

			if ((file.frontendBlocks || []).length > 0) {
				lines.push(`- ${isRussianLocale ? 'UI-блоки' : 'UI blocks'}:`);
				for (const block of file.frontendBlocks || []) {
					lines.push('');
					lines.push(`  - ${formatFrontendBlockHeading(block, file.path, isRussianLocale)}`);
					lines.push(`    ${isRussianLocale ? 'Описание' : 'Description'}: ${block.description}`);
					if (block.stateDeps.length > 0) {
						lines.push(`    ${isRussianLocale ? 'Состояние' : 'State'}: ${block.stateDeps.join(', ')}`);
					}
					if (block.eventHandlers.length > 0) {
						lines.push(`    ${isRussianLocale ? 'События' : 'Events'}: ${block.eventHandlers.join(', ')}`);
					}
					if (block.dataSources.length > 0) {
						lines.push(`    ${isRussianLocale ? 'Источники данных' : 'Data sources'}: ${block.dataSources.join(', ')}`);
					}
				}
				lines.push('');
			}

			if (file.symbols.length > 0) {
				lines.push(`- ${isRussianLocale ? 'Элементы файла' : 'File elements'}:`);
				for (const symbol of file.symbols) {
					lines.push('');
					lines.push(`  - ${formatFileElementHeading(symbol, file.path, isRussianLocale)}`);
					lines.push(`    ${isRussianLocale ? 'Сигнатура' : 'Signature'}: ${symbol.signature}`);
					lines.push(`    ${isRussianLocale ? 'Описание' : 'Description'}: ${symbol.description}`);
				}
			}

			lines.push('');

			return lines;
		}),
		'',
		relationsTitle,
		...buildRelationSectionLines(
			codeDescription.relationBlock,
			codeDescription.relations,
			isRussianLocale,
			isRussianLocale ? 'Явные связи между файлами не обнаружены.' : 'No explicit file relationships were detected.',
		),
		'',
		timelineTitle,
		...(codeDescription.recentChanges.length > 0
			? codeDescription.recentChanges.map(item => `- ${item}`)
			: [isRussianLocale ? '- История изменений для ветки не получена.' : '- No recent change timeline was collected for the branch.']),
		'',
		structureTitle,
		...(filteredTreeOmissions > 0
			? [isRussianLocale
				? `- Дерево ниже показывает ${limitedFiles.length} релевантных файлов; временные, бинарные и сгенерированные артефакты исключены.`
				: `- The tree below shows ${limitedFiles.length} relevant files; temporary, binary, and generated artifacts are excluded.`]
			: []),
		tree ? '```text' : (isRussianLocale ? 'Структура файлов не обнаружена.' : 'No file structure detected.'),
		tree || '',
		tree ? '```' : '',
		files.length > limitedFiles.length ? (isRussianLocale ? `... ещё ${files.length - limitedFiles.length} файлов скрыто` : `... ${files.length - limitedFiles.length} more files omitted`) : '',
		'',
		notesTitle,
		implementationNote,
	].filter(line => line !== undefined && line !== null).join('\n');
}

function buildCodeMapDeltaInstruction(input: {
	repository: string;
	branchName: string;
	baseBranchName: string;
	generatedAt: string;
	headSha: string;
	locale: string;
	files: string[];
	codeDescription: ProjectCodeDescription;
	diffEntries: CodeMapRefDiffEntry[];
	changedFiles: string[];
	deletedFiles: string[];
	renamedFiles: Array<{ from: string; to: string }>;
	basedOnBranchName: string;
}): string {
	const isRussianLocale = input.locale.toLowerCase().startsWith('ru');
	const heading = isRussianLocale
		? `# Delta Code Map проекта ${input.repository} для ветки ${input.branchName}`
		: `# Project Delta Code Map for ${input.repository} branch ${input.branchName}`;
	const overviewTitle = isRussianLocale ? '## Обзор delta' : '## Delta Overview';
	const changedAreasTitle = isRussianLocale ? '## Изменённые области' : '## Changed Areas';
	const changedFilesTitle = isRussianLocale ? '## Изменённые файлы и элементы' : '## Changed Files and Elements';
	const relationsTitle = isRussianLocale ? '## Связи затронутых частей' : '## Impact Relationships';
	const timelineTitle = isRussianLocale ? '## Сводка diff' : '## Diff Summary';
	const deletedTitle = isRussianLocale ? '## Удалённые файлы' : '## Deleted Files';
	const renamedTitle = isRussianLocale ? '## Переименования' : '## Renamed Files';

	return [
		heading,
		'',
		overviewTitle,
		`- ${isRussianLocale ? 'Репозиторий' : 'Repository'}: ${input.repository}`,
		`- ${isRussianLocale ? 'Текущая ветка' : 'Current branch'}: ${input.branchName}`,
		`- ${isRussianLocale ? 'Базовая tracked-ветка' : 'Base tracked branch'}: ${input.baseBranchName}`,
		`- ${isRussianLocale ? 'Использованный базовый артефакт' : 'Reused base artifact'}: ${input.basedOnBranchName || input.baseBranchName}`,
		`- ${isRussianLocale ? 'HEAD коммит' : 'Head commit'}: ${input.headSha || (isRussianLocale ? 'неизвестно' : 'unknown')}`,
		`- ${isRussianLocale ? 'Сгенерировано' : 'Generated at'}: ${input.generatedAt}`,
		`- ${isRussianLocale ? 'Всего файлов в снимке' : 'Files in snapshot'}: ${input.files.length}`,
		`- ${isRussianLocale ? 'Изменённых файлов' : 'Changed files'}: ${input.changedFiles.length}`,
		`- ${isRussianLocale ? 'Удалённых файлов' : 'Deleted files'}: ${input.deletedFiles.length}`,
		`- ${isRussianLocale ? 'Переименований' : 'Renames'}: ${input.renamedFiles.length}`,
		'',
		...(input.codeDescription.projectEssence.length > 0
			? [(isRussianLocale ? '### Краткая суть delta' : '### Delta Essence'), ...input.codeDescription.projectEssence.map(item => `- ${item}`), '']
			: []),
		changedAreasTitle,
		...(input.codeDescription.areas.length > 0
			? input.codeDescription.areas.flatMap(area => [
				`### ${area.area}`,
				`- ${isRussianLocale ? 'Описание' : 'Description'}: ${area.description}`,
				...(area.representativeFiles.length > 0 ? [`- ${isRussianLocale ? 'Файлы' : 'Files'}: ${area.representativeFiles.join(', ')}`] : []),
				...(area.symbols.length > 0 ? [`- ${isRussianLocale ? 'Элементы' : 'Elements'}: ${area.symbols.join(', ')}`] : []),
				'',
			])
			: [isRussianLocale ? '- Существенных изменённых областей не выделено.' : '- No significant changed areas were detected.']),
		changedFilesTitle,
		...(input.codeDescription.fileSummaries.length > 0
			? input.codeDescription.fileSummaries.flatMap(file => buildInstructionFileSummaryLines(file, isRussianLocale))
			: [isRussianLocale ? '- Изменённые сигнальные файлы не выбраны.' : '- No informative changed files were selected.']),
		'',
		relationsTitle,
		...buildRelationSectionLines(
			input.codeDescription.relationBlock,
			input.codeDescription.relations,
			isRussianLocale,
			isRussianLocale ? 'Явные связи между изменениями не обнаружены.' : 'No explicit relationships between the changes were detected.',
		),
		'',
		timelineTitle,
		...(input.codeDescription.recentChanges.length > 0
			? input.codeDescription.recentChanges.map(item => `- ${item}`)
			: [isRussianLocale ? '- Diff не дал компактной сводки.' : '- The diff did not produce a compact summary.']),
		'',
		deletedTitle,
		...(input.deletedFiles.length > 0
			? input.deletedFiles.map(item => `- ${item}`)
			: [isRussianLocale ? '- Нет удалённых файлов.' : '- No deleted files.']),
		'',
		renamedTitle,
		...(input.renamedFiles.length > 0
			? input.renamedFiles.map(item => `- ${item.from} -> ${item.to}`)
			: [isRussianLocale ? '- Нет переименованных файлов.' : '- No renamed files.']),
	].join('\n');
}

function buildInstructionFileSummaryLines(file: FileSummary, isRussianLocale: boolean): string[] {
	const lines = [
		`### ${file.path}`,
		...(file.description ? [`- ${isRussianLocale ? 'Описание' : 'Description'}: ${file.description}`] : []),
		`- ${isRussianLocale ? 'Роль' : 'Role'}: ${file.role}`,
		`- ${isRussianLocale ? 'Строк в файле' : 'Line count'}: ${file.lineCount}`,
	];

	if (file.imports.length > 0) {
		lines.push(`- ${isRussianLocale ? 'Внутренние импорты' : 'Internal imports'}: ${file.imports.join(', ')}`);
	}

	if ((file.frontendContract || []).length > 0) {
		lines.push(`- ${isRussianLocale ? 'Frontend-контракт' : 'Frontend contract'}: ${(file.frontendContract || []).join(' | ')}`);
	}

	for (const block of file.frontendBlocks || []) {
		lines.push(`- ${formatFrontendBlockHeading(block, file.path, isRussianLocale)}: ${block.description}`);
	}

	for (const symbol of file.symbols) {
		lines.push(`- ${formatFileElementHeading(symbol, file.path, isRussianLocale)}: ${symbol.description}`);
	}

	lines.push('');
	return lines;
}

function buildRelationSectionLines(
	relationBlock: ProjectCodeDescription['relationBlock'],
	fallbackRelations: string[],
	isRussianLocale: boolean,
	emptyMessage: string,
): string[] {
	const hasStructuredBlock = Boolean(
		relationBlock
		&& (
			relationBlock.summary.length > 0
			|| relationBlock.diagramLines.length > 0
			|| relationBlock.architectureFlows.length > 0
			|| relationBlock.fileLinks.length > 0
			|| relationBlock.uiDataLinks.length > 0
			|| relationBlock.symbolLinks.length > 0
		),
	);

	if (hasStructuredBlock && relationBlock) {
		const lines: string[] = [];
		if (relationBlock.summary.length > 0) {
			lines.push(isRussianLocale ? '### Краткая сводка' : '### Summary');
			lines.push(...relationBlock.summary.map(item => `- ${item}`));
			lines.push('');
		}
		if (relationBlock.diagramLines.length > 0) {
			lines.push(isRussianLocale ? '### Схема связи' : '### Relationship Diagram');
			lines.push('```text');
			lines.push(...relationBlock.diagramLines);
			lines.push('```');
			lines.push('');
		}
		if (relationBlock.architectureFlows.length > 0) {
			lines.push(isRussianLocale ? '### Архитектурные потоки' : '### Architectural Flows');
			lines.push(...relationBlock.architectureFlows.map(item => `- ${item}`));
			lines.push('');
		}
		if (relationBlock.fileLinks.length > 0) {
			lines.push(isRussianLocale ? '### Межфайловые связи' : '### Inter-file Links');
			lines.push(...relationBlock.fileLinks.map(item => `- ${item.label}`));
			lines.push('');
		}
		if (relationBlock.uiDataLinks.length > 0) {
			lines.push(isRussianLocale ? '### UI и данные' : '### UI and Data');
			lines.push(...relationBlock.uiDataLinks.map(item => `- ${item.label}`));
			lines.push('');
		}
		if (relationBlock.symbolLinks.length > 0) {
			lines.push(isRussianLocale ? '### Символьные связи' : '### Symbol Links');
			lines.push(...relationBlock.symbolLinks.map(item => `- ${item.label}`));
			lines.push('');
		}
		while (lines[lines.length - 1] === '') {
			lines.pop();
		}
		return lines;
	}

	if (fallbackRelations.length > 0) {
		return fallbackRelations.map(item => `- ${item}`);
	}

	return [`- ${emptyMessage}`];
}

function buildFallbackCodeDescription(files: string[], manifest: PackageManifest | null, composerManifest: ComposerManifest | null, isRussianLocale: boolean): ProjectCodeDescription {
	const analysisFiles = selectFilesForAnalysis(files);
	const detailFiles = selectFilesForDetailedSummary(analysisFiles);
	const areas = buildAreaEntries(analysisFiles).slice(0, MAX_AREA_COUNT).map(area => ({
		area: area.area,
		fileCount: area.files.length,
		description: describeArea(area.area, area.files.slice(0, MAX_FILES_PER_AREA), [], isRussianLocale),
		representativeFiles: area.files.slice(0, MAX_FILES_PER_AREA),
		symbols: [],
	}));

	return {
		projectEssence: buildProjectEssence(analysisFiles, manifest, composerManifest, isRussianLocale),
		architectureSummary: buildArchitectureSummary(analysisFiles, manifest, composerManifest, isRussianLocale),
		patterns: detectPatterns(analysisFiles, manifest, composerManifest, isRussianLocale),
		entryPoints: findEntryPoints(analysisFiles, isRussianLocale),
		areas,
		fileSummaries: detailFiles.map(filePath => buildFileSummary(filePath, '', isRussianLocale)),
		relations: [],
		relationBlock: {
			summary: [],
			diagramLines: [],
			architectureFlows: [],
			fileLinks: [],
			uiDataLinks: [],
			symbolLinks: [],
		},
		recentChanges: [],
	};
}

function buildDeltaRecentChanges(diffEntries: CodeMapRefDiffEntry[], isRussianLocale: boolean): string[] {
	if (diffEntries.length === 0) {
		return [];
	}

	return diffEntries.slice(0, MAX_RECENT_CHANGES).map((entry) => {
		switch (entry.status) {
			case 'A':
				return isRussianLocale ? `Добавлен файл ${entry.path}` : `Added file ${entry.path}`;
			case 'D':
				return isRussianLocale ? `Удалён файл ${entry.path}` : `Deleted file ${entry.path}`;
			case 'R':
				return isRussianLocale
					? `Переименование ${entry.oldPath || 'unknown'} -> ${entry.path}`
					: `Renamed ${entry.oldPath || 'unknown'} -> ${entry.path}`;
			case 'C':
				return isRussianLocale
					? `Скопирован файл ${entry.oldPath || 'unknown'} -> ${entry.path}`
					: `Copied ${entry.oldPath || 'unknown'} -> ${entry.path}`;
			default:
				return isRussianLocale ? `Изменён файл ${entry.path}` : `Modified file ${entry.path}`;
		}
	});
}

function buildDeltaEssence(reuseContext: ReuseContext, isRussianLocale: boolean): string[] {
	const lines = [
		isRussianLocale
			? `Delta построена относительно ветки ${reuseContext.sourceArtifact.branchName}.`
			: `The delta is built against branch ${reuseContext.sourceArtifact.branchName}.`,
		isRussianLocale
			? `Сигнальные изменения затрагивают ${reuseContext.changedFiles.size} файлов.`
			: `The informative change set touches ${reuseContext.changedFiles.size} files.`,
	];

	if (reuseContext.deletedFiles.length > 0) {
		lines.push(isRussianLocale
			? `Также удалено ${reuseContext.deletedFiles.length} файлов.`
			: `${reuseContext.deletedFiles.length} files were also deleted.`);
	}

	if (reuseContext.renamedFiles.length > 0) {
		lines.push(isRussianLocale
			? `Есть ${reuseContext.renamedFiles.length} переименований, которые могут сдвинуть точки входа или связи.`
			: `${reuseContext.renamedFiles.length} renames may shift entry points or relationships.`);
	}

	return lines;
}

function buildDeltaArchitectureSummary(reuseContext: ReuseContext, areas: CodeAreaSummary[], isRussianLocale: boolean): string[] {
	const lines: string[] = [];
	if (areas.length > 0) {
		lines.push(isRussianLocale
			? `Изменения сосредоточены в областях: ${areas.map(item => item.area).join(', ')}.`
			: `Changes are concentrated in: ${areas.map(item => item.area).join(', ')}.`);
	}
	if (reuseContext.changedFiles.size === 0 && reuseContext.deletedFiles.length > 0) {
		lines.push(isRussianLocale
			? 'В этой delta нет новых сигнальных файлов, но есть удаления относительно базовой tracked-ветки.'
			: 'This delta contains no new informative files but does include deletions against the tracked base.');
	}
	if (lines.length === 0) {
		lines.push(isRussianLocale
			? 'Архитектурное влияние delta выводится из изменённых файлов и связей.'
			: 'The architectural impact of the delta is inferred from the changed files and their relationships.');
	}
	return lines;
}

function buildProjectEssence(files: string[], manifest: PackageManifest | null, composerManifest: ComposerManifest | null, isRussianLocale: boolean): string[] {
	const lines: string[] = [];
	const description = manifest?.description?.trim() || composerManifest?.description?.trim();
	if (description) {
		lines.push(isRussianLocale ? `Заявленная цель проекта: ${description}` : `Declared project purpose: ${description}`);
	}

	if (isLaravelProject(files, composerManifest)) {
		lines.push(isRussianLocale
			? 'Это Laravel-приложение или пакет: видны HTTP-контроллеры, маршруты, миграции, модели и тесты вокруг прикладных сценариев.'
			: 'This looks like a Laravel application or package with HTTP controllers, routes, migrations, models, and tests around application scenarios.');
	}

	if (files.some(filePath => filePath.startsWith('src/providers/')) && files.some(filePath => filePath.startsWith('src/webview/'))) {
		lines.push(isRussianLocale
			? 'Проект управляет UI-панелями и webview-сценариями, синхронизируя их с extension host и состоянием workspace.'
			: 'The project manages UI panels and webview flows, synchronizing them with the extension host and workspace state.');
	}

	if (files.some(filePath => filePath.startsWith('src/codemap/'))) {
		lines.push(isRussianLocale
			? 'В кодовой базе есть отдельный слой codemap для построения и хранения инструкций по структуре кода.'
			: 'The codebase contains a dedicated codemap layer for building and persisting code-structure instructions.');
	}

	if (lines.length === 0) {
		lines.push(isRussianLocale
			? 'Суть проекта выводится из структуры файлов, основных зависимостей и точек входа.'
			: 'The project purpose is inferred from file structure, primary dependencies, and entry points.');
	}

	return lines;
}

function detectPatterns(files: string[], manifest: PackageManifest | null, composerManifest: ComposerManifest | null, isRussianLocale: boolean): string[] {
	const patterns: string[] = [];
	if (files.some(filePath => filePath.startsWith('src/services/'))) {
		patterns.push(isRussianLocale ? 'service layer для доменной и интеграционной логики' : 'service layer for domain and integration logic');
	}
	if (files.some(filePath => filePath.startsWith('src/providers/'))) {
		patterns.push(isRussianLocale ? 'provider/manager pattern для связывания VS Code API и UI' : 'provider/manager pattern for connecting VS Code API and UI');
	}
	if (files.some(filePath => filePath.startsWith('src/webview/'))) {
		patterns.push(isRussianLocale ? 'разделение extension host и client-side webview' : 'extension-host and client-side webview separation');
	}
	if (manifest?.dependencies?.react || manifest?.devDependencies?.react) {
		patterns.push(isRussianLocale ? 'component-based UI на React' : 'component-based UI with React');
	}
	if (files.some(filePath => /\.vue$/i.test(filePath))) {
		patterns.push(isRussianLocale ? 'single-file components на Vue с шаблоном и script-логикой' : 'Vue single-file components with linked template and script logic');
	}
	if (files.some(filePath => /\.blade\.php$/i.test(filePath) || /\.html?$/i.test(filePath))) {
		patterns.push(isRussianLocale ? 'шаблонный UI с секциями страниц, формами и интерактивными блоками' : 'template-driven UI with page sections, forms, and interactive blocks');
	}
	if (isLaravelProject(files, composerManifest)) {
		patterns.push(isRussianLocale ? 'MVC-слои Laravel: маршруты, контроллеры, модели и миграции' : 'Laravel MVC layering with routes, controllers, models, and migrations');
	}
	if (files.some(filePath => filePath.startsWith('database/migrations/'))) {
		patterns.push(isRussianLocale ? 'схема БД версионируется миграциями' : 'database schema is versioned via migrations');
	}
	if (files.some(filePath => filePath.startsWith('tests/Feature/')) && files.some(filePath => filePath.startsWith('tests/Unit/'))) {
		patterns.push(isRussianLocale ? 'разделение unit и feature/integration тестов' : 'separate unit and feature/integration test layers');
	}
	return patterns;
}

export function buildFileSummary(filePath: string, source: string, isRussianLocale: boolean): FileSummary {
	const prepared = buildPreparedFileSummary(filePath, source, isRussianLocale);
	return materializePreparedFileSummary(prepared);
}

function materializePreparedFileSummary(
	prepared: PreparedFileSummary,
	fileDescriptionsById: ReadonlyMap<string, string> = new Map(),
	symbolDescriptionsById: ReadonlyMap<string, string> = new Map(),
	frontendBlockDescriptionsById: ReadonlyMap<string, string> = new Map(),
): FileSummary {
	return {
		path: prepared.path,
		lineCount: prepared.lineCount,
		description: fileDescriptionsById.get(prepared.fileDescriptionId) || prepared.description,
		role: prepared.role,
		imports: [...prepared.imports],
		frontendContract: [...prepared.frontendContract],
		frontendBlocks: prepared.frontendBlocks.map(block => ({
			kind: block.kind,
			name: block.name,
			line: block.line,
			column: block.column,
			description: frontendBlockDescriptionsById.get(block.id) || block.description,
			purpose: block.purpose,
			stateDeps: [...block.stateDeps],
			eventHandlers: [...block.eventHandlers],
			dataSources: [...block.dataSources],
			childComponents: [...block.childComponents],
			conditions: [...block.conditions],
			routes: [...block.routes],
			forms: [...block.forms],
		})),
		symbols: prepared.symbols.map(symbol => ({
			kind: symbol.kind,
			name: symbol.name,
			signature: symbol.signature,
			line: symbol.line,
			column: symbol.column,
			description: symbolDescriptionsById.get(symbol.id) || symbol.description,
		})),
	};
}

function normalizeCachedFileSummary(value: unknown): FileSummary | null {
	if (!value || typeof value !== 'object') {
		return null;
	}

	const record = value as Partial<FileSummary>;
	if (typeof record.path !== 'string' || typeof record.role !== 'string' || !Array.isArray(record.imports) || !Array.isArray(record.symbols)) {
		return null;
	}

	return {
		path: record.path,
		lineCount: Number.isFinite(record.lineCount) ? Number(record.lineCount) : 0,
		description: typeof record.description === 'string' ? record.description.trim() : '',
		role: record.role,
		imports: record.imports.map(item => String(item || '').trim()).filter(Boolean),
		frontendContract: Array.isArray(record.frontendContract)
			? record.frontendContract.map(item => String(item || '').trim()).filter(Boolean)
			: [],
		frontendBlocks: Array.isArray(record.frontendBlocks)
			? record.frontendBlocks
				.filter((block): block is FrontendBlockSummary => Boolean(block && typeof block === 'object' && typeof (block as FrontendBlockSummary).name === 'string'))
				.map(block => ({
					kind: String(block.kind || '').trim(),
					name: String(block.name || '').trim(),
					line: Number.isFinite(block.line) ? Number(block.line) : 0,
					column: Number.isFinite(block.column) ? Number(block.column) : 0,
					description: String(block.description || '').trim(),
					purpose: String(block.purpose || '').trim(),
					stateDeps: Array.isArray(block.stateDeps) ? block.stateDeps.map(item => String(item || '').trim()).filter(Boolean) : [],
					eventHandlers: Array.isArray(block.eventHandlers) ? block.eventHandlers.map(item => String(item || '').trim()).filter(Boolean) : [],
					dataSources: Array.isArray(block.dataSources) ? block.dataSources.map(item => String(item || '').trim()).filter(Boolean) : [],
					childComponents: Array.isArray(block.childComponents) ? block.childComponents.map(item => String(item || '').trim()).filter(Boolean) : [],
					conditions: Array.isArray(block.conditions) ? block.conditions.map(item => String(item || '').trim()).filter(Boolean) : [],
					routes: Array.isArray(block.routes) ? block.routes.map(item => String(item || '').trim()).filter(Boolean) : [],
					forms: Array.isArray(block.forms) ? block.forms.map(item => String(item || '').trim()).filter(Boolean) : [],
				}))
			: [],
		symbols: record.symbols
			.filter((symbol): symbol is FileSymbolSummary => Boolean(symbol && typeof symbol === 'object' && typeof (symbol as FileSymbolSummary).name === 'string'))
			.map(symbol => ({
				kind: String(symbol.kind || '').trim(),
				name: String(symbol.name || '').trim(),
				signature: String(symbol.signature || '').trim(),
				line: Number.isFinite(symbol.line) ? Number(symbol.line) : 0,
				column: Number.isFinite(symbol.column) ? Number(symbol.column) : 0,
				description: String(symbol.description || '').trim(),
			})),
	};
}

function normalizeCachedAreaSummary(value: unknown): CodeAreaSummary | null {
	if (!value || typeof value !== 'object') {
		return null;
	}

	const record = value as Partial<CodeAreaSummary>;
	if (typeof record.area !== 'string' || typeof record.description !== 'string' || !Array.isArray(record.representativeFiles) || !Array.isArray(record.symbols)) {
		return null;
	}

	return {
		area: record.area,
		fileCount: Number.isFinite(record.fileCount) ? Number(record.fileCount) : 0,
		description: record.description,
		representativeFiles: record.representativeFiles.map(item => String(item || '').trim()).filter(Boolean),
		symbols: record.symbols.map(item => String(item || '').trim()).filter(Boolean),
	};
}

function buildPreparedFileSummary(filePath: string, source: string, isRussianLocale: boolean): PreparedFileSummary {
	const imports = extractInternalImports(source);
	const role = describeFileRole(filePath, isRussianLocale);
	const frontendInsights = extractFrontendInsights(filePath, source, role, imports, isRussianLocale);
	return {
		path: filePath,
		lineCount: source ? source.split(/\r?\n/).length : 0,
		description: '',
		fileDescriptionId: createFileDescriptionId(filePath),
		role,
		excerpt: extractFileSummarySnippet(source),
		symbols: extractDetailedSymbols(filePath, source, role, isRussianLocale).slice(0, MAX_SYMBOLS_PER_FILE),
		imports,
		frontendContract: frontendInsights.contract,
		frontendBlocks: frontendInsights.blocks.slice(0, MAX_FRONTEND_BLOCKS_PER_FILE),
	};
}

function extractFrontendInsights(
	filePath: string,
	source: string,
	role: string,
	imports: string[],
	isRussianLocale: boolean,
): { contract: string[]; blocks: PreparedFrontendBlockSummary[] } {
	const sections = extractFrontendFileSections(filePath, source);
	if (!sections) {
		return { contract: [], blocks: [] };
	}

	const scriptIndex = buildFrontendScriptIndex(sections.scriptSource, imports, isRussianLocale);
	const candidates = collectFrontendTemplateCandidates(source, sections.templateSource, sections.templateOffset);
	const blocks = candidates
		.map(candidate => buildFrontendBlockSummary(filePath, role, sections.framework, candidate, scriptIndex, isRussianLocale))
		.filter((item): item is PreparedFrontendBlockSummary => Boolean(item));
	const uniqueBlocks = dedupeFrontendBlocks(blocks)
		.sort((left, right) => left.line - right.line || left.column - right.column)
		.slice(0, MAX_FRONTEND_BLOCKS_PER_FILE);

	return {
		contract: buildFrontendContractSummary(sections.framework, uniqueBlocks, scriptIndex, isRussianLocale),
		blocks: uniqueBlocks,
	};
}

function extractFrontendFileSections(filePath: string, source: string): FrontendFileSections | null {
	if (!source) {
		return null;
	}

	if (/\.vue$/i.test(filePath)) {
		const templateMatch = source.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i);
		const templateStart = templateMatch && templateMatch.index !== undefined
			? templateMatch.index + templateMatch[0].indexOf('>') + 1
			: 0;
		const scriptBlocks = Array.from(source.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi));
		return {
			framework: 'vue',
			templateSource: templateMatch?.[1] || source,
			templateOffset: templateStart,
			scriptSource: scriptBlocks.map(match => match[1] || '').join('\n\n'),
		};
	}

	if (/\.blade\.php$/i.test(filePath)) {
		return {
			framework: 'blade',
			templateSource: source,
			templateOffset: 0,
			scriptSource: extractInlineScriptContent(source),
		};
	}

	if (/\.html?$/i.test(filePath)) {
		return {
			framework: 'html',
			templateSource: source,
			templateOffset: 0,
			scriptSource: extractInlineScriptContent(source),
		};
	}

	return null;
}

function extractInlineScriptContent(source: string): string {
	return Array.from(source.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi))
		.map(match => match[1] || '')
		.join('\n\n');
}

function buildFrontendScriptIndex(scriptSource: string, imports: string[], isRussianLocale: boolean): FrontendScriptIndex {
	const stateNames = new Set<string>();
	const props = new Set<string>();
	const dataSources = new Set<string>();
	const routes = new Set<string>();
	const eventHandlerSnippets = new Map<string, string>();
	const handlerDataSources = new Map<string, string[]>();
	const knownDataSourceNames = new Set<string>();

	for (const match of scriptSource.matchAll(/\b(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:ref|reactive|computed|shallowRef|useState)\s*\(/g)) {
		stateNames.add(match[1] || '');
	}
	for (const match of scriptSource.matchAll(/\b(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(use[A-Z][A-Za-z0-9_$]*)\s*\(/g)) {
		const alias = match[1] || '';
		const callee = match[2] || '';
		if (alias) {
			stateNames.add(alias);
			knownDataSourceNames.add(alias);
		}
		if (callee) {
			dataSources.add(alias ? `${alias} (${callee})` : callee);
			if (callee === 'useRoute' || callee === 'useRouter') {
				routes.add(alias || callee.toLowerCase());
			}
		}
	}
	for (const match of scriptSource.matchAll(/\b(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*(?:Store|Service|Api))\s*=\s*(?:new\s+)?([A-Za-z_$][A-Za-z0-9_$]*)?\s*\(/g)) {
		const alias = match[1] || '';
		const callee = match[2] || '';
		if (alias) {
			knownDataSourceNames.add(alias);
			dataSources.add(callee ? `${alias} (${callee})` : alias);
		}
	}
	for (const match of scriptSource.matchAll(/\bdefineProps(?:<[^>]+>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
		for (const key of match[1].matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g)) {
			props.add(key[1] || '');
		}
	}
	for (const match of scriptSource.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*defineModel\b/g)) {
		props.add(match[1] || '');
	}
	for (const imported of imports) {
		if (/store|service|api/i.test(imported)) {
			dataSources.add(imported);
		}
	}

	const functionCandidates = extractFrontendFunctionCandidates(scriptSource);
	for (const item of functionCandidates) {
		if (!item.name || eventHandlerSnippets.has(item.name)) {
			continue;
		}
		const snippet = trimSnippet(item.snippet);
		if (!snippet) {
			continue;
		}
		eventHandlerSnippets.set(item.name, snippet);
		const sources = Array.from(knownDataSourceNames).filter(name => new RegExp(`\\b${escapeForRegex(name)}\\b`).test(snippet));
		if (/route\b|router\b/.test(snippet)) {
			routes.add(/router\b/.test(snippet) ? 'router' : 'route');
		}
		handlerDataSources.set(item.name, sources.slice(0, 4));
	}

	const contract: string[] = [];
	if (props.size > 0) {
		contract.push(isRussianLocale
			? `Входные данные и props: ${Array.from(props).slice(0, 6).join(', ')}.`
			: `Inputs and props: ${Array.from(props).slice(0, 6).join(', ')}.`);
	}
	if (dataSources.size > 0 || routes.size > 0) {
		const sources = [
			...Array.from(dataSources).slice(0, 5),
			...Array.from(routes).map(item => item === 'router' || item === 'route' ? item : `${item}`),
		];
		contract.push(isRussianLocale
			? `Источники данных и навигация: ${sources.join(', ')}.`
			: `Data sources and navigation: ${sources.join(', ')}.`);
	}
	if (eventHandlerSnippets.size > 0) {
		contract.push(isRussianLocale
			? `Связанные обработчики: ${Array.from(eventHandlerSnippets.keys()).slice(0, 6).join(', ')}.`
			: `Linked handlers: ${Array.from(eventHandlerSnippets.keys()).slice(0, 6).join(', ')}.`);
	}

	return {
		props: Array.from(props).filter(Boolean),
		stateNames: Array.from(stateNames).filter(Boolean),
		eventHandlerSnippets,
		handlerDataSources,
		dataSources: Array.from(dataSources).filter(Boolean),
		routes: Array.from(routes).filter(Boolean),
		contract,
	};
}

function extractFrontendFunctionCandidates(scriptSource: string): Array<{ name: string; snippet: string }> {
	const items: Array<{ name: string; snippet: string }> = [];
	for (const match of scriptSource.matchAll(/(^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
		const name = match[2] || '';
		const index = (match.index || 0) + (match[1]?.length || 0);
		items.push({ name, snippet: extractSymbolSnippet(scriptSource, index) });
	}
	for (const match of scriptSource.matchAll(/(^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g)) {
		const name = match[2] || '';
		const index = (match.index || 0) + (match[1]?.length || 0);
		items.push({ name, snippet: extractSymbolSnippet(scriptSource, index) });
	}
	return items;
}

function collectFrontendTemplateCandidates(
	fullSource: string,
	templateSource: string,
	templateOffset: number,
): FrontendTemplateCandidate[] {
	const candidates: FrontendTemplateCandidate[] = [];
	for (let index = 0; index < templateSource.length; index += 1) {
		if (templateSource[index] !== '<') {
			continue;
		}
		if (templateSource.startsWith('<!--', index)) {
			const commentEnd = templateSource.indexOf('-->', index + 4);
			index = commentEnd >= 0 ? commentEnd + 2 : templateSource.length;
			continue;
		}
		if (templateSource[index + 1] === '/' || templateSource[index + 1] === '!' || templateSource[index + 1] === '?') {
			continue;
		}

		const tag = readHtmlStartTag(templateSource, index);
		if (!tag) {
			continue;
		}
		index = Math.max(index, tag.endIndex - 1);
		const score = scoreFrontendTemplateTag(tag.tagName, tag.attrs);
		if (score <= 0) {
			continue;
		}
		const globalStart = templateOffset + tag.startIndex;
		const location = getLocation(fullSource, globalStart);
		const excerpt = buildTemplateCandidateExcerpt(templateSource, tag.startIndex, tag.endIndex, tag.tagName);
		candidates.push({
			tagName: tag.tagName,
			attrs: tag.attrs,
			startIndex: globalStart,
			endIndex: globalStart + excerpt.length,
			startTagEnd: templateOffset + tag.endIndex,
			location,
			excerpt,
			score,
		});
	}

	return candidates
		.sort((left, right) => right.score - left.score || left.startIndex - right.startIndex)
		.slice(0, MAX_FRONTEND_BLOCKS_PER_FILE * 2);
}

function readHtmlStartTag(source: string, startIndex: number): { tagName: string; attrs: string; startIndex: number; endIndex: number } | null {
	if (source[startIndex] !== '<') {
		return null;
	}
	let cursor = startIndex + 1;
	while (cursor < source.length && /\s/.test(source[cursor] || '')) {
		cursor += 1;
	}
	const nameStart = cursor;
	while (cursor < source.length && /[A-Za-z0-9:_-]/.test(source[cursor] || '')) {
		cursor += 1;
	}
	const tagName = source.slice(nameStart, cursor);
	if (!tagName) {
		return null;
	}
	let inQuote = '';
	while (cursor < source.length) {
		const character = source[cursor] || '';
		if (inQuote) {
			if (character === inQuote) {
				inQuote = '';
			}
		} else if (character === '"' || character === '\'') {
			inQuote = character;
		} else if (character === '>') {
			const raw = source.slice(startIndex, cursor + 1);
			const attrs = raw.replace(/^<[^\s>]+/, '').replace(/\/?>$/, '').trim();
			return {
				tagName,
				attrs,
				startIndex,
				endIndex: cursor + 1,
			};
		}
		cursor += 1;
	}
	return null;
}

function buildTemplateCandidateExcerpt(source: string, startIndex: number, startTagEnd: number, tagName: string): string {
	if (VOID_HTML_TAGS.has(tagName.toLowerCase())) {
		return trimSnippet(source.slice(startIndex, Math.min(source.length, startTagEnd + 220)));
	}
	const closingIndex = source.indexOf(`</${tagName}`, startTagEnd);
	if (closingIndex >= 0) {
		const closeEnd = source.indexOf('>', closingIndex);
		if (closeEnd >= 0) {
			return trimSnippet(source.slice(startIndex, Math.min(source.length, closeEnd + 1)));
		}
	}
	return trimSnippet(source.slice(startIndex, Math.min(source.length, startIndex + 900)));
}

function scoreFrontendTemplateTag(tagName: string, attrs: string): number {
	const lowerTag = tagName.toLowerCase();
	const attrsLower = attrs.toLowerCase();
	const isCustom = isCustomFrontendTag(tagName);
	const hasInteractivity = /(?:@|v-on:|wire:|x-on:|v-model|:to=|href=|type\s*=\s*["']submit["'])/.test(attrs);
	const hasVisibility = /(?:v-if|v-else|v-show|x-show|wire:loading)/.test(attrs);
	const classSignals = /(toolbar|filter|search|table|grid|list|card|dialog|modal|empty|sidebar|tabs|nav|header|footer|actions)/.test(attrsLower);

	if (isCustom) {
		return 100 + (hasInteractivity ? 10 : 0);
	}
	if (['main', 'form', 'table', 'dialog', 'nav', 'aside', 'section', 'header', 'footer'].includes(lowerTag)) {
		return 80 + (hasInteractivity ? 10 : 0) + (hasVisibility ? 6 : 0);
	}
	if (['article', 'div'].includes(lowerTag) && classSignals) {
		return 62 + (hasInteractivity ? 8 : 0) + (hasVisibility ? 6 : 0);
	}
	if (['ul', 'ol'].includes(lowerTag) && (classSignals || hasInteractivity)) {
		return 56;
	}
	return 0;
}

function buildFrontendBlockSummary(
	filePath: string,
	role: string,
	framework: 'vue' | 'html' | 'blade',
	candidate: FrontendTemplateCandidate,
	scriptIndex: FrontendScriptIndex,
	isRussianLocale: boolean,
): PreparedFrontendBlockSummary | null {
	const kind = detectFrontendBlockKind(candidate.tagName, candidate.attrs, candidate.excerpt);
	const name = inferFrontendBlockName(filePath, candidate.tagName, candidate.attrs, candidate.excerpt, kind);
	const eventHandlers = extractFrontendEventHandlers(candidate.attrs, candidate.excerpt);
	const stateDeps = extractFrontendStateDependencies(candidate.attrs, candidate.excerpt, scriptIndex);
	const conditions = extractFrontendConditions(candidate.attrs, candidate.excerpt);
	const childComponents = extractChildComponentNames(candidate.excerpt, candidate.tagName);
	const forms = extractFrontendFormFields(candidate.excerpt);
	const routes = extractFrontendRoutes(candidate.attrs, candidate.excerpt, eventHandlers, scriptIndex);
	const linkedScriptSnippets = eventHandlers
		.map(handler => scriptIndex.eventHandlerSnippets.get(handler) || '')
		.filter(Boolean)
		.slice(0, 3);
	const dataSources = uniqueStrings([
		...eventHandlers.flatMap(handler => scriptIndex.handlerDataSources.get(handler) || []),
		...scriptIndex.dataSources.filter(item => stateDeps.some(state => item.includes(state)) || routes.some(route => item.includes(route))),
		...scriptIndex.routes.filter(item => routes.includes(item)),
	]).slice(0, 6);
	const purpose = describeFrontendBlockPurpose(kind, name, forms, childComponents, eventHandlers, isRussianLocale);
	const fallbackDescription = describeFrontendBlock(filePath, name, kind, purpose, stateDeps, eventHandlers, dataSources, conditions, childComponents, forms, routes, isRussianLocale);
	if (!fallbackDescription) {
		return null;
	}

	return {
		id: createSymbolId(filePath, 'ui-block', name, candidate.location.line, candidate.location.column),
		filePath,
		fileRole: role,
		framework,
		kind,
		name,
		line: candidate.location.line,
		column: candidate.location.column,
		description: fallbackDescription,
		fallbackDescription,
		purpose,
		stateDeps,
		eventHandlers,
		dataSources,
		childComponents,
		conditions,
		routes,
		forms,
		excerpt: candidate.excerpt,
		linkedScriptSnippets,
	};
}

function dedupeFrontendBlocks(blocks: PreparedFrontendBlockSummary[]): PreparedFrontendBlockSummary[] {
	const seen = new Set<string>();
	const result: PreparedFrontendBlockSummary[] = [];
	for (const block of blocks) {
		const key = `${block.kind}:${block.name}:${block.line}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(block);
	}
	return result;
}

function buildFrontendContractSummary(
	framework: 'vue' | 'html' | 'blade',
	blocks: PreparedFrontendBlockSummary[],
	scriptIndex: FrontendScriptIndex,
	isRussianLocale: boolean,
): string[] {
	const lines = [
		isRussianLocale
			? `Фреймворк/UI-слой: ${framework}. Значимые блоки: ${blocks.length > 0 ? blocks.map(block => block.name).slice(0, 4).join(', ') : 'не выделены'}.`
			: `Framework/UI layer: ${framework}. Meaningful blocks: ${blocks.length > 0 ? blocks.map(block => block.name).slice(0, 4).join(', ') : 'none detected'}.`,
		...scriptIndex.contract,
	];
	return lines.filter(Boolean).slice(0, 3);
}

function isCustomFrontendTag(tagName: string): boolean {
	return tagName.includes('-') || /^[A-Z]/.test(tagName);
}

function detectFrontendBlockKind(tagName: string, attrs: string, excerpt: string): string {
	const lowerTag = tagName.toLowerCase();
	const lower = `${attrs} ${excerpt}`.toLowerCase();
	if (/\b(dialog|modal)\b/.test(lower) || lowerTag === 'dialog') { return 'dialog'; }
	if (/\b(empty|no-results|zero-state)\b/.test(lower)) { return 'empty-state'; }
	if (/\b(filter|search)\b/.test(lower) || (lowerTag === 'form' && /\bv-model|name=/.test(lower))) { return 'filters'; }
	if (/\b(toolbar|actions)\b/.test(lower) || lowerTag === 'header') { return 'toolbar'; }
	if (/\b(sidebar|drawer)\b/.test(lower) || lowerTag === 'aside') { return 'sidebar'; }
	if (/\b(tab|tabs)\b/.test(lower)) { return 'tabs'; }
	if (lowerTag === 'table' || /\btable|grid\b/.test(lower)) { return 'table'; }
	if (lowerTag === 'form') { return 'form'; }
	if (lowerTag === 'nav') { return 'navigation'; }
	if (lowerTag === 'main') { return 'page'; }
	if (lowerTag === 'section') { return 'section'; }
	if (['ul', 'ol'].includes(lowerTag) || /\blist\b/.test(lower)) { return 'list'; }
	if (/\b(card|tile)\b/.test(lower)) { return 'card'; }
	return isCustomFrontendTag(tagName) ? 'section' : 'layout';
}

function inferFrontendBlockName(filePath: string, tagName: string, attrs: string, excerpt: string, kind: string): string {
	if (isCustomFrontendTag(tagName)) {
		return toPascalCase(tagName.replace(/^x-/, ''));
	}
	const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
	if (idMatch?.[1]) {
		return toPascalCase(idMatch[1]);
	}
	const classMatch = attrs.match(/\bclass\s*=\s*["']([^"']+)["']/i);
	if (classMatch?.[1]) {
		const tokens = classMatch[1].split(/\s+/).filter(Boolean);
		const significantToken = tokens.find(token => /(toolbar|filter|search|table|list|card|dialog|modal|empty|sidebar|tabs|header|footer)/i.test(token));
		if (significantToken) {
			return toPascalCase(significantToken);
		}
	}
	const headingMatch = excerpt.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
	const headingText = normalizeInlineText(headingMatch?.[1] || '');
	if (headingText) {
		return `${toPascalCase(headingText.split(/\s+/).slice(0, 3).join(' '))}${toPascalCase(kind)}`;
	}
	const fileStem = filePath.split('/').pop()?.replace(/\.[^.]+(?:\.[^.]+)?$/, '') || 'Ui';
	return `${toPascalCase(fileStem)}${toPascalCase(kind)}`;
}

function extractFrontendEventHandlers(attrs: string, excerpt: string): string[] {
	const handlers = new Set<string>();
	for (const match of `${attrs}\n${excerpt}`.matchAll(/(?:@|v-on:|x-on:)([A-Za-z0-9_.:-]+)\s*=\s*["']([^"']+)["']/g)) {
		const callable = extractCallableName(match[2] || '');
		if (callable) {
			handlers.add(callable);
		}
	}
	for (const match of `${attrs}\n${excerpt}`.matchAll(/wire:([A-Za-z0-9_.:-]+)\s*=\s*["']([^"']+)["']/g)) {
		const callable = extractCallableName(match[2] || '');
		if (callable) {
			handlers.add(callable);
		}
	}
	return Array.from(handlers).slice(0, 6);
}

function extractFrontendStateDependencies(attrs: string, excerpt: string, scriptIndex: FrontendScriptIndex): string[] {
	const expressions: string[] = [];
	for (const match of `${attrs}\n${excerpt}`.matchAll(/(?:v-model(?::[A-Za-z-]+)?|x-model|wire:model|v-if|v-else-if|v-show|:[A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']/g)) {
		expressions.push(match[1] || '');
	}
	for (const match of excerpt.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)) {
		expressions.push(match[1] || '');
	}
	const known = new Set([...scriptIndex.stateNames, ...scriptIndex.props, ...scriptIndex.routes.map(item => item.replace(/\s*\(.*/, ''))]);
	const identifiers = uniqueStrings(expressions.flatMap(expression => extractExpressionIdentifiers(expression)))
		.filter(identifier => !identifier.startsWith('v') && !['true', 'false', 'null', 'undefined'].includes(identifier));
	const prioritized = identifiers.filter(identifier => known.has(identifier));
	return uniqueStrings([...prioritized, ...identifiers]).slice(0, 6);
}

function extractFrontendConditions(attrs: string, excerpt: string): string[] {
	const conditions = new Set<string>();
	for (const match of `${attrs}\n${excerpt}`.matchAll(/(?:v-if|v-else-if|v-show|x-show)\s*=\s*["']([^"']+)["']/g)) {
		const condition = normalizeInlineText(match[1] || '');
		if (condition) {
			conditions.add(condition);
		}
	}
	for (const match of excerpt.matchAll(/@if\s*\(([^)]+)\)/g)) {
		const condition = normalizeInlineText(match[1] || '');
		if (condition) {
			conditions.add(condition);
		}
	}
	return Array.from(conditions).slice(0, 3);
}

function extractChildComponentNames(excerpt: string, currentTagName: string): string[] {
	const components = new Set<string>();
	for (const match of excerpt.matchAll(/<([A-Za-z][A-Za-z0-9:_-]*)\b/g)) {
		const tagName = match[1] || '';
		if (!tagName || tagName === currentTagName || !isCustomFrontendTag(tagName)) {
			continue;
		}
		components.add(toPascalCase(tagName.replace(/^x-/, '')));
	}
	return Array.from(components).slice(0, 6);
}

function extractFrontendFormFields(excerpt: string): string[] {
	const fields = new Set<string>();
	for (const match of excerpt.matchAll(/\bname\s*=\s*["']([^"']+)["']/g)) {
		if (match[1]) {
			fields.add(match[1]);
		}
	}
	for (const match of excerpt.matchAll(/(?:v-model(?::[A-Za-z-]+)?|x-model|wire:model)\s*=\s*["']([^"']+)["']/g)) {
		const expression = match[1] || '';
		const segment = expression.split('.').filter(Boolean).pop();
		if (segment) {
			fields.add(segment);
		}
	}
	return Array.from(fields).slice(0, 6);
}

function extractFrontendRoutes(
	attrs: string,
	excerpt: string,
	eventHandlers: string[],
	scriptIndex: FrontendScriptIndex,
): string[] {
	const routes = new Set<string>();
	for (const match of `${attrs}\n${excerpt}`.matchAll(/\b(?:href|to|:to)\s*=\s*["']([^"']+)["']/g)) {
		const route = normalizeInlineText(match[1] || '');
		if (route) {
			routes.add(route);
		}
	}
	for (const match of `${attrs}\n${excerpt}`.matchAll(/\b(route|router)\b/g)) {
		routes.add(match[1] || '');
	}
	for (const handler of eventHandlers) {
		const snippet = scriptIndex.eventHandlerSnippets.get(handler) || '';
		if (/\brouter\./.test(snippet)) {
			routes.add('router');
		}
		if (/\broute\b/.test(snippet)) {
			routes.add('route');
		}
	}
	return Array.from(routes).slice(0, 4);
}

function describeFrontendBlockPurpose(
	kind: string,
	name: string,
	forms: string[],
	childComponents: string[],
	eventHandlers: string[],
	isRussianLocale: boolean,
): string {
	const details: string[] = [];
	if (forms.length > 0) {
		details.push(isRussianLocale ? `управляет полями ${forms.join(', ')}` : `manages fields ${forms.join(', ')}`);
	}
	if (eventHandlers.length > 0) {
		details.push(isRussianLocale ? `запускает действия ${eventHandlers.join(', ')}` : `triggers ${eventHandlers.join(', ')}`);
	}
	if (childComponents.length > 0) {
		details.push(isRussianLocale ? `собирает дочерние компоненты ${childComponents.join(', ')}` : `composes child components ${childComponents.join(', ')}`);
	}
	if (details.length === 0) {
		details.push(isRussianLocale ? `служит блоком типа «${kind}»` : `acts as a ${kind} block`);
	}
	return isRussianLocale
		? `${name} ${details.join(', ')}.`
		: `${name} ${details.join(', ')}.`;
}

function describeFrontendBlock(
	filePath: string,
	name: string,
	kind: string,
	purpose: string,
	stateDeps: string[],
	eventHandlers: string[],
	dataSources: string[],
	conditions: string[],
	childComponents: string[],
	forms: string[],
	routes: string[],
	isRussianLocale: boolean,
): string {
	const parts = [purpose.replace(/\.$/, '')];
	if (stateDeps.length > 0) {
		parts.push(isRussianLocale
			? `зависит от состояния ${stateDeps.join(', ')}`
			: `depends on state ${stateDeps.join(', ')}`);
	}
	if (eventHandlers.length > 0) {
		parts.push(isRussianLocale
			? `инициирует ${eventHandlers.join(', ')}`
			: `triggers ${eventHandlers.join(', ')}`);
	}
	if (dataSources.length > 0) {
		parts.push(isRussianLocale
			? `опирается на источники данных ${dataSources.join(', ')}`
			: `relies on data sources ${dataSources.join(', ')}`);
	}
	if (conditions.length > 0) {
		parts.push(isRussianLocale
			? `переключается по условиям ${conditions.join(', ')}`
			: `switches by conditions ${conditions.join(', ')}`);
	}
	if (forms.length > 0 && (kind === 'form' || kind === 'filters')) {
		parts.push(isRussianLocale
			? `содержит поля ${forms.join(', ')}`
			: `contains fields ${forms.join(', ')}`);
	}
	if (childComponents.length > 0) {
		parts.push(isRussianLocale
			? `внутри использует ${childComponents.join(', ')}`
			: `internally uses ${childComponents.join(', ')}`);
	}
	if (routes.length > 0) {
		parts.push(isRussianLocale
			? `связан с навигацией ${routes.join(', ')}`
			: `is tied to navigation ${routes.join(', ')}`);
	}
	const normalized = uniqueStrings(parts).join('. ').replace(/\.\s*\./g, '. ').trim();
	if (!normalized) {
		return '';
	}
	return `${isRussianLocale ? 'UI-блок' : 'UI block'} ${name} ${normalized.replace(/\.$/, '')}.`.replace(/\s+/g, ' ').trim();
}

function extractCallableName(expression: string): string {
	const normalized = (expression || '').trim();
	if (!normalized) {
		return '';
	}
	const callableMatch = normalized.match(/([A-Za-z_$][A-Za-z0-9_$.]*)\s*\(/);
	if (callableMatch?.[1]) {
		return callableMatch[1].split('.').pop() || callableMatch[1];
	}
	if (/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(normalized)) {
		return normalized.split('.').pop() || normalized;
	}
	return '';
}

function extractExpressionIdentifiers(expression: string): string[] {
	const reserved = new Set([
		'if', 'else', 'true', 'false', 'null', 'undefined', 'return', 'typeof', 'instanceof',
		'new', 'await', 'async', 'for', 'of', 'in', 'let', 'const', 'var', 'this',
		'Math', 'Date', 'Object', 'Array', 'Number', 'String', 'Boolean',
	]);
	const identifiers = new Set<string>();
	for (const match of (expression || '').matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
		const value = match[1] || '';
		if (!reserved.has(value)) {
			identifiers.add(value);
		}
	}
	return Array.from(identifiers);
}

function normalizeInlineText(value: string): string {
	return (value || '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\{\{[\s\S]*?\}\}/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function toPascalCase(value: string): string {
	return (value || '')
		.replace(/[^A-Za-z0-9]+/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.map(token => token.charAt(0).toUpperCase() + token.slice(1))
		.join('') || 'UiBlock';
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
}

function escapeForRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function describeFileRole(filePath: string, isRussianLocale: boolean): string {
	const lower = filePath.toLowerCase();
	if (/^app\/http\/controllers\//.test(lower)) {
		return isRussianLocale ? 'HTTP-контроллеры и обработчики маршрутов' : 'HTTP controllers and route handlers';
	}
	if (/^app\/models\//.test(lower)) {
		return isRussianLocale ? 'модели данных и слой ORM' : 'data models and ORM layer';
	}
	if (/^app\/jobs\//.test(lower)) {
		return isRussianLocale ? 'фоновые задания и очередь' : 'background jobs and queue workload';
	}
	if (/^app\/providers\//.test(lower)) {
		return isRussianLocale ? 'провайдеры приложения и bootstrap сервисов' : 'application providers and service bootstrap';
	}
	if (/^app\/(dto|data)\//.test(lower)) {
		return isRussianLocale ? 'DTO и структуры входных данных' : 'DTOs and input data structures';
	}
	if (/^app\/services\//.test(lower)) {
		return isRussianLocale ? 'сервисная логика приложения' : 'application service logic';
	}
	if (lower.includes('/services/')) {
		return isRussianLocale ? 'сервисная логика и интеграции' : 'service logic and integrations';
	}
	if (lower.includes('/providers/')) {
		return isRussianLocale ? 'слой провайдеров и регистрации зависимостей' : 'provider layer and dependency registration';
	}
	if (lower.includes('/webview/')) {
		return isRussianLocale ? 'клиентская часть webview UI' : 'client-side webview UI';
	}
	if (/(\.vue|\.tsx|\.jsx)$/.test(lower) && /(components|pages|views|screens)/.test(lower)) {
		return isRussianLocale ? 'frontend-компоненты и страницы интерфейса' : 'frontend UI components and screens';
	}
	if (lower.includes('/types/')) {
		return isRussianLocale ? 'контракты и типы данных' : 'shared contracts and data types';
	}
	if (lower.includes('/utils/')) {
		return isRussianLocale ? 'утилиты и чистые вычисления' : 'utility and pure computation helpers';
	}
	if (/^database\/migrations\//.test(lower)) {
		return isRussianLocale ? 'миграции и версия схемы базы данных' : 'database migrations and schema versioning';
	}
	if (/^database\/factories\//.test(lower)) {
		return isRussianLocale ? 'фабрики моделей для тестов и seed-данных' : 'model factories for tests and seed data';
	}
	if (/^database\/seeders\//.test(lower)) {
		return isRussianLocale ? 'заполнение базы начальными данными' : 'database seeders and initial data setup';
	}
	if (/^routes\//.test(lower)) {
		return isRussianLocale ? 'маршруты и карта HTTP/CLI-точек входа' : 'route declarations and HTTP/CLI entry mapping';
	}
	if (/^resources\/views\//.test(lower)) {
		return isRussianLocale ? 'шаблоны представлений и серверный UI' : 'view templates and server-rendered UI';
	}
	if (/^resources\/(js|ts|css|scss)\//.test(lower)) {
		return isRussianLocale ? 'frontend-ассеты и клиентские точки входа' : 'frontend assets and client entry points';
	}
	if (/\.html?$/.test(lower)) {
		return isRussianLocale ? 'HTML-шаблоны и структура интерфейса' : 'HTML templates and interface structure';
	}
	if (/^config\//.test(lower)) {
		return isRussianLocale ? 'конфигурация приложения и окружения' : 'application and environment configuration';
	}
	if (/^bootstrap\//.test(lower)) {
		return isRussianLocale ? 'bootstrap и запуск приложения' : 'bootstrap and application startup';
	}
	if (/^public\//.test(lower)) {
		return isRussianLocale ? 'публичные web-ассеты и входная точка HTTP' : 'public web assets and HTTP entry point';
	}
	if (/^storage\/framework\//.test(lower)) {
		return isRussianLocale ? 'сгенерированные runtime-артефакты фреймворка' : 'generated framework runtime artifacts';
	}
	if (/^storage\//.test(lower)) {
		return isRussianLocale ? 'runtime-хранилище, логи и временные данные' : 'runtime storage, logs, and temporary data';
	}
	if (/^artisan$/.test(lower)) {
		return isRussianLocale ? 'CLI-точка входа Laravel' : 'Laravel CLI entry point';
	}
	if (/composer\.json$/.test(lower)) {
		return isRussianLocale ? 'PHP-манифест зависимостей и автозагрузки' : 'PHP dependency and autoload manifest';
	}
	if (/package\.json$/.test(lower)) {
		return isRussianLocale ? 'манифест зависимостей и скриптов' : 'dependency and script manifest';
	}
	if (/phpunit\.xml$/.test(lower)) {
		return isRussianLocale ? 'конфигурация тестового раннера PHPUnit' : 'PHPUnit test runner configuration';
	}
	if (/docker-compose\.ya?ml$/.test(lower)) {
		return isRussianLocale ? 'docker-оркестрация локального окружения' : 'Docker orchestration for local environment';
	}
	if (/readme\.md$/.test(lower)) {
		return isRussianLocale ? 'документация проекта' : 'project documentation';
	}
	if (/test|spec/.test(lower)) {
		if (/^tests\/feature\//.test(lower)) {
			return isRussianLocale ? 'feature/integration тесты прикладных сценариев' : 'feature/integration tests for application scenarios';
		}
		if (/^tests\/unit\//.test(lower)) {
			return isRussianLocale ? 'unit-тесты отдельных компонентов и утилит' : 'unit tests for isolated components and utilities';
		}
		return isRussianLocale ? 'автотесты' : 'automated tests';
	}
	return isRussianLocale ? 'файл структуры проекта' : 'project structure file';
}

function extractDetailedSymbols(filePath: string, source: string, role: string, isRussianLocale: boolean): PreparedFileSymbolSummary[] {
	if (!source) {
		return [];
	}

	const isPhpLike = /\.php$/i.test(filePath);
	const isScriptLike = /\.(ts|tsx|js|jsx|mjs|cjs|vue)$/i.test(filePath);
	const symbols: PreparedFileSymbolSummary[] = [];
	const classPattern = /(?<!:)\b(?:export\s+)?(?:abstract\s+)?class(?:\s+([A-Za-z0-9_]+))?(?:\s+extends\s+[^{\n]+)?/g;
	for (const match of source.matchAll(classPattern)) {
		const rawClassName = match[1]?.trim();
		const className = !rawClassName || rawClassName.toLowerCase() === 'extends'
			? ANONYMOUS_CLASS_SYMBOL_NAME
			: rawClassName;
		const classIndex = match.index || 0;
		const location = getLocation(source, classIndex);
		const classBody = extractBraceBlock(source, classIndex);
		const fallbackDescription = describeClassSymbol(filePath, className, match[0].trim(), role, isRussianLocale);
		symbols.push({
			id: createSymbolId(filePath, 'class', className, location.line, location.column),
			kind: 'class',
			name: className,
			signature: match[0].trim(),
			line: location.line,
			column: location.column,
			description: fallbackDescription,
			fallbackDescription,
			filePath,
			fileRole: role,
			excerpt: extractSymbolSnippet(source, classIndex),
		});
		for (const method of extractClassMethods(filePath, classBody, role, isRussianLocale)) {
			symbols.push({
				...method,
				line: location.line + method.line - 1,
				id: createSymbolId(filePath, method.kind, method.name, location.line + method.line - 1, method.column),
			});
		}
	}

	const patterns: Array<{ kind: string; regex: RegExp; enabled: boolean; describe: (name: string, signature: string, body: string) => string }> = [
		{
			kind: 'function',
			regex: /(^|\n)\s*(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g,
			enabled: isScriptLike || isPhpLike,
			describe: (name, signature, body) => describeRoutineSymbol(
				filePath,
				'function',
				name,
				signature,
				role,
				isRussianLocale,
				body,
			),
		},
		{
			kind: 'const',
			regex: isPhpLike
				? /\bconst\s+([A-Za-z0-9_]+)\s*=\s*([^\n;]+)/g
				: /(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*([^\n;]+)/g,
			enabled: isScriptLike || isPhpLike,
			describe: (name, signature) => describeConstantSymbol(name, signature, isRussianLocale),
		},
		{
			kind: 'interface',
			regex: /(?:export\s+)?interface\s+([A-Za-z0-9_]+)/g,
			enabled: isScriptLike,
			describe: (name) => describeInterfaceSymbol(name, isRussianLocale),
		},
		{
			kind: 'type',
			regex: /(?:export\s+)?type\s+([A-Za-z0-9_]+)/g,
			enabled: isScriptLike,
			describe: (name) => describeTypeSymbol(name, isRussianLocale),
		},
		{
			kind: 'enum',
			regex: /(?:export\s+)?enum\s+([A-Za-z0-9_]+)/g,
			enabled: isScriptLike,
			describe: (name) => describeEnumSymbol(name, isRussianLocale),
		},
	];

	for (const pattern of patterns) {
		if (!pattern.enabled) {
			continue;
		}
		for (const match of source.matchAll(pattern.regex)) {
			const name = pattern.kind === 'function' ? match[2] : match[1];
			const signature = match[0].trim();
			const symbolIndex = pattern.kind === 'function'
				? (match.index || 0) + (match[1]?.length || 0)
				: (match.index || 0);
			const location = getLocation(source, symbolIndex);
			if (symbols.some(item => item.kind === pattern.kind && item.name === name && item.line === location.line)) {
				continue;
			}
			const body = pattern.kind === 'function' ? extractBraceBlock(source, symbolIndex) : '';
			const fallbackDescription = pattern.describe(name, signature, body);
			symbols.push({
				id: createSymbolId(filePath, pattern.kind, name, location.line, location.column),
				kind: pattern.kind,
				name,
				signature,
				line: location.line,
				column: location.column,
				description: fallbackDescription,
				fallbackDescription,
				filePath,
				fileRole: role,
				excerpt: extractSymbolSnippet(source, symbolIndex),
			});
		}
	}

	return symbols.sort((left, right) => left.line - right.line || left.column - right.column);
}

function extractClassMethods(filePath: string, classBody: string, role: string, isRussianLocale: boolean): PreparedFileSymbolSummary[] {
	const methods: PreparedFileSymbolSummary[] = [];
	if (!classBody) {
		return methods;
	}

	const reservedWords = new Set(['if', 'for', 'while', 'switch', 'catch', 'return']);
	const patterns = [
		/(^|\n)\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?::\s*([^\s{]+))?/g,
		/(^|\n)\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+)*(?:get\s+|set\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*(?::\s*([^\n{]+))?\s*\{/g,
	];

	for (const pattern of patterns) {
		for (const match of classBody.matchAll(pattern)) {
			const name = match[2];
			if (!name || reservedWords.has(name)) {
				continue;
			}
			const index = (match.index || 0) + (match[1]?.length || 0);
			const location = getLocation(classBody, index);
			const params = (match[3] || '').trim();
			const returnType = (match[4] || '').trim();
			const signature = `${name}(${params})${returnType ? `: ${returnType}` : ''}`;
			if (methods.some(item => item.name === name && item.line === location.line)) {
				continue;
			}
			const fallbackDescription = describeRoutineSymbol(filePath, 'method', name, signature, role, isRussianLocale, extractBraceBlock(classBody, index));
			methods.push({
				kind: 'method',
				name,
				signature,
				line: location.line,
				column: location.column,
				description: fallbackDescription,
				fallbackDescription,
				filePath,
				fileRole: role,
				id: '',
				excerpt: extractSymbolSnippet(classBody, index),
			});
		}
	}

	return methods;
}

function extractBraceBlock(source: string, startIndex: number): string {
	const openIndex = source.indexOf('{', startIndex);
	if (openIndex < 0) {
		return '';
	}
	let depth = 0;
	for (let index = openIndex; index < source.length; index += 1) {
		const character = source[index];
		if (character === '{') {
			depth += 1;
		} else if (character === '}') {
			depth -= 1;
			if (depth === 0) {
				return source.slice(openIndex + 1, index);
			}
		}
	}
	return source.slice(openIndex + 1);
}

function extractSymbolSnippet(source: string, startIndex: number): string {
	const normalizedStart = Math.max(0, startIndex);
	const tail = source.slice(normalizedStart);
	const firstLineEnd = tail.indexOf('\n');
	const header = (firstLineEnd >= 0 ? tail.slice(0, firstLineEnd) : tail).trim();
	const body = extractBraceBlock(source, normalizedStart).trim();
	const combined = body ? `${header}\n${body}` : header;
	return combined.replace(/\r/g, '').trim().slice(0, MAX_SYMBOL_SNIPPET_CHARS);
}

function extractFileSummarySnippet(source: string): string {
	return trimSnippet(source).slice(0, MAX_SYMBOL_SNIPPET_CHARS);
}

function createFileDescriptionId(filePath: string): string {
	return `${filePath}::file`;
}

function createSymbolId(filePath: string, kind: string, name: string, line: number, column: number): string {
	return `${filePath}::${kind}::${name}::${line}:${column}`;
}

function getLocation(source: string, index: number): { line: number; column: number } {
	const prefix = source.slice(0, index);
	const lines = prefix.split(/\r?\n/);
	return {
		line: lines.length,
		column: (lines[lines.length - 1]?.length || 0) + 1,
	};
}

function extractInternalImports(source: string): string[] {
	if (!source) {
		return [];
	}
	const imports = new Set<string>();
	for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
		const target = match[1]?.trim();
		if (target && (target.startsWith('.') || target.startsWith('@/') || target.startsWith('src/'))) {
			imports.add(target);
		}
	}
	for (const match of source.matchAll(/\buse\s+([A-Za-z0-9_\\]+)\s*;/g)) {
		const target = match[1]?.trim();
		if (target && /^(App|Tests|Database)\\/.test(target)) {
			imports.add(target);
		}
	}
	return Array.from(imports).slice(0, 8);
}

function buildRelations(fileSummaries: FileSummary[], isRussianLocale: boolean): string[] {
	const relations: string[] = [];
	for (const file of fileSummaries) {
		for (const imported of file.imports) {
			relations.push(isRussianLocale
				? `${file.path} использует ${imported}`
				: `${file.path} depends on ${imported}`);
		}
	}
	return relations.slice(0, MAX_RELATIONS);
}

function parseRecentChanges(stdout: string, isRussianLocale: boolean): string[] {
	const lines = stdout.split(/\r?\n/);
	const result: string[] = [];
	let currentHeader = '';
	let currentFiles: string[] = [];

	const flush = () => {
		if (!currentHeader) {
			return;
		}
		const fileSuffix = currentFiles.length > 0 ? ` (${currentFiles.slice(0, 4).join(', ')}${currentFiles.length > 4 ? ', ...' : ''})` : '';
		result.push(`${currentHeader}${fileSuffix}`);
		currentHeader = '';
		currentFiles = [];
	};

	for (const line of lines) {
		if (!line.trim()) {
			flush();
			continue;
		}

		if (line.includes('\t')) {
			flush();
			const [sha, date, message] = line.split('\t');
			currentHeader = isRussianLocale
				? `${date}: ${message} [${sha.slice(0, 7)}]`
				: `${date}: ${message} [${sha.slice(0, 7)}]`;
			continue;
		}

		currentFiles.push(line.trim());
	}

	flush();
	return result;
}

function isBinaryLikeFile(filePath: string): boolean {
	return /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|pdf|zip|gz|wasm|lock)$/i.test(filePath);
}

function trimSnippet(source: string): string {
	const normalized = source.replace(/\r/g, '').trim();
	if (!normalized) {
		return '';
	}
	return normalized.slice(0, 1800);
}

function estimateAreaBatchItemChars(item: CodeMapAreaDescriptionBatchItem): number {
	const filesChars = item.representativeFiles.join(', ').length;
	const symbolsChars = item.symbols.join(', ').length;
	const snippetsChars = item.snippets.reduce((total, snippet) => total + snippet.filePath.length + snippet.snippet.length + 32, 0);
	return item.id.length
		+ item.area.length
		+ (item.manifestDescription?.length || 0)
		+ filesChars
		+ symbolsChars
		+ snippetsChars
		+ 256;
}

function estimateSymbolBatchItemChars(item: CodeMapSymbolBatchItem): number {
	return item.id.length
		+ item.filePath.length
		+ item.fileRole.length
		+ item.kind.length
		+ item.name.length
		+ item.signature.length
		+ item.excerpt.length
		+ item.fallbackDescription.length
		+ 256;
}

function estimateFileSymbolBatchItemChars(item: CodeMapFileBatchItem): number {
	return item.id.length
		+ item.filePath.length
		+ item.fileRole.length
		+ item.lineCount.toString().length
		+ item.imports.join(', ').length
		+ item.frontendContract.join(' | ').length
		+ item.frontendBlockNames.join(', ').length
		+ item.excerpt.length
		+ item.fallbackDescription.length
		+ item.symbols.reduce((total, symbol) => total + estimateSymbolBatchItemChars(symbol), 0)
		+ 384;
}

function estimateFrontendBlockBatchItemChars(item: CodeMapFrontendBlockBatchItem): number {
	return item.id.length
		+ item.filePath.length
		+ item.fileRole.length
		+ item.framework.length
		+ item.blockKind.length
		+ item.blockName.length
		+ item.purpose.length
		+ item.stateDeps.join(', ').length
		+ item.eventHandlers.join(', ').length
		+ item.dataSources.join(', ').length
		+ item.childComponents.join(', ').length
		+ item.conditions.join(', ').length
		+ item.routes.join(', ').length
		+ item.forms.join(', ').length
		+ item.excerpt.length
		+ item.linkedScriptSnippets.join('\n').length
		+ item.fallbackDescription.length
		+ 320;
}

export function buildAreaDescriptionBatches<T extends CodeMapAreaDescriptionBatchItem>(
	items: T[],
	maxChars: number,
	maxItemsPerBatch = Number.MAX_SAFE_INTEGER,
): T[][] {
	const limit = Math.max(4000, Math.floor(maxChars || 0));
	const itemLimit = Math.max(1, Math.floor(maxItemsPerBatch || 0));
	const batches: T[][] = [];
	let currentBatch: T[] = [];
	let currentChars = 0;

	for (const item of items) {
		const itemChars = estimateAreaBatchItemChars(item);
		if (currentBatch.length > 0 && (currentChars + itemChars > limit || currentBatch.length >= itemLimit)) {
			batches.push(currentBatch);
			currentBatch = [];
			currentChars = 0;
		}

		currentBatch.push(item);
		currentChars += itemChars;
	}

	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}

	return batches;
}

export function buildFileSymbolDescriptionBatches(
	items: CodeMapFileBatchItem[],
	maxChars: number,
	maxItemsPerBatch = Number.MAX_SAFE_INTEGER,
	maxFilesPerBatch = Number.MAX_SAFE_INTEGER,
): CodeMapFileBatchItem[][] {
	const limit = Math.max(4000, Math.floor(maxChars || 0));
	const itemLimit = Math.max(1, Math.floor(maxItemsPerBatch || 0));
	const fileLimit = Math.max(1, Math.floor(maxFilesPerBatch || 0));
	const batches: CodeMapFileBatchItem[][] = [];
	let currentBatch: CodeMapFileBatchItem[] = [];
	let currentChars = 0;
	let currentSymbolCount = 0;

	for (const item of items) {
		const itemChars = estimateFileSymbolBatchItemChars(item);
		const itemSymbolCount = Math.max(1, item.symbols.length);
		const nextFileCount = currentBatch.length + 1;
		if (currentBatch.length > 0 && (currentChars + itemChars > limit || currentSymbolCount + itemSymbolCount > itemLimit || nextFileCount > fileLimit)) {
			batches.push(currentBatch);
			currentBatch = [];
			currentChars = 0;
			currentSymbolCount = 0;
		}
		currentBatch.push(item);
		currentChars += itemChars;
		currentSymbolCount += itemSymbolCount;
	}

	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}

	return batches;
}

export function buildFrontendBlockDescriptionBatches(
	items: CodeMapFrontendBlockBatchItem[],
	maxChars: number,
	maxItemsPerBatch = Number.MAX_SAFE_INTEGER,
	maxFilesPerBatch = Number.MAX_SAFE_INTEGER,
): CodeMapFrontendBlockBatchItem[][] {
	const limit = Math.max(4000, Math.floor(maxChars || 0));
	const itemLimit = Math.max(1, Math.floor(maxItemsPerBatch || 0));
	const fileLimit = Math.max(1, Math.floor(maxFilesPerBatch || 0));
	const batches: CodeMapFrontendBlockBatchItem[][] = [];
	let currentBatch: CodeMapFrontendBlockBatchItem[] = [];
	let currentChars = 0;
	let currentFiles = new Set<string>();

	for (const item of items) {
		const itemChars = estimateFrontendBlockBatchItemChars(item);
		const nextFileCount = currentFiles.has(item.filePath)
			? currentFiles.size
			: currentFiles.size + 1;
		if (currentBatch.length > 0 && (currentChars + itemChars > limit || currentBatch.length >= itemLimit || nextFileCount > fileLimit)) {
			batches.push(currentBatch);
			currentBatch = [];
			currentChars = 0;
			currentFiles = new Set<string>();
		}
		currentBatch.push(item);
		currentChars += itemChars;
		currentFiles.add(item.filePath);
	}

	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}

	return batches;
}

function extractJsonCandidate(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return '';
	}

	const withoutFences = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
	if (withoutFences.startsWith('{') || withoutFences.startsWith('[')) {
		return withoutFences;
	}

	const objectStart = withoutFences.indexOf('{');
	const objectEnd = withoutFences.lastIndexOf('}');
	if (objectStart >= 0 && objectEnd > objectStart) {
		return withoutFences.slice(objectStart, objectEnd + 1);
	}

	const arrayStart = withoutFences.indexOf('[');
	const arrayEnd = withoutFences.lastIndexOf(']');
	if (arrayStart >= 0 && arrayEnd > arrayStart) {
		return withoutFences.slice(arrayStart, arrayEnd + 1);
	}

	return withoutFences;
}

export function parseCodeMapAreaBatchResponse(value: string): Record<string, string> {
	return parseIdDescriptionResponse(value, 'areas');
}

function parseCodeMapFileSymbolBatchResponse(value: string): { fileDescriptions: Record<string, string>; symbolDescriptions: Record<string, string> } {
	const candidate = extractJsonCandidate(value);
	if (!candidate) {
		return {
			fileDescriptions: {},
			symbolDescriptions: {},
		};
	}

	try {
		const parsed = JSON.parse(candidate) as unknown;
		if (!parsed || typeof parsed !== 'object') {
			return {
				fileDescriptions: {},
				symbolDescriptions: {},
			};
		}
		const record = parsed as Record<string, unknown>;
		return {
			fileDescriptions: collectIdDescriptionEntries(record.files),
			symbolDescriptions: collectIdDescriptionEntries(record.symbols),
		};
	} catch {
		return {
			fileDescriptions: {},
			symbolDescriptions: {},
		};
	}
}

function parseCodeMapFrontendBatchResponse(value: string): Record<string, string> {
	return parseIdDescriptionResponse(value, 'blocks');
}

function parseIdDescriptionResponse(value: string, collectionKey: 'areas' | 'symbols' | 'blocks'): Record<string, string> {
	const candidate = extractJsonCandidate(value);
	if (!candidate) {
		return {};
	}

	try {
		const parsed = JSON.parse(candidate) as unknown;
		const result: Record<string, string> = {};
		const collect = (entries: unknown[]) => {
			for (const entry of entries) {
				if (!entry || typeof entry !== 'object') {
					continue;
				}
				const record = entry as Record<string, unknown>;
				const id = String(record.id || '').trim();
				const description = String(record.description || '').trim();
				if (id) {
					result[id] = description;
				}
			}
		};

		if (Array.isArray(parsed)) {
			collect(parsed);
			return result;
		}

		if (!parsed || typeof parsed !== 'object') {
			return {};
		}

		const record = parsed as Record<string, unknown>;
		if (Array.isArray(record[collectionKey])) {
			collect(record[collectionKey] as unknown[]);
			return result;
		}

		for (const [key, entryValue] of Object.entries(record)) {
			if (typeof entryValue === 'string') {
				result[key] = entryValue;
			}
		}

		return result;
	} catch {
		return {};
	}
}

function collectIdDescriptionEntries(value: unknown): Record<string, string> {
	if (!Array.isArray(value)) {
		return {};
	}

	const result: Record<string, string> = {};
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const id = String(record.id || '').trim();
		const description = String(record.description || '').trim();
		if (id) {
			result[id] = description;
		}
	}

	return result;
}

function normalizeAreaDescription(value: string, maxChars: number): string {
	const normalized = value
		.replace(/```[\s\S]*?```/g, '')
		.replace(/^[\-*]\s+/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!normalized) {
		return '';
	}
	return normalized.slice(0, Math.max(200, maxChars));
}

function normalizeSymbolDescription(value: string, maxChars: number): string {
	const normalized = value
		.replace(/```[\s\S]*?```/g, '')
		.replace(/^[\-*]\s+/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!normalized) {
		return '';
	}
	return normalized.slice(0, Math.max(160, maxChars));
}

function normalizeFileDescription(value: string, maxChars: number): string {
	const normalized = value
		.replace(/```[\s\S]*?```/g, '')
		.replace(/^[\-*]\s+/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!normalized) {
		return '';
	}
	return normalized.slice(0, Math.max(180, maxChars));
}

function buildAreaSnapshotToken(area: string, files: string[], fileBlobShas: ReadonlyMap<string, string>): string {
	const entries = files.map(filePath => {
		const blobSha = String(fileBlobShas.get(filePath) || '').trim();
		if (!blobSha) {
			return '';
		}
		return `${filePath}:${blobSha}`;
	});

	if (entries.some(entry => !entry)) {
		return '';
	}

	return createHash('sha1')
		.update(area)
		.update('\0')
		.update(entries.join('\n'))
		.digest('hex');
}

function buildCodeMapSourceSnapshotToken(
	files: string[],
	fileBlobShas: ReadonlyMap<string, string>,
	gitIgnoreFiles: string[],
	gitIgnoreBlobShas: ReadonlyMap<string, string>,
): string {
	const fileEntries = [...files]
		.sort((left, right) => left.localeCompare(right))
		.map(filePath => `${filePath}:${String(fileBlobShas.get(filePath) || '').trim()}`);
	const gitIgnoreEntries = [...gitIgnoreFiles]
		.sort((left, right) => left.localeCompare(right))
		.map(filePath => `${filePath}:${String(gitIgnoreBlobShas.get(filePath) || '').trim()}`);

	return createHash('sha1')
		.update(JSON.stringify({
			files: fileEntries,
			gitignore: gitIgnoreEntries,
		}))
		.digest('hex');
}

function normalizeExcludedPaths(paths: string[]): string[] {
	return Array.from(new Set((paths || [])
		.map(item => String(item || '').trim().replace(/^\.\/+/, '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
		.filter(Boolean)));
}

function matchesConfiguredExclusion(filePath: string, excludedPaths: string[]): boolean {
	const normalizedFilePath = String(filePath || '').replace(/\\/g, '/');
	if (!normalizedFilePath) {
		return false;
	}

	return excludedPaths.some(excludedPath => {
		if (!excludedPath) {
			return false;
		}
		if (excludedPath.includes('/')) {
			return normalizedFilePath === excludedPath || normalizedFilePath.startsWith(`${excludedPath}/`);
		}
		return normalizedFilePath.split('/').includes(excludedPath);
	});
}

function collectGitIgnoreFiles(files: string[], excludedPaths: string[]): string[] {
	return files
		.filter(filePath => isGitIgnoreFile(filePath))
		.filter(filePath => !matchesConfiguredExclusion(filePath, excludedPaths));
}

function isGitIgnoreFile(filePath: string): boolean {
	return filePath === '.gitignore' || filePath.endsWith('/.gitignore');
}

function isIgnoredByGitIgnore(filePath: string, matchers: GitIgnoreMatcherEntry[]): boolean {
	let ignored = false;

	for (const entry of matchers) {
		const relativePath = toRelativeGitIgnorePath(filePath, entry.basePath);
		if (!relativePath) {
			continue;
		}

		const result = entry.matcher.test(relativePath);
		if (result.ignored) {
			ignored = true;
		}
		if (result.unignored) {
			ignored = false;
		}
	}

	return ignored;
}

function toRelativeGitIgnorePath(filePath: string, basePath: string): string {
	if (!basePath) {
		return filePath;
	}
	if (filePath === basePath || !filePath.startsWith(`${basePath}/`)) {
		return '';
	}
	return filePath.slice(basePath.length + 1);
}

function getParentDirectory(filePath: string): string {
	const parts = filePath.split('/').filter(Boolean);
	if (parts.length <= 1) {
		return '';
	}
	return parts.slice(0, -1).join('/');
}

function buildAreaEntries(files: string[]): Array<{ area: string; files: string[] }> {
	const groups = new Map<string, string[]>();

	for (const filePath of files) {
		const area = detectAreaKey(filePath);
		if (!groups.has(area)) {
			groups.set(area, []);
		}
		groups.get(area)!.push(filePath);
	}

	return Array.from(groups.entries())
		.map(([area, groupFiles]) => ({
			area,
			files: groupFiles.sort((left, right) => scoreRepresentativeFile(right) - scoreRepresentativeFile(left)),
		}))
		.sort((left, right) => {
			const scoreDiff = scoreArea(left.area, left.files.length) - scoreArea(right.area, right.files.length);
			if (scoreDiff !== 0) {
				return scoreDiff;
			}

			return right.files.length - left.files.length;
		});
}

function detectAreaKey(filePath: string): string {
	const parts = filePath.split('/').filter(Boolean);
	if (parts.length === 0) {
		return '.';
	}

	if (parts[0] === 'src' && parts.length >= 2) {
		return `src/${parts[1]}`;
	}

	if (parts[0] === 'webview' && parts.length >= 2) {
		return `webview/${parts[1]}`;
	}

	return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

function scoreArea(area: string, fileCount: number): number {
	const priorityMap: Record<string, number> = {
		'app/Http': 98,
		'app/Models': 95,
		'app/Services': 94,
		'app/Providers': 93,
		'database/migrations': 90,
		'routes/api-testing.php': 88,
		'routes': 87,
		'tests/Feature': 84,
		'tests/Unit': 82,
		'src/services': 100,
		'src/providers': 96,
		'src/webview': 92,
		'src/types': 88,
		'src/utils': 86,
		'src': 84,
		'tests': 60,
		'scripts': 58,
		'media': 40,
	};

	for (const [prefix, weight] of Object.entries(priorityMap)) {
		if (area === prefix || area.startsWith(`${prefix}/`)) {
			return -(weight + fileCount / 100);
		}
	}

	return -(fileCount / 100);
}

function scoreRepresentativeFile(filePath: string): number {
	let score = 0;
	if (/^artisan$/.test(filePath)) { score += 130; }
	if (/^bootstrap\/app\.php$/.test(filePath)) { score += 120; }
	if (/^routes\//.test(filePath)) { score += 95; }
	if (/^app\/Http\/Controllers\//.test(filePath)) { score += 90; }
	if (/^app\/(Models|Services|Providers|Jobs|Dto)\//.test(filePath)) { score += 80; }
	if (/^database\/migrations\//.test(filePath)) { score += 75; }
	if (/^tests\/(Feature|Unit)\//.test(filePath)) { score += 70; }
	if (/extension\.[jt]s$/.test(filePath)) { score += 120; }
	if (/index\.[jt]s$/.test(filePath)) { score += 80; }
	if (/App\.[jt]sx?$/.test(filePath)) { score += 70; }
	if (/\.(vue|blade\.php|html?)$/i.test(filePath)) { score += 78; }
	if (/(pages|views|screens|components)\//i.test(filePath)) { score += 55; }
	if (/service|provider|manager|panel|controller|router|store/i.test(filePath)) { score += 60; }
	if (/types?|schema|model/i.test(filePath)) { score += 35; }
	if (/test|spec/i.test(filePath)) { score -= /^tests\//.test(filePath) ? 0 : 30; }
	return score - filePath.length / 1000;
}

function buildArchitectureSummary(files: string[], manifest: PackageManifest | null, composerManifest: ComposerManifest | null, isRussianLocale: boolean): string[] {
	const lines: string[] = [];
	const hasExtensionEntry = files.includes('src/extension.ts') || files.includes('src/extension.js');
	const hasWebview = files.some(filePath => filePath.startsWith('src/webview/') || filePath.startsWith('webview/'));
	const hasServices = files.some(filePath => /(^|\/)services\//.test(filePath));
	const hasProviders = files.some(filePath => /(^|\/)providers\//.test(filePath));
	const hasTests = files.some(filePath => /(^|\/)(tests|__tests__)\//.test(filePath));
	const dependencies = collectProjectDependencies(manifest, composerManifest).map(value => value.toLowerCase());

	if (dependencies.includes('vscode') || hasExtensionEntry) {
		lines.push(isRussianLocale
			? 'Проект выглядит как VS Code extension: есть extension host точка входа и команды редактора.'
			: 'The project looks like a VS Code extension with an extension-host entry point and editor commands.');
	}

	if (hasProviders && hasWebview) {
		lines.push(isRussianLocale
			? 'UI отделён от extension host: провайдеры и panel manager-ы управляют webview, а клиентские компоненты живут отдельно.'
			: 'UI is separated from the extension host: providers and panel managers control webviews while client components live separately.');
	}

	if (hasServices) {
		lines.push(isRussianLocale
			? 'Сервисный слой собирает интеграции и доменную логику; по именам каталогов видно разделение на storage/git/AI/memory/codemap задачи.'
			: 'The service layer concentrates integrations and domain logic, with folders suggesting storage/git/AI/memory/codemap responsibilities.');
	}

	if (isLaravelProject(files, composerManifest)) {
		lines.push(isRussianLocale
			? 'HTTP-поток строится по типичной схеме Laravel: routes направляют запросы в controllers, модели и сервисы обслуживают бизнес-логику, а миграции фиксируют схему БД.'
			: 'The HTTP flow follows a typical Laravel shape: routes send requests into controllers, models and services handle business logic, and migrations version the database schema.');
	}

	if (hasTests) {
		lines.push(isRussianLocale
			? 'В проекте есть отдельный набор автотестов, что позволяет проверять утилиты и генерацию инструкций отдельно от runtime расширения.'
			: 'The project includes a dedicated automated test suite, so utilities and instruction generation can be validated outside the extension runtime.');
	}

	if (lines.length === 0) {
		lines.push(isRussianLocale
			? 'Архитектура определяется в основном по структуре каталогов и ключевым конфигурационным файлам.'
			: 'Architecture is currently inferred mainly from folder structure and key configuration files.');
	}

	return lines;
}

function findEntryPoints(files: string[], isRussianLocale: boolean): string[] {
	const candidates = files
		.filter(filePath =>
			/(^|\/)(extension|index|main|app|server|cli)\.[jt]sx?$/.test(filePath)
			|| /^bootstrap\/app\.php$/.test(filePath)
			|| /^public\/index\.php$/.test(filePath)
			|| /^artisan$/.test(filePath)
			|| /^routes\/(web|api|console)(-testing)?\.php$/.test(filePath),
		)
		.sort((left, right) => scoreRepresentativeFile(right) - scoreRepresentativeFile(left))
		.slice(0, 8);
	return candidates.map(filePath => {
		const hint = describeEntryPoint(filePath, isRussianLocale);
		return `${filePath}${hint ? ` — ${hint}` : ''}`;
	});
}

function describeEntryPoint(filePath: string, isRussianLocale: boolean): string {
	if (/extension\.[jt]s$/.test(filePath)) {
		return isRussianLocale ? 'основная точка входа extension host' : 'main extension-host entry point';
	}
	if (/index\.[jt]s$/.test(filePath)) {
		return isRussianLocale ? 'точка сборки или публичный экспорт модуля' : 'module export or package entry point';
	}
	if (/App\.[jt]sx?$/.test(filePath) || /app\.[jt]sx?$/.test(filePath)) {
		return isRussianLocale ? 'корневой UI-компонент' : 'root UI component';
	}
	if (/^bootstrap\/app\.php$/.test(filePath)) {
		return isRussianLocale ? 'bootstrap приложения и сборка контейнера Laravel' : 'application bootstrap and Laravel container wiring';
	}
	if (/^public\/index\.php$/.test(filePath)) {
		return isRussianLocale ? 'публичная HTTP-точка входа приложения' : 'public HTTP entry point of the application';
	}
	if (/^artisan$/.test(filePath)) {
		return isRussianLocale ? 'CLI-вход для artisan-команд' : 'CLI entry for artisan commands';
	}
	if (/^routes\/web\.php$/.test(filePath)) {
		return isRussianLocale ? 'web-маршруты пользовательского интерфейса' : 'web route declarations';
	}
	if (/^routes\/api(-testing)?\.php$/.test(filePath)) {
		return isRussianLocale ? 'API-маршруты и тестовые HTTP-сценарии' : 'API routes and test HTTP scenarios';
	}
	if (/^routes\/console\.php$/.test(filePath)) {
		return isRussianLocale ? 'консольные команды и scheduled hooks' : 'console commands and scheduled hooks';
	}
	if (/server|cli|main/i.test(filePath)) {
		return isRussianLocale ? 'управляющий исполняемый файл' : 'control or executable entry file';
	}
	return '';
}

function describeArea(area: string, files: string[], symbols: string[], isRussianLocale: boolean): string {
	const lower = area.toLowerCase();
	const fileHint = files.slice(0, 2).join(', ');
	const symbolHint = symbols.length > 0 ? symbols.join(', ') : '';

	if (lower.includes('services')) {
		return isRussianLocale
			? `Сервисный слой с прикладной логикой и интеграциями. Видны основные точки поведения: ${symbolHint || fileHint}.`
			: `Service layer for application logic and integrations. Main behavior points visible here: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('providers')) {
		return isRussianLocale
			? `Слой провайдеров и manager-классов, который связывает VS Code API, webview и команды. Репрезентативные элементы: ${symbolHint || fileHint}.`
			: `Provider and manager layer that connects the VS Code API, webviews, and commands. Representative elements: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('webview')) {
		return isRussianLocale
			? `Клиентская UI-часть webview. Здесь находятся экраны, панели и визуальные компоненты: ${symbolHint || fileHint}.`
			: `Client-side webview UI. Screens, panels, and visual components live here: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('types')) {
		return isRussianLocale
			? `Контракты данных и типы, которыми обмениваются сервисы, UI и extension host. Ключевые определения: ${symbolHint || fileHint}.`
			: `Data contracts and types shared between services, UI, and the extension host. Key definitions: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('utils')) {
		return isRussianLocale
			? `Утилиты и чистые функции для вычислений, форматирования и вспомогательной логики. Наиболее заметные элементы: ${symbolHint || fileHint}.`
			: `Utilities and pure helpers for calculations, formatting, and support logic. Notable elements: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('test')) {
		if (lower.includes('tests/feature')) {
			return isRussianLocale
				? `Feature/integration тесты проверяют сквозные сценарии через HTTP, контейнер приложения или БД. Репрезентативные элементы: ${symbolHint || fileHint}.`
				: `Feature/integration tests validate end-to-end scenarios through HTTP, the application container, or the database. Representative elements: ${symbolHint || fileHint}.`;
		}
		if (lower.includes('tests/unit')) {
			return isRussianLocale
				? `Unit-тесты изолированно проверяют методы, хелперы и небольшие сервисы. Репрезентативные элементы: ${symbolHint || fileHint}.`
				: `Unit tests validate methods, helpers, and small services in isolation. Representative elements: ${symbolHint || fileHint}.`;
		}
		return isRussianLocale
			? `Автотесты, фиксирующие ожидаемое поведение ключевых утилит и генераторов. Покрываемые файлы: ${fileHint}.`
			: `Automated tests that lock expected behavior for core utilities and generators. Covered files include ${fileHint}.`;
	}

	if (lower.includes('database/migrations')) {
		return isRussianLocale
			? `Миграции описывают создание, изменение и откат структуры базы данных. Основные файлы: ${fileHint}.`
			: `Migrations define database schema creation, change, and rollback steps. Main files: ${fileHint}.`;
	}

	if (lower.includes('app/http')) {
		return isRussianLocale
			? `HTTP-слой принимает запросы, валидирует входные данные и делегирует работу модели или сервисам. Репрезентативные элементы: ${symbolHint || fileHint}.`
			: `The HTTP layer accepts requests, validates input, and delegates work to models or services. Representative elements: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('app/models')) {
		return isRussianLocale
			? `Модели описывают доменные сущности и их связь с хранилищем данных. Репрезентативные элементы: ${symbolHint || fileHint}.`
			: `Models describe domain entities and their relationship to persistent storage. Representative elements: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('routes')) {
		return isRussianLocale
			? `Маршруты связывают URL или консольные команды с контроллерами и обработчиками. Основные файлы: ${fileHint}.`
			: `Routes connect URLs or console commands to controllers and handlers. Main files: ${fileHint}.`;
	}

	if (lower.includes('config')) {
		return isRussianLocale
			? `Конфигурационный слой задаёт поведение окружения, сервисов и фреймворка. Основные файлы: ${fileHint}.`
			: `Configuration defines environment, service, and framework behavior. Main files: ${fileHint}.`;
	}

	if (lower.includes('scripts')) {
		return isRussianLocale
			? `Служебные скрипты для сборки, синхронизации метаданных и операционных задач. Основные файлы: ${fileHint}.`
			: `Operational scripts for build flow, metadata synchronization, and maintenance tasks. Main files: ${fileHint}.`;
	}

	if (lower.includes('media')) {
		return isRussianLocale
			? `Статические ресурсы и ассеты интерфейса. Используются extension UI и webview.`
			: `Static assets used by the extension UI and webviews.`;
	}

	return isRussianLocale
		? `Область ${area} собирает связанные файлы вокруг одной ответственности. Репрезентативные элементы: ${symbolHint || fileHint}.`
		: `Area ${area} groups related files around a shared responsibility. Representative elements: ${symbolHint || fileHint}.`;
}

function extractSymbolNames(filePath: string, source: string): string[] {
	return Array.from(new Set(extractDetailedSymbols(filePath, source, '', false).map(symbol => symbol.name)));
}

function summarizeExtensions(files: string[]): string[] {
	const counts = new Map<string, number>();
	for (const filePath of files) {
		const extension = normalizeLanguageLabel(filePath);
		if (!extension) {
			continue;
		}
		counts.set(extension, (counts.get(extension) || 0) + 1);
	}

	return Array.from(counts.entries())
		.sort((left, right) => right[1] - left[1])
		.slice(0, 8)
		.map(([extension]) => extension);
}

function detectFrameworks(manifest: PackageManifest | null, composerManifest: ComposerManifest | null, files: string[]): string[] {
	const dependencies = collectProjectDependencies(manifest, composerManifest).map(value => value.toLowerCase());
	const detected: string[] = [];
	const signals: Array<[string, string]> = [
		['vscode', 'VS Code Extension'],
		['laravel/framework', 'Laravel'],
		['illuminate/', 'Laravel'],
		['phpunit/phpunit', 'PHPUnit'],
		['react', 'React'],
		['vue', 'Vue'],
		['next', 'Next.js'],
		['express', 'Express'],
		['nestjs', 'NestJS'],
		['tailwindcss', 'Tailwind CSS'],
		['vite', 'Vite'],
		['typescript', 'TypeScript'],
		['sql.js', 'sql.js'],
	];

	for (const [needle, label] of signals) {
		if (dependencies.some(value => value === needle || value.includes(needle))) {
			detected.push(label);
		}
	}

	if (detected.length === 0 && isLaravelProject(files, composerManifest)) {
		detected.push('Laravel');
	}
	if (files.some(filePath => /\.vue$/i.test(filePath)) && !detected.includes('Vue')) {
		detected.push('Vue');
	}

	return Array.from(new Set(detected));
}

function normalizeLanguageLabel(filePath: string): string | null {
	const lower = filePath.toLowerCase();
	if (lower.endsWith('.blade.php')) { return 'blade'; }
	if (lower.endsWith('.vue')) { return 'vue'; }
	if (lower.endsWith('.html') || lower.endsWith('.htm')) { return 'html'; }
	if (lower.endsWith('.php')) { return 'php'; }
	if (lower.endsWith('.ts')) { return 'ts'; }
	if (lower.endsWith('.tsx')) { return 'tsx'; }
	if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) { return 'js'; }
	if (lower.endsWith('.jsx')) { return 'jsx'; }
	if (lower.endsWith('.json')) { return 'json'; }
	if (lower.endsWith('.md')) { return 'md'; }
	if (lower.endsWith('.yml') || lower.endsWith('.yaml')) { return 'yaml'; }
	if (lower.endsWith('.xml')) { return 'xml'; }
	if (lower.endsWith('.css')) { return 'css'; }
	if (lower.endsWith('.scss')) { return 'scss'; }
	if (lower.endsWith('.sql')) { return 'sql'; }
	if (lower.endsWith('.sh')) { return 'sh'; }
	if (lower === 'artisan') { return 'php'; }
	if (lower.startsWith('.env')) { return 'env'; }
	return null;
}

function collectProjectScripts(manifest: PackageManifest | null, composerManifest: ComposerManifest | null): string[] {
	return Array.from(new Set([
		...Object.keys(manifest?.scripts || {}),
		...Object.keys(composerManifest?.scripts || {}),
	])).filter(Boolean);
}

function collectProjectDependencies(manifest: PackageManifest | null, composerManifest: ComposerManifest | null): string[] {
	return Array.from(new Set([
		...Object.keys(manifest?.dependencies || {}),
		...Object.keys(manifest?.devDependencies || {}),
		...Object.keys(composerManifest?.require || {}),
		...Object.keys(composerManifest?.requireDev || {}),
	].filter(name => name && name !== 'php' && !name.startsWith('ext-'))));
}

function resolveProjectName(manifest: PackageManifest | null, composerManifest: ComposerManifest | null, repository: string): string {
	return manifest?.name || composerManifest?.name || repository;
}

function resolveProjectDescription(manifest: PackageManifest | null, composerManifest: ComposerManifest | null, isRussianLocale: boolean, fallback: string): string {
	return manifest?.description?.trim() || composerManifest?.description?.trim() || fallback || (isRussianLocale ? 'Описание проекта не найдено.' : 'Project description was not found.');
}

function isLaravelProject(files: string[], composerManifest: ComposerManifest | null): boolean {
	const dependencies = [
		...Object.keys(composerManifest?.require || {}),
		...Object.keys(composerManifest?.requireDev || {}),
	].map(value => value.toLowerCase());
	return dependencies.some(value => value === 'laravel/framework' || value.startsWith('illuminate/'))
		|| (files.some(filePath => filePath.startsWith('app/Http/Controllers/'))
			&& files.some(filePath => filePath.startsWith('routes/'))
			&& files.some(filePath => filePath.startsWith('database/migrations/')));
}

function isAnalysisNoiseFile(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return lower.endsWith('.swp')
		|| lower.endsWith('.swo')
		|| lower.endsWith('~')
		|| lower === '.gitignore'
		|| lower === '.gitattributes'
		|| lower === '.editorconfig'
		|| /\/\.gitignore$/.test(lower)
		|| /^storage\/framework\//.test(lower)
		|| /^bootstrap\/cache\//.test(lower)
		|| /^vendor\//.test(lower)
		|| /^node_modules\//.test(lower)
		|| /(^|\/)\.ds_store$/.test(lower)
		|| /composer\.lock$/.test(lower)
		|| /package-lock\.json$/.test(lower)
		|| /pnpm-lock\.ya?ml$/.test(lower)
		|| /yarn\.lock$/.test(lower)
		|| /^public\/favicon\.ico$/.test(lower)
		|| isBinaryLikeFile(filePath);
}

function selectFilesForAnalysis(files: string[]): string[] {
	const relevant = files.filter(filePath => !isAnalysisNoiseFile(filePath));
	return relevant.length > 0 ? relevant : files.filter(filePath => !isBinaryLikeFile(filePath));
}

function selectFilesForDetailedSummary(files: string[]): string[] {
	return files
		.filter(filePath => !/^storage\//.test(filePath.toLowerCase()))
		.sort((left, right) => scoreDetailedFile(right) - scoreDetailedFile(left))
		.slice(0, MAX_FILE_SUMMARY_COUNT)
		.sort((left, right) => left.localeCompare(right));
}

function scoreDetailedFile(filePath: string): number {
	let score = scoreRepresentativeFile(filePath);
	const lower = filePath.toLowerCase();
	if (/^config\//.test(lower)) { score += 50; }
	if (/^resources\/views\//.test(lower)) { score += 40; }
	if (/^resources\/(js|ts|css|scss)\//.test(lower)) { score += 45; }
	if (/\.(vue|blade\.php|html?)$/i.test(filePath)) { score += 42; }
	if (/(pages|views|screens|components)\//.test(lower)) { score += 28; }
	if (/^database\/(migrations|factories|seeders)\//.test(lower)) { score += 55; }
	if (/^tests\/(feature|unit)\//.test(lower)) { score += 35; }
	if (/^README\.md$/i.test(filePath)) { score += 20; }
	if (/^package\.json$|^composer\.json$|^phpunit\.xml$|^artisan$/i.test(filePath)) { score += 65; }
	if (/\.example$/.test(lower)) { score -= 25; }
	return score;
}

function describeClassSymbol(filePath: string, className: string, signature: string, role: string, isRussianLocale: boolean): string {
	const lower = filePath.toLowerCase();
	const extendsMatch = signature.match(/extends\s+([A-Za-z0-9_\\]+)/);
	const baseClass = extendsMatch?.[1];
	const displayName = className === ANONYMOUS_CLASS_SYMBOL_NAME
		? (isRussianLocale ? 'анонимный класс' : 'anonymous class')
		: className;

	if (/^tests\//.test(lower)) {
		return isRussianLocale
			? `Тестовый класс ${displayName} группирует сценарии проверки для области «${role}».${baseClass ? ` Наследуется от ${baseClass}.` : ''}`
			: `Test class ${displayName} groups verification scenarios for the “${role}” area.${baseClass ? ` It extends ${baseClass}.` : ''}`;
	}
	if (/^app\/http\/controllers\//.test(lower)) {
		return isRussianLocale
			? `Класс ${displayName} обрабатывает HTTP-сценарии этой области и координирует ответ клиенту.${baseClass ? ` Базовый класс: ${baseClass}.` : ''}`
			: `Class ${displayName} handles HTTP scenarios in this area and coordinates responses back to the client.${baseClass ? ` Base class: ${baseClass}.` : ''}`;
	}
	if (/^app\/models\//.test(lower)) {
		return isRussianLocale
			? `Класс ${displayName} представляет доменную модель и поведение, связанное с хранением данных.${baseClass ? ` Наследуется от ${baseClass}.` : ''}`
			: `Class ${displayName} represents a domain model and behavior tied to persistent data.${baseClass ? ` It extends ${baseClass}.` : ''}`;
	}
	if (/^app\/providers\//.test(lower)) {
		return isRussianLocale
			? `Класс ${displayName} отвечает за регистрацию и bootstrap зависимостей приложения.${baseClass ? ` Наследуется от ${baseClass}.` : ''}`
			: `Class ${displayName} is responsible for dependency registration and application bootstrap.${baseClass ? ` It extends ${baseClass}.` : ''}`;
	}
	if (/^app\/jobs\//.test(lower)) {
		return isRussianLocale
			? `Класс ${displayName} описывает фоновую задачу или единицу работы для очереди.${baseClass ? ` Наследуется от ${baseClass}.` : ''}`
			: `Class ${displayName} describes a background job or queue work item.${baseClass ? ` It extends ${baseClass}.` : ''}`;
	}
	if (/^app\/(services|dto)\//.test(lower) || /\/services\//.test(lower)) {
		return isRussianLocale
			? `Класс ${displayName} концентрирует ответственность области «${role}».${baseClass ? ` Наследуется от ${baseClass}.` : ''}`
			: `Class ${displayName} concentrates the responsibility of the “${role}” area.${baseClass ? ` It extends ${baseClass}.` : ''}`;
	}

	return isRussianLocale
		? `Класс ${displayName} является основным объектом этого файла и задаёт его публичную ответственность.${baseClass ? ` Наследуется от ${baseClass}.` : ''}`
		: `Class ${displayName} is the main object in this file and defines its public responsibility.${baseClass ? ` It extends ${baseClass}.` : ''}`;
}

function describeRoutineSymbol(
	filePath: string,
	kind: 'function' | 'method',
	name: string,
	signature: string,
	role: string,
	isRussianLocale: boolean,
	body = '',
): string {
	const lower = filePath.toLowerCase();
	const normalizedName = name.toLowerCase();
	const subject = kind === 'method'
		? (isRussianLocale ? 'Метод' : 'Method')
		: (isRussianLocale ? 'Функция' : 'Function');
	const signatureInfo = parseRoutineSignature(signature);

	if (normalizedName === '__construct' || normalizedName === 'constructor') {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} инициализирует объект, зависимости или исходную конфигурацию.`
			: `${subject} ${name} initializes the object, its dependencies, or starting configuration.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (normalizedName === 'setup') {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} подготавливает тестовое окружение перед выполнением сценариев.`
			: `${subject} ${name} prepares the test environment before scenarios run.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (normalizedName === 'teardown') {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} очищает временное состояние после завершения тестов.`
			: `${subject} ${name} cleans temporary state after the tests finish.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (normalizedName === 'up' && /^database\/migrations\//.test(lower)) {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} применяет изменения схемы базы данных для этой миграции.`
			: `${subject} ${name} applies the database schema changes for this migration.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (normalizedName === 'down' && /^database\/migrations\//.test(lower)) {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} откатывает изменения схемы базы данных, сделанные миграцией.`
			: `${subject} ${name} rolls back the schema changes made by this migration.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (normalizedName === 'register' && /provider/.test(lower)) {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} регистрирует сервисы и зависимости в контейнере приложения.`
			: `${subject} ${name} registers services and dependencies in the application container.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (normalizedName === 'boot' && /provider/.test(lower)) {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} завершает bootstrap области и подключает runtime-поведение.`
			: `${subject} ${name} finalizes bootstrap for the area and attaches runtime behavior.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (normalizedName === 'handle') {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} служит основной точкой выполнения для команды, middleware или фоновой задачи.`
			: `${subject} ${name} acts as the main execution entry for a command, middleware, or background job.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (normalizedName === 'render') {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} преобразует внутреннее состояние в HTTP- или UI-представление.`
			: `${subject} ${name} transforms internal state into an HTTP or UI representation.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (normalizedName === 'toarray') {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} сериализует объект в структуру данных для ответа или хранения.`
			: `${subject} ${name} serializes the object into a data structure for responses or storage.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (normalizedName === 'definition') {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} задаёт шаблон данных для фабрики и генерации тестовых записей.`
			: `${subject} ${name} defines the data template for a factory and generated test records.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (normalizedName === 'rules') {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} возвращает правила валидации входных данных.`
			: `${subject} ${name} returns validation rules for incoming data.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (normalizedName === 'casts') {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} описывает преобразования типов для полей модели или DTO.`
			: `${subject} ${name} defines type casts for model or DTO fields.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (normalizedName === 'response') {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} формирует унифицированный ответ для вызывающего кода.`
			: `${subject} ${name} builds a normalized response for the caller.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (isTestLikeName(name) || /^tests\//.test(lower)) {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} проверяет сценарий «${humanizeSymbolName(name, true)}», воспроизводит ожидаемый рабочий путь и фиксирует корректность поведения области.`
			: `${subject} ${name} verifies the scenario “${humanizeSymbolName(name, false)}”, exercises the expected execution path, and checks the area behavior.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (/^app\/http\/controllers\//.test(lower)) {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} обслуживает HTTP-сценарий этой области и управляет ответом клиенту.`
			: `${subject} ${name} serves an HTTP scenario in this area and manages the response to the client.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}
	if (/^app\/services\//.test(lower) || /\/services\//.test(lower)) {
		return withRoutineBodyDetail(isRussianLocale
			? `${subject} ${name} реализует часть сервисной логики области «${role || 'сервисы'}».`
			: `${subject} ${name} implements part of the service logic in the “${role || 'services'}” area.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
	}

	return withRoutineBodyDetail(isRussianLocale
		? `${subject} ${name} выполняет действие «${humanizeSymbolName(name, true)}» в контексте своей области.`
		: `${subject} ${name} performs the action expressed by its name: ${humanizeSymbolName(name, false)}.`, buildRoutineBodyDetail(body, signatureInfo, isRussianLocale));
}

function describeConstantSymbol(name: string, signature: string, isRussianLocale: boolean): string {
	return isRussianLocale
		? `Константа ${name} фиксирует переиспользуемое значение или настройку. Сигнатура: ${signature}.`
		: `Constant ${name} defines a reusable value or setting. Signature: ${signature}.`;
}

function describeInterfaceSymbol(name: string, isRussianLocale: boolean): string {
	return isRussianLocale
		? `Интерфейс ${name} описывает контракт взаимодействия между компонентами.`
		: `Interface ${name} describes a contract between components.`;
}

function describeTypeSymbol(name: string, isRussianLocale: boolean): string {
	return isRussianLocale
		? `Тип ${name} задаёт форму данных и ожидаемые ограничения.`
		: `Type ${name} defines the expected data shape and constraints.`;
}

function describeEnumSymbol(name: string, isRussianLocale: boolean): string {
	return isRussianLocale
		? `Перечисление ${name} ограничивает набор допустимых состояний или вариантов.`
		: `Enum ${name} constrains the allowed set of states or variants.`;
}

function formatAreaPreparationDetail(
	isRussianLocale: boolean,
	areaCount: number,
	analysisFileCount: number,
	batchCount: number,
	aiModel: string,
): string {
	return isRussianLocale
		? `Подготовлено ${areaCount} областей из ${analysisFileCount} файлов. AI-батчей: ${batchCount}. Модель: ${aiModel}`
		: `Prepared ${areaCount} areas from ${analysisFileCount} files. AI batches: ${batchCount}. Model: ${aiModel}`;
}

function formatAreaBatchStartDetail(
	isRussianLocale: boolean,
	batchIndex: number,
	batchCount: number,
	batch: PreparedCodeMapAreaDescription[],
): string {
	const areaPreview = batch.map(item => item.area).slice(0, 3).join(', ');
	return isRussianLocale
		? `AI-батч ${batchIndex + 1}/${batchCount}: ${batch.length} областей${areaPreview ? ` (${areaPreview})` : ''}`
		: `AI batch ${batchIndex + 1}/${batchCount}: ${batch.length} areas${areaPreview ? ` (${areaPreview})` : ''}`;
}

function formatAreaCompletionDetail(
	isRussianLocale: boolean,
	completed: number,
	total: number,
	areaName: string,
	usedFallback: boolean,
): string {
	return isRussianLocale
		? `Готово ${completed}/${total}: ${areaName}${usedFallback ? ' (локальное описание)' : ''}`
		: `Completed ${completed}/${total}: ${areaName}${usedFallback ? ' (local fallback)' : ''}`;
}

function formatSymbolBatchStartDetail(
	isRussianLocale: boolean,
	batchIndex: number,
	batchCount: number,
	batch: CodeMapFileBatchItem[],
): string {
	const filePreview = batch.map(item => item.filePath).slice(0, 3).join(', ');
	const symbolCount = batch.reduce((sum, item) => sum + item.symbols.length, 0);
	return isRussianLocale
		? `AI-батч ${batchIndex + 1}/${batchCount}: ${batch.length} файлов, ${symbolCount} символов${filePreview ? ` (${filePreview})` : ''}`
		: `AI batch ${batchIndex + 1}/${batchCount}: ${batch.length} files, ${symbolCount} symbols${filePreview ? ` (${filePreview})` : ''}`;
}

function formatSymbolBatchCompletionDetail(
	isRussianLocale: boolean,
	completed: number,
	total: number,
	filePath: string,
	symbolCount: number,
	usedFallback: boolean,
): string {
	return isRussianLocale
		? `Готово ${completed}/${total}: ${filePath} (${symbolCount} символов)${usedFallback ? ' (локальное описание)' : ''}`
		: `Completed ${completed}/${total}: ${filePath} (${symbolCount} symbols)${usedFallback ? ' (local fallback)' : ''}`;
}

function formatFrontendBatchStartDetail(
	isRussianLocale: boolean,
	batchIndex: number,
	batchCount: number,
	batch: CodeMapFrontendBlockBatchItem[],
): string {
	const filePreview = Array.from(new Set(batch.map(item => item.filePath))).slice(0, 3).join(', ');
	return isRussianLocale
		? `AI-батч UI ${batchIndex + 1}/${batchCount}: ${batch.length} блоков${filePreview ? ` (${filePreview})` : ''}`
		: `AI UI batch ${batchIndex + 1}/${batchCount}: ${batch.length} blocks${filePreview ? ` (${filePreview})` : ''}`;
}

function formatFrontendBatchCompletionDetail(
	isRussianLocale: boolean,
	completed: number,
	total: number,
	filePath: string,
	blockName: string,
	usedFallback: boolean,
): string {
	return isRussianLocale
		? `Готово ${completed}/${total}: ${filePath} -> ${blockName}${usedFallback ? ' (локальное описание)' : ''}`
		: `Completed ${completed}/${total}: ${filePath} -> ${blockName}${usedFallback ? ' (local fallback)' : ''}`;
}

function formatFileElementHeading(symbol: FileSymbolSummary, filePath: string, isRussianLocale: boolean): string {
	const kind = localizeSymbolKind(symbol.kind, isRussianLocale);
	const location = `${filePath}:${symbol.line}:${symbol.column}`;
	if (symbol.kind === 'class' && symbol.name === ANONYMOUS_CLASS_SYMBOL_NAME) {
		return `${kind} (${location})`;
	}
	return `${kind} ${symbol.name} (${location})`;
}

function formatFrontendBlockHeading(block: FrontendBlockSummary, filePath: string, isRussianLocale: boolean): string {
	const kind = localizeFrontendBlockKind(block.kind, isRussianLocale);
	return `${kind} ${block.name} (${filePath}:${block.line}:${block.column})`;
}

function localizeSymbolKind(kind: string, isRussianLocale: boolean): string {
	if (!isRussianLocale) {
		return kind;
	}
	switch (kind) {
		case 'class':
			return 'Класс';
		case 'method':
			return 'Метод';
		case 'function':
			return 'Функция';
		case 'const':
			return 'Константа';
		case 'interface':
			return 'Интерфейс';
		case 'type':
			return 'Тип';
		case 'enum':
			return 'Перечисление';
		default:
			return kind;
	}
}

function localizeFrontendBlockKind(kind: string, isRussianLocale: boolean): string {
	if (!isRussianLocale) {
		return kind;
	}
	switch (kind) {
		case 'page':
			return 'Страница';
		case 'layout':
			return 'Лэйаут';
		case 'section':
			return 'Секция';
		case 'toolbar':
			return 'Панель действий';
		case 'form':
			return 'Форма';
		case 'filters':
			return 'Фильтры';
		case 'list':
			return 'Список';
		case 'table':
			return 'Таблица';
		case 'card':
			return 'Карточка';
		case 'dialog':
			return 'Диалог';
		case 'tabs':
			return 'Вкладки';
		case 'sidebar':
			return 'Боковая панель';
		case 'empty-state':
			return 'Пустое состояние';
		case 'feedback':
			return 'Сообщение интерфейса';
		case 'navigation':
			return 'Навигация';
		default:
			return 'UI-блок';
	}
}

function isTestLikeName(name: string): boolean {
	return /^(test|should|can|it_|it[A-Z])/.test(name);
}

function parseRoutineSignature(signature: string): RoutineSignatureInfo {
	const openIndex = signature.indexOf('(');
	const closeIndex = signature.lastIndexOf(')');
	const paramsBlock = openIndex >= 0 && closeIndex > openIndex
		? signature.slice(openIndex + 1, closeIndex)
		: '';
	const params = paramsBlock
		.split(',')
		.map(item => item.trim())
		.filter(Boolean)
		.map(item => {
			const phpMatch = item.match(/\$([A-Za-z_][A-Za-z0-9_]*)/);
			if (phpMatch?.[1]) {
				return phpMatch[1];
			}
			const jsMatch = item.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:[?:=]|$)/);
			return jsMatch?.[1] || '';
		})
		.filter(Boolean);
	const returnType = closeIndex >= 0
		? (signature.slice(closeIndex + 1).match(/:\s*([^={]+)/)?.[1] || '').trim()
		: '';

	return { params, returnType };
}

function withRoutineBodyDetail(baseDescription: string, detail: string): string {
	const normalizedBase = baseDescription.trim();
	const normalizedDetail = detail.trim();
	if (!normalizedDetail) {
		return normalizedBase;
	}
	return `${normalizedBase.endsWith('.') ? normalizedBase : `${normalizedBase}.`} ${normalizedDetail}`;
}

function buildRoutineBodyDetail(body: string, signature: RoutineSignatureInfo, isRussianLocale: boolean): string {
	const signals = analyzeRoutineBody(body, signature);
	const clauses: string[] = [];

	if (signals.validatesInput) {
		clauses.push(isRussianLocale ? 'валидирует входные данные' : 'validates incoming data');
	}
	if (signals.containerClasses.length > 0) {
		clauses.push(isRussianLocale
			? `разрешает через контейнер ${formatReadableList(signals.containerClasses, true)}`
			: `resolves ${formatReadableList(signals.containerClasses, false)} from the application container`);
	} else if (signals.instantiatedClasses.length > 0) {
		clauses.push(isRussianLocale
			? `создаёт ${formatReadableList(signals.instantiatedClasses, true)}`
			: `instantiates ${formatReadableList(signals.instantiatedClasses, false)}`);
	}
	if (signals.touchesPersistence) {
		clauses.push(isRussianLocale ? 'читает или изменяет данные в хранилище' : 'reads or writes persisted data');
	}
	if (signals.buildsResponse) {
		clauses.push(isRussianLocale ? 'формирует ответ для вызывающей стороны' : 'builds the response for the caller');
	}
	if (signals.dispatchesWork) {
		clauses.push(isRussianLocale ? 'запускает фоновую или отложенную работу' : 'dispatches background or deferred work');
	}
	if (signals.hasBranches) {
		clauses.push(isRussianLocale ? 'разветвляет выполнение по условиям' : 'branches the control flow on conditions');
	}
	if (signals.hasLoops) {
		clauses.push(isRussianLocale ? 'обходит набор данных' : 'iterates over a data set');
	}
	if (signals.hasAwait) {
		clauses.push(isRussianLocale ? 'дожидается асинхронных операций' : 'waits for async operations');
	}
	if (signals.hasAssertions) {
		clauses.push(isRussianLocale ? 'фиксирует ожидаемый результат проверками' : 'asserts the expected outcome');
	}
	if (signals.hasThrows) {
		clauses.push(isRussianLocale ? 'прерывает выполнение исключением при ошибочном состоянии' : 'aborts by throwing on invalid state');
	}
	if (signals.directReturnParam) {
		clauses.push(isRussianLocale
			? `напрямую возвращает параметр ${signals.directReturnParam}`
			: `returns the ${signals.directReturnParam} parameter directly`);
	} else if (signals.returnsValue && !signals.buildsResponse) {
		clauses.push(isRussianLocale
			? (signature.returnType ? `возвращает значение типа ${signature.returnType}` : 'возвращает итоговое значение')
			: (signature.returnType ? `returns a value of type ${signature.returnType}` : 'returns a resulting value'));
	}
	if (clauses.length === 0 && signals.callTargets.length > 0) {
		clauses.push(isRussianLocale
			? `вызывает ${formatReadableList(signals.callTargets, true)}`
			: `calls ${formatReadableList(signals.callTargets, false)}`);
	}
	if (clauses.length === 0 && signature.params.length > 0) {
		clauses.push(isRussianLocale
			? `работает с аргументами ${formatReadableList(signature.params, true)}`
			: `works with arguments ${formatReadableList(signature.params, false)}`);
	}
	if (clauses.length === 0) {
		return '';
	}

	return isRussianLocale
		? `Внутри ${formatReadableList(clauses.slice(0, 3), true)}.`
		: `Inside it ${formatReadableList(clauses.slice(0, 3), false)}.`;
}

function analyzeRoutineBody(body: string, signature: RoutineSignatureInfo): RoutineBodySignals {
	const normalized = body.replace(/\s+/g, ' ').trim();
	if (!normalized) {
		return {
			hasBranches: false,
			hasLoops: false,
			hasAssertions: false,
			hasAwait: false,
			hasThrows: false,
			returnsValue: false,
			directReturnParam: '',
			containerClasses: [],
			callTargets: [],
			instantiatedClasses: [],
			touchesPersistence: false,
			buildsResponse: false,
			validatesInput: false,
			dispatchesWork: false,
		};
	}

	const containerClasses = uniqueMatches(body, /(?:app|resolve|make)\s*\(\s*([A-Za-z_][A-Za-z0-9_\\]*)::class/g)
		.map(className => className.split('\\').pop() || className)
		.slice(0, 3);
	const callTargets = [
		...uniqueMatches(body, /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g),
		...uniqueMatches(body, /(?:->|\.)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g),
		...uniqueMatches(body, /\b([A-Za-z_][A-Za-z0-9_\\]*)::([A-Za-z_][A-Za-z0-9_]*)\s*\(/g, 2).map(item => item.split('\\').pop() || item),
	]
		.filter(item => !ROUTINE_CALL_NAME_STOPLIST.has(item.toLowerCase()))
		.filter(item => !containerClasses.includes(item))
		.filter(item => !signature.params.includes(item))
		.filter((item, index, array) => array.indexOf(item) === index)
		.slice(0, 4);
	const instantiatedClasses = uniqueMatches(body, /\bnew\s+([A-Za-z_][A-Za-z0-9_\\]*)/g)
		.map(className => className.split('\\').pop() || className)
		.slice(0, 3);
	const directReturnMatch = body.match(/\breturn\s+\$?([A-Za-z_][A-Za-z0-9_]*)\s*;/);
	const directReturnParam = signature.params.includes(directReturnMatch?.[1] || '') ? (directReturnMatch?.[1] || '') : '';

	return {
		hasBranches: /\b(if|elseif|else\s+if|switch|case|match)\b/.test(body),
		hasLoops: /\b(foreach|for|while|map|filter|reduce|forEach)\b/.test(body),
		hasAssertions: /\b(assert[A-Za-z0-9_]*|expect)\s*\(|->assert[A-Za-z0-9_]*\s*\(/.test(body),
		hasAwait: /\bawait\b|Promise\.(all|race|allSettled)\b/.test(body),
		hasThrows: /\bthrow\b/.test(body),
		returnsValue: /\breturn\b/.test(body),
		directReturnParam,
		containerClasses,
		callTargets,
		instantiatedClasses,
		touchesPersistence: /\b(DB|Schema)\s*::|::(create|update|delete|insert|find|first|get|query)\s*\(|->(save|create|update|delete|insert|get|first|find|pluck|sync|attach|detach)\s*\(/.test(body),
		buildsResponse: /\b(response|json|view|redirect|abort)\s*\(|->(json|view|redirect|download|stream)\s*\(/.test(body),
		validatesInput: /\bvalidate[A-Za-z0-9_]*\s*\(|->validate[A-Za-z0-9_]*\s*\(/.test(body),
		dispatchesWork: /\bdispatch(?:Sync|Now)?\s*\(|::dispatch(?:Sync|Now)?\s*\(|->dispatch\s*\(/.test(body),
	};
}

const ROUTINE_CALL_NAME_STOPLIST = new Set([
	'if',
	'for',
	'foreach',
	'while',
	'switch',
	'catch',
	'return',
	'function',
	'new',
	'class',
	'isset',
	'empty',
	'array',
	'eval',
]);

function uniqueMatches(input: string, regex: RegExp, groupIndex = 1): string[] {
	const values = new Set<string>();
	for (const match of input.matchAll(regex)) {
		const value = match[groupIndex]?.trim();
		if (value) {
			values.add(value);
		}
	}
	return Array.from(values);
}

function formatReadableList(items: string[], isRussianLocale: boolean): string {
	const normalized = Array.from(new Set(items.map(item => item.trim()).filter(Boolean)));
	if (normalized.length === 0) {
		return '';
	}
	if (normalized.length === 1) {
		return normalized[0] || '';
	}
	if (normalized.length === 2) {
		return `${normalized[0]} ${isRussianLocale ? 'и' : 'and'} ${normalized[1]}`;
	}
	return `${normalized.slice(0, -1).join(', ')} ${isRussianLocale ? 'и' : 'and'} ${normalized[normalized.length - 1]}`;
}

function humanizeSymbolName(name: string, isRussianLocale: boolean): string {
	const withoutPrefix = name
		.replace(/^(test|should|can|it|when|then)/i, '')
		.replace(/^_+/, '');
	const words = withoutPrefix
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_-]+/g, ' ')
		.trim()
		.toLowerCase();
	if (!words) {
		return isRussianLocale ? 'внутренняя операция области' : 'an internal area operation';
	}
	return words;
}
