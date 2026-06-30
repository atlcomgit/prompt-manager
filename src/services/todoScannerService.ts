import * as vscode from 'vscode';
import * as path from 'path';
import ignore from 'ignore';
import { getCodeMapSettings } from '../codemap/codeMapConfig.js';
import type { PromptDashboardTodoMarker, PromptDashboardTodosData } from '../types/promptDashboard.js';
import {
	buildPromptDashboardTodosData,
	extractPromptDashboardTodoMarkers,
	normalizePromptDashboardTodoPath,
} from '../utils/promptDashboardTodos.js';

const DEFAULT_EXCLUDED_PATHS = [
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
	'.vscode/prompt-manager',
];

const BINARY_FILE_EXTENSIONS = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif',
	'pdf', 'zip', 'gz', 'tgz', 'rar', '7z', 'tar',
	'wasm', 'so', 'dll', 'dylib', 'exe', 'bin',
	'woff', 'woff2', 'ttf', 'otf', 'eot',
	'mp3', 'mp4', 'mov', 'avi', 'webm', 'ogg',
]);

interface TodoScannerProjectTarget {
	name: string;
	rootPath: string;
}

interface TodoScannerState {
	markers: PromptDashboardTodoMarker[];
	scannedFileCount: number;
	skippedFileCount: number;
	visitedFileCount: number;
	truncated: boolean;
}

export interface TodoScannerInput {
	projectPaths: Map<string, string>;
	projectNames: string[];
}

/** Scans workspace text files for ToDo dashboard markers with bounded IO. */
export class TodoScannerService {
	private static readonly MAX_RESULTS = 500;
	private static readonly MAX_SCANNED_FILES = 2500;
	private static readonly MAX_FILE_BYTES = 512 * 1024;

	/** Exposes the payload result limit used by placeholder snapshots. */
	getMaxResults(): number {
		return TodoScannerService.MAX_RESULTS;
	}

	/** Scans selected workspace projects and returns a grouped dashboard payload. */
	async scanTodos(input: TodoScannerInput): Promise<PromptDashboardTodosData> {
		const state: TodoScannerState = {
			markers: [],
			scannedFileCount: 0,
			skippedFileCount: 0,
			visitedFileCount: 0,
			truncated: false,
		};
		const excludedPaths = this.resolveExcludedPaths();
		const targets = this.resolveProjectTargets(input.projectPaths, input.projectNames);

		for (const target of targets) {
			if (state.truncated) {
				break;
			}
			const matcher = await this.createIgnoreMatcher(vscode.Uri.file(target.rootPath));
			await this.walkProject(target, '', matcher, excludedPaths, state);
		}

		return buildPromptDashboardTodosData({
			markers: state.markers,
			scannedFileCount: state.scannedFileCount,
			skippedFileCount: state.skippedFileCount,
			maxResults: TodoScannerService.MAX_RESULTS,
			truncated: state.truncated,
		});
	}

	/** Resolves selected project names against the visible workspace project map. */
	private resolveProjectTargets(projectPaths: Map<string, string>, projectNames: string[]): TodoScannerProjectTarget[] {
		const requestedNames = new Set((projectNames || []).map(project => project.trim()).filter(Boolean));
		const entries = Array.from(projectPaths.entries())
			.filter(([project]) => requestedNames.size === 0 || requestedNames.has(project))
			.sort(([left], [right]) => left.localeCompare(right, 'ru'));
		return entries.map(([name, rootPath]) => ({ name, rootPath }));
	}

	/** Combines built-in generated folders with user-configured dashboard/code-map exclusions. */
	private resolveExcludedPaths(): string[] {
		const memoryProjectMapExcludedFolders = vscode.workspace
			.getConfiguration('promptManager.memory')
			.get<string[]>('projectMap.excludedFolders', []) || [];
		return Array.from(new Set([
			...DEFAULT_EXCLUDED_PATHS,
			...getCodeMapSettings().excludedPaths,
			...memoryProjectMapExcludedFolders,
		].map(item => normalizePromptDashboardTodoPath(item)).filter(Boolean)));
	}

	/** Builds a root ignore matcher from project ignore files. */
	private async createIgnoreMatcher(rootUri: vscode.Uri): Promise<ReturnType<typeof ignore>> {
		const matcher = ignore();
		for (const fileName of ['.gitignore', '.vscodeignore']) {
			const content = await this.readTextFile(vscode.Uri.joinPath(rootUri, fileName));
			if (content.trim()) {
				matcher.add(content);
			}
		}
		return matcher;
	}

	/** Reads one UTF-8 text file and returns an empty string when it is absent. */
	private async readTextFile(fileUri: vscode.Uri): Promise<string> {
		try {
			const bytes = await vscode.workspace.fs.readFile(fileUri);
			return Buffer.from(bytes).toString('utf-8');
		} catch {
			return '';
		}
	}

	/** Walks one project directory until the scan reaches its configured bounds. */
	private async walkProject(
		target: TodoScannerProjectTarget,
		relativePath: string,
		matcher: ReturnType<typeof ignore>,
		excludedPaths: string[],
		state: TodoScannerState,
	): Promise<void> {
		if (state.truncated) {
			return;
		}

		const directoryUri = vscode.Uri.file(path.join(target.rootPath, relativePath));
		let entries: [string, vscode.FileType][] = [];
		try {
			entries = await vscode.workspace.fs.readDirectory(directoryUri);
		} catch {
			state.skippedFileCount += 1;
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

		for (const [entryName, fileType] of entries) {
			if (state.truncated) {
				return;
			}

			const nextRelativePath = normalizePromptDashboardTodoPath(relativePath ? `${relativePath}/${entryName}` : entryName);
			if (this.shouldExcludePath(nextRelativePath, fileType, matcher, excludedPaths)) {
				continue;
			}

			if (fileType === vscode.FileType.Directory) {
				await this.walkProject(target, nextRelativePath, matcher, excludedPaths, state);
				continue;
			}

			if (fileType === vscode.FileType.File) {
				await this.scanFile(target, nextRelativePath, state);
			}
		}
	}

	/** Checks static exclusion rules and ignore-file rules for one project-relative path. */
	private shouldExcludePath(
		relativePath: string,
		fileType: vscode.FileType,
		matcher: ReturnType<typeof ignore>,
		excludedPaths: string[],
	): boolean {
		if (this.matchesExcludedPath(relativePath, excludedPaths)) {
			return true;
		}
		if (fileType === vscode.FileType.Directory) {
			return matcher.ignores(relativePath) || matcher.ignores(`${relativePath}/`);
		}
		return matcher.ignores(relativePath);
	}

	/** Checks one path against folder names and path-prefix exclusions. */
	private matchesExcludedPath(relativePath: string, excludedPaths: string[]): boolean {
		const normalizedPath = normalizePromptDashboardTodoPath(relativePath);
		const segments = normalizedPath.split('/').filter(Boolean);
		return excludedPaths.some(excludedPath => {
			if (!excludedPath) {
				return false;
			}
			if (excludedPath.includes('/')) {
				return normalizedPath === excludedPath || normalizedPath.startsWith(`${excludedPath}/`);
			}
			return segments.includes(excludedPath);
		});
	}

	/** Reads and scans one candidate text file when it fits the configured bounds. */
	private async scanFile(target: TodoScannerProjectTarget, relativePath: string, state: TodoScannerState): Promise<void> {
		state.visitedFileCount += 1;
		if (state.visitedFileCount > TodoScannerService.MAX_SCANNED_FILES) {
			state.truncated = true;
			return;
		}
		if (this.shouldSkipFileByName(relativePath)) {
			state.skippedFileCount += 1;
			return;
		}

		const fileUri = vscode.Uri.file(path.join(target.rootPath, relativePath));
		try {
			const stat = await vscode.workspace.fs.stat(fileUri);
			if (stat.size > TodoScannerService.MAX_FILE_BYTES) {
				state.skippedFileCount += 1;
				return;
			}

			const bytes = await vscode.workspace.fs.readFile(fileUri);
			if (this.looksBinary(bytes)) {
				state.skippedFileCount += 1;
				return;
			}

			state.scannedFileCount += 1;
			const remainingMarkers = TodoScannerService.MAX_RESULTS - state.markers.length;
			const result = extractPromptDashboardTodoMarkers({
				project: target.name,
				filePath: relativePath,
				content: Buffer.from(bytes).toString('utf-8'),
				maxMarkers: remainingMarkers,
			});
			state.markers.push(...result.markers);
			if (result.truncated || state.markers.length >= TodoScannerService.MAX_RESULTS) {
				state.truncated = true;
			}
		} catch {
			state.skippedFileCount += 1;
		}
	}

	/** Skips known binary assets before reading file contents. */
	private shouldSkipFileByName(relativePath: string): boolean {
		const fileName = relativePath.split('/').pop() || relativePath;
		const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() || '' : '';
		return Boolean(extension && BINARY_FILE_EXTENSIONS.has(extension));
	}

	/** Uses a small null-byte probe to avoid decoding binary payloads as text. */
	private looksBinary(bytes: Uint8Array): boolean {
		const probeLength = Math.min(bytes.length, 1024);
		for (let index = 0; index < probeLength; index += 1) {
			if (bytes[index] === 0) {
				return true;
			}
		}
		return false;
	}
}