/**
 * Core type definitions for Prompt Manager extension
 */

/** Prompt status */
export type PromptStatus = 'draft' | 'in-progress' | 'stopped' | 'cancelled' | 'completed' | 'report' | 'review' | 'closed';

/** Canonical order of prompt statuses used in UI controls and grouping */
export const PROMPT_STATUS_ORDER: PromptStatus[] = [
	'draft',
	'in-progress',
	'stopped',
	'cancelled',
	'completed',
	'report',
	'review',
	'closed',
];

const PROMPT_STATUS_SET = new Set<PromptStatus>(PROMPT_STATUS_ORDER);

export function isPromptStatus(value: string): value is PromptStatus {
	return PROMPT_STATUS_SET.has(value as PromptStatus);
}

export function getNextPromptStatus(status: PromptStatus): PromptStatus | null {
	const index = PROMPT_STATUS_ORDER.indexOf(status);
	if (index < 0 || index >= PROMPT_STATUS_ORDER.length - 1) {
		return null;
	}

	return PROMPT_STATUS_ORDER[index + 1] || null;
}

export function shouldShowPromptPlanForStatus(status: PromptStatus): boolean {
	return status !== 'draft';
}

/** Editor tab in prompt settings page */
export type EditorPromptTab = 'main' | 'process';

/** Persisted per-prompt editor view state */
export interface EditorPromptViewState {
	activeTab: EditorPromptTab;
}

/** Key source used for resolving persisted editor view state */
export interface EditorPromptViewStateKeySource {
	promptUuid?: string | null;
	promptId?: string | null;
	fallbackKey?: string | null;
}

/** Create default per-prompt editor view state */
export function createDefaultEditorPromptViewState(): EditorPromptViewState {
	return {
		activeTab: 'main',
	};
}

/** Normalize potentially partial persisted editor view state */
export function normalizeEditorPromptViewState(
	state?: Partial<EditorPromptViewState> | null,
): EditorPromptViewState {
	const defaults = createDefaultEditorPromptViewState();
	if (!state) {
		return defaults;
	}

	return {
		activeTab: state.activeTab === 'process' ? 'process' : defaults.activeTab,
	};
}

/** Resolve all candidate storage keys for per-prompt editor view state */
export function getEditorPromptViewStateStorageKeys(source?: EditorPromptViewStateKeySource | null): string[] {
	const keys: string[] = [];
	const promptUuid = typeof source?.promptUuid === 'string' ? source.promptUuid.trim() : '';
	if (promptUuid) {
		keys.push(`promptUuid:${promptUuid}`);
	}

	const promptId = typeof source?.promptId === 'string' ? source.promptId.trim() : '';
	if (promptId) {
		keys.push(`promptId:${promptId}`);
	}

	const fallbackKey = typeof source?.fallbackKey === 'string' ? source.fallbackKey.trim() : '';
	if (fallbackKey) {
		keys.push(fallbackKey);
	}

	return Array.from(new Set(keys));
}

/** Resolve the primary storage key for per-prompt editor view state */
export function resolveEditorPromptViewStateStorageKey(source?: EditorPromptViewStateKeySource | null): string | null {
	return getEditorPromptViewStateStorageKeys(source)[0] || null;
}

/** Move persisted editor view state from transient keys to a stable prompt key */
export function moveEditorPromptViewStateEntries(
	states: Record<string, EditorPromptViewState> | null | undefined,
	fromSources: Array<EditorPromptViewStateKeySource | null | undefined>,
	toSource?: EditorPromptViewStateKeySource | null,
): Record<string, EditorPromptViewState> {
	const next: Record<string, EditorPromptViewState> = {};
	for (const [key, value] of Object.entries(states || {})) {
		const normalizedKey = key.trim();
		if (!normalizedKey) {
			continue;
		}
		next[normalizedKey] = normalizeEditorPromptViewState(value);
	}

	const targetKeys = getEditorPromptViewStateStorageKeys(toSource);
	const primaryTargetKey = targetKeys[0] || null;
	if (!primaryTargetKey) {
		return next;
	}

	const sourceKeys = Array.from(new Set(
		fromSources.flatMap(source => getEditorPromptViewStateStorageKeys(source)),
	));

	let stateToCarry = next[primaryTargetKey];
	for (const sourceKey of sourceKeys) {
		if (!stateToCarry && next[sourceKey]) {
			stateToCarry = next[sourceKey];
		}
	}

	if (!stateToCarry) {
		return next;
	}

	next[primaryTargetKey] = normalizeEditorPromptViewState(stateToCarry);
	for (const sourceKey of sourceKeys) {
		if (sourceKey !== primaryTargetKey) {
			delete next[sourceKey];
		}
	}
	for (const targetKey of targetKeys.slice(1)) {
		if (targetKey !== primaryTargetKey) {
			delete next[targetKey];
		}
	}

	return next;
}

/** Prompt configuration stored as JSON */
export interface PromptConfig {
	/** Unique identifier (folder name / slug) */
	id: string;
	/** Stable UUID that survives slug/folder renames */
	promptUuid: string;
	/** Human-readable title */
	title: string;
	/** Short description */
	description: string;
	/** Status of the prompt */
	status: PromptStatus;
	/** Whether this prompt is favorited */
	favorite: boolean;
	/** Icon codicon name or path */
	icon?: string;

	// --- Workspace context ---
	/** Selected workspace folder names */
	projects: string[];
	/** Programming languages */
	languages: string[];
	/** Frameworks */
	frameworks: string[];
	/** Skills (from .vscode/skills/ or ~/.copilot/skills/) */
	skills: string[];
	/** MCP tool identifiers */
	mcpTools: string[];
	/** Hooks (from .vscode/hooks/ or ~/.copilot/hooks/) */
	hooks: string[];

	// --- Task tracking ---
	/** Task tracker issue number/reference */
	taskNumber: string;
	/** Git branch name */
	branch: string;
	/** Preferred tracked branch for Git flow */
	trackedBranch: string;
	/** Preferred tracked branches per project for Git flow */
	trackedBranchesByProject?: Record<string, string>;

	// --- AI model ---
	/** AI model identifier to use */
	model: string;

	// --- Chat mode ---
	/** Chat mode: 'agent' | 'plan' */
	chatMode: 'agent' | 'plan';

	// --- Context files ---
	/** Relative paths to context files attached to this prompt */
	contextFiles: string[];
	/** Path to HTTP examples file */
	httpExamples: string;

	// --- Chat integration ---
	/** Associated Copilot chat session IDs */
	chatSessionIds: string[];

	// --- Time tracking ---
	/** Time spent writing the prompt (ms) */
	timeSpentWriting: number;
	/** Time spent in chat implementing (ms) */
	timeSpentImplementing: number;
	/** Accumulated task work time while status is in-progress (ms) */
	timeSpentOnTask: number;
	/** Additional manually entered time (ms) */
	timeSpentUntracked: number;
	/** Process notes for the prompt execution */
	notes: string;

	// --- Timestamps ---
	createdAt: string;
	updatedAt: string;
}

/** Full prompt data (config + markdown content) */
export interface Prompt extends PromptConfig {
	/** Markdown content of the prompt */
	content: string;
	/** Markdown report content */
	report: string;
}

export type PromptContextFileKind =
	| 'image'
	| 'video'
	| 'audio'
	| 'pdf'
	| 'archive'
	| 'document'
	| 'sheet'
	| 'slides'
	| 'code'
	| 'text'
	| 'other';

export interface PromptContextFileCard {
	path: string;
	displayName: string;
	directoryLabel: string;
	extension: string;
	tileLabel: string;
	kind: PromptContextFileKind;
	typeLabel: string;
	exists: boolean;
	sizeBytes?: number;
	sizeLabel: string;
	modifiedAt?: string;
	previewUri?: string;
}

export type PromptHistoryReason =
	| 'manual'
	| 'autosave'
	| 'status-change'
	| 'switch'
	| 'start-chat'
	| 'restore'
	| 'system';

export interface PromptHistoryEntry {
	id: string;
	promptId: string;
	createdAt: string;
	reason: PromptHistoryReason;
	prompt: Prompt;
}

/** Default prompt config */
export function createDefaultPrompt(id: string = ''): Prompt {
	const now = new Date().toISOString();
	return {
		id,
		promptUuid: '',
		title: '',
		description: '',
		status: 'draft',
		favorite: false,
		projects: [],
		languages: [],
		frameworks: [],
		skills: [],
		mcpTools: [],
		hooks: [],
		taskNumber: '',
		branch: '',
		trackedBranch: '',
		trackedBranchesByProject: {},
		model: '',
		chatMode: 'agent',
		contextFiles: [],
		httpExamples: '',
		chatSessionIds: [],
		timeSpentWriting: 0,
		timeSpentImplementing: 0,
		timeSpentOnTask: 0,
		timeSpentUntracked: 0,
		notes: '',
		createdAt: now,
		updatedAt: now,
		content: '',
		report: '',
	};
}

/** Sidebar sort options */
export type SortField = 'title' | 'createdAt' | 'updatedAt' | 'status';
export type SortOrder = 'asc' | 'desc';

/** Sidebar group options */
export type GroupBy = 'none' | 'status' | 'project' | 'language' | 'framework';

/** Sidebar created-at period filter */
export type CreatedAtFilter =
	| 'all'
	| 'last-1-day'
	| 'last-7-days'
	| 'last-14-days'
	| 'last-30-days'
	| 'last-1-year'
	| 'current-week'
	| 'previous-week'
	| 'current-month'
	| 'previous-month'
	| 'current-year'
	| 'previous-year';

/** Filter state for sidebar */
export interface FilterState {
	search: string;
	status: PromptStatus[];
	projects: string[];
	languages: string[];
	frameworks: string[];
	favorites: boolean;
	createdAt: CreatedAtFilter;
}

/** Sidebar UI state */
export interface SidebarState {
	selectedPromptId: string | null;
	selectedPromptUuid: string | null;
	filters: FilterState;
	sortField: SortField;
	sortOrder: SortOrder;
	groupBy: GroupBy;
	collapsedGroups: Record<string, boolean>;
	panelWidth: number;
}

type PartialSidebarState = Partial<Omit<SidebarState, 'filters'>> & {
	filters?: Partial<FilterState>;
};

/** Create default sidebar state */
export function createDefaultSidebarState(): SidebarState {
	return {
		selectedPromptId: null,
		selectedPromptUuid: null,
		filters: {
			search: '',
			status: [],
			projects: [],
			languages: [],
			frameworks: [],
			favorites: false,
			createdAt: 'all',
		},
		sortField: 'createdAt',
		sortOrder: 'desc',
		groupBy: 'none',
		collapsedGroups: {},
		panelWidth: 300,
	};
}

/** Normalize potentially partial persisted sidebar state */
export function normalizeSidebarState(state?: PartialSidebarState | null): SidebarState {
	const defaults = createDefaultSidebarState();
	if (!state) {
		return defaults;
	}

	return {
		...defaults,
		...state,
		filters: {
			...defaults.filters,
			...(state.filters || {}),
		},
		collapsedGroups: state.collapsedGroups || defaults.collapsedGroups,
	};
}

/** Statistics for all prompts */
export interface PromptStatistics {
	totalPrompts: number;
	byStatus: Record<PromptStatus, number>;
	totalTimeWriting: number;
	totalTimeImplementing: number;
	totalTimeOnTask: number;
	totalTime: number;
	favoriteCount: number;
	avgTimePerPrompt: number;
	recentActivity: Array<{ id: string; title: string; updatedAt: string }>;
	/** Brief report rows: taskNumber, title, total time */
	reportRows: Array<{ taskNumber: string; title: string; timeWriting: number; timeImplementing: number; timeOnTask: number; totalTime: number; status: PromptStatus; reportSummary: string }>;
}
