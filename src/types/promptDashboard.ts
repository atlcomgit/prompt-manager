import type { GitOverlayChangeFile, GitOverlayCommit, GitOverlayCommitChangedFile, GitOverlayPipelineStatus, GitOverlayProjectSnapshot, GitOverlayReviewState, GitOverlayParallelBranchSummary } from './git.js';
import type { DockerContainersData } from './docker.js';
import type { PromptStatus } from './prompt.js';

export type PromptDashboardWidgetKind = 'activity' | 'status' | 'projects' | 'aiAnalysis' | 'docker';

/** Stores top-level prompt-page dashboard sections that users can collapse. */
export type PromptDashboardSectionKey =
	| 'status'
	| 'activity'
	| 'projectBranches'
	| 'reviewRequests'
	| 'parallelBranches'
	| 'projectCommits'
	| 'dockerContainers'
	| 'aiAnalysis';

/** Persists only sections explicitly collapsed by the user. */
export type PromptDashboardCollapsedSections = Partial<Record<PromptDashboardSectionKey, boolean>>;

/** Persists the shared visible two-column layout of prompt-dashboard cards. */
export type PromptDashboardSectionOrder = PromptDashboardSectionKey[][];

/** Prompt dashboard keeps two stable columns in full mode. */
export const PROMPT_DASHBOARD_SECTION_COLUMN_COUNT = 2;

/** Stable ordered list of all collapsible prompt-page dashboard sections. */
export const PROMPT_DASHBOARD_SECTION_KEYS: PromptDashboardSectionKey[] = [
	'status',
	'activity',
	'projectBranches',
	'reviewRequests',
	'parallelBranches',
	'projectCommits',
	'dockerContainers',
	'aiAnalysis',
];

/** Project-derived sections share one host payload and only collapse as a group for refresh gating. */
export const PROMPT_DASHBOARD_PROJECT_SECTION_KEYS: PromptDashboardSectionKey[] = [
	'projectBranches',
	'reviewRequests',
	'parallelBranches',
	'projectCommits',
];

/** Creates the default shared dashboard collapse state. */
export function createDefaultPromptDashboardCollapsedSections(): PromptDashboardCollapsedSections {
	return {};
}

/** Creates the default shared dashboard widget order. */
export function createDefaultPromptDashboardSectionOrder(): PromptDashboardSectionOrder {
	return buildPromptDashboardSectionOrderFromFlatList(PROMPT_DASHBOARD_SECTION_KEYS);
}

/** Normalizes persisted collapse flags and keeps only explicit collapsed=true values. */
export function normalizePromptDashboardCollapsedSections(
	state?: Partial<Record<PromptDashboardSectionKey, unknown>> | null,
): PromptDashboardCollapsedSections {
	const normalized: PromptDashboardCollapsedSections = {};
	if (!state || typeof state !== 'object') {
		return normalized;
	}

	for (const key of PROMPT_DASHBOARD_SECTION_KEYS) {
		if (state[key] === true) {
			normalized[key] = true;
		}
	}

	return normalized;
}

/** Normalizes a persisted widget order and appends any missing dashboard cards in their default order. */
export function normalizePromptDashboardSectionOrder(
	state?: unknown,
): PromptDashboardSectionOrder {
	if (!Array.isArray(state)) {
		return createDefaultPromptDashboardSectionOrder();
	}

	if (state.every(value => typeof value === 'string')) {
		return normalizePromptDashboardSectionOrder(
			buildPromptDashboardSectionOrderFromFlatList(state as readonly PromptDashboardSectionKey[]),
		);
	}

	const defaultLayout = createDefaultPromptDashboardSectionOrder();
	const seen = new Set<PromptDashboardSectionKey>();
	const normalized: PromptDashboardSectionOrder = Array.from(
		{ length: PROMPT_DASHBOARD_SECTION_COLUMN_COUNT },
		() => [],
	);
	for (let columnIndex = 0; columnIndex < PROMPT_DASHBOARD_SECTION_COLUMN_COUNT; columnIndex += 1) {
		const rawColumn = Array.isArray(state[columnIndex]) ? state[columnIndex] as readonly unknown[] : [];
		for (const value of rawColumn) {
			if (typeof value !== 'string') {
				continue;
			}
			const section = PROMPT_DASHBOARD_SECTION_KEYS.find(key => key === value);
			if (!section || seen.has(section)) {
				continue;
			}
			seen.add(section);
			normalized[columnIndex].push(section);
		}
	}

	for (let columnIndex = 0; columnIndex < defaultLayout.length; columnIndex += 1) {
		for (const section of defaultLayout[columnIndex]) {
			if (!seen.has(section)) {
				seen.add(section);
				normalized[columnIndex].push(section);
			}
		}
	}

	return normalized;
}

/** Flattens the persisted two-column layout into the visible row-first order. */
export function flattenPromptDashboardSectionOrder(
	order: PromptDashboardSectionOrder,
): PromptDashboardSectionKey[] {
	const normalizedOrder = normalizePromptDashboardSectionOrder(order);
	const flatOrder: PromptDashboardSectionKey[] = [];
	const rowCount = Math.max(0, ...normalizedOrder.map(column => column.length));
	for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
		for (let columnIndex = 0; columnIndex < normalizedOrder.length; columnIndex += 1) {
			const section = normalizedOrder[columnIndex][rowIndex];
			if (section) {
				flatOrder.push(section);
			}
		}
	}
	return flatOrder;
}

/** Rebuilds the persisted two-column layout from a legacy flat row-first order. */
export function buildPromptDashboardSectionOrderFromFlatList(
	state?: readonly unknown[] | null,
): PromptDashboardSectionOrder {
	const columns: PromptDashboardSectionOrder = Array.from(
		{ length: PROMPT_DASHBOARD_SECTION_COLUMN_COUNT },
		() => [],
	);
	if (!Array.isArray(state)) {
		return columns;
	}

	const seen = new Set<PromptDashboardSectionKey>();
	for (const value of state) {
		if (typeof value !== 'string') {
			continue;
		}
		const section = PROMPT_DASHBOARD_SECTION_KEYS.find(key => key === value);
		if (!section || seen.has(section)) {
			continue;
		}
		const targetColumn = columns.reduce<number>((bestIndex, column, columnIndex, allColumns) => {
			return column.length < allColumns[bestIndex].length ? columnIndex : bestIndex;
		}, 0);
		seen.add(section);
		columns[targetColumn].push(section);
	}

	return columns;
}

/** Toggles one top-level dashboard section in the shared collapse state. */
export function togglePromptDashboardSectionCollapsedState(
	state: PromptDashboardCollapsedSections,
	section: PromptDashboardSectionKey,
): PromptDashboardCollapsedSections {
	const normalized = normalizePromptDashboardCollapsedSections(state);
	if (normalized[section]) {
		const nextState = { ...normalized };
		delete nextState[section];
		return nextState;
	}

	return {
		...normalized,
		[section]: true,
	};
}

/** Checks whether one visible dashboard section is currently collapsed. */
export function isPromptDashboardSectionCollapsed(
	state: PromptDashboardCollapsedSections,
	section: PromptDashboardSectionKey,
): boolean {
	return normalizePromptDashboardCollapsedSections(state)[section] === true;
}

/** Checks whether all project-backed dashboard sections are collapsed together. */
export function areAllPromptDashboardProjectSectionsCollapsed(
	state: PromptDashboardCollapsedSections,
): boolean {
	const normalized = normalizePromptDashboardCollapsedSections(state);
	return PROMPT_DASHBOARD_PROJECT_SECTION_KEYS.every(section => normalized[section] === true);
}

/** Resolves whether host-side refresh work can be skipped for a widget payload. */
export function shouldSkipPromptDashboardWidgetRefresh(
	state: PromptDashboardCollapsedSections,
	widget: PromptDashboardWidgetKind,
): boolean {
	if (widget === 'projects') {
		return areAllPromptDashboardProjectSectionsCollapsed(state);
	}

	if (widget === 'activity' || widget === 'status' || widget === 'aiAnalysis') {
		return isPromptDashboardSectionCollapsed(state, widget);
	}

	if (widget === 'docker') {
		return isPromptDashboardSectionCollapsed(state, 'dockerContainers');
	}

	return false;
}

/** Resolves collapsed host widget payloads from the richer UI section state. */
export function resolveCollapsedPromptDashboardWidgets(
	state: PromptDashboardCollapsedSections,
): PromptDashboardWidgetKind[] {
	const widgets = (['activity', 'status', 'projects', 'aiAnalysis', 'docker'] as const)
		.filter(widget => shouldSkipPromptDashboardWidgetRefresh(state, widget));
	return [...widgets];
}

/** Maps one visible dashboard section to the host widget payload it belongs to. */
export function resolvePromptDashboardWidgetKindForSection(
	section: PromptDashboardSectionKey,
): PromptDashboardWidgetKind {
	if (section === 'dockerContainers') {
		return 'docker';
	}

	return section === 'status' || section === 'activity' || section === 'aiAnalysis'
		? section
		: 'projects';
}

/** Checks whether at least one top-level dashboard section is still visible. */
export function hasVisiblePromptDashboardSections(
	state: PromptDashboardCollapsedSections,
): boolean {
	const normalized = normalizePromptDashboardCollapsedSections(state);
	return PROMPT_DASHBOARD_SECTION_KEYS.some(section => normalized[section] !== true);
}

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
	changedFileCount?: number;
	changedFilesHydrated?: boolean;
}

export interface PromptDashboardProjectSummary {
	project: string;
	repositoryPath: string;
	available: boolean;
	error: string;
	branchSwitchError: string;
	/** Stores the latest pull-action error for the current project row. */
	pullError: string;
	/** Flags selected prompt projects whose current branch differs from the prompt branch. */
	hasPromptBranchMismatch: boolean;
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
	incomingFiles: GitOverlayCommitChangedFile[];
	incomingAuthors?: string[];
	uncommittedFiles: GitOverlayChangeFile[];
}

export interface PromptDashboardProjectsData {
	projects: PromptDashboardProjectSummary[];
	branchProjects?: PromptDashboardProjectSummary[];
	/** Marks which shared Git-backed sections already have explicit data in this payload. */
	loadedSections?: PromptDashboardSectionKey[];
}

/** Normalizes loaded shared-project sections into a stable dashboard order. */
export function normalizePromptDashboardLoadedProjectSections(
	sections?: readonly PromptDashboardSectionKey[] | null,
	hasProjectData = false,
): PromptDashboardSectionKey[] {
	if (!sections) {
		return hasProjectData ? [...PROMPT_DASHBOARD_PROJECT_SECTION_KEYS] : [];
	}

	const requestedSections = new Set(
		sections.filter((section): section is PromptDashboardSectionKey => PROMPT_DASHBOARD_PROJECT_SECTION_KEYS.includes(section)),
	);
	return PROMPT_DASHBOARD_PROJECT_SECTION_KEYS.filter(section => requestedSections.has(section));
}

/** Checks whether one shared Git-backed section already has its own payload data. */
export function isPromptDashboardProjectsSectionLoaded(
	data: PromptDashboardProjectsData | null | undefined,
	section: PromptDashboardSectionKey,
): boolean {
	if (!PROMPT_DASHBOARD_PROJECT_SECTION_KEYS.includes(section)) {
		return true;
	}
	if (!data) {
		return false;
	}

	const loadedSections = normalizePromptDashboardLoadedProjectSections(
		data.loadedSections,
		(data.projects?.length || 0) > 0 || (data.branchProjects?.length || 0) > 0,
	);
	return loadedSections.includes(section);
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
	selectedProjectNames: string[];
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
	docker: PromptDashboardWidgetSnapshot<DockerContainersData>;
	aiAnalysis: PromptDashboardWidgetSnapshot<PromptDashboardAnalysisState | null>;
}