import type { PromptContextFileCard, PromptContextFileKind } from '../types/prompt.js';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']);
const PDF_EXTENSIONS = new Set(['pdf']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'xz']);
const DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'odt', 'rtf']);
const SHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'ods', 'csv']);
const SLIDE_EXTENSIONS = new Set(['ppt', 'pptx', 'odp', 'key']);
const CODE_EXTENSIONS = new Set([
	'ts',
	'tsx',
	'js',
	'jsx',
	'cjs',
	'mjs',
	'json',
	'jsonc',
	'css',
	'scss',
	'less',
	'html',
	'htm',
	'xml',
	'yml',
	'yaml',
	'md',
	'mdts',
	'php',
	'py',
	'rb',
	'go',
	'rs',
	'java',
	'kt',
	'swift',
	'sh',
	'bash',
	'zsh',
	'ps1',
	'sql',
	'vue',
	'svelte',
	'ini',
	'conf',
	'log',
	'txt',
	'env',
]);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'log', 'csv', 'env', 'ini', 'conf']);

function parseFileUrl(value: string): string {
	if (!/^file:\/\//i.test(value)) {
		return value;
	}

	try {
		const url = new URL(value);
		const decodedPath = decodeURIComponent(url.pathname || '');
		if (/^\/[a-zA-Z]:\//.test(decodedPath)) {
			return decodedPath.slice(1);
		}
		if (url.hostname) {
			return `//${url.hostname}${decodedPath}`;
		}
		return decodedPath || value;
	} catch {
		return value;
	}
}

export function normalizeContextFileInput(value: string): string {
	const trimmedValue = String(value || '').trim();
	if (!trimmedValue) {
		return '';
	}

	const withoutBullet = trimmedValue.replace(/^[-*•]\s+/, '').trim();
	const withoutQuotes = withoutBullet.replace(/^["'`]+|["'`]+$/g, '').trim();
	return parseFileUrl(withoutQuotes);
}

export function isLikelyContextFilePath(value: string): boolean {
	const normalizedValue = normalizeContextFileInput(value);
	if (!normalizedValue) {
		return false;
	}

	if (/^(~|\.{1,2}[\\/])/.test(normalizedValue)) {
		return true;
	}

	if (/^[a-zA-Z]:[\\/]/.test(normalizedValue)) {
		return true;
	}

	if (normalizedValue.includes('/') || normalizedValue.includes('\\')) {
		return true;
	}

	return /\.[a-zA-Z0-9_-]{1,12}$/.test(normalizedValue);
}

export function normalizeContextFileReference(filePath: string): string {
	const normalizedValue = normalizeContextFileInput(filePath);
	if (!normalizedValue) {
		return '';
	}

	return normalizedValue.replace(/\\/g, '/');
}

export function isAbsoluteContextFileReference(filePath: string): boolean {
	const normalizedValue = normalizeContextFileReference(filePath);
	if (!normalizedValue) {
		return false;
	}

	return normalizedValue.startsWith('/')
		|| normalizedValue.startsWith('//')
		|| normalizedValue.startsWith('~/')
		|| /^~\//.test(normalizedValue)
		|| /^[a-zA-Z]:\//.test(normalizedValue);
}

export function hasContextFileParentTraversal(filePath: string): boolean {
	const normalizedValue = normalizeContextFileReference(filePath);
	if (!normalizedValue || isAbsoluteContextFileReference(normalizedValue)) {
		return false;
	}

	return normalizedValue.split('/').filter(Boolean).includes('..');
}

export function dedupeContextFileReferences(filePaths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const filePath of filePaths || []) {
		const normalizedPath = normalizeContextFileReference(filePath);
		if (!normalizedPath || seen.has(normalizedPath)) {
			continue;
		}

		seen.add(normalizedPath);
		result.push(normalizedPath);
	}

	return result;
}

export function extractContextFilePathsFromClipboardText(text: string): string[] {
	const lines = String(text || '').split(/\r?\n/);
	return dedupeContextFileReferences(lines.filter(isLikelyContextFilePath));
}

export function getContextFileExtension(filePath: string): string {
	const normalizedPath = normalizeContextFileReference(filePath);
	const segments = normalizedPath.split('/').filter(Boolean);
	const baseName = segments[segments.length - 1] || normalizedPath;
	const extension = baseName.includes('.') ? baseName.slice(baseName.lastIndexOf('.') + 1) : '';
	return extension.toLowerCase();
}

export function getContextFileDisplayName(filePath: string): string {
	const normalizedPath = normalizeContextFileReference(filePath);
	const segments = normalizedPath.split('/').filter(Boolean);
	return segments[segments.length - 1] || normalizedPath;
}

export function getContextFileDirectoryLabel(filePath: string): string {
	const normalizedPath = normalizeContextFileReference(filePath);
	const lastSlashIndex = normalizedPath.lastIndexOf('/');
	if (lastSlashIndex <= 0) {
		return normalizedPath.startsWith('/') ? '/' : '';
	}

	return normalizedPath.slice(0, lastSlashIndex);
}

export function getContextFileKind(filePath: string): PromptContextFileKind {
	const extension = getContextFileExtension(filePath);

	if (IMAGE_EXTENSIONS.has(extension)) {
		return 'image';
	}
	if (VIDEO_EXTENSIONS.has(extension)) {
		return 'video';
	}
	if (AUDIO_EXTENSIONS.has(extension)) {
		return 'audio';
	}
	if (PDF_EXTENSIONS.has(extension)) {
		return 'pdf';
	}
	if (ARCHIVE_EXTENSIONS.has(extension)) {
		return 'archive';
	}
	if (DOCUMENT_EXTENSIONS.has(extension)) {
		return 'document';
	}
	if (SHEET_EXTENSIONS.has(extension)) {
		return 'sheet';
	}
	if (SLIDE_EXTENSIONS.has(extension)) {
		return 'slides';
	}
	if (TEXT_EXTENSIONS.has(extension)) {
		return 'text';
	}
	if (CODE_EXTENSIONS.has(extension)) {
		return 'code';
	}

	return 'other';
}

export function isContextFilePreviewSupported(kind: PromptContextFileKind): boolean {
	return kind === 'image' || kind === 'video';
}

export function formatContextFileSize(sizeBytes?: number | null): string {
	if (!Number.isFinite(sizeBytes) || sizeBytes === undefined || sizeBytes === null || sizeBytes < 0) {
		return '—';
	}

	if (sizeBytes < 1024) {
		return `${sizeBytes} B`;
	}
	if (sizeBytes < 1024 * 1024) {
		return `${(sizeBytes / 1024).toFixed(1)} KB`;
	}
	return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getContextFileTypeLabel(kind: PromptContextFileKind, extension: string): string {
	const upperExtension = extension ? extension.toUpperCase() : '';

	switch (kind) {
		case 'image':
			return upperExtension ? `${upperExtension} image` : 'Image';
		case 'video':
			return upperExtension ? `${upperExtension} video` : 'Video';
		case 'audio':
			return upperExtension ? `${upperExtension} audio` : 'Audio';
		case 'pdf':
			return 'PDF document';
		case 'archive':
			return upperExtension ? `${upperExtension} archive` : 'Archive';
		case 'document':
			return upperExtension ? `${upperExtension} document` : 'Document';
		case 'sheet':
			return upperExtension ? `${upperExtension} table` : 'Spreadsheet';
		case 'slides':
			return upperExtension ? `${upperExtension} slides` : 'Presentation';
		case 'code':
			return upperExtension ? `${upperExtension} source file` : 'Source file';
		case 'text':
			return upperExtension ? `${upperExtension} text file` : 'Text file';
		default:
			return upperExtension ? `${upperExtension} file` : 'File';
	}
}

export function getContextFileExtensionFromMimeType(mimeType: string): string {
	const normalizedMimeType = String(mimeType || '').trim().toLowerCase();
	if (normalizedMimeType === 'image/png') {
		return 'png';
	}
	if (normalizedMimeType === 'image/jpeg') {
		return 'jpg';
	}
	if (normalizedMimeType === 'image/gif') {
		return 'gif';
	}
	if (normalizedMimeType === 'image/webp') {
		return 'webp';
	}
	if (normalizedMimeType === 'image/bmp') {
		return 'bmp';
	}
	if (normalizedMimeType === 'image/svg+xml') {
		return 'svg';
	}
	if (normalizedMimeType.startsWith('image/')) {
		const [, subtype] = normalizedMimeType.split('/', 2);
		return subtype || 'png';
	}

	return 'bin';
}

export function getContextFileTileLabel(filePath: string, kind?: PromptContextFileKind): string {
	const extension = getContextFileExtension(filePath);
	if (extension) {
		return extension.toUpperCase().slice(0, 4);
	}

	switch (kind || getContextFileKind(filePath)) {
		case 'image':
			return 'IMG';
		case 'video':
			return 'VID';
		case 'audio':
			return 'AUD';
		case 'pdf':
			return 'PDF';
		case 'archive':
			return 'ZIP';
		case 'document':
			return 'DOC';
		case 'sheet':
			return 'XLS';
		case 'slides':
			return 'PPT';
		case 'code':
			return 'CODE';
		case 'text':
			return 'TEXT';
		default:
			return 'FILE';
	}
}

export function buildContextFileCardPlaceholder(filePath: string): PromptContextFileCard {
	const normalizedPath = normalizeContextFileReference(filePath);
	const kind = getContextFileKind(normalizedPath);
	const extension = getContextFileExtension(normalizedPath);

	return {
		path: normalizedPath,
		displayName: getContextFileDisplayName(normalizedPath),
		directoryLabel: getContextFileDirectoryLabel(normalizedPath),
		extension,
		tileLabel: getContextFileTileLabel(normalizedPath, kind),
		kind,
		typeLabel: getContextFileTypeLabel(kind, extension),
		exists: true,
		sizeBytes: undefined,
		sizeLabel: '…',
		modifiedAt: undefined,
		previewUri: undefined,
	};
}