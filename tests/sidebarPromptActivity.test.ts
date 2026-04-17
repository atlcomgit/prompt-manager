import test from 'node:test';
import assert from 'node:assert/strict';

import type { PromptConfig } from '../src/types/prompt.js';
import {
	isSidebarPromptActivityActive,
	resolveSidebarPromptActivityKeys,
	updateSidebarPromptActivityKeys,
} from '../src/utils/sidebarPromptActivity.js';

function makePrompt(overrides: Partial<PromptConfig> = {}): PromptConfig {
	const now = '2026-04-17T12:00:00.000Z';
	return {
		id: 'prompt-1',
		promptUuid: 'uuid-1',
		title: 'Prompt',
		description: 'Description',
		status: 'draft',
		favorite: false,
		projects: [],
		languages: [],
		frameworks: [],
		skills: [],
		mcpTools: [],
		hooks: [],
		taskNumber: '',
		branch: '',
		trackedBranch: '',
		trackedBranchesByProject: {},
		model: '',
		chatMode: 'agent',
		contextFiles: [],
		httpExamples: '',
		chatSessionIds: [],
		timeSpentWriting: 0,
		timeSpentImplementing: 0,
		timeSpentOnTask: 0,
		timeSpentUntracked: 0,
		notes: '',
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

test('resolveSidebarPromptActivityKeys prefers stable promptUuid and keeps id fallback', () => {
	assert.deepEqual(resolveSidebarPromptActivityKeys({ id: 'prompt-1', promptUuid: 'uuid-1' }), [
		'uuid:uuid-1',
		'id:prompt-1',
	]);
});

test('updateSidebarPromptActivityKeys adds and removes prompt activity keys as a stable set', () => {
	const added = updateSidebarPromptActivityKeys([], { id: 'prompt-1', promptUuid: 'uuid-1' }, true);
	assert.deepEqual(added, ['uuid:uuid-1', 'id:prompt-1']);

	const removed = updateSidebarPromptActivityKeys(added, { id: 'prompt-1', promptUuid: 'uuid-1' }, false);
	assert.deepEqual(removed, []);
});

test('isSidebarPromptActivityActive keeps busy state after prompt rename through promptUuid', () => {
	const activityKeys = updateSidebarPromptActivityKeys([], {
		id: 'old-slug',
		promptUuid: 'stable-uuid',
	}, true);

	assert.equal(isSidebarPromptActivityActive(makePrompt({
		id: 'new-slug',
		promptUuid: 'stable-uuid',
	}), activityKeys), true);
	assert.equal(isSidebarPromptActivityActive(makePrompt({
		id: 'other-prompt',
		promptUuid: 'other-uuid',
	}), activityKeys), false);
});
