import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeStoredPromptConfig } from '../src/utils/promptConfig.js';

test('normalizeStoredPromptConfig backfills missing promptUuid for legacy prompt configs', () => {
	const result = normalizeStoredPromptConfig(
		'legacy-prompt',
		{
			title: 'Legacy prompt',
			description: 'Created before promptUuid existed',
		},
		() => 'generated-uuid',
	);

	assert.equal(result.shouldBackfillPromptUuid, true);
	assert.equal(result.config.id, 'legacy-prompt');
	assert.equal(result.config.promptUuid, 'generated-uuid');
	assert.equal(result.config.title, 'Legacy prompt');
	assert.equal(result.config.description, 'Created before promptUuid existed');
	assert.equal(result.config.trackedBranch, '');
	assert.deepEqual(result.config.trackedBranchesByProject, {});
	assert.equal(result.config.notes, '');
});

test('normalizeStoredPromptConfig preserves existing promptUuid', () => {
	const result = normalizeStoredPromptConfig(
		'existing-prompt',
		{
			promptUuid: 'existing-uuid',
			trackedBranch: 'master',
			trackedBranchesByProject: {
				api: 'master',
				web: 'main',
			},
			title: 'Existing prompt',
		},
		() => 'generated-uuid',
	);

	assert.equal(result.shouldBackfillPromptUuid, false);
	assert.equal(result.config.promptUuid, 'existing-uuid');
	assert.equal(result.config.trackedBranch, 'master');
	assert.deepEqual(result.config.trackedBranchesByProject, {
		api: 'master',
		web: 'main',
	});
	assert.equal(result.config.title, 'Existing prompt');
	assert.equal(result.config.id, 'existing-prompt');
});
