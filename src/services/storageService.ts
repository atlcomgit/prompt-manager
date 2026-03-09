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
	private readonly HISTORY_DIR_NAME = 'history';
	private readonly DAILY_TIME_FILE = 'daily-time.json';
	private readonly HISTORY_LIMIT = 20;
	private readonly HISTORY_WINDOW_MS = 30_000;

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

	/** Get path to a prompt folder */
	private promptDir(id: string): string {
		return path.join(this.storageDir, id);
	}

	/** Get absolute URI to prompt.md for prompt id */
	getPromptMarkdownUri(id: string): vscode.Uri {
		return vscode.Uri.file(path.join(this.promptDir(id), 'prompt.md'));
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

	/** List all prompt configs (lightweight — no content) */
	async listPrompts(): Promise<PromptConfig[]> {
		await this.ensureStorageDir();
		const uri = vscode.Uri.file(this.storageDir);

		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(uri);
		} catch {
			return [];
		}

		const prompts: PromptConfig[] = [];
		for (const [name, type] of entries) {
			if (type === vscode.FileType.Directory) {
				try {
					const config = await this.readConfig(name);
					if (config) {
						prompts.push(config);
					}
				} catch {
					// Skip corrupted prompt folders
				}
			}
		}
		return prompts;
	}

	/** Read config.json for a prompt */
	private async readConfig(id: string): Promise<PromptConfig | null> {
		const configPath = path.join(this.promptDir(id), 'config.json');
		try {
			const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(configPath));
			const parsed = JSON.parse(Buffer.from(raw).toString('utf-8')) as Partial<PromptConfig>;
			const defaults = createDefaultPrompt(id);
			const normalized: PromptConfig = {
				...defaults,
				...parsed,
				id,
				timeSpentOnTask: typeof parsed.timeSpentOnTask === 'number' ? parsed.timeSpentOnTask : 0,
				timeSpentUntracked: typeof parsed.timeSpentUntracked === 'number' ? parsed.timeSpentUntracked : 0,
			};
			return normalized;
		} catch {
			return null;
		}
	}

	/** Read full prompt (config + markdown) */
	async getPrompt(id: string): Promise<Prompt | null> {
		const config = await this.readConfig(id);
		if (!config) { return null; }

		const mdPath = path.join(this.promptDir(id), 'prompt.md');
		const reportPath = path.join(this.promptDir(id), 'report.md');
		let content = '';
		let report = '';
		try {
			const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(mdPath));
			content = Buffer.from(raw).toString('utf-8');
		} catch {
			// No markdown file yet
		}

		try {
			const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(reportPath));
			report = Buffer.from(raw).toString('utf-8');
		} catch {
			// No report file yet
		}

		return { ...config, content, report };
	}

	/** Save prompt (config + markdown) */
	async savePrompt(
		prompt: Prompt,
		options?: { historyReason?: PromptHistoryReason | string; forceHistory?: boolean; skipHistory?: boolean }
	): Promise<PromptConfig> {
		await this.ensureStorageDir();
		const reason = this.normalizeHistoryReason(options?.historyReason);
		const forceHistory = Boolean(options?.forceHistory);
		const skipHistory = Boolean(options?.skipHistory);
		const existingPrompt = prompt.id ? await this.getPrompt(prompt.id) : null;
		if (!skipHistory && prompt.id) {
			const shouldCapture = await this.shouldCaptureHistorySnapshot(existingPrompt, prompt, reason, forceHistory);
			if (shouldCapture && existingPrompt) {
				await this.createHistorySnapshot(existingPrompt, reason);
			}
		}

		const dir = this.promptDir(prompt.id);
		const dirUri = vscode.Uri.file(dir);

		try {
			await vscode.workspace.fs.stat(dirUri);
		} catch {
			await vscode.workspace.fs.createDirectory(dirUri);
		}

		// Save config.json (without content field)
		const { content, report, ...config } = prompt;
		config.updatedAt = new Date().toISOString();

		const configPath = path.join(dir, 'config.json');
		const configJson = JSON.stringify(config, null, 2);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(configPath),
			Buffer.from(configJson, 'utf-8')
		);

		// Save prompt.md
		const mdPath = path.join(dir, 'prompt.md');
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(mdPath),
			Buffer.from(content, 'utf-8')
		);

		// Save report.md
		const reportPath = path.join(dir, 'report.md');
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(reportPath),
			Buffer.from(report || '', 'utf-8')
		);

		// Ensure context directory exists
		const contextDir = path.join(dir, 'context');
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(contextDir));
		} catch {
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(contextDir));
		}

		// Update daily time tracking (record time deltas for today)
		if (existingPrompt) {
			await this.updateDailyTime(prompt.id, existingPrompt, prompt);
		}

		return config;
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
	}

	/** Duplicate a prompt with a new id */
	async duplicatePrompt(sourceId: string, newId: string): Promise<Prompt | null> {
		const source = await this.getPrompt(sourceId);
		if (!source) { return null; }

		const now = new Date().toISOString();
		const duplicate: Prompt = {
			...source,
			id: newId,
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
	async uniqueId(baseId: string): Promise<string> {
		let id = baseId;
		let counter = 1;
		while (await this.exists(id)) {
			id = `${baseId}-${counter}`;
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

		return this.getPrompt(newId);
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

		const reportRows = prompts.map(p => ({
			taskNumber: p.taskNumber || '',
			title: p.title || p.id,
			timeWriting: p.timeSpentWriting || 0,
			timeImplementing: p.timeSpentImplementing || 0,
			timeOnTask: p.timeSpentOnTask || 0,
			totalTime: (p.timeSpentWriting || 0) + (p.timeSpentImplementing || 0) + (p.timeSpentOnTask || 0) + (p.timeSpentUntracked || 0),
			status: p.status,
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
}
