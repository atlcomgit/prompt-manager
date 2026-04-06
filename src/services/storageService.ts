/**
 * Storage service — reads/writes prompt data from .vscode/prompt-manager/
 *
 * Each prompt is stored as a folder:
 *   .vscode/prompt-manager/<slug>/
 *     config.json   — PromptConfig
 *     prompt.md     — Markdown content
 *     context/      — attached context files
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import type {
	Prompt,
	PromptConfig,
	PromptHistoryEntry,
	PromptHistoryReason,
	PromptStatistics,
	PromptStatus,
} from '../types/prompt.js';
import { createDefaultPrompt } from '../types/prompt.js';
import { normalizeStoredPromptConfig } from '../utils/promptConfig.js';
import { summarizePromptReport } from '../utils/statisticsExport.js';

/** Daily time entry for a prompt (ms per category) */
export interface DailyTimeEntry {
	writing: number;
	implementing: number;
	onTask: number;
	untracked: number;
}

/** Daily time data: date string (YYYY-MM-DD) → time breakdown */
export type DailyTimeData = Record<string, DailyTimeEntry>;

export class StorageService {
	private readonly STORAGE_DIR = '.vscode/prompt-manager';
	private readonly RESERVED_PROMPT_DIR_NAMES = new Set(['chat-memory', 'codemap']);
	private readonly HISTORY_DIR_NAME = 'history';
	private readonly DAILY_TIME_FILE = 'daily-time.json';
	private readonly HISTORY_LIMIT = 20;
	private readonly HISTORY_WINDOW_MS = 30_000;
	private readonly CACHE_FILE = 'prompt-list.json';

	private _listCache: PromptConfig[] | null = null;
	private _backgroundRefreshCancelled = false;

	constructor(private readonly workspaceRoot: string) { }

	/** Get absolute path to storage directory */
	private get storageDir(): string {
		return path.join(this.workspaceRoot, this.STORAGE_DIR);
	}

	/** Ensure storage directory exists */
	async ensureStorageDir(): Promise<void> {
		const uri = vscode.Uri.file(this.storageDir);
		try {
			await vscode.workspace.fs.stat(uri);
		} catch {
			await vscode.workspace.fs.createDirectory(uri);
		}
	}

	private get cacheFilePath(): string {
		return path.join(this.storageDir, this.CACHE_FILE);
	}

	private async readListCache(): Promise<PromptConfig[] | null> {
		try {
			const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(this.cacheFilePath));
			const parsed = JSON.parse(Buffer.from(raw).toString('utf-8'));
			if (!Array.isArray(parsed)) { return null; }
			return parsed as PromptConfig[];
		} catch {
			return null;
		}
	}

	private async writeListCache(prompts: PromptConfig[]): Promise<void> {
		this._listCache = prompts;
		try {
			await vscode.workspace.fs.writeFile(
				vscode.Uri.file(this.cacheFilePath),
				Buffer.from(JSON.stringify(prompts, null, 2), 'utf-8'),
			);
		} catch {
			// Cache write failure is non-fatal
		}
	}

	/** Update or add one entry in the cache. No-op if no cache exists yet. */
	private async updateListCacheEntry(config: PromptConfig, removedId?: string): Promise<void> {
		const current = this._listCache ?? await this.readListCache();
		if (current === null) { return; }
		const updated = current.filter(p => p.id !== config.id && p.id !== removedId);
		updated.push(config);
		await this.writeListCache(updated);
	}

	/** Быстрое обновление кэша: in-memory мгновенно, файловая запись в фоне */
	private updateListCacheEntryFast(config: PromptConfig, removedId?: string): void {
		const current = this._listCache;
		if (current === null) { return; }
		const updated = current.filter(p => p.id !== config.id && p.id !== removedId);
		updated.push(config);
		this._listCache = updated;
		// Файловая запись кэша — в фоне, не блокирует save
		void this.writeListCacheFile(updated).catch(() => { });
	}

	/** Запись файла кэша списка без обновления in-memory кэша */
	private async writeListCacheFile(prompts: PromptConfig[]): Promise<void> {
		try {
			await vscode.workspace.fs.writeFile(
				vscode.Uri.file(this.cacheFilePath),
				Buffer.from(JSON.stringify(prompts, null, 2), 'utf-8'),
			);
		} catch {
			// Cache write failure is non-fatal
		}
	}

	/** Remove one entry from the cache by id. No-op if no cache exists yet. */
	private async removeListCacheEntry(id: string): Promise<void> {
		const current = this._listCache ?? await this.readListCache();
		if (current === null) { return; }
		await this.writeListCache(current.filter(p => p.id !== id));
	}

	/** Get path to a prompt folder */
	private promptDir(id: string): string {
		return path.join(this.storageDir, id);
	}

	private normalizePromptId(baseId: string): string {
		const trimmed = (baseId || '').trim();
		return trimmed || 'prompt';
	}

	private isReservedPromptDirName(id: string): boolean {
		return this.RESERVED_PROMPT_DIR_NAMES.has((id || '').trim());
	}

	private ensurePromptUuid<T extends Prompt | PromptConfig>(prompt: T): T {
		if (!(prompt.promptUuid || '').trim()) {
			prompt.promptUuid = crypto.randomUUID();
		}
		return prompt;
	}

	private async findPromptIdByUuid(promptUuid: string): Promise<string | undefined> {
		const normalizedPromptUuid = (promptUuid || '').trim();
		if (!normalizedPromptUuid) {
			return undefined;
		}

		const prompts = await this.listPrompts();
		return prompts.find(prompt => (prompt.promptUuid || '').trim() === normalizedPromptUuid)?.id;
	}

	private async resolveExistingPromptIdentity(prompt: Prompt, requestedPreviousId: string): Promise<string | undefined> {
		const normalizedPreviousId = requestedPreviousId.trim();
		if (normalizedPreviousId) {
			return normalizedPreviousId;
		}

		const canonicalPromptId = await this.findPromptIdByUuid(prompt.promptUuid);
		if (canonicalPromptId) {
			return canonicalPromptId;
		}

		const normalizedPromptId = (prompt.id || '').trim();
		if (!normalizedPromptId) {
			return undefined;
		}

		const existingPrompt = await this.getPrompt(normalizedPromptId);
		if (existingPrompt && (existingPrompt.promptUuid || '').trim() === (prompt.promptUuid || '').trim()) {
			return normalizedPromptId;
		}

		return undefined;
	}

	private async ensurePromptDirectory(id: string): Promise<string> {
		await this.ensureStorageDir();
		const dir = this.promptDir(id);
		const dirUri = vscode.Uri.file(dir);
		try {
			await vscode.workspace.fs.stat(dirUri);
		} catch {
			await vscode.workspace.fs.createDirectory(dirUri);
		}
		return dir;
	}

	private async ensurePromptReportFile(id: string, reportContent: string = ''): Promise<void> {
		if (!id.trim()) {
			return;
		}

		const dir = await this.ensurePromptDirectory(id);
		const reportUri = vscode.Uri.file(path.join(dir, 'report.txt'));
		try {
			await vscode.workspace.fs.stat(reportUri);
		} catch {
			await vscode.workspace.fs.writeFile(reportUri, Buffer.from(reportContent, 'utf-8'));
		}
	}

	/** Get absolute URI to prompt.md for prompt id */
	getPromptMarkdownUri(id: string): vscode.Uri {
		return vscode.Uri.file(path.join(this.promptDir(id), 'prompt.md'));
	}

	/** Get absolute URI to report.txt for prompt id */
	getPromptReportUri(id: string): vscode.Uri {
		return vscode.Uri.file(path.join(this.promptDir(id), 'report.txt'));
	}

	/** Get absolute path to storage directory */
	getStorageDirectoryPath(): string {
		return this.storageDir;
	}

	/** Get absolute path to a prompt folder */
	getPromptDirectoryPath(id: string): string {
		return this.promptDir(id);
	}

	private promptHistoryDir(id: string): string {
		return path.join(this.promptDir(id), this.HISTORY_DIR_NAME);
	}

	private normalizeHistoryReason(reason?: string): PromptHistoryReason {
		switch ((reason || '').trim()) {
			case 'manual':
			case 'autosave':
			case 'status-change':
			case 'switch':
			case 'start-chat':
			case 'restore':
				return reason as PromptHistoryReason;
			default:
				return 'system';
		}
	}

	private historyTrackedFingerprint(prompt: Prompt): string {
		const stable = {
			content: prompt.content,
			report: prompt.report,
			contextFiles: [...(prompt.contextFiles || [])].map(file => file.trim()).sort(),
		};
		return JSON.stringify(stable);
	}

	private makeHistoryEntryId(): string {
		const now = new Date();
		const ts = now.toISOString().replace(/[:.]/g, '-');
		const suffix = Math.random().toString(36).slice(2, 8);
		return `${ts}-${suffix}`;
	}

	private async readHistoryEntry(promptId: string, entryId: string): Promise<PromptHistoryEntry | null> {
		const fileUri = vscode.Uri.file(path.join(this.promptHistoryDir(promptId), `${entryId}.json`));
		try {
			const raw = await vscode.workspace.fs.readFile(fileUri);
			const parsed = JSON.parse(Buffer.from(raw).toString('utf-8')) as PromptHistoryEntry;
			if (!parsed || !parsed.id || !parsed.prompt || !parsed.promptId) {
				return null;
			}
			return parsed;
		} catch {
			return null;
		}
	}

	private async trimPromptHistory(promptId: string): Promise<void> {
		const dirUri = vscode.Uri.file(this.promptHistoryDir(promptId));
		let entries: [string, vscode.FileType][] = [];
		try {
			entries = await vscode.workspace.fs.readDirectory(dirUri);
		} catch {
			return;
		}

		const files = entries
			.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
			.map(([name]) => name)
			.sort((a, b) => b.localeCompare(a));

		if (files.length <= this.HISTORY_LIMIT) {
			return;
		}

		for (const file of files.slice(this.HISTORY_LIMIT)) {
			try {
				await vscode.workspace.fs.delete(vscode.Uri.joinPath(dirUri, file));
			} catch {
				// ignore trimming issues
			}
		}
	}

	private async getLatestHistoryEntry(promptId: string): Promise<PromptHistoryEntry | null> {
		const list = await this.listPromptHistory(promptId);
		if (list.length === 0) {
			return null;
		}
		return this.readHistoryEntry(promptId, list[0].id);
	}

	private async createHistorySnapshot(prompt: Prompt, reason: PromptHistoryReason): Promise<void> {
		if (!prompt.id) {
			return;
		}

		const latestEntry = await this.getLatestHistoryEntry(prompt.id);
		if (latestEntry?.prompt && this.historyTrackedFingerprint(latestEntry.prompt) === this.historyTrackedFingerprint(prompt)) {
			return;
		}

		const historyDirUri = vscode.Uri.file(this.promptHistoryDir(prompt.id));
		try {
			await vscode.workspace.fs.stat(historyDirUri);
		} catch {
			await vscode.workspace.fs.createDirectory(historyDirUri);
		}

		const entry: PromptHistoryEntry = {
			id: this.makeHistoryEntryId(),
			promptId: prompt.id,
			createdAt: new Date().toISOString(),
			reason,
			prompt: JSON.parse(JSON.stringify(prompt)) as Prompt,
		};

		const entryUri = vscode.Uri.file(path.join(this.promptHistoryDir(prompt.id), `${entry.id}.json`));
		await vscode.workspace.fs.writeFile(entryUri, Buffer.from(JSON.stringify(entry, null, 2), 'utf-8'));
		await this.trimPromptHistory(prompt.id);
	}

	private async shouldCaptureHistorySnapshot(
		previousPrompt: Prompt | null,
		nextPrompt: Prompt,
		reason: PromptHistoryReason,
		_forceHistory: boolean,
	): Promise<boolean> {
		if (!previousPrompt || !previousPrompt.id) {
			return false;
		}

		const previousTrackedFingerprint = this.historyTrackedFingerprint(previousPrompt);
		const nextTrackedFingerprint = this.historyTrackedFingerprint(nextPrompt);
		if (previousTrackedFingerprint === nextTrackedFingerprint) {
			return false;
		}

		const contentChanged = previousPrompt.content !== nextPrompt.content;
		const reportChanged = previousPrompt.report !== nextPrompt.report;
		const previousFiles = [...(previousPrompt.contextFiles || [])].map(file => file.trim()).sort();
		const nextFiles = [...(nextPrompt.contextFiles || [])].map(file => file.trim()).sort();
		const filesChanged = JSON.stringify(previousFiles) !== JSON.stringify(nextFiles);

		if (!contentChanged && !reportChanged && !filesChanged) {
			return false;
		}

		if (reason === 'manual') {
			return true;
		}

		if (reportChanged || filesChanged) {
			return true;
		}

		const latestEntry = await this.getLatestHistoryEntry(previousPrompt.id);
		if (!latestEntry?.createdAt) {
			return true;
		}

		const latestTs = new Date(latestEntry.createdAt).getTime();
		if (!Number.isFinite(latestTs)) {
			return true;
		}

		return (Date.now() - latestTs) >= this.HISTORY_WINDOW_MS;
	}

	/** Фоновая запись истории — не блокирует основной поток сохранения */
	private async captureHistorySnapshotInBackground(
		existingPrompt: Prompt | null,
		nextPrompt: Prompt,
		reason: PromptHistoryReason,
		forceHistory: boolean,
	): Promise<void> {
		try {
			const shouldCapture = await this.shouldCaptureHistorySnapshot(existingPrompt, nextPrompt, reason, forceHistory);
			if (shouldCapture && existingPrompt) {
				await this.createHistorySnapshot(existingPrompt, reason);
			}
		} catch {
			// Ошибка записи истории не должна влиять на работу расширения
		}
	}

	/** List all prompt configs (lightweight — no content) */
	async listPrompts(): Promise<PromptConfig[]> {
		await this.ensureStorageDir();

		// Level 1: in-memory cache
		if (this._listCache !== null) {
			return this._listCache;
		}

		// Level 2: persistent cache file
		const cached = await this.readListCache();
		if (cached !== null) {
			this._listCache = cached;
			return cached;
		}

		// Level 3: full parallel scan — build and persist cache
		return this._scanAndCachePrompts();
	}

	private async _scanAndCachePrompts(): Promise<PromptConfig[]> {
		const uri = vscode.Uri.file(this.storageDir);
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(uri);
		} catch {
			return [];
		}

		const dirs = entries
			.filter(([, type]) => type === vscode.FileType.Directory)
			.map(([name]) => name);
		const configs = await Promise.all(dirs.map(name => this.readConfig(name).catch(() => null)));
		const prompts = configs.filter(Boolean) as PromptConfig[];
		await this.writeListCache(prompts);
		return prompts;
	}

	/** Read config.json for a prompt */
	private async readConfig(id: string): Promise<PromptConfig | null> {
		const configPath = path.join(this.promptDir(id), 'config.json');
		try {
			const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(configPath));
			const parsed = JSON.parse(Buffer.from(raw).toString('utf-8')) as Partial<PromptConfig>;
			const { config, shouldBackfillPromptUuid } = normalizeStoredPromptConfig(
				id,
				parsed,
				() => crypto.randomUUID(),
			);

			if (shouldBackfillPromptUuid) {
				try {
					await vscode.workspace.fs.writeFile(
						vscode.Uri.file(configPath),
						Buffer.from(JSON.stringify(config, null, 2), 'utf-8'),
					);
				} catch {
					// Ignore backfill failures and continue with in-memory config.
				}
			}

			return config;
		} catch {
			return null;
		}
	}

	/** Read full prompt (config + markdown) */
	async getPrompt(id: string): Promise<Prompt | null> {
		const config = await this.readConfig(id);
		if (!config) { return null; }

		const mdPath = path.join(this.promptDir(id), 'prompt.md');
		const reportPath = path.join(this.promptDir(id), 'report.txt');
		const legacyReportPath = path.join(this.promptDir(id), 'report.md');

		// Параллельное чтение content и report для ускорения
		const [contentResult, reportResult] = await Promise.allSettled([
			vscode.workspace.fs.readFile(vscode.Uri.file(mdPath)),
			vscode.workspace.fs.readFile(vscode.Uri.file(reportPath)),
		]);

		const content = contentResult.status === 'fulfilled'
			? Buffer.from(contentResult.value).toString('utf-8')
			: '';

		let report = '';
		let hasReportTxt = true;
		if (reportResult.status === 'fulfilled') {
			report = Buffer.from(reportResult.value).toString('utf-8');
		} else {
			hasReportTxt = false;
			try {
				const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(legacyReportPath));
				report = Buffer.from(raw).toString('utf-8');
			} catch {
				// No report file yet
			}
		}

		if (!hasReportTxt) {
			await this.ensurePromptReportFile(id, report);
		}

		return { ...config, content, report };
	}

	/** Save prompt (config + markdown). Возвращает полный Prompt (config + content + report) */
	async savePrompt(
		prompt: Prompt,
		options?: { historyReason?: PromptHistoryReason | string; forceHistory?: boolean; skipHistory?: boolean; previousId?: string }
	): Promise<Prompt> {
		await this.ensureStorageDir();
		this.ensurePromptUuid(prompt);
		const requestedPreviousId = (options?.previousId || '').trim();
		const requestedPromptId = (prompt.id || '').trim();
		const existingPromptIdentity = await this.resolveExistingPromptIdentity(prompt, requestedPreviousId);
		const shouldPreserveRequestedPromptId = Boolean(
			requestedPromptId
			&& existingPromptIdentity
			&& requestedPromptId !== existingPromptIdentity,
		);
		if (existingPromptIdentity && existingPromptIdentity !== prompt.id && !shouldPreserveRequestedPromptId) {
			prompt.id = existingPromptIdentity;
		}
		const reason = this.normalizeHistoryReason(options?.historyReason);
		const forceHistory = Boolean(options?.forceHistory);
		const skipHistory = Boolean(options?.skipHistory);
		const previousId = existingPromptIdentity || requestedPreviousId;
		const existingPromptId = previousId || prompt.id;
		const existingPrompt = existingPromptId ? await this.getPrompt(existingPromptId) : null;
		// История создаётся в фоне — не блокирует основной поток сохранения
		if (!skipHistory && existingPromptId) {
			void this.captureHistorySnapshotInBackground(existingPrompt, prompt, reason, forceHistory);
		}

		const safePromptId = await this.uniqueId(prompt.id, existingPromptIdentity || previousId || undefined);
		prompt.id = safePromptId;

		if (previousId && previousId !== prompt.id) {
			await this.renamePromptDirectory(previousId, prompt.id);
		}

		const dir = await this.ensurePromptDirectory(prompt.id);
		await this.ensurePromptReportFile(prompt.id);

		// Save config.json (without content field)
		const { content, report, ...config } = prompt;
		config.updatedAt = new Date().toISOString();

		const configPath = path.join(dir, 'config.json');
		const configJson = JSON.stringify(config, null, 2);

		// Параллельная запись всех файлов для ускорения
		await Promise.all([
			vscode.workspace.fs.writeFile(
				vscode.Uri.file(configPath),
				Buffer.from(configJson, 'utf-8')
			),
			vscode.workspace.fs.writeFile(
				vscode.Uri.file(path.join(dir, 'prompt.md')),
				Buffer.from(content, 'utf-8')
			),
			vscode.workspace.fs.writeFile(
				vscode.Uri.file(path.join(dir, 'report.txt')),
				Buffer.from(report || '', 'utf-8')
			),
			// Удаление legacy report.md (если существует)
			vscode.workspace.fs.delete(vscode.Uri.file(path.join(dir, 'report.md'))).then(undefined, () => { }),
		]);

		// Ensure context directory exists
		const contextDir = path.join(dir, 'context');
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(contextDir));
		} catch {
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(contextDir));
		}

		// Обновление daily time в фоне — не блокирует save
		if (existingPrompt) {
			void this.updateDailyTime(prompt.id, existingPrompt, prompt).catch(() => { });
		}

		// Обновление in-memory кэша — мгновенно; файловая запись в фоне
		this.updateListCacheEntryFast(config, previousId && previousId !== prompt.id ? previousId : undefined);

		// Возвращаем полный Prompt (config + content + report) чтобы не требовался повторный getPrompt()
		return { ...config, content, report };
	}

	async listPromptHistory(promptId: string): Promise<Array<{ id: string; createdAt: string; reason: PromptHistoryReason }>> {
		const dirUri = vscode.Uri.file(this.promptHistoryDir(promptId));
		let entries: [string, vscode.FileType][] = [];
		try {
			entries = await vscode.workspace.fs.readDirectory(dirUri);
		} catch {
			return [];
		}

		const result: Array<{ id: string; createdAt: string; reason: PromptHistoryReason }> = [];
		for (const [name, type] of entries) {
			if (type !== vscode.FileType.File || !name.endsWith('.json')) {
				continue;
			}
			const id = name.slice(0, -5);
			const entry = await this.readHistoryEntry(promptId, id);
			if (!entry) {
				continue;
			}
			result.push({ id: entry.id, createdAt: entry.createdAt, reason: entry.reason });
		}

		return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
	}

	async restorePromptHistory(promptId: string, entryId: string): Promise<Prompt | null> {
		const targetEntry = await this.readHistoryEntry(promptId, entryId);
		if (!targetEntry) {
			return null;
		}

		const currentPrompt = await this.getPrompt(promptId);
		const targetPromptForCompare: Prompt = {
			...targetEntry.prompt,
			id: promptId,
		};

		if (currentPrompt && this.historyTrackedFingerprint(currentPrompt) !== this.historyTrackedFingerprint(targetPromptForCompare)) {
			await this.createHistorySnapshot(currentPrompt, 'restore');
		}

		const restoredPrompt: Prompt = {
			...targetPromptForCompare,
		};

		await this.savePrompt(restoredPrompt, { historyReason: 'restore', skipHistory: true });
		return this.getPrompt(promptId);
	}

	/** Delete a prompt folder */
	async deletePrompt(id: string): Promise<void> {
		const dir = this.promptDir(id);
		try {
			await vscode.workspace.fs.delete(vscode.Uri.file(dir), { recursive: true });
		} catch {
			// Already deleted or doesn't exist
		}
		await this.removeListCacheEntry(id);
	}

	/** Duplicate a prompt with a new id */
	async duplicatePrompt(sourceId: string, newId: string): Promise<Prompt | null> {
		const source = await this.getPrompt(sourceId);
		if (!source) { return null; }

		const now = new Date().toISOString();
		const duplicate: Prompt = {
			...source,
			id: newId,
			promptUuid: '',
			title: `${source.title} (copy)`,
			chatSessionIds: [],
			timeSpentWriting: 0,
			timeSpentImplementing: 0,
			timeSpentOnTask: 0,
			timeSpentUntracked: 0,
			createdAt: now,
			updatedAt: now,
		};

		await this.savePrompt(duplicate);
		return duplicate;
	}

	/** Check if prompt id exists */
	async exists(id: string): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(this.promptDir(id)));
			return true;
		} catch {
			return false;
		}
	}

	/** Generate a unique id by appending number if needed */
	async uniqueId(baseId: string, excludeId?: string): Promise<string> {
		const normalizedBaseId = this.normalizePromptId(baseId);
		let id = normalizedBaseId;
		let counter = 1;
		while (this.isReservedPromptDirName(id) || ((await this.exists(id)) && id !== excludeId)) {
			id = `${normalizedBaseId}-${counter}`;
			counter++;
		}
		return id;
	}

	/** Import a prompt from an external folder */
	async importPrompt(sourceFolder: string): Promise<Prompt | null> {
		const sourceName = path.basename(sourceFolder);
		const newId = await this.uniqueId(sourceName);
		const targetDir = this.promptDir(newId);

		// Copy entire folder
		await this.copyDirectory(
			vscode.Uri.file(sourceFolder),
			vscode.Uri.file(targetDir)
		);

		const imported = await this.getPrompt(newId);
		if (!imported) {
			return null;
		}
		imported.promptUuid = '';
		await this.savePrompt(imported, { skipHistory: true });
		return this.getPrompt(imported.id);
	}

	/** Export a prompt to an external folder */
	async exportPrompt(id: string, targetFolder: string): Promise<void> {
		const sourceDir = this.promptDir(id);
		const targetDir = path.join(targetFolder, id);

		await this.copyDirectory(
			vscode.Uri.file(sourceDir),
			vscode.Uri.file(targetDir)
		);
	}

	/** Read daily time data for a prompt */
	async getDailyTime(promptId: string): Promise<DailyTimeData> {
		const filePath = path.join(this.promptDir(promptId), this.DAILY_TIME_FILE);
		try {
			const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
			return JSON.parse(Buffer.from(raw).toString('utf-8')) as DailyTimeData;
		} catch {
			return {};
		}
	}

	/** Update daily time tracking: compute deltas and add to today's entry */
	private async updateDailyTime(promptId: string, oldPrompt: PromptConfig, newPrompt: Prompt): Promise<void> {
		const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

		// Compute time deltas
		const dWriting = Math.max(0, (newPrompt.timeSpentWriting || 0) - (oldPrompt.timeSpentWriting || 0));
		const dImplementing = Math.max(0, (newPrompt.timeSpentImplementing || 0) - (oldPrompt.timeSpentImplementing || 0));
		const dOnTask = Math.max(0, (newPrompt.timeSpentOnTask || 0) - (oldPrompt.timeSpentOnTask || 0));
		const dUntracked = Math.max(0, (newPrompt.timeSpentUntracked || 0) - (oldPrompt.timeSpentUntracked || 0));

		// Skip if no time change
		if (dWriting === 0 && dImplementing === 0 && dOnTask === 0 && dUntracked === 0) {
			return;
		}

		// Read existing daily time data
		const dailyData = await this.getDailyTime(promptId);
		const entry = dailyData[today] || { writing: 0, implementing: 0, onTask: 0, untracked: 0 };
		entry.writing += dWriting;
		entry.implementing += dImplementing;
		entry.onTask += dOnTask;
		entry.untracked += dUntracked;
		dailyData[today] = entry;

		// Write back
		const filePath = path.join(this.promptDir(promptId), this.DAILY_TIME_FILE);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(filePath),
			Buffer.from(JSON.stringify(dailyData, null, 2), 'utf-8')
		);
	}

	/** Get total time from daily data within a date range */
	getDailyTimeTotalInRange(dailyData: DailyTimeData, dateFrom: string, dateTo: string): number {
		let total = 0;
		for (const [date, entry] of Object.entries(dailyData)) {
			if (date >= dateFrom && date <= dateTo) {
				total += (entry.writing || 0) + (entry.implementing || 0) + (entry.onTask || 0) + (entry.untracked || 0);
			}
		}
		return total;
	}

	/** Compute statistics across all prompts, optionally filtered by date range */
	async getStatistics(filter?: { dateFrom?: string; dateTo?: string; minFiveMin?: boolean }): Promise<PromptStatistics> {
		let prompts = await this.listPrompts();
		const hasDateRange = filter?.dateFrom && filter?.dateTo;

		// Filter by updatedAt within date range
		if (hasDateRange) {
			prompts = prompts.filter(p => {
				const dateStr = p.updatedAt.slice(0, 10); // YYYY-MM-DD
				return dateStr >= filter.dateFrom! && dateStr <= filter.dateTo!;
			});
		}

		// Filter by ≥5 min total daily time in date range (from daily-time.json)
		if (filter?.minFiveMin && hasDateRange) {
			const MIN_TIME_MS = 5 * 60 * 1000; // 5 minutes
			const filtered: PromptConfig[] = [];
			for (const p of prompts) {
				const dailyData = await this.getDailyTime(p.id);
				const totalInRange = this.getDailyTimeTotalInRange(dailyData, filter.dateFrom!, filter.dateTo!);
				if (totalInRange >= MIN_TIME_MS) {
					filtered.push(p);
				}
			}
			prompts = filtered;
		}

		const byStatus: Record<PromptStatus, number> = {
			draft: 0,
			'in-progress': 0,
			stopped: 0,
			cancelled: 0,
			completed: 0,
			report: 0,
			review: 0,
			closed: 0,
		};
		let totalTimeWriting = 0;
		let totalTimeImplementing = 0;
		let totalTimeOnTask = 0;
		let totalTimeUntracked = 0;
		let favoriteCount = 0;

		for (const p of prompts) {
			byStatus[p.status] = (byStatus[p.status] || 0) + 1;
			if (p.favorite) favoriteCount++;
			totalTimeWriting += p.timeSpentWriting || 0;
			totalTimeImplementing += p.timeSpentImplementing || 0;
			totalTimeOnTask += p.timeSpentOnTask || 0;
			totalTimeUntracked += p.timeSpentUntracked || 0;
		}

		const totalTime = totalTimeWriting + totalTimeImplementing + totalTimeOnTask + totalTimeUntracked;
		const avgTimePerPrompt = prompts.length > 0 ? totalTime / prompts.length : 0;

		const recentActivity = [...prompts]
			.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
			.slice(0, 10)
			.map(p => ({ id: p.id, title: p.title, updatedAt: p.updatedAt }));

		const reportRowPrompts = await Promise.all(prompts.map(async (promptConfig) => {
			const fullPrompt = await this.getPrompt(promptConfig.id);
			return fullPrompt || ({ ...createDefaultPrompt(promptConfig.id), ...promptConfig } as Prompt);
		}));

		const reportRows = reportRowPrompts.map(p => ({
			taskNumber: p.taskNumber || '',
			title: p.title || p.id,
			timeWriting: p.timeSpentWriting || 0,
			timeImplementing: p.timeSpentImplementing || 0,
			timeOnTask: p.timeSpentOnTask || 0,
			totalTime: (p.timeSpentWriting || 0) + (p.timeSpentImplementing || 0) + (p.timeSpentOnTask || 0) + (p.timeSpentUntracked || 0),
			status: p.status,
			reportSummary: summarizePromptReport(p.report || ''),
		}));

		return {
			totalPrompts: prompts.length,
			byStatus,
			totalTimeWriting,
			totalTimeImplementing,
			totalTimeOnTask,
			totalTime,
			favoriteCount,
			avgTimePerPrompt,
			recentActivity,
			reportRows,
		};
	}

	/** Recursively copy a directory */
	private async copyDirectory(source: vscode.Uri, target: vscode.Uri): Promise<void> {
		try {
			await vscode.workspace.fs.stat(target);
		} catch {
			await vscode.workspace.fs.createDirectory(target);
		}

		const entries = await vscode.workspace.fs.readDirectory(source);
		for (const [name, type] of entries) {
			const srcUri = vscode.Uri.joinPath(source, name);
			const tgtUri = vscode.Uri.joinPath(target, name);

			if (type === vscode.FileType.Directory) {
				await this.copyDirectory(srcUri, tgtUri);
			} else {
				const data = await vscode.workspace.fs.readFile(srcUri);
				await vscode.workspace.fs.writeFile(tgtUri, data);
			}
		}
	}

	private async renamePromptDirectory(oldId: string, newId: string): Promise<void> {
		if (!oldId || !newId || oldId === newId) {
			return;
		}

		const oldUri = vscode.Uri.file(this.promptDir(oldId));
		const newUri = vscode.Uri.file(this.promptDir(newId));

		try {
			await vscode.workspace.fs.stat(oldUri);
		} catch {
			return;
		}

		await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
	}

	/**
	 * Start a low-priority background scan to sync the cache with any manual
	 * file-system changes (e.g. user renamed a folder or edited config.json).
	 * Reads each prompt folder sequentially with small pauses to minimise disk
	 * and CPU pressure.  Calls `onComplete` only when actual changes are found.
	 */
	startBackgroundCacheRefresh(onComplete?: () => void): void {
		this._backgroundRefreshCancelled = false;
		setTimeout(() => void this._runBackgroundRefresh(onComplete), 0);
	}

	cancelBackgroundCacheRefresh(): void {
		this._backgroundRefreshCancelled = true;
	}

	private async _runBackgroundRefresh(onComplete?: () => void): Promise<void> {
		// Give the extension time to fully initialise before touching the disk.
		await new Promise<void>(resolve => setTimeout(resolve, 2000));
		if (this._backgroundRefreshCancelled) { return; }

		let entries: [string, vscode.FileType][];
		try {
			await this.ensureStorageDir();
			entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(this.storageDir));
		} catch {
			return;
		}

		const dirs = entries
			.filter(([, type]) => type === vscode.FileType.Directory)
			.map(([name]) => name);

		const freshConfigs: PromptConfig[] = [];
		for (const name of dirs) {
			if (this._backgroundRefreshCancelled) { return; }
			try {
				const config = await this.readConfig(name);
				if (config) { freshConfigs.push(config); }
			} catch {
				// skip corrupted folders
			}
			// Low-priority pause — keeps disk and CPU pressure minimal.
			await new Promise<void>(resolve => setTimeout(resolve, 30));
		}

		if (this._backgroundRefreshCancelled) { return; }

		// Compare fresh data against the current cache.
		const cached = this._listCache ?? await this.readListCache();
		let hasChanges = cached === null;

		if (!hasChanges && cached !== null) {
			const freshById = new Map(freshConfigs.map(c => [c.id, c]));
			const cachedById = new Map(cached.map(c => [c.id, c]));
			if (freshById.size !== cachedById.size) {
				hasChanges = true;
			} else {
				for (const [id, fresh] of freshById) {
					const existing = cachedById.get(id);
					if (!existing || fresh.updatedAt !== existing.updatedAt) {
						hasChanges = true;
						break;
					}
				}
			}
		}

		if (hasChanges && !this._backgroundRefreshCancelled) {
			await this.writeListCache(freshConfigs);
			onComplete?.();
		}
	}
}
