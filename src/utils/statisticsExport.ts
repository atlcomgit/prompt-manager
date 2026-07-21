export interface StatisticsExportPeriodInput {
	dateFrom?: string | null;
	dateTo?: string | null;
	fallbackHours?: number;
}

/** Prompt statuses accepted by statistics export rows. */
export type StatisticsExportStatus =
	| 'draft'
	| 'in-progress'
	| 'stopped'
	| 'cancelled'
	| 'completed'
	| 'report'
	| 'review'
	| 'closed';

/** Time calculation mode used by statistics export documents. */
export type StatisticsExportHoursMode = 'actual' | 'scaled';

/** Date range shown in statistics export documents. */
export interface StatisticsExportPeriodRange {
	/** Inclusive first date in YYYY-MM-DD format. */
	dateFrom: string;
	/** Inclusive last date in YYYY-MM-DD format. */
	dateTo: string;
}

export interface StatisticsMarkdownExportRow {
	taskNumber: string;
	title: string;
	hours: number;
	reportSummary?: string;
	status?: StatisticsExportStatus;
}

/** Source row used to convert tracked milliseconds into actual export hours. */
export interface StatisticsActualExportSourceRow {
	/** Optional task reference displayed in the report. */
	taskNumber: string;
	/** Prompt title displayed in the report. */
	title: string;
	/** Tracked duration converted from milliseconds to fractional hours. */
	totalTime: number;
	/** Compact completed-work text included in detailed reports. */
	reportSummary?: string;
	/** Prompt status converted to a report progress percentage. */
	status?: StatisticsExportStatus;
}

export interface StatisticsWordExportRow {
	taskNumber: string;
	title: string;
	hours: number;
}

/** Display and context options shared by all statistics export renderers. */
export interface StatisticsExportDisplayOptions {
	showHours?: boolean;
	showCost?: boolean;
	/** actual keeps tracked daily time; scaled distributes rows to the entered target. */
	hoursMode?: StatisticsExportHoursMode;
	/** Full selected period shown in HTML and Markdown export documents. */
	period?: StatisticsExportPeriodRange;
}

/** Normalize optional visibility flags for all statistics export renderers. */
export function normalizeStatisticsExportDisplayOptions(
	options?: StatisticsExportDisplayOptions,
): { showHours: boolean; showCost: boolean } {
	const showHours = options?.showHours !== false;
	const showCost = showHours && options?.showCost !== false;

	return { showHours, showCost };
}

/** Parse a date-only value without applying the local timezone. */
function parseDateOnly(value?: string | null): Date | null {
	if (!value) {
		return null;
	}

	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (!match) {
		return null;
	}

	const year = Number.parseInt(match[1], 10);
	const month = Number.parseInt(match[2], 10);
	const day = Number.parseInt(match[3], 10);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	if (
		parsed.getUTCFullYear() !== year
		|| parsed.getUTCMonth() !== month - 1
		|| parsed.getUTCDate() !== day
	) {
		return null;
	}

	return parsed;
}

/** Check whether the date points to the first day of its UTC month. */
function isFirstDayOfMonth(date: Date): boolean {
	return date.getUTCDate() === 1;
}

/** Check whether the date points to the last day of its UTC month. */
function isLastDayOfMonth(date: Date): boolean {
	const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
	return date.getUTCDate() === lastDay.getUTCDate();
}

/** Count full calendar months covered by an inclusive date range. */
function countInclusiveMonths(start: Date, end: Date): number {
	return ((end.getUTCFullYear() - start.getUTCFullYear()) * 12)
		+ (end.getUTCMonth() - start.getUTCMonth())
		+ 1;
}

/** Count weekdays in an inclusive UTC date range. */
function countWorkingDays(start: Date, end: Date): number {
	let count = 0;
	const cursor = new Date(start.getTime());

	while (cursor.getTime() <= end.getTime()) {
		const day = cursor.getUTCDay();
		if (day !== 0 && day !== 6) {
			count += 1;
		}
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}

	return count;
}

/** Calculate the default scaled export target for the selected statistics period. */
export function calculateStatisticsExportTargetHours({
	dateFrom,
	dateTo,
	fallbackHours = 165,
}: StatisticsExportPeriodInput): number {
	const start = parseDateOnly(dateFrom);
	const end = parseDateOnly(dateTo);

	if (!start || !end) {
		return fallbackHours;
	}

	if (start.getTime() > end.getTime()) {
		return 0;
	}

	if (isFirstDayOfMonth(start) && isLastDayOfMonth(end)) {
		return countInclusiveMonths(start, end) * 165;
	}

	return countWorkingDays(start, end) * 8;
}

/** Resolve a compact locale supported by the statistics export formatters. */
function resolveStatisticsLocale(locale: string): string {
	return locale.toLowerCase().startsWith('ru') ? 'ru-RU' : 'en-US';
}

/** Format a number with locale-aware grouping and up to two fractional digits. */
export function formatStatisticsExportNumber(value: number, locale: string): string {
	const normalized = Number.isFinite(value) ? value : 0;
	const hasFraction = Math.abs(normalized % 1) > 0.000001;
	return new Intl.NumberFormat(resolveStatisticsLocale(locale), {
		minimumFractionDigits: hasFraction ? 2 : 0,
		maximumFractionDigits: 2,
	}).format(normalized);
}

/** Convert tracked report durations to fractional hours without proportional scaling. */
export function buildStatisticsActualExportRows(
	rows: StatisticsActualExportSourceRow[],
): StatisticsMarkdownExportRow[] {
	const hourMs = 1000 * 60 * 60;
	return rows.map(row => ({
		taskNumber: row.taskNumber || '—',
		title: row.title,
		hours: Number.isFinite(row.totalTime) && row.totalTime > 0 ? row.totalTime / hourMs : 0,
		status: row.status,
		reportSummary: row.reportSummary || '',
	}));
}

/** Format a date range for statistics export subtitles and summary metadata. */
export function formatStatisticsExportPeriod(
	period: StatisticsExportPeriodRange | undefined,
	locale: string,
): string {
	const start = parseDateOnly(period?.dateFrom);
	const end = parseDateOnly(period?.dateTo);
	if (!start || !end) {
		return '';
	}

	const formatter = new Intl.DateTimeFormat(resolveStatisticsLocale(locale), {
		timeZone: 'UTC',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	const formattedStart = formatter.format(start);
	const formattedEnd = formatter.format(end);

	return formattedStart === formattedEnd ? formattedStart : `${formattedStart} - ${formattedEnd}`;
}

/** Build the localized document subtitle for actual and scaled statistics export modes. */
export function buildStatisticsExportSubtitle(
	totalHours: number,
	hourlyRate: number,
	locale: string,
	options: StatisticsExportDisplayOptions = {},
): string {
	const isRu = locale.toLowerCase().startsWith('ru');
	const { showHours, showCost } = normalizeStatisticsExportDisplayOptions(options);
	const formattedTotalHours = formatStatisticsExportNumber(totalHours, locale);
	const formattedHourlyRate = formatStatisticsExportNumber(hourlyRate, locale);
	const period = formatStatisticsExportPeriod(options.period, locale);
	const periodText = period ? (isRu ? ` за период ${period}` : ` for ${period}`) : '';

	if (!showHours) {
		return isRu
			? `Сводный отчёт${periodText} по выбранным задачам.`
			: `Summary report${periodText} for selected tasks.`;
	}

	if (options.hoursMode === 'actual') {
		return isRu
			? `Сводный отчёт${periodText} по фактически учтённому времени: ${formattedTotalHours} часов.`
			: `Summary report${periodText} with actual tracked time: ${formattedTotalHours} hours.`;
	}

	if (showCost) {
		return isRu
			? `Сводный отчёт${periodText} с пропорциональным распределением до ${formattedTotalHours} часов `
				+ `по ставке ${formattedHourlyRate}.`
			: `Summary report${periodText} with proportional distribution to ${formattedTotalHours} hours `
				+ `at a ${formattedHourlyRate} hourly rate.`;
	}

	return isRu
		? `Сводный отчёт${periodText} с пропорциональным распределением до ${formattedTotalHours} часов.`
		: `Summary report${periodText} with proportional distribution to ${formattedTotalHours} hours.`;
}

/** Format a number for tab-separated Word-compatible export rows. */
function formatStatisticsWordNumber(value: number, locale: string): string {
	const normalized = Number.isFinite(value) ? value : 0;
	const hasFraction = Math.abs(normalized % 1) > 0.000001;
	return new Intl.NumberFormat(resolveStatisticsLocale(locale), {
		useGrouping: false,
		minimumFractionDigits: hasFraction ? 2 : 0,
		maximumFractionDigits: 2,
	}).format(normalized);
}

/** Sanitize text before placing it into tab-separated Word-compatible cells. */
function sanitizeStatisticsWordCell(value: string): string {
	return (value || '')
		.replace(/\t+/g, ' ')
		.replace(/\r?\n+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Build a tab-separated section that can be pasted into Word as a table. */
export function buildStatisticsWordSection(
	rows: StatisticsWordExportRow[],
	hourlyRate: number,
	locale: string,
	options: StatisticsExportDisplayOptions = {},
): string {
	const { showHours, showCost } = normalizeStatisticsExportDisplayOptions(options);
	const isRu = locale.toLowerCase().startsWith('ru');
	const taskFallback = isRu ? '—' : '-';
	const unitLabel = isRu ? 'ч.' : 'h.';
	const headers = isRu
		? ['№', 'Номер задачи: Название']
		: ['#', 'Task number: Title'];

	if (showHours) {
		headers.push(isRu ? 'Количество часов' : 'Hours', unitLabel);
	}

	if (showCost) {
		headers.push(isRu ? 'Стоимость часа' : 'Hourly rate', isRu ? 'Сумма' : 'Amount');
	}

	const safeHourlyRate = Number.isFinite(hourlyRate) ? hourlyRate : 0;
	const lines = rows.map((row, index) => {
		const taskNumber = sanitizeStatisticsWordCell(row.taskNumber || '') || taskFallback;
		const title = sanitizeStatisticsWordCell(row.title || '') || taskFallback;
		const hours = Number.isFinite(row.hours) ? row.hours : 0;
		const amount = hours * safeHourlyRate;

		const columns = [
			String(index + 1),
			`${taskNumber}: ${title}`,
		];

		if (showHours) {
			columns.push(formatStatisticsWordNumber(hours, locale), unitLabel);
		}

		if (showCost) {
			columns.push(
				formatStatisticsWordNumber(safeHourlyRate, locale),
				formatStatisticsWordNumber(amount, locale),
			);
		}

		return columns.join('\t');
	});

	return [
		'## Word',
		'',
		headers.join('\t'),
		...lines,
	].join('\n');
}

/** Decode the small subset of HTML entities used in report summaries. */
function decodeBasicHtmlEntities(value: string): string {
	return value
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}

/** Normalize one report line before it is inserted into statistics exports. */
function normalizeSummaryLine(value: string): string {
	return decodeBasicHtmlEntities(value)
		.replace(/`([^`]+)`/g, '$1')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/^[\s>*#\-+]+/g, '')
		.replace(/[*_~]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Extract the user-facing completed-work section from a prompt report. */
function extractDoneSection(text: string): string {
	const preparedText = text
		.replace(/\r/g, '')
		.replace(/\t/g, ' ')
		.replace(/[ \u00A0]+/g, ' ')
		.replace(/\n{2,}/g, '\n')
		.trim();

	// The section detector is split into readable fragments to keep the export parser maintainable.
	const headingPrefix = String.raw`\s*(?:[-*+]\s*)?(?:\*\*|__)?`;
	const headingSuffix = String.raw`(?:\*\*|__)?\s*[:.]?`;
	const doneHeading = String.raw`(?:что\s+сделано|сделано|what\s+was\s+done)`;
	const nextHeading = String.raw`(?:как\s+протестировать|особенности\s+реализации|примеры|`
		+ String.raw`how\s+to\s+test|implementation\s+details|examples)`;
	const doneSectionPattern = new RegExp(
		String.raw`(?:^|\n)`
			+ headingPrefix
			+ doneHeading
			+ headingSuffix
			+ String.raw`\s*([\s\S]*?)(?=\n`
			+ headingPrefix
			+ nextHeading
			+ headingSuffix
			+ String.raw`|$)`,
		'i',
	);
	const doneSectionMatch = doneSectionPattern.exec(preparedText);
	const candidate = doneSectionMatch?.[1] || preparedText;
	return normalizeSummaryLine(candidate.replace(/\r?\n/g, ' '));
}

/** Summarize a prompt report for compact statistics export rows. */
export function summarizePromptReport(report: string, maxLength: number = 500): string {
	const normalized = extractDoneSection(decodeBasicHtmlEntities(
		(report || '')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|blockquote|pre|tr|table)>/gi, '\n')
			.replace(/<li\b[^>]*>/gi, '\n')
			.replace(/<[^>]+>/g, ' ')
			.replace(/```[\s\S]*?```/g, '\n')
	)).trim();

	if (!normalized) {
		return '';
	}

	if (normalized.length <= maxLength) {
		return normalized;
	}

	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Map prompt statuses to progress percentages shown in report-based exports. */
export function getStatisticsStatusPercent(status?: StatisticsExportStatus): number {
	switch (status) {
		case 'draft':
			return 10;
		case 'closed':
			return 100;
		case 'in-progress':
			return 50;
		case 'stopped':
			return 60;
		case 'cancelled':
			return 0;
		case 'completed':
			return 70;
		case 'report':
			return 80;
		case 'review':
			return 90;
		default:
			return 0;
	}
}

/** Build a Markdown export where each prompt includes its report summary. */
export function buildStatisticsMarkdownWithReport(
	rows: StatisticsMarkdownExportRow[],
	totalHours: number,
	hourlyRate: number,
	locale: string,
	options: StatisticsExportDisplayOptions = {},
): string {
	const { showHours, showCost } = normalizeStatisticsExportDisplayOptions(options);
	const isRu = locale.toLowerCase().startsWith('ru');
	const title = isRu ? '# Отчёт по статистике' : '# Statistics Report';
	const generatedLabel = isRu ? 'Сформировано' : 'Generated';
	const totalLabel = isRu ? 'Итого часов' : 'Total hours';
	const hourlyRateLabel = isRu ? 'Ставка часа' : 'Hourly rate';
	const totalAmountLabel = isRu ? 'Итоговая сумма' : 'Total amount';
	const taskNumberLabel = isRu ? 'Номер задачи' : 'Task number';
	const nameLabel = isRu ? 'Название' : 'Title';
	const summaryLabel = isRu ? 'Что сделано' : 'What was done';
	const statusLabel = isRu ? 'Статус' : 'Status';
	const hoursLabel = isRu ? 'Часы' : 'Hours';
	const amountLabel = isRu ? 'Сумма' : 'Amount';
	const periodLabel = isRu ? 'Период' : 'Period';
	const modeLabel = isRu ? 'Режим часов' : 'Hours mode';
	const actualModeLabel = isRu ? 'фактические часы' : 'actual hours';
	const scaledModeLabel = isRu ? 'масштабирование' : 'scaled hours';
	const emptyValue = isRu ? '—' : '-';
	const totalAmount = rows.reduce((sum, row) => {
		const rowHours = Number.isFinite(row.hours) ? row.hours : 0;
		const safeHourlyRate = Number.isFinite(hourlyRate) ? hourlyRate : 0;
		return sum + (rowHours * safeHourlyRate);
	}, 0);
	const wordSection = buildStatisticsWordSection(rows, hourlyRate, locale, { showHours, showCost });
	const subtitle = buildStatisticsExportSubtitle(totalHours, hourlyRate, locale, options);
	const formattedPeriod = formatStatisticsExportPeriod(options.period, locale);
	const formattedDate = new Date().toLocaleString(isRu ? 'ru-RU' : 'en-US', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	});
	const summaryLines = [`- ${generatedLabel}: ${formattedDate}`];
	if (formattedPeriod) {
		summaryLines.push(`- ${periodLabel}: ${formattedPeriod}`);
	}

	if (showHours) {
		summaryLines.push(`- ${totalLabel}: ${formatStatisticsExportNumber(totalHours, locale)}`);
		const hoursModeLabel = options.hoursMode === 'actual' ? actualModeLabel : scaledModeLabel;
		summaryLines.push(`- ${modeLabel}: ${hoursModeLabel}`);
	}

	if (showCost) {
		summaryLines.push(`- ${hourlyRateLabel}: ${formatStatisticsExportNumber(hourlyRate, locale)}`);
		summaryLines.push(`- ${totalAmountLabel}: ${formatStatisticsExportNumber(totalAmount, locale)}`);
	}

	const blocks = rows.map((row) => {
		const taskNumber = (row.taskNumber || '').trim() || emptyValue;
		const taskTitle = (row.title || '').trim() || emptyValue;
		const reportSummary = (row.reportSummary || '').trim() || emptyValue;
		const statusPercent = getStatisticsStatusPercent(row.status);
		const hours = formatStatisticsExportNumber(row.hours, locale);
		const amount = formatStatisticsExportNumber(row.hours * hourlyRate, locale);
		const lines = [
			`${taskNumberLabel}: ${taskNumber}`,
			`${nameLabel}: ${taskTitle}`,
		];

		if (showHours) {
			lines.push(`${hoursLabel}: ${hours}`);
		}

		if (showCost) {
			lines.push(`${amountLabel}: ${amount}`);
		}

		lines.push(`${summaryLabel}: ${reportSummary}`);
		lines.push(`${statusLabel}: ${statusPercent}%`);

		return lines.join('\n');
	});

	return [
		title,
		`> ${subtitle}`,
		'',
		...summaryLines,
		'',
		blocks.join('\n\n'),
		'',
		wordSection,
		'',
	].join('\n');
}
