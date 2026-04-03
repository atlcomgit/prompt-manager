/**
 * Workspace service — discovers workspace folders, skills, MCP tools, hooks
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

export interface DiscoveredItem {
	id: string;
	name: string;
	description: string;
}

export class WorkspaceService {
	private skillsCache: DiscoveredItem[] | null = null;
	private hooksCache: DiscoveredItem[] | null = null;
	private mcpToolsCache: DiscoveredItem[] | null = null;
	private refreshInterval: NodeJS.Timeout | null = null;
	private static readonly PROJECT_INSTRUCTIONS_FOLDER = '.github/instructions';
	private static readonly PROJECT_INSTRUCTIONS_FILE_NAME = 'prompt-manager.instructions.md';

	constructor() {
		// Background refresh every 30 seconds
		this.refreshInterval = setInterval(() => {
			this.invalidateCache();
		}, 30000);
	}

	dispose(): void {
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
		}
	}

	private invalidateCache(): void {
		this.skillsCache = null;
		this.hooksCache = null;
		this.mcpToolsCache = null;
	}

	private getHookSearchPaths(): string[] {
		const searchPaths: string[] = [];
		for (const folder of vscode.workspace.workspaceFolders || []) {
			searchPaths.push(path.join(folder.uri.fsPath, '.vscode', 'hooks'));
		}
		searchPaths.push(path.join(os.homedir(), '.copilot', 'hooks'));
		return searchPaths;
	}

	/** Get all workspace folder names */
	getWorkspaceFolders(): string[] {
		return (vscode.workspace.workspaceFolders || []).map(f => f.name);
	}

	/** Get workspace folder paths */
	getWorkspaceFolderPaths(): Map<string, string> {
		const map = new Map<string, string>();
		for (const f of vscode.workspace.workspaceFolders || []) {
			map.set(f.name, f.uri.fsPath);
		}
		return map;
	}

	/** Discover skills from .vscode/skills/ and ~/.copilot/skills/ */
	async getSkills(): Promise<DiscoveredItem[]> {
		if (this.skillsCache) { return this.skillsCache; }

		const skills: DiscoveredItem[] = [];
		const searchPaths: string[] = [];

		// Workspace-local skills
		for (const folder of vscode.workspace.workspaceFolders || []) {
			searchPaths.push(path.join(folder.uri.fsPath, '.vscode', 'skills'));
		}

		// Global skills
		searchPaths.push(path.join(os.homedir(), '.copilot', 'skills'));

		for (const searchPath of searchPaths) {
			try {
				const uri = vscode.Uri.file(searchPath);
				const entries = await vscode.workspace.fs.readDirectory(uri);
				for (const [name, type] of entries) {
					if (type === vscode.FileType.Directory) {
						const skill = await this.readSkillInfo(path.join(searchPath, name), name);
						if (skill && !skills.find(s => s.id === skill.id)) {
							skills.push(skill);
						}
					}
				}
			} catch {
				// Directory doesn't exist
			}
		}

		this.skillsCache = skills;
		return skills;
	}

	/** Read skill info from SKILL.md or similar */
	private async readSkillInfo(skillPath: string, name: string): Promise<DiscoveredItem | null> {
		let description = '';

		// Try to read SKILL.md for description
		for (const filename of ['SKILL.md', 'README.md', 'skill.json']) {
			try {
				const raw = await vscode.workspace.fs.readFile(
					vscode.Uri.file(path.join(skillPath, filename))
				);
				const content = Buffer.from(raw).toString('utf-8');
				if (filename.endsWith('.json')) {
					const json = JSON.parse(content);
					description = json.description || '';
				} else {
					// Extract first line or heading as description
					const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#'));
					description = firstLine?.trim() || '';
				}
				break;
			} catch {
				// File doesn't exist
			}
		}

		return { id: name, name, description };
	}

	/** Discover MCP tools from workspace configuration */
	async getMcpTools(): Promise<DiscoveredItem[]> {
		if (this.mcpToolsCache) { return this.mcpToolsCache; }

		const tools: DiscoveredItem[] = [];

		// Read .vscode/mcp.json or settings
		for (const folder of vscode.workspace.workspaceFolders || []) {
			try {
				const mcpConfigPath = path.join(folder.uri.fsPath, '.vscode', 'mcp.json');
				const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(mcpConfigPath));
				const config = JSON.parse(Buffer.from(raw).toString('utf-8'));

				if (config.servers) {
					for (const [serverId, serverConfig] of Object.entries(config.servers)) {
						tools.push({
							id: serverId,
							name: serverId,
							description: (serverConfig as any).description || `MCP server: ${serverId}`,
						});
					}
				}
			} catch {
				// No MCP config
			}
		}

		// Also check VS Code settings for MCP
		const mcpSettings = vscode.workspace.getConfiguration('mcp');
		const servers = mcpSettings?.get<Record<string, any>>('servers');
		if (servers) {
			for (const [serverId] of Object.entries(servers)) {
				if (!tools.find(t => t.id === serverId)) {
					tools.push({
						id: serverId,
						name: serverId,
						description: `MCP server: ${serverId}`,
					});
				}
			}
		}

		this.mcpToolsCache = tools;
		return tools;
	}

	/** Discover hooks from .vscode/hooks/ and ~/.copilot/hooks/ */
	async getHooks(): Promise<DiscoveredItem[]> {
		if (this.hooksCache) { return this.hooksCache; }

		const hooks: DiscoveredItem[] = [];
		const searchPaths = this.getHookSearchPaths();

		for (const searchPath of searchPaths) {
			try {
				const uri = vscode.Uri.file(searchPath);
				const entries = await vscode.workspace.fs.readDirectory(uri);
				for (const [name, type] of entries) {
					if (type !== vscode.FileType.File) {
						continue;
					}

					const hookName = name.replace(/\.[^.]+$/, '');
					if (!hooks.find(h => h.id === hookName)) {
						hooks.push({
							id: hookName,
							name: hookName,
							description: `Hook: ${hookName}`,
						});
					}
				}
			} catch {
				// Directory doesn't exist
			}
		}

		this.hooksCache = hooks;
		return hooks;
	}

	/** Resolve hook names (without extension) to executable file paths */
	async resolveHookExecutables(hookIds: string[]): Promise<Map<string, string>> {
		const resolved = new Map<string, string>();
		const targets = new Set(hookIds.map(h => h.trim()).filter(Boolean));
		if (targets.size === 0) {
			return resolved;
		}

		const extensionRank = new Map<string, number>([
			['.sh', 0],
			['.bash', 1],
			['.zsh', 2],
			['.py', 3],
			['.js', 4],
			['.mjs', 5],
			['.cjs', 6],
			['', 7],
		]);

		for (const searchPath of this.getHookSearchPaths()) {
			try {
				const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(searchPath));
				const candidatesById = new Map<string, string[]>();

				for (const [name, type] of entries) {
					if (type !== vscode.FileType.File) {
						continue;
					}

					const baseName = name.replace(/\.[^.]+$/, '');
					if (!targets.has(baseName)) {
						continue;
					}

					const absPath = path.join(searchPath, name);
					const arr = candidatesById.get(baseName) || [];
					arr.push(absPath);
					candidatesById.set(baseName, arr);
				}

				for (const [hookId, candidates] of candidatesById.entries()) {
					if (resolved.has(hookId)) {
						continue;
					}
					const sorted = [...candidates].sort((a, b) => {
						const extA = path.extname(a).toLowerCase();
						const extB = path.extname(b).toLowerCase();
						const rankA = extensionRank.get(extA) ?? 100;
						const rankB = extensionRank.get(extB) ?? 100;
						return rankA - rankB;
					});
					resolved.set(hookId, sorted[0]);
				}
			} catch {
				// Directory doesn't exist
			}
		}

		return resolved;
	}

	/** Sync global agent context into the workspace instruction file under .github/instructions/. */
	async syncGlobalAgentInstructionsFile(globalContext: string): Promise<void> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return;
		}

		const instructionsFile = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'prompt-manager', 'chat-memory', 'ai.instructions.md');
		const legacyInstructionsFile = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'prompt-manager', 'ai.instructions.md');
		const projectInstructionsDir = vscode.Uri.joinPath(workspaceFolder.uri, '.github', 'instructions');
		const projectInstructionsFile = vscode.Uri.joinPath(
			workspaceFolder.uri,
			'.github',
			'instructions',
			WorkspaceService.PROJECT_INSTRUCTIONS_FILE_NAME,
		);

		await vscode.workspace.fs.createDirectory(projectInstructionsDir);

		const trimmedContext = (globalContext || '').trim();
		const fileContent = trimmedContext
			? `---\napplyTo: '**'\n---\n\n# Prompt Manager Agent Instructions\n\n${trimmedContext}\n`
			: '';

		await this.writeFileIfChanged(projectInstructionsFile, fileContent);
		await this.deleteFileIfExists(instructionsFile);
		await this.deleteFileIfExists(legacyInstructionsFile);
	}

	/** Ensure .github/instructions is registered in chat.instructionsFilesLocations. */
	async ensureProjectInstructionsFolderRegistered(): Promise<void> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return;
		}

		const chatConfig = vscode.workspace.getConfiguration('chat', workspaceFolder.uri);
		await this.ensurePathInChatLocationsSetting(
			chatConfig,
			'instructionsFilesLocations',
			WorkspaceService.PROJECT_INSTRUCTIONS_FOLDER,
			vscode.Uri.joinPath(workspaceFolder.uri, '.github', 'instructions').fsPath,
			vscode.ConfigurationTarget.Workspace,
			false,
		);
	}

	private async writeFileIfChanged(file: vscode.Uri, content: string): Promise<void> {
		try {
			const current = await vscode.workspace.fs.readFile(file);
			if (Buffer.from(current).toString('utf-8') === content) {
				return;
			}
		} catch {
			// file does not exist yet or cannot be read; write it below
		}

		await vscode.workspace.fs.writeFile(file, Buffer.from(content, 'utf-8'));
	}

	private async deleteFileIfExists(file: vscode.Uri): Promise<void> {
		try {
			await vscode.workspace.fs.delete(file);
		} catch {
			// ignore missing file
		}
	}

	private async ensurePathInChatLocationsSetting(
		chatConfig: vscode.WorkspaceConfiguration,
		settingKey: 'instructionsFilesLocations' | 'promptFilesLocations',
		relativePath: string,
		absolutePath: string,
		target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Workspace,
		fallbackToGlobal: boolean = false,
	): Promise<void> {
		const currentValue = chatConfig.get<unknown>(settingKey);
		const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/u, '');
		const normalizedRelative = normalizePath(relativePath);
		const normalizedAbsolute = normalizePath(absolutePath);
		const hasPath = (value: unknown): boolean => {
			if (Array.isArray(value)) {
				return value
					.filter((v): v is string => typeof v === 'string')
					.some(v => {
						const normalized = normalizePath(v);
						return normalized === normalizedRelative || normalized === normalizedAbsolute;
					});
			}
			if (value && typeof value === 'object') {
				return Object.keys(value as Record<string, unknown>).some(key => {
					const normalized = normalizePath(key);
					return normalized === normalizedRelative || normalized === normalizedAbsolute;
				});
			}
			return false;
		};

		if (hasPath(currentValue)) {
			return;
		}

		if (Array.isArray(currentValue)) {
			const values = currentValue.filter((v): v is string => typeof v === 'string');
			await chatConfig.update(settingKey, [...values, relativePath], target);
			if (fallbackToGlobal && !hasPath(chatConfig.get<unknown>(settingKey))) {
				await chatConfig.update(settingKey, [...values, relativePath], vscode.ConfigurationTarget.Global);
			}
			return;
		}

		if (currentValue && typeof currentValue === 'object') {
			const entries = currentValue as Record<string, unknown>;
			const normalizedEntries: Record<string, boolean> = {};
			for (const [key, value] of Object.entries(entries)) {
				if (typeof value === 'boolean') {
					normalizedEntries[key] = value;
					continue;
				}

				if (typeof value === 'string' && /^\d+$/.test(key)) {
					normalizedEntries[value] = true;
				}
			}

			const updated: Record<string, boolean> = {
				...normalizedEntries,
				[relativePath]: true,
			};
			await chatConfig.update(settingKey, updated, target);
			if (fallbackToGlobal && !hasPath(chatConfig.get<unknown>(settingKey))) {
				await chatConfig.update(settingKey, updated, vscode.ConfigurationTarget.Global);
			}
			return;
		}

		const defaultValue = { [relativePath]: true };
		await chatConfig.update(settingKey, defaultValue, target);
		if (fallbackToGlobal && !hasPath(chatConfig.get<unknown>(settingKey))) {
			await chatConfig.update(settingKey, defaultValue, vscode.ConfigurationTarget.Global);
		}
	}

}
