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

/** Expandable section keys in prompt settings page */
export type EditorPromptSectionKey =
	| 'basic'
	| 'workspace'
	| 'prompt'
	| 'globalPrompt'
	| 'report'
	| 'notes'
	| 'memory'
	| 'plan'
	| 'tech'
	| 'integrations'
	| 'agent'
	| 'groups'
	| 'files'
	| 'time';

/** Sections whose default state can still be overridden by content until manual interaction. */
export const PROMPT_EDITOR_AUTO_MANAGED_SECTION_KEYS = ['notes', 'plan', 'report'] as const;

/** Sections that stay under automatic default/content rules until manually changed. */
export type EditorPromptAutoManagedSectionKey = typeof PROMPT_EDITOR_AUTO_MANAGED_SECTION_KEYS[number];

const PROMPT_EDITOR_AUTO_MANAGED_SECTION_KEY_SET = new Set<EditorPromptSectionKey>(
	PROMPT_EDITOR_AUTO_MANAGED_SECTION_KEYS,
);

export function isPromptEditorAutoManagedSection(
	key: EditorPromptSectionKey,
): key is EditorPromptAutoManagedSectionKey {
	return PROMPT_EDITOR_AUTO_MANAGED_SECTION_KEY_SET.has(key);
}

/** Persisted expanded/collapsed state for prompt editor sections */
export type EditorPromptExpandedSections = Record<EditorPromptSectionKey, boolean>;

/** Persisted mode for a manually toggled auto-managed section. */
export type EditorPromptManualSectionOverrideMode = 'manual' | 'until-content';

/** Marks sections that were toggled manually and how long the override should win. */
export type EditorPromptManualSectionOverrides = Partial<Record<EditorPromptAutoManagedSectionKey, EditorPromptManualSectionOverrideMode>>;

/** Create default expanded/collapsed state for prompt editor sections */
export function createDefaultEditorPromptExpandedSections(): EditorPromptExpandedSections {
	return {
		basic: true,
		workspace: true,
		prompt: true,
		globalPrompt: false,
		report: false,
		notes: false,
		memory: false,
		plan: false,
		tech: false,
		integrations: false,
		agent: true,
		groups: false,
		files: false,
		time: true,
	};
}

/** Create default manual override flags for prompt editor sections. */
export function createDefaultEditorPromptManualSectionOverrides(): EditorPromptManualSectionOverrides {
	return {};
}

/** Persisted per-prompt editor view state */
export interface EditorPromptViewState {
	activeTab: EditorPromptTab;
	expandedSections: EditorPromptExpandedSections;
	manualSectionOverrides: EditorPromptManualSectionOverrides;
	descriptionExpanded: boolean;
}

type PartialEditorPromptViewState = Partial<Omit<EditorPromptViewState, 'expandedSections'>> & {
	expandedSections?: Partial<EditorPromptExpandedSections> | null;
	manualSectionOverrides?: EditorPromptManualSectionOverrides | null;
};

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
		expandedSections: createDefaultEditorPromptExpandedSections(),
		manualSectionOverrides: createDefaultEditorPromptManualSectionOverrides(),
		descriptionExpanded: false,
	};
}

function normalizeEditorPromptExpandedSections(
	state?: Partial<Record<EditorPromptSectionKey, unknown>> | null,
): EditorPromptExpandedSections {
	const defaults = createDefaultEditorPromptExpandedSections();
	if (!state || typeof state !== 'object') {
		return defaults;
	}

	return {
		basic: typeof state.basic === 'boolean' ? state.basic : defaults.basic,
		workspace: typeof state.workspace === 'boolean' ? state.workspace : defaults.workspace,
		prompt: typeof state.prompt === 'boolean' ? state.prompt : defaults.prompt,
		globalPrompt: typeof state.globalPrompt === 'boolean' ? state.globalPrompt : defaults.globalPrompt,
		report: typeof state.report === 'boolean' ? state.report : defaults.report,
		notes: typeof state.notes === 'boolean' ? state.notes : defaults.notes,
		memory: typeof state.memory === 'boolean' ? state.memory : defaults.memory,
		plan: typeof state.plan === 'boolean' ? state.plan : defaults.plan,
		tech: typeof state.tech === 'boolean' ? state.tech : defaults.tech,
		integrations: typeof state.integrations === 'boolean' ? state.integrations : defaults.integrations,
		agent: typeof state.agent === 'boolean' ? state.agent : defaults.agent,
		groups: typeof state.groups === 'boolean' ? state.groups : defaults.groups,
		files: typeof state.files === 'boolean' ? state.files : defaults.files,
		time: typeof state.time === 'boolean' ? state.time : defaults.time,
	};
}

function normalizeEditorPromptManualSectionOverrides(
	state?: Partial<Record<EditorPromptAutoManagedSectionKey, unknown>> | null,
): EditorPromptManualSectionOverrides {
	const normalized: EditorPromptManualSectionOverrides = {};

	for (const key of PROMPT_EDITOR_AUTO_MANAGED_SECTION_KEYS) {
		const rawValue = state?.[key];
		if (rawValue === true || rawValue === 'manual') {
			normalized[key] = 'manual';
			continue;
		}

		if ((key === 'plan' || key === 'report') && rawValue === 'until-content') {
			normalized[key] = 'until-content';
		}
	}

	return normalized;
}

/** Normalize potentially partial persisted editor view state */
export function normalizeEditorPromptViewState(
	state?: PartialEditorPromptViewState | null,
): EditorPromptViewState {
	const defaults = createDefaultEditorPromptViewState();
	if (!state) {
		return defaults;
	}

	return {
		activeTab: state.activeTab === 'process' ? 'process' : defaults.activeTab,
		expandedSections: normalizeEditorPromptExpandedSections(state.expandedSections),
		manualSectionOverrides: normalizeEditorPromptManualSectionOverrides(state.manualSectionOverrides),
		descriptionExpanded: typeof state.descriptionExpanded === 'boolean'
			? state.descriptionExpanded
			: defaults.descriptionExpanded,
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
	states: Record<string, PartialEditorPromptViewState> | null | undefined,
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
	/** Whether this prompt is stored in archive */
	archived?: boolean;
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
	/** Auto-complete only after a chat request started at/after this timestamp (ms). */
	chatRequestAutoCompleteAfter?: number;

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

	// --- Agent progress ---
	/** Task completion progress (0–100) read from agent.json at runtime; not persisted in config.json */
	progress?: number;

	// --- Custom groups ---
	/** IDs of custom user-defined groups this prompt belongs to */
	customGroupIds?: string[];

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
		/** Генерируем UUID сразу при создании, чтобы однозначно идентифицировать промпт до первого сохранения */
		promptUuid: crypto.randomUUID(),
		title: '',
		description: '',
		status: 'draft',
		favorite: false,
		archived: false,
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
		customGroupIds: [],
		createdAt: now,
		updatedAt: now,
		content: '',
		report: '',
	};
}

/** Normalize the auto-complete request gate stored in prompt config. */
function normalizePromptChatRequestAutoCompleteAfter(value: unknown): number | undefined {
	const normalized = Number(value);
	if (!Number.isFinite(normalized) || normalized <= 0) {
		return undefined;
	}

	return normalized;
}

/** Record that prompt auto-complete should wait for the next chat request after this moment. */
export function markPromptChatAutoCompleteAfter<T extends { chatRequestAutoCompleteAfter?: number }>(
	prompt: T,
	timestampMs: number = Date.now(),
): T {
	const normalizedTimestamp = normalizePromptChatRequestAutoCompleteAfter(timestampMs);
	if (normalizedTimestamp === undefined) {
		delete prompt.chatRequestAutoCompleteAfter;
		return prompt;
	}

	prompt.chatRequestAutoCompleteAfter = normalizedTimestamp;
	return prompt;
}

/** Allow auto-complete only for chat requests that started after the in-progress gate. */
export function shouldAutoCompletePromptFromChatRequest(
	prompt: Pick<PromptConfig, 'chatRequestAutoCompleteAfter'>,
	requestStartedAt?: number,
): boolean {
	const gateTimestamp = normalizePromptChatRequestAutoCompleteAfter(prompt.chatRequestAutoCompleteAfter);
	if (gateTimestamp === undefined) {
		return true;
	}

	const normalizedRequestStartedAt = Number(requestStartedAt || 0);
	if (!Number.isFinite(normalizedRequestStartedAt) || normalizedRequestStartedAt <= 0) {
		return false;
	}

	return normalizedRequestStartedAt >= gateTimestamp;
}

/** Sidebar sort options */
export type SortField = 'title' | 'createdAt' | 'updatedAt' | 'status';
export type SortOrder = 'asc' | 'desc';

/** Sidebar list view options */
export type SidebarViewMode = 'detailed' | 'compact';

/** Sidebar group options */
export type GroupBy = 'none' | 'status' | 'project' | 'language' | 'framework' | 'custom';

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
	viewMode: SidebarViewMode;
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
		viewMode: 'detailed',
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

/** User-defined custom group for prompts. Independent from PromptStatus. */
export interface PromptCustomGroup {
	/** Stable unique identifier (uuid) */
	id: string;
	/** Display name shown in UI */
	name: string;
	/** Optional CSS color (e.g. '#ff8800' or 'var(--vscode-charts-blue)'). Empty = default */
	color: string;
	/** Sort order (ascending). Lower values appear first. */
	order: number;
	/** ISO 8601 creation timestamp */
	createdAt: string;
	/** ISO 8601 last update timestamp */
	updatedAt: string;
}

/** Sentinel ID used in the 'custom' group view to bucket prompts without any custom group. */
export const PROMPT_CUSTOM_GROUP_NONE_KEY = '__prompt-manager:no-custom-group__';

/** Normalize raw partial PromptCustomGroup payload (e.g. coming from disk JSON or message) */
export function normalizePromptCustomGroup(
	raw: Partial<PromptCustomGroup> | null | undefined,
): PromptCustomGroup | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}

	const id = typeof raw.id === 'string' ? raw.id.trim() : '';
	const name = typeof raw.name === 'string' ? raw.name.trim() : '';
	if (!id || !name) {
		return null;
	}

	const now = new Date().toISOString();
	return {
		id,
		name,
		color: typeof raw.color === 'string' ? raw.color.trim() : '',
		order: Number.isFinite(raw.order) ? Number(raw.order) : 0,
		createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : now,
		updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : now,
	};
}

/** Sort custom groups by (order, name). Stable for equal order via name fallback. */
export function sortPromptCustomGroups(groups: PromptCustomGroup[]): PromptCustomGroup[] {
	return [...groups].sort((a, b) => {
		if (a.order !== b.order) {
			return a.order - b.order;
		}
		return a.name.localeCompare(b.name);
	});
}

// ---- Chat Memory Summary (displayed in Process tab) ----

/** Source kind for an instruction file attached to the chat session. */
export type ChatMemoryInstructionSourceKind = 'global' | 'session' | 'project' | 'codemap' | 'unknown';

/** Instruction file attached to the chat session */
export interface ChatMemoryInstructionFile {
	/** Short label for display (e.g. "Глобальные инструкции") */
	label: string;
	/** File name on disk */
	fileName: string;
	/** Stable source kind for UI grouping and badges */
	sourceKind: ChatMemoryInstructionSourceKind;
	/** Short explanation of what the source adds to the chat */
	description: string;
	/** Whether the file existed at the time of summary generation */
	exists: boolean;
	/** File size in bytes, when available */
	sizeBytes?: number;
	/** Human-readable file size */
	sizeLabel: string;
	/** ISO timestamp of the last modification, when available */
	modifiedAt?: string;
}

/** Aggregated count for an attached context-file kind. */
export interface ChatMemoryContextKindSummary {
	/** Canonical kind used by PromptContextFileCard */
	kind: PromptContextFileKind;
	/** Localized kind label for direct rendering */
	label: string;
	/** Number of existing files of this kind */
	count: number;
}

/** Detailed snapshot of prompt context files for the last chat start. */
export interface ChatMemoryContextFilesSummary {
	/** Detailed cards for each referenced context file */
	files: PromptContextFileCard[];
	/** Number of referenced context files after normalization/deduplication */
	totalCount: number;
	/** Number of files that existed and could be attached */
	existingCount: number;
	/** Number of missing or unreadable files */
	missingCount: number;
	/** Combined size of existing context files in bytes */
	totalSizeBytes: number;
	/** Human-readable combined size of existing context files */
	totalSizeLabel: string;
	/** Breakdown of existing files by kind */
	kindBreakdown: ChatMemoryContextKindSummary[];
}

/** Summary of one codemap instruction section included in chat memory. */
export interface ChatMemoryCodemapInstructionSummary {
	/** Branch name used for the rendered instruction */
	branchName: string;
	/** Tracked branch resolved for the repository */
	resolvedBranchName: string;
	/** Instruction kind represented by the section */
	instructionKind: 'base' | 'delta';
	/** Whether a persisted instruction existed when the summary was generated */
	exists: boolean;
	/** Whether a refresh for this section was queued during chat preparation */
	queuedRefresh: boolean;
	/** Number of files declared by the persisted instruction metadata */
	fileCount: number;
	/** Number of described files found in the stored branch artifact */
	describedFilesCount: number;
	/** Number of described symbols found in the stored branch artifact */
	describedSymbolsCount: number;
	/** Number of method/function-like described symbols */
	describedMethodLikeCount: number;
	/** Uncompressed instruction size in bytes */
	sizeBytes: number;
	/** Compressed instruction size in bytes */
	compressedSizeBytes: number;
	/** When the persisted instruction was generated, if available */
	generatedAt?: string;
	/** Source commit sha for the persisted instruction, if available */
	sourceCommitSha?: string;
}

/** Codemap coverage snapshot for one repository in the attached chat memory. */
export interface ChatMemoryCodemapRepositorySummary {
	/** Repository name as resolved from the workspace */
	repository: string;
	/** Current branch at chat-start time */
	currentBranch: string;
	/** Resolved tracked branch for the repository */
	resolvedBranchName: string;
	/** Base branch used for codemap comparisons */
	baseBranchName: string;
	/** Included codemap sections for this repository */
	sections: ChatMemoryCodemapInstructionSummary[];
}

/** Aggregated codemap coverage included in the chat memory snapshot. */
export interface ChatMemoryCodemapSummary {
	/** Number of repositories represented in the codemap snapshot */
	repositoryCount: number;
	/** Number of persisted or queued codemap instruction sections */
	instructionCount: number;
	/** Number of codemap instruction sections queued for refresh */
	queuedRefreshCount: number;
	/** Combined fileCount across included codemap instruction sections */
	totalFileCount: number;
	/** Combined described file count across included codemap artifacts */
	describedFilesCount: number;
	/** Combined described symbol count across included codemap artifacts */
	describedSymbolsCount: number;
	/** Combined method/function-like described symbol count */
	describedMethodLikeCount: number;
	/** Combined uncompressed codemap instruction size in bytes */
	totalSizeBytes: number;
	/** Combined compressed codemap instruction size in bytes */
	totalCompressedSizeBytes: number;
	/** Per-repository codemap snapshot details */
	repositories: ChatMemoryCodemapRepositorySummary[];
}

/** Top-level aggregate counters for the memory snapshot shown in the editor. */
export interface ChatMemoryTotalsSummary {
	/** Number of files that were available for attachment */
	attachedFilesCount: number;
	/** Number of instruction files attached to the chat */
	instructionFilesCount: number;
	/** Number of referenced prompt context files */
	contextFilesCount: number;
	/** Number of prompt context files that existed */
	contextExistingCount: number;
	/** Combined size of all attached files in bytes */
	totalSizeBytes: number;
	/** Combined size of attached instruction files in bytes */
	instructionSizeBytes: number;
	/** Combined size of attached context files in bytes */
	contextSizeBytes: number;
	/** Combined described file count surfaced by codemap */
	describedFilesCount: number;
	/** Combined described symbol count surfaced by codemap */
	describedSymbolsCount: number;
	/** Combined method/function-like described symbol count surfaced by codemap */
	describedMethodLikeCount: number;
}

/** Summary of the memory context passed to the chat */
export interface ChatMemorySummary {
	/** Total character count of the raw memory context block */
	totalChars: number;
	/** Number of recent/relevant commits included */
	shortTermCommits: number;
	/** Number of architecture summaries included */
	longTermSummaries: number;
	/** Whether the project structure map was included */
	hasProjectMap: boolean;
	/** Number of uncommitted-change projects included */
	uncommittedProjects: number;
	/** Instruction files attached to the chat */
	instructionFiles: ChatMemoryInstructionFile[];
	/** User context files count */
	contextFilesCount: number;
	/** ISO timestamp when the summary was built */
	generatedAt: string;
	/** Detailed prompt context files snapshot for the last chat generation */
	contextFiles: ChatMemoryContextFilesSummary;
	/** Aggregated codemap coverage for the last chat generation */
	codemap: ChatMemoryCodemapSummary | null;
	/** Top-level file and codemap counters for quick metric rendering */
	totals: ChatMemoryTotalsSummary;
}
