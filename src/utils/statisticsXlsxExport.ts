import type {
	CellObject,
	SheetData,
	SheetOptions,
} from 'write-excel-file/node' with { "resolution-mode": "import" };

import type { PromptStatus } from '../types/prompt.js';
import { formatStatisticsDurationForDisplay } from './statisticsTable.js';

/** Source row used to build the statistics XLSX table. */
export interface StatisticsXlsxExportRow {
	/** Task number displayed in the first column. */
	taskNumber: string;
	/** Prompt title displayed as text to avoid spreadsheet formula execution. */
	title: string;
	/** Prompt lifecycle status localized for the selected export locale. */
	status: PromptStatus;
	/** Time spent preparing the prompt, in milliseconds. */
	timeWriting: number;
	/** Time spent in chat, in milliseconds. */
	timeImplementing: number;
	/** Time spent on the task outside chat, in milliseconds. */
	timeOnTask: number;
	/** Time that could not be assigned to a specific activity, in milliseconds. */
	timeUntracked: number;
	/** Total tracked time, in milliseconds. */
	totalTime: number;
}

/** Localized labels used by the statistics XLSX export. */
interface StatisticsXlsxExportLabels {
	/** Excel sheet name. */
	sheetName: string;
	/** Header cell labels in export column order. */
	headers: readonly string[];
	/** Footer label shown in the summary row. */
	footer: string;
	/** Placeholder used when a task number is empty. */
	emptyTaskNumber: string;
	/** Status labels keyed by persisted prompt status. */
	statuses: Record<PromptStatus, string>;
}

/** Text cells are forced to text format to prevent formula interpretation. */
const TEXT_CELL_BASE_STYLE = {
	type: String,
	format: '@',
} as const;

/** Header cells use bold text and a subtle fill for readability. */
const HEADER_CELL_STYLE = {
	...TEXT_CELL_BASE_STYLE,
	fontWeight: 'bold',
	backgroundColor: '#E5E7EB',
	borderColor: '#D1D5DB',
	borderStyle: 'thin',
} as const;

/** Footer cells are bold so totals are visually separated from data rows. */
const FOOTER_CELL_STYLE = {
	...TEXT_CELL_BASE_STYLE,
	fontWeight: 'bold',
	backgroundColor: '#F3F4F6',
	borderColor: '#D1D5DB',
	borderStyle: 'thin',
} as const;

/** Regular text cells keep spreadsheet values as literal text. */
const TEXT_CELL_STYLE = {
	...TEXT_CELL_BASE_STYLE,
	alignVertical: 'top',
} as const;

/** Time cells are text-formatted durations aligned to the right. */
const TIME_CELL_STYLE = {
	...TEXT_CELL_STYLE,
	align: 'right',
} as const;

/** Title cells wrap long prompt names inside a wider column. */
const TITLE_CELL_STYLE = {
	...TEXT_CELL_STYLE,
	wrap: true,
} as const;

/** Column widths keep task metadata compact and the title readable. */
const STATISTICS_XLSX_COLUMNS = [
	{ width: 14 },
	{ width: 48 },
	{ width: 16 },
	{ width: 14 },
	{ width: 14 },
	{ width: 14 },
	{ width: 14 },
	{ width: 14 },
];

/** Check whether the selected locale should use Russian labels. */
function isRussianStatisticsLocale(locale: string): boolean {
	return locale.toLowerCase().startsWith('ru');
}

/** Build localized labels for headers, statuses, footer and sheet name. */
function buildStatisticsXlsxExportLabels(locale: string): StatisticsXlsxExportLabels {
	if (isRussianStatisticsLocale(locale)) {
		return {
			sheetName: 'Статистика',
			headers: [
				'№ задачи',
				'Название',
				'Статус',
				'На промпт',
				'На чат',
				'На задачу',
				'На разное',
				'Итого',
			],
			footer: 'Итого',
			emptyTaskNumber: '—',
			statuses: {
				draft: 'Черновик',
				'in-progress': 'В работе',
				stopped: 'Остановлено',
				cancelled: 'Отменено',
				completed: 'Завершено',
				report: 'Отчёт',
				review: 'Проверка',
				closed: 'Закрыто',
			},
		};
	}

	return {
		sheetName: 'Statistics',
		headers: [
			'Task #',
			'Title',
			'Status',
			'Prompt',
			'Chat',
			'Task',
			'Other',
			'Total',
		],
		footer: 'Total',
		emptyTaskNumber: '-',
		statuses: {
			draft: 'Draft',
			'in-progress': 'In progress',
			stopped: 'Stopped',
			cancelled: 'Cancelled',
			completed: 'Completed',
			report: 'Report',
			review: 'Review',
			closed: 'Closed',
		},
	};
}

/** Normalize duration values before displaying them and calculating the footer. */
function normalizeDuration(milliseconds: number): number {
	return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
}

/** Build a safe text cell with optional style overrides. */
function createTextCell(value: string, style: Partial<CellObject> = {}): CellObject {
	return {
		...TEXT_CELL_STYLE,
		...style,
		value,
	};
}

/** Build a right-aligned localized duration cell using the shared display formatter. */
function createDurationCell(milliseconds: number, locale: string, style: Partial<CellObject> = {}): CellObject {
	return createTextCell(formatStatisticsDurationForDisplay(milliseconds, locale), {
		...TIME_CELL_STYLE,
		...style,
	});
}

/** Build a header row in the required statistics column order. */
function buildHeaderRow(labels: StatisticsXlsxExportLabels): CellObject[] {
	return labels.headers.map((header, index) => createTextCell(header, {
		...HEADER_CELL_STYLE,
		align: index >= 3 ? 'right' : 'left',
		wrap: index === 1,
	}));
}

/** Build one data row while preserving incoming order and text-only values. */
function buildDataRow(
	row: StatisticsXlsxExportRow,
	labels: StatisticsXlsxExportLabels,
	locale: string,
): CellObject[] {
	return [
		createTextCell(row.taskNumber.trim() || labels.emptyTaskNumber),
		createTextCell(row.title, TITLE_CELL_STYLE),
		createTextCell(labels.statuses[row.status]),
		createDurationCell(normalizeDuration(row.timeWriting), locale),
		createDurationCell(normalizeDuration(row.timeImplementing), locale),
		createDurationCell(normalizeDuration(row.timeOnTask), locale),
		createDurationCell(normalizeDuration(row.timeUntracked), locale),
		createDurationCell(normalizeDuration(row.totalTime), locale),
	];
}

/** Build the bold footer row from the same source rows exported above it. */
function buildFooterRow(
	rows: StatisticsXlsxExportRow[],
	labels: StatisticsXlsxExportLabels,
	locale: string,
): CellObject[] {
	// Sum normalized row durations so the footer matches displayed values.
	const totals = rows.reduce((result, row) => ({
		timeWriting: result.timeWriting + normalizeDuration(row.timeWriting),
		timeImplementing: result.timeImplementing + normalizeDuration(row.timeImplementing),
		timeOnTask: result.timeOnTask + normalizeDuration(row.timeOnTask),
		timeUntracked: result.timeUntracked + normalizeDuration(row.timeUntracked),
		totalTime: result.totalTime + normalizeDuration(row.totalTime),
	}), {
		timeWriting: 0,
		timeImplementing: 0,
		timeOnTask: 0,
		timeUntracked: 0,
		totalTime: 0,
	});

	return [
		createTextCell(labels.footer, FOOTER_CELL_STYLE),
		createTextCell('', FOOTER_CELL_STYLE),
		createTextCell('', FOOTER_CELL_STYLE),
		createDurationCell(totals.timeWriting, locale, FOOTER_CELL_STYLE),
		createDurationCell(totals.timeImplementing, locale, FOOTER_CELL_STYLE),
		createDurationCell(totals.timeOnTask, locale, FOOTER_CELL_STYLE),
		createDurationCell(totals.timeUntracked, locale, FOOTER_CELL_STYLE),
		createDurationCell(totals.totalTime, locale, FOOTER_CELL_STYLE),
	];
}

/** Build XLSX sheet options for the localized statistics worksheet. */
export function buildStatisticsXlsxSheetOptions(locale: string): SheetOptions<Buffer> {
	const labels = buildStatisticsXlsxExportLabels(locale);

	return {
		sheet: labels.sheetName,
		columns: STATISTICS_XLSX_COLUMNS,
		stickyRowsCount: 1,
		orientation: 'landscape',
	};
}

/** Build statistics XLSX sheet data without producing a file. */
export function buildStatisticsXlsxSheetData(rows: StatisticsXlsxExportRow[], locale: string): SheetData {
	const labels = buildStatisticsXlsxExportLabels(locale);
	const dataRows = rows.map(row => buildDataRow(row, labels, locale));

	return [
		buildHeaderRow(labels),
		...dataRows,
		buildFooterRow(rows, labels, locale),
	];
}

/** Create a real XLSX buffer for Node.js callers. */
export async function createStatisticsXlsxBuffer(
	rows: StatisticsXlsxExportRow[],
	locale: string,
): Promise<Buffer> {
	const { default: writeXlsxFile } = await import('write-excel-file/node');
	const sheetData = buildStatisticsXlsxSheetData(rows, locale);
	const sheetOptions = buildStatisticsXlsxSheetOptions(locale);

	return writeXlsxFile(sheetData, sheetOptions).toBuffer();
}
