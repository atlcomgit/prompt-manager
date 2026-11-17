import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildPlanChecklistSummary,
	getPlanChecklistStats,
	parsePlanChecklist,
	selectCompactPlanLines,
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

test('selectCompactPlanLines preserves headings, checklist states, indentation, and source indices', () => {
	const lines = [
		'# План', 'Пояснение', '## Шаг 1', '- [x] Готово', '  - [ ] В работе',
		'1. [X] Проверено', '[ ] Без маркера', 'Обычный пункт', '####Не заголовок',
	];

	assert.deepEqual(selectCompactPlanLines(lines), [
		{ index: 0, text: '# План' },
		{ index: 2, text: '## Шаг 1' },
		{ index: 3, text: '- [x] Готово' },
		{ index: 4, text: '  - [ ] В работе' },
		{ index: 5, text: '1. [X] Проверено' },
		{ index: 6, text: '[ ] Без маркера' },
	]);
});

test('selectCompactPlanLines keeps only one existing blank before each section heading', () => {
	const lines = [
		'', '# План', '- [x] Готово', '  Подробности',
		'', ' ', '\t', '## Новый раздел',
		'- [ ] Короткое название', '  Подробности пункта', '## Без отступа',
		'', '', '### Финальный раздел', '- [x] Проверено',
		'', '', '- [ ] Другой пункт', '', '',
	];

	assert.deepEqual(selectCompactPlanLines(lines), [
		{ index: 1, text: '# План' },
		{ index: 2, text: '- [x] Готово' },
		{ index: 6, text: '' },
		{ index: 7, text: '## Новый раздел' },
		{ index: 8, text: '- [ ] Короткое название' },
		{ index: 10, text: '## Без отступа' },
		{ index: 12, text: '' },
		{ index: 13, text: '### Финальный раздел' },
		{ index: 14, text: '- [x] Проверено' },
		{ index: 17, text: '- [ ] Другой пункт' },
	]);
});

test('selectCompactPlanLines ignores headings and checkboxes inside fenced code', () => {
	const lines = [
		'# Заголовок', '```markdown', '## Код', '- [x] Ложный пункт', '```',
		'~~~', '- [ ] Другой ложный пункт', '~~~', '- [ ] Настоящий пункт',
	];

	assert.deepEqual(selectCompactPlanLines(lines), [
		{ index: 0, text: '# Заголовок' },
		{ index: 8, text: '- [ ] Настоящий пункт' },
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