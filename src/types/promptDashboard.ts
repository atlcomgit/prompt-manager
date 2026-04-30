import type { GitOverlayCommit, GitOverlayCommitChangedFile, GitOverlayPipelineStatus, GitOverlayProjectSnapshot, GitOverlayReviewState, GitOverlayParallelBranchSummary } from './git.js';
import type { PromptStatus } from './prompt.js';

export type PromptDashboardWidgetKind = 'activity' | 'status' | 'projects' | 'aiAnalysis';

export type PromptDashboardLoadStatus = 'idle' | 'loading' | 'fresh' | 'stale' | 'error';

export interface PromptDashboardCacheState {
	status: PromptDashboardLoadStatus;
	source: 'placeholder' | 'cache' | 'refresh';
	updatedAt?: string;
	expiresAt?: string;
	error?: string;
}

export interface PromptDashboardWidgetSnapshot<TData> {
	kind: PromptDashboardWidgetKind;
	cache: PromptDashboardCacheState;
	data: TData;
}

export interface PromptDashboardPromptActivityItem {
	id: string;
	promptUuid?: string;
	taskNumber: string;
	title: string;
	status: PromptStatus;
	day: 'today' | 'yesterday';
	totalMs: number;
	updatedAt: string;
	progress?: number;
}

export interface PromptDashboardPromptActivityData {
	thresholdMs: number;
	today: PromptDashboardPromptActivityItem[];
	yesterday: PromptDashboardPromptActivityItem[];
	yesterdayLabel?: string;
}

export interface PromptDashboardStatusData {
	status: PromptStatus;
	progress?: number;
	totalTimeMs: number;
	updatedAt: string;
}

export interface PromptDashboardBranchAction {
	kind: 'tracked' | 'prompt';
	branch: string;
	available: boolean;
}

export interface PromptDashboardRecentCommit extends GitOverlayCommit {
	changedFiles: GitOverlayCommitChangedFile[];
}

export interface PromptDashboardProjectSummary {
	project: string;
	repositoryPath: string;
	available: boolean;
	error: string;
	currentBranch: string;
	promptBranch: string;
	trackedBranch: string;
	dirty: boolean;
	hasConflicts: boolean;
	ahead: number;
	behind: number;
	branches: GitOverlayProjectSnapshot['branches'];
	branchActions: PromptDashboardBranchAction[];
	recentCommits: PromptDashboardRecentCommit[];
	review: GitOverlayReviewState;
	pipeline: GitOverlayPipelineStatus | null;
	parallelBranches: GitOverlayParallelBranchSummary[];
	conflictFiles: string[];
}

export interface PromptDashboardProjectsData {
	projects: PromptDashboardProjectSummary[];
}

export interface PromptDashboardAnalysisState {
	status: 'idle' | 'running' | 'completed' | 'error';
	model: string;
	updatedAt?: string;
	content: string;
	inputFingerprint?: string;
	error?: string;
}

export interface PromptDashboardScope {
	promptId: string;
	promptUuid: string;
	projectNames: string[];
	promptBranch: string;
	trackedBranch: string;
	trackedBranchesByProject: Record<string, string>;
	model: string;
}

export interface PromptDashboardSnapshot {
	promptId: string;
	promptUuid: string;
	generatedAt: string;
	scopeKey: string;
	activity: PromptDashboardWidgetSnapshot<PromptDashboardPromptActivityData>;
	status: PromptDashboardWidgetSnapshot<PromptDashboardStatusData>;
	projects: PromptDashboardWidgetSnapshot<PromptDashboardProjectsData>;
	aiAnalysis: PromptDashboardWidgetSnapshot<PromptDashboardAnalysisState | null>;
}