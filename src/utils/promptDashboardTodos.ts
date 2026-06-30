import type {
	PromptDashboardTodoFile,
	PromptDashboardTodoFileTypeGroup,
	PromptDashboardTodoFileTypeSummary,
	PromptDashboardTodoMarker,
	PromptDashboardTodosData,
} from '../types/promptDashboard.js';

const TODO_MARKER_PATTERN = /\/\/\?!\?|todo/gi;
const TODO_PREVIEW_MAX_LENGTH = 180;

/** Describes text content that should be scanned for ToDo markers. */
export interface PromptDashboardTodoExtractionInput {
	project: string;
	filePath: string;
	content: string;
	maxMarkers?: number;
}

/** Carries extracted markers and a local truncation flag for one scanned file. */
export interface PromptDashboardTodoExtractionResult {
	markers: PromptDashboardTodoMarker[];
	truncated: boolean;
}

/** Builds a grouped dashboard payload from a flat ToDo marker list. */
export interface PromptDashboardTodosDataInput {
	markers: PromptDashboardTodoMarker[];
	scannedFileCount: number;
	skippedFileCount: number;
	maxResults: number;
	truncated: boolean;
	generatedAt?: string;
}

/** Normalizes a project-relative file path for stable grouping keys. */
export function normalizePromptDashboardTodoPath(filePath: string): string {
	return String(filePath || '')
		.replace(/\\/g, '/')
		.replace(/^\.\/+/, '')
		.replace(/^\/+/, '')
		.split('/')
		.map(segment => segment.trim())
		.filter(Boolean)
		.join('/');
}

/** Resolves the compact file type used by the ToDo widget filter. */
export function normalizePromptDashboardTodoFileType(filePath: string): string {
	const normalizedPath = normalizePromptDashboardTodoPath(filePath);
	const fileName = normalizedPath.split('/').pop() || normalizedPath;
	if (!fileName || !fileName.includes('.')) {
		return normalizeSpecialPromptDashboardTodoFileType(fileName);
	}

	const extension = fileName.split('.').pop()?.trim().toLowerCase() || '';
	return extension || normalizeSpecialPromptDashboardTodoFileType(fileName);
}

/** Formats one file type for compact filter chips and tree headers. */
export function formatPromptDashboardTodoFileTypeLabel(fileType: string): string {
	const normalizedType = String(fileType || '').trim().toLowerCase();
	if (!normalizedType || normalizedType === 'other') {
		return 'other';
	}
	if (normalizedType === 'dockerfile' || normalizedType === 'makefile') {
		return normalizedType;
	}
	return `.${normalizedType}`;
}

/** Extracts every supported ToDo marker from one UTF-8 text file. */
export function extractPromptDashboardTodoMarkers(
	input: PromptDashboardTodoExtractionInput,
): PromptDashboardTodoExtractionResult {
	const project = String(input.project || '').trim();
	const filePath = normalizePromptDashboardTodoPath(input.filePath);
	const fileType = normalizePromptDashboardTodoFileType(filePath);
	const maxMarkers = Number.isFinite(input.maxMarkers)
		? Math.max(0, Math.floor(input.maxMarkers || 0))
		: Number.POSITIVE_INFINITY;
	const markers: PromptDashboardTodoMarker[] = [];
	let truncated = false;

	if (!project || !filePath || !input.content || maxMarkers <= 0) {
		return { markers, truncated: false };
	}

	const lines = input.content.split(/\r?\n/);
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const lineText = lines[lineIndex];
		TODO_MARKER_PATTERN.lastIndex = 0;
		let match = TODO_MARKER_PATTERN.exec(lineText);
		while (match) {
			if (markers.length >= maxMarkers) {
				truncated = true;
				return { markers, truncated };
			}

			const token = match[0];
			const line = lineIndex + 1;
			const column = match.index + 1;
			markers.push({
				id: buildPromptDashboardTodoMarkerId({ project, filePath, line, column, token }),
				project,
				filePath,
				fileType,
				marker: token.toLowerCase() === 'todo' ? 'todo' : 'custom',
				token,
				line,
				column,
				preview: normalizePromptDashboardTodoPreview(lineText),
			});
			match = TODO_MARKER_PATTERN.exec(lineText);
		}
	}

	return { markers, truncated };
}

/** Builds the grouped ToDo payload rendered by the dashboard widget. */
export function buildPromptDashboardTodosData(input: PromptDashboardTodosDataInput): PromptDashboardTodosData {
	const markers = sortPromptDashboardTodoMarkers(input.markers || []);
	const fileTypeSummaries = buildPromptDashboardTodoFileTypeSummaries(markers);
	const projects = Array.from(groupPromptDashboardTodosByProject(markers).entries())
		.sort(([left], [right]) => left.localeCompare(right, 'ru'))
		.map(([project, projectMarkers]) => buildPromptDashboardTodoProjectGroup(project, projectMarkers));

	return {
		generatedAt: input.generatedAt || new Date().toISOString(),
		projects,
		fileTypes: fileTypeSummaries,
		markerCount: markers.length,
		fileCount: countPromptDashboardTodoFiles(markers),
		scannedFileCount: Math.max(0, input.scannedFileCount || 0),
		skippedFileCount: Math.max(0, input.skippedFileCount || 0),
		maxResults: Math.max(0, input.maxResults || 0),
		truncated: input.truncated === true,
	};
}

/** Returns all markers from a grouped ToDo payload in stable render order. */
export function flattenPromptDashboardTodoMarkers(data: PromptDashboardTodosData): PromptDashboardTodoMarker[] {
	return data.projects.flatMap(project => project.fileTypes.flatMap(group => group.files.flatMap(file => file.markers)));
}

/** Filters grouped ToDo payload by selected file types while keeping scan metadata intact. */
export function filterPromptDashboardTodosDataByFileTypes(
	data: PromptDashboardTodosData,
	selectedFileTypes: readonly string[],
): PromptDashboardTodosData {
	const selectedTypes = new Set(
		(selectedFileTypes || [])
			.map(fileType => String(fileType || '').trim().toLowerCase())
			.filter(Boolean),
	);
	if (selectedTypes.size === 0) {
		return data;
	}

	const markers = flattenPromptDashboardTodoMarkers(data)
		.filter(marker => selectedTypes.has(marker.fileType));
	return buildPromptDashboardTodosData({
		markers,
		scannedFileCount: data.scannedFileCount,
		skippedFileCount: data.skippedFileCount,
		maxResults: data.maxResults,
		truncated: data.truncated,
		generatedAt: data.generatedAt,
	});
}

/** Builds a stable marker id from a file location and matched token. */
function buildPromptDashboardTodoMarkerId(input: {
	project: string;
	filePath: string;
	line: number;
	column: number;
	token: string;
}): string {
	return [
		input.project,
		input.filePath,
		String(input.line),
		String(input.column),
		input.token.toLowerCase(),
	].map(encodeURIComponent).join(':');
}

/** Keeps long source lines readable without sending full line payloads into the webview. */
function normalizePromptDashboardTodoPreview(lineText: string): string {
	const normalized = String(lineText || '').replace(/\s+/g, ' ').trim();
	if (normalized.length <= TODO_PREVIEW_MAX_LENGTH) {
		return normalized;
	}
	return `${normalized.slice(0, TODO_PREVIEW_MAX_LENGTH - 3)}...`;
}

/** Handles common extensionless filenames as filterable pseudo-types. */
function normalizeSpecialPromptDashboardTodoFileType(fileName: string): string {
	const normalizedName = String(fileName || '').trim().toLowerCase();
	if (normalizedName === 'dockerfile') {
		return 'dockerfile';
	}
	if (normalizedName === 'makefile') {
		return 'makefile';
	}
	return 'other';
}

/** Sorts markers by project, file, line and marker column. */
function sortPromptDashboardTodoMarkers(markers: PromptDashboardTodoMarker[]): PromptDashboardTodoMarker[] {
	return [...markers].sort((left, right) => {
		const projectOrder = left.project.localeCompare(right.project, 'ru');
		if (projectOrder !== 0) {
			return projectOrder;
		}
		const pathOrder = left.filePath.localeCompare(right.filePath, 'ru');
		if (pathOrder !== 0) {
			return pathOrder;
		}
		return left.line - right.line || left.column - right.column;
	});
}

/** Groups markers by workspace project. */
function groupPromptDashboardTodosByProject(
	markers: PromptDashboardTodoMarker[],
): Map<string, PromptDashboardTodoMarker[]> {
	const grouped = new Map<string, PromptDashboardTodoMarker[]>();
	for (const marker of markers) {
		grouped.set(marker.project, [...(grouped.get(marker.project) || []), marker]);
	}
	return grouped;
}

/** Builds one project tree branch from flat project markers. */
function buildPromptDashboardTodoProjectGroup(
	project: string,
	markers: PromptDashboardTodoMarker[],
) {
	const fileTypes = Array.from(groupPromptDashboardTodosByFileType(markers).entries())
		.sort(([left], [right]) => left.localeCompare(right, 'ru'))
		.map(([fileType, fileTypeMarkers]) => buildPromptDashboardTodoFileTypeGroup(fileType, fileTypeMarkers));
	return {
		project,
		markerCount: markers.length,
		fileCount: countPromptDashboardTodoFiles(markers),
		fileTypes,
	};
}

/** Groups markers by normalized file type. */
function groupPromptDashboardTodosByFileType(
	markers: PromptDashboardTodoMarker[],
): Map<string, PromptDashboardTodoMarker[]> {
	const grouped = new Map<string, PromptDashboardTodoMarker[]>();
	for (const marker of markers) {
		grouped.set(marker.fileType, [...(grouped.get(marker.fileType) || []), marker]);
	}
	return grouped;
}

/** Builds one file-type tree branch from flat markers. */
function buildPromptDashboardTodoFileTypeGroup(
	fileType: string,
	markers: PromptDashboardTodoMarker[],
): PromptDashboardTodoFileTypeGroup {
	const files = Array.from(groupPromptDashboardTodosByFile(markers).entries())
		.sort(([left], [right]) => left.localeCompare(right, 'ru'))
		.map(([filePath, fileMarkers]) => buildPromptDashboardTodoFile(filePath, fileMarkers));
	return {
		fileType,
		label: formatPromptDashboardTodoFileTypeLabel(fileType),
		markerCount: markers.length,
		fileCount: files.length,
		files,
	};
}

/** Groups markers by project-relative file path. */
function groupPromptDashboardTodosByFile(markers: PromptDashboardTodoMarker[]): Map<string, PromptDashboardTodoMarker[]> {
	const grouped = new Map<string, PromptDashboardTodoMarker[]>();
	for (const marker of markers) {
		grouped.set(marker.filePath, [...(grouped.get(marker.filePath) || []), marker]);
	}
	return grouped;
}

/** Builds one grouped file row from flat file markers. */
function buildPromptDashboardTodoFile(
	filePath: string,
	markers: PromptDashboardTodoMarker[],
): PromptDashboardTodoFile {
	const pathParts = splitPromptDashboardTodoPath(filePath);
	const firstMarker = markers[0];
	return {
		project: firstMarker?.project || '',
		filePath,
		fileName: pathParts.fileName,
		directoryPath: pathParts.directoryPath,
		fileType: firstMarker?.fileType || normalizePromptDashboardTodoFileType(filePath),
		markerCount: markers.length,
		markers: sortPromptDashboardTodoMarkers(markers),
	};
}

/** Splits one normalized file path into directory and file-name parts. */
function splitPromptDashboardTodoPath(filePath: string): { fileName: string; directoryPath: string } {
	const normalizedPath = normalizePromptDashboardTodoPath(filePath);
	const segments = normalizedPath.split('/').filter(Boolean);
	const fileName = segments.pop() || normalizedPath;
	return {
		fileName,
		directoryPath: segments.join('/'),
	};
}

/** Builds filter summaries for all file types present in the marker list. */
function buildPromptDashboardTodoFileTypeSummaries(
	markers: PromptDashboardTodoMarker[],
): PromptDashboardTodoFileTypeSummary[] {
	return Array.from(groupPromptDashboardTodosByFileType(markers).entries())
		.sort(([left], [right]) => left.localeCompare(right, 'ru'))
		.map(([fileType, fileTypeMarkers]) => ({
			fileType,
			label: formatPromptDashboardTodoFileTypeLabel(fileType),
			markerCount: fileTypeMarkers.length,
			fileCount: countPromptDashboardTodoFiles(fileTypeMarkers),
		}));
}

/** Counts unique files touched by the provided markers. */
function countPromptDashboardTodoFiles(markers: PromptDashboardTodoMarker[]): number {
	return new Set(markers.map(marker => `${marker.project}:${marker.filePath}`)).size;
}