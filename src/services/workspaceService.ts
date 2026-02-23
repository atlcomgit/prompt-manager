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
		const searchPaths: string[] = [];

		for (const folder of vscode.workspace.workspaceFolders || []) {
			searchPaths.push(path.join(folder.uri.fsPath, '.vscode', 'hooks'));
		}
		searchPaths.push(path.join(os.homedir(), '.copilot', 'hooks'));

		for (const searchPath of searchPaths) {
			try {
				const uri = vscode.Uri.file(searchPath);
				const entries = await vscode.workspace.fs.readDirectory(uri);
				for (const [name, type] of entries) {
					if (type === vscode.FileType.File || type === vscode.FileType.Directory) {
						const hookName = name.replace(/\.[^.]+$/, '');
						if (!hooks.find(h => h.id === hookName)) {
							hooks.push({
								id: hookName,
								name: hookName,
								description: `Hook: ${hookName}`,
							});
						}
					}
				}
			} catch {
				// Directory doesn't exist
			}
		}

		this.hooksCache = hooks;
		return hooks;
	}
}
