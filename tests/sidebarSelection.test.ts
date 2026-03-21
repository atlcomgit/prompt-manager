import test from 'node:test';
import assert from 'node:assert/strict';

import type { PromptConfig } from '../src/types/prompt.js';
import { normalizeSidebarState } from '../src/types/prompt.js';
import { reconcileSidebarSelection } from '../src/utils/sidebarSelection.js';

function makePrompt(overrides: Partial<PromptConfig>): PromptConfig {
	const now = '2026-03-21T12:00:00.000Z';
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
		model: '',
		chatMode: 'agent',
		contextFiles: [],
		httpExamples: '',
		chatSessionIds: [],
		timeSpentWriting: 0,
		timeSpentImplementing: 0,
		timeSpentOnTask: 0,
		timeSpentUntracked: 0,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

test('normalizeSidebarState backfills selectedPromptUuid for legacy sidebar state', () => {
	const result = normalizeSidebarState({
		selectedPromptId: 'prompt-1',
		filters: {
			search: '',
			status: [],
			projects: [],
			languages: [],
			frameworks: [],
			favorites: false,
			createdAt: 'all',
		},
	});

	assert.equal(result.selectedPromptId, 'prompt-1');
	assert.equal(result.selectedPromptUuid, null);
	assert.equal(result.filters.createdAt, 'all');
});

test('reconcileSidebarSelection remaps selection to renamed prompt by promptUuid', () => {
	const prompts = [
		makePrompt({ id: '46-new-slug', promptUuid: 'stable-uuid' }),
	];

	const result = reconcileSidebarSelection(prompts, {
		selectedId: '46-old-slug',
		selectedPromptUuid: 'stable-uuid',
	});

	assert.deepEqual(result, {
		selectedId: '46-new-slug',
		selectedPromptUuid: 'stable-uuid',
	});
});

test('reconcileSidebarSelection backfills promptUuid from legacy selected id', () => {
	const prompts = [
		makePrompt({ id: 'prompt-1', promptUuid: 'stable-uuid' }),
	];

	const result = reconcileSidebarSelection(prompts, {
		selectedId: 'prompt-1',
		selectedPromptUuid: null,
	});

	assert.deepEqual(result, {
		selectedId: 'prompt-1',
		selectedPromptUuid: 'stable-uuid',
	});
});

test('reconcileSidebarSelection clears missing selection when prompt disappears', () => {
	const result = reconcileSidebarSelection([], {
		selectedId: 'prompt-1',
		selectedPromptUuid: 'stable-uuid',
	});

	assert.deepEqual(result, {
		selectedId: null,
		selectedPromptUuid: null,
	});
});

test('reconcileSidebarSelection preserves optimistic new prompt selection', () => {
	const prompts = [
		makePrompt({ id: 'prompt-1', promptUuid: 'stable-uuid' }),
	];

	const result = reconcileSidebarSelection(prompts, {
		selectedId: '__new__',
		selectedPromptUuid: null,
	});

	assert.deepEqual(result, {
		selectedId: '__new__',
		selectedPromptUuid: null,
	});
});