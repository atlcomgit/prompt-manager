export const CODEMAP_REALTIME_REFRESH_DELAY_MS = 5000;
export const CODEMAP_REALTIME_REFRESH_MIN_INTERVAL_MS = 60_000;

export function computeRealtimeRefreshTargetTime(nowMs: number, lastQueuedAtMs = 0): number {
	return Math.max(
		nowMs + CODEMAP_REALTIME_REFRESH_DELAY_MS,
		lastQueuedAtMs > 0 ? lastQueuedAtMs + CODEMAP_REALTIME_REFRESH_MIN_INTERVAL_MS : 0,
	);
}

export function shouldIgnoreRealtimeRefreshPath(relativePath: string, excludedPaths: string[]): boolean {
	const normalizedPath = normalizeRealtimePath(relativePath);
	if (!normalizedPath) {
		return true;
	}

	const ignoredPrefixes = [
		'.git',
		'.vscode/prompt-manager',
		...((excludedPaths || []).map(item => normalizeRealtimePath(item)).filter(Boolean)),
	];

	return ignoredPrefixes.some(prefix => matchesRealtimePathPrefix(normalizedPath, prefix));
}

function matchesRealtimePathPrefix(relativePath: string, prefix: string): boolean {
	const normalizedPrefix = normalizeRealtimePath(prefix).replace(/\/+$/g, '');
	if (!normalizedPrefix) {
		return false;
	}

	return relativePath === normalizedPrefix || relativePath.startsWith(`${normalizedPrefix}/`);
}

function normalizeRealtimePath(value: string): string {
	return String(value || '')
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\.\/+/, '')
		.replace(/^\/+/, '')
		.replace(/\/+$/g, '');
}
