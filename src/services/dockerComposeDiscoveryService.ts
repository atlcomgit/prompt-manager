import { readdirSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getCodeMapSettings } from '../codemap/codeMapConfig.js';
import { shouldIgnoreRealtimeRefreshPath } from '../codemap/codeMapRealtimeRefresh.js';
import type { DockerComposeFileReference } from '../types/docker.js';
import {
	matchesDockerComposeRootPattern,
	normalizeDockerComposeRelativePath,
	normalizeDockerComposeRootPattern,
	shouldIncludeDockerComposeFile,
} from '../utils/dockerComposeDiscovery.js';

export const DEFAULT_DOCKER_COMPOSE_FILE_PATTERNS = [
	'docker-compose.yml',
	'*.docker-compose.yml',
	'compose.yml',
	'*.compose.yml',
	'docker-compose.yaml',
	'*.docker-compose.yaml',
	'compose.yaml',
	'*.compose.yaml',
];

const MAX_DOCKER_COMPOSE_PATTERNS = 64;

/** Discovers compose files in workspace folders and invalidates results on file changes. */
export class DockerComposeDiscoveryService implements vscode.Disposable {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	private readonly watchers: vscode.Disposable[] = [];
	private readonly configListener: vscode.Disposable;
	private cachedFiles: DockerComposeFileReference[] | null = null;

	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor() {
		this.rebuildWatchers();
		this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('promptManager.docker.composeFilePatterns')
				|| event.affectsConfiguration('promptManager.codemap.excludedPaths')) {
				this.rebuildWatchers();
				this.invalidate();
			}
		});
	}

	/** Returns normalized compose glob patterns from settings. */
	getComposeFilePatterns(): string[] {
		const configured = vscode.workspace
			.getConfiguration('promptManager')
			.get<unknown>('docker.composeFilePatterns', DEFAULT_DOCKER_COMPOSE_FILE_PATTERNS);
		if (!Array.isArray(configured)) {
			return [...DEFAULT_DOCKER_COMPOSE_FILE_PATTERNS];
		}

		const normalized = configured
			.filter((value): value is string => typeof value === 'string')
			.map(normalizeDockerComposeRootPattern)
			.filter(Boolean)
			.slice(0, MAX_DOCKER_COMPOSE_PATTERNS);
		return normalized.length > 0 ? Array.from(new Set(normalized)) : [...DEFAULT_DOCKER_COMPOSE_FILE_PATTERNS];
	}

	/** Reads compose files from cache or scans workspace folders. */
	async getComposeFiles(force = false): Promise<DockerComposeFileReference[]> {
		if (!force && this.cachedFiles) {
			return this.cachedFiles;
		}

		const folders = vscode.workspace.workspaceFolders || [];
		const patterns = this.getComposeFilePatterns();
		const excludedPaths = this.getExcludedPaths();
		const byPath = new Map<string, DockerComposeFileReference>();
		for (const folder of folders) {
			if (shouldSkipDockerComposeWorkspaceFolder(folder, excludedPaths)) {
				continue;
			}
			for (const pattern of patterns) {
				const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), undefined, 500);
				for (const uri of files) {
					const filePath = uri.fsPath;
					const relativePath = path.relative(folder.uri.fsPath, filePath).split(path.sep).join('/');
					if (byPath.has(filePath) || !shouldIncludeDockerComposeFile(relativePath, excludedPaths)) {
						continue;
					}
					byPath.set(filePath, {
						project: folder.name,
						projectPath: folder.uri.fsPath,
						filePath,
						relativePath,
					});
				}
			}
		}

		this.cachedFiles = Array.from(byPath.values())
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'ru'));
		return this.cachedFiles;
	}

	/** Reads compose files synchronously for fast startup cache validation. */
	getComposeFilesSync(): DockerComposeFileReference[] {
		if (this.cachedFiles) {
			return this.cachedFiles;
		}

		const folders = vscode.workspace.workspaceFolders || [];
		const patterns = this.getComposeFilePatterns();
		const excludedPaths = this.getExcludedPaths();
		const byPath = new Map<string, DockerComposeFileReference>();
		for (const folder of folders) {
			if (shouldSkipDockerComposeWorkspaceFolder(folder, excludedPaths)) {
				continue;
			}
			let entries: Array<{ isFile: () => boolean; name: string }>;
			try {
				entries = readdirSync(folder.uri.fsPath, { withFileTypes: true, encoding: 'utf8' }) as Array<{ isFile: () => boolean; name: string }>;
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isFile()) {
					continue;
				}
				const relativePath = normalizeDockerComposeRelativePath(entry.name);
				if (!relativePath || !patterns.some(pattern => matchesDockerComposeRootPattern(relativePath, pattern))) {
					continue;
				}
				if (!shouldIncludeDockerComposeFile(relativePath, excludedPaths)) {
					continue;
				}
				const filePath = path.join(folder.uri.fsPath, entry.name);
				if (byPath.has(filePath)) {
					continue;
				}
				byPath.set(filePath, {
					project: folder.name,
					projectPath: folder.uri.fsPath,
					filePath,
					relativePath,
				});
			}
		}

		this.cachedFiles = Array.from(byPath.values())
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'ru'));
		return this.cachedFiles;
	}

	/** Clears cached discovery results and notifies listeners. */
	invalidate(): void {
		this.cachedFiles = null;
		this.onDidChangeEmitter.fire();
	}

	/** Disposes file watchers and event emitters. */
	dispose(): void {
		for (const watcher of this.watchers.splice(0)) {
			watcher.dispose();
		}
		this.configListener.dispose();
		this.onDidChangeEmitter.dispose();
	}

	/** Recreates workspace file watchers for current compose patterns. */
	private rebuildWatchers(): void {
		for (const watcher of this.watchers.splice(0)) {
			watcher.dispose();
		}

		const folders = vscode.workspace.workspaceFolders || [];
		const excludedPaths = this.getExcludedPaths();
		for (const folder of folders) {
			if (shouldSkipDockerComposeWorkspaceFolder(folder, excludedPaths)) {
				continue;
			}
			for (const pattern of this.getComposeFilePatterns()) {
				const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
				watcher.onDidCreate(() => this.invalidate());
				watcher.onDidChange(() => this.invalidate());
				watcher.onDidDelete(() => this.invalidate());
				this.watchers.push(watcher);
			}
		}
	}

	/** Reads shared extension excluded paths used by project scanning features. */
	private getExcludedPaths(): string[] {
		return getCodeMapSettings().excludedPaths;
	}
}

/** Skips workspace projects whose root folder itself is excluded by extension settings. */
function shouldSkipDockerComposeWorkspaceFolder(folder: vscode.WorkspaceFolder, excludedPaths: string[]): boolean {
	const folderName = normalizeDockerComposeRelativePath(folder.name || path.basename(folder.uri.fsPath));
	return Boolean(folderName && shouldIgnoreRealtimeRefreshPath(folderName, excludedPaths));
}