/**
 * Statistics Panel Manager — opens a webview panel with prompt statistics
 */

import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import type { StorageService } from '../services/storageService.js';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../types/messages.js';

let currentPanel: vscode.WebviewPanel | undefined;

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
				// Open a new untitled text document with the report
				const lines = msg.rows.map(r => `${r.taskNumber}\t${r.title}\t${r.hours}`);
				const header = '№ задачи\tНазвание\tЧасы';
				const total = msg.rows.reduce((s, r) => s + r.hours, 0);
				const content = [header, ...lines, '', `Итого\t\t${total}`].join('\n');
				const doc = await vscode.workspace.openTextDocument({ content, language: 'plaintext' });
				await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
			}
		});
	}

	dispose(): void {
		currentPanel?.dispose();
		currentPanel = undefined;
	}
}
