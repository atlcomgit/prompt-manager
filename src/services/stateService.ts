/**
 * State service — persists UI state (sidebar filters, sort, last opened prompt, etc.)
 * Хранит общие UI-настройки в конфигурации пользователя, локальные состояния — в workspaceState.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { lock } from 'proper-lockfile';
import { refreshUserSettingsSnapshot } from './userSettingsSnapshot.js';
import { QuickCommandSettings, QUICK_COMMAND_PREFIX, QUICK_COMMAND_TRANSACTION } from './quickCommandSettings.js';
import type { EditorPromptViewState, EditorPromptViewStateKeySource, EditorPromptPlanViewMode, SidebarState } from '../types/prompt.js';
import type {
	PromptDashboardCollapsedSections,
	PromptDashboardSectionOrder,
	PromptDashboardLayoutMode,
	PromptDashboardLayouts,
} from '../types/promptDashboard.js';
import {
	createDefaultEditorPromptViewState,
	moveEditorPromptViewStateEntries,
	normalizeEditorPromptViewState,
	normalizeSidebarState,
	getEditorPromptViewStateStorageKeys,
	getEditorPromptPlanViewModeKeys,
	moveEditorPromptPlanViewModeEntries,
	resolveEditorPromptViewStateStorageKey,
} from '../types/prompt.js';
import {
	normalizePromptDashboardLayouts,
	normalizePromptDashboardCollapsedSections,
	normalizePromptDashboardSectionOrder,
	PROMPT_DASHBOARD_SECTION_KEYS,
} from '../types/promptDashboard.js';
import {
	normalizePromptDashboardPreferences,
	serializeDashboardQuickCommands,
	type DashboardQuickCommandEdit,
	type DashboardQuickCommandsConfiguration,
	type DashboardQuickCommandsWidgetState,
	type PromptDashboardPreferences,
} from '../types/promptDashboardPreferences.js';
import { readSqliteItemValueCached, resolveBundledSqlJsWasmPath } from '../utils/sqliteItemTable.js';
import { observeStableChatCompletion, isCompletedChatResponse, type StableChatCompletionCandidate } from '../utils/chatCompletionState.js';
import {
	normalizePromptEditorLayout, normalizePromptEditorMainExpanded, PROMPT_EDITOR_TAB_SECTIONS,
	type PromptEditorLayout,
} from '../types/promptEditorLayout.js';
import { applyUiSettingsChanges } from '../utils/uiSettingsPatch.js';

/** Независимые поля Docker не перезаписывают соседнюю настройку из другого окна. */
const PROMPT_DOCKER_SETTING_FIELDS = ['viewMode', 'statusFilter', 'search', 'sortBy', 'expandedContainerIds'] as const;
/** Независимые поля TODO сохраняют параллельный поиск и выбор типов файлов. */
const PROMPT_TODOS_SETTING_FIELDS = ['search', 'selectedFileTypes'] as const;
/** Поля вида быстрых заметок пишутся отдельно, чтобы параллельные правки окон не затирали друг друга. */
const PROMPT_QUICK_NOTES_SETTING_FIELDS = [
	'newNoteScope', 'newNoteColor', 'search', 'colors', 'boardGroupBy', 'boardScope', 'boardShowDone', 'descriptionHeight',
] as const;

/** Глобальный строковый порядок остаётся доступен старым версиям. */
const QUICK_COMMAND_METADATA_FIELDS = ['categories', 'texts'] as const;
const PROMPT_QUICK_COMMANDS_SETTING_FIELDS = ['items', ...QUICK_COMMAND_METADATA_FIELDS, 'target'] as const;
/** Independently stored dashboard settings; changes inside object maps merge by key. */
const PROMPT_DASHBOARD_PREFERENCE_FIELDS = ['showAllBranchProjects', 'hiddenSections'] as const;
const DASHBOARD_MAP_FIELDS = ['expanded', 'bashScriptOrder', 'bashScriptFavorites', 'bashScriptHiddenFolders'] as const;
const DASHBOARD_MAP_READ_TOKEN = 'dashboardMapStorage.readToken';
const DASHBOARD_EXPANDED_SETTING = 'dashboardPreferences.expanded';
/** Пользовательские настройки application наследуются Tunnel и участвуют в штатной Settings Sync. */
export const PROMPT_UI_SETTING_KEYS = [
	'editor.sectionOrder.main', 'editor.sectionOrder.process',
	...PROMPT_EDITOR_TAB_SECTIONS.main.map(section => `editor.mainExpandedSections.${section}`),
	'editor.panelSplitRatio',
	'dashboardLayouts.singleColumn.order', 'dashboardLayouts.twoColumns.order',
	...['singleColumn', 'twoColumns'].flatMap(mode => PROMPT_DASHBOARD_SECTION_KEYS.map(
		section => `dashboardLayouts.${mode}.collapsed.${section}`,
	)),
	...PROMPT_DOCKER_SETTING_FIELDS.map(field => `dashboardPreferences.docker.${field}`),
	...PROMPT_TODOS_SETTING_FIELDS.map(field => `dashboardPreferences.todos.${field}`),
	...PROMPT_QUICK_NOTES_SETTING_FIELDS.map(field => `dashboardPreferences.quickNotes.${field}`),
	...PROMPT_QUICK_COMMANDS_SETTING_FIELDS.map(field => `${QUICK_COMMAND_PREFIX}.${field}`),
	`${QUICK_COMMAND_PREFIX}.textBindings`, QUICK_COMMAND_TRANSACTION,
	...PROMPT_DASHBOARD_PREFERENCE_FIELDS.map(field => `dashboardPreferences.${field}`),
	...DASHBOARD_MAP_FIELDS.map(field => `dashboardPreferences.${field}`),
] as const;

interface ChatSessionLatestRequestState {
	requestIndex: number;
	requestModelState?: number;
	hasRequestResult?: boolean;
}

/** Tracks whether the shared agent context came from remote load or manual input. */
export type GlobalAgentContextSource = 'empty' | 'manual' | 'remote';

const SIDEBAR_STATE_KEY = 'promptManager.sidebarState';
const LAST_PROMPT_KEY = 'promptManager.lastPromptId';
const GLOBAL_AGENT_CONTEXT_KEY = 'promptManager.globalAgentContext';
const GLOBAL_AGENT_CONTEXT_SOURCE_KEY = 'promptManager.globalAgentContextSource';
const STARTUP_EDITOR_OPEN_KEY = 'promptManager.startup.editorOpen';
const STARTUP_EDITOR_PROMPT_ID_KEY = 'promptManager.startup.editorPromptId';
const PROMPT_EDITOR_VIEW_STATE_KEY = 'promptManager.editorPromptViewState';
/** An explicit per-prompt plan view choice cannot be overwritten by an older layout snapshot. */
const PROMPT_EDITOR_PLAN_MODE_KEY = 'promptManager.editorPlanViewModes';
const PROMPT_DASHBOARD_COLLAPSED_SECTIONS_KEY = 'promptManager.dashboardCollapsedSections';
const PROMPT_DASHBOARD_SECTION_ORDER_KEY = 'promptManager.dashboardSectionOrder';
/** Раздельные настройки режимов; старые ключи читаются только при первоначальном переносе. */
const PROMPT_DASHBOARD_LAYOUTS_KEY = 'promptManager.dashboardLayouts';
/** Настройки содержимого виджетов общие для обоих профилей ширины. */
const PROMPT_DASHBOARD_PREFERENCES_KEY = 'promptManager.dashboardPreferences';
const STATISTICS_UI_STATE_KEY = 'promptManager.statisticsUiState';

export class StateService {
	private static readonly GIT_OVERLAY_TRACKED_BRANCH_PREFERENCE_KEY = 'editor.gitOverlayTrackedBranchPreference';
	private static readonly GIT_OVERLAY_TRACKED_BRANCHES_BY_PROJECT_PREFERENCE_KEY = 'editor.gitOverlayTrackedBranchesByProjectPreference';
	private promptEditorViewStateMutationQueue: Promise<void> = Promise.resolve();
	private promptPlanViewModeMutationQueue: Promise<void> = Promise.resolve();
	/** Очередь экземпляра упорядочивает записи и перенос; независимые окна сохраняют отдельные статические поля. */
	private promptDashboardMutationQueue: Promise<void> = Promise.resolve();
	/** Подтверждённые значения скрывают незавершённый Configuration.update и сохраняются при ошибке записи. */
	private readonly promptUiConfirmedValues = new Map<string, unknown>();
	private readonly quickCommandSettings = new QuickCommandSettings(
		() => this.context.globalStorageUri.fsPath,
		key => vscode.workspace.getConfiguration('promptManager').inspect(key)?.globalValue,
		async (key, value) => { await vscode.workspace.getConfiguration('promptManager').update(key, value, vscode.ConfigurationTarget.Global); },
	);

	/** Normalize persisted global-context source and keep legacy workspaces predictable. */
	private static normalizeGlobalAgentContextSource(
		source: unknown,
		context: string,
	): GlobalAgentContextSource {
		const hasContext = context.trim().length > 0;
		if (!hasContext) {
			return 'empty';
		}

		return source === 'remote' ? 'remote' : 'manual';
	}

	constructor(private readonly context: vscode.ExtensionContext) { }

	private getPreferredWorkspaceStateDbPath(): string | null {
		const storageUriPath = this.context.storageUri?.fsPath;
		if (!storageUriPath) {
			return null;
		}
		return path.join(storageUriPath, '..', 'state.vscdb');
	}

	private getWorkspaceStateDbCandidates(): string[] {
		const candidates: string[] = [];

		const preferredPath = this.getPreferredWorkspaceStateDbPath();
		if (preferredPath) {
			candidates.push(preferredPath);
		}

		const home = os.homedir();
		if (process.platform === 'linux') {
			candidates.push(path.join(home, '.config', 'Code', 'User', 'workspaceStorage'));
		} else if (process.platform === 'darwin') {
			candidates.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'));
		} else if (process.platform === 'win32') {
			const appData = process.env.APPDATA || '';
			if (appData) {
				candidates.push(path.join(appData, 'Code', 'User', 'workspaceStorage'));
			}
		}

		return candidates;
	}

	private async resolveWorkspaceStateDbPaths(): Promise<string[]> {
		const candidates = this.getWorkspaceStateDbCandidates();
		const resolved = new Map<string, number>();

		for (const candidate of candidates) {
			if (candidate.endsWith('state.vscdb')) {
				try {
					const stat = await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
					resolved.set(candidate, stat.mtime);
				} catch {
					// continue
				}
				continue;
			}

			try {
				const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(candidate));
				for (const [name, type] of entries) {
					if (type !== vscode.FileType.Directory) {
						continue;
					}
					const dbPath = path.join(candidate, name, 'state.vscdb');
					try {
						const stat = await vscode.workspace.fs.stat(vscode.Uri.file(dbPath));
						resolved.set(dbPath, stat.mtime);
					} catch {
						// continue
					}
				}
			} catch {
				// continue
			}
		}

		const preferredPath = this.getPreferredWorkspaceStateDbPath();
		const preferredMtime = preferredPath ? resolved.get(preferredPath) : undefined;

		const ordered = Array.from(resolved.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([dbPath]) => dbPath);

		if (preferredPath && preferredMtime !== undefined) {
			return [
				preferredPath,
				...ordered.filter(dbPath => dbPath !== preferredPath),
			];
		}

		return ordered;
	}

	private scopeWorkspaceStateDbPathsToCurrentWorkspace(dbPaths: string[]): string[] {
		if (dbPaths.length === 0) {
			return [];
		}

		const preferredPath = this.getPreferredWorkspaceStateDbPath();
		if (!preferredPath) {
			return dbPaths;
		}

		return dbPaths.filter(dbPath => dbPath === preferredPath);
	}

	private getStateDbCandidates(): string[] {
		const home = os.homedir();
		if (process.platform === 'linux') {
			return [
				path.join(home, '.config', 'Code', 'User', 'globalStorage', 'state.vscdb'),
				path.join(home, '.config', 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb'),
				path.join(home, '.config', 'VSCodium', 'User', 'globalStorage', 'state.vscdb'),
			];
		}
		if (process.platform === 'darwin') {
			return [
				path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb'),
				path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb'),
				path.join(home, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage', 'state.vscdb'),
			];
		}
		if (process.platform === 'win32') {
			const appData = process.env.APPDATA || '';
			return [
				path.join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb'),
				path.join(appData, 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb'),
				path.join(appData, 'VSCodium', 'User', 'globalStorage', 'state.vscdb'),
			];
		}
		return [];
	}

	private async resolveStateDbPath(): Promise<string | null> {
		for (const candidate of this.getStateDbCandidates()) {
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
				return candidate;
			} catch {
				// continue
			}
		}
		return null;
	}

	private async resolveWorkspaceStateDbPath(): Promise<string | null> {
		const paths = this.scopeWorkspaceStateDbPathsToCurrentWorkspace(await this.resolveWorkspaceStateDbPaths());
		return paths[0] || null;
	}

	/** Читает индекс чат-сессий из read-only снимка `state.vscdb` workspace. */
	private async readChatSessionStoreIndex(dbPath: string): Promise<any | null> {
		try {
			const raw = (await this.readWorkspaceItemValue(dbPath, 'chat.ChatSessionStore.index')).trim();
			if (!raw) {
				return null;
			}
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}

	/** Read the latest request state from a chat session JSONL to avoid false completion from noisy index timing. */
	private static extractLatestChatRequestStateFromJsonl(raw: string): ChatSessionLatestRequestState | null {
		const requestStates = new Map<number, ChatSessionLatestRequestState>();

		const ensureRequestState = (requestIndex: number): ChatSessionLatestRequestState => {
			const existing = requestStates.get(requestIndex);
			if (existing) {
				return existing;
			}
			const created: ChatSessionLatestRequestState = { requestIndex };
			requestStates.set(requestIndex, created);
			return created;
		};

		const toOptionalNumber = (value: unknown): number | undefined => {
			const numeric = Number(value);
			return Number.isFinite(numeric) ? numeric : undefined;
		};

		for (const line of raw.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}

			let parsed: any;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue;
			}

			if (parsed?.kind === 0) {
				const requests = Array.isArray(parsed?.v?.requests) ? parsed.v.requests : [];
				for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
					const requestState = ensureRequestState(requestIndex);
					const request = requests[requestIndex] || {};
					requestState.requestModelState = toOptionalNumber(request?.modelState?.value ?? request?.modelState);
					if (Object.prototype.hasOwnProperty.call(request, 'result')) {
						requestState.hasRequestResult = request.result != null;
					}
				}
				continue;
			}

			const keyPath = Array.isArray(parsed?.k) ? parsed.k : null;
			if (!keyPath || keyPath[0] !== 'requests' || typeof keyPath[1] !== 'number' || keyPath.length < 3) {
				continue;
			}

			const requestState = ensureRequestState(keyPath[1]);
			if (keyPath[2] === 'result') {
				requestState.hasRequestResult = parsed?.v != null;
				continue;
			}

			if (keyPath[2] === 'modelState') {
				requestState.requestModelState = toOptionalNumber(parsed?.v?.value ?? parsed?.v);
			}
		}

		if (requestStates.size === 0) {
			return null;
		}

		return Array.from(requestStates.values())
			.sort((left, right) => right.requestIndex - left.requestIndex)[0] || null;
	}

	/** Read terminal request markers from the persisted chat session JSONL. */
	private async readLatestChatRequestState(sessionId: string): Promise<ChatSessionLatestRequestState | null> {
		const jsonlPath = await this.findChatSessionJsonlPath(sessionId);
		if (!jsonlPath) {
			return null;
		}

		try {
			const raw = await fs.readFile(jsonlPath, 'utf-8');
			return StateService.extractLatestChatRequestStateFromJsonl(raw);
		} catch {
			return null;
		}
	}

	/** Keep only sessions that started or still had request activity after the tracked start timestamp. */
	private static isChatSessionRelevantToReference(entry: any, referenceTimestampMs: number): boolean {
		const started = Number(entry?.timing?.lastRequestStarted || 0);
		const ended = Number(entry?.timing?.lastRequestEnded || 0);
		if (started <= 0) {
			return false;
		}

		if (started >= referenceTimestampMs) {
			return true;
		}

		return ended >= referenceTimestampMs;
	}

	/** When a session id is known, never silently fall back to another recent session. */
	private static selectRecentChatSessionCandidate(sessions: any[], sessionIdHint?: string): any | null {
		const normalizedHint = String(sessionIdHint || '').trim();
		if (!normalizedHint) {
			return sessions[0] || null;
		}

		return sessions.find((entry: any) => String(entry?.sessionId || '').trim() === normalizedHint) || null;
	}

	/** Pick an active chat session from workspace memento while skipping explicitly excluded sessions. */
	private static selectActiveChatSessionIdCandidate(parsed: any, excludedSessionIds?: Set<string>): string {
		const excluded = excludedSessionIds || new Set<string>();
		const direct = String(parsed?.sessionId || '').trim();
		if (direct && !excluded.has(direct)) {
			return direct;
		}

		const historyCopilot = Array.isArray(parsed?.history?.copilot) ? parsed.history.copilot : [];
		for (let index = historyCopilot.length - 1; index >= 0; index -= 1) {
			const candidate = String(historyCopilot[index]?.sessionId || '').trim();
			if (candidate && !excluded.has(candidate)) {
				return candidate;
			}
		}

		return '';
	}

	/**
	 * Читает значение `ItemTable` из снимка `state.vscdb` через sql.js.
	 * Рабочий файл VS Code не открывается как SQLite-БД, поэтому блокировки и запись исключены.
	 */
	private async readWorkspaceItemValue(dbPath: string, key: string): Promise<string> {
		const wasmPath = resolveBundledSqlJsWasmPath(this.context.extensionUri?.fsPath);
		if (!wasmPath) {
			return '';
		}

		try {
			return ((await readSqliteItemValueCached(dbPath, wasmPath, key)) ?? '').trim();
		} catch {
			return '';
		}
	}

	async getActiveChatSessionId(
		timeoutMs: number = 5000,
		pollIntervalMs: number = 250,
		options: { excludeSessionIds?: string[] } = {},
	): Promise<string> {
		const dbPaths = this.scopeWorkspaceStateDbPathsToCurrentWorkspace(await this.resolveWorkspaceStateDbPaths());
		if (dbPaths.length === 0) {
			return '';
		}
		const excludedSessionIds = new Set(
			(options.excludeSessionIds || [])
				.map(value => String(value || '').trim())
				.filter(Boolean),
		);

		const startedAt = Date.now();
		while (Date.now() - startedAt <= timeoutMs) {
			const keysToCheck = [
				'memento/interactive-session-view-copilot',
				'memento/interactive-session-view-agent',
				'memento/interactive-session',
			];

			for (const dbPath of dbPaths) {
				for (const key of keysToCheck) {
					const raw = await this.readWorkspaceItemValue(dbPath, key);
					if (!raw) {
						continue;
					}

					try {
						const parsed = JSON.parse(raw);
						const candidate = StateService.selectActiveChatSessionIdCandidate(parsed, excludedSessionIds);
						if (candidate) {
							return candidate;
						}
					} catch {
						// continue with next key
					}
				}
			}

			await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
		}

		return '';
	}

	private getRecentChatSessionsFromIndex(index: any, referenceTimestampMs: number): any[] {
		const entries = index?.entries as Record<string, any> | undefined;
		if (!entries || typeof entries !== 'object') {
			return [];
		}

		return Object.values(entries)
			.filter((entry: any) => StateService.isChatSessionRelevantToReference(entry, referenceTimestampMs))
			.sort((a: any, b: any) => Number(b?.timing?.lastRequestStarted || 0) - Number(a?.timing?.lastRequestStarted || 0));
	}

	private getTrackedChatSessionsFromIndex(index: any, sessionIds: string[]): any[] {
		const entries = index?.entries as Record<string, any> | undefined;
		if (!entries || typeof entries !== 'object') {
			return [];
		}

		const trackedSessionIds = new Set(
			sessionIds
				.map(value => String(value || '').trim())
				.filter(Boolean),
		);
		if (trackedSessionIds.size === 0) {
			return [];
		}

		return Object.values(entries)
			.filter((entry: any) => trackedSessionIds.has(String(entry?.sessionId || '').trim()))
			.sort((a: any, b: any) => Number(b?.timing?.lastRequestStarted || 0) - Number(a?.timing?.lastRequestStarted || 0));
	}

	async waitForChatSessionStarted(
		referenceTimestampMs: number,
		timeoutMs: number = 15000,
		pollIntervalMs: number = 500,
		sessionIdHint?: string,
	): Promise<{ ok: boolean; sessionId?: string; lastRequestStarted?: number; dbPath?: string; reason?: string }> {
		const dbPaths = this.scopeWorkspaceStateDbPathsToCurrentWorkspace(await this.resolveWorkspaceStateDbPaths());
		if (dbPaths.length === 0) {
			return { ok: false, reason: 'workspace-db-not-found' };
		}
		const normalizedHint = String(sessionIdHint || '').trim();

		const startedAt = Date.now();
		while (Date.now() - startedAt <= timeoutMs) {
			let current: any;
			let matchedDbPath = '';

			for (const dbPath of dbPaths) {
				const index = await this.readChatSessionStoreIndex(dbPath);
				const sessions = this.getRecentChatSessionsFromIndex(index, referenceTimestampMs);
				const candidate = StateService.selectRecentChatSessionCandidate(sessions, normalizedHint);
				if (!candidate) {
					continue;
				}
				const candidateStarted = Number(candidate?.timing?.lastRequestStarted || 0);
				const currentStarted = Number(current?.timing?.lastRequestStarted || 0);
				if (!current || candidateStarted > currentStarted) {
					current = candidate;
					matchedDbPath = dbPath;
				}
			}

			if (current) {
				const sessionId = String(current?.sessionId || '').trim();
				const lastRequestStarted = Number(current?.timing?.lastRequestStarted || 0);
				if (sessionId && lastRequestStarted > 0) {
					return { ok: true, sessionId, lastRequestStarted, dbPath: matchedDbPath };
				}
			}

			await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
		}

		return { ok: false, reason: 'timeout', dbPath: dbPaths[0] };
	}

	async hasChatSession(sessionId: string): Promise<boolean> {
		const target = (sessionId || '').trim();
		if (!target) {
			return false;
		}

		const dbPaths = this.scopeWorkspaceStateDbPathsToCurrentWorkspace(await this.resolveWorkspaceStateDbPaths());
		if (dbPaths.length === 0) {
			return false;
		}

		for (const dbPath of dbPaths) {
			const index = await this.readChatSessionStoreIndex(dbPath);
			const entries = index?.entries as Record<string, any> | undefined;
			if (!entries || typeof entries !== 'object') {
				continue;
			}
			if (Object.values(entries).some((entry: any) => String(entry?.sessionId || '') === target)) {
				return true;
			}
		}

		return false;
	}

	async waitForChatRequestCompletion(
		referenceTimestampMs: number,
		timeoutMs: number = 180000,
		pollIntervalMs: number = 1000,
		sessionIdHint?: string,
	): Promise<{
		ok: boolean;
		reason?: string;
		sessionId?: string;
		lastRequestStarted?: number;
		lastRequestEnded?: number;
		lastResponseState?: number;
		requestModelState?: number;
		hasRequestResult?: boolean;
		hasPendingEdits?: boolean;
		dbPath?: string;
	}> {
		const dbPaths = this.scopeWorkspaceStateDbPathsToCurrentWorkspace(await this.resolveWorkspaceStateDbPaths());
		if (dbPaths.length === 0) {
			return { ok: false, reason: 'workspace-db-not-found' };
		}
		const normalizedHint = String(sessionIdHint || '').trim();

		const startedAt = Date.now();
		let lastObservedSessionId = '';
		let lastObservedRequestStarted = 0;
		let lastObservedRequestEnded = 0;
		let lastObservedResponseState: number | undefined;
		let lastObservedRequestModelState: number | undefined;
		let lastObservedHasRequestResult: boolean | undefined;
		let lastObservedHasPendingEdits: boolean | undefined;
		let lastObservedDbPath = '';
		let stableCompletionCandidate: StableChatCompletionCandidate | null = null;
		const completionStableForMs = Math.max(1500, pollIntervalMs * 2);
		while (Date.now() - startedAt <= timeoutMs) {
			let current: any;
			let matchedDbPath = '';

			for (const dbPath of dbPaths) {
				const index = await this.readChatSessionStoreIndex(dbPath);
				const sessions = this.getRecentChatSessionsFromIndex(index, referenceTimestampMs);
				const candidate = StateService.selectRecentChatSessionCandidate(sessions, normalizedHint);
				if (!candidate) {
					continue;
				}
				const candidateStarted = Number(candidate?.timing?.lastRequestStarted || 0);
				const currentStarted = Number(current?.timing?.lastRequestStarted || 0);
				if (!current || candidateStarted > currentStarted) {
					current = candidate;
					matchedDbPath = dbPath;
				}
			}

			if (current) {
				const lastRequestStarted = Number(current?.timing?.lastRequestStarted || 0);
				const lastRequestEnded = Number(current?.timing?.lastRequestEnded || 0);
				const lastResponseState = Number(current?.lastResponseState ?? -1);
				const hasPendingEdits = Boolean(current?.hasPendingEdits);
				lastObservedSessionId = String(current?.sessionId || '').trim();
				const latestRequestState = lastObservedSessionId
					? await this.readLatestChatRequestState(lastObservedSessionId)
					: null;
				const requestModelState = latestRequestState?.requestModelState;
				const hasRequestResult = latestRequestState?.hasRequestResult;
				lastObservedRequestStarted = lastRequestStarted;
				lastObservedRequestEnded = lastRequestEnded;
				lastObservedResponseState = lastResponseState;
				lastObservedRequestModelState = requestModelState;
				lastObservedHasRequestResult = hasRequestResult;
				lastObservedHasPendingEdits = hasPendingEdits;
				lastObservedDbPath = matchedDbPath;
				const completionObservation = observeStableChatCompletion(
					stableCompletionCandidate,
					{
						sessionId: lastObservedSessionId,
						lastRequestStarted,
						lastRequestEnded,
						lastResponseState,
						requestModelState,
						hasRequestResult,
						hasPendingEdits,
					},
					Date.now(),
					completionStableForMs,
				);
				stableCompletionCandidate = completionObservation.candidate;

				if (completionObservation.completed) {
					return {
						ok: true,
						sessionId: String(current?.sessionId || ''),
						lastRequestStarted,
						lastRequestEnded,
						lastResponseState,
						requestModelState,
						hasRequestResult,
						hasPendingEdits,
						dbPath: matchedDbPath,
					};
				}
			} else {
				stableCompletionCandidate = null;
			}

			await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
		}

		return {
			ok: false,
			reason: 'timeout',
			sessionId: lastObservedSessionId || undefined,
			lastRequestStarted: lastObservedRequestStarted || undefined,
			lastRequestEnded: lastObservedRequestEnded || undefined,
			lastResponseState: lastObservedResponseState,
			requestModelState: lastObservedRequestModelState,
			hasRequestResult: lastObservedHasRequestResult,
			hasPendingEdits: lastObservedHasPendingEdits,
			dbPath: lastObservedDbPath || dbPaths[0],
		};
	}

	async getLatestTrackedChatRequestCompletion(
		sessionIds: string[],
	): Promise<{
		ok: boolean;
		reason?: string;
		sessionId?: string;
		lastRequestStarted?: number;
		lastRequestEnded?: number;
		lastResponseState?: number;
		requestModelState?: number;
		hasRequestResult?: boolean;
		hasPendingEdits?: boolean;
		dbPath?: string;
	}> {
		const normalizedSessionIds = Array.from(new Set(
			sessionIds
				.map(value => String(value || '').trim())
				.filter(Boolean),
		));
		if (normalizedSessionIds.length === 0) {
			return { ok: false, reason: 'session-id-not-provided' };
		}

		const dbPaths = this.scopeWorkspaceStateDbPathsToCurrentWorkspace(await this.resolveWorkspaceStateDbPaths());
		if (dbPaths.length === 0) {
			return { ok: false, reason: 'workspace-db-not-found' };
		}

		let current: any;
		let matchedDbPath = '';

		for (const dbPath of dbPaths) {
			const index = await this.readChatSessionStoreIndex(dbPath);
			const sessions = this.getTrackedChatSessionsFromIndex(index, normalizedSessionIds);
			const candidate = sessions[0];
			if (!candidate) {
				continue;
			}

			const candidateStarted = Number(candidate?.timing?.lastRequestStarted || 0);
			const currentStarted = Number(current?.timing?.lastRequestStarted || 0);
			if (!current || candidateStarted > currentStarted) {
				current = candidate;
				matchedDbPath = dbPath;
			}
		}

		if (!current) {
			return { ok: false, reason: 'session-not-found', dbPath: dbPaths[0] };
		}

		const sessionId = String(current?.sessionId || '').trim();
		const lastRequestStarted = Number(current?.timing?.lastRequestStarted || 0);
		const lastRequestEnded = Number(current?.timing?.lastRequestEnded || 0);
		const lastResponseState = Number(current?.lastResponseState ?? -1);
		const hasPendingEdits = Boolean(current?.hasPendingEdits);
		const latestRequestState = sessionId
			? await this.readLatestChatRequestState(sessionId)
			: null;
		const requestModelState = latestRequestState?.requestModelState;
		const hasRequestResult = latestRequestState?.hasRequestResult;
		const ok = isCompletedChatResponse({
			sessionId,
			lastRequestStarted,
			lastRequestEnded,
			lastResponseState,
			requestModelState,
			hasRequestResult,
			hasPendingEdits,
		});

		return {
			ok,
			...(ok ? {} : { reason: 'not-completed' }),
			sessionId: sessionId || undefined,
			lastRequestStarted: lastRequestStarted || undefined,
			lastRequestEnded: lastRequestEnded || undefined,
			lastResponseState,
			requestModelState,
			hasRequestResult,
			hasPendingEdits,
			dbPath: matchedDbPath || dbPaths[0],
		};
	}

	/**
	 * Extract total implementing time from a chat session JSONL file.
	 * Parses the JSONL, finds all requests and their result.timings.totalElapsed,
	 * and returns the sum (ms). Returns 0 if the file is not found or unreadable.
	 */
	async getChatSessionTotalElapsed(sessionId: string): Promise<number> {
		const normalizedId = (sessionId || '').trim();
		if (!normalizedId) {
			return 0;
		}
		const jsonlPath = await this.findChatSessionJsonlPath(normalizedId);
		if (!jsonlPath) {
			return 0;
		}

		try {
			const raw = await fs.readFile(jsonlPath, 'utf-8');
			let totalElapsed = 0;

			for (const line of raw.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				let obj: any;
				try {
					obj = JSON.parse(trimmed);
				} catch {
					continue;
				}

				const kind = obj?.kind;
				const k: any[] = obj?.k || [];
				const v = obj?.v;

				// kind=1 patch: ['requests', <index>, 'result'] → v.timings.totalElapsed
				if (kind === 1 && Array.isArray(k) && k.length === 3 && k[0] === 'requests' && k[2] === 'result') {
					const elapsed = Number(v?.timings?.totalElapsed || 0);
					if (elapsed > 0) {
						totalElapsed += elapsed;
					}
				}
			}

			return totalElapsed;
		} catch {
			return 0;
		}
	}

	/**
	 * Extract total implementing time from multiple chat sessions.
	 * Returns the sum of totalElapsed across all provided session IDs.
	 */
	async getChatSessionsTotalElapsed(sessionIds: string[]): Promise<number> {
		let total = 0;
		for (const sessionId of sessionIds) {
			total += await this.getChatSessionTotalElapsed(sessionId);
		}
		return total;
	}

	/**
	 * Find the JSONL file path for a given chat session ID.
	 */
	private async findChatSessionJsonlPath(sessionId: string): Promise<string | null> {
		const dbPaths = this.scopeWorkspaceStateDbPathsToCurrentWorkspace(await this.resolveWorkspaceStateDbPaths());

		for (const dbPath of dbPaths) {
			const candidate = path.join(path.dirname(dbPath), 'chatSessions', `${sessionId}.jsonl`);
			try {
				await fs.access(candidate);
				return candidate;
			} catch {
				// not in this workspace storage, try next
			}
		}

		// Also try via storageUri as fallback
		const storageUriPath = this.context.storageUri?.fsPath;
		if (storageUriPath) {
			const candidate = path.join(storageUriPath, '..', 'chatSessions', `${sessionId}.jsonl`);
			try {
				await fs.access(candidate);
				return candidate;
			} catch {
				// not found via storageUri either
			}
		}

		return null;
	}

	/**
	 * Rename a chat session by writing customTitle to its JSONL session file.
	 * Индекс сессий в `state.vscdb` не изменяется: прямая запись в рабочую БД VS Code
	 * конфликтует с её собственными транзакциями, а заголовок в UI обновляет вызывающий код.
	 */
	async renameChatSession(
		sessionId: string,
		newTitle: string,
	): Promise<{ ok: boolean; reason?: string }> {
		const normalizedId = (sessionId || '').trim();
		const normalizedTitle = (newTitle || '').trim();
		if (!normalizedId || !normalizedTitle) {
			return { ok: false, reason: 'empty-args' };
		}

		const jsonlPath = await this.findChatSessionJsonlPath(normalizedId);
		let jsonlReason = 'jsonl-not-found';
		let jsonlOk = false;
		if (jsonlPath) {
			// Append a kind:1 patch that sets customTitle on the session object.
			// VS Code's JSONL format: kind:0 = initial state, kind:1 = field patch
			const patch = JSON.stringify({ kind: 1, k: ['customTitle'], v: normalizedTitle });
			try {
				// Read last byte to avoid creating empty lines (double \n)
				const stat = await fs.stat(jsonlPath);
				let prefix = '\n';
				if (stat.size > 0) {
					const fd = await fs.open(jsonlPath, 'r');
					const buf = Buffer.alloc(1);
					await fd.read(buf, 0, 1, stat.size - 1);
					await fd.close();
					if (buf[0] === 0x0A) { // file already ends with \n
						prefix = '';
					}
				}
				await fs.appendFile(jsonlPath, prefix + patch + '\n');
				jsonlOk = true;
				jsonlReason = jsonlPath;
			} catch (error: any) {
				jsonlReason = error?.message || 'jsonl-write-failed';
			}
		}

		if (jsonlOk) {
			return { ok: true, reason: `jsonl:${jsonlReason}` };
		}

		return { ok: false, reason: jsonlReason };
	}

	/** Get saved sidebar state */
	getSidebarState(): SidebarState {
		const saved = this.context.workspaceState.get<SidebarState>(SIDEBAR_STATE_KEY);
		return normalizeSidebarState(saved);
	}

	/** Save sidebar state */
	async saveSidebarState(state: SidebarState): Promise<void> {
		await this.context.workspaceState.update(SIDEBAR_STATE_KEY, state);
	}

	/** Get last opened prompt id */
	getLastPromptId(): string | null {
		return this.context.workspaceState.get<string>(LAST_PROMPT_KEY) || null;
	}

	/** Save last opened prompt id */
	async saveLastPromptId(id: string): Promise<void> {
		await this.context.workspaceState.update(LAST_PROMPT_KEY, id);
	}

	/** Get persisted startup restore state for the prompt editor */
	getStartupEditorRestoreState(): { wasOpen: boolean; promptId: string | null } {
		return {
			wasOpen: this.context.workspaceState.get<boolean>(STARTUP_EDITOR_OPEN_KEY, false),
			promptId: this.context.workspaceState.get<string>(STARTUP_EDITOR_PROMPT_ID_KEY) || null,
		};
	}

	/** Save persisted startup restore state for the prompt editor */
	async saveStartupEditorRestoreState(wasOpen: boolean, promptId: string | null): Promise<void> {
		await Promise.all([
			this.context.workspaceState.update(STARTUP_EDITOR_OPEN_KEY, wasOpen),
			this.context.workspaceState.update(STARTUP_EDITOR_PROMPT_ID_KEY, promptId && promptId.trim() ? promptId.trim() : undefined),
		]);
	}

	/** Get global agent context */
	getGlobalAgentContext(): string {
		return this.context.workspaceState.get<string>(GLOBAL_AGENT_CONTEXT_KEY) || '';
	}

	/** Get the saved source for the shared agent context with a safe legacy fallback. */
	getGlobalAgentContextSource(): GlobalAgentContextSource {
		const context = this.getGlobalAgentContext();
		const storedSource = this.context.workspaceState.get<string>(GLOBAL_AGENT_CONTEXT_SOURCE_KEY);
		return StateService.normalizeGlobalAgentContextSource(storedSource, context);
	}

	/** Save global agent context together with its source metadata. */
	async saveGlobalAgentContext(context: string, source?: GlobalAgentContextSource): Promise<void> {
		const normalizedContext = typeof context === 'string' ? context : '';
		const normalizedSource = StateService.normalizeGlobalAgentContextSource(source, normalizedContext);
		await Promise.all([
			this.context.workspaceState.update(GLOBAL_AGENT_CONTEXT_KEY, normalizedContext),
			this.context.workspaceState.update(GLOBAL_AGENT_CONTEXT_SOURCE_KEY, normalizedSource),
		]);
	}

	/** Serialize mutations of the shared editor view-state map to avoid lost updates between async writes. */
	private async mutatePromptEditorViewStateStore(
		mutator: (current: Record<string, EditorPromptViewState>) => Record<string, EditorPromptViewState> | undefined,
	): Promise<void> {
		const applyMutation = async (): Promise<void> => {
			const current = this.context.workspaceState.get<Record<string, EditorPromptViewState>>(
				PROMPT_EDITOR_VIEW_STATE_KEY,
				{},
			);
			const next = mutator(current);
			await this.context.workspaceState.update(
				PROMPT_EDITOR_VIEW_STATE_KEY,
				next && Object.keys(next).length > 0 ? next : undefined,
			);
		};

		const pendingMutation = this.promptEditorViewStateMutationQueue.then(applyMutation, applyMutation);
		this.promptEditorViewStateMutationQueue = pendingMutation.catch(() => undefined);
		await pendingMutation;
	}

	/** Ждёт принятые dashboard-записи до bootstrap; отказ обрабатывает вызывающий save. Тесты: stateService.test.ts. */
	async waitForPromptDashboardSaves(): Promise<void> {
		// Во время записи могли поступить новые действия; снимок должен включать и их результат.
		let pending: Promise<void>;
		do {
			pending = this.promptDashboardMutationQueue;
			await pending;
		} while (pending !== this.promptDashboardMutationQueue);
	}

	/** Отличает отсутствие ключа от явного сброса null; tests/stateService.test.ts проверяет перенос между workspace. */
	private readPromptUiSetting<T>(key: string): T | null | undefined {
		if (this.promptUiConfirmedValues.has(key)) {
			return this.promptUiConfirmedValues.get(key) as T | null | undefined;
		}
		return vscode.workspace.getConfiguration('promptManager').inspect<T | null>(key)?.globalValue;
	}

	/** Успех публикуется после update; прежнее значение остаётся доступным при отказе записи. */
	private async writePromptUiSetting(key: string, value: unknown): Promise<void> {
		this.promptUiConfirmedValues.set(key, this.readPromptUiSetting(key));
		await vscode.workspace.getConfiguration('promptManager').update(key, value, vscode.ConfigurationTarget.Global);
		this.promptUiConfirmedValues.delete(key);
	}

	/** Восстанавливает логический объект, перекрывая legacy только присутствующими глобальными листьями. */
	private readPromptUiFields<T extends object>(
		prefix: string, fields: readonly (keyof T & string)[], fallback?: T,
	): Partial<T> | undefined {
		const result: Partial<T> = { ...fallback };
		let found = fallback !== undefined;
		for (const field of fields) {
			const value = this.readPromptUiSetting<T[typeof field]>(`${prefix}.${field}`);
			if (value !== undefined) {
				// Сброс убирает legacy-поле; доменный нормализатор затем выбирает default или отсутствие optional-поля.
				result[field] = value ?? undefined;
				found = true;
			}
		}
		return found ? result : undefined;
	}

	/** Записывает только изменённые листья; независимые поля не входят в одно конфигурационное update. */
	private async writePromptUiFields<T extends object>(
		prefix: string, fields: readonly (keyof T & string)[], next: T, base?: T,
	): Promise<void> {
		for (const field of fields) {
			if (base && JSON.stringify(base[field]) === JSON.stringify(next[field])) {
				continue;
			}
			await this.writePromptUiSetting(`${prefix}.${field}`, next[field] ?? null);
		}
	}

	/** Внешнее изменение после завершения очереди снимает защиту от предыдущего отказа. */
	invalidatePromptUiSettings(): void {
		this.promptUiConfirmedValues.clear();
	}

	/** Capture each delivered legacy list before broadcasts coalesce its rename and a subsequent re-add. */
	observeQuickCommandListChange(): void {
		if (!this.quickCommandSettings.needsBindingRefresh()) return;
		this.getPromptDashboardPreferences();
	}

	/** Единственная очередь сохраняет патч и недостающие legacy-поля; чтение/resize ничего не записывают. */
	private async mutatePromptUiSettings(
		mutation: () => Promise<void>,
		source?: EditorPromptViewStateKeySource,
		initialPreferences?: PromptDashboardPreferences,
	): Promise<void> {
		const apply = async (): Promise<void> => {
			// Частичный patch не должен подменять старые значения остальных полей значениями по умолчанию.
			const seeds = this.capturePromptUiMigrationSeeds(source, initialPreferences);
			await mutation();
			await this.migrateMissingPromptUiSettings(seeds);
		};
		const pending = this.promptDashboardMutationQueue.then(apply, apply);
		this.promptDashboardMutationQueue = pending.catch(() => undefined);
		await pending;
	}

	/** Снимает полный legacy-снимок до первой записи, включая ещё не изменённые флаги сворачивания. */
	private capturePromptUiMigrationSeeds(
		source?: EditorPromptViewStateKeySource,
		initialPreferences?: PromptDashboardPreferences,
	): Record<string, unknown> {
		const layout = this.getPromptEditorLayout();
		const dashboard = this.getPromptDashboardLayouts();
		const preferences = this.getPromptDashboardPreferences() ?? initialPreferences;
		const expanded = {
			...normalizePromptEditorMainExpanded(this.getPromptEditorViewState(source).expandedSections),
			...this.readPromptUiFields<NonNullable<PromptEditorLayout['mainExpandedSections']>>(
				'editor.mainExpandedSections', PROMPT_EDITOR_TAB_SECTIONS.main,
			),
		};
		const seeds: Record<string, unknown> = {
			'editor.sectionOrder.main': layout.main,
			'editor.sectionOrder.process': layout.process,
		};
		for (const section of PROMPT_EDITOR_TAB_SECTIONS.main) {
			seeds[`editor.mainExpandedSections.${section}`] = expanded[section];
		}
		for (const mode of ['single-column', 'two-columns'] as const) {
			const prefix = this.dashboardLayoutSettingPrefix(mode);
			seeds[`${prefix}.order`] = dashboard[mode].sectionOrder;
			for (const section of PROMPT_DASHBOARD_SECTION_KEYS) {
				seeds[`${prefix}.collapsed.${section}`] = dashboard[mode].collapsedSections[section] === true;
			}
		}
		// Отсутствующие preferences оставляют возможность переноса ещё не доставленного localStorage.
		if (preferences) {
			for (const field of PROMPT_DOCKER_SETTING_FIELDS) {
				// Отсутствующий optional viewMode тоже завершает перенос и не подхватывает режим другой рабочей области.
				seeds[`dashboardPreferences.docker.${field}`] = preferences.docker[field] ?? null;
			}
			for (const field of PROMPT_TODOS_SETTING_FIELDS) {
				seeds[`dashboardPreferences.todos.${field}`] = preferences.todos[field];
			}
			for (const field of PROMPT_QUICK_NOTES_SETTING_FIELDS) {
				seeds[`dashboardPreferences.quickNotes.${field}`] = preferences.quickNotes[field];
			}
			const commands = serializeDashboardQuickCommands(preferences.quickCommands);
			seeds[`${QUICK_COMMAND_PREFIX}.items`] = commands.items;
			for (const field of QUICK_COMMAND_METADATA_FIELDS) {
				if (Object.keys(commands[field]).length) seeds[`${QUICK_COMMAND_PREFIX}.${field}`] = commands[field];
			}
			seeds[`${QUICK_COMMAND_PREFIX}.target`] = commands.target;
			seeds[DASHBOARD_EXPANDED_SETTING] = preferences.expanded;
			for (const field of PROMPT_DASHBOARD_PREFERENCE_FIELDS) {
				seeds[`dashboardPreferences.${field}`] = preferences[field];
			}
		}
		return seeds;
	}

	/** Переносит отсутствующие листья, повторно проверяя Settings Sync перед каждой отдельной записью. */
	private async migrateMissingPromptUiSettings(seeds: Record<string, unknown>): Promise<void> {
		for (const [key, value] of Object.entries(seeds)) {
			if (value === undefined || this.readPromptUiSetting(key) !== undefined) continue;
			if (key === DASHBOARD_EXPANDED_SETTING) {
				// An explicit toggle can arrive after capture, before this legacy seed reaches the profile.
				await this.withDashboardMapLock(async read => {
					if (read(key) === undefined) await this.writePromptUiSetting(key, value);
				});
			} else {
				await this.writePromptUiSetting(key, value);
			}
		}
	}

	/** Порядок глобален на обеих вкладках, раскрытие — только для main; доля ширины общая для всех промптов. */
	getPromptEditorLayout(): PromptEditorLayout {
		return normalizePromptEditorLayout({
			main: this.readPromptUiSetting<PromptEditorLayout['main']>('editor.sectionOrder.main') ?? undefined,
			process: this.readPromptUiSetting<PromptEditorLayout['process']>('editor.sectionOrder.process') ?? undefined,
			mainExpandedSections: this.readPromptUiFields<NonNullable<PromptEditorLayout['mainExpandedSections']>>(
				'editor.mainExpandedSections', PROMPT_EDITOR_TAB_SECTIONS.main,
			),
			// Отсутствие ключа остаётся отсутствием, явный null — автоматической шириной после сброса.
			panelSplitRatio: this.readPromptUiSetting<number>('editor.panelSplitRatio'),
		});
	}

	/** Применяет изменение формы относительно снимка webview без записи состояния Process. */
	async savePromptEditorLayout(
		state: PromptEditorLayout,
		baseState?: PromptEditorLayout,
		source?: EditorPromptViewStateKeySource,
	): Promise<void> {
		const next = normalizePromptEditorLayout(state);
		const base = baseState ? normalizePromptEditorLayout(baseState) : undefined;
		await this.mutatePromptUiSettings(async () => {
			for (const field of ['main', 'process'] as const) {
				if (base && JSON.stringify(next[field]) === JSON.stringify(base[field])) {
					continue;
				}
				await this.writePromptUiSetting(`editor.sectionOrder.${field}`, next[field]);
			}
			if (next.mainExpandedSections) {
				await this.writePromptUiFields('editor.mainExpandedSections', PROMPT_EDITOR_TAB_SECTIONS.main,
					next.mainExpandedSections, base?.mainExpandedSections);
			}
			// Старые сообщения без доли и чужие правки формы не сбрасывают выбранную ширину.
			if (next.panelSplitRatio !== undefined
				&& (!base || (base.panelSplitRatio ?? null) !== next.panelSplitRatio)) {
				await this.writePromptUiSetting('editor.panelSplitRatio', next.panelSplitRatio);
			}
		}, source);
	}

	/** Префикс настроек режима не зависит от текущей рабочей области. */
	private dashboardLayoutSettingPrefix(mode: PromptDashboardLayoutMode): string {
		return `dashboardLayouts.${mode === 'single-column' ? 'singleColumn' : 'twoColumns'}`;
	}

	/** Читает пользовательские режимы с fallback на прежние workspace-профили. */
	getPromptDashboardLayouts(): PromptDashboardLayouts {
		const legacy = normalizePromptDashboardLayouts(
			this.context.workspaceState.get(PROMPT_DASHBOARD_LAYOUTS_KEY),
			this.context.workspaceState.get(PROMPT_DASHBOARD_SECTION_ORDER_KEY),
			this.context.workspaceState.get<PromptDashboardCollapsedSections>(PROMPT_DASHBOARD_COLLAPSED_SECTIONS_KEY),
		);
		for (const mode of ['single-column', 'two-columns'] as const) {
			const prefix = this.dashboardLayoutSettingPrefix(mode);
			// Явный null сбрасывает порядок к default; только отсутствующий ключ разрешает workspace-fallback.
			const order = this.readPromptUiSetting(`${prefix}.order`);
			legacy[mode] = {
				sectionOrder: normalizePromptDashboardSectionOrder(order === undefined ? legacy[mode].sectionOrder : order, mode),
				collapsedSections: normalizePromptDashboardCollapsedSections(this.readPromptUiFields(
					`${prefix}.collapsed`, PROMPT_DASHBOARD_SECTION_KEYS, legacy[mode].collapsedSections,
				)),
			};
		}
		return legacy;
	}

	/** Возвращает сворачивание только выбранного режима. */
	getPromptDashboardCollapsedSections(mode: PromptDashboardLayoutMode = 'two-columns'): PromptDashboardCollapsedSections {
		return this.getPromptDashboardLayouts()[mode].collapsedSections;
	}

	/** Пустая карта означает раскрытие всех карточек и не возвращает прежние workspace-флаги. */
	async savePromptDashboardCollapsedSections(
		state: PromptDashboardCollapsedSections,
		mode: PromptDashboardLayoutMode = 'two-columns',
		baseState?: PromptDashboardCollapsedSections,
		source?: EditorPromptViewStateKeySource,
	): Promise<void> {
		const next = normalizePromptDashboardCollapsedSections(state);
		const base = baseState === undefined ? undefined : normalizePromptDashboardCollapsedSections(baseState);
		await this.mutatePromptUiSettings(async () => {
			for (const section of PROMPT_DASHBOARD_SECTION_KEYS) {
				const collapsed = next[section] === true;
				if (base && (base[section] === true) === collapsed) {
					continue;
				}
				// Явный false перекрывает legacy true, хотя внешний контракт хранит только свёрнутые разделы.
				await this.writePromptUiSetting(`${this.dashboardLayoutSettingPrefix(mode)}.collapsed.${section}`, collapsed);
			}
		}, source);
	}

	/** Возвращает порядок карточек только выбранного режима. */
	getPromptDashboardSectionOrder(mode: PromptDashboardLayoutMode = 'two-columns'): PromptDashboardSectionOrder {
		return this.getPromptDashboardLayouts()[mode].sectionOrder;
	}

	/** Сохраняет перестановку отдельно от сворачивания и настроек другой ширины. */
	async savePromptDashboardSectionOrder(
		order: PromptDashboardSectionOrder,
		mode: PromptDashboardLayoutMode = 'two-columns',
		source?: EditorPromptViewStateKeySource,
	): Promise<void> {
		const next = normalizePromptDashboardSectionOrder(order, mode);
		await this.mutatePromptUiSettings(
			() => this.writePromptUiSetting(`${this.dashboardLayoutSettingPrefix(mode)}.order`, next), source,
		);
	}

	/** Отсутствие любого нового и workspace-значения разрешает legacy-перенос из webview. */
	getPromptDashboardPreferences(): PromptDashboardPreferences | undefined {
		const saved = this.context.workspaceState.get<PromptDashboardPreferences>(PROMPT_DASHBOARD_PREFERENCES_KEY);
		const legacy = saved === undefined ? undefined : normalizePromptDashboardPreferences(saved);
		const next: Partial<PromptDashboardPreferences> = {};
		const docker = this.readPromptUiFields<PromptDashboardPreferences['docker']>(
			'dashboardPreferences.docker', PROMPT_DOCKER_SETTING_FIELDS, legacy?.docker,
		);
		const todos = this.readPromptUiFields<PromptDashboardPreferences['todos']>(
			'dashboardPreferences.todos', PROMPT_TODOS_SETTING_FIELDS, legacy?.todos,
		);
		const quickNotes = this.readPromptUiFields<PromptDashboardPreferences['quickNotes']>(
			'dashboardPreferences.quickNotes', PROMPT_QUICK_NOTES_SETTING_FIELDS, legacy?.quickNotes,
		);
		const quickCommands = this.quickCommandSettings.readCommands(this.readPromptUiFields<DashboardQuickCommandsConfiguration>(
			QUICK_COMMAND_PREFIX, PROMPT_QUICK_COMMANDS_SETTING_FIELDS,
			legacy && serializeDashboardQuickCommands(legacy.quickCommands),
		));
		for (const field of [...PROMPT_DASHBOARD_PREFERENCE_FIELDS, ...DASHBOARD_MAP_FIELDS]) {
			const value = this.readPromptUiSetting(`dashboardPreferences.${field}`);
			if (value !== undefined) {
				Object.assign(next, { [field]: value });
			}
		}
		return !legacy && !docker && !todos && !quickNotes && !quickCommands && Object.keys(next).length === 0 ? undefined
			: normalizePromptDashboardPreferences({ ...legacy, ...next, docker, todos, quickNotes, quickCommands });
	}

	/** Commit only a modal's row against current settings; the optional seed migrates previously local webview data. */
	async saveDashboardQuickCommand(edit: DashboardQuickCommandEdit, migration?: PromptDashboardPreferences, source?: EditorPromptViewStateKeySource): Promise<void> {
		const fallback = normalizePromptDashboardPreferences(migration);
		await this.mutatePromptUiSettings(() => this.quickCommandSettings.edit(edit,
			() => this.getPromptDashboardPreferences()?.quickCommands ?? fallback.quickCommands), source, fallback);
	}

	/** Read and write a whole settings map while other windows of the profile wait for their turn. */
	private async withDashboardMapLock(update: (read: (key: string) => unknown) => Promise<void>): Promise<void> {
		const directory = this.context.globalStorageUri.fsPath;
		await fs.mkdir(directory, { recursive: true });
		const release = await lock(directory, {
			lockfilePath: path.join(directory, 'dashboard-map-settings.lock'),
			retries: { retries: 12, minTimeout: 25, maxTimeout: 250 },
		});
		try {
			const configuration = () => vscode.workspace.getConfiguration('promptManager');
			const read = (key: string) => configuration().inspect(key)?.globalValue;
			await refreshUserSettingsSnapshot(DASHBOARD_MAP_READ_TOKEN, read,
				async (key, value) => { await configuration().update(key, value, vscode.ConfigurationTarget.Global); },
				'Настройки панели «Обзор» ещё обновляются в этом окне.');
			await update(read);
		} finally {
			await release();
		}
	}

	/** Merge per-key changes into a fresh snapshot. An explicit full save replaces the legacy disclosure map. */
	private async saveDashboardMaps(next: PromptDashboardPreferences, base?: PromptDashboardPreferences): Promise<void> {
		const fields = DASHBOARD_MAP_FIELDS.filter(field => (field === 'expanded' && !base)
			|| JSON.stringify(next[field]) !== JSON.stringify(base?.[field] ?? {}));
		if (!fields.length) return;
		await this.withDashboardMapLock(async read => {
			for (const field of fields) {
				const key = `dashboardPreferences.${field}`;
				const raw = read(key);
				// A first folder toggle migrates remaining disclosures. An explicit global null overrides the legacy map.
				const stored = raw === undefined && field === 'expanded'
					? this.context.workspaceState.get<PromptDashboardPreferences>(PROMPT_DASHBOARD_PREFERENCES_KEY)?.expanded
						?? base?.expanded : raw;
				const current = normalizePromptDashboardPreferences({ [field]: stored })[field];
				const previous = base?.[field] ?? (field === 'expanded' ? undefined : {});
				await this.writePromptUiSetting(key, applyUiSettingsChanges(current, next[field], previous));
			}
		});
	}

	/** Адресный патч preferences сохраняет параллельные изменения других полей и явный false. */
	async savePromptDashboardPreferences(
		state: PromptDashboardPreferences,
		baseState?: PromptDashboardPreferences,
		source?: EditorPromptViewStateKeySource,
	): Promise<void> {
		const next = normalizePromptDashboardPreferences(state);
		const base = baseState ? normalizePromptDashboardPreferences(baseState) : undefined;
		await this.mutatePromptUiSettings(async () => {
			await this.writePromptUiFields('dashboardPreferences.docker', PROMPT_DOCKER_SETTING_FIELDS, next.docker, base?.docker);
			await this.writePromptUiFields('dashboardPreferences.todos', PROMPT_TODOS_SETTING_FIELDS, next.todos, base?.todos);
			await this.writePromptUiFields(
				'dashboardPreferences.quickNotes', PROMPT_QUICK_NOTES_SETTING_FIELDS, next.quickNotes, base?.quickNotes,
			);
			await this.quickCommandSettings.save(next.quickCommands, base?.quickCommands,
				() => this.getPromptDashboardPreferences()?.quickCommands ?? next.quickCommands);
			await this.writePromptUiFields(QUICK_COMMAND_PREFIX, ['target'], next.quickCommands, base?.quickCommands);
			await this.saveDashboardMaps(next, base);
			for (const field of PROMPT_DASHBOARD_PREFERENCE_FIELDS) {
				if (base && JSON.stringify(base[field]) === JSON.stringify(next[field])) {
					continue;
				}
				const current = this.getPromptDashboardPreferences() ?? normalizePromptDashboardPreferences(undefined);
				const merged = applyUiSettingsChanges(current[field], next[field], base?.[field]);
				await this.writePromptUiSetting(`dashboardPreferences.${field}`, merged);
			}
		}, source, next);
	}

	/** Restores only an explicitly selected plan mode; legacy states retain their original default. */
	getPromptPlanViewMode(source?: EditorPromptViewStateKeySource | null): EditorPromptPlanViewMode | null {
		const saved = this.context.workspaceState.get<Record<string, unknown>>(PROMPT_EDITOR_PLAN_MODE_KEY, {});
		for (const key of getEditorPromptPlanViewModeKeys(source)) {
			const mode = saved[key];
			if (mode === 'compact' || mode === 'full') {
				return mode;
			}
		}
		return null;
	}

	/** Writes only the plan mode, without rewriting other editor view-state fields. */
	async savePromptPlanViewMode(
		source: EditorPromptViewStateKeySource | null | undefined,
		mode: EditorPromptPlanViewMode,
	): Promise<void> {
		const key = getEditorPromptPlanViewModeKeys(source)[0];
		if (!key || (mode !== 'compact' && mode !== 'full')) {
			return;
		}
		await this.mutatePromptPlanViewModeStore(current => ({ ...current, [key]: mode }));
	}

	/** Последовательно изменяет карту режимов плана, чтобы выбор и перенос при переименовании не теряли записи. */
	private async mutatePromptPlanViewModeStore(
		mutator: (current: Record<string, unknown>) => Record<string, unknown>,
	): Promise<void> {
		const write = async (): Promise<void> => {
			const current = this.context.workspaceState.get<Record<string, unknown>>(PROMPT_EDITOR_PLAN_MODE_KEY, {});
			const next = mutator(current);
			// Перенос вызывается при каждом сохранении промпта; без изменений запись в workspaceState не нужна.
			if (JSON.stringify(next) === JSON.stringify(current)) {
				return;
			}
			await this.context.workspaceState.update(
				PROMPT_EDITOR_PLAN_MODE_KEY,
				Object.keys(next).length > 0 ? next : undefined,
			);
		};
		const pending = this.promptPlanViewModeMutationQueue.then(write, write);
		this.promptPlanViewModeMutationQueue = pending.catch(() => undefined);
		await pending;
	}

	getPromptEditorViewState(source?: EditorPromptViewStateKeySource | null): EditorPromptViewState {
		const saved = this.context.workspaceState.get<Record<string, EditorPromptViewState>>(PROMPT_EDITOR_VIEW_STATE_KEY, {});
		const chosenMode = this.getPromptPlanViewMode(source);
		for (const key of getEditorPromptViewStateStorageKeys(source)) {
			const state = saved[key];
			if (state) {
				const normalized = normalizeEditorPromptViewState(state);
				return chosenMode ? { ...normalized, planViewMode: chosenMode } : normalized;
			}
		}
		const defaults = createDefaultEditorPromptViewState();
		return chosenMode ? { ...defaults, planViewMode: chosenMode } : defaults;
	}

	async savePromptEditorViewState(
		source: EditorPromptViewStateKeySource | null | undefined,
		state: EditorPromptViewState,
	): Promise<void> {
		const key = resolveEditorPromptViewStateStorageKey(source);
		if (!key) {
			return;
		}

		await this.mutatePromptEditorViewStateStore(current => ({
			...current,
			[key]: normalizeEditorPromptViewState(state),
		}));
	}

	/** Переносит состояние редактора и выбранный режим плана на новый ключ после первого сохранения или переименования. */
	async migratePromptEditorViewState(
		fromSources: Array<EditorPromptViewStateKeySource | null | undefined>,
		toSource: EditorPromptViewStateKeySource | null | undefined,
	): Promise<void> {
		await Promise.all([
			this.mutatePromptEditorViewStateStore(current => moveEditorPromptViewStateEntries(current, fromSources, toSource)),
			this.mutatePromptPlanViewModeStore(current => moveEditorPromptPlanViewModeEntries(current, fromSources, toSource)),
		]);
	}

	getGitOverlayTrackedBranchPreference(): string {
		return (this.context.workspaceState.get<string>(StateService.GIT_OVERLAY_TRACKED_BRANCH_PREFERENCE_KEY) || '').trim();
	}

	getGitOverlayTrackedBranchesByProjectPreference(): Record<string, string> {
		const stored = this.context.workspaceState.get<Record<string, string>>(
			StateService.GIT_OVERLAY_TRACKED_BRANCHES_BY_PROJECT_PREFERENCE_KEY,
			{},
		);
		const result: Record<string, string> = {};

		for (const [project, branch] of Object.entries(stored || {})) {
			const normalizedProject = project.trim();
			const normalizedBranch = typeof branch === 'string' ? branch.trim() : '';
			if (!normalizedProject || !normalizedBranch) {
				continue;
			}
			result[normalizedProject] = normalizedBranch;
		}

		return result;
	}

	async saveGitOverlayTrackedBranchPreference(branch: string, branchesByProject?: Record<string, string>): Promise<void> {
		const normalized = (branch || '').trim();
		const currentBranchesByProject = this.getGitOverlayTrackedBranchesByProjectPreference();
		const nextBranchesByProject: Record<string, string> = {
			...currentBranchesByProject,
		};

		for (const [project, projectBranch] of Object.entries(branchesByProject || {})) {
			const normalizedProject = project.trim();
			const normalizedProjectBranch = typeof projectBranch === 'string' ? projectBranch.trim() : '';
			if (!normalizedProject) {
				continue;
			}

			if (!normalizedProjectBranch) {
				delete nextBranchesByProject[normalizedProject];
				continue;
			}

			nextBranchesByProject[normalizedProject] = normalizedProjectBranch;
		}

		await this.context.workspaceState.update(
			StateService.GIT_OVERLAY_TRACKED_BRANCH_PREFERENCE_KEY,
			normalized || undefined,
		);
		await this.context.workspaceState.update(
			StateService.GIT_OVERLAY_TRACKED_BRANCHES_BY_PROJECT_PREFERENCE_KEY,
			Object.keys(nextBranchesByProject).length > 0 ? nextBranchesByProject : undefined,
		);
	}

	getStatisticsUiState(): { hourlyRateInput: string } {
		const saved = this.context.workspaceState.get<Record<string, unknown>>(STATISTICS_UI_STATE_KEY, {});
		return {
			hourlyRateInput: typeof saved?.hourlyRateInput === 'string' ? saved.hourlyRateInput : '',
		};
	}

	async saveStatisticsUiState(state: { hourlyRateInput: string }): Promise<void> {
		await this.context.workspaceState.update(STATISTICS_UI_STATE_KEY, {
			hourlyRateInput: typeof state.hourlyRateInput === 'string' ? state.hourlyRateInput : '',
		});
	}

	/** Generic get */
	get<T>(key: string, defaultValue: T): T {
		return this.context.workspaceState.get<T>(key, defaultValue);
	}

	/** Generic set */
	async set<T>(key: string, value: T): Promise<void> {
		await this.context.workspaceState.update(key, value);
	}
}
