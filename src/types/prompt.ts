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
		model: '',
		chatMode: 'agent',
		contextFiles: [],
		httpExamples: '',
		chatSessionIds: [],
		timeSpentWriting: 0,
		timeSpentImplementing: 0,
		timeSpentOnTask: 0,
		timeSpentUntracked: 0,
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

/** Filter state for sidebar */
export interface FilterState {
	search: string;
	status: PromptStatus[];
	projects: string[];
	languages: string[];
	frameworks: string[];
	favorites: boolean;
}

/** Sidebar UI state */
export interface SidebarState {
	selectedPromptId: string | null;
	filters: FilterState;
	sortField: SortField;
	sortOrder: SortOrder;
	groupBy: GroupBy;
	collapsedGroups: Record<string, boolean>;
	panelWidth: number;
}

/** Create default sidebar state */
export function createDefaultSidebarState(): SidebarState {
	return {
		selectedPromptId: null,
		filters: {
			search: '',
			status: [],
			projects: [],
			languages: [],
			frameworks: [],
			favorites: false,
		},
		sortField: 'createdAt',
		sortOrder: 'desc',
		groupBy: 'none',
		collapsedGroups: {},
		panelWidth: 300,
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
