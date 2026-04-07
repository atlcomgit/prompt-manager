import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildPlanChecklistSummary,
	getPlanChecklistStats,
	parsePlanChecklist,
} from '../src/utils/planChecklist.js';

test('parsePlanChecklist extracts checklist items from markdown plan', () => {
	const items = parsePlanChecklist(`
# План реализации

- [x] Обновить API.
- [ ] Добавить тесты.

Текст без чеклиста.
`);

	assert.deepEqual(items, [
		{ text: 'Обновить API.', checked: true, lineNumber: 4 },
		{ text: 'Добавить тесты.', checked: false, lineNumber: 5 },
	]);
});

test('parsePlanChecklist supports ordered markdown items and uppercase marker', () => {
	const items = parsePlanChecklist(`
1. [X] Подготовить данные.
2. [ ] Проверить сборку.
`);

	assert.deepEqual(items, [
		{ text: 'Подготовить данные.', checked: true, lineNumber: 2 },
		{ text: 'Проверить сборку.', checked: false, lineNumber: 3 },
	]);
});

test('getPlanChecklistStats counts completed and pending items', () => {
	const stats = getPlanChecklistStats([
		{ text: 'One', checked: true, lineNumber: 1 },
		{ text: 'Two', checked: false, lineNumber: 2 },
		{ text: 'Three', checked: true, lineNumber: 3 },
	]);

	assert.deepEqual(stats, {
		total: 3,
		completed: 2,
		pending: 1,
	});
});

test('buildPlanChecklistSummary returns empty summary for empty checklist', () => {
	assert.deepEqual(buildPlanChecklistSummary([]), []);
});

test('buildPlanChecklistSummary returns counters for checklist items', () => {
	const summary = buildPlanChecklistSummary([
		{ text: 'One', checked: true, lineNumber: 1 },
		{ text: 'Two', checked: false, lineNumber: 2 },
	]);

	assert.deepEqual(summary, [
		'Выполнено: 1',
		'Осталось: 1',
		'Всего: 2',
	]);
});