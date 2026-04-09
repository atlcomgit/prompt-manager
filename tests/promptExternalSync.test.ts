import test from 'node:test';
import assert from 'node:assert/strict';

import type { Prompt } from '../src/types/prompt.js';
import {
	applyPromptConfigSnapshotToPrompt,
	mergePromptExternalConfig,
	normalizePromptExternalChangedAt,
} from '../src/utils/promptExternalSync.js';

function makePrompt(overrides: Partial<Prompt> = {}): Prompt {
	return {
		id: 'prompt-1',
		promptUuid: 'prompt-1-uuid',
		title: 'Prompt 1',
		description: 'Description',
		status: 'draft',
		favorite: false,
		archived: false,
		projects: ['api'],
		languages: ['TypeScript'],
		frameworks: ['VS Code'],
		skills: [],
		mcpTools: [],
		hooks: [],
		taskNumber: '1',
		branch: 'feature/prompt-1',
		trackedBranch: 'main',
		trackedBranchesByProject: { api: 'main' },
		model: 'copilot/gpt-5.4',
		chatMode: 'agent',
		contextFiles: ['README.md'],
		httpExamples: '',
		chatSessionIds: ['chat-1'],
		timeSpentWriting: 1200,
		timeSpentImplementing: 800,
		timeSpentOnTask: 500,
		timeSpentUntracked: 0,
		notes: '',
		createdAt: '2026-04-09T09:00:00.000Z',
		updatedAt: '2026-04-09T09:00:00.000Z',
		content: 'Prompt body',
		report: 'Report body',
		...overrides,
	};
}

test('normalizePromptExternalChangedAt prefers config updatedAt and falls back to file mtime', () => {
	assert.equal(
		normalizePromptExternalChangedAt('2026-04-09T10:00:00.000Z', 123),
		Date.parse('2026-04-09T10:00:00.000Z'),
	);
	assert.equal(normalizePromptExternalChangedAt('', 456), 456);
	assert.equal(normalizePromptExternalChangedAt('invalid-date', 789), 789);
	assert.equal(normalizePromptExternalChangedAt('', null), null);
});

test('mergePromptExternalConfig preserves only locally newer fields and applies the rest from external config', () => {
	const currentPrompt = makePrompt({
		title: 'Local title',
		status: 'review',
		taskNumber: '61-local',
		updatedAt: '2026-04-09T10:05:00.000Z',
	});
	const externalPrompt = makePrompt({
		title: 'External title',
		status: 'completed',
		taskNumber: '61-external',
		notes: 'Updated by external agent',
		updatedAt: '2026-04-09T10:00:00.000Z',
	});

	const result = mergePromptExternalConfig(
		currentPrompt,
		externalPrompt,
		{
			status: Date.parse('2026-04-09T10:10:00.000Z'),
			title: Date.parse('2026-04-09T09:30:00.000Z'),
		},
		Date.parse('2026-04-09T10:00:00.000Z'),
	);

	assert.equal(result.mergedPrompt.status, 'review');
	assert.equal(result.mergedPrompt.title, 'External title');
	assert.equal(result.mergedPrompt.taskNumber, '61-external');
	assert.equal(result.mergedPrompt.notes, 'Updated by external agent');
	assert.equal(result.mergedPrompt.updatedAt, '2026-04-09T10:00:00.000Z');
	assert.deepEqual(result.preservedLocalFields, ['status']);
	assert.deepEqual(result.appliedExternalFields.sort(), ['notes', 'taskNumber', 'title']);
	assert.equal(result.hasChanges, true);
});

test('applyPromptConfigSnapshotToPrompt updates config fields and keeps content/report intact', () => {
	const currentPrompt = makePrompt({
		content: 'Local content',
		report: 'Local report',
		status: 'draft',
		updatedAt: '2026-04-09T09:00:00.000Z',
	});
	const configSnapshot = makePrompt({
		status: 'review',
		notes: 'Synced notes',
		title: 'Config title',
		updatedAt: '2026-04-09T11:00:00.000Z',
	});

	const updatedPrompt = applyPromptConfigSnapshotToPrompt(currentPrompt, configSnapshot);

	assert.equal(updatedPrompt.status, 'review');
	assert.equal(updatedPrompt.notes, 'Synced notes');
	assert.equal(updatedPrompt.title, 'Config title');
	assert.equal(updatedPrompt.updatedAt, '2026-04-09T11:00:00.000Z');
	assert.equal(updatedPrompt.content, 'Local content');
	assert.equal(updatedPrompt.report, 'Local report');
});