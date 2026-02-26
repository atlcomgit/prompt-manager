/**
 * State service — persists UI state (sidebar filters, sort, last opened prompt, etc.)
 * Uses VS Code extension globalState and workspaceState.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
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
		const paths = await this.resolveWorkspaceStateDbPaths();
		return paths[0] || null;
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

	private getPreferredAndFallbackDbPaths(dbPaths: string[]): { preferred: string[]; fallback: string[] } {
		if (dbPaths.length === 0) {
			return { preferred: [], fallback: [] };
		}

		const preferredPath = this.getPreferredWorkspaceStateDbPath();
		if (!preferredPath) {
			return { preferred: [dbPaths[0]], fallback: dbPaths.slice(1) };
		}

		const preferred = dbPaths.includes(preferredPath)
			? [preferredPath]
			: [dbPaths[0]];
		const fallback = dbPaths.filter(dbPath => !preferred.includes(dbPath));
		return { preferred, fallback };
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
		const dbPaths = await this.resolveWorkspaceStateDbPaths();
		if (dbPaths.length === 0) {
			return '';
		}
		const { preferred, fallback } = this.getPreferredAndFallbackDbPaths(dbPaths);

		const startedAt = Date.now();
		while (Date.now() - startedAt <= timeoutMs) {
			const keysToCheck = [
				'memento/interactive-session-view-copilot',
				'memento/interactive-session-view-agent',
				'memento/interactive-session',
			];

			const scanGroup = async (paths: string[]): Promise<string> => {
				for (const dbPath of paths) {
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
				}
				return '';
			};

			const preferredSession = await scanGroup(preferred);
			if (preferredSession) {
				return preferredSession;
			}
			const fallbackSession = await scanGroup(fallback);
			if (fallbackSession) {
				return fallbackSession;
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
		sessionIdHint?: string,
	): Promise<{ ok: boolean; sessionId?: string; lastRequestStarted?: number; dbPath?: string; reason?: string }> {
		const dbPaths = await this.resolveWorkspaceStateDbPaths();
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
				const hinted = normalizedHint
					? sessions.find((entry: any) => String(entry?.sessionId || '').trim() === normalizedHint)
					: undefined;
				const candidate = hinted || sessions[0];
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

		const dbPaths = await this.resolveWorkspaceStateDbPaths();
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
		hasPendingEdits?: boolean;
		dbPath?: string;
	}> {
		const dbPaths = await this.resolveWorkspaceStateDbPaths();
		if (dbPaths.length === 0) {
			return { ok: false, reason: 'workspace-db-not-found' };
		}
		const normalizedHint = String(sessionIdHint || '').trim();

		const startedAt = Date.now();
		let lastObservedSessionId = '';
		let lastObservedRequestStarted = 0;
		let lastObservedRequestEnded = 0;
		let lastObservedResponseState: number | undefined;
		let lastObservedHasPendingEdits: boolean | undefined;
		let lastObservedDbPath = '';
		while (Date.now() - startedAt <= timeoutMs) {
			let current: any;
			let matchedDbPath = '';

			for (const dbPath of dbPaths) {
				const index = await this.readChatSessionStoreIndex(dbPath);
				const sessions = this.getRecentChatSessionsFromIndex(index, referenceTimestampMs);
				const hinted = normalizedHint
					? sessions.find((entry: any) => String(entry?.sessionId || '').trim() === normalizedHint)
					: undefined;
				const candidate = hinted || sessions[0];
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
				lastObservedRequestStarted = lastRequestStarted;
				lastObservedRequestEnded = lastRequestEnded;
				lastObservedResponseState = lastResponseState;
				lastObservedHasPendingEdits = hasPendingEdits;
				lastObservedDbPath = matchedDbPath;
				const finished = lastRequestEnded > lastRequestStarted && !hasPendingEdits;

				if (finished) {
					return {
						ok: true,
						sessionId: String(current?.sessionId || ''),
						lastRequestStarted,
						lastRequestEnded,
						lastResponseState,
						hasPendingEdits,
						dbPath: matchedDbPath,
					};
				}
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
			hasPendingEdits: lastObservedHasPendingEdits,
			dbPath: lastObservedDbPath || dbPaths[0],
		};
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
		const dbPaths = await this.resolveWorkspaceStateDbPaths();

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
	 * VS Code stores chat sessions as JSONL files in chatSessions/ directory.
	 * Appending a kind:1 patch for customTitle sets the display title.
	 * The title takes effect after VS Code window reload (VS Code reads JSONL on startup).
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
		if (!jsonlPath) {
			return { ok: false, reason: 'jsonl-not-found' };
		}

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
			return { ok: true, reason: jsonlPath };
		} catch (error: any) {
			return { ok: false, reason: error?.message || 'jsonl-write-failed' };
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
