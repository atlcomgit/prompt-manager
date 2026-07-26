/**
 * Statistics Panel Manager — opens a webview panel with prompt statistics
 */

import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import type { StorageService } from '../services/storageService.js';
import type { StateService } from '../services/stateService.js';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../types/messages.js';
import {
	buildStatisticsExportHtmlDocument,
	buildStatisticsExportMarkdownDocument,
	type StatisticsExportDocumentRow,
} from '../utils/statisticsDocumentTemplate.js';
import type { StatisticsExportDisplayOptions, StatisticsExportPeriodRange } from '../utils/statisticsExport.js';
import {
	createStatisticsXlsxBuffer,
	type StatisticsXlsxExportRow,
} from '../utils/statisticsXlsxExport.js';

let currentPanel: vscode.WebviewPanel | undefined;
const ALLOWED_EXPORT_STATUSES = new Set([
	'draft',
	'in-progress',
	'stopped',
	'cancelled',
	'completed',
	'report',
	'review',
	'closed',
] as const);
/** Maximum row count accepted from a statistics webview export message. */
const MAX_STATISTICS_XLSX_EXPORT_ROWS = 5_000;
/** Conservative text limit used to bound workbook memory for untrusted webview payloads. */
const MAX_STATISTICS_XLSX_CELL_TEXT_LENGTH = 4_096;

function normalizeExportRows(rows: unknown): StatisticsExportDocumentRow[] {
	if (!Array.isArray(rows)) {
		return [];
	}

	return rows.map((row) => {
		const candidate = row as Record<string, unknown>;
		const taskNumber = typeof candidate.taskNumber === 'string' ? candidate.taskNumber : '';
		const title = typeof candidate.title === 'string' ? candidate.title : '';
		const reportSummary = typeof candidate.reportSummary === 'string' ? candidate.reportSummary : '';
		const hoursValue = typeof candidate.hours === 'number' ? candidate.hours : Number(candidate.hours);
		const normalizedHours = Number.isFinite(hoursValue) && hoursValue >= 0 ? hoursValue : 0;
		const status = typeof candidate.status === 'string' && ALLOWED_EXPORT_STATUSES.has(candidate.status as never)
			? candidate.status as StatisticsExportDocumentRow['status']
			: undefined;

		return {
			taskNumber,
			title,
			hours: normalizedHours,
			status,
			reportSummary,
		};
	}).filter((row) => row.title.trim().length > 0 || row.taskNumber.trim().length > 0 || row.hours > 0);
}

/** Normalize a duration payload to finite non-negative milliseconds. */
function normalizeXlsxDuration(value: unknown): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Normalize text payloads to the maximum supported Excel cell length. */
function normalizeXlsxText(value: unknown): string {
	return typeof value === 'string' ? value.slice(0, MAX_STATISTICS_XLSX_CELL_TEXT_LENGTH) : '';
}

/** Normalize untrusted webview rows before creating a statistics XLSX workbook. */
function normalizeXlsxRows(rows: unknown): StatisticsXlsxExportRow[] {
	if (!Array.isArray(rows)) {
		return [];
	}

	return rows.slice(0, MAX_STATISTICS_XLSX_EXPORT_ROWS).map((row) => {
		const candidate = row && typeof row === 'object' ? row as Record<string, unknown> : {};
		const timeWriting = normalizeXlsxDuration(candidate.timeWriting);
		const timeImplementing = normalizeXlsxDuration(candidate.timeImplementing);
		const timeOnTask = normalizeXlsxDuration(candidate.timeOnTask);
		const timeUntracked = normalizeXlsxDuration(candidate.timeUntracked);
		const status = typeof candidate.status === 'string' && ALLOWED_EXPORT_STATUSES.has(candidate.status as never)
			? candidate.status as StatisticsXlsxExportRow['status']
			: 'draft';

		return {
			taskNumber: normalizeXlsxText(candidate.taskNumber),
			title: normalizeXlsxText(candidate.title),
			status,
			timeWriting,
			timeImplementing,
			timeOnTask,
			timeUntracked,
			totalTime: timeWriting + timeImplementing + timeOnTask + timeUntracked,
		};
	}).filter(row => row.title.trim().length > 0 || row.taskNumber.trim().length > 0 || row.totalTime > 0);
}

/** Build the default XLSX file name for the current local date. */
function buildStatisticsXlsxFileName(): string {
	const now = new Date();
	const year = String(now.getFullYear());
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `prompt-statistics-${year}-${month}-${day}.xlsx`;
}

/** Normalize an optional export period before forwarding it to document builders. */
function normalizeExportPeriod(period: unknown): StatisticsExportPeriodRange | undefined {
	if (!period || typeof period !== 'object') {
		return undefined;
	}

	const candidate = period as Record<string, unknown>;
	const dateFrom = typeof candidate.dateFrom === 'string' ? candidate.dateFrom : '';
	const dateTo = typeof candidate.dateTo === 'string' ? candidate.dateTo : '';
	return dateFrom && dateTo ? { dateFrom, dateTo } : undefined;
}

/** Open generated statistics export content in a regular VS Code document. */
async function openExportDocument(content: string, language: 'html' | 'markdown'): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({ content, language });
	await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

export class StatisticsPanelManager {
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly storageService: StorageService,
		private readonly stateService: StateService,
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
			if (msg.type === 'getStatisticsUiState') {
				const state = this.stateService.getStatisticsUiState();
				const response: ExtensionToWebviewMessage = {
					type: 'statisticsUiState',
					hourlyRateInput: state.hourlyRateInput,
				};
				panel.webview.postMessage(response);
			}
			if (msg.type === 'saveStatisticsUiState') {
				await this.stateService.saveStatisticsUiState({ hourlyRateInput: msg.hourlyRateInput });
			}
			if (msg.type === 'exportReport') {
				const rows = normalizeExportRows(msg.rows);
				const total = rows.reduce((sum, row) => sum + row.hours, 0);
				// Invalid or missing rates must keep amount columns disabled instead of reaching document builders.
				const hourlyRate = typeof msg.hourlyRate === 'number' && Number.isFinite(msg.hourlyRate)
					? msg.hourlyRate
					: 0;
				const displayOptions: StatisticsExportDisplayOptions = {
					showHours: typeof msg.showHours === 'boolean' ? msg.showHours : undefined,
					showCost: typeof msg.showCost === 'boolean' ? msg.showCost : undefined,
					hoursMode: msg.hoursMode === 'actual' || msg.hoursMode === 'scaled' ? msg.hoursMode : undefined,
					period: normalizeExportPeriod(msg.period),
				};
				const content = msg.format === 'md'
					? buildStatisticsExportMarkdownDocument(
						rows,
						total,
						vscode.env.language,
						Boolean(msg.includeReport),
						hourlyRate,
						displayOptions,
					)
					: buildStatisticsExportHtmlDocument(
						rows,
						total,
						vscode.env.language,
						Boolean(msg.includeReport),
						hourlyRate,
						displayOptions,
					);
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
			if (msg.type === 'exportStatisticsXlsx') {
				const rows = normalizeXlsxRows(msg.rows);
				if (rows.length === 0) {
					return;
				}

				try {
					const fileName = buildStatisticsXlsxFileName();
					const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
					const defaultUri = workspaceFolder ? vscode.Uri.joinPath(workspaceFolder.uri, fileName) : undefined;
					const targetUri = await vscode.window.showSaveDialog({
						defaultUri,
						filters: { 'Excel workbook': ['xlsx'] },
						saveLabel: vscode.env.language.toLowerCase().startsWith('ru') ? 'Сохранить Excel' : 'Save Excel',
					});

					if (!targetUri) {
						return;
					}

					const workbook = await createStatisticsXlsxBuffer(rows, vscode.env.language);
					await vscode.workspace.fs.writeFile(targetUri, workbook);
					vscode.window.showInformationMessage(
						vscode.env.language.toLowerCase().startsWith('ru')
							? `Excel-файл сохранён: ${targetUri.fsPath}`
							: `Excel file saved: ${targetUri.fsPath}`,
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(
						vscode.env.language.toLowerCase().startsWith('ru')
							? `Не удалось сохранить Excel-файл: ${message}`
							: `Failed to save Excel file: ${message}`,
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
