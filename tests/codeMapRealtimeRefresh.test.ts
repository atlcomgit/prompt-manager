import test from 'node:test';
import assert from 'node:assert/strict';

import {
	CODEMAP_REALTIME_REFRESH_DELAY_MS,
	CODEMAP_REALTIME_REFRESH_MIN_INTERVAL_MS,
	computeRealtimeRefreshTargetTime,
	shouldIgnoreRealtimeRefreshPath,
} from '../src/codemap/codeMapRealtimeRefresh.js';

test('computeRealtimeRefreshTargetTime uses five-second delay for the first run', () => {
	const nowMs = 1_000;
	assert.equal(
		computeRealtimeRefreshTargetTime(nowMs),
		nowMs + CODEMAP_REALTIME_REFRESH_DELAY_MS,
	);
});

test('computeRealtimeRefreshTargetTime respects the one-minute throttle window', () => {
	const lastQueuedAtMs = 20_000;
	const nowMs = 30_000;
	assert.equal(
		computeRealtimeRefreshTargetTime(nowMs, lastQueuedAtMs),
		lastQueuedAtMs + CODEMAP_REALTIME_REFRESH_MIN_INTERVAL_MS,
	);
});

test('computeRealtimeRefreshTargetTime still keeps a five-second quiet period after the latest change', () => {
	const lastQueuedAtMs = 20_000;
	const nowMs = 78_000;
	assert.equal(
		computeRealtimeRefreshTargetTime(nowMs, lastQueuedAtMs),
		nowMs + CODEMAP_REALTIME_REFRESH_DELAY_MS,
	);
});

test('shouldIgnoreRealtimeRefreshPath ignores internal codemap files and configured exclusions', () => {
	assert.equal(
		shouldIgnoreRealtimeRefreshPath('.vscode/prompt-manager/chat-memory/codemap.instructions.md', []),
		true,
	);
	assert.equal(
		shouldIgnoreRealtimeRefreshPath('.github/instructions/prompt-manager.instructions.md', ['.github']),
		true,
	);
	assert.equal(
		shouldIgnoreRealtimeRefreshPath('src\\feature\\index.ts', ['.github']),
		false,
	);
});
