import type { PromptDashboardBranchAction, PromptDashboardCacheState, PromptDashboardProjectSummary, PromptDashboardPromptActivityItem, PromptDashboardScope, PromptDashboardWidgetKind, PromptDashboardWidgetSnapshot } from '../types/promptDashboard.js';
import type { GitOverlayBranchInfo, GitOverlayChangeFile } from '../types/git.js';
import type { PromptStatus } from '../types/prompt.js';

export const PROMPT_DASHBOARD_WARM_INTERVAL_MS = 5 * 60 * 1000;
export const PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS = 5 * 60 * 1000;
export const PROMPT_DASHBOARD_MIN_RIGHT_SPACE_PX = 280;

export function resolvePromptDashboardMode(pageWidth: number, formShellWidth: number): 'full' | 'compact' {
	return pageWidth - formShellWidth >= PROMPT_DASHBOARD_MIN_RIGHT_SPACE_PX ? 'full' : 'compact';
}

export function buildPromptDashboardScopeKey(scope: PromptDashboardScope): string {
	const projects = [...scope.projectNames].map(item => item.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru')).join('|');
	const trackedByProject = Object.entries(scope.trackedBranchesByProject || {})
		.map(([project, branch]) => `${project.trim()}:${String(branch || '').trim()}`)
		.filter(item => item !== ':')
		.sort((a, b) => a.localeCompare(b, 'ru'))
		.join('|');
	return [
		scope.promptUuid || scope.promptId || '__new__',
		projects,
		scope.promptBranch.trim(),
		scope.trackedBranch.trim(),
		trackedByProject,
		scope.model.trim(),
	].join('::');
}

export function buildPromptDashboardWidgetCacheKey(scope: PromptDashboardScope, widget: PromptDashboardWidgetKind): string {
	return `${buildPromptDashboardScopeKey(scope)}::${widget}`;
}

export function createPromptDashboardCacheState(input?: Partial<PromptDashboardCacheState>): PromptDashboardCacheState {
	return {
		status: input?.status || 'idle',
		source: input?.source || 'placeholder',
		updatedAt: input?.updatedAt,
		expiresAt: input?.expiresAt,
		error: input?.error,
	};
}

export function resolvePromptDashboardCacheState(updatedAtMs: number, ttlMs: number, nowMs = Date.now()): PromptDashboardCacheState {
	const updatedAt = new Date(updatedAtMs).toISOString();
	const expiresAtMs = updatedAtMs + Math.max(0, ttlMs);
	return {
		status: nowMs <= expiresAtMs ? 'fresh' : 'stale',
		source: 'cache',
		updatedAt,
		expiresAt: new Date(expiresAtMs).toISOString(),
	};
}

export function createPromptDashboardWidgetSnapshot<TData>(
	kind: PromptDashboardWidgetKind,
	data: TData,
	cache?: Partial<PromptDashboardCacheState>,
): PromptDashboardWidgetSnapshot<TData> {
	return {
		kind,
		data,
		cache: createPromptDashboardCacheState(cache),
	};
}

export function getPromptDashboardStatusProgress(status: PromptStatus, progress?: number): number {
	if (status === 'in-progress' && typeof progress === 'number' && Number.isFinite(progress)) {
		return Math.max(0, Math.min(100, Math.round(progress)));
	}

	switch (status) {
		case 'draft': return 10;
		case 'in-progress': return 50;
		case 'stopped': return 60;
		case 'cancelled': return 0;
		case 'completed': return 70;
		case 'report': return 80;
		case 'review': return 90;
		case 'closed': return 100;
		default: return 0;
	}
}

export function formatPromptDashboardDuration(valueMs: number): string {
	const totalSeconds = Math.floor(Math.max(0, valueMs) / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}

export function splitPromptDashboardActivityByDay(items: PromptDashboardPromptActivityItem[]): {
	today: PromptDashboardPromptActivityItem[];
	yesterday: PromptDashboardPromptActivityItem[];
} {
	return {
		today: items.filter(item => item.day === 'today').sort((left, right) => right.totalMs - left.totalMs),
		yesterday: items.filter(item => item.day === 'yesterday').sort((left, right) => right.totalMs - left.totalMs),
	};
}

export function buildPromptDashboardBranchActions(input: {
	promptBranch: string;
	trackedBranch: string;
	branches: GitOverlayBranchInfo[];
}): PromptDashboardBranchAction[] {
	const branchNames = new Set(input.branches.map(branch => branch.name));
	return [
		{ kind: 'tracked' as const, branch: input.trackedBranch.trim(), available: branchNames.has(input.trackedBranch.trim()) },
		{ kind: 'prompt' as const, branch: input.promptBranch.trim(), available: branchNames.has(input.promptBranch.trim()) },
	].filter(action => Boolean(action.branch));
}

export function detectPromptDashboardFileConflicts(baseFiles: string[], changedFiles: string[]): string[] {
	const baseSet = new Set(baseFiles.map(file => file.trim()).filter(Boolean));
	return changedFiles.map(file => file.trim()).filter(file => baseSet.has(file));
}

export function flattenPromptDashboardChangeFiles(groups: Array<GitOverlayChangeFile[]>): string[] {
	return Array.from(new Set(groups.flat().map(file => file.path).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru'));
}

export function buildPromptDashboardAnalysisFingerprint(input: {
	promptTitle: string;
	promptContent: string;
	promptBranch: string;
	projects: PromptDashboardProjectSummary[];
}): string {
	const payload = JSON.stringify({
		promptTitle: input.promptTitle.trim(),
		promptContent: input.promptContent.trim(),
		promptBranch: input.promptBranch.trim(),
		projects: input.projects.map(project => ({
			project: project.project,
			currentBranch: project.currentBranch,
			promptBranch: project.promptBranch,
			trackedBranch: project.trackedBranch,
			dirty: project.dirty,
			hasConflicts: project.hasConflicts,
			ahead: project.ahead,
			behind: project.behind,
			pipeline: project.pipeline?.state || 'unknown',
			review: project.review.request
				? `${project.review.request.state}:${project.review.request.number}:${project.review.request.sourceBranch}:${project.review.request.targetBranch}`
				: project.review.unsupportedReason || project.review.error || '',
			recentCommits: project.recentCommits.map(commit => ({
				sha: commit.sha,
				subject: commit.subject,
				changedFiles: commit.changedFiles.map(file => `${file.status}:${file.previousPath || ''}:${file.path}`),
			})),
			parallelBranches: project.parallelBranches.map(branch => ({
				name: branch.name,
				baseBranch: branch.baseBranch,
				ahead: branch.ahead,
				behind: branch.behind,
				lastCommit: branch.lastCommit?.sha || '',
				affectedFiles: branch.affectedFiles.map(file => `${file.status}:${file.previousPath || ''}:${file.path}`),
				potentialConflicts: branch.potentialConflicts.map(file => `${file.path}:${file.reason}`),
			})),
			conflictFiles: project.conflictFiles,
		})),
	});
	let hash = 2166136261;
	for (let index = 0; index < payload.length; index++) {
		hash ^= payload.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return `${payload.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}