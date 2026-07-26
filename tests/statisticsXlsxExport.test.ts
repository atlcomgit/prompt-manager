import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildStatisticsXlsxSheetData,
	buildStatisticsXlsxSheetOptions,
	createStatisticsXlsxBuffer,
	type StatisticsXlsxExportRow,
} from '../src/utils/statisticsXlsxExport.js';
import { formatStatisticsDurationForDisplay } from '../src/utils/statisticsTable.js';

/** Minimal generated cell shape used by focused XLSX export assertions. */
interface TestCellObject {
	/** Cell value written to the worksheet. */
	value?: string;
	/** Cell type passed to the XLSX writer. */
	type?: StringConstructor | string;
	/** Cell number format passed to the XLSX writer. */
	format?: string;
	/** Horizontal alignment passed to the XLSX writer. */
	align?: string;
	/** Text wrapping flag passed to the XLSX writer. */
	wrap?: boolean;
}

/** Minimal generated sheet shape used by focused XLSX export assertions. */
type TestSheetData = Array<Array<TestCellObject | null | undefined>>;

/** Build generated sheet data with the narrow shape used by assertions. */
function buildTestSheetData(locale: string): TestSheetData {
	return buildStatisticsXlsxSheetData(rows, locale) as unknown as TestSheetData;
}

/** Shared rows cover ordering, localization, totals and text safety checks. */
const rows: StatisticsXlsxExportRow[] = [
	{
		taskNumber: '162',
		title: '=1+1',
		status: 'in-progress',
		timeWriting: 1_000,
		timeImplementing: 61_000,
		timeOnTask: 3_661_000,
		timeUntracked: 0,
		totalTime: 3_723_000,
	},
	{
		taskNumber: '',
		title: 'Second row',
		status: 'completed',
		timeWriting: 2_000,
		timeImplementing: 2_000,
		timeOnTask: 2_000,
		timeUntracked: 2_000,
		totalTime: 8_000,
	},
];

/** Return a typed cell object from generated sheet data. */
function getCell(sheetData: TestSheetData, rowIndex: number, columnIndex: number): TestCellObject {
	const cell = sheetData[rowIndex]?.[columnIndex];

	assert.equal(typeof cell, 'object');
	assert.notEqual(cell, null);
	assert.ok(!Array.isArray(cell));

	return cell as TestCellObject;
}

/** Verify duration formatting branches shared by table and XLSX export. */
test('formatStatisticsDurationForDisplay formats compact durations', () => {
	assert.equal(formatStatisticsDurationForDisplay(0, 'ru'), '0с');
	assert.equal(formatStatisticsDurationForDisplay(999, 'ru'), '0с');
	assert.equal(formatStatisticsDurationForDisplay(1_000, 'ru'), '1с');
	assert.equal(formatStatisticsDurationForDisplay(61_000, 'ru'), '1м 1с');
	assert.equal(formatStatisticsDurationForDisplay(3_661_000, 'ru'), '1ч 1м 1с');
	assert.equal(formatStatisticsDurationForDisplay(3_661_000, 'en-US'), '1h 1m 1s');
});

/** Verify Russian headers, status labels, column count and row order. */
test('buildStatisticsXlsxSheetData builds localized Russian rows in input order', () => {
	const sheetData = buildTestSheetData('ru');

	assert.equal(sheetData[0]?.length, 8);
	assert.deepEqual(sheetData[0]?.map(cell => cell?.value), [
		'№ задачи',
		'Название',
		'Статус',
		'На промпт',
		'На чат',
		'На задачу',
		'На разное',
		'Итого',
	]);
	assert.equal(getCell(sheetData, 1, 0).value, '162');
	assert.equal(getCell(sheetData, 2, 0).value, '—');
	assert.equal(getCell(sheetData, 1, 2).value, 'В работе');
	assert.equal(getCell(sheetData, 2, 2).value, 'Завершено');
});

/** Verify English localization and empty task number placeholder. */
test('buildStatisticsXlsxSheetData builds localized English labels', () => {
	const sheetData = buildTestSheetData('en-US');

	assert.deepEqual(sheetData[0]?.map(cell => cell?.value), [
		'Task #',
		'Title',
		'Status',
		'Prompt',
		'Chat',
		'Task',
		'Other',
		'Total',
	]);
	assert.equal(getCell(sheetData, 1, 2).value, 'In progress');
	assert.equal(getCell(sheetData, 2, 0).value, '-');
	assert.equal(getCell(sheetData, 1, 5).value, '1h 1m 1s');

	// Check sheet-level settings used by the XLSX writer.
	const englishOptions = buildStatisticsXlsxSheetOptions('en');
	assert.equal(englishOptions.sheet, 'Statistics');
	assert.equal(englishOptions.stickyRowsCount, 1);
	assert.equal(englishOptions.orientation, 'landscape');
	assert.equal(englishOptions.columns?.length, 8);
	assert.equal(buildStatisticsXlsxSheetOptions('ru').sheet, 'Статистика');
});

/** Verify footer totals are calculated from exported rows without formulas. */
test('buildStatisticsXlsxSheetData calculates footer totals from rows', () => {
	const sheetData = buildTestSheetData('ru');
	const footerIndex = sheetData.length - 1;

	assert.equal(getCell(sheetData, footerIndex, 0).value, 'Итого');
	assert.equal(getCell(sheetData, footerIndex, 3).value, '3с');
	assert.equal(getCell(sheetData, footerIndex, 4).value, '1м 3с');
	assert.equal(getCell(sheetData, footerIndex, 5).value, '1ч 1м 3с');
	assert.equal(getCell(sheetData, footerIndex, 6).value, '2с');
	assert.equal(getCell(sheetData, footerIndex, 7).value, '1ч 2м 11с');
});

/** Verify text cells keep dangerous titles as literal strings. */
test('buildStatisticsXlsxSheetData marks dangerous title as text', () => {
	const sheetData = buildTestSheetData('ru');
	const titleCell = getCell(sheetData, 1, 1);

	assert.equal(titleCell.value, '=1+1');
	assert.equal(titleCell.type, String);
	assert.equal(titleCell.format, '@');
	assert.equal(titleCell.wrap, true);
	assert.notEqual(titleCell.type, 'Formula');
});

/** Verify time cells are text formatted and aligned to the right. */
test('buildStatisticsXlsxSheetData formats durations as right-aligned text', () => {
	const sheetData = buildTestSheetData('ru');
	const timeCell = getCell(sheetData, 1, 5);

	assert.equal(timeCell.value, '1ч 1м 1с');
	assert.equal(timeCell.type, String);
	assert.equal(timeCell.format, '@');
	assert.equal(timeCell.align, 'right');
});

/** Verify XLSX writer returns a non-empty ZIP file buffer. */
test('createStatisticsXlsxBuffer creates a real XLSX buffer', async () => {
	const buffer = await createStatisticsXlsxBuffer(rows, 'ru');

	assert.ok(buffer.length > 0);
	assert.equal(buffer.subarray(0, 2).toString('utf8'), 'PK');
});
