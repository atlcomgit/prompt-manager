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
