/**
 * State service — persists UI state (sidebar filters, sort, last opened prompt, etc.)
 * Uses VS Code extension globalState and workspaceState.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SidebarState } from '../types/prompt.js';
import { createDefaultSidebarState } from '../types/prompt.js';

const execFileAsync = promisify(execFile);

const SIDEBAR_STATE_KEY = 'promptManager.sidebarState';
const LAST_PROMPT_KEY = 'promptManager.lastPromptId';
const GLOBAL_AGENT_CONTEXT_KEY = 'promptManager.globalAgentContext';

export class StateService {
	constructor(private readonly context: vscode.ExtensionContext) { }

	private getWorkspaceStateDbCandidates(): string[] {
		const candidates: string[] = [];

		const storageUriPath = this.context.storageUri?.fsPath;
		if (storageUriPath) {
			candidates.push(path.join(storageUriPath, '..', 'state.vscdb'));
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
		const candidates = this.getWorkspaceStateDbCandidates();

		for (const candidate of candidates) {
			if (candidate.endsWith('state.vscdb')) {
				try {
					await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
					return candidate;
				} catch {
					// continue
				}
				continue;
			}

			try {
				const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(candidate));
				const dbCandidates = entries
					.filter(([, type]) => type === vscode.FileType.Directory)
					.map(([name]) => path.join(candidate, name, 'state.vscdb'));

				for (const dbPath of dbCandidates) {
					try {
						await vscode.workspace.fs.stat(vscode.Uri.file(dbPath));
						return dbPath;
					} catch {
						// continue
					}
				}
			} catch {
				// continue
			}
		}

		return null;
	}

	private async readChatSessionStoreIndex(dbPath: string): Promise<any | null> {
		try {
			const sql = "SELECT value FROM ItemTable WHERE key='chat.ChatSessionStore.index' LIMIT 1;";
			const { stdout } = await execFileAsync('sqlite3', [dbPath, sql]);
			const raw = (stdout || '').trim();
			if (!raw) {
				return null;
			}
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}

	private async readWorkspaceItemValue(dbPath: string, key: string): Promise<string> {
		try {
			const sql = `SELECT value FROM ItemTable WHERE key='${this.escapeSql(key)}' LIMIT 1;`;
			const { stdout } = await execFileAsync('sqlite3', [dbPath, sql]);
			return (stdout || '').trim();
		} catch {
			return '';
		}
	}

	async getActiveChatSessionId(
		timeoutMs: number = 5000,
		pollIntervalMs: number = 250,
	): Promise<string> {
		const dbPath = await this.resolveWorkspaceStateDbPath();
		if (!dbPath) {
			return '';
		}

		const startedAt = Date.now();
		while (Date.now() - startedAt <= timeoutMs) {
			const keysToCheck = [
				'memento/interactive-session-view-copilot',
				'memento/interactive-session-view-agent',
				'memento/interactive-session',
			];

			for (const key of keysToCheck) {
				const raw = await this.readWorkspaceItemValue(dbPath, key);
				if (!raw) {
					continue;
				}

				try {
					const parsed = JSON.parse(raw);
					const direct = String(parsed?.sessionId || '').trim();
					if (direct) {
						return direct;
					}

					const historyCopilot = parsed?.history?.copilot;
					if (Array.isArray(historyCopilot) && historyCopilot.length > 0) {
						const candidate = String(historyCopilot[historyCopilot.length - 1]?.sessionId || '').trim();
						if (candidate) {
							return candidate;
						}
					}
				} catch {
					// continue with next key
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
			.filter((entry: any) => {
				const started = Number(entry?.timing?.lastRequestStarted || 0);
				return started >= referenceTimestampMs - 5000;
			})
			.sort((a: any, b: any) => Number(b?.timing?.lastRequestStarted || 0) - Number(a?.timing?.lastRequestStarted || 0));
	}

	async waitForChatSessionStarted(
		referenceTimestampMs: number,
		timeoutMs: number = 15000,
		pollIntervalMs: number = 500,
	): Promise<{ ok: boolean; sessionId?: string; lastRequestStarted?: number; dbPath?: string; reason?: string }> {
		const dbPath = await this.resolveWorkspaceStateDbPath();
		if (!dbPath) {
			return { ok: false, reason: 'workspace-db-not-found' };
		}

		const startedAt = Date.now();
		while (Date.now() - startedAt <= timeoutMs) {
			const index = await this.readChatSessionStoreIndex(dbPath);
			const sessions = this.getRecentChatSessionsFromIndex(index, referenceTimestampMs);
			const current = sessions[0];
			if (current) {
				const sessionId = String(current?.sessionId || '').trim();
				const lastRequestStarted = Number(current?.timing?.lastRequestStarted || 0);
				if (sessionId && lastRequestStarted > 0) {
					return { ok: true, sessionId, lastRequestStarted, dbPath };
				}
			}

			await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
		}

		return { ok: false, reason: 'timeout', dbPath };
	}

	async hasChatSession(sessionId: string): Promise<boolean> {
		const target = (sessionId || '').trim();
		if (!target) {
			return false;
		}

		const dbPath = await this.resolveWorkspaceStateDbPath();
		if (!dbPath) {
			return false;
		}

		const index = await this.readChatSessionStoreIndex(dbPath);
		const entries = index?.entries as Record<string, any> | undefined;
		if (!entries || typeof entries !== 'object') {
			return false;
		}

		return Object.values(entries).some((entry: any) => String(entry?.sessionId || '') === target);
	}

	async waitForChatRequestCompletion(
		referenceTimestampMs: number,
		timeoutMs: number = 180000,
		pollIntervalMs: number = 1000,
	): Promise<{
		ok: boolean;
		reason?: string;
		sessionId?: string;
		lastRequestStarted?: number;
		lastRequestEnded?: number;
		lastResponseState?: number;
		hasPendingEdits?: boolean;
		dbPath?: string;
	}> {
		const dbPath = await this.resolveWorkspaceStateDbPath();
		if (!dbPath) {
			return { ok: false, reason: 'workspace-db-not-found' };
		}

		const startedAt = Date.now();
		while (Date.now() - startedAt <= timeoutMs) {
			const index = await this.readChatSessionStoreIndex(dbPath);
			const sessions = this.getRecentChatSessionsFromIndex(index, referenceTimestampMs);
			const current = sessions[0];
			if (current) {
				const lastRequestStarted = Number(current?.timing?.lastRequestStarted || 0);
				const lastRequestEnded = Number(current?.timing?.lastRequestEnded || 0);
				const lastResponseState = Number(current?.lastResponseState ?? -1);
				const hasPendingEdits = Boolean(current?.hasPendingEdits);
				const finished = lastRequestEnded > lastRequestStarted && !hasPendingEdits && lastResponseState !== 2;

				if (finished) {
					return {
						ok: true,
						sessionId: String(current?.sessionId || ''),
						lastRequestStarted,
						lastRequestEnded,
						lastResponseState,
						hasPendingEdits,
						dbPath,
					};
				}
			}

			await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
		}

		return { ok: false, reason: 'timeout', dbPath };
	}

	private escapeSql(value: string): string {
		return value.replace(/'/g, "''");
	}

	async forcePersistChatCurrentLanguageModel(modelIdentifier: string): Promise<{ ok: boolean; reason?: string; dbPath?: string }> {
		if (!modelIdentifier) {
			return { ok: false, reason: 'empty-model' };
		}

		const dbPath = await this.resolveStateDbPath();
		if (!dbPath) {
			return { ok: false, reason: 'db-not-found' };
		}

		const model = this.escapeSql(modelIdentifier);
		const locations = ['panel', 'chat', 'editor', 'editorInline'];
		const sqlParts: string[] = ['PRAGMA busy_timeout=2000;'];
		for (const location of locations) {
			sqlParts.push(
				`INSERT INTO ItemTable(key, value) VALUES('chat.currentLanguageModel.${location}', '${model}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;`,
				`INSERT INTO ItemTable(key, value) VALUES('chat.currentLanguageModel.${location}.isDefault', 'false') ON CONFLICT(key) DO UPDATE SET value=excluded.value;`,
				`INSERT INTO ItemTable(key, value) VALUES('chat.currentLanguageModel.${location}.local', '${model}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;`,
				`INSERT INTO ItemTable(key, value) VALUES('chat.currentLanguageModel.${location}.local.isDefault', 'false') ON CONFLICT(key) DO UPDATE SET value=excluded.value;`
			);
		}
		const sql = sqlParts.join(' ');

		try {
			await execFileAsync('sqlite3', [dbPath, sql]);
			return { ok: true, dbPath };
		} catch (error: any) {
			return { ok: false, reason: error?.message || 'sqlite-write-failed', dbPath };
		}
	}

	/** Get saved sidebar state */
	getSidebarState(): SidebarState {
		const saved = this.context.workspaceState.get<SidebarState>(SIDEBAR_STATE_KEY);
		return saved ? { ...createDefaultSidebarState(), ...saved } : createDefaultSidebarState();
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

	/** Get global agent context */
	getGlobalAgentContext(): string {
		return this.context.workspaceState.get<string>(GLOBAL_AGENT_CONTEXT_KEY) || '';
	}

	/** Save global agent context */
	async saveGlobalAgentContext(context: string): Promise<void> {
		await this.context.workspaceState.update(GLOBAL_AGENT_CONTEXT_KEY, context);
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
