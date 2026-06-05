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
	assert.equal(result.config.chatTarget, 'copilot');
	assert.equal(result.config.autoStartChatWithXdotool, false);
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

test('normalizeStoredPromptConfig preserves supported chat targets', () => {
	for (const chatTarget of ['copilot', 'kilo', 'codex'] as const) {
		const result = normalizeStoredPromptConfig(
			`prompt-${chatTarget}`,
			{ chatTarget },
			() => 'generated-uuid',
		);

		assert.equal(result.config.chatTarget, chatTarget);
	}
});

test('normalizeStoredPromptConfig falls back to copilot for invalid chat target', () => {
	const result = normalizeStoredPromptConfig(
		'prompt-invalid-target',
		{ chatTarget: 'unknown' as any },
		() => 'generated-uuid',
	);

	assert.equal(result.config.chatTarget, 'copilot');
});

test('normalizeStoredPromptConfig normalizes xdotool auto-start flag', () => {
	const enabledResult = normalizeStoredPromptConfig(
		'prompt-xdotool-enabled',
		{ autoStartChatWithXdotool: true },
		() => 'generated-uuid',
	);
	const disabledResult = normalizeStoredPromptConfig(
		'prompt-xdotool-disabled',
		{ autoStartChatWithXdotool: 'true' as any },
		() => 'generated-uuid',
	);

	assert.equal(enabledResult.config.autoStartChatWithXdotool, true);
	assert.equal(disabledResult.config.autoStartChatWithXdotool, false);
});
