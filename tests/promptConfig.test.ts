import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeChatTarget, normalizeStoredPromptConfig } from '../src/utils/promptConfig.js';

/** Проверяет общий нормализатор целей и прежний fallback для отсутствующих или поврежденных значений. */
test('normalizeChatTarget accepts supported targets and rejects invalid values', () => {
	for (const target of ['copilot', 'kilo', 'codex', 'claude'] as const) {
		assert.equal(normalizeChatTarget(target), target);
	}
	for (const target of [undefined, null, '', 'unknown', 'Claude', 'claude ', 1, {}, ['claude']]) {
		assert.equal(normalizeChatTarget(target), 'copilot');
	}
});

/** Проверяет восстановление обязательных полей старой конфигурации промпта. */
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
	assert.equal(result.config.autoStartChat, true);
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

/** Проверяет сохранение всех поддерживаемых целей, включая Claude Code. */
test('normalizeStoredPromptConfig preserves supported chat targets', () => {
	for (const chatTarget of ['copilot', 'kilo', 'codex', 'claude'] as const) {
		const result = normalizeStoredPromptConfig(
			`prompt-${chatTarget}`,
			{ chatTarget },
			() => 'generated-uuid',
		);

		assert.equal(result.config.chatTarget, chatTarget);
	}
});

/** Проверяет, что выбор Claude не меняет режим, сохраненную модель и независимые флаги отправки. */
test('normalizeStoredPromptConfig preserves Claude settings and keeps Xdotool opt-in', () => {
	for (const chatMode of ['agent', 'plan'] as const) {
		const result = normalizeStoredPromptConfig(
			'prompt-claude',
			{ chatTarget: 'claude', chatMode, model: 'copilot/gpt-5.4', autoStartChat: false },
			() => 'generated-uuid',
		);

		assert.equal(result.config.chatTarget, 'claude');
		assert.equal(result.config.chatMode, chatMode);
		assert.equal(result.config.model, 'copilot/gpt-5.4');
		assert.equal(result.config.autoStartChat, false);
		assert.equal(result.config.autoStartChatWithXdotool, false);
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

/** Проверяет значение автостарта по умолчанию и сохранение явного отключения. */
test('normalizeStoredPromptConfig keeps Copilot auto-start enabled by default and accepts explicit disable', () => {
	const defaultResult = normalizeStoredPromptConfig(
		'prompt-copilot-default',
		{},
		() => 'generated-uuid',
	);
	const disabledResult = normalizeStoredPromptConfig(
		'prompt-copilot-disabled',
		{ autoStartChat: false },
		() => 'generated-uuid',
	);

	assert.equal(defaultResult.config.autoStartChat, true);
	assert.equal(disabledResult.config.autoStartChat, false);
});
