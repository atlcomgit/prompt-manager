import test from 'node:test';
import assert from 'node:assert/strict';

import {
	COMPACT_TASK_COLUMN_BUFFER_CH,
	COMPACT_TASK_COLUMN_MAX_WIDTH_RATIO,
	COMPACT_TASK_COLUMN_MIN_WIDTH_PX,
	COMPACT_TASK_TITLE_COLUMN_GAP_PX,
	COMPACT_TITLE_STATUS_COLUMN_GAP_PX,
	normalizeCompactTaskNumber,
	resolveCompactPromptGridTemplateColumns,
	resolveCompactTaskColumnTrack,
	resolveSharedCompactTaskColumnTrack,
} from '../src/utils/sidebarCompactLayout.js';

test('normalizeCompactTaskNumber trims the value and falls back to a placeholder', () => {
	assert.equal(normalizeCompactTaskNumber('  347417694  '), '347417694');
	assert.equal(normalizeCompactTaskNumber('   '), '—');
	assert.equal(normalizeCompactTaskNumber(undefined), '—');
	assert.equal(normalizeCompactTaskNumber(null), '—');
});

test('resolveCompactTaskColumnTrack keeps the minimum width for short values', () => {
	assert.equal(
		resolveCompactTaskColumnTrack('7'),
		`minmax(${COMPACT_TASK_COLUMN_MIN_WIDTH_PX}px, min(${COMPACT_TASK_COLUMN_MAX_WIDTH_RATIO}, ${Number((1 + COMPACT_TASK_COLUMN_BUFFER_CH).toFixed(1))}ch))`,
	);
});

test('resolveCompactTaskColumnTrack grows with the task number length but keeps a one-third cap', () => {
	assert.equal(
		resolveCompactTaskColumnTrack('347417694'),
		`minmax(${COMPACT_TASK_COLUMN_MIN_WIDTH_PX}px, min(${COMPACT_TASK_COLUMN_MAX_WIDTH_RATIO}, ${Number((9 + COMPACT_TASK_COLUMN_BUFFER_CH).toFixed(1))}ch))`,
	);

	assert.equal(
		resolveCompactTaskColumnTrack('  TASK-12345678901234567890  '),
		`minmax(${COMPACT_TASK_COLUMN_MIN_WIDTH_PX}px, min(${COMPACT_TASK_COLUMN_MAX_WIDTH_RATIO}, ${Number((25 + COMPACT_TASK_COLUMN_BUFFER_CH).toFixed(1))}ch))`,
	);
});

test('resolveSharedCompactTaskColumnTrack aligns the whole list by the widest normalized task number', () => {
	assert.equal(
		resolveSharedCompactTaskColumnTrack(['12', ' 347417694 ', undefined, '5']),
		`minmax(${COMPACT_TASK_COLUMN_MIN_WIDTH_PX}px, min(${COMPACT_TASK_COLUMN_MAX_WIDTH_RATIO}, ${Number((9 + COMPACT_TASK_COLUMN_BUFFER_CH).toFixed(1))}ch))`,
	);

	assert.equal(
		resolveSharedCompactTaskColumnTrack([]),
		resolveCompactTaskColumnTrack(undefined),
	);
});

test('resolveCompactPromptGridTemplateColumns uses a tighter gap between task and title columns', () => {
	assert.equal(
		resolveCompactPromptGridTemplateColumns(resolveCompactTaskColumnTrack('347417694')),
		`${resolveCompactTaskColumnTrack('347417694')} ${COMPACT_TASK_TITLE_COLUMN_GAP_PX}px minmax(0, 1fr) ${COMPACT_TITLE_STATUS_COLUMN_GAP_PX}px max-content`,
	);
});