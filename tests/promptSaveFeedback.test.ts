import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildReservedArchiveRenameNotice,
	shouldApplyPromptAiEnrichmentState,
	shouldNotifyReservedArchiveRename,
} from '../src/utils/promptSaveFeedback.js';

test('shouldApplyPromptAiEnrichmentState matches current prompt or active save id only', () => {
	assert.equal(shouldApplyPromptAiEnrichmentState('prompt-1', '', 'prompt-1', '', null), true);
	assert.equal(shouldApplyPromptAiEnrichmentState('prompt-1', '', 'other-prompt', '', 'prompt-1'), true);
	assert.equal(shouldApplyPromptAiEnrichmentState('prompt-1', '', 'other-prompt', '', 'another-save'), false);
	assert.equal(shouldApplyPromptAiEnrichmentState('', '', 'prompt-1', '', 'prompt-1'), false);
	assert.equal(shouldApplyPromptAiEnrichmentState('old-prompt-id', 'uuid-1', 'other-prompt', 'uuid-1', null), true);
});

test('shouldNotifyReservedArchiveRename only reports exact archive base renames', () => {
	assert.equal(shouldNotifyReservedArchiveRename('archive', 'archive-1', ''), true);
	assert.equal(shouldNotifyReservedArchiveRename('archive', 'archive-1', 'archive-1'), false);
	assert.equal(shouldNotifyReservedArchiveRename('archive-task', 'archive-task', ''), false);
	assert.equal(shouldNotifyReservedArchiveRename('', 'archive-1', ''), false);
});

test('buildReservedArchiveRenameNotice returns localized messages', () => {
	assert.equal(
		buildReservedArchiveRenameNotice('archive-1', 'ru'),
		'Имя папки "archive" зарезервировано для архивации в Трекере. Промпт сохранён как "archive-1".',
	);
	assert.equal(
		buildReservedArchiveRenameNotice('archive-1', 'en'),
		'The folder name "archive" is reserved for Tracker archiving. The prompt was saved as "archive-1".',
	);
});