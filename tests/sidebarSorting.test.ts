import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
	createDefaultPrompt, createDefaultSidebarState, normalizeSidebarState,
	type PromptConfig, type SortField, type SortOrder,
} from '../src/types/prompt.js';
import { compareSidebarPrompts } from '../src/utils/sidebarSorting.js';
import { FilterBar } from '../src/webview/sidebar/components/FilterBar.js';
import { withLocale } from './testLocale.js';

/** Создаёт промпт с фиксированными датами без обращения к хранилищу и рабочим ресурсам. */
function makePrompt(id: string, taskNumber: string, overrides: Partial<PromptConfig> = {}): PromptConfig {
	return {
		...createDefaultPrompt(id),
		title: id,
		taskNumber,
		createdAt: '2026-11-15T00:00:00.000Z',
		updatedAt: '2026-11-15T00:00:00.000Z',
		...overrides,
	};
}

/** Возвращает порядок id, не меняя исходный массив и метаданные. */
function sortedIds(prompts: PromptConfig[], order: SortOrder = 'asc', field: SortField = 'taskNumber'): string[] {
	return [...prompts].sort((left, right) => compareSidebarPrompts(left, right, field, order))
		.map(prompt => prompt.id);
}

/** Проверяет естественный порядок цифровых и составных номеров в обоих направлениях. */
test('compareSidebarPrompts orders numeric and compound task numbers naturally', () => {
	const prompts = [
		makePrompt('task-170', '170'),
		makePrompt('abc-12', 'ABC-12'),
		makePrompt('task-10', '10'),
		makePrompt('abc-2', 'ABC-2'),
		makePrompt('task-2', '2'),
		makePrompt('abc-2-10', 'ABC-2-10'),
		makePrompt('abc-2-2', 'ABC-2-2'),
	];
	const expected = ['task-2', 'task-10', 'task-170', 'abc-2', 'abc-2-2', 'abc-2-10', 'abc-12'];
	assert.deepEqual(sortedIds(prompts), expected);
	assert.deepEqual(sortedIds(prompts, 'desc'), [...expected].reverse());
});

/** Проверяет номера больше Number.MAX_SAFE_INTEGER и длиннее числового сегмента Intl.Collator. */
test('compareSidebarPrompts preserves arbitrary precision for very long task numbers', () => {
	const longPrefix = '9'.repeat(300);
	const prompts = [
		makePrompt('larger', `${longPrefix}2`),
		makePrompt('safe-plus-two', '9007199254740993'),
		makePrompt('smaller', `${longPrefix}1`),
		makePrompt('safe-plus-one', '9007199254740992'),
		makePrompt('longest', `1${'0'.repeat(302)}`),
	];
	assert.deepEqual(sortedIds(prompts), ['safe-plus-one', 'safe-plus-two', 'smaller', 'larger', 'longest']);
});

/** Пустые и пробельные номера остаются в конце независимо от направления. */
test('compareSidebarPrompts keeps blank task numbers last for ascending and descending order', () => {
	const prompts = [
		makePrompt('empty', ''),
		makePrompt('ten', '10'),
		makePrompt('blank', ' \t '),
		makePrompt('two', '2'),
	];
	assert.deepEqual(sortedIds(prompts), ['two', 'ten', 'blank', 'empty']);
	assert.deepEqual(sortedIds(prompts, 'desc'), ['ten', 'two', 'empty', 'blank']);
});

/** Численно равные номера упорядочиваются по названию и id, а пробелы и ведущие нули не переписываются. */
test('compareSidebarPrompts breaks task number ties by title and id without changing stored values', () => {
	const prompts = [
		makePrompt('z-id', ' 002 ', { title: 'Alpha' }),
		makePrompt('b-id', '2', { title: 'Beta' }),
		makePrompt('a-id', '0002', { title: 'Alpha' }),
	];
	const snapshot = structuredClone(prompts);
	assert.deepEqual(sortedIds(prompts), ['a-id', 'z-id', 'b-id']);
	assert.deepEqual(sortedIds([...prompts].reverse()), ['a-id', 'z-id', 'b-id']);
	assert.deepEqual(sortedIds(prompts, 'desc'), ['b-id', 'z-id', 'a-id']);
	assert.deepEqual(prompts, snapshot);
});

/** Нулевой номер не считается отсутствующим; начальные нули меняют только написание. */
test('compareSidebarPrompts treats zero as a populated task number', () => {
	const prompts = [makePrompt('empty', ''), makePrompt('zero', '0'), makePrompt('two-zeros', '00')];
	assert.deepEqual(sortedIds(prompts), ['two-zeros', 'zero', 'empty']);
	assert.deepEqual(sortedIds(prompts, 'desc'), ['zero', 'two-zeros', 'empty']);
});

/** Архивные результаты участвуют в том же сравнении без изменения признака архива. */
test('compareSidebarPrompts applies the same task number order to archived search results', () => {
	const prompts = [makePrompt('active', '10'), makePrompt('archive', '2', { archived: true })];
	assert.deepEqual(sortedIds(prompts), ['archive', 'active']);
	assert.equal(prompts[1].archived, true);
});

/** Номер первичен; дата разрешает равенство раньше названия, включая численно равные записи с нулями. */
test('combined task number sort compares creation date before title in both directions', () => {
	const prompts = [
		makePrompt('ten', '10', { createdAt: '2026-01-01T00:00:00.000Z' }),
		makePrompt('alpha-new', '002', { createdAt: '2026-11-16T00:00:00.000Z' }),
		makePrompt('zeta-old', '2', { createdAt: '2026-11-14T00:00:00.000Z' }),
		makePrompt('abc-12', 'ABC-12'),
		makePrompt('abc-2', 'ABC-2'),
	];
	const snapshot = structuredClone(prompts);
	const expected = ['zeta-old', 'alpha-new', 'ten', 'abc-2', 'abc-12'];
	assert.deepEqual(sortedIds(prompts, 'asc', 'taskNumberCreatedAt'), expected);
	assert.deepEqual(sortedIds(prompts, 'desc', 'taskNumberCreatedAt'), [...expected].reverse());
	assert.deepEqual(sortedIds(prompts, 'asc', 'taskNumber').slice(0, 2), ['alpha-new', 'zeta-old']);
	assert.deepEqual(prompts, snapshot);
});

/** Пустые номера остаются последними и упорядочиваются по дате, затем по названию и стабильному id. */
test('combined task number sort orders blank and equal dates deterministically', () => {
	const prompts = [
		makePrompt('blank-new', ' ', { createdAt: '2026-11-16T00:00:00.000Z' }),
		makePrompt('z-id', '2', { title: 'same' }),
		makePrompt('blank-old', '', { createdAt: '2026-11-14T00:00:00.000Z', archived: true }),
		makePrompt('a-id', '02', { title: 'same' }),
	];
	assert.deepEqual(sortedIds(prompts, 'asc', 'taskNumberCreatedAt'), ['a-id', 'z-id', 'blank-old', 'blank-new']);
	assert.deepEqual(sortedIds(prompts, 'desc', 'taskNumberCreatedAt'), ['z-id', 'a-id', 'blank-new', 'blank-old']);
	assert.deepEqual(sortedIds([...prompts].reverse(), 'asc', 'taskNumberCreatedAt'),
		['a-id', 'z-id', 'blank-old', 'blank-new']);
});

/** Начальный и неполный state получают новый режим; явные старые и новые настройки переживают восстановление. */
test('sidebar defaults to combined task number sorting and preserves saved choices', () => {
	for (const state of [createDefaultSidebarState(), normalizeSidebarState(), normalizeSidebarState({})]) {
		assert.equal(state.sortField, 'taskNumberCreatedAt');
		assert.equal(state.sortOrder, 'asc');
	}
	for (const sortField of ['title', 'taskNumber', 'taskNumberCreatedAt'] as const) {
		const restored = normalizeSidebarState({ sortField, sortOrder: 'desc' });
		assert.equal(restored.sortField, sortField);
		assert.equal(restored.sortOrder, 'desc');
	}
});

/** Прежние поля сохраняют лексикографическое сравнение, запасное название и направление. */
test('compareSidebarPrompts preserves all previous sort fields and stable ties', () => {
	const prompts = [
		makePrompt('alpha', '170', { title: '', status: 'draft', updatedAt: '2026-11-16T00:00:00.000Z' }),
		makePrompt('beta', '2', { status: 'completed', createdAt: '2026-11-14T00:00:00.000Z' }),
	];
	assert.deepEqual(sortedIds(prompts, 'asc', 'title'), ['alpha', 'beta']);
	assert.deepEqual(sortedIds(prompts, 'desc', 'title'), ['beta', 'alpha']);
	assert.deepEqual(sortedIds(prompts, 'asc', 'createdAt'), ['beta', 'alpha']);
	assert.deepEqual(sortedIds(prompts, 'desc', 'createdAt'), ['alpha', 'beta']);
	assert.deepEqual(sortedIds(prompts, 'asc', 'updatedAt'), ['beta', 'alpha']);
	assert.deepEqual(sortedIds(prompts, 'desc', 'updatedAt'), ['alpha', 'beta']);
	assert.deepEqual(sortedIds(prompts, 'asc', 'status'), ['beta', 'alpha']);
	assert.deepEqual(sortedIds(prompts, 'desc', 'status'), ['alpha', 'beta']);
	assert.equal(compareSidebarPrompts(prompts[0], { ...prompts[1], title: 'alpha' }, 'title', 'asc'), 0);
});

/** Пункт нового способа сортировки доступен и отмечен выбранным в обеих локализациях. */
test('FilterBar offers both selected task number sorts in Russian and English', () => {
	for (const [locale, sortField, label] of [
		['ru', 'taskNumber', 'Номер задачи'], ['en', 'taskNumber', 'Task number'],
		['ru', 'taskNumberCreatedAt', 'Номер задачи + Дата создания'],
		['en', 'taskNumberCreatedAt', 'Task number + Creation date'],
	] as const) {
		const markup = withLocale(locale, () => renderToStaticMarkup(React.createElement(FilterBar, {
			mode: 'view-settings',
			sortField,
			onSortFieldChange: () => {},
			sortOrder: 'asc',
			onSortOrderChange: () => {},
			viewMode: 'compact',
			onViewModeChange: () => {},
			groupBy: 'status',
			onGroupByChange: () => {},
		})));
		assert.ok(markup.includes(`<option value="${sortField}" selected="">${label}</option>`));
	}
});
