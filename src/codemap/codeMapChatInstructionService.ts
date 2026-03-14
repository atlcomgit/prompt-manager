import * as path from 'path';
import * as vscode from 'vscode';
import type { Prompt } from '../types/prompt.js';
import { summarizeUncommittedProjects } from '../utils/uncommittedChangesSummary.js';
import type { StorageService } from '../services/storageService.js';
import type { WorkspaceService } from '../services/workspaceService.js';
import type { GitService } from '../services/gitService.js';
import type { CodeMapMaterializationTarget } from '../types/codemap.js';
import { CodeMapDatabaseService } from './codeMapDatabaseService.js';
import { CodeMapBranchResolverService } from './codeMapBranchResolverService.js';
import { CodeMapMaterializerService } from './codeMapMaterializerService.js';
import { CodeMapOrchestratorService } from './codeMapOrchestratorService.js';
import { CODEMAP_CHAT_INSTRUCTION_FILE_NAME, getCodeMapSettings } from './codeMapConfig.js';

export class CodeMapChatInstructionService {
	constructor(
		private readonly storageService: StorageService,
		private readonly workspaceService: WorkspaceService,
		private readonly gitService: GitService,
		private readonly db: CodeMapDatabaseService,
		private readonly branchResolver: CodeMapBranchResolverService,
		private readonly materializer: CodeMapMaterializerService,
		private readonly orchestrator: CodeMapOrchestratorService,
	) { }

	async prepareInstruction(prompt: Pick<Prompt, 'projects'>): Promise<void> {
		const settings = getCodeMapSettings();
		const filePath = this.getInstructionFilePath();
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(filePath)));

		if (!settings.enabled) {
			await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from('', 'utf-8'));
			return;
		}

		const projectPaths = this.workspaceService.getWorkspaceFolderPaths();
		const resolutions = await this.branchResolver.resolveProjects(projectPaths, prompt.projects, settings.trackedBranches);
		const uncommittedSnapshots = await this.gitService.getUncommittedProjectData(projectPaths, resolutions.map(item => item.repository));
		const materializationTargets: CodeMapMaterializationTarget[] = [];

		for (const resolution of resolutions) {
			const baseInstruction = this.db.getLatestInstruction(resolution.repository, resolution.resolvedBranchName, 'base');
			const currentInstruction = resolution.currentBranch !== resolution.resolvedBranchName
				? this.db.getLatestInstruction(resolution.repository, resolution.currentBranch, 'delta')
				: null;

			const queuedBaseRefresh = this.shouldQueueBaseRefresh(resolution, baseInstruction)
				? this.orchestrator.queueInstruction(resolution, 'base', 'start-chat', settings.updatePriority)
				: false;
			const queuedCurrentRefresh = resolution.currentBranch !== resolution.resolvedBranchName && this.shouldQueueCurrentRefresh(resolution, currentInstruction)
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

		const content = this.materializer.compose(materializationTargets, new Date().toISOString(), vscode.env.language);
		await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(content, 'utf-8'));
	}

	queueWorkspaceRefresh(): void {
		const settings = getCodeMapSettings();
		if (!settings.enabled || !settings.autoUpdate) {
			return;
		}

		const projectPaths = this.workspaceService.getWorkspaceFolderPaths();
		void this.orchestrator.queueTrackedBranchSnapshots(projectPaths, settings.trackedBranches);
	}

	private shouldQueueBaseRefresh(resolution: CodeMapMaterializationTarget['resolution'], baseInstruction: CodeMapMaterializationTarget['baseInstruction']): boolean {
		if (!baseInstruction) {
			return true;
		}

		return baseInstruction.sourceCommitSha !== resolution.resolvedHeadSha;
	}

	private shouldQueueCurrentRefresh(resolution: CodeMapMaterializationTarget['resolution'], currentInstruction: CodeMapMaterializationTarget['currentInstruction']): boolean {
		if (!currentInstruction) {
			return true;
		}

		return currentInstruction.sourceCommitSha !== resolution.currentHeadSha;
	}

	private getInstructionFilePath(): string {
		return path.join(this.storageService.getStorageDirectoryPath(), 'chat-memory', CODEMAP_CHAT_INSTRUCTION_FILE_NAME);
	}
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