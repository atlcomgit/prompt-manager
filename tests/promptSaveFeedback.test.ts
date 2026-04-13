import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildReservedArchiveRenameNotice,
	shouldApplyPromptSaveResult,
	shouldApplyPromptAiEnrichmentState,
	shouldApplySavedPromptToPanel,
	shouldNotifyReservedArchiveRename,
} from '../src/utils/promptSaveFeedback.js';

test('shouldApplyPromptAiEnrichmentState matches current prompt or active save id only', () => {
	assert.equal(shouldApplyPromptAiEnrichmentState('prompt-1', '', 'prompt-1', '', null), true);
	assert.equal(shouldApplyPromptAiEnrichmentState('prompt-1', '', 'other-prompt', '', 'prompt-1'), true);
	assert.equal(shouldApplyPromptAiEnrichmentState('prompt-1', '', 'other-prompt', '', 'another-save'), false);
	assert.equal(shouldApplyPromptAiEnrichmentState('', '', 'prompt-1', '', 'prompt-1'), false);
	assert.equal(shouldApplyPromptAiEnrichmentState('old-prompt-id', 'uuid-1', 'other-prompt', 'uuid-1', null), true);
});

test('shouldApplyPromptSaveResult matches only the active or currently opened prompt save completion', () => {
	assert.equal(shouldApplyPromptSaveResult('prompt-1', '', '', 'prompt-1', '', null), true);
	assert.equal(shouldApplyPromptSaveResult('prompt-2', 'uuid-2', '', 'other-prompt', 'uuid-2', null), true);
	assert.equal(shouldApplyPromptSaveResult('prompt-2', '', 'prompt-1', 'prompt-1', '', null), true);
	assert.equal(shouldApplyPromptSaveResult('prompt-2', '', '', 'other-prompt', '', 'prompt-2'), true);
	assert.equal(shouldApplyPromptSaveResult('prompt-2', '', '', 'other-prompt', '', 'another-save'), false);
});

test('shouldApplySavedPromptToPanel keeps stale save results away from a switched panel', () => {
	assert.equal(shouldApplySavedPromptToPanel('prompt-1', '', 'prompt-1', '', ''), true);
	/** UUID совпадает И id совпадает (через previousPromptId) — принимаем */
	assert.equal(shouldApplySavedPromptToPanel('prompt-2', 'uuid-2', 'prompt-1', 'uuid-2', 'prompt-1'), true);
	/** UUID совпадает, но id не совпадает (нет previousPromptId) — отклоняем для существующего промпта */
	assert.equal(shouldApplySavedPromptToPanel('prompt-2', 'uuid-2', 'other-prompt', 'uuid-2', ''), false);
	assert.equal(shouldApplySavedPromptToPanel('prompt-2', '', '__new__', '', ''), false);
	assert.equal(shouldApplySavedPromptToPanel('prompt-2', '', 'prompt-1', '', 'prompt-1'), true);
	assert.equal(shouldApplySavedPromptToPanel('prompt-2', '', 'prompt-3', '', 'prompt-1'), false);
});

test('shouldApplySavedPromptToPanel rejects stale save when switching between new prompts with different UUIDs', () => {
	/** Два новых промпта с разными UUID — сохранение #1 не должно затереть #2 */
	assert.equal(shouldApplySavedPromptToPanel('saved-id', 'uuid-a', '', 'uuid-b', ''), false);
	/** Два новых промпта без UUID — отклоняем для безопасности */
	assert.equal(shouldApplySavedPromptToPanel('saved-id', '', '', '', ''), false);
	/** Новый промпт, оба UUID пусты — отклоняем */
	assert.equal(shouldApplySavedPromptToPanel('', '', '', '', ''), false);
});

test('shouldApplySavedPromptToPanel accepts own save for new prompt matched by UUID', () => {
	/** UUID совпадает — это тот же промпт, принимаем */
	assert.equal(shouldApplySavedPromptToPanel('saved-id', 'uuid-a', '', 'uuid-a', ''), true);
	/** UUID совпадает, оба без id — принимаем */
	assert.equal(shouldApplySavedPromptToPanel('', 'uuid-a', '', 'uuid-a', ''), true);
});

test('shouldApplySavedPromptToPanel rejects save from existing prompt applied to new prompt panel', () => {
	/** Сохранение существующего промпта не должно затереть новый с другим UUID */
	assert.equal(shouldApplySavedPromptToPanel('prompt-a', 'uuid-a', '', 'uuid-b', ''), false);
	/** Даже с previousPromptId — если live пустой и UUID не совпадают, отклоняем */
	assert.equal(shouldApplySavedPromptToPanel('prompt-a', 'uuid-a', '', 'uuid-b', 'prompt-a'), false);
});

test('shouldApplySavedPromptToPanel requires both uuid AND id match for existing prompts', () => {
	/** UUID совпадает, id совпадает — принимаем */
	assert.equal(shouldApplySavedPromptToPanel('task-1', 'uuid-x', 'task-1', 'uuid-x', ''), true);
	/** UUID совпадает, id не совпадает, нет previousPromptId — отклоняем */
	assert.equal(shouldApplySavedPromptToPanel('task-1', 'uuid-x', 'task-2', 'uuid-x', ''), false);
	/** UUID совпадает, id не совпадает, но previousPromptId совпадает — принимаем (переименование) */
	assert.equal(shouldApplySavedPromptToPanel('task-1-new', 'uuid-x', 'task-1', 'uuid-x', 'task-1'), true);
	/** UUID не совпадает, id совпадает — отклоняем */
	assert.equal(shouldApplySavedPromptToPanel('task-1', 'uuid-a', 'task-1', 'uuid-b', ''), false);
	/** Без UUID (легаси) — маппинг только по id */
	assert.equal(shouldApplySavedPromptToPanel('task-1', '', 'task-1', '', ''), true);
	assert.equal(shouldApplySavedPromptToPanel('task-1', '', 'task-2', '', ''), false);
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