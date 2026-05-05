import test from 'node:test';
import assert from 'node:assert/strict';

import {
	excludeProjectNames,
	resolveEffectiveProjectNames,
} from '../src/utils/projectScope.js';

test('excludeProjectNames removes excluded workspace projects and keeps the remaining order', () => {
	assert.deepEqual(
		excludeProjectNames(['repo-a', 'repo-b', 'repo-c'], ['repo-b', 'repo-x', 'repo-b']),
		['repo-a', 'repo-c'],
	);
});

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

test('resolveEffectiveProjectNames filters excluded workspace projects out of the visible workspace scope', () => {
	assert.deepEqual(
		resolveEffectiveProjectNames([], ['repo-a', 'repo-b', 'repo-c'], {
			excludedProjectNames: ['repo-b'],
		}),
		['repo-a', 'repo-c'],
	);
});

test('resolveEffectiveProjectNames can keep excluded selected projects from widening back to the workspace', () => {
	assert.deepEqual(
		resolveEffectiveProjectNames(['repo-b'], ['repo-a', 'repo-b', 'repo-c'], {
			excludedProjectNames: ['repo-b'],
			fallbackToWorkspaceWhenSelectionInvalid: false,
		}),
		[],
	);
});