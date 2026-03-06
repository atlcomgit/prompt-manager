/**
 * Statistics Panel Manager — opens a webview panel with prompt statistics
 */

import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import type { StorageService } from '../services/storageService.js';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../types/messages.js';

let currentPanel: vscode.WebviewPanel | undefined;

interface ExportReportRow {
	taskNumber: string;
	title: string;
	hours: number;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function buildExportHtml(rows: ExportReportRow[], totalHours: number, locale: string): string {
	const isRu = locale.toLowerCase().startsWith('ru');
	const labels = {
		title: isRu ? 'Отчёт по статистике' : 'Statistics Report',
		subtitle: isRu ? 'Сводный отчёт с пропорциональным распределением до 165 часов' : 'Summary report with proportional distribution to 165 hours',
		generated: isRu ? 'Сформировано' : 'Generated',
		total: isRu ? 'Итого часов' : 'Total hours',
		count: isRu ? 'Задач в отчёте' : 'Tasks in report',
		taskNumber: isRu ? '№ задачи' : 'Task #',
		name: isRu ? 'Название' : 'Title',
		hours: isRu ? 'Часы' : 'Hours',
	};
	const formattedDate = new Date().toLocaleString(isRu ? 'ru-RU' : 'en-US', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	});
	const tableRows = rows.map((row, index) => {
		const zebraClass = index % 2 === 0 ? 'row-even' : 'row-odd';
		return [
			`<tr class="${zebraClass}">`,
			`<td class="col-task">${escapeHtml(row.taskNumber || '—')}</td>`,
			`<td class="col-title">${escapeHtml(row.title)}</td>`,
			`<td class="col-hours">${row.hours}</td>`,
			'</tr>',
		].join('');
	}).join('\n');

	return `<!DOCTYPE html>
<html lang="${isRu ? 'ru' : 'en'}">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>${escapeHtml(labels.title)}</title>
	<style>
		:root {
			color-scheme: light;
			--bg: #f4f6f8;
			--panel: #ffffff;
			--panel-muted: #fafbfc;
			--border: #d8dee4;
			--border-strong: #c7d0d9;
			--text: #1f2933;
			--muted: #5b6773;
			--accent: #0f766e;
		}

		* {
			box-sizing: border-box;
		}

		body {
			margin: 0;
			padding: 32px;
			font-family: "Segoe UI", "Noto Sans", sans-serif;
			background: var(--bg);
			color: var(--text);
		}

		.container {
			max-width: 1120px;
			margin: 0 auto;
			background: var(--panel);
			border: 1px solid var(--border);
			border-radius: 12px;
			box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
			overflow: hidden;
		}

		.header {
			padding: 32px 36px 24px;
			background: var(--panel-muted);
			border-bottom: 1px solid var(--border);
		}

		.kicker {
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

		h1 {
			margin: 18px 0 8px;
			font-size: 32px;
			line-height: 1.15;
			letter-spacing: -0.02em;
		}

		.subtitle {
			margin: 0;
			font-size: 15px;
			line-height: 1.5;
			color: var(--muted);
		}

		.meta {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 12px;
			padding: 24px 36px 0;
		}

		.meta-card {
			padding: 18px 20px;
			border-radius: 10px;
			background: var(--panel);
			border: 1px solid var(--border);
		}

		.meta-label {
			display: block;
			font-size: 12px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--muted);
			margin-bottom: 8px;
		}

		.meta-value {
			display: block;
			font-size: 28px;
			font-weight: 700;
		}

		.table-wrap {
			padding: 24px 36px 36px;
		}

		table {
			width: 100%;
			border-collapse: separate;
			border-spacing: 0;
			background: var(--panel);
			border: 1px solid var(--border);
			border-radius: 10px;
			overflow: hidden;
		}

		thead th {
			padding: 18px 20px;
			text-align: left;
			font-size: 13px;
			font-weight: 700;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			background: #f8fafc;
			border-bottom: 1px solid var(--border-strong);
		}

		tbody td,
		tfoot td {
			padding: 18px 20px;
			border-bottom: 1px solid var(--border);
			vertical-align: top;
		}

		tbody tr:last-child td {
			border-bottom: none;
		}

		.row-even {
			background: #ffffff;
		}

		.row-odd {
			background: #fbfcfd;
		}

		.col-task {
			width: 140px;
			font-weight: 700;
			white-space: nowrap;
			color: var(--accent);
		}

		.col-title {
			width: auto;
		}

		.col-hours {
			width: 120px;
			text-align: right;
			font-weight: 700;
		}

		tfoot td {
			background: #f8fafc;
			font-weight: 700;
			border-top: 1px solid var(--border-strong);
			border-bottom: none;
		}

		.footer-note {
			padding: 0 36px 32px;
			font-size: 13px;
			color: var(--muted);
		}

		@media (max-width: 800px) {
			body {
				padding: 16px;
			}

			.header,
			.table-wrap,
			.footer-note,
			.meta {
				padding-left: 18px;
				padding-right: 18px;
			}

			.meta {
				grid-template-columns: 1fr;
			}

			h1 {
				font-size: 28px;
			}

			table,
			thead,
			tbody,
			tfoot,
			tr,
			th,
			td {
				display: block;
			}

			thead {
				display: none;
			}

			tbody tr,
			tfoot tr {
				border-bottom: 1px solid var(--border);
			}

			tbody td,
			tfoot td {
				padding: 10px 14px;
				text-align: left;
			}

			.col-hours {
				text-align: left;
			}
		}
	</style>
</head>
<body>
	<div class="container">
		<header class="header">
			<div class="kicker">Prompt Manager</div>
			<h1>${escapeHtml(labels.title)}</h1>
			<p class="subtitle">${escapeHtml(labels.subtitle)}</p>
		</header>
		<section class="meta">
			<div class="meta-card">
				<span class="meta-label">${escapeHtml(labels.generated)}</span>
				<span class="meta-value">${escapeHtml(formattedDate)}</span>
			</div>
			<div class="meta-card">
				<span class="meta-label">${escapeHtml(labels.count)}</span>
				<span class="meta-value">${rows.length}</span>
			</div>
			<div class="meta-card">
				<span class="meta-label">${escapeHtml(labels.total)}</span>
				<span class="meta-value">${totalHours}</span>
			</div>
		</section>
		<section class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>${escapeHtml(labels.taskNumber)}</th>
						<th>${escapeHtml(labels.name)}</th>
						<th style="text-align: right;">${escapeHtml(labels.hours)}</th>
					</tr>
				</thead>
				<tbody>
					${tableRows}
				</tbody>
				<tfoot>
					<tr>
						<td colspan="2">${escapeHtml(labels.total)}</td>
						<td class="col-hours">${totalHours}</td>
					</tr>
				</tfoot>
			</table>
		</section>
		<div class="footer-note">Prompt Manager • HTML export</div>
	</div>
</body>
</html>`;
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

function buildExportMarkdown(rows: ExportReportRow[], totalHours: number, locale: string): string {
	const isRu = locale.toLowerCase().startsWith('ru');
	const title = isRu ? '# Отчёт по статистике' : '# Statistics Report';
	const generatedLabel = isRu ? 'Сформировано' : 'Generated';
	const totalLabel = isRu ? 'Итого часов' : 'Total hours';
	const taskNumberLabel = isRu ? '№ задачи' : 'Task #';
	const titleLabel = isRu ? 'Название' : 'Title';
	const hoursLabel = isRu ? 'Часы' : 'Hours';
	const formattedDate = new Date().toLocaleString(isRu ? 'ru-RU' : 'en-US', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	});
	const tableRows = rows.map((row) => ({
		taskNumber: escapeMarkdownCell(row.taskNumber || '—'),
		title: escapeMarkdownCell(row.title),
		hours: String(row.hours),
	}));
	const totalTaskLabel = `**${isRu ? 'Итого' : 'Total'}**`;
	const totalHoursLabel = `**${totalHours}**`;
	const taskNumberWidth = Math.max(
		taskNumberLabel.length,
		totalTaskLabel.length,
		...tableRows.map((row) => row.taskNumber.length),
	);
	const titleWidth = Math.max(
		titleLabel.length,
		...tableRows.map((row) => row.title.length),
	);
	const hoursWidth = Math.max(
		hoursLabel.length,
		totalHoursLabel.length,
		...tableRows.map((row) => row.hours.length),
	);
	const separator = `| ${'-'.repeat(taskNumberWidth)} | ${'-'.repeat(titleWidth)} | ${'-'.repeat(Math.max(3, hoursWidth - 1))}: |`;
	const header = `| ${padMarkdownCell(taskNumberLabel, taskNumberWidth)} | ${padMarkdownCell(titleLabel, titleWidth)} | ${padMarkdownCell(hoursLabel, hoursWidth, 'right')} |`;
	const bodyRows = tableRows
		.map((row) => `| ${padMarkdownCell(row.taskNumber, taskNumberWidth)} | ${padMarkdownCell(row.title, titleWidth)} | ${padMarkdownCell(row.hours, hoursWidth, 'right')} |`)
		.join('\n');
	const totalRow = `| ${padMarkdownCell(totalTaskLabel, taskNumberWidth)} | ${padMarkdownCell('', titleWidth)} | ${padMarkdownCell(totalHoursLabel, hoursWidth, 'right')} |`;

	return [
		title,
		'',
		`- ${generatedLabel}: ${formattedDate}`,
		`- ${totalLabel}: ${totalHours}`,
		'',
		header,
		separator,
		bodyRows,
		totalRow,
	].join('\n') + '\n';
}

async function openExportDocument(content: string, language: 'html' | 'markdown'): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({ content, language });
	await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

export class StatisticsPanelManager {
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly storageService: StorageService,
	) { }

	/** Open or focus the statistics panel */
	async show(): Promise<void> {
		if (currentPanel) {
			currentPanel.reveal();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'promptManager.statistics',
			'📊 Статистика промптов',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [this.extensionUri],
			}
		);

		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar-icon.svg');

		panel.webview.html = getWebviewHtml(
			panel.webview,
			this.extensionUri,
			'dist/webview/statistics.js',
			'Prompt Statistics',
			vscode.env.language
		);

		currentPanel = panel;

		panel.onDidDispose(() => {
			currentPanel = undefined;
		});

		panel.webview.onDidReceiveMessage(async (msg: WebviewToExtensionMessage) => {
			if (msg.type === 'getStatistics') {
				const filter = (msg.dateFrom || msg.dateTo || msg.minFiveMin)
					? { dateFrom: msg.dateFrom, dateTo: msg.dateTo, minFiveMin: msg.minFiveMin }
					: undefined;
				const stats = await this.storageService.getStatistics(filter);
				const response: ExtensionToWebviewMessage = { type: 'statistics', data: stats };
				panel.webview.postMessage(response);
			}
			if (msg.type === 'exportReport') {
				const total = msg.rows.reduce((sum, row) => sum + row.hours, 0);
				const content = msg.format === 'md'
					? buildExportMarkdown(msg.rows, total, vscode.env.language)
					: buildExportHtml(msg.rows, total, vscode.env.language);
				try {
					await openExportDocument(content, msg.format === 'md' ? 'markdown' : 'html');
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(
						vscode.env.language.toLowerCase().startsWith('ru')
							? `Не удалось открыть отчёт: ${message}`
							: `Failed to open report: ${message}`
					);
				}
			}
		});
	}

	dispose(): void {
		currentPanel?.dispose();
		currentPanel = undefined;
	}
}
