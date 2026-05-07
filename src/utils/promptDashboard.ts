import type { PromptDashboardAnalysisState, PromptDashboardBranchAction, PromptDashboardCacheState, PromptDashboardLoadStatus, PromptDashboardProjectsData, PromptDashboardProjectSummary, PromptDashboardPromptActivityItem, PromptDashboardScope, PromptDashboardSnapshot, PromptDashboardStatusData, PromptDashboardWidgetKind, PromptDashboardWidgetSnapshot } from '../types/promptDashboard.js';
import type { GitOverlayBranchInfo, GitOverlayChangeFile, GitOverlayCommitChangedFile } from '../types/git.js';
import type { Prompt, PromptStatus } from '../types/prompt.js';

export const PROMPT_DASHBOARD_WARM_INTERVAL_MS = 5 * 60 * 1000;
export const PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS = 5 * 60 * 1000;
export const PROMPT_DASHBOARD_MIN_RIGHT_SPACE_PX = 280;
const PROMPT_DASHBOARD_TEXT_ELLIPSIS = '...';
const PROMPT_DASHBOARD_PATH_SHORT_SEGMENT_PREFIX = 4;
const PROMPT_DASHBOARD_PATH_LONG_SEGMENT_PREFIX = 8;
const PROMPT_DASHBOARD_PATH_COMPACT_THRESHOLD = 24;

/** Stores compact path pieces for one dashboard file row. */
export interface PromptDashboardCompactPathParts {
	fileName: string;
	directoryPath: string;
	displayPath: string;
}

export function resolvePromptDashboardMode(pageWidth: number, formShellWidth: number): 'full' | 'compact' {
	return pageWidth - formShellWidth >= PROMPT_DASHBOARD_MIN_RIGHT_SPACE_PX ? 'full' : 'compact';
}

/** Keeps both the start and the ending of a long label visible inside narrow dashboard rows. */
export function compactPromptDashboardMiddleLabel(value: string, maxLength: number): string {
	const normalized = (value || '').trim();
	if (!normalized || normalized.length <= maxLength || maxLength <= PROMPT_DASHBOARD_TEXT_ELLIPSIS.length + 2) {
		return normalized;
	}

	const visibleChars = maxLength - PROMPT_DASHBOARD_TEXT_ELLIPSIS.length;
	const prefixLength = Math.ceil(visibleChars / 2);
	const suffixLength = Math.floor(visibleChars / 2);
	return `${normalized.slice(0, prefixLength)}${PROMPT_DASHBOARD_TEXT_ELLIPSIS}${normalized.slice(normalized.length - suffixLength)}`;
}

/** Shortens long intermediate path segments while keeping the file name intact. */
function compactPromptDashboardPathSegment(segment: string): string {
	if (segment.length > PROMPT_DASHBOARD_PATH_LONG_SEGMENT_PREFIX) {
		return `${segment.slice(0, PROMPT_DASHBOARD_PATH_LONG_SEGMENT_PREFIX)}${PROMPT_DASHBOARD_TEXT_ELLIPSIS}`;
	}
	if (segment.length > PROMPT_DASHBOARD_PATH_SHORT_SEGMENT_PREFIX) {
		return `${segment.slice(0, PROMPT_DASHBOARD_PATH_SHORT_SEGMENT_PREFIX)}..`;
	}
	return segment;
}

/** Builds compact directory and file-name parts for one branch-widget file row. */
export function formatPromptDashboardCompactPathParts(
	path: string,
	compactThreshold = PROMPT_DASHBOARD_PATH_COMPACT_THRESHOLD,
): PromptDashboardCompactPathParts {
	const normalized = (path || '')
		.split(/[\\/]+/)
		.map(segment => segment.trim())
		.filter(Boolean)
		.join('/');
	if (!normalized) {
		return { fileName: '', directoryPath: '', displayPath: '' };
	}

	const segments = normalized.split('/');
	const fileName = segments.pop() || normalized;
	const directorySegments = normalized.length > compactThreshold
		? segments.map(compactPromptDashboardPathSegment)
		: segments;
	const directoryPath = directorySegments.join('/');
	return {
		fileName,
		directoryPath,
		displayPath: directoryPath ? `${directoryPath}/${fileName}` : fileName,
	};
}

/** Reuses the current snapshot when visibility changed but prompt inputs stayed the same. */
export function shouldRequestPromptDashboardSnapshot(input: {
	mode: 'full' | 'compact';
	isLoaded: boolean;
	hasSnapshot: boolean;
	currentFingerprint: string;
	lastRequestedFingerprint: string;
}): boolean {
	if (input.mode !== 'full' || !input.isLoaded) {
		return false;
	}

	if (!input.hasSnapshot) {
		return true;
	}

	return input.currentFingerprint !== input.lastRequestedFingerprint;
}

/** Clears branch-apply loaders only after the projects widget finished its refresh. */
export function shouldClearPromptDashboardBusyActionFromWidget(input: {
	busyAction: string | null;
	widgetKind: PromptDashboardWidgetKind;
	cacheStatus: PromptDashboardLoadStatus;
}): boolean {
	if (!input.busyAction || input.widgetKind !== 'projects' || input.cacheStatus === 'loading') {
		return false;
	}

	return input.busyAction === 'switch-all'
		|| input.busyAction.startsWith('switch-project:')
		|| input.busyAction.startsWith('pull-project:')
		|| input.busyAction.startsWith('preset:');
}

/** Keeps the last project rows mounted while a refresh is still loading new Git data. */
export function preservePromptDashboardProjectsLoadingSnapshot(
	previousWidget: PromptDashboardWidgetSnapshot<PromptDashboardProjectsData>,
	nextWidget: PromptDashboardWidgetSnapshot<PromptDashboardProjectsData>,
): PromptDashboardWidgetSnapshot<PromptDashboardProjectsData> {
	if (nextWidget.cache.status !== 'loading' || nextWidget.data.projects.length > 0 || previousWidget.data.projects.length === 0) {
		return nextWidget;
	}

	return {
		...nextWidget,
		data: previousWidget.data,
	};
}

export function shouldAcceptPromptDashboardAnalysisMessage(input: {
	activeRequestId: string;
	messageRequestId?: string;
	currentPromptId?: string;
	currentPromptUuid?: string;
	messagePromptId?: string;
	messagePromptUuid?: string;
	currentAnalysisFingerprint?: string;
	messageAnalysisFingerprint?: string;
	currentAnalysisStatus?: PromptDashboardAnalysisState['status'];
	messageAnalysisStatus?: PromptDashboardAnalysisState['status'];
}): boolean {
	if (!input.messageRequestId || input.messageRequestId === input.activeRequestId) {
		return true;
	}

	const samePromptId = !input.currentPromptId || !input.messagePromptId || input.currentPromptId === input.messagePromptId;
	const samePromptUuid = !input.currentPromptUuid || !input.messagePromptUuid || input.currentPromptUuid === input.messagePromptUuid;
	if (!samePromptId || !samePromptUuid) {
		return false;
	}

	if (
		!input.currentAnalysisFingerprint
		|| !input.messageAnalysisFingerprint
		|| input.currentAnalysisFingerprint !== input.messageAnalysisFingerprint
	) {
		return false;
	}

	if (input.currentAnalysisStatus === 'completed' && input.messageAnalysisStatus === 'running') {
		return false;
	}

	return true;
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
		case 'in-progress': return 0;
		case 'stopped': return 60;
		case 'cancelled': return 0;
		case 'completed': return 70;
		case 'report': return 80;
		case 'review': return 90;
		case 'closed': return 100;
		default: return 0;
	}
}

export function getPromptDashboardTotalTimeMs(prompt: Pick<Prompt, 'timeSpentWriting' | 'timeSpentImplementing' | 'timeSpentOnTask' | 'timeSpentUntracked'>): number {
	return Math.max(0,
		(prompt.timeSpentWriting || 0)
		+ (prompt.timeSpentImplementing || 0)
		+ (prompt.timeSpentOnTask || 0)
		+ (prompt.timeSpentUntracked || 0),
	);
}

/** Detects prompt changes that must invalidate the global activity widget cache. */
export function buildPromptDashboardActivityFingerprint(
	prompt: Pick<Prompt, 'id' | 'promptUuid' | 'status' | 'progress' | 'updatedAt' | 'timeSpentWriting' | 'timeSpentImplementing' | 'timeSpentOnTask' | 'timeSpentUntracked'>,
): string {
	return [
		prompt.promptUuid || prompt.id || '__new__',
		prompt.status,
		typeof prompt.progress === 'number' ? String(prompt.progress) : '',
		prompt.updatedAt || '',
		String(prompt.timeSpentWriting || 0),
		String(prompt.timeSpentImplementing || 0),
		String(prompt.timeSpentOnTask || 0),
		String(prompt.timeSpentUntracked || 0),
	].join('::');
}

export function buildPromptDashboardStatusDataFromPrompt(
	prompt: Pick<Prompt, 'status' | 'progress' | 'updatedAt' | 'timeSpentWriting' | 'timeSpentImplementing' | 'timeSpentOnTask' | 'timeSpentUntracked'>,
): PromptDashboardStatusData {
	// Rebuild the widget payload from prompt fields when the dashboard scope itself stays unchanged.
	return {
		status: prompt.status,
		progress: getPromptDashboardStatusProgress(prompt.status, prompt.progress),
		totalTimeMs: getPromptDashboardTotalTimeMs(prompt),
		updatedAt: prompt.updatedAt || new Date().toISOString(),
	};
}

/** Control how prompt-side status sync should treat runtime progress from other dashboard sources. */
export interface PromptDashboardStatusSyncOptions {
	progressOverride?: number;
	preserveInProgressSnapshotProgress?: boolean;
}

/** Reuse the freshest known in-progress percent unless an explicit runtime override is available. */
function resolvePromptDashboardStatusSyncProgress(
	status: PromptStatus,
	promptProgress: number | undefined,
	snapshotStatus: PromptStatus,
	snapshotProgress: number | undefined,
	options?: PromptDashboardStatusSyncOptions,
): number {
	if (typeof options?.progressOverride === 'number' && Number.isFinite(options.progressOverride)) {
		return Math.max(0, Math.min(100, Math.round(options.progressOverride)));
	}

	const normalizedPromptProgress = typeof promptProgress === 'number' && Number.isFinite(promptProgress)
		? Math.max(0, Math.min(100, Math.round(promptProgress)))
		: undefined;
	const fallbackProgress = getPromptDashboardStatusProgress(status);

	if (
		options?.preserveInProgressSnapshotProgress
		&& status === 'in-progress'
		&& snapshotStatus === 'in-progress'
		&& typeof snapshotProgress === 'number'
		&& Number.isFinite(snapshotProgress)
		&& (normalizedPromptProgress === undefined || normalizedPromptProgress === fallbackProgress)
	) {
		return Math.max(0, Math.min(100, Math.round(snapshotProgress)));
	}

	return getPromptDashboardStatusProgress(status, normalizedPromptProgress);
}

export function syncPromptDashboardStatusFromPrompt(
	snapshot: PromptDashboardSnapshot | null,
	prompt: Pick<Prompt, 'id' | 'promptUuid' | 'status' | 'progress' | 'updatedAt' | 'timeSpentWriting' | 'timeSpentImplementing' | 'timeSpentOnTask' | 'timeSpentUntracked'>,
	options?: PromptDashboardStatusSyncOptions,
): PromptDashboardSnapshot | null {
	if (!snapshot) {
		return snapshot;
	}

	const promptId = String(prompt.id || '__new__').trim() || '__new__';
	const snapshotId = String(snapshot.promptId || '__new__').trim() || '__new__';
	if (promptId !== snapshotId) {
		return snapshot;
	}

	const promptUuid = String(prompt.promptUuid || '').trim();
	const snapshotUuid = String(snapshot.promptUuid || '').trim();
	if (promptUuid && snapshotUuid && promptUuid !== snapshotUuid) {
		return snapshot;
	}

	const nextData: PromptDashboardStatusData = {
		status: prompt.status,
		progress: resolvePromptDashboardStatusSyncProgress(
			prompt.status,
			prompt.progress,
			snapshot.status.data.status,
			snapshot.status.data.progress,
			options,
		),
		totalTimeMs: getPromptDashboardTotalTimeMs(prompt),
		updatedAt: prompt.updatedAt || new Date().toISOString(),
	};
	const currentData = snapshot.status.data;
	if (
		currentData.status === nextData.status
		&& currentData.progress === nextData.progress
		&& currentData.totalTimeMs === nextData.totalTimeMs
		&& currentData.updatedAt === nextData.updatedAt
	) {
		return snapshot;
	}

	return {
		...snapshot,
		status: {
			...snapshot.status,
			data: nextData,
		},
		generatedAt: new Date().toISOString(),
	};
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

function formatPromptDashboardChangedFileFingerprint(file: GitOverlayCommitChangedFile): string {
	return [
		file.status,
		file.previousPath || '',
		file.path,
		file.additions ?? '',
		file.deletions ?? '',
		file.isBinary === true ? 'binary' : '',
	].join(':');
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
				changedFiles: commit.changedFiles.map(formatPromptDashboardChangedFileFingerprint),
			})),
			parallelBranches: project.parallelBranches.map(branch => ({
				name: branch.name,
				baseBranch: branch.baseBranch,
				ahead: branch.ahead,
				behind: branch.behind,
				lastCommit: branch.lastCommit?.sha || '',
				affectedFiles: branch.affectedFiles.map(formatPromptDashboardChangedFileFingerprint),
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