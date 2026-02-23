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
import type { Prompt, PromptConfig, PromptStatistics, PromptStatus } from '../types/prompt.js';
import { createDefaultPrompt } from '../types/prompt.js';

export class StorageService {
	private readonly STORAGE_DIR = '.vscode/prompt-manager';

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
			const config = JSON.parse(Buffer.from(raw).toString('utf-8')) as PromptConfig;
			config.id = id; // Ensure id matches folder name
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
		let content = '';
		try {
			const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(mdPath));
			content = Buffer.from(raw).toString('utf-8');
		} catch {
			// No markdown file yet
		}

		return { ...config, content };
	}

	/** Save prompt (config + markdown) */
	async savePrompt(prompt: Prompt): Promise<PromptConfig> {
		await this.ensureStorageDir();

		const dir = this.promptDir(prompt.id);
		const dirUri = vscode.Uri.file(dir);

		try {
			await vscode.workspace.fs.stat(dirUri);
		} catch {
			await vscode.workspace.fs.createDirectory(dirUri);
		}

		// Save config.json (without content field)
		const { content, ...config } = prompt;
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

		// Ensure context directory exists
		const contextDir = path.join(dir, 'context');
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(contextDir));
		} catch {
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(contextDir));
		}

		return config;
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

	/** Compute statistics across all prompts, optionally filtered by period */
	async getStatistics(filter?: { month?: number; year?: number }): Promise<PromptStatistics> {
		let prompts = await this.listPrompts();

		// Filter by period if specified
		if (filter?.year) {
			prompts = prompts.filter(p => {
				const date = new Date(p.updatedAt);
				if (filter.month !== undefined && filter.month > 0) {
					return date.getFullYear() === filter.year && date.getMonth() + 1 === filter.month;
				}
				return date.getFullYear() === filter.year;
			});
		}
		const byStatus: Record<PromptStatus, number> = { draft: 0, 'in-progress': 0, completed: 0, stopped: 0, cancelled: 0 };
		const byLanguage: Record<string, number> = {};
		const byFramework: Record<string, number> = {};
		let totalTimeWriting = 0;
		let totalTimeImplementing = 0;
		let favoriteCount = 0;

		for (const p of prompts) {
			byStatus[p.status] = (byStatus[p.status] || 0) + 1;
			if (p.favorite) favoriteCount++;
			totalTimeWriting += p.timeSpentWriting || 0;
			totalTimeImplementing += p.timeSpentImplementing || 0;
			for (const lang of p.languages) {
				byLanguage[lang] = (byLanguage[lang] || 0) + 1;
			}
			for (const fw of p.frameworks) {
				byFramework[fw] = (byFramework[fw] || 0) + 1;
			}
		}

		const totalTime = totalTimeWriting + totalTimeImplementing;
		const avgTimePerPrompt = prompts.length > 0 ? totalTime / prompts.length : 0;

		const recentActivity = [...prompts]
			.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
			.slice(0, 10)
			.map(p => ({ id: p.id, title: p.title, updatedAt: p.updatedAt }));

		const topLanguages = Object.entries(byLanguage)
			.sort(([, a], [, b]) => b - a)
			.slice(0, 10)
			.map(([name, count]) => ({ name, count }));

		const topFrameworks = Object.entries(byFramework)
			.sort(([, a], [, b]) => b - a)
			.slice(0, 10)
			.map(([name, count]) => ({ name, count }));

		const reportRows = prompts.map(p => ({
			taskNumber: p.taskNumber || '',
			title: p.title || p.id,
			timeWriting: p.timeSpentWriting || 0,
			timeImplementing: p.timeSpentImplementing || 0,
			totalTime: (p.timeSpentWriting || 0) + (p.timeSpentImplementing || 0),
			status: p.status,
		}));

		return {
			totalPrompts: prompts.length,
			byStatus,
			byLanguage,
			byFramework,
			totalTimeWriting,
			totalTimeImplementing,
			totalTime,
			favoriteCount,
			avgTimePerPrompt,
			recentActivity,
			topLanguages,
			topFrameworks,
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
