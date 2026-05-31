import { shouldIgnoreRealtimeRefreshPath } from '../codemap/codeMapRealtimeRefresh.js';

/** Escapes plain file-name text before it is used inside a root-level glob regex. */
function escapeDockerComposeRootPatternRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

/** Converts recursive compose patterns into root-only workspace project patterns. */
export function normalizeDockerComposeRootPattern(value: string): string {
	let normalized = String(value || '')
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\.\/+/g, '')
		.replace(/^\/+/g, '')
		.replace(/\/+/g, '/');
	while (normalized.startsWith('**/')) {
		normalized = normalized.slice(3);
	}
	const parts = normalized.split('/').filter(Boolean);
	const rootPattern = parts.length > 0 ? parts[parts.length - 1] : normalized;
	return rootPattern && rootPattern !== '**' ? rootPattern : '';
}

/** Matches one root-level file name against a normalized compose glob pattern. */
export function matchesDockerComposeRootPattern(fileName: string, pattern: string): boolean {
	const normalizedFileName = normalizeDockerComposeRelativePath(fileName);
	const normalizedPattern = normalizeDockerComposeRootPattern(pattern);
	if (!normalizedFileName || !normalizedPattern) {
		return false;
	}
	const patternRegex = new RegExp(`^${normalizedPattern
		.split('*')
		.map(escapeDockerComposeRootPatternRegex)
		.join('.*')}$`);
	return patternRegex.test(normalizedFileName);
}

/** Returns true only for compose files placed directly in a scanned project root. */
export function shouldIncludeDockerComposeFile(relativePath: string, excludedPaths: string[]): boolean {
	const normalized = normalizeDockerComposeRelativePath(relativePath);
	return Boolean(normalized && !normalized.includes('/') && !shouldIgnoreRealtimeRefreshPath(normalized, excludedPaths));
}

/** Normalizes a workspace-relative path for Docker compose discovery checks. */
export function normalizeDockerComposeRelativePath(value: string): string {
	return String(value || '')
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\.\/+/g, '')
		.replace(/^\/+/g, '')
		.replace(/\/+/g, '/');
}
