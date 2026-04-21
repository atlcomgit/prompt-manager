/**
 * Copilot Usage Service — получает данные об использовании GitHub Copilot Premium запросов.
 *
 * Использует GitHub REST API для получения информации о подписке и использовании.
 * Поддерживает кэширование, персистентность состояния, и fallback на локальное отслеживание.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { appendPromptManagerLog } from '../utils/promptManagerOutput.js';
import { readSqliteItemTable } from '../utils/sqliteItemTable.js';

const execFileAsync = promisify(execFile);

/** Данные об использовании Copilot Premium запросов */
export interface CopilotUsageData {
	/** Количество использованных запросов за текущий период */
	used: number;
	/** Общий лимит запросов за текущий период */
	limit: number;
	/** Дата начала текущего периода (ISO 8601) */
	periodStart: string;
	/** Дата окончания текущего периода (ISO 8601) */
	periodEnd: string;
	/** Дата и время последнего обновления данных (ISO 8601) */
	lastUpdated: string;
	/** Среднее количество запросов в день за текущий период */
	avgPerDay: number;
	/** Авторизован ли пользователь */
	authenticated: boolean;
	/** Тип подписки (free, pro, business, enterprise, unknown) */
	planType: string;
	/** Источник данных (api, inferred, local) */
	source: 'api' | 'inferred' | 'local';
	/** Диагностический статус последней синхронизации */
	lastSyncStatus?: string;
	/** История снапшотов usage для графиков */
	snapshots: Array<{ date: string; used: number; limit: number }>;
}

export interface CopilotUsageAccountSummary {
	copilotPreferredGitHubLabel: string | null;
	promptManagerPreferredGitHubLabel: string | null;
	activeGithubSessionAccountLabel: string | null;
	githubSessionIssue: string | null;
	availableGitHubAccounts: Array<{ id: string; label: string }>;
}

export type CopilotAccountSwitchPhase =
	| 'idle'
	| 'detected'
	| 'syncing-extension'
	| 'awaiting-session'
	| 'refreshing-usage'
	| 'completed'
	| 'error';

export interface CopilotAccountSwitchState {
	isSwitching: boolean;
	phase: CopilotAccountSwitchPhase;
	message: string;
	accountLabel: string | null;
	startedAt: string | null;
	updatedAt: string;
}

export interface CopilotAccountSwitchInteractiveResult {
	changed: boolean;
	cancelled?: boolean;
	message: string;
	accountLabel?: string;
}

export interface CopilotUsageSnapshot {
	usage: CopilotUsageData;
	accountSummary: CopilotUsageAccountSummary;
	debugLog: string;
	switchState: CopilotAccountSwitchState;
}

export interface CopilotAccountSwitchCompletionResult extends CopilotUsageSnapshot {
	accountLabel: string;
	message: string;
}

/** Результат чтения usage-метрик или явной ошибки авторизации GitHub API. */
type CopilotUsageMetricsFetchResult =
	| {
		kind: 'metrics';
		used: number;
		limit: number;
		source: 'api' | 'inferred';
		planType?: string;
		snapshots?: Array<{ date: string; used: number; limit: number }>;
		statusText: string;
	}
	| {
		kind: 'auth-error';
		statusText: string;
	};

/** Ключи для хранения состояния в globalState */
const STATE_KEY_USAGE = 'promptManager.copilotUsage';

/** Интервал автоматического обновления данных (5 минут) */
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Минимальный интервал между запросами к API (30 секунд) */
const MIN_API_CALL_INTERVAL_MS = 30 * 1000;
const MIN_FULL_REFRESH_INTERVAL_MS = 30 * 1000;
const LAST_CHAT_ACTIVITY_KEY = 'promptManager.copilotUsage.lastChatActivity';
const CHAT_REQUESTS_BASE_TOTAL_KEY = 'promptManager.copilotUsage.chatRequestsBaseTotal';
const CHAT_REQUESTS_BASE_USED_KEY = 'promptManager.copilotUsage.chatRequestsBaseUsed';
const GITHUB_AUTH_PROVIDER_ID = 'github';
const COPILOT_CHAT_AUTH_PROVIDER_ID = '__GitHub.copilot-chat';
const COPILOT_GITHUB_PREFERENCE_KEYS = ['github.copilot-github', 'github.copilot-chat-github'];
const PROMPT_MANAGER_GITHUB_PREFERENCE_KEY = 'alek-fiend.copilot-prompt-manager-github';
const PROMPT_MANAGER_GITHUB_PREFERENCE_FALLBACK_STATE_KEY = 'promptManager.copilotUsage.githubPreference';
const COPILOT_CHAT_GITHUB_USAGE_EXTENSION_IDS = ['github.copilot-chat', 'github.copilot'];
const ACCOUNT_SWITCH_DETECTION_INTERVAL_MS = 500;
const ACCOUNT_SWITCH_DETECTION_MAX_ATTEMPTS = 60;
const ACCOUNT_SWITCH_SESSION_INTERVAL_MS = 500;
const ACCOUNT_SWITCH_SESSION_MAX_ATTEMPTS = 24;
const ACCOUNT_SWITCH_USAGE_INTERVAL_MS = 1_000;
const ACCOUNT_SWITCH_USAGE_MAX_ATTEMPTS = 10;

export class CopilotUsageService implements vscode.Disposable {
	/** Событие обновления данных об использовании */
	private readonly _onDidChangeUsage = new vscode.EventEmitter<CopilotUsageData>();
	readonly onDidChangeUsage = this._onDidChangeUsage.event;
	private readonly _onDidChangeAccountSwitchState = new vscode.EventEmitter<CopilotAccountSwitchState>();
	readonly onDidChangeAccountSwitchState = this._onDidChangeAccountSwitchState.event;
	private readonly disposables: vscode.Disposable[] = [];

	/** Таймер автоматического обновления */
	private autoRefreshTimer: ReturnType<typeof setInterval> | undefined;

	/** Кэш последних данных об использовании */
	private cachedData: CopilotUsageData | null = null;

	/** Временная метка последнего API-вызова */
	private lastApiCallTimestamp = 0;

	/** Флаг выполнения запроса */
	private isFetching = false;
	private lastKnownAuthenticated = false;
	private lastDebugLog = '';
	private lastFullRefreshTimestamp = 0;
	private lastKnownCopilotGitHubPreference: string | null | undefined;
	/** In-memory кэш PM preference — fallback при недоступной DB (state.vscdb заблокирован) */
	private lastSyncedPmPreference: string | null = null;
	private lastGitHubSessionIssue: string | null = null;
	private copilotPreferencePollingTimer: ReturnType<typeof setInterval> | undefined;
	private isSwitchingAccount = false;
	/** Когда пользователь явно выбрал аккаунт — не перезаписывать автоматически из Copilot Chat */
	private userExplicitAccountChoice: string | null = null;
	private readonly stateDbItemCache = new Map<string, { fingerprint: string; items: Map<string, string> }>();
	private accountSwitchState: CopilotAccountSwitchState = {
		isSwitching: false,
		phase: 'idle',
		message: '',
		accountLabel: null,
		startedAt: null,
		updatedAt: new Date().toISOString(),
	};
	private readonly pendingAuthSessionProviderIds = new Set<string>();
	private interactiveSwitchRequestId = 0;

	private isDebugVerbose(): boolean {
		const config = vscode.workspace.getConfiguration('promptManager');
		return config.get<boolean>('copilotUsage.debugVerbose', false);
	}

	private formatDebugLog(lines: string[]): string {
		if (this.isDebugVerbose()) {
			return lines.join('\n');
		}

		const keepPrefixes = ['[fetch]', '[cache]', '[api]', '[result]', '[status]', '[auth]'];
		const compact = lines.filter((line) => keepPrefixes.some((prefix) => line.startsWith(prefix)));
		return compact.join('\n');
	}

	private async delay(ms: number): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, ms));
	}

	private normalizeAccountLabel(accountLabel: string | null | undefined): string | null {
		const normalized = typeof accountLabel === 'string' ? accountLabel.trim() : '';
		return normalized || null;
	}

	private isExpectedAccountLabel(currentLabel: string | null | undefined, expectedLabel: string | null | undefined): boolean {
		const normalizedCurrent = this.normalizeAccountLabel(currentLabel);
		const normalizedExpected = this.normalizeAccountLabel(expectedLabel);
		if (!normalizedCurrent || !normalizedExpected) {
			return false;
		}

		return normalizedCurrent.toLowerCase() === normalizedExpected.toLowerCase();
	}

	private emitAccountSwitchState(state: CopilotAccountSwitchState): void {
		this.accountSwitchState = { ...state };
		appendPromptManagerLog(
			`[${state.updatedAt}] [switch-state] isSwitching=${state.isSwitching} phase=${state.phase} account=${state.accountLabel || 'none'} message=${state.message || 'none'}`,
		);
		this._onDidChangeAccountSwitchState.fire({ ...state });
	}

	private beginAccountSwitching(accountLabel: string, message: string): void {
		const timestamp = new Date().toISOString();
		this.isSwitchingAccount = true;
		this.emitAccountSwitchState({
			isSwitching: true,
			phase: 'detected',
			message,
			accountLabel: this.normalizeAccountLabel(accountLabel),
			startedAt: timestamp,
			updatedAt: timestamp,
		});
	}

	private updateAccountSwitchProgress(phase: CopilotAccountSwitchPhase, message: string, accountLabel?: string | null): void {
		if (!this.isSwitchingAccount) {
			return;
		}

		const timestamp = new Date().toISOString();
		this.emitAccountSwitchState({
			isSwitching: true,
			phase,
			message,
			accountLabel: this.normalizeAccountLabel(accountLabel ?? this.accountSwitchState.accountLabel),
			startedAt: this.accountSwitchState.startedAt || timestamp,
			updatedAt: timestamp,
		});
	}

	private flushPendingAuthenticationSessionChanges(): void {
		if (this.pendingAuthSessionProviderIds.size === 0) {
			return;
		}

		const providerIds = Array.from(this.pendingAuthSessionProviderIds);
		this.pendingAuthSessionProviderIds.clear();
		appendPromptManagerLog(
			`[${new Date().toISOString()}] [auth-event] flushing deferred providers: ${providerIds.join(', ')}`,
		);
		for (const providerId of providerIds) {
			void this.handleAuthenticationSessionsChanged(providerId);
		}
	}

	private async waitForFetchToFinish(timeoutMs: number): Promise<void> {
		const startedAt = Date.now();
		while (this.isFetching && (Date.now() - startedAt) < timeoutMs) {
			await this.delay(100);
		}
	}

	private async safelyGetGitHubAccounts(): Promise<readonly vscode.AuthenticationSessionAccountInformation[]> {
		try {
			return await vscode.authentication.getAccounts(GITHUB_AUTH_PROVIDER_ID);
		} catch {
			return [];
		}
	}

	getAccountSwitchState(): CopilotAccountSwitchState {
		return { ...this.accountSwitchState };
	}

	private getGlobalStateDbCandidates(): string[] {
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
			if (!appData) {
				return [];
			}
			return [
				path.join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb'),
				path.join(appData, 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb'),
				path.join(appData, 'VSCodium', 'User', 'globalStorage', 'state.vscdb'),
			];
		}
		return [];
	}

	private async resolveGlobalStateDbPath(): Promise<string | null> {
		for (const candidate of this.getGlobalStateDbCandidates()) {
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
				return candidate;
			} catch {
				// continue
			}
		}
		return null;
	}

	private async getCurrentWorkspaceStateDbPath(): Promise<string | null> {
		const storageUriPath = this.context.storageUri?.fsPath;
		if (!storageUriPath) {
			return null;
		}

		const candidate = path.join(storageUriPath, '..', 'state.vscdb');
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
			return candidate;
		} catch {
			return null;
		}
	}

	private async getWorkspaceStateDbPaths(): Promise<string[]> {
		const candidates: string[] = [];
		const storageUriPath = this.context.storageUri?.fsPath;
		if (storageUriPath) {
			candidates.push(path.join(storageUriPath, '..', 'state.vscdb'));
		}

		const home = os.homedir();
		if (process.platform === 'linux') {
			const root = path.join(home, '.config', 'Code', 'User', 'workspaceStorage');
			try {
				const dirs = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
				for (const [name, type] of dirs) {
					if (type === vscode.FileType.Directory) {
						candidates.push(path.join(root, name, 'state.vscdb'));
					}
				}
			} catch {
				// ignore
			}
		}

		const existing: string[] = [];
		for (const candidate of candidates) {
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
				existing.push(candidate);
			} catch {
				// ignore
			}
		}
		return Array.from(new Set(existing));
	}

	private async getWorkspaceStorageRoots(): Promise<string[]> {
		const roots: string[] = [];
		const storageUriPath = this.context.storageUri?.fsPath;
		if (storageUriPath) {
			roots.push(path.join(storageUriPath, '..'));
		}

		const home = os.homedir();
		if (process.platform === 'linux') {
			const root = path.join(home, '.config', 'Code', 'User', 'workspaceStorage');
			try {
				const dirs = await fs.readdir(root, { withFileTypes: true });
				for (const dir of dirs) {
					if (dir.isDirectory()) {
						roots.push(path.join(root, dir.name));
					}
				}
			} catch {
				// ignore
			}
		}

		return Array.from(new Set(roots));
	}

	private async countChatRequestsCurrentPeriod(periodStartIso: string): Promise<number> {
		const roots = await this.getWorkspaceStorageRoots();
		const periodStartMs = new Date(periodStartIso).getTime();
		let total = 0;

		for (const root of roots) {
			const chatSessionsDir = path.join(root, 'chatSessions');
			let files: string[] = [];
			try {
				files = await fs.readdir(chatSessionsDir);
			} catch {
				continue;
			}

			for (const file of files) {
				if (!file.endsWith('.jsonl')) {
					continue;
				}
				const fullPath = path.join(chatSessionsDir, file);
				let stat: Awaited<ReturnType<typeof fs.stat>>;
				try {
					stat = await fs.stat(fullPath);
				} catch {
					continue;
				}
				if (stat.mtimeMs < periodStartMs) {
					continue;
				}

				let content = '';
				try {
					content = await fs.readFile(fullPath, 'utf-8');
				} catch {
					continue;
				}

				for (const line of content.split('\n')) {
					const trimmed = line.trim();
					if (!trimmed) {
						continue;
					}
					try {
						const obj = JSON.parse(trimmed) as { kind?: number; k?: unknown[] };
						if (obj.kind === 2 && Array.isArray(obj.k) && obj.k.length > 0 && obj.k[0] === 'requests') {
							total += 1;
						}
					} catch {
						// ignore malformed line
					}
				}
			}
		}

		return total;
	}

	private async readWorkspaceChatActivitySignal(): Promise<{ maxLastMessageDate: number; changedSessions: number }> {
		const dbPaths = await this.getWorkspaceStateDbPaths();
		let maxLastMessageDate = 0;
		let changedSessions = 0;
		const lastSeen = this.context.globalState.get<number>(LAST_CHAT_ACTIVITY_KEY, 0);

		for (const dbPath of dbPaths) {
			const cachedRaw = await this.readStateValueWithSqlJs(dbPath, 'chat.ChatSessionStore.index');
			if (cachedRaw.ok) {
				const parsed = this.parseChatSessionStoreIndex(cachedRaw.value);
				if (!parsed) {
					continue;
				}

				const nextSignal = this.extractChatActivitySignal(parsed, lastSeen);
				maxLastMessageDate = Math.max(maxLastMessageDate, nextSignal.maxLastMessageDate);
				changedSessions += nextSignal.changedSessions;
				continue;
			}

			try {
				const sql = "SELECT value FROM ItemTable WHERE key='chat.ChatSessionStore.index' LIMIT 1;";
				const { stdout } = await execFileAsync('sqlite3', [dbPath, sql]);
				const parsed = this.parseChatSessionStoreIndex((stdout || '').trim());
				if (!parsed) {
					continue;
				}
				const nextSignal = this.extractChatActivitySignal(parsed, lastSeen);
				maxLastMessageDate = Math.max(maxLastMessageDate, nextSignal.maxLastMessageDate);
				changedSessions += nextSignal.changedSessions;
			} catch {
				// continue
			}
		}

		if (maxLastMessageDate > lastSeen) {
			await this.context.globalState.update(LAST_CHAT_ACTIVITY_KEY, maxLastMessageDate);
		}

		return { maxLastMessageDate, changedSessions };
	}

	private parseChatSessionStoreIndex(raw: string | null | undefined): { entries?: Record<string, { lastMessageDate?: number }> } | null {
		const normalized = String(raw || '').trim();
		if (!normalized) {
			return null;
		}

		try {
			return JSON.parse(normalized) as { entries?: Record<string, { lastMessageDate?: number }> };
		} catch {
			return null;
		}
	}

	private extractChatActivitySignal(
		index: { entries?: Record<string, { lastMessageDate?: number }> },
		lastSeen: number,
	): { maxLastMessageDate: number; changedSessions: number } {
		let maxLastMessageDate = 0;
		let changedSessions = 0;
		const entries = index?.entries || {};

		for (const entry of Object.values(entries)) {
			const ts = Number(entry?.lastMessageDate || 0);
			if (ts > maxLastMessageDate) {
				maxLastMessageDate = ts;
			}
			if (ts > lastSeen) {
				changedSessions += 1;
			}
		}

		return { maxLastMessageDate, changedSessions };
	}

	private escapeSql(value: string): string {
		return value.replace(/'/g, "''");
	}

	private deepFindNumberByNames(node: unknown, names: string[]): number | null {
		if (!node || typeof node !== 'object') {
			return null;
		}
		if (Array.isArray(node)) {
			for (const item of node) {
				const nested = this.deepFindNumberByNames(item, names);
				if (nested !== null) {
					return nested;
				}
			}
			return null;
		}

		const rec = node as Record<string, unknown>;
		for (const [key, value] of Object.entries(rec)) {
			if (typeof value === 'number' && names.includes(key.toLowerCase()) && Number.isFinite(value)) {
				return value;
			}
		}
		for (const value of Object.values(rec)) {
			const nested = this.deepFindNumberByNames(value, names);
			if (nested !== null) {
				return nested;
			}
		}
		return null;
	}

	private deepFindStringByNames(node: unknown, names: string[]): string | null {
		if (!node || typeof node !== 'object') {
			return null;
		}
		if (Array.isArray(node)) {
			for (const item of node) {
				const nested = this.deepFindStringByNames(item, names);
				if (nested) {
					return nested;
				}
			}
			return null;
		}

		const rec = node as Record<string, unknown>;
		for (const [key, value] of Object.entries(rec)) {
			if (typeof value === 'string' && names.includes(key.toLowerCase()) && value.trim()) {
				return value.trim();
			}
		}
		for (const value of Object.values(rec)) {
			const nested = this.deepFindStringByNames(value, names);
			if (nested) {
				return nested;
			}
		}
		return null;
	}

	private parseUsageFromJsonText(raw: string): { used: number; limit: number; planType?: string } | null {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}

		if (parsed && typeof parsed === 'object') {
			const record = parsed as Record<string, unknown>;
			const entries = record['copilotUsageEntries'];
			if (Array.isArray(entries) && entries.length > 0) {
				const normalized = entries
					.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
					.map((entry) => ({
						used: Number(entry['used'] || 0),
						quota: Number(entry['quota'] || entry['limit'] || 0),
						plan: typeof entry['plan'] === 'string' ? String(entry['plan']) : '',
						timestamp: Number(entry['timestamp'] || 0),
					}))
					.filter((entry) => Number.isFinite(entry.used) && Number.isFinite(entry.quota) && entry.quota > 0)
					.sort((a, b) => b.timestamp - a.timestamp);

				if (normalized.length > 0) {
					const latest = normalized[0];
					return {
						used: latest.used,
						limit: latest.quota,
						planType: latest.plan || undefined,
					};
				}
			}
		}

		const used = this.deepFindNumberByNames(parsed, ['used', 'usage', 'premium_requests_used', 'quota_used']);
		const limit = this.deepFindNumberByNames(parsed, ['quota', 'limit', 'monthly_limit', 'premium_requests_limit', 'quota_total']);
		if (used === null || limit === null || limit <= 0) {
			return null;
		}

		const planType = this.deepFindStringByNames(parsed, ['plan', 'plantype', 'copilot_plan_type']) || undefined;
		return { used, limit, planType };
	}

	private async readLocalUsageFromStateDb(): Promise<{ used: number; limit: number; planType?: string; status: string } | null> {
		const dbPath = await this.resolveGlobalStateDbPath();
		if (!dbPath) {
			return null;
		}

		const priorityKeys = [
			'TMRomain.copilot-usage-tracker',
			'tmromain.copilot-usage-tracker',
			'fail-safe.copilot-premium-usage-monitor',
		];

		const cachedItems = await this.getStateDbItems(dbPath);
		if (cachedItems) {
			for (const key of priorityKeys) {
				const raw = String(cachedItems.get(key) || '').trim();
				if (!raw) {
					continue;
				}

				const parsed = this.parseUsageFromJsonText(raw);
				if (parsed && parsed.limit > 0) {
					return { ...parsed, status: `local-db:${key}` };
				}
			}

			for (const [key, value] of cachedItems.entries()) {
				const normalizedKey = key.toLowerCase();
				const normalizedValue = value.toLowerCase();
				if (!normalizedKey.includes('copilot')) {
					continue;
				}
				if (!normalizedValue.includes('quota') && !normalizedValue.includes('premium') && !normalizedValue.includes('used')) {
					continue;
				}

				const parsed = this.parseUsageFromJsonText(value);
				if (parsed && parsed.limit > 0) {
					return { ...parsed, status: `local-db:${key}` };
				}
			}

			return null;
		}

		for (const key of priorityKeys) {
			try {
				const sql = `SELECT value FROM ItemTable WHERE key='${this.escapeSql(key)}' LIMIT 1;`;
				const { stdout } = await execFileAsync('sqlite3', [dbPath, sql]);
				const raw = (stdout || '').trim();
				if (!raw) {
					continue;
				}
				const parsed = this.parseUsageFromJsonText(raw);
				if (parsed && parsed.limit > 0) {
					return { ...parsed, status: `local-db:${key}` };
				}
			} catch {
				// continue
			}
		}

		try {
			const sql = "SELECT key, value FROM ItemTable WHERE lower(key) LIKE '%copilot%' AND (lower(value) LIKE '%quota%' OR lower(value) LIKE '%premium%' OR lower(value) LIKE '%used%') LIMIT 80;";
			const { stdout } = await execFileAsync('sqlite3', [dbPath, sql, '-separator', '\t']);
			const lines = (stdout || '').split('\n').map(line => line.trim()).filter(Boolean);
			for (const line of lines) {
				const tabIndex = line.indexOf('\t');
				if (tabIndex <= 0) {
					continue;
				}
				const key = line.slice(0, tabIndex);
				const value = line.slice(tabIndex + 1);
				const parsed = this.parseUsageFromJsonText(value);
				if (parsed && parsed.limit > 0) {
					return { ...parsed, status: `local-db:${key}` };
				}
			}
		} catch {
			// continue
		}

		return null;
	}

	constructor(private readonly context: vscode.ExtensionContext) {
		// Восстанавливаем сохранённое состояние при инициализации
		this.restoreState();
		this.disposables.push(
			vscode.authentication.onDidChangeSessions((event) => {
				if (!this.isRelevantAuthenticationProvider(event.provider.id)) {
					return;
				}

				void this.handleAuthenticationSessionsChanged(event.provider.id);
			}),
		);
		this.startCopilotPreferencePolling();
		this.accountSwitchState = {
			isSwitching: false,
			phase: 'idle',
			message: '',
			accountLabel: null,
			startedAt: null,
			updatedAt: new Date().toISOString(),
		};
	}

	private isRelevantAuthenticationProvider(providerId: string): boolean {
		return providerId === GITHUB_AUTH_PROVIDER_ID || providerId === COPILOT_CHAT_AUTH_PROVIDER_ID;
	}

	private async handleAuthenticationSessionsChanged(providerId: string): Promise<void> {
		const ts = new Date().toISOString();
		appendPromptManagerLog(
			`[${ts}] [auth-event] onDidChangeSessions fired for provider: ${providerId}, ` +
			`userExplicitChoice=${this.userExplicitAccountChoice || 'none'}, isSwitching=${this.isSwitchingAccount}`,
		);

		// Во время ручного переключения — не вмешиваемся, switchCopilotChatAccountInteractively
		// сам управляет состоянием. Иначе возникает race condition.
		if (this.isSwitchingAccount) {
			this.pendingAuthSessionProviderIds.add(providerId);
			appendPromptManagerLog(`[${ts}] [auth-event] DEFER — isSwitchingAccount=true provider=${providerId}`);
			return;
		}

		// При смене сессии Copilot Chat (внешнее изменение, не наше) — следуем за ней
		if (providerId === COPILOT_CHAT_AUTH_PROVIDER_ID) {
			const copilotChatAccount = await this.resolveCopilotChatBoundGitHubAccount();
			appendPromptManagerLog(
				`[${ts}] [auth-event] Copilot Chat session now: ${copilotChatAccount?.label || 'none'} (was: ${this.lastKnownCopilotGitHubPreference || 'none'})`,
			);
			if (this.userExplicitAccountChoice) {
				appendPromptManagerLog(
					`[${ts}] [auth-event] clearing userExplicitAccountChoice (was: ${this.userExplicitAccountChoice}) — external Copilot Chat change`,
				);
				this.userExplicitAccountChoice = null;
			}
			const synced = await this.syncPreferenceFromCopilotChat(`auth-session-changed:${providerId}`);
			appendPromptManagerLog(
				`[${ts}] [auth-event] syncPreferenceFromCopilotChat result: synced=${synced}`,
			);
		}

		if (providerId === GITHUB_AUTH_PROVIDER_ID) {
			try {
				const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER_ID, ['user:email', 'read:user'], { createIfNone: false });
				appendPromptManagerLog(
					`[${ts}] [auth-event] GitHub session now: ${session?.account.label || 'none'}`,
				);
			} catch { /* ignore */ }
		}

		await this.refreshAuthenticationBinding(`auth-session-changed:${providerId}`);
	}

	async checkAuthenticationBindingOnActivation(): Promise<void> {
		const ts = new Date().toISOString();
		appendPromptManagerLog(`[${ts}] [activation] === START checkAuthenticationBindingOnActivation ===`);

		// При активации синхронизируем preference расширения с Copilot Chat
		const synced = await this.syncPreferenceFromCopilotChat('activation');
		appendPromptManagerLog(`[${ts}] [activation] syncPreferenceFromCopilotChat: synced=${synced}`);

		await this.refreshAuthenticationBinding('activation');
		appendPromptManagerLog(
			`[${ts}] [activation] after refresh: authenticated=${this.cachedData?.authenticated}, account=${this.lastKnownCopilotGitHubPreference || 'none'}, issue=${this.lastGitHubSessionIssue || 'none'}`,
		);
	}

	/**
	 * Синхронизирует аккаунт расширения с account preference Copilot Chat.
	 * Для account preference надежнее DB preference, так как live session может обновляться позже.
	 */
	private async syncPreferenceFromCopilotChat(reason: string): Promise<boolean> {
		try {
			// Если пользователь явно выбрал аккаунт — не перезаписываем его выбор
			if (this.userExplicitAccountChoice) {
				appendPromptManagerLog(
					`[${new Date().toISOString()}] [sync] ${reason}: SKIP — userExplicitAccountChoice=${this.userExplicitAccountChoice}`,
				);
				return false;
			}

			// Приоритет: DB preference Copilot Chat → usage активности Copilot Chat → живая сессия (fallback)
			const copilotChatAccount = await this.resolveCopilotChatBoundGitHubAccount();
			const dbPreference = await this.resolveCopilotPreferredGitHubAccountLabel();
			const usagePreference = await this.resolveCopilotChatGitHubUsageAccountLabel();
			const actualLabel = dbPreference ?? usagePreference ?? copilotChatAccount?.label;

			appendPromptManagerLog(
				`[${new Date().toISOString()}] [sync] ${reason}: copilotChat=${copilotChatAccount?.label || 'none'}, db=${dbPreference || 'none'}, usage=${usagePreference || 'none'}, known=${this.lastKnownCopilotGitHubPreference || 'none'}, actual=${actualLabel || 'none'}`,
			);

			if (!actualLabel) {
				return false;
			}

			const normalizedActual = actualLabel.trim().toLowerCase();
			const normalizedKnown = this.lastKnownCopilotGitHubPreference?.trim().toLowerCase();

			if (normalizedActual !== normalizedKnown) {
				appendPromptManagerLog(
					`[${new Date().toISOString()}] [sync] ${reason}: CHANGED from ${this.lastKnownCopilotGitHubPreference || 'none'} → ${actualLabel}`,
				);
				await this.persistPreferredAccountLabel(PROMPT_MANAGER_GITHUB_PREFERENCE_KEY, actualLabel);
				this.lastKnownCopilotGitHubPreference = actualLabel;
				return true;
			}

			return false;
		} catch (err) {
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [sync] ${reason}: ERROR ${String(err)}`,
			);
			return false;
		}
	}

	/**
	 * Периодически проверяет, не изменился ли аккаунт Copilot Chat (через state.vscdb).
	 * Если обнаружено расхождение — автоматически переключает расширение на тот же аккаунт.
	 */
	private startCopilotPreferencePolling(): void {
		this.stopCopilotPreferencePolling();
		// Проверяем каждые 15 секунд
		this.copilotPreferencePollingTimer = setInterval(() => {
			if (this.isSwitchingAccount || this.isFetching) {
				return;
			}
			void this.pollCopilotPreferenceChange();
		}, 15_000);
	}

	private stopCopilotPreferencePolling(): void {
		if (this.copilotPreferencePollingTimer) {
			clearInterval(this.copilotPreferencePollingTimer);
			this.copilotPreferencePollingTimer = undefined;
		}
	}

	private async pollCopilotPreferenceChange(): Promise<void> {
		try {
			const synced = await this.syncPreferenceFromCopilotChat('preference-poll');
			if (synced) {
				appendPromptManagerLog(
					`[${new Date().toISOString()}] [poll] Copilot Chat account change detected, refreshing...`,
				);
				this.lastApiCallTimestamp = 0;
				this.lastFullRefreshTimestamp = 0;
				await this.refreshAuthenticationBinding('copilot-chat-account-changed');
			}
		} catch {
			// keep polling resilient
		}
	}

	private async refreshAuthenticationBinding(reason: string): Promise<void> {
		this.lastApiCallTimestamp = 0;
		this.lastFullRefreshTimestamp = 0;

		if (this.cachedData) {
			this.cachedData = {
				...this.cachedData,
				lastUpdated: new Date().toISOString(),
				lastSyncStatus: reason,
			};
		}

		try {
			await this.fetchUsage(true);
		} catch {
			// keep extension resilient on auth provider glitches
		}
	}

	/**
	 * Восстанавливает сохранённое состояние из globalState.
	 * Если данные были сохранены ранее, они используются как начальные значения.
	 */
	private restoreState(): void {
		const saved = this.context.globalState.get<CopilotUsageData>(STATE_KEY_USAGE);
		if (saved) {
			const sanitizedSnapshots = this.fillSnapshotGaps(
				this.sanitizeSnapshots(
					Array.isArray(saved.snapshots) ? saved.snapshots : [],
					Number(saved.used || 0),
					Number(saved.limit || 0),
				),
			);
			this.cachedData = {
				...saved,
				source: saved.source || 'local',
				snapshots: sanitizedSnapshots,
				lastSyncStatus: saved.lastSyncStatus || 'restored-from-cache',
			};
			this.lastKnownAuthenticated = !!saved.authenticated;
		}
	}

	/**
	 * Сохраняет текущее состояние в globalState.
	 */
	private async persistState(): Promise<void> {
		if (this.cachedData) {
			await this.context.globalState.update(STATE_KEY_USAGE, this.cachedData);
		}
	}

	private async readStateValue(dbPath: string, key: string): Promise<string | null> {
		const cachedValue = await this.readStateValueWithSqlJs(dbPath, key);
		if (cachedValue.ok) {
			return cachedValue.value;
		}

		if (process.platform === 'win32') {
			return null;
		}

		try {
			const sql = `SELECT value FROM ItemTable WHERE key='${this.escapeSql(key)}' LIMIT 1;`;
			const { stdout } = await execFileAsync('sqlite3', [dbPath, sql]);
			const raw = (stdout || '').trim();
			return raw || null;
		} catch (err) {
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [state-db] readStateValue FAILED key=${key} db=${dbPath} error=${String(err)}`,
			);
			return null;
		}
	}

	private async writeStateValue(dbPath: string, key: string, value: string): Promise<void> {
		if (process.platform === 'win32') {
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [state-db] writeStateValue SKIPPED key=${key} db=${dbPath} reason=external-sqlite-unavailable-on-win32`,
			);
			return;
		}

		const sql = [
			'BEGIN TRANSACTION;',
			`INSERT INTO ItemTable(key, value) VALUES ('${this.escapeSql(key)}', '${this.escapeSql(value)}')`,
			'ON CONFLICT(key) DO UPDATE SET value=excluded.value;',
			'COMMIT;',
		].join(' ');
		try {
			await execFileAsync('sqlite3', [dbPath, sql]);
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [state-db] writeStateValue OK key=${key} value=${value} db=${dbPath}`,
			);
		} catch (err) {
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [state-db] writeStateValue FAILED key=${key} value=${value} db=${dbPath} error=${String(err)}`,
			);
			throw err;
		}
	}

	private async persistPreferredAccountLabel(key: string, accountLabel: string): Promise<void> {
		await this.context.globalState.update(PROMPT_MANAGER_GITHUB_PREFERENCE_FALLBACK_STATE_KEY, accountLabel);
		this.lastSyncedPmPreference = accountLabel;

		const dbPaths = [
			await this.getCurrentWorkspaceStateDbPath(),
			await this.resolveGlobalStateDbPath(),
		].filter((value): value is string => !!value);

		appendPromptManagerLog(
			`[${new Date().toISOString()}] [persist] persistPreferredAccountLabel key=${key} value=${accountLabel} dbPaths=[${dbPaths.join(', ')}]`,
		);

		let anySuccess = false;
		for (const dbPath of dbPaths) {
			try {
				await this.writeStateValue(dbPath, key, accountLabel);
				anySuccess = true;
			} catch {
				// writeStateValue уже залогировала ошибку
			}
		}

		if (!anySuccess) {
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [persist] ALL DB writes FAILED for ${key}=${accountLabel} — using globalState fallback`,
			);
		}
	}

	private async resolveCopilotPreferredGitHubAccountLabel(): Promise<string | null> {
		const dbPaths = [
			await this.getCurrentWorkspaceStateDbPath(),
			await this.resolveGlobalStateDbPath(),
		].filter((value): value is string => !!value);

		for (const dbPath of dbPaths) {
			for (const key of COPILOT_GITHUB_PREFERENCE_KEYS) {
				const value = await this.readStateValue(dbPath, key);
				if (value) {
					return value;
				}
			}
		}

		return await this.resolveCopilotChatGitHubUsageAccountLabel();
	}

	private async resolvePromptManagerPreferredGitHubAccountLabel(): Promise<string | null> {
		const dbPaths = [
			await this.getCurrentWorkspaceStateDbPath(),
			await this.resolveGlobalStateDbPath(),
		].filter((value): value is string => !!value);

		for (const dbPath of dbPaths) {
			const value = await this.readStateValue(dbPath, PROMPT_MANAGER_GITHUB_PREFERENCE_KEY);
			if (value) {
				this.lastSyncedPmPreference = value;
				appendPromptManagerLog(
					`[${new Date().toISOString()}] [resolve-pm] found in DB: ${value} db=${dbPath}`,
				);
				return value;
			}
		}

		const persistedFallback = this.context.globalState.get<string>(PROMPT_MANAGER_GITHUB_PREFERENCE_FALLBACK_STATE_KEY) || null;
		if (persistedFallback) {
			this.lastSyncedPmPreference = persistedFallback;
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [resolve-pm] using globalState fallback: ${persistedFallback}`,
			);
			return persistedFallback;
		}

		// Если DB недоступна — используем in-memory кэш, чтобы не зацикливать sync
		appendPromptManagerLog(
			`[${new Date().toISOString()}] [resolve-pm] DB returned nothing, using in-memory cache: ${this.lastSyncedPmPreference || 'null'}`,
		);
		return this.lastSyncedPmPreference;
	}

	private async resolveLatestUsedAccountForExtension(
		providerId: string,
		extensionIds: readonly string[],
	): Promise<{ accountLabel: string; lastUsed: number } | null> {
		const dbPaths = [
			await this.getCurrentWorkspaceStateDbPath(),
			await this.resolveGlobalStateDbPath(),
		].filter((value): value is string => !!value);
		const normalizedExtensionIds = new Set(
			extensionIds.map((value) => value.trim().toLowerCase()).filter(Boolean),
		);
		if (normalizedExtensionIds.size === 0) {
			return null;
		}

		const keyPrefix = `${providerId}-`;
		const sql = `SELECT key, value FROM ItemTable WHERE key LIKE '${this.escapeSql(providerId)}-%-usages';`;
		let latest: { accountLabel: string; lastUsed: number } | null = null;

		for (const dbPath of dbPaths) {
			const cachedItems = await this.getStateDbItems(dbPath);
			if (cachedItems) {
				for (const [key, rawValue] of cachedItems.entries()) {
					if (!key.startsWith(keyPrefix) || !key.endsWith('-usages')) {
						continue;
					}

					const accountLabel = key.slice(keyPrefix.length, -'-usages'.length).trim();
					if (!accountLabel) {
						continue;
					}

					let usages: unknown;
					try {
						usages = JSON.parse(rawValue);
					} catch {
						continue;
					}

					if (!Array.isArray(usages)) {
						continue;
					}

					for (const usage of usages) {
						if (!usage || typeof usage !== 'object') {
							continue;
						}

						const usageRecord = usage as Record<string, unknown>;
						const extensionId = typeof usageRecord.extensionId === 'string'
							? usageRecord.extensionId.trim().toLowerCase()
							: '';
						if (!normalizedExtensionIds.has(extensionId)) {
							continue;
						}

						const lastUsed = Number(usageRecord.lastUsed || 0);
						if (!Number.isFinite(lastUsed) || lastUsed <= 0) {
							continue;
						}

						if (!latest || lastUsed > latest.lastUsed) {
							latest = { accountLabel, lastUsed };
						}
					}
				}
				continue;
			}

			try {
				const { stdout } = await execFileAsync('sqlite3', [dbPath, sql, '-separator', '\t']);
				const lines = (stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
				for (const line of lines) {
					const tabIndex = line.indexOf('\t');
					if (tabIndex <= 0) {
						continue;
					}

					const key = line.slice(0, tabIndex);
					const rawValue = line.slice(tabIndex + 1);
					if (!key.startsWith(keyPrefix) || !key.endsWith('-usages')) {
						continue;
					}

					const accountLabel = key.slice(keyPrefix.length, -'-usages'.length).trim();
					if (!accountLabel) {
						continue;
					}

					let usages: unknown;
					try {
						usages = JSON.parse(rawValue);
					} catch {
						continue;
					}

					if (!Array.isArray(usages)) {
						continue;
					}

					for (const usage of usages) {
						if (!usage || typeof usage !== 'object') {
							continue;
						}

						const usageRecord = usage as Record<string, unknown>;
						const extensionId = typeof usageRecord.extensionId === 'string'
							? usageRecord.extensionId.trim().toLowerCase()
							: '';
						if (!normalizedExtensionIds.has(extensionId)) {
							continue;
						}

						const lastUsed = Number(usageRecord.lastUsed || 0);
						if (!Number.isFinite(lastUsed) || lastUsed <= 0) {
							continue;
						}

						if (!latest || lastUsed > latest.lastUsed) {
							latest = { accountLabel, lastUsed };
						}
					}
				}
			} catch {
				// ignore unavailable db or malformed row
			}
		}

		return latest;
	}

	private async readStateValueWithSqlJs(dbPath: string, key: string): Promise<{ ok: boolean; value: string | null }> {
		const items = await this.getStateDbItems(dbPath);
		if (!items) {
			return { ok: false, value: null };
		}

		return {
			ok: true,
			value: items.get(key) ?? null,
		};
	}

	private async getStateDbItems(dbPath: string): Promise<Map<string, string> | null> {
		const wasmPath = this.getSqlJsWasmPath();
		if (!wasmPath) {
			return null;
		}

		try {
			const fingerprint = this.getStateDbFingerprint(dbPath);
			if (!fingerprint) {
				return null;
			}

			const cached = this.stateDbItemCache.get(dbPath);
			if (!cached || cached.fingerprint !== fingerprint) {
				const items = await readSqliteItemTable(dbPath, wasmPath);
				this.stateDbItemCache.set(dbPath, { fingerprint, items });
			}

			return this.stateDbItemCache.get(dbPath)?.items ?? null;
		} catch {
			return null;
		}
	}

	private getSqlJsWasmPath(): string | null {
		const wasmPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'sql-wasm.wasm').fsPath;
		return fsSync.existsSync(wasmPath) ? wasmPath : null;
	}

	private getStateDbFingerprint(dbPath: string): string {
		const candidates = [
			dbPath,
			`${dbPath}-wal`,
			`${dbPath}-shm`,
			`${dbPath}-journal`,
		];

		const parts: string[] = [];
		for (const candidate of candidates) {
			try {
				const stat = fsSync.statSync(candidate);
				parts.push(`${candidate}:${stat.size}:${stat.mtimeMs}`);
			} catch {
				// continue
			}
		}

		return parts.join('|');
	}

	private async resolveCopilotChatGitHubUsageAccountLabel(): Promise<string | null> {
		const latest = await this.resolveLatestUsedAccountForExtension(
			GITHUB_AUTH_PROVIDER_ID,
			COPILOT_CHAT_GITHUB_USAGE_EXTENSION_IDS,
		);
		return latest?.accountLabel ?? null;
	}

	private async refreshCopilotGitHubPreference(): Promise<boolean> {
		// Если пользователь явно выбрал аккаунт — не перезаписывать
		if (this.userExplicitAccountChoice) {
			return false;
		}
		// Приоритет: DB preference Copilot Chat → живая сессия
		const copilotChatAccount = await this.resolveCopilotChatBoundGitHubAccount();
		const preference = await this.resolveCopilotPreferredGitHubAccountLabel()
			?? await this.resolveCopilotChatGitHubUsageAccountLabel()
			?? copilotChatAccount?.label;
		const changed = this.lastKnownCopilotGitHubPreference !== preference;
		this.lastKnownCopilotGitHubPreference = preference;
		return changed;
	}

	private async requestGitHubSessionForAccount(
		account: vscode.AuthenticationSessionAccountInformation,
		createIfNone: boolean,
	): Promise<vscode.AuthenticationSession | null> {
		try {
			return (await vscode.authentication.getSession(
				GITHUB_AUTH_PROVIDER_ID,
				['repo', 'workflow', 'user:email', 'read:user'],
				{
					createIfNone,
					clearSessionPreference: true,
					account,
				},
			)) ?? null;
		} catch {
			return null;
		}
	}

	private async syncPromptManagerGitHubPreference(
		preferredAccount: vscode.AuthenticationSessionAccountInformation | undefined,
		createIfNone: boolean,
	): Promise<void> {
		if (!preferredAccount) {
			return;
		}

		const promptManagerPreference = await this.resolvePromptManagerPreferredGitHubAccountLabel();
		if (promptManagerPreference?.trim().toLowerCase() === preferredAccount.label.trim().toLowerCase()) {
			return;
		}

		appendPromptManagerLog(
			`[${new Date().toISOString()}] [copilot-usage.auth] sync prompt-manager preference from ${promptManagerPreference || 'none'} to ${preferredAccount.label}`,
		);
		// Сохраняем в in-memory кэш ДО записи в DB — при неудаче DB sync не зацикливается
		this.lastSyncedPmPreference = preferredAccount.label;
		await this.persistPreferredAccountLabel(PROMPT_MANAGER_GITHUB_PREFERENCE_KEY, preferredAccount.label);

		try {
			await vscode.authentication.getSession(
				GITHUB_AUTH_PROVIDER_ID,
				['repo', 'workflow', 'user:email', 'read:user'],
				{
					createIfNone,
					clearSessionPreference: true,
					account: preferredAccount,
				},
			);
		} catch {
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [copilot-usage.auth] sync prompt-manager preference failed for account ${preferredAccount.label}`,
			);
			// fall back to regular getSession flow below
		}
	}

	private isSameGitHubAccount(
		session: vscode.AuthenticationSession | null | undefined,
		preferredAccount: vscode.AuthenticationSessionAccountInformation | undefined,
	): boolean {
		if (!session || !preferredAccount) {
			return true;
		}

		if (session.account.id && preferredAccount.id && session.account.id === preferredAccount.id) {
			return true;
		}

		return session.account.label.trim().toLowerCase() === preferredAccount.label.trim().toLowerCase();
	}

	private async retryGitHubSessionWithClearedPreference(
		scopes: string[],
		preferredAccount: vscode.AuthenticationSessionAccountInformation,
		createIfNone: boolean,
	): Promise<vscode.AuthenticationSession | null> {
		appendPromptManagerLog(
			`[${new Date().toISOString()}] [copilot-usage.auth] retry getSession with cleared preference for account ${preferredAccount.label} scopes=${scopes.join(',')}`,
		);
		try {
			return (await vscode.authentication.getSession(
				GITHUB_AUTH_PROVIDER_ID,
				scopes,
				{
					createIfNone,
					clearSessionPreference: true,
					account: preferredAccount,
				},
			)) ?? null;
		} catch {
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [copilot-usage.auth] retry getSession with cleared preference failed for account ${preferredAccount.label}`,
			);
			return null;
		}
	}

	private summarizeSession(session: vscode.AuthenticationSession | null | undefined): Record<string, unknown> | null {
		if (!session) {
			return null;
		}

		return {
			id: session.id,
			accountLabel: session.account.label,
			accountId: session.account.id,
			scopes: [...session.scopes].sort(),
		};
	}

	private async buildPreferenceSnapshot(dbPath: string | null): Promise<Record<string, string | null>> {
		if (!dbPath) {
			return {};
		}

		const snapshot: Record<string, string | null> = {};
		for (const key of [...COPILOT_GITHUB_PREFERENCE_KEYS, PROMPT_MANAGER_GITHUB_PREFERENCE_KEY]) {
			snapshot[key] = await this.readStateValue(dbPath, key);
		}
		return snapshot;
	}

	async getUsageSnapshot(forceRefresh: boolean = false): Promise<CopilotUsageSnapshot> {
		const usage = await this.fetchUsage(forceRefresh);
		const accountSummary = await this.getAccountBindingSummary();
		return {
			usage,
			accountSummary,
			debugLog: this.lastDebugLog,
			switchState: this.getAccountSwitchState(),
		};
	}

	async buildDiagnosticsReport(): Promise<string> {
		const timestamp = new Date().toISOString();
		const workspaceDbPath = await this.getCurrentWorkspaceStateDbPath();
		const globalDbPath = await this.resolveGlobalStateDbPath();
		const workspacePreferences = await this.buildPreferenceSnapshot(workspaceDbPath);
		const globalPreferences = await this.buildPreferenceSnapshot(globalDbPath);
		const copilotPreference = await this.resolveCopilotPreferredGitHubAccountLabel();
		const promptManagerPreference = await this.resolvePromptManagerPreferredGitHubAccountLabel();
		const githubAccounts = await this.safelyGetGitHubAccounts();
		const preferredAccount = await this.resolveGitHubAccountByLabel(copilotPreference);
		let copilotChatSession: vscode.AuthenticationSession | null = null;
		let defaultGithubSession: vscode.AuthenticationSession | null = null;
		let preferredGithubSession: vscode.AuthenticationSession | null = null;
		try {
			copilotChatSession = (await vscode.authentication.getSession(
				COPILOT_CHAT_AUTH_PROVIDER_ID,
				[],
				{ createIfNone: false },
			)) ?? null;
		} catch {
			copilotChatSession = null;
		}
		try {
			defaultGithubSession = (await vscode.authentication.getSession(
				GITHUB_AUTH_PROVIDER_ID,
				['repo', 'workflow', 'user:email', 'read:user'],
				{ createIfNone: false },
			)) ?? null;
		} catch {
			defaultGithubSession = null;
		}
		if (preferredAccount) {
			try {
				preferredGithubSession = (await vscode.authentication.getSession(
					GITHUB_AUTH_PROVIDER_ID,
					['repo', 'workflow', 'user:email', 'read:user'],
					{ createIfNone: false, account: preferredAccount },
				)) ?? null;
			} catch {
				preferredGithubSession = null;
			}
		}

		const report = {
			timestamp,
			workspaceStateDbPath: workspaceDbPath,
			globalStateDbPath: globalDbPath,
			workspacePreferences,
			globalPreferences,
			copilotPreferredGitHubLabel: copilotPreference,
			promptManagerPreferredGitHubLabel: promptManagerPreference,
			lastKnownCopilotGitHubPreference: this.lastKnownCopilotGitHubPreference,
			availableGitHubAccounts: githubAccounts.map((account) => ({ id: account.id, label: account.label })),
			resolvedPreferredGitHubAccount: preferredAccount ? { id: preferredAccount.id, label: preferredAccount.label } : null,
			copilotChatSession: this.summarizeSession(copilotChatSession),
			defaultGithubSession: this.summarizeSession(defaultGithubSession),
			preferredGithubSession: this.summarizeSession(preferredGithubSession),
			lastGitHubSessionIssue: this.lastGitHubSessionIssue,
			cachedUsage: this.cachedData,
			lastDebugLog: this.lastDebugLog,
		};

		return JSON.stringify(report, null, 2);
	}

	async getAccountBindingSummary(): Promise<CopilotUsageAccountSummary> {
		const [
			copilotChatBoundAccount,
			copilotDbPreference,
			promptManagerPreferredGitHubLabel,
			availableGitHubAccounts,
			promptManagerSession,
		] = await Promise.all([
			this.resolveCopilotChatBoundGitHubAccount(),
			this.resolveCopilotPreferredGitHubAccountLabel(),
			this.resolvePromptManagerPreferredGitHubAccountLabel(),
			this.safelyGetGitHubAccounts(),
			this.getGitHubSession(false),
		]);

		// Для страницы важнее выбранный account preference Copilot Chat, а не потенциально отстающая живая сессия.
		const copilotPreferredGitHubLabel = copilotDbPreference ?? copilotChatBoundAccount?.label ?? null;

		return {
			copilotPreferredGitHubLabel,
			promptManagerPreferredGitHubLabel,
			activeGithubSessionAccountLabel: promptManagerSession?.account.label || null,
			githubSessionIssue: this.lastGitHubSessionIssue,
			availableGitHubAccounts: availableGitHubAccounts.map((account) => ({ id: account.id, label: account.label })),
		};
	}

	async switchCopilotChatAccountInteractively(): Promise<CopilotAccountSwitchInteractiveResult> {
		const ts = () => new Date().toISOString();
		if (this.isSwitchingAccount) {
			appendPromptManagerLog(`[${ts()}] [switch] switch request ignored: another switch is already running`);
			return {
				changed: false,
				cancelled: true,
				message: 'Смена аккаунта уже выполняется.',
			};
		}

		const copilotChatAccountBefore = await this.resolveCopilotChatBoundGitHubAccount();
		const dbPreferenceBefore = await this.resolveCopilotPreferredGitHubAccountLabel();
		const usagePreferenceBefore = await this.resolveCopilotChatGitHubUsageAccountLabel();
		const beforeLabel = copilotChatAccountBefore?.label || null;
		const requestId = ++this.interactiveSwitchRequestId;
		appendPromptManagerLog(
			`[${ts()}] [switch] === START ===\n` +
			`[${ts()}] [switch] requestId=${requestId} copilotChat BEFORE: live=${beforeLabel || 'none'}, db=${dbPreferenceBefore || 'none'}, usage=${usagePreferenceBefore || 'none'}`,
		);

		// === Детекция смены: событие + поллинг (гонка — кто первый обнаружит) ===
		let detected = false;
		let detectedLabel: string | null = null;

		const authEvents: string[] = [];
		const authDisposable = vscode.authentication.onDidChangeSessions((e) => {
			authEvents.push(`${e.provider.id}@${new Date().toISOString()}`);
			appendPromptManagerLog(`[${ts()}] [switch] onDidChangeSessions: provider=${e.provider.id}`);
		});

		try {
			// ===== ШАГ 1: Открываем пикер Copilot Chat =====
			appendPromptManagerLog(`[${ts()}] [switch] calling _manageAccountPreferencesForExtension...`);
			let commandError: string | null = null;
			try {
				await vscode.commands.executeCommand(
					'_manageAccountPreferencesForExtension',
					'github.copilot-chat',
					'github',
				);
			} catch (err) {
				commandError = String(err);
			}
			appendPromptManagerLog(
				`[${ts()}] [switch] command returned. error=${commandError || 'none'}, authEvents=[${authEvents.join(', ')}]`,
			);

			if (commandError) {
				if (this.interactiveSwitchRequestId === requestId) {
					this.interactiveSwitchRequestId = 0;
				}
				return { changed: false, message: `Ошибка: ${commandError}` };
			}

			// ===== ШАГ 2: Команда выше только открывает QuickPick и возвращается сразу.
			// Ждём фактическое изменение account preference Copilot Chat.
			for (let attempt = 1; attempt <= ACCOUNT_SWITCH_DETECTION_MAX_ATTEMPTS; attempt++) {
				if (this.interactiveSwitchRequestId !== requestId) {
					appendPromptManagerLog(`[${ts()}] [switch] requestId=${requestId} superseded by newer request`);
					return { changed: false, cancelled: true, message: 'Смена аккаунта была перезапущена.' };
				}
				await this.delay(ACCOUNT_SWITCH_DETECTION_INTERVAL_MS);

				const liveSession = await this.resolveCopilotChatBoundGitHubAccount();
				const liveLabel = liveSession?.label || null;
				const dbPref = await this.resolveCopilotPreferredGitHubAccountLabel();
				const usagePref = await this.resolveCopilotChatGitHubUsageAccountLabel();

				appendPromptManagerLog(
					`[${ts()}] [switch] poll #${attempt}: live=${liveLabel || 'none'}, db=${dbPref || 'none'}, usage=${usagePref || 'none'}, events=[${authEvents.join(', ')}]`,
				);

				// Основной сигнал: изменился account preference Copilot Chat.
				if (dbPref && dbPref !== dbPreferenceBefore) {
					detectedLabel = dbPref;
					detected = true;
					appendPromptManagerLog(`[${ts()}] [switch] DETECTED via account preference: ${detectedLabel}`);
					break;
				}

				// Fallback: Copilot Chat реально начал использовать другой GitHub-аккаунт.
				if (usagePref && usagePref !== usagePreferenceBefore) {
					detectedLabel = usagePref;
					detected = true;
					appendPromptManagerLog(`[${ts()}] [switch] DETECTED via usage activity: ${detectedLabel}`);
					break;
				}

				// Fallback: если у пользователя сразу обновилась живая сессия Copilot Chat.
				if (liveLabel && liveLabel !== beforeLabel) {
					detectedLabel = liveLabel;
					detected = true;
					appendPromptManagerLog(`[${ts()}] [switch] DETECTED via live session: ${detectedLabel}`);
					break;
				}
			}

			if (!detected || !detectedLabel) {
				appendPromptManagerLog(`[${ts()}] [switch] requestId=${requestId} not detected before timeout — cancelled`);
				if (this.interactiveSwitchRequestId === requestId) {
					this.interactiveSwitchRequestId = 0;
				}
				return { changed: false, cancelled: true, message: 'Аккаунт не изменён.' };
			}

			// ===== ШАГ 3: Аккаунт РЕАЛЬНО изменился =====
			appendPromptManagerLog(`[${ts()}] [switch] CHANGED: ${beforeLabel} → ${detectedLabel}`);
			if (this.interactiveSwitchRequestId === requestId) {
				this.interactiveSwitchRequestId = 0;
			}

			this.userExplicitAccountChoice = detectedLabel;
			this.lastKnownCopilotGitHubPreference = detectedLabel;
			this.lastGitHubSessionIssue = null;
			this.lastApiCallTimestamp = 0;
			this.lastFullRefreshTimestamp = 0;
			this.beginAccountSwitching(detectedLabel, `Выбран аккаунт ${detectedLabel}. Начинаем синхронизацию Prompt Manager.`);

			return {
				changed: true,
				accountLabel: detectedLabel,
				message: `Выбран аккаунт ${detectedLabel}. Обновляем данные Prompt Manager.`,
			};
		} finally {
			authDisposable.dispose();
			if (this.interactiveSwitchRequestId === requestId && !detected) {
				this.interactiveSwitchRequestId = 0;
			}
			appendPromptManagerLog(`[${ts()}] [switch] === END === authEvents=[${authEvents.join(', ')}]`);
		}
	}

	async completeAccountSwitch(accountLabel: string): Promise<CopilotAccountSwitchCompletionResult> {
		const expectedAccountLabel = this.normalizeAccountLabel(accountLabel);
		if (!expectedAccountLabel) {
			throw new Error('Не удалось определить новый аккаунт для Prompt Manager.');
		}

		appendPromptManagerLog(
			`[${new Date().toISOString()}] [switch-complete] start for account=${expectedAccountLabel}`,
		);

		if (!this.isSwitchingAccount) {
			this.beginAccountSwitching(expectedAccountLabel, `Синхронизируем Prompt Manager с аккаунтом ${expectedAccountLabel}.`);
		}

		try {
			this.updateAccountSwitchProgress(
				'syncing-extension',
				`Переключаем Prompt Manager на аккаунт ${expectedAccountLabel}.`,
				expectedAccountLabel,
			);
			await this.persistPreferredAccountLabel(PROMPT_MANAGER_GITHUB_PREFERENCE_KEY, expectedAccountLabel);
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [switch-complete] prompt-manager preference persisted: ${expectedAccountLabel}`,
			);

			this.updateAccountSwitchProgress(
				'awaiting-session',
				`Ждём GitHub-сессию Prompt Manager для аккаунта ${expectedAccountLabel}.`,
				expectedAccountLabel,
			);
			const session = await this.waitForPromptManagerSession(expectedAccountLabel);
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [switch-complete] session resolved: ${session.account.label}`,
			);

			this.lastApiCallTimestamp = 0;
			this.lastFullRefreshTimestamp = 0;
			this.updateAccountSwitchProgress(
				'refreshing-usage',
				`Обновляем Copilot Premium Usage для аккаунта ${expectedAccountLabel}.`,
				expectedAccountLabel,
			);
			const snapshot = await this.waitForUsageSnapshot(expectedAccountLabel);
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [switch-complete] usage confirmed: account=${snapshot.accountSummary.activeGithubSessionAccountLabel || 'none'} used=${snapshot.usage.used} limit=${snapshot.usage.limit} source=${snapshot.usage.source}`,
			);

			this.endAccountSwitching({
				phase: 'completed',
				message: `Аккаунт ${expectedAccountLabel} подключён. Данные обновлены.`,
				accountLabel: expectedAccountLabel,
			});
			this.userExplicitAccountChoice = null;
			const completedSnapshot: CopilotUsageSnapshot = {
				...snapshot,
				switchState: this.getAccountSwitchState(),
			};

			return {
				...completedSnapshot,
				accountLabel: expectedAccountLabel,
				message: `Аккаунт переключен на ${expectedAccountLabel}. Данные панели и статусбара обновлены.`,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [switch-complete] failed: ${message}`,
			);
			this.endAccountSwitching({
				phase: 'error',
				message: `Смена аккаунта не завершена: ${message}`,
				accountLabel: expectedAccountLabel,
			});
			throw error;
		}
	}

	private async waitForPromptManagerSession(expectedAccountLabel: string): Promise<vscode.AuthenticationSession> {
		let createIfNoneAttempted = false;
		for (let attempt = 1; attempt <= ACCOUNT_SWITCH_SESSION_MAX_ATTEMPTS; attempt += 1) {
			if (attempt > 1) {
				await this.delay(ACCOUNT_SWITCH_SESSION_INTERVAL_MS);
			}

			const session = await this.getGitHubSession(false);
			const sessionLabel = session?.account.label || null;
			const promptManagerPreference = await this.resolvePromptManagerPreferredGitHubAccountLabel();
			appendPromptManagerLog(
				`[${new Date().toISOString()}] [switch-session] poll #${attempt}: expected=${expectedAccountLabel} session=${sessionLabel || 'none'} promptManagerPreference=${promptManagerPreference || 'none'} issue=${this.lastGitHubSessionIssue || 'none'}`,
			);

			if (session && this.isExpectedAccountLabel(sessionLabel, expectedAccountLabel)) {
				return session;
			}

			if (!createIfNoneAttempted && attempt === Math.ceil(ACCOUNT_SWITCH_SESSION_MAX_ATTEMPTS / 2)) {
				createIfNoneAttempted = true;
				this.updateAccountSwitchProgress(
					'awaiting-session',
					`Пытаемся получить GitHub-сессию для аккаунта ${expectedAccountLabel}.`,
					expectedAccountLabel,
				);
				const createdSession = await this.getGitHubSession(true);
				const createdSessionLabel = createdSession?.account.label || null;
				appendPromptManagerLog(
					`[${new Date().toISOString()}] [switch-session] createIfNone attempt: session=${createdSessionLabel || 'none'}`,
				);
				if (createdSession && this.isExpectedAccountLabel(createdSessionLabel, expectedAccountLabel)) {
					return createdSession;
				}
			}
		}

		throw new Error(`Prompt Manager не получил GitHub-сессию для аккаунта ${expectedAccountLabel}.`);
	}

	private async waitForUsageSnapshot(expectedAccountLabel: string): Promise<CopilotUsageSnapshot> {
		let lastError: Error | null = null;
		for (let attempt = 1; attempt <= ACCOUNT_SWITCH_USAGE_MAX_ATTEMPTS; attempt += 1) {
			if (attempt > 1) {
				await this.delay(ACCOUNT_SWITCH_USAGE_INTERVAL_MS);
			}

			try {
				const snapshot = await this.getUsageSnapshot(true);
				const activeSessionLabel = snapshot.accountSummary.activeGithubSessionAccountLabel;
				const promptManagerPreference = snapshot.accountSummary.promptManagerPreferredGitHubLabel;
				appendPromptManagerLog(
					`[${new Date().toISOString()}] [switch-usage] poll #${attempt}: expected=${expectedAccountLabel} active=${activeSessionLabel || 'none'} promptManagerPreference=${promptManagerPreference || 'none'} authenticated=${snapshot.usage.authenticated} used=${snapshot.usage.used} limit=${snapshot.usage.limit} source=${snapshot.usage.source}`,
				);

				const activeMatches = this.isExpectedAccountLabel(activeSessionLabel, expectedAccountLabel);
				const preferenceMatches = !promptManagerPreference || this.isExpectedAccountLabel(promptManagerPreference, expectedAccountLabel);
				if (snapshot.usage.authenticated && activeMatches && preferenceMatches) {
					return snapshot;
				}
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				appendPromptManagerLog(
					`[${new Date().toISOString()}] [switch-usage] poll #${attempt} failed: ${lastError.message}`,
				);
			}
		}

		if (lastError) {
			throw lastError;
		}

		throw new Error(`Не удалось подтвердить обновление данных для аккаунта ${expectedAccountLabel}.`);
	}

	/** Вызывается, когда процесс смены аккаунта завершён и можно вернуть обычный режим работы */
	endAccountSwitching(options?: { phase?: CopilotAccountSwitchPhase; message?: string; accountLabel?: string | null }): void {
		const timestamp = new Date().toISOString();
		this.isSwitchingAccount = false;
		this.emitAccountSwitchState({
			isSwitching: false,
			phase: options?.phase ?? 'idle',
			message: options?.message || '',
			accountLabel: this.normalizeAccountLabel(options?.accountLabel ?? this.accountSwitchState.accountLabel),
			startedAt: this.accountSwitchState.startedAt,
			updatedAt: timestamp,
		});
		this.flushPendingAuthenticationSessionChanges();
	}

	private async resolveGitHubAccountByLabel(accountLabel: string | null): Promise<vscode.AuthenticationSessionAccountInformation | undefined> {
		if (!accountLabel) {
			return undefined;
		}

		try {
			const githubAccounts = await vscode.authentication.getAccounts(GITHUB_AUTH_PROVIDER_ID);
			const normalizedLabel = accountLabel.trim().toLowerCase();
			return githubAccounts.find((account) => account.label.trim().toLowerCase() === normalizedLabel);
		} catch {
			return undefined;
		}
	}

	private async resolveCopilotChatBoundGitHubAccount(): Promise<vscode.AuthenticationSessionAccountInformation | undefined> {
		try {
			const copilotChatSession = await vscode.authentication.getSession(
				COPILOT_CHAT_AUTH_PROVIDER_ID,
				[],
				{ createIfNone: false },
			);
			const copilotChatAccount = copilotChatSession?.account;
			if (copilotChatAccount) {
				const githubAccounts = await vscode.authentication.getAccounts(GITHUB_AUTH_PROVIDER_ID);
				const matchedAccount = githubAccounts.find((account) => {
					if (copilotChatAccount.id && account.id === copilotChatAccount.id) {
						return true;
					}

					return account.label.trim().toLowerCase() === copilotChatAccount.label.trim().toLowerCase();
				});
				if (matchedAccount) {
					return matchedAccount;
				}
			}
		} catch {
			// fall through to usage fallback below
		}

		const usageLabel = await this.resolveCopilotChatGitHubUsageAccountLabel();
		return await this.resolveGitHubAccountByLabel(usageLabel);
	}

	/**
	 * Получает GitHub сессию через VS Code Authentication API.
	 * @param createIfNone — создавать ли новую сессию, если её нет
	 * @returns Сессия или null, если пользователь не авторизован
	 */
	private async getGitHubSession(createIfNone: boolean = false): Promise<vscode.AuthenticationSession | null> {
		const ts = new Date().toISOString();

		// Приоритет:
		// 1. Явный выбор пользователя (через кнопку "Сменить аккаунт") — высший приоритет
		// 2. Account preference Copilot Chat
		// 3. Последний реально использованный GitHub-аккаунт Copilot Chat
		// 4. Живая сессия Copilot Chat — fallback
		// 5. DB preference / кэш — fallback
		let preferredAccount: vscode.AuthenticationSessionAccountInformation | undefined;
		let source = 'none';

		if (this.userExplicitAccountChoice) {
			preferredAccount = await this.resolveGitHubAccountByLabel(this.userExplicitAccountChoice);
			if (preferredAccount) {
				source = `explicit:${this.userExplicitAccountChoice}`;
			}
		}

		if (!preferredAccount) {
			const copilotPreference = this.lastKnownCopilotGitHubPreference === undefined
				? await this.resolveCopilotPreferredGitHubAccountLabel()
				: this.lastKnownCopilotGitHubPreference;
			preferredAccount = await this.resolveGitHubAccountByLabel(copilotPreference);
			if (preferredAccount) {
				source = `copilot-preference:${preferredAccount.label}`;
			}
		}

		if (!preferredAccount) {
			const usageAccountLabel = await this.resolveCopilotChatGitHubUsageAccountLabel();
			preferredAccount = await this.resolveGitHubAccountByLabel(usageAccountLabel);
			if (preferredAccount) {
				source = `copilot-usage:${preferredAccount.label}`;
			}
		}

		if (!preferredAccount) {
			const copilotChatBound = await this.resolveCopilotChatBoundGitHubAccount();
			if (copilotChatBound) {
				preferredAccount = copilotChatBound;
				source = `copilot-chat-live:${copilotChatBound.label}`;
			}
		}

		if (!preferredAccount) {
			const fallbackLabel = this.lastKnownCopilotGitHubPreference ?? null;
			preferredAccount = await this.resolveGitHubAccountByLabel(fallbackLabel);
			source = `fallback:${fallbackLabel || 'none'}`;
		}

		appendPromptManagerLog(
			`[${ts}] [getSession] source=${source!}, preferred=${preferredAccount?.label || 'none'}, explicitChoice=${this.userExplicitAccountChoice || 'none'}, createIfNone=${createIfNone}`,
		);

		this.lastGitHubSessionIssue = null;
		if (preferredAccount && !this.userExplicitAccountChoice) {
			this.lastKnownCopilotGitHubPreference = preferredAccount.label;
		}
		// Не перезаписывать PM preference, если пользователь явно выбрал аккаунт
		if (!this.userExplicitAccountChoice) {
			await this.syncPromptManagerGitHubPreference(preferredAccount, createIfNone);
		}
		const scopesVariants: string[][] = [
			['repo', 'workflow', 'user:email', 'read:user'],
			['read:user', 'user:email'],
			['read:user'],
			['user'],
			['read:user', 'read:org'],
			['user', 'read:org'],
			[],
		];

		for (const scopes of scopesVariants) {
			try {
				let session = await vscode.authentication.getSession(
					GITHUB_AUTH_PROVIDER_ID,
					scopes,
					{
						createIfNone: createIfNone && scopes === scopesVariants[0],
						...(preferredAccount ? { account: preferredAccount } : {}),
					},
				);
				if (!this.isSameGitHubAccount(session, preferredAccount) && preferredAccount) {
					appendPromptManagerLog(
						`[${new Date().toISOString()}] [copilot-usage.auth] getSession returned account ${session?.account.label || 'none'} instead of preferred ${preferredAccount.label}`,
					);
					session = await this.retryGitHubSessionWithClearedPreference(
						scopes,
						preferredAccount,
						createIfNone && scopes === scopesVariants[0],
					) ?? session;
				}
				if (!this.isSameGitHubAccount(session, preferredAccount) && preferredAccount) {
					this.lastGitHubSessionIssue = `github-session-account-mismatch: expected=${preferredAccount.label}; actual=${session?.account.label || 'none'}`;
					appendPromptManagerLog(
						`[${new Date().toISOString()}] [getSession] scopes=[${scopes.join(',')}] MISMATCH expected=${preferredAccount.label} actual=${session?.account.label || 'none'} — trying next scopes`,
					);
					continue;
				}
				if (session) {
					appendPromptManagerLog(
						`[${new Date().toISOString()}] [getSession] SUCCESS scopes=[${scopes.join(',')}] account=${session.account.label}`,
					);
					return session;
				}
			} catch (err) {
				appendPromptManagerLog(
					`[${new Date().toISOString()}] [getSession] scopes=[${scopes.join(',')}] ERROR: ${String(err)}`,
				);
				// try next scope variant
			}
		}

		if (!createIfNone) {
			if (preferredAccount && !this.lastGitHubSessionIssue) {
				this.lastGitHubSessionIssue = `github-session-not-accessible-for-preferred-account: ${preferredAccount.label}`;
			}

			return null;
		}

		try {
			const session = await vscode.authentication.getSession(
				GITHUB_AUTH_PROVIDER_ID,
				['repo', 'workflow', 'user:email', 'read:user'],
				{
					createIfNone: true,
					...(preferredAccount ? { account: preferredAccount } : {}),
				},
			);
			if (!this.isSameGitHubAccount(session, preferredAccount) && preferredAccount) {
				this.lastGitHubSessionIssue = `github-session-account-mismatch-after-create: expected=${preferredAccount.label}; actual=${session?.account.label || 'none'}`;
				return null;
			}
			return session;
		} catch {
			if (preferredAccount) {
				this.lastGitHubSessionIssue = `github-session-create-failed-for-preferred-account: ${preferredAccount.label}`;
			}
			return null;
		}
	}

	/**
	 * Выполняет HTTP GET запрос к GitHub API.
	 * @param url — URL эндпоинта
	 * @param token — OAuth токен авторизации
	 * @returns Ответ API или null при ошибке
	 */
	private async fetchGitHubApi<T>(url: string, token: string): Promise<{ ok: boolean; status: number; data: T | null; message?: string; authError: boolean }> {
		try {
			const response = await fetch(url, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${token}`,
					'Accept': 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
				},
			});

			const rawText = await response.text();
			let data: T | null = null;
			let message = '';
			if (rawText.trim()) {
				try {
					data = JSON.parse(rawText) as T;
					if (data && typeof data === 'object') {
						const maybeMessage = (data as Record<string, unknown>)['message'];
						if (typeof maybeMessage === 'string') {
							message = maybeMessage;
						}
					}
				} catch {
					message = rawText.trim();
				}
			}

			return {
				ok: response.ok,
				status: response.status,
				data,
				message,
				authError: this.isAuthenticationFailure(response.status, message),
			};
		} catch {
			return { ok: false, status: 0, data: null, message: 'network-error', authError: false };
		}
	}

	/**
	 * Получает информацию о Copilot подписке пользователя.
	 * Endpoint: GET /user/copilot
	 */
	private async fetchCopilotSubscription(token: string): Promise<{ planType: string; seatManagementSetting?: string } | null> {
		// Пробуем получить информацию о подписке Copilot
		const response = await this.fetchGitHubApi<Record<string, unknown>>(
			'https://api.github.com/user/copilot',
			token,
		);
		const data = response.data;

		if (!response.ok || !data) {
			return null;
		}

		// Извлекаем тип плана из ответа API
		const planType = String(data['plan_type'] || data['copilot_plan_type'] || 'unknown');
		const seatManagementSetting = String(data['seat_management_setting'] || '');

		return { planType, seatManagementSetting };
	}

	private mapInternalPlan(planRaw: string): string {
		switch ((planRaw || '').toLowerCase()) {
			case 'free':
				return 'Free';
			case 'individual':
				return 'Pro';
			case 'individual_pro':
				return 'Pro+';
			case 'business':
				return 'Business';
			case 'enterprise':
				return 'Enterprise';
			default:
				return planRaw || 'unknown';
		}
	}

	private async fetchCopilotInternalQuota(token: string): Promise<CopilotUsageMetricsFetchResult | null> {
		try {
			const response = await fetch('https://api.github.com/copilot_internal/user', {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${token}`,
					'Accept': 'application/json',
					'X-GitHub-Api-Version': '2025-05-01',
					'User-Agent': 'copilot-prompt-manager-vscode',
				},
			});

			const rawText = await response.text();
			let data: Record<string, unknown> | null = null;
			let message = '';
			if (rawText.trim()) {
				try {
					data = JSON.parse(rawText) as Record<string, unknown>;
					const maybeMessage = data['message'];
					if (typeof maybeMessage === 'string') {
						message = maybeMessage;
					}
				} catch {
					message = rawText.trim();
				}
			}

			if (!response.ok) {
				if (this.isAuthenticationFailure(response.status, message)) {
					return {
						kind: 'auth-error',
						statusText: `github-auth-error:${this.formatApiStatus('api:copilot_internal/user', response.status, message)}`,
					};
				}
				return null;
			}

			if (!data) {
				return null;
			}
			const quotaSnapshots = data['quota_snapshots'];
			if (!quotaSnapshots || typeof quotaSnapshots !== 'object') {
				return null;
			}
			const premium = (quotaSnapshots as Record<string, unknown>)['premium_interactions'];
			if (!premium || typeof premium !== 'object') {
				return null;
			}

			const premiumRecord = premium as Record<string, unknown>;
			const entitlement = Number(premiumRecord['entitlement'] || 0);
			const percentRemaining = Number(premiumRecord['percent_remaining'] || 0);
			if (!Number.isFinite(entitlement) || entitlement <= 0 || !Number.isFinite(percentRemaining)) {
				return null;
			}

			const used = Math.max(0, Math.round(entitlement * (1 - (percentRemaining / 100))));
			const planRaw = String(data['copilot_plan'] || '');
			const planType = this.mapInternalPlan(planRaw);
			return {
				kind: 'metrics',
				used,
				limit: entitlement,
				source: 'api',
				planType,
				statusText: 'api:copilot_internal/user',
			};
		} catch {
			return null;
		}
	}

	private async fetchCopilotBillingPremiumUsage(token: string): Promise<CopilotUsageMetricsFetchResult | null> {
		try {
			const user = await this.fetchGitHubApi<Record<string, unknown>>('https://api.github.com/user', token);
			if (!user.ok || !user.data) {
				if (user.authError) {
					return {
						kind: 'auth-error',
						statusText: `github-auth-error:${this.formatApiStatus('api:user', user.status, user.message)}`,
					};
				}
				return null;
			}
			const login = String(user.data['login'] || '').trim();
			if (!login) {
				return null;
			}

			const url = `https://api.github.com/users/${encodeURIComponent(login)}/settings/billing/premium_request/usage`;
			const billing = await this.fetchGitHubApi<Record<string, unknown>>(url, token);
			if (!billing.ok || !billing.data) {
				if (billing.authError) {
					return {
						kind: 'auth-error',
						statusText: `github-auth-error:${this.formatApiStatus('api:billing/premium_request/usage', billing.status, billing.message)}`,
					};
				}
				return null;
			}

			const used = Number(billing.data['total_premium_requests_used'] || 0);
			const limit = Number(billing.data['monthly_included_premium_requests'] || 0);
			if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
				return null;
			}

			return {
				kind: 'metrics',
				used,
				limit,
				source: 'api',
				statusText: 'api:billing/premium_request/usage',
			};
		} catch {
			return null;
		}
	}

	/**
	 * Получает данные об использовании Copilot через внутренний API.
	 * Пробует несколько эндпоинтов, т.к. API может измениться.
	 */
	private extractFirstNumber(data: unknown, keys: string[]): number | null {
		if (!data || typeof data !== 'object') {
			return null;
		}

		const record = data as Record<string, unknown>;
		for (const key of keys) {
			const value = record[key];
			if (typeof value === 'number' && Number.isFinite(value)) {
				return value;
			}
		}

		for (const value of Object.values(record)) {
			if (Array.isArray(value)) {
				for (const item of value) {
					const nested = this.extractFirstNumber(item, keys);
					if (nested !== null) {
						return nested;
					}
				}
			} else if (value && typeof value === 'object') {
				const nested = this.extractFirstNumber(value, keys);
				if (nested !== null) {
					return nested;
				}
			}
		}

		return null;
	}

	private extractNumberByPredicate(
		data: unknown,
		predicate: (key: string) => boolean,
	): number | null {
		if (!data || typeof data !== 'object') {
			return null;
		}

		const values: number[] = [];
		const walk = (node: unknown): void => {
			if (!node || typeof node !== 'object') {
				return;
			}
			if (Array.isArray(node)) {
				for (const item of node) {
					walk(item);
				}
				return;
			}
			for (const [key, value] of Object.entries(node)) {
				if (typeof value === 'number' && Number.isFinite(value) && predicate(key.toLowerCase())) {
					values.push(value);
				}
				if (value && typeof value === 'object') {
					walk(value);
				}
			}
		};

		walk(data);
		if (values.length === 0) {
			return null;
		}
		return Math.max(...values);
	}

	private collectSnapshotsFromData(data: unknown): Array<{ date: string; used: number; limit: number }> {
		if (!Array.isArray(data)) {
			return [];
		}

		const snapshots: Array<{ date: string; used: number; limit: number }> = [];
		for (const item of data) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const rec = item as Record<string, unknown>;
			const date = String(rec['date'] || rec['day'] || rec['created_at'] || '');
			const used = Number(rec['used'] || rec['premium_requests_used'] || rec['total_premium_chat_turns'] || 0);
			const limit = Number(rec['limit'] || rec['premium_requests_limit'] || rec['monthly_limit'] || 0);
			if (!date || !Number.isFinite(used)) {
				continue;
			}
			snapshots.push({ date, used, limit: Number.isFinite(limit) ? limit : 0 });
		}

		return snapshots;
	}

	private mergeSnapshot(used: number, limit: number): Array<{ date: string; used: number; limit: number }> {
		const base = [...(this.cachedData?.snapshots || [])];
		const today = new Date().toISOString().slice(0, 10);
		const existingIndex = base.findIndex(item => item.date.slice(0, 10) === today);
		if (existingIndex >= 0) {
			base[existingIndex] = {
				...base[existingIndex],
				used: Math.max(base[existingIndex].used, used),
				limit: limit || base[existingIndex].limit,
			};
		} else {
			base.push({ date: today, used, limit });
		}

		return base
			.sort((a, b) => a.date.localeCompare(b.date))
			.slice(-62);
	}

	/**
	 * Нормализует и дедуплицирует массив snapshot-записей.
	 * Обеспечивает монотонный рост used внутри последовательности дней,
	 * не зажимая исторические значения до текущего currentUsed.
	 */
	private sanitizeSnapshots(
		snapshots: Array<{ date: string; used: number; limit: number }>,
		_currentUsed: number,
		currentLimit: number,
	): Array<{ date: string; used: number; limit: number }> {
		if (!Array.isArray(snapshots) || snapshots.length === 0) {
			return [];
		}

		/** Нормализация: извлекаем дату, фильтруем невалидные записи */
		const normalized = snapshots
			.map((item) => {
				const dateOnly = String(item.date || '').slice(0, 10);
				const rawUsed = Number(item.used);
				const rawLimit = Number(item.limit);
				if (!dateOnly || !Number.isFinite(rawUsed)) {
					return null;
				}
				return {
					date: dateOnly,
					used: Math.max(0, rawUsed),
					limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : currentLimit,
				};
			})
			.filter((item): item is { date: string; used: number; limit: number } => !!item)
			.sort((a, b) => a.date.localeCompare(b.date));

		/** Дедупликация по дате — сохраняем запись с максимальным used */
		const dedup = new Map<string, { date: string; used: number; limit: number }>();
		for (const item of normalized) {
			const existing = dedup.get(item.date);
			if (!existing || item.used > existing.used) {
				dedup.set(item.date, item);
			}
		}

		/** Обеспечиваем монотонный рост used по дням ВНУТРИ одного месяца.
		 *  При переходе на новый месяц или при явном падении used (более чем на 50%)
		 *  сбрасываем baseline, чтобы не «надувать» дельты после reset месяца. */
		const result: Array<{ date: string; used: number; limit: number }> = [];
		let prevUsed = 0;
		let prevMonth = '';
		for (const item of Array.from(dedup.values()).sort((a, b) => a.date.localeCompare(b.date))) {
			const month = item.date.slice(0, 7);
			const monthChanged = month !== prevMonth;
			const looksLikeMonthReset = !monthChanged && prevUsed > 0 && item.used < prevUsed * 0.5;
			if (monthChanged || looksLikeMonthReset) {
				prevUsed = 0;
			}
			const used = Math.max(prevUsed, item.used);
			result.push({ ...item, used });
			prevUsed = used;
			prevMonth = month;
		}

		return result.slice(-62);
	}

	/**
	 * Заполняет пропуски между snapshot-днями методом forward-fill.
	 * Для каждого пропущенного дня ставит used = значение предыдущего дня.
	 * Гарантирует, что DailyBars получит корректные delta между последовательными днями.
	 */
	private fillSnapshotGaps(
		snapshots: Array<{ date: string; used: number; limit: number }>,
	): Array<{ date: string; used: number; limit: number }> {
		if (snapshots.length <= 1) {
			return snapshots;
		}

		const result: Array<{ date: string; used: number; limit: number }> = [];
		for (let i = 0; i < snapshots.length; i++) {
			const current = snapshots[i];
			result.push(current);

			/** Если есть следующий snapshot, заполняем дни между текущим и следующим */
			if (i < snapshots.length - 1) {
				const next = snapshots[i + 1];
				const currentDate = new Date(current.date + 'T00:00:00');
				const nextDate = new Date(next.date + 'T00:00:00');
				const gapDays = Math.round((nextDate.getTime() - currentDate.getTime()) / (1000 * 60 * 60 * 24));

				/** Вставляем пропущенные дни с used = текущим значением (forward-fill) */
				for (let dayOffset = 1; dayOffset < gapDays; dayOffset++) {
					const fillDate = new Date(currentDate);
					fillDate.setDate(fillDate.getDate() + dayOffset);
					const fillDateStr = fillDate.toISOString().slice(0, 10);
					result.push({ date: fillDateStr, used: current.used, limit: current.limit });
				}
			}
		}

		/** Заполняем от последнего snapshot до сегодня */
		const last = result[result.length - 1];
		const today = new Date().toISOString().slice(0, 10);
		if (last && last.date < today) {
			const lastDate = new Date(last.date + 'T00:00:00');
			const todayDate = new Date(today + 'T00:00:00');
			const gapDays = Math.round((todayDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
			for (let dayOffset = 1; dayOffset <= gapDays; dayOffset++) {
				const fillDate = new Date(lastDate);
				fillDate.setDate(fillDate.getDate() + dayOffset);
				const fillDateStr = fillDate.toISOString().slice(0, 10);
				result.push({ date: fillDateStr, used: last.used, limit: last.limit });
			}
		}

		return result.slice(-62);
	}

	private async fetchCopilotUsageMetrics(token: string): Promise<CopilotUsageMetricsFetchResult | null> {
		const internal = await this.fetchCopilotInternalQuota(token);
		if (internal) {
			return internal;
		}

		const billing = await this.fetchCopilotBillingPremiumUsage(token);
		if (billing) {
			return billing;
		}

		// Эндпоинты для получения данных об использовании (пробуем по порядку)
		const endpoints = [
			'https://api.github.com/user/copilot/usage',
			'https://api.github.com/user/copilot/metrics',
			'https://api.github.com/user/copilot/billing',
			'https://api.github.com/user/copilot',
			'https://api.github.com/copilot_internal/v2/user_monthly_usage',
		];
		const statuses: string[] = [];

		for (const url of endpoints) {
			const response = await this.fetchGitHubApi<Record<string, unknown> | Array<Record<string, unknown>>>(url, token);
			const statusChunk = this.formatApiStatus(url, response.status, response.message);
			statuses.push(statusChunk);
			if (response.authError) {
				return {
					kind: 'auth-error',
					statusText: `github-auth-error:${statuses.join('; ')}`,
				};
			}
			if (!response.ok || !response.data) {
				continue;
			}

			const data = response.data;
			const used = this.extractFirstNumber(data, [
				'premium_requests_used',
				'premium_chat_requests_used',
				'total_premium_chat_turns',
				'total_premium_requests',
				'used',
				'quota_used',
			]);
			const limit = this.extractFirstNumber(data, [
				'premium_requests_limit',
				'premium_chat_requests_limit',
				'monthly_limit',
				'limit',
				'quota_limit',
				'quota_total',
				'included_premium_requests',
			]);

			const usedResolved = used ?? this.extractNumberByPredicate(
				data,
				(key) => key.includes('used') && (key.includes('premium') || key.includes('quota') || key.includes('chat')),
			);
			const limitResolved = limit ?? this.extractNumberByPredicate(
				data,
				(key) =>
					(key.includes('limit') || key.includes('total') || key.includes('quota'))
					&& (key.includes('premium') || key.includes('quota') || key.includes('chat')),
			);

			if (usedResolved !== null && limitResolved !== null && limitResolved > 0) {
				return {
					kind: 'metrics',
					used: usedResolved,
					limit: limitResolved,
					source: 'api',
					snapshots: this.collectSnapshotsFromData(data),
					statusText: statuses.join('; '),
				};
			}

			if (usedResolved !== null && usedResolved > 0) {
				return {
					kind: 'metrics',
					used: usedResolved,
					limit: 0,
					source: 'inferred',
					snapshots: this.collectSnapshotsFromData(data),
					statusText: statuses.join('; '),
				};
			}
		}

		return null;
	}

	/**
	 * Определяет лимит запросов на основе типа подписки.
	 * Значения могут быть переопределены пользователем в настройках.
	 */
	private resolveLimit(planType: string): number {
		// Проверяем пользовательские настройки
		const config = vscode.workspace.getConfiguration('promptManager');
		const customLimit = config.get<number>('copilotPremiumRequestsLimit', 0);

		if (customLimit > 0) {
			return customLimit;
		}

		// Значения по умолчанию на основе типа подписки
		switch (planType.toLowerCase()) {
			case 'pro':
			case 'individual':
				return 300;
			case 'pro+':
			case 'proplus':
				return 1500;
			case 'business':
				return 300;
			case 'enterprise':
				return 1000;
			default:
				return 300; // Значение по умолчанию
		}
	}

	/**
	 * Вычисляет границы текущего периода (месяца).
	 * @returns Начало и конец текущего месяца (ISO строки)
	 */
	private getCurrentPeriod(): { start: string; end: string } {
		const now = new Date();
		const start = new Date(now.getFullYear(), now.getMonth(), 1);
		const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

		return {
			start: start.toISOString(),
			end: end.toISOString(),
		};
	}

	/**
	 * Вычисляет среднее количество запросов в день.
	 * @param used — количество использованных запросов
	 * @param periodStart — начало периода (ISO строка)
	 */
	private calculateAvgPerDay(used: number, periodStart: string): number {
		const start = new Date(periodStart);
		const now = new Date();
		const daysPassed = Math.max(1, Math.ceil((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
		return Math.round((used / daysPassed) * 10) / 10;
	}

	private getCurrentLocalDateIso(): string {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, '0');
		const day = String(now.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	/** Определяет, что ответ GitHub API указывает именно на проблему входа. */
	private isAuthenticationFailure(status: number, message?: string): boolean {
		if (status === 401) {
			return true;
		}

		if (status !== 403) {
			return false;
		}

		const normalizedMessage = String(message || '').trim().toLowerCase();
		if (!normalizedMessage) {
			return false;
		}

		return normalizedMessage.includes('bad credentials')
			|| normalizedMessage.includes('requires authentication')
			|| normalizedMessage.includes('require authentication')
			|| normalizedMessage.includes('must authenticate')
			|| normalizedMessage.includes('authentication required')
			|| normalizedMessage.includes('invalid token')
			|| normalizedMessage.includes('expired token');
	}

	/** Приводит статус API к компактному диагностическому виду. */
	private formatApiStatus(source: string, status: number, message?: string): string {
		const normalizedMessage = String(message || '').trim();
		return normalizedMessage
			? `${source} -> ${status} (${normalizedMessage})`
			: `${source} -> ${status}`;
	}

	/** Собирает состояние без авторизации, чтобы UI не показывал устаревший usage. */
	private buildUnauthenticatedUsageData(statusText: string): CopilotUsageData {
		const period = this.getCurrentPeriod();
		return {
			used: 0,
			limit: 0,
			periodStart: period.start,
			periodEnd: period.end,
			lastUpdated: new Date().toISOString(),
			avgPerDay: 0,
			authenticated: false,
			planType: this.cachedData?.planType || 'unknown',
			source: 'local',
			lastSyncStatus: statusText,
			snapshots: this.cachedData?.snapshots || [],
		};
	}

	/**
	 * Проверяет, нужно ли сбросить счётчик (новый месяц).
	 */
	private shouldResetCounter(): boolean {
		if (!this.cachedData) {
			return false;
		}

		const savedPeriodStart = new Date(this.cachedData.periodStart);
		const currentPeriod = this.getCurrentPeriod();
		const currentPeriodStart = new Date(currentPeriod.start);

		return savedPeriodStart.getTime() !== currentPeriodStart.getTime();
	}

	/**
	 * Основной метод получения данных об использовании.
	 * Сначала пробует GitHub API, затем использует локальный кэш.
	 * @param forceRefresh — принудительное обновление (игнорируя кэш)
	 * @returns Данные об использовании
	 */
	async fetchUsage(forceRefresh: boolean = false): Promise<CopilotUsageData> {
		const copilotPreferenceChanged = await this.refreshCopilotGitHubPreference();
		if (copilotPreferenceChanged) {
			forceRefresh = true;
			this.lastApiCallTimestamp = 0;
			this.lastFullRefreshTimestamp = 0;
		}

		const now = Date.now();
		const fullRefreshThrottled = !forceRefresh
			&& !!this.cachedData
			&& (now - this.lastFullRefreshTimestamp) < MIN_FULL_REFRESH_INTERVAL_MS;
		if (fullRefreshThrottled && this.cachedData) {
			this.lastDebugLog = this.formatDebugLog([
				`[fetch] forceRefresh=${forceRefresh} fullRefreshThrottled=true now=${new Date(now).toISOString()}`,
				`[auth] copilotPreference=${this.lastKnownCopilotGitHubPreference || 'none'} changed=${copilotPreferenceChanged}`,
				`[cache] reuse-throttled-full-refresh ageMs=${now - this.lastFullRefreshTimestamp}`,
				`[result] used=${this.cachedData.used} limit=${this.cachedData.limit} source=${this.cachedData.source} planType=${this.cachedData.planType}`,
			]);
			return this.cachedData;
		}

		const minApiInterval = this.cachedData?.source === 'api'
			? MIN_API_CALL_INTERVAL_MS
			: 5 * 1000;
		const shouldCallApi = forceRefresh || (now - this.lastApiCallTimestamp) >= minApiInterval;
		const debugLines: string[] = [];
		debugLines.push(`[fetch] forceRefresh=${forceRefresh} shouldCallApi=${shouldCallApi} minApiIntervalMs=${minApiInterval} now=${new Date(now).toISOString()}`);
		debugLines.push(`[auth] copilotPreference=${this.lastKnownCopilotGitHubPreference || 'none'} changed=${copilotPreferenceChanged}`);

		// Защита от параллельных запросов
		if (this.isFetching) {
			if (forceRefresh) {
				appendPromptManagerLog(`[${new Date().toISOString()}] [fetch] waiting for in-flight request before force refresh`);
				await this.waitForFetchToFinish(10_000);
			}
			if (this.isFetching && this.cachedData) {
				return this.cachedData;
			}
		}

		if (!forceRefresh && !shouldCallApi && this.cachedData?.authenticated && this.cachedData.source === 'api') {
			const cachedApiData: CopilotUsageData = {
				...this.cachedData,
				lastUpdated: new Date().toISOString(),
				lastSyncStatus: `${this.cachedData.lastSyncStatus || 'api-cache'}; cache-reuse`,
			};
			this.cachedData = cachedApiData;
			debugLines.push('[cache] reuse-last-api-snapshot');
			debugLines.push(`[result] used=${cachedApiData.used} limit=${cachedApiData.limit} source=${cachedApiData.source} planType=${cachedApiData.planType}`);
			this.lastDebugLog = this.formatDebugLog(debugLines);
			this.lastFullRefreshTimestamp = now;
			this._onDidChangeUsage.fire(cachedApiData);
			return cachedApiData;
		}

		this.isFetching = true;

		try {
			const session = await this.getGitHubSession(false);
			debugLines.push(`[auth] session=${session ? 'yes' : 'no'}`);

			// Если пользователь не авторизован — возвращаем данные без авторизации
			if (!session) {
				const unauthData = this.buildUnauthenticatedUsageData(
					this.lastGitHubSessionIssue || 'github-session-not-found',
				);
				this.cachedData = unauthData;
				this.lastKnownAuthenticated = false;
				this.lastDebugLog = this.formatDebugLog(debugLines.concat('[result] unauthenticated'));
				this.lastFullRefreshTimestamp = now;
				this._onDidChangeUsage.fire(unauthData);
				return unauthData;
			}
			this.lastKnownAuthenticated = true;

			// Получаем данные о подписке
			const subscription = shouldCallApi
				? await this.fetchCopilotSubscription(session.accessToken)
				: null;
			let planType = subscription?.planType || 'unknown';
			debugLines.push(`[subscription] planType=${planType}`);

			// Получаем данные об использовании из API
			const usageMetricsResult = shouldCallApi
				? await this.fetchCopilotUsageMetrics(session.accessToken)
				: null;
			const usageMetrics = usageMetricsResult?.kind === 'metrics'
				? usageMetricsResult
				: null;
			const usageAuthError = usageMetricsResult?.kind === 'auth-error'
				? usageMetricsResult.statusText
				: null;
			debugLines.push(`[api] usageMetrics=${usageMetrics
				? `used=${usageMetrics.used},limit=${usageMetrics.limit},source=${usageMetrics.source}`
				: usageAuthError || 'none'}`);
			if (shouldCallApi) {
				this.lastApiCallTimestamp = now;
			}
			if (usageAuthError) {
				this.lastGitHubSessionIssue = usageAuthError;
				const unauthData = this.buildUnauthenticatedUsageData(usageAuthError);
				this.cachedData = unauthData;
				this.lastKnownAuthenticated = false;
				this.lastDebugLog = this.formatDebugLog(debugLines.concat(`[result] unauthenticated-auth-error:${usageAuthError}`));
				this.lastFullRefreshTimestamp = now;
				await this.persistState();
				this._onDidChangeUsage.fire(unauthData);
				return unauthData;
			}
			const localUsageMetrics = !usageMetrics
				? await this.readLocalUsageFromStateDb()
				: null;
			debugLines.push(`[local-db] usage=${localUsageMetrics ? `used=${localUsageMetrics.used},limit=${localUsageMetrics.limit},status=${localUsageMetrics.status}` : 'none'}`);
			const chatSignal = await this.readWorkspaceChatActivitySignal();
			debugLines.push(`[chat-signal] changedSessions=${chatSignal.changedSessions} maxLastMessageDate=${chatSignal.maxLastMessageDate}`);
			const period = this.getCurrentPeriod();
			const chatRequestsTotal = await this.countChatRequestsCurrentPeriod(period.start);
			debugLines.push(`[chat-requests] total=${chatRequestsTotal} periodStart=${period.start}`);

			if (planType === 'unknown' && this.cachedData?.planType) {
				planType = this.cachedData.planType;
			}
			if (usageMetrics?.planType && planType === 'unknown') {
				planType = usageMetrics.planType;
			}
			if (localUsageMetrics?.planType && planType === 'unknown') {
				planType = localUsageMetrics.planType;
			}

			const limit = usageMetrics?.limit && usageMetrics.limit > 0
				? usageMetrics.limit
				: localUsageMetrics?.limit && localUsageMetrics.limit > 0
					? localUsageMetrics.limit
					: this.resolveLimit(planType);
			const samePeriod = !this.shouldResetCounter();
			const cachedUsed = this.cachedData?.authenticated && samePeriod
				? (this.cachedData.used || 0)
				: 0;

			// Сброс счётчика при начале нового периода
			let used: number;
			if (usageMetrics) {
				used = usageMetrics.used;
			} else if (localUsageMetrics) {
				used = localUsageMetrics.used;
			} else if (this.shouldResetCounter()) {
				used = 0;
			} else {
				used = this.cachedData?.used ?? 0;
			}
			if (!usageMetrics && samePeriod) {
				used = Math.max(used, cachedUsed);
				debugLines.push(`[guard-nondecrease] cachedUsed=${cachedUsed} afterGuard=${used}`);
			}

			if (!usageMetrics && chatSignal.changedSessions > 0 && this.cachedData?.authenticated) {
				const bumped = (this.cachedData.used || 0) + chatSignal.changedSessions;
				used = Math.max(used, bumped);
				debugLines.push(`[bump-chat-signal] cachedUsed=${this.cachedData.used} bumped=${bumped} finalUsed=${used}`);
			}

			const baseTotal = this.context.globalState.get<number>(CHAT_REQUESTS_BASE_TOTAL_KEY);
			const baseUsed = this.context.globalState.get<number>(CHAT_REQUESTS_BASE_USED_KEY);
			debugLines.push(`[base] baseTotal=${baseTotal ?? 'undefined'} baseUsed=${baseUsed ?? 'undefined'}`);
			if (baseTotal === undefined || baseUsed === undefined || this.shouldResetCounter()) {
				await this.context.globalState.update(CHAT_REQUESTS_BASE_TOTAL_KEY, chatRequestsTotal);
				await this.context.globalState.update(CHAT_REQUESTS_BASE_USED_KEY, used);
				debugLines.push(`[base-update] set baseTotal=${chatRequestsTotal} baseUsed=${used}`);
			} else {
				let effectiveBaseTotal = baseTotal;
				let effectiveBaseUsed = baseUsed;

				if (!usageMetrics && localUsageMetrics) {
					const expectedFromBase = baseUsed + Math.max(0, chatRequestsTotal - baseTotal);
					if (localUsageMetrics.used > expectedFromBase) {
						await this.context.globalState.update(CHAT_REQUESTS_BASE_TOTAL_KEY, chatRequestsTotal);
						await this.context.globalState.update(CHAT_REQUESTS_BASE_USED_KEY, localUsageMetrics.used);
						used = Math.max(used, localUsageMetrics.used);
						effectiveBaseTotal = chatRequestsTotal;
						effectiveBaseUsed = localUsageMetrics.used;
						debugLines.push(`[base-rebase] from expected=${expectedFromBase} to localUsed=${localUsageMetrics.used} at total=${chatRequestsTotal}`);
					}
				}

				const deltaRequests = Math.max(0, chatRequestsTotal - effectiveBaseTotal);
				if (!usageMetrics && deltaRequests > 0) {
					used = Math.max(used, effectiveBaseUsed + deltaRequests);
					debugLines.push(`[bump-chat-requests] delta=${deltaRequests} baseUsed=${effectiveBaseUsed} finalUsed=${used}`);
				}
			}

			const snapshotsFromApi = usageMetrics?.snapshots || [];
			const snapshotsRaw = snapshotsFromApi.length > 0
				? snapshotsFromApi.slice(-62)
				: this.mergeSnapshot(used, limit);
			const sanitized = this.sanitizeSnapshots(snapshotsRaw, used, limit);
			/** Заполняем пропущенные дни, чтобы DailyBars корректно считал delta */
			const snapshots = this.fillSnapshotGaps(sanitized);

			const data: CopilotUsageData = {
				used,
				limit,
				periodStart: period.start,
				periodEnd: period.end,
				lastUpdated: new Date().toISOString(),
				avgPerDay: this.calculateAvgPerDay(used, period.start),
				authenticated: true,
				planType,
				source: usageMetrics?.source || (localUsageMetrics ? 'inferred' : 'local'),
				lastSyncStatus: usageMetrics?.statusText
					|| localUsageMetrics?.status
					|| (shouldCallApi ? 'usage-endpoint-empty' : 'api-throttled-local-refresh'),
				snapshots,
			};

			if (!usageMetrics && chatSignal.changedSessions > 0) {
				data.lastSyncStatus = `${data.lastSyncStatus}; chat-signal:+${chatSignal.changedSessions}`;
			}
			if (!usageMetrics) {
				const baseTotal = this.context.globalState.get<number>(CHAT_REQUESTS_BASE_TOTAL_KEY, chatRequestsTotal);
				const deltaRequests = Math.max(0, chatRequestsTotal - baseTotal);
				data.lastSyncStatus = `${data.lastSyncStatus}; chat-requests:${chatRequestsTotal}; delta:${deltaRequests}`;
				debugLines.push(`[status] ${data.lastSyncStatus}`);
			}
			if (!usageMetrics && samePeriod) {
				data.used = Math.max(data.used, cachedUsed);
				debugLines.push(`[final-nondecrease] cachedUsed=${cachedUsed} finalUsed=${data.used}`);
			}

			debugLines.push(`[result] used=${data.used} limit=${data.limit} source=${data.source} planType=${data.planType}`);
			this.lastDebugLog = this.formatDebugLog(debugLines);
			this.lastFullRefreshTimestamp = now;

			this.cachedData = data;
			await this.persistState();
			this._onDidChangeUsage.fire(data);

			return data;
		} finally {
			this.isFetching = false;
		}
	}

	/**
	 * Инкрементирует счётчик использованных запросов.
	 * Вызывается при каждом использовании Premium Copilot запроса.
	 */
	async incrementUsage(): Promise<void> {
		if (!this.cachedData) {
			await this.fetchUsage();
		}

		if (this.cachedData && this.cachedData.authenticated) {
			// Сброс при новом месяце
			if (this.shouldResetCounter()) {
				this.cachedData.used = 0;
				const period = this.getCurrentPeriod();
				this.cachedData.periodStart = period.start;
				this.cachedData.periodEnd = period.end;
			}

			this.cachedData.used += 1;
			this.cachedData.lastUpdated = new Date().toISOString();
			this.cachedData.avgPerDay = this.calculateAvgPerDay(
				this.cachedData.used,
				this.cachedData.periodStart,
			);
			this.cachedData.source = 'local';
			this.cachedData.lastSyncStatus = this.cachedData.lastSyncStatus || 'local-increment';
			const today = this.getCurrentLocalDateIso();
			const history = [...this.cachedData.snapshots];
			const index = history.findIndex(item => item.date.slice(0, 10) === today);
			if (index >= 0) {
				history[index] = {
					...history[index],
					used: Math.max(history[index].used, this.cachedData.used),
					limit: this.cachedData.limit,
				};
			} else {
				history.push({ date: today, used: this.cachedData.used, limit: this.cachedData.limit });
			}
			this.cachedData.snapshots = history
				.sort((a, b) => a.date.localeCompare(b.date))
				.slice(-62);

			await this.persistState();
			this._onDidChangeUsage.fire(this.cachedData);
		}
	}

	/**
	 * Инициирует процесс авторизации через GitHub.
	 * Открывает диалог авторизации VS Code и запрашивает необходимые scopes.
	 */
	async authenticate(): Promise<boolean> {
		const session = await this.getGitHubSession(true);
		if (session) {
			this.lastKnownAuthenticated = true;
			await this.fetchUsage(true);
			return true;
		}
		return false;
	}

	getLastKnownAuthenticated(): boolean {
		return this.lastKnownAuthenticated;
	}

	/**
	 * Запускает автоматическое обновление данных по таймеру.
	 */
	startAutoRefresh(options?: { intervalMs?: number; forceRefresh?: boolean }): void {
		const intervalMs = options?.intervalMs ?? AUTO_REFRESH_INTERVAL_MS;
		const forceRefresh = options?.forceRefresh ?? false;
		this.stopAutoRefresh();
		this.autoRefreshTimer = setInterval(async () => {
			await this.fetchUsage(forceRefresh);
		}, intervalMs);
	}

	/**
	 * Останавливает автоматическое обновление данных.
	 */
	stopAutoRefresh(): void {
		if (this.autoRefreshTimer) {
			clearInterval(this.autoRefreshTimer);
			this.autoRefreshTimer = undefined;
		}
	}

	/**
	 * Возвращает кэшированные данные без запроса к API.
	 */
	getCachedData(): CopilotUsageData | null {
		return this.cachedData;
	}

	/**
	 * Процент использования запросов (0-100+).
	 */
	getUsagePercent(): number {
		if (!this.cachedData || this.cachedData.limit === 0) {
			return 0;
		}
		return Math.round((this.cachedData.used / this.cachedData.limit) * 100);
	}

	getLastDebugLog(): string {
		return this.lastDebugLog;
	}

	/**
	 * Освобождает ресурсы сервиса.
	 */
	dispose(): void {
		this.stopAutoRefresh();
		this.stopCopilotPreferencePolling();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this._onDidChangeUsage.dispose();
		this._onDidChangeAccountSwitchState.dispose();
	}
}
