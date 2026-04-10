import {
	buildStatisticsMarkdownWithReport,
	normalizeStatisticsExportDisplayOptions,
	buildStatisticsWordSection,
	formatStatisticsExportNumber,
	type StatisticsExportDisplayOptions,
	type StatisticsExportStatus,
} from './statisticsExport.js';

export interface StatisticsExportDocumentRow {
	taskNumber: string;
	title: string;
	hours: number;
	status?: StatisticsExportStatus;
	reportSummary?: string;
}

const DEFAULT_EXPORT_HOURLY_RATE = 1743;

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function resolveExportHourlyRate(hourlyRate: number | undefined): number {
	if (typeof hourlyRate !== 'number' || !Number.isFinite(hourlyRate) || hourlyRate < 0) {
		return DEFAULT_EXPORT_HOURLY_RATE;
	}

	return hourlyRate;
}

function calculateExportRowAmount(hours: number, hourlyRate: number): number {
	return (Number.isFinite(hours) ? hours : 0) * resolveExportHourlyRate(hourlyRate);
}

function resolveStatisticsDocumentDisplayOptions(
	totalHours: number,
	hourlyRate: number | undefined,
	options?: StatisticsExportDisplayOptions,
): { showHours: boolean; showCost: boolean } {
	const inferredShowHours = Number.isFinite(totalHours) && totalHours > 0;
	const inferredShowCost = inferredShowHours && typeof hourlyRate === 'number' && Number.isFinite(hourlyRate) && hourlyRate > 0;

	return normalizeStatisticsExportDisplayOptions({
		showHours: options?.showHours ?? inferredShowHours,
		showCost: options?.showCost ?? inferredShowCost,
	});
}

function buildLabels(
	locale: string,
	formattedTotalHours: string,
	formattedHourlyRate: string,
	displayOptions: StatisticsExportDisplayOptions,
) {
	const isRu = locale.toLowerCase().startsWith('ru');
	const { showHours, showCost } = normalizeStatisticsExportDisplayOptions(displayOptions);
	const subtitle = showHours && showCost
		? (isRu
			? `Сводный отчёт с пропорциональным распределением до ${formattedTotalHours} часов по ставке ${formattedHourlyRate}`
			: `Summary report with proportional distribution to ${formattedTotalHours} hours at a ${formattedHourlyRate} hourly rate`)
		: showHours
			? (isRu
				? `Сводный отчёт с пропорциональным распределением до ${formattedTotalHours} часов.`
				: `Summary report with proportional distribution to ${formattedTotalHours} hours.`)
			: (isRu
				? 'Сводный отчёт по выбранным задачам.'
				: 'Summary report for selected tasks.');

	return {
		isRu,
		lang: isRu ? 'ru' : 'en',
		title: isRu ? 'Отчёт по статистике' : 'Statistics Report',
		subtitle,
		generated: isRu ? 'Сформировано' : 'Generated',
		total: isRu ? 'Итого часов' : 'Total hours',
		rate: isRu ? 'Ставка часа' : 'Hourly rate',
		totalAmount: isRu ? 'Итоговая сумма' : 'Total amount',
		count: isRu ? 'Задач в отчёте' : 'Tasks in report',
		taskNumber: isRu ? '№ задачи' : 'Task #',
		name: isRu ? 'Название' : 'Title',
		hours: isRu ? 'Часы' : 'Hours',
		amount: isRu ? 'Сумма' : 'Amount',
		report: isRu ? 'Что сделано' : 'Summary',
		footer: isRu ? 'Prompt Manager • HTML-документ' : 'Prompt Manager • HTML document',
	};
}

function buildFormattedDate(locale: string, isRu: boolean): string {
	return new Date().toLocaleString(isRu ? 'ru-RU' : 'en-US', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	});
}

function buildStatisticsDocumentStyles(): string {
	return `
		:root {
			color-scheme: light;
		}

		.pm-stats-export-page {
			--bg: #f4f6f8;
			--panel: #ffffff;
			--panel-muted: #fafbfc;
			--border: #d8dee4;
			--border-strong: #c7d0d9;
			--text: #1f2933;
			--muted: #5b6773;
			--accent: #0f766e;
			margin: 0;
			padding: 32px;
			font-family: "Segoe UI", "Noto Sans", sans-serif;
			background: var(--bg);
			color: var(--text);
		}

		.pm-stats-export-page * {
			box-sizing: border-box;
		}

		.pm-stats-export-container {
			max-width: 1120px;
			margin: 0 auto;
			background: var(--panel);
			border: 1px solid var(--border);
			border-radius: 12px;
			box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
			overflow: hidden;
		}

		.pm-stats-export-header {
			padding: 32px 36px 24px;
			background: var(--panel-muted);
			border-bottom: 1px solid var(--border);
		}

		.pm-stats-export-kicker {
			display: inline-flex;
			align-items: center;
			padding: 6px 10px;
			border-radius: 6px;
			background: #ecfdf5;
			color: var(--accent);
			font-size: 12px;
			font-weight: 700;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			border: 1px solid #cce9e4;
		}

		.pm-stats-export-title {
			margin: 18px 0 8px;
			font-size: 32px;
			line-height: 1.15;
			letter-spacing: -0.02em;
		}

		.pm-stats-export-subtitle {
			margin: 0;
			font-size: 15px;
			line-height: 1.5;
			color: var(--muted);
		}

		.pm-stats-export-meta {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
			gap: 12px;
			padding: 24px 36px 0;
		}

		.pm-stats-export-meta-card {
			padding: 18px 20px;
			border-radius: 10px;
			background: var(--panel);
			border: 1px solid var(--border);
		}

		.pm-stats-export-meta-label {
			display: block;
			font-size: 12px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--muted);
			margin-bottom: 8px;
		}

		.pm-stats-export-meta-value {
			display: block;
			font-size: 28px;
			font-weight: 700;
		}

		.pm-stats-export-table-wrap {
			padding: 24px 36px 36px;
		}

		.pm-stats-export-table {
			width: 100%;
			border-collapse: separate;
			border-spacing: 0;
			background: var(--panel);
			border: 1px solid var(--border);
			border-radius: 10px;
			overflow: hidden;
		}

		.pm-stats-export-table thead th {
			padding: 18px 20px;
			text-align: left;
			font-size: 13px;
			font-weight: 700;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			background: #f8fafc;
			border-bottom: 1px solid var(--border-strong);
		}

		.pm-stats-export-table tbody td,
		.pm-stats-export-table tfoot td {
			padding: 18px 20px;
			border-bottom: 1px solid var(--border);
			vertical-align: top;
		}

		.pm-stats-export-table tbody tr:last-child td {
			border-bottom: none;
		}

		.pm-stats-export-row-even {
			background: #ffffff;
		}

		.pm-stats-export-row-odd {
			background: #fbfcfd;
		}

		.pm-stats-export-col-task {
			width: 140px;
			font-weight: 700;
			white-space: nowrap;
			color: var(--accent);
		}

		.pm-stats-export-col-title {
			width: auto;
		}

		.pm-stats-export-col-report {
			width: 36%;
			line-height: 1.45;
			color: var(--muted);
		}

		.pm-stats-export-col-hours,
		.pm-stats-export-col-amount,
		.pm-stats-export-col-hours-head,
		.pm-stats-export-col-amount-head {
			text-align: right;
		}

		.pm-stats-export-col-hours {
			width: 120px;
			font-weight: 700;
		}

		.pm-stats-export-col-amount {
			width: 160px;
			font-weight: 700;
		}

		.pm-stats-export-table tfoot td {
			background: #f8fafc;
			font-weight: 700;
			border-top: 1px solid var(--border-strong);
			border-bottom: none;
		}

		.pm-stats-export-footer {
			padding: 0 36px 32px;
			font-size: 13px;
			color: var(--muted);
		}

		@media (max-width: 800px) {
			.pm-stats-export-page {
				padding: 16px;
			}

			.pm-stats-export-header,
			.pm-stats-export-table-wrap,
			.pm-stats-export-footer,
			.pm-stats-export-meta {
				padding-left: 18px;
				padding-right: 18px;
			}

			.pm-stats-export-meta {
				grid-template-columns: 1fr;
			}

			.pm-stats-export-title {
				font-size: 28px;
			}

			.pm-stats-export-table,
			.pm-stats-export-table thead,
			.pm-stats-export-table tbody,
			.pm-stats-export-table tfoot,
			.pm-stats-export-table tr,
			.pm-stats-export-table th,
			.pm-stats-export-table td {
				display: block;
			}

			.pm-stats-export-table thead {
				display: none;
			}

			.pm-stats-export-table tbody tr,
			.pm-stats-export-table tfoot tr {
				border-bottom: 1px solid var(--border);
			}

			.pm-stats-export-table tbody td,
			.pm-stats-export-table tfoot td,
			.pm-stats-export-col-hours,
			.pm-stats-export-col-amount {
				padding: 10px 14px;
				text-align: left;
				width: auto;
			}
		}
	`;
}

function buildStatisticsDocumentMarkup(
	rows: StatisticsExportDocumentRow[],
	totalHours: number,
	locale: string,
	includeReport: boolean,
	hourlyRate: number,
	displayOptions?: StatisticsExportDisplayOptions,
): { lang: string; title: string; markup: string } {
	const resolvedDisplayOptions = resolveStatisticsDocumentDisplayOptions(totalHours, hourlyRate, displayOptions);
	const { showHours, showCost } = resolvedDisplayOptions;
	const exportHourlyRate = resolveExportHourlyRate(hourlyRate);
	const totalAmount = rows.reduce((sum, row) => sum + calculateExportRowAmount(row.hours, exportHourlyRate), 0);
	const formattedHourlyRate = formatStatisticsExportNumber(exportHourlyRate, locale);
	const formattedTotalHours = formatStatisticsExportNumber(totalHours, locale);
	const formattedTotalAmount = formatStatisticsExportNumber(totalAmount, locale);
	const labels = buildLabels(locale, formattedTotalHours, formattedHourlyRate, resolvedDisplayOptions);
	const formattedDate = buildFormattedDate(locale, labels.isRu);
	const tableRows = rows.map((row, index) => {
		const zebraClass = index % 2 === 0 ? 'pm-stats-export-row-even' : 'pm-stats-export-row-odd';
		const amount = formatStatisticsExportNumber(calculateExportRowAmount(row.hours, exportHourlyRate), locale);
		return [
			`<tr class="${zebraClass}">`,
			`<td class="pm-stats-export-col-task">${escapeHtml(row.taskNumber || '—')}</td>`,
			`<td class="pm-stats-export-col-title">${escapeHtml(row.title)}</td>`,
			...(includeReport ? [`<td class="pm-stats-export-col-report">${escapeHtml(row.reportSummary || '—')}</td>`] : []),
			...(showHours ? [`<td class="pm-stats-export-col-hours">${escapeHtml(formatStatisticsExportNumber(row.hours, locale))}</td>`] : []),
			...(showCost ? [`<td class="pm-stats-export-col-amount">${escapeHtml(amount)}</td>`] : []),
			'</tr>',
		].join('');
	}).join('\n');
	const metaCards = [
		`<div class="pm-stats-export-meta-card">
			<span class="pm-stats-export-meta-label">${escapeHtml(labels.generated)}</span>
			<span class="pm-stats-export-meta-value">${escapeHtml(formattedDate)}</span>
		</div>`,
		`<div class="pm-stats-export-meta-card">
			<span class="pm-stats-export-meta-label">${escapeHtml(labels.count)}</span>
			<span class="pm-stats-export-meta-value">${rows.length}</span>
		</div>`,
	];

	if (showHours) {
		metaCards.push(`
			<div class="pm-stats-export-meta-card">
				<span class="pm-stats-export-meta-label">${escapeHtml(labels.total)}</span>
				<span class="pm-stats-export-meta-value">${escapeHtml(formattedTotalHours)}</span>
			</div>
		`.trim());
	}

	if (showCost) {
		metaCards.push(`
			<div class="pm-stats-export-meta-card">
				<span class="pm-stats-export-meta-label">${escapeHtml(labels.rate)}</span>
				<span class="pm-stats-export-meta-value">${escapeHtml(formattedHourlyRate)}</span>
			</div>
		`.trim());
		metaCards.push(`
			<div class="pm-stats-export-meta-card">
				<span class="pm-stats-export-meta-label">${escapeHtml(labels.totalAmount)}</span>
				<span class="pm-stats-export-meta-value">${escapeHtml(formattedTotalAmount)}</span>
			</div>
		`.trim());
	}

	const footerRow = showHours || showCost
		? `
			<tfoot>
				<tr>
					<td colspan="${includeReport ? '3' : '2'}">${escapeHtml(labels.total)}</td>
					${showHours ? `<td class="pm-stats-export-col-hours">${escapeHtml(formattedTotalHours)}</td>` : ''}
					${showCost ? `<td class="pm-stats-export-col-amount">${escapeHtml(formattedTotalAmount)}</td>` : ''}
				</tr>
			</tfoot>
		`.trim()
		: '';

	return {
		lang: labels.lang,
		title: labels.title,
		markup: `
			<div class="pm-stats-export-page">
				<div class="pm-stats-export-container">
					<header class="pm-stats-export-header">
						<div class="pm-stats-export-kicker">Prompt Manager</div>
						<h1 class="pm-stats-export-title">${escapeHtml(labels.title)}</h1>
						<p class="pm-stats-export-subtitle">${escapeHtml(labels.subtitle)}</p>
					</header>
					<section class="pm-stats-export-meta">
						${metaCards.join('\n')}
					</section>
					<section class="pm-stats-export-table-wrap">
						<table class="pm-stats-export-table">
							<thead>
								<tr>
									<th>${escapeHtml(labels.taskNumber)}</th>
									<th>${escapeHtml(labels.name)}</th>
									${includeReport ? `<th>${escapeHtml(labels.report)}</th>` : ''}
									${showHours ? `<th class="pm-stats-export-col-hours-head">${escapeHtml(labels.hours)}</th>` : ''}
									${showCost ? `<th class="pm-stats-export-col-amount-head">${escapeHtml(labels.amount)}</th>` : ''}
								</tr>
							</thead>
							<tbody>
								${tableRows}
							</tbody>
							${footerRow}
						</table>
					</section>
					<div class="pm-stats-export-footer">${escapeHtml(labels.footer)}</div>
				</div>
			</div>
		`.trim(),
	};
}

function escapeMarkdownCell(value: string): string {
	return value
		.replace(/\|/g, '\\|')
		.replace(/\r?\n/g, ' ')
		.trim();
}

function padMarkdownCell(value: string, width: number, align: 'left' | 'right' = 'left'): string {
	return align === 'right' ? value.padStart(width, ' ') : value.padEnd(width, ' ');
}

export function buildStatisticsExportHtmlDocument(
	rows: StatisticsExportDocumentRow[],
	totalHours: number,
	locale: string,
	includeReport: boolean,
	hourlyRate: number,
	displayOptions?: StatisticsExportDisplayOptions,
): string {
	const { lang, title, markup } = buildStatisticsDocumentMarkup(rows, totalHours, locale, includeReport, hourlyRate, displayOptions);
	const styles = buildStatisticsDocumentStyles();
	return `<!DOCTYPE html>
<html lang="${lang}">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>${escapeHtml(title)}</title>
	<style>${styles}</style>
</head>
<body style="margin:0">
	${markup}
</body>
</html>`;
}

export function buildStatisticsExportHtmlPreview(
	rows: StatisticsExportDocumentRow[],
	totalHours: number,
	locale: string,
	includeReport: boolean,
	hourlyRate: number,
	displayOptions?: StatisticsExportDisplayOptions,
): string {
	const { markup } = buildStatisticsDocumentMarkup(rows, totalHours, locale, includeReport, hourlyRate, displayOptions);
	return `<style>${buildStatisticsDocumentStyles()}</style>${markup}`;
}

export function buildStatisticsExportMarkdownDocument(
	rows: StatisticsExportDocumentRow[],
	totalHours: number,
	locale: string,
	includeReport: boolean,
	hourlyRate: number,
	displayOptions?: StatisticsExportDisplayOptions,
): string {
	const resolvedDisplayOptions = resolveStatisticsDocumentDisplayOptions(totalHours, hourlyRate, displayOptions);
	const { showHours, showCost } = resolvedDisplayOptions;
	const exportHourlyRate = resolveExportHourlyRate(hourlyRate);
	const formattedTotalHours = formatStatisticsExportNumber(totalHours, locale);
	const formattedHourlyRate = formatStatisticsExportNumber(exportHourlyRate, locale);
	const totalAmount = rows.reduce((sum, row) => sum + calculateExportRowAmount(row.hours, exportHourlyRate), 0);
	const formattedTotalAmount = formatStatisticsExportNumber(totalAmount, locale);

	if (includeReport) {
		return buildStatisticsMarkdownWithReport(rows, totalHours, exportHourlyRate, locale, resolvedDisplayOptions);
	}

	const isRu = locale.toLowerCase().startsWith('ru');
	const title = isRu ? '# Отчёт по статистике' : '# Statistics Report';
	const generatedLabel = isRu ? 'Сформировано' : 'Generated';
	const totalLabel = isRu ? 'Итого часов' : 'Total hours';
	const hourlyRateLabel = isRu ? 'Ставка часа' : 'Hourly rate';
	const totalAmountLabel = isRu ? 'Итоговая сумма' : 'Total amount';
	const taskNumberLabel = isRu ? '№ задачи' : 'Task #';
	const titleLabel = isRu ? 'Название' : 'Title';
	const hoursLabel = isRu ? 'Часы' : 'Hours';
	const amountLabel = isRu ? 'Сумма' : 'Amount';
	const formattedDate = buildFormattedDate(locale, isRu);
	const summaryLines = [`- ${generatedLabel}: ${formattedDate}`];

	if (showHours) {
		summaryLines.push(`- ${totalLabel}: ${formattedTotalHours}`);
	}

	if (showCost) {
		summaryLines.push(`- ${hourlyRateLabel}: ${formattedHourlyRate}`);
		summaryLines.push(`- ${totalAmountLabel}: ${formattedTotalAmount}`);
	}

	const tableRows = rows.map((row) => ({
		taskNumber: escapeMarkdownCell(row.taskNumber || '—'),
		title: escapeMarkdownCell(row.title),
		hours: formatStatisticsExportNumber(row.hours, locale),
		amount: formatStatisticsExportNumber(calculateExportRowAmount(row.hours, exportHourlyRate), locale),
	}));
	const totalTaskLabel = `**${isRu ? 'Итого' : 'Total'}**`;
	const totalHoursLabel = `**${formattedTotalHours}**`;
	const totalAmountRowLabel = `**${formattedTotalAmount}**`;
	const columns: Array<{
		key: 'taskNumber' | 'title' | 'hours' | 'amount';
		label: string;
		align: 'left' | 'right';
		totalValue: string;
	}> = [
			{ key: 'taskNumber', label: taskNumberLabel, align: 'left', totalValue: totalTaskLabel },
			{ key: 'title', label: titleLabel, align: 'left', totalValue: '' },
			...(showHours ? [{ key: 'hours', label: hoursLabel, align: 'right', totalValue: totalHoursLabel } as const] : []),
			...(showCost ? [{ key: 'amount', label: amountLabel, align: 'right', totalValue: totalAmountRowLabel } as const] : []),
		];
	const widths = Object.fromEntries(columns.map((column) => [
		column.key,
		Math.max(
			column.label.length,
			column.totalValue.length,
			...tableRows.map((row) => String(row[column.key] || '').length),
		),
	])) as Record<'taskNumber' | 'title' | 'hours' | 'amount', number>;
	const formatMarkdownRow = (row: Record<'taskNumber' | 'title' | 'hours' | 'amount', string>): string => (
		`| ${columns.map((column) => padMarkdownCell(String(row[column.key] || ''), widths[column.key], column.align)).join(' | ')} |`
	);
	const separator = `| ${columns.map((column) => (
		column.align === 'right'
			? `${'-'.repeat(Math.max(3, widths[column.key] - 1))}:`
			: `${'-'.repeat(widths[column.key])}`
	)).join(' | ')} |`;
	const header = formatMarkdownRow({
		taskNumber: taskNumberLabel,
		title: titleLabel,
		hours: hoursLabel,
		amount: amountLabel,
	});
	const bodyRows = tableRows.map((row) => formatMarkdownRow({
		taskNumber: row.taskNumber,
		title: row.title,
		hours: row.hours,
		amount: row.amount,
	})).join('\n');
	const totalRow = (showHours || showCost)
		? formatMarkdownRow({
			taskNumber: totalTaskLabel,
			title: '',
			hours: totalHoursLabel,
			amount: totalAmountRowLabel,
		})
		: '';
	const wordSection = buildStatisticsWordSection(rows, exportHourlyRate, locale, resolvedDisplayOptions);

	return [
		title,
		'',
		...summaryLines,
		'',
		header,
		separator,
		bodyRows,
		...(totalRow ? [totalRow] : []),
		'',
		wordSection,
	].join('\n') + '\n';
}
