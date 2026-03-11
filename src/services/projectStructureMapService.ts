import * as vscode from 'vscode';
import ignore from 'ignore';
import { buildAsciiTree, type AsciiTreeItem } from '../utils/asciiTree.js';

const DEFAULT_EXCLUDED_FOLDERS = [
	'.git',
	'node_modules',
	'dist',
	'build',
	'coverage',
	'out',
	'out-tests',
	'.next',
	'.turbo',
	'.cache',
	'.qodo',
	'.vscode/prompt-manager/chat-memory',
];

interface ProjectStructureMapSettings {
	enabled: boolean;
	maxDepth: number;
	maxEntries: number;
	excludedFolders: string[];
}

export interface ProjectStructureMapOptions {
	projectNames?: string[];
}

export interface ProjectStructureMapResult {
	tree: string;
	truncated: boolean;
	maxEntries: number;
	rootNames: string[];
}

interface ScanState {
	items: AsciiTreeItem[];
	entryCount: number;
	truncated: boolean;
	maxEntries: number;
}

export class ProjectStructureMapService {
	async buildProjectStructureMap(
		options: ProjectStructureMapOptions = {},
	): Promise<ProjectStructureMapResult | null> {
		const settings = this.getSettings();
		if (!settings.enabled) {
			return null;
		}

		const workspaceFolders = vscode.workspace.workspaceFolders || [];
		if (workspaceFolders.length === 0) {
			return null;
		}

		const selectedNames = new Set((options.projectNames || []).map(name => name.trim()).filter(Boolean));
		const targets = selectedNames.size > 0
			? workspaceFolders.filter(folder => selectedNames.has(folder.name))
			: workspaceFolders;
		const effectiveTargets = targets.length > 0 ? targets : workspaceFolders;
		const state: ScanState = {
			items: [],
			entryCount: 0,
			truncated: false,
			maxEntries: settings.maxEntries,
		};

		for (const folder of effectiveTargets) {
			if (!this.tryPushEntry(state, { path: folder.name, kind: 'directory' })) {
				break;
			}

			const matcher = await this.createIgnoreMatcher(folder.uri);
			await this.walkDirectory(folder.uri, folder.name, '', 0, settings, matcher, state);
			if (state.truncated) {
				break;
			}
		}

		const tree = buildAsciiTree(state.items);
		if (!tree) {
			return null;
		}

		return {
			tree,
			truncated: state.truncated,
			maxEntries: settings.maxEntries,
			rootNames: effectiveTargets.map(folder => folder.name),
		};
	}

	private getSettings(): ProjectStructureMapSettings {
		const config = vscode.workspace.getConfiguration('promptManager');
		return {
			enabled: config.get<boolean>('memory.projectMap.enabled', true),
			maxDepth: Math.max(1, config.get<number>('memory.projectMap.maxDepth', 2)),
			maxEntries: Math.max(20, config.get<number>('memory.projectMap.maxEntries', 200)),
			excludedFolders: [
				...DEFAULT_EXCLUDED_FOLDERS,
				...(config.get<string[]>('memory.projectMap.excludedFolders', []) || []),
			],
		};
	}

	private async createIgnoreMatcher(rootUri: vscode.Uri) {
		const matcher = ignore();
		for (const fileName of ['.gitignore', '.vscodeignore']) {
			const content = await this.readTextFile(vscode.Uri.joinPath(rootUri, fileName));
			if (content) {
				matcher.add(content);
			}
		}
		return matcher;
	}

	private async readTextFile(fileUri: vscode.Uri): Promise<string> {
		try {
			const bytes = await vscode.workspace.fs.readFile(fileUri);
			return Buffer.from(bytes).toString('utf-8');
		} catch {
			return '';
		}
	}

	private async walkDirectory(
		rootUri: vscode.Uri,
		rootName: string,
		relativePath: string,
		depth: number,
		settings: ProjectStructureMapSettings,
		matcher: ReturnType<typeof ignore>,
		state: ScanState,
	): Promise<void> {
		if (state.truncated || depth >= settings.maxDepth) {
			return;
		}

		const currentUri = relativePath ? vscode.Uri.joinPath(rootUri, relativePath) : rootUri;
		let entries: [string, vscode.FileType][] = [];

		try {
			entries = await vscode.workspace.fs.readDirectory(currentUri);
		} catch {
			return;
		}

		entries.sort((left, right) => {
			const leftIsDirectory = left[1] === vscode.FileType.Directory;
			const rightIsDirectory = right[1] === vscode.FileType.Directory;
			if (leftIsDirectory !== rightIsDirectory) {
				return leftIsDirectory ? -1 : 1;
			}
			return left[0].localeCompare(right[0], 'ru', { sensitivity: 'base' });
		});

		for (const [name, type] of entries) {
			const nextRelativePath = relativePath ? `${relativePath}/${name}` : name;
			if (this.shouldExclude(nextRelativePath, type, settings, matcher)) {
				continue;
			}

			const kind = type === vscode.FileType.Directory ? 'directory' : 'file';
			if (!this.tryPushEntry(state, { path: `${rootName}/${nextRelativePath}`, kind })) {
				return;
			}

			if (type === vscode.FileType.Directory) {
				await this.walkDirectory(rootUri, rootName, nextRelativePath, depth + 1, settings, matcher, state);
				if (state.truncated) {
					return;
				}
			}
		}
	}

	private tryPushEntry(state: ScanState, item: AsciiTreeItem): boolean {
		if (state.entryCount >= state.maxEntries) {
			state.truncated = true;
			return false;
		}

		state.items.push(item);
		state.entryCount += 1;
		return true;
	}

	private shouldExclude(
		relativePath: string,
		type: vscode.FileType,
		settings: ProjectStructureMapSettings,
		matcher: ReturnType<typeof ignore>,
	): boolean {
		const normalizedPath = relativePath.replace(/\\/g, '/');
		if (this.matchesExcludedFolder(normalizedPath, settings.excludedFolders)) {
			return true;
		}

		// Файлы правил игнорирования никогда не исключаем из карты:
		// они сами являются источником правил и должны быть всегда видны.
		const fileName = normalizedPath.split('/').pop() ?? '';
		if (fileName === '.gitignore' || fileName === '.vscodeignore') {
			return false;
		}

		if (type === vscode.FileType.Directory) {
			return matcher.ignores(normalizedPath) || matcher.ignores(`${normalizedPath}/`);
		}

		return matcher.ignores(normalizedPath);
	}

	private matchesExcludedFolder(relativePath: string, excludedFolders: string[]): boolean {
		const normalizedPath = relativePath.replace(/\\/g, '/');
		const segments = normalizedPath.split('/').filter(Boolean);

		return excludedFolders.some(entry => {
			const normalizedEntry = entry.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
			if (!normalizedEntry) {
				return false;
			}

			if (normalizedEntry.includes('/')) {
				return normalizedPath === normalizedEntry || normalizedPath.startsWith(`${normalizedEntry}/`);
			}

			return segments.includes(normalizedEntry);
		});
	}
}