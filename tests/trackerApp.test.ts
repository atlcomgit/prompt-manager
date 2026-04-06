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

test('getTrackerMoveAllState disables action for empty and final columns', async () => {
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
		nextStatus: null,
		disabled: true,
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