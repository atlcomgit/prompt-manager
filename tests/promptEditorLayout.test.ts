import test from 'node:test';
import assert from 'node:assert/strict';
import {
	normalizePromptEditorLayout,
	normalizePromptEditorMainExpanded,
	normalizePromptEditorPanelSplitRatio,
	normalizePromptEditorSectionOrder,
	PROMPT_EDITOR_TAB_SECTIONS,
} from '../src/types/promptEditorLayout.js';
import { createDefaultEditorPromptExpandedSections } from '../src/types/prompt.js';

/** Defaults располагают статусы сразу после основного блока и не создают раскрытия до миграции. */
test('normalizePromptEditorLayout places statuses after basic and keeps expansion absent until supplied', () => {
	const result = normalizePromptEditorLayout();
	assert.deepEqual(result.main, PROMPT_EDITOR_TAB_SECTIONS.main);
	assert.deepEqual(result.process, PROMPT_EDITOR_TAB_SECTIONS.process);
	assert.deepEqual(result.main.slice(0, 3), ['basic', 'status', 'time']);
	assert.equal(result.mainExpandedSections, undefined);
});

/** Каждый порядок содержит только разделы собственной вкладки, один раз и с дополнением новых ключей. */
test('normalizePromptEditorSectionOrder removes unknown, duplicate and foreign-tab sections', () => {
	const main = normalizePromptEditorSectionOrder(['time', 'basic', 'time', 'report', 'unknown', null], 'main');
	assert.deepEqual(main.slice(0, 3), ['time', 'basic', 'status']);
	assert.deepEqual([...main].sort(), [...PROMPT_EDITOR_TAB_SECTIONS.main].sort());
	const process = normalizePromptEditorSectionOrder(['report', 'report', 'basic', 'plan', 42], 'process');
	assert.deepEqual(process, ['report', 'plan', 'notes', 'memory']);
	assert.deepEqual(normalizePromptEditorSectionOrder({}, 'main'), PROMPT_EDITOR_TAB_SECTIONS.main);
});

/** Явное расположение статусов сохраняется, а старый порядок получает новый блок после basic. */
test('normalizePromptEditorSectionOrder preserves an explicit status position and migrates legacy order', () => {
	const main = ['status', 'time', 'basic'];
	assert.deepEqual(normalizePromptEditorSectionOrder(main, 'main').slice(0, 3), main);
	assert.deepEqual(normalizePromptEditorSectionOrder(['files', 'basic', 'time'], 'main').slice(0, 4),
		['files', 'basic', 'status', 'time']);
	assert.deepEqual(main, ['status', 'time', 'basic']);
});

/** Main сохраняет false, подставляет defaults и исключает раскрытия Process и неизвестные значения. */
test('normalizePromptEditorMainExpanded preserves explicit false and excludes Process flags', () => {
	const result = normalizePromptEditorMainExpanded({ basic: false, files: true, time: 'false',
		report: true, notes: true, plan: true, memory: false, unexpected: true });
	assert.deepEqual(Object.keys(result), PROMPT_EDITOR_TAB_SECTIONS.main);
	assert.equal(result.basic, false);
	assert.equal(result.files, true);
	assert.equal(result.time, createDefaultEditorPromptExpandedSections().time);
	assert.equal(Object.hasOwn(result, 'report'), false);
	assert.equal(Object.hasOwn(result, 'plan'), false);
});

/** Нормализация возвращает отдельные массивы и карты, не позволяя UI менять входной снимок. */
test('normalizePromptEditorLayout copies supplied section order and main expansion', () => {
	const input = normalizePromptEditorLayout({ main: ['files'], mainExpandedSections: { basic: false } });
	const result = normalizePromptEditorLayout(input);
	result.main.reverse();
	result.process.reverse();
	result.mainExpandedSections!.basic = true;
	assert.equal(input.main[0], 'files');
	assert.deepEqual(input.process, PROMPT_EDITOR_TAB_SECTIONS.process);
	assert.equal(input.mainExpandedSections?.basic, false);
});

/** Доля ширины сохраняет отличие отсутствия от сброса, округляется и отклоняет некорректные значения. */
test('normalizePromptEditorLayout keeps panel split ratio absence, reset and valid rounded values', () => {
	assert.equal(Object.hasOwn(normalizePromptEditorLayout({ main: ['files'] }), 'panelSplitRatio'), false);
	assert.equal(normalizePromptEditorLayout({ panelSplitRatio: null }).panelSplitRatio, null);
	assert.equal(normalizePromptEditorLayout({ panelSplitRatio: 0.123_456 }).panelSplitRatio, 0.1235);
	for (const valid of [0, 0.5, 1]) {
		assert.equal(normalizePromptEditorPanelSplitRatio(valid), valid);
	}
	for (const invalid of [NaN, Infinity, -Infinity, -0.01, 1.01, '0.5', true, {}, []]) {
		assert.equal(normalizePromptEditorPanelSplitRatio(invalid), null);
	}
});
