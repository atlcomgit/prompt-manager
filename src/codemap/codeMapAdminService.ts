import * as vscode from 'vscode';
import type {
	CodeMapActivity,
	CodeMapBranchResolution,
	CodeMapInstructionDetail,
	CodeMapInstructionKind,
	CodeMapInstructionListItem,
	CodeMapSettings,
	CodeMapStatistics,
} from '../types/codemap.js';
import type { WorkspaceService } from '../services/workspaceService.js';
import type { GitService } from '../services/gitService.js';
import { getCodeMapSettings } from './codeMapConfig.js';
import { CodeMapDatabaseService } from './codeMapDatabaseService.js';
import { CodeMapBranchResolverService } from './codeMapBranchResolverService.js';
import { CodeMapOrchestratorService } from './codeMapOrchestratorService.js';
import { normalizeCopilotModelFamily } from '../constants/ai.js';

export class CodeMapAdminService {
	constructor(
		private readonly workspaceService: WorkspaceService,
		private readonly gitService: GitService,
		private readonly db: CodeMapDatabaseService,
		private readonly branchResolver: CodeMapBranchResolverService,
		private readonly orchestrator: CodeMapOrchestratorService,
	) { }

	async getInstructions(): Promise<CodeMapInstructionListItem[]> {
		try {
			const instructions = this.db.listLatestInstructions();
			const obsoleteIds = await this.getObsoleteInstructionIds(instructions);
			return instructions.map(item => ({
				...item,
				isObsolete: obsoleteIds.has(item.id),
			}));
		} catch {
			return [];
		}
	}

	getInstructionDetail(id: number): CodeMapInstructionDetail | null {
		try {
			return this.db.getInstructionDetail(id);
		} catch {
			return null;
		}
	}

	getStatistics(): CodeMapStatistics {
		try {
			return this.db.getStatistics();
		} catch {
			return {
				totalInstructions: 0,
				totalVersions: 0,
				totalJobs: 0,
				queuedJobs: 0,
				runningJobs: 0,
				completedJobs: 0,
				failedJobs: 0,
				dbSizeBytes: 0,
				repositories: [],
				branches: [],
				avgDurationMs: 0,
				avgGenerationDurationMs: 0,
				maxDurationMs: 0,
				peakHeapUsedBytes: 0,
				aiModels: [],
				triggerStats: [],
				repositoryStats: [],
			};
		}
	}

	getActivity(): CodeMapActivity {
		return {
			statistics: this.getStatistics(),
			runtime: this.orchestrator.getRuntimeState(),
			recentJobs: this.getRecentJobs(),
		};
	}

	getSettings(): CodeMapSettings {
		return getCodeMapSettings();
	}

	deleteInstruction(id: number): boolean {
		try {
			return this.db.deleteInstruction(id);
		} catch {
			return false;
		}
	}

	async deleteObsoleteInstructions(): Promise<number> {
		const instructions = await this.getInstructions();
		const obsoleteIds = instructions.filter(item => item.isObsolete).map(item => item.id);
		if (obsoleteIds.length === 0) {
			return 0;
		}

		try {
			return this.db.deleteInstructionsByIds(obsoleteIds);
		} catch {
			return 0;
		}
	}

	async saveSettings(settings: Partial<CodeMapSettings>): Promise<CodeMapSettings> {
		const config = vscode.workspace.getConfiguration('promptManager.codemap');
		if (settings.enabled !== undefined) { await config.update('enabled', settings.enabled, true); }
		if (settings.trackedBranches !== undefined) { await config.update('trackedBranches', settings.trackedBranches, true); }
		if (settings.autoUpdate !== undefined) { await config.update('autoUpdate', settings.autoUpdate, true); }
		if (settings.notificationsEnabled !== undefined) { await config.update('notifications.enabled', settings.notificationsEnabled, true); }
		if (settings.aiModel !== undefined) { await config.update('aiModel', normalizeCopilotModelFamily(settings.aiModel), true); }
		if (settings.instructionMaxChars !== undefined) { await config.update('instructionMaxChars', settings.instructionMaxChars, true); }
		if (settings.blockDescriptionMode !== undefined) { await config.update('blockDescriptionMode', settings.blockDescriptionMode, true); }
		if (settings.blockMaxChars !== undefined) { await config.update('blockMaxChars', settings.blockMaxChars, true); }
		if (settings.batchContextMaxChars !== undefined) { await config.update('batchContextMaxChars', settings.batchContextMaxChars, true); }
		if (settings.updatePriority !== undefined) {
			const value = settings.updatePriority === 'low' ? 'lower' : settings.updatePriority === 'high' ? 'higher' : 'normal';
			await config.update('updatePriority', value, true);
		}
		if (settings.aiDelayMs !== undefined) { await config.update('aiDelayMs', settings.aiDelayMs, true); }
		if (settings.startupDelayMs !== undefined) { await config.update('startupDelayMs', settings.startupDelayMs, true); }
		if (settings.maxVersionsPerInstruction !== undefined) { await config.update('maxVersionsPerInstruction', settings.maxVersionsPerInstruction, true); }

		return getCodeMapSettings();
	}

	async queueRefreshWorkspace(): Promise<number> {
		const settings = getCodeMapSettings();
		const projectPaths = this.workspaceService.getWorkspaceFolderPaths();
		const resolutions = await this.branchResolver.resolveProjects(projectPaths, [], settings.trackedBranches);
		let queued = 0;

		for (const resolution of resolutions) {
			if (this.orchestrator.queueInstruction(resolution, 'base', 'manual', settings.updatePriority)) {
				queued += 1;
			}

			if (resolution.currentBranch !== resolution.resolvedBranchName) {
				if (this.orchestrator.queueInstruction(resolution, 'delta', 'manual', settings.updatePriority)) {
					queued += 1;
				}
			}
		}

		return queued;
	}

	async queueRefreshInstruction(id: number): Promise<boolean> {
		let detail: CodeMapInstructionDetail | null = null;
		try {
			detail = this.db.getInstructionDetail(id);
		} catch {
			return false;
		}

		if (!detail) {
			return false;
		}

		const resolution = await this.buildResolutionFromInstruction(detail.instruction);
		if (!resolution) {
			return false;
		}

		return this.orchestrator.queueInstruction(
			resolution,
			detail.instruction.instructionKind,
			'manual',
			getCodeMapSettings().updatePriority,
		);
	}

	private getRecentJobs() {
		try {
			return this.db.getRecentJobs(20);
		} catch {
			return [];
		}
	}

	private async getObsoleteInstructionIds(instructions: CodeMapInstructionListItem[]): Promise<Set<number>> {
		const projectPaths = this.workspaceService.getWorkspaceFolderPaths();
		const trackedBranches = getCodeMapSettings().trackedBranches;
		const keepKeys = new Set<string>();

		for (const [repository, projectPath] of projectPaths.entries()) {
			for (const trackedBranch of trackedBranches) {
				const trackedHeadSha = await this.branchResolver.getHeadSha(projectPath, trackedBranch);
				if (trackedHeadSha) {
					keepKeys.add(`${repository}::${trackedBranch}::base`);
				}
			}
		}

		const resolutions = await this.branchResolver.resolveProjects(projectPaths, [], trackedBranches);
		for (const resolution of resolutions) {
			keepKeys.add(`${resolution.repository}::${resolution.resolvedBranchName}::base`);
			if (resolution.currentBranch !== resolution.resolvedBranchName) {
				keepKeys.add(`${resolution.repository}::${resolution.currentBranch}::delta`);
			}
		}

		const obsoleteIds = new Set<number>();
		for (const instruction of instructions) {
			const key = `${instruction.repository}::${instruction.branchName}::${instruction.instructionKind}`;
			if (!projectPaths.has(instruction.repository) || !keepKeys.has(key)) {
				obsoleteIds.add(instruction.id);
			}
		}

		return obsoleteIds;
	}

	private async buildResolutionFromInstruction(instruction: CodeMapInstructionDetail['instruction']): Promise<CodeMapBranchResolution | null> {
		const projectPath = this.workspaceService.getWorkspaceFolderPaths().get(instruction.repository);
		if (!projectPath) {
			return null;
		}

		const currentBranch = await this.gitService.getCurrentBranch(projectPath) || instruction.branchName;
		const currentHeadSha = await this.branchResolver.getHeadSha(projectPath, currentBranch);
		const resolvedBranchName = instruction.instructionKind === 'base'
			? instruction.branchName
			: instruction.resolvedBranchName;
		const resolvedHeadSha = await this.branchResolver.getHeadSha(projectPath, resolvedBranchName);

		return {
			repository: instruction.repository,
			projectPath,
			currentBranch: instruction.instructionKind === 'delta' ? instruction.branchName : currentBranch,
			resolvedBranchName,
			baseBranchName: instruction.baseBranchName,
			branchRole: instruction.instructionKind === 'delta' ? 'current' : instruction.branchRole,
			isTrackedBranch: instruction.branchRole === 'tracked',
			hasUncommittedChanges: (await this.gitService.hasUncommittedChanges(projectPath)).hasChanges,
			resolvedHeadSha,
			currentHeadSha,
		};
	}
}