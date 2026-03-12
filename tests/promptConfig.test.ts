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
});

test('normalizeStoredPromptConfig preserves existing promptUuid', () => {
	const result = normalizeStoredPromptConfig(
		'existing-prompt',
		{
			promptUuid: 'existing-uuid',
			title: 'Existing prompt',
		},
		() => 'generated-uuid',
	);

	assert.equal(result.shouldBackfillPromptUuid, false);
	assert.equal(result.config.promptUuid, 'existing-uuid');
	assert.equal(result.config.title, 'Existing prompt');
	assert.equal(result.config.id, 'existing-prompt');
});
