export interface StatisticsExportPeriodInput {
	dateFrom?: string | null;
	dateTo?: string | null;
	fallbackHours?: number;
}

export type StatisticsExportStatus = 'draft' | 'in-progress' | 'stopped' | 'cancelled' | 'completed' | 'report' | 'review' | 'closed';

export interface StatisticsMarkdownExportRow {
	taskNumber: string;
	title: string;
	hours: number;
	reportSummary?: string;
	status?: StatisticsExportStatus;
}

export interface StatisticsWordExportRow {
	taskNumber: string;
	title: string;
	hours: number;
}

export interface StatisticsExportDisplayOptions {
	showHours?: boolean;
	showCost?: boolean;
}

export function normalizeStatisticsExportDisplayOptions(
	options?: StatisticsExportDisplayOptions,
): { showHours: boolean; showCost: boolean } {
	const showHours = options?.showHours !== false;
	const showCost = showHours && options?.showCost !== false;

	return { showHours, showCost };
}

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

function isFirstDayOfMonth(date: Date): boolean {
	return date.getUTCDate() === 1;
}

function isLastDayOfMonth(date: Date): boolean {
	const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
	return date.getUTCDate() === lastDay.getUTCDate();
}

function countInclusiveMonths(start: Date, end: Date): number {
	return ((end.getUTCFullYear() - start.getUTCFullYear()) * 12)
		+ (end.getUTCMonth() - start.getUTCMonth())
		+ 1;
}

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

function resolveStatisticsLocale(locale: string): string {
	return locale.toLowerCase().startsWith('ru') ? 'ru-RU' : 'en-US';
}

export function formatStatisticsExportNumber(value: number, locale: string): string {
	const normalized = Number.isFinite(value) ? value : 0;
	const hasFraction = Math.abs(normalized % 1) > 0.000001;
	return new Intl.NumberFormat(resolveStatisticsLocale(locale), {
		minimumFractionDigits: hasFraction ? 2 : 0,
		maximumFractionDigits: 2,
	}).format(normalized);
}

function formatStatisticsWordNumber(value: number, locale: string): string {
	const normalized = Number.isFinite(value) ? value : 0;
	const hasFraction = Math.abs(normalized % 1) > 0.000001;
	return new Intl.NumberFormat(resolveStatisticsLocale(locale), {
		useGrouping: false,
		minimumFractionDigits: hasFraction ? 2 : 0,
		maximumFractionDigits: 2,
	}).format(normalized);
}

function sanitizeStatisticsWordCell(value: string): string {
	return (value || '')
		.replace(/\t+/g, ' ')
		.replace(/\r?\n+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

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

function decodeBasicHtmlEntities(value: string): string {
	return value
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}

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

function extractDoneSection(text: string): string {
	const preparedText = text
		.replace(/\r/g, '')
		.replace(/\t/g, ' ')
		.replace(/[ \u00A0]+/g, ' ')
		.replace(/\n{2,}/g, '\n')
		.trim();

	const doneSectionMatch = /(?:^|\n)\s*(?:[-*+]\s*)?(?:\*\*|__)?(?:что\s+сделано|сделано|what\s+was\s+done)(?:\*\*|__)?\s*[:.]?\s*([\s\S]*?)(?=\n\s*(?:[-*+]\s*)?(?:\*\*|__)?(?:как\s+протестировать|особенности\s+реализации|примеры|how\s+to\s+test|implementation\s+details|examples)(?:\*\*|__)?\s*[:.]?|$)/i.exec(preparedText);
	const candidate = doneSectionMatch?.[1] || preparedText;
	return normalizeSummaryLine(candidate.replace(/\r?\n/g, ' '));
}

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
	const emptyValue = isRu ? '—' : '-';
	const totalAmount = rows.reduce((sum, row) => sum + ((Number.isFinite(row.hours) ? row.hours : 0) * (Number.isFinite(hourlyRate) ? hourlyRate : 0)), 0);
	const wordSection = buildStatisticsWordSection(rows, hourlyRate, locale, { showHours, showCost });
	const formattedDate = new Date().toLocaleString(isRu ? 'ru-RU' : 'en-US', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	});
	const summaryLines = [`- ${generatedLabel}: ${formattedDate}`];

	if (showHours) {
		summaryLines.push(`- ${totalLabel}: ${formatStatisticsExportNumber(totalHours, locale)}`);
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
		'',
		...summaryLines,
		'',
		blocks.join('\n\n'),
		'',
		wordSection,
		'',
	].join('\n');
}