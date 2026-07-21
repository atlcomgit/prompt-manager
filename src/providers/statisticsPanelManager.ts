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
		});
	}

	dispose(): void {
		currentPanel?.dispose();
		currentPanel = undefined;
	}
}
