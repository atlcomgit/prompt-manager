import test from 'node:test';
import assert from 'node:assert/strict';

import type { PromptConfig } from '../src/types/prompt.js';
import { normalizeSidebarState } from '../src/types/prompt.js';
import {
	reconcileSidebarDeletionState,
	reconcileSidebarPromptSavingSelection,
	reconcileSidebarSelection,
} from '../src/utils/sidebarSelection.js';

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
		trackedBranch: '',
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
	assert.equal(result.viewMode, 'detailed');
	assert.equal(result.filters.createdAt, 'all');
});

test('normalizeSidebarState preserves explicit compact view mode', () => {
	const result = normalizeSidebarState({
		viewMode: 'compact',
	});

	assert.equal(result.viewMode, 'compact');
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

test('reconcileSidebarSelection preserves optimistic new prompt until matching promptUuid appears', () => {
	const prompts = [
		makePrompt({ id: 'prompt-1', promptUuid: 'other-uuid' }),
	];

	const result = reconcileSidebarSelection(prompts, {
		selectedId: '__new__',
		selectedPromptUuid: 'stable-uuid',
	});

	assert.deepEqual(result, {
		selectedId: '__new__',
		selectedPromptUuid: 'stable-uuid',
	});
});

test('reconcileSidebarSelection remaps optimistic new prompt to saved prompt by promptUuid', () => {
	const prompts = [
		makePrompt({ id: 'saved-prompt', promptUuid: 'stable-uuid' }),
	];

	const result = reconcileSidebarSelection(prompts, {
		selectedId: '__new__',
		selectedPromptUuid: 'stable-uuid',
	});

	assert.deepEqual(result, {
		selectedId: 'saved-prompt',
		selectedPromptUuid: 'stable-uuid',
	});
});

test('reconcileSidebarPromptSavingSelection captures promptUuid for optimistic new prompt', () => {
	const result = reconcileSidebarPromptSavingSelection({
		selectedId: '__new__',
		selectedPromptUuid: null,
	}, {
		id: '__new__',
		promptUuid: 'stable-uuid',
	});

	assert.deepEqual(result, {
		selectedId: '__new__',
		selectedPromptUuid: 'stable-uuid',
	});
});

test('reconcileSidebarPromptSavingSelection ignores unrelated saving prompt updates', () => {
	const result = reconcileSidebarPromptSavingSelection({
		selectedId: '__new__',
		selectedPromptUuid: null,
	}, {
		id: 'prompt-1',
		promptUuid: 'uuid-1',
	});

	assert.deepEqual(result, {
		selectedId: '__new__',
		selectedPromptUuid: null,
	});
});

test('reconcileSidebarDeletionState clears optimistic new prompt and selection', () => {
	const result = reconcileSidebarDeletionState({
		showOptimisticNewPrompt: true,
		selectedId: '__new__',
		selectedPromptUuid: null,
	}, '__new__');

	assert.deepEqual(result, {
		showOptimisticNewPrompt: false,
		selectedId: null,
		selectedPromptUuid: null,
	});
});

test('reconcileSidebarDeletionState clears selected saved prompt only', () => {
	const result = reconcileSidebarDeletionState({
		showOptimisticNewPrompt: true,
		selectedId: 'prompt-1',
		selectedPromptUuid: 'uuid-1',
	}, 'prompt-1');

	assert.deepEqual(result, {
		showOptimisticNewPrompt: true,
		selectedId: null,
		selectedPromptUuid: null,
	});
});

test('reconcileSidebarDeletionState ignores unrelated prompt deletion', () => {
	const result = reconcileSidebarDeletionState({
		showOptimisticNewPrompt: true,
		selectedId: 'prompt-1',
		selectedPromptUuid: 'uuid-1',
	}, 'prompt-2');

	assert.deepEqual(result, {
		showOptimisticNewPrompt: true,
		selectedId: 'prompt-1',
		selectedPromptUuid: 'uuid-1',
	});
});