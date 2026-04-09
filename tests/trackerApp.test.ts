import test from 'node:test';
import assert from 'node:assert/strict';

import type { PromptConfig, PromptStatus } from '../src/types/prompt.js';

function makePromptConfig(id: string, status: PromptStatus): PromptConfig {
	return {
		id,
		promptUuid: `${id}-uuid`,
		title: id,
		description: '',
		status,
		favorite: false,
		archived: false,
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
		createdAt: '2026-04-06T00:00:00.000Z',
		updatedAt: '2026-04-06T00:00:00.000Z',
	};
}

async function importTrackerHelpers() {
	const previousAcquire = (globalThis as Record<string, unknown>).acquireVsCodeApi;
	(globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
		postMessage: (_msg: unknown) => { },
		getState: () => ({}),
		setState: (_state: unknown) => { },
	});

	try {
		return await import('../src/webview/tracker/TrackerApp.js');
	} finally {
		if (previousAcquire === undefined) {
			Reflect.deleteProperty(globalThis as Record<string, unknown>, 'acquireVsCodeApi');
		} else {
			(globalThis as Record<string, unknown>).acquireVsCodeApi = previousAcquire;
		}
	}
}

test('getTrackerMoveAllState disables action only when no cards are selected', async () => {
	const { getTrackerMoveAllState } = await importTrackerHelpers();

	assert.deepEqual(getTrackerMoveAllState('draft', 2), {
		nextStatus: 'in-progress',
		disabled: false,
	});

	assert.deepEqual(getTrackerMoveAllState('draft', 0), {
		nextStatus: 'in-progress',
		disabled: true,
	});

	assert.deepEqual(getTrackerMoveAllState('closed', 3), {
		nextStatus: 'draft',
		disabled: false,
	});
});

test('applyPromptStatusToPrompts updates only targeted prompt cards', async () => {
	const { applyPromptStatusToPrompts } = await importTrackerHelpers();
	const prompts = [
		makePromptConfig('draft-a', 'draft'),
		makePromptConfig('draft-b', 'draft'),
		makePromptConfig('review-a', 'review'),
	];

	const updated = applyPromptStatusToPrompts(prompts, ['draft-a', 'draft-b'], 'in-progress');

	assert.deepEqual(updated.map(prompt => ({ id: prompt.id, status: prompt.status })), [
		{ id: 'draft-a', status: 'in-progress' },
		{ id: 'draft-b', status: 'in-progress' },
		{ id: 'review-a', status: 'review' },
	]);
	assert.equal(updated[2], prompts[2]);
});

test('tracker selection helpers toggle cards and work per column', async () => {
	const {
		getSelectedPromptIdsForStatus,
		setTrackerPromptSelectionForStatus,
		toggleTrackerPromptSelection,
	} = await importTrackerHelpers();
	const prompts = [
		makePromptConfig('draft-a', 'draft'),
		makePromptConfig('draft-b', 'draft'),
		makePromptConfig('review-a', 'review'),
	];

	const toggled = toggleTrackerPromptSelection(['draft-a'], 'draft-b').sort();
	assert.deepEqual(toggled, ['draft-a', 'draft-b']);

	const selectedAllDraft = setTrackerPromptSelectionForStatus(['review-a'], prompts, 'draft', true).sort();
	assert.deepEqual(selectedAllDraft, ['draft-a', 'draft-b', 'review-a']);

	const selectedDraftIds = getSelectedPromptIdsForStatus(prompts, selectedAllDraft, 'draft');
	assert.deepEqual(selectedDraftIds, ['draft-a', 'draft-b']);

	const deselectedDraft = setTrackerPromptSelectionForStatus(selectedAllDraft, prompts, 'draft', false);
	assert.deepEqual(deselectedDraft, ['review-a']);
});

test('filterExistingTrackerSelections removes ids that are no longer present', async () => {
	const { filterExistingTrackerSelections } = await importTrackerHelpers();
	const prompts = [
		makePromptConfig('draft-a', 'draft'),
		makePromptConfig('review-a', 'review'),
	];

	assert.deepEqual(
		filterExistingTrackerSelections(['draft-a', 'ghost', 'review-a'], prompts),
		['draft-a', 'review-a'],
	);
});

test('shouldRefreshTrackerSelectedPrompt returns true when refreshed list has newer config metadata', async () => {
	const { shouldRefreshTrackerSelectedPrompt } = await importTrackerHelpers();
	const selectedPrompt = {
		...makePromptConfig('draft-a', 'draft'),
		content: 'Prompt body',
		report: 'Report body',
	};
	const refreshedConfig = {
		...makePromptConfig('draft-a', 'review'),
		title: 'Updated title',
		updatedAt: '2026-04-06T10:00:00.000Z',
	};

	assert.equal(shouldRefreshTrackerSelectedPrompt(selectedPrompt, refreshedConfig), true);
	assert.equal(shouldRefreshTrackerSelectedPrompt(selectedPrompt, makePromptConfig('draft-a', 'draft')), false);
	assert.equal(shouldRefreshTrackerSelectedPrompt(selectedPrompt, makePromptConfig('other', 'draft')), false);
});