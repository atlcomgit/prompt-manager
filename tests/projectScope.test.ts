import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveEffectiveProjectNames } from '../src/utils/projectScope.js';

test('resolveEffectiveProjectNames keeps valid selected projects in the requested order', () => {
	assert.deepEqual(
		resolveEffectiveProjectNames(
			[' repo-b ', 'repo-a', 'repo-b'],
			['repo-a', 'repo-b', 'repo-c'],
		),
		['repo-b', 'repo-a'],
	);
});

test('resolveEffectiveProjectNames falls back to the workspace for empty or invalid selection', () => {
	assert.deepEqual(resolveEffectiveProjectNames([], ['repo-a', 'repo-b']), ['repo-a', 'repo-b']);
	assert.deepEqual(resolveEffectiveProjectNames(['missing'], ['repo-a', 'repo-b']), ['repo-a', 'repo-b']);
});