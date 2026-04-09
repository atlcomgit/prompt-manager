import test from 'node:test';
import assert from 'node:assert/strict';

import type { PromptConfig, PromptStatus } from '../src/types/prompt.js';

function makePromptConfig(id: string, status: PromptStatus, archived: boolean): PromptConfig {
	return {
		id,
		promptUuid: `${id}-uuid`,
		title: id,
		description: '',
		status,
		favorite: false,
		archived,
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
		createdAt: '2026-04-09T00:00:00.000Z',
		updatedAt: '2026-04-09T00:00:00.000Z',
	};
}

async function importSidebarHelpers() {
	const previousAcquire = (globalThis as Record<string, unknown>).acquireVsCodeApi;
	(globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
		postMessage: (_msg: unknown) => { },
		getState: () => ({}),
		setState: (_state: unknown) => { },
	});

	try {
		return await import('../src/webview/sidebar/SidebarApp.js');
	} finally {
		if (previousAcquire === undefined) {
			Reflect.deleteProperty(globalThis as Record<string, unknown>, 'acquireVsCodeApi');
		} else {
			(globalThis as Record<string, unknown>).acquireVsCodeApi = previousAcquire;
		}
	}
}

test('getSidebarPromptSearchPool keeps archived prompts hidden until search is active', async () => {
	const { getSidebarPromptSearchPool } = await importSidebarHelpers();
	const activePrompts = [makePromptConfig('active-a', 'draft', false)];
	const archivedPrompts = [makePromptConfig('archived-a', 'closed', true)];

	assert.deepEqual(
		getSidebarPromptSearchPool(activePrompts, archivedPrompts, '').map((prompt: PromptConfig) => prompt.id),
		['active-a'],
	);

	assert.deepEqual(
		getSidebarPromptSearchPool(activePrompts, archivedPrompts, 'archived').map((prompt: PromptConfig) => prompt.id),
		['active-a', 'archived-a'],
	);
});