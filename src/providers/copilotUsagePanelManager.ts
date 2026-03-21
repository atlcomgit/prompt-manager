/**
 * Copilot Usage Panel Manager — отдельная webview-страница
 * с детальной статистикой использования Copilot Premium.
 */

import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import type { CopilotUsageAccountSummary, CopilotUsageService } from '../services/copilotUsageService.js';

let currentPanel: vscode.WebviewPanel | undefined;
let panelRefreshTimer: ReturnType<typeof setInterval> | undefined;
const PANEL_REFRESH_INTERVAL_MS = 30 * 1000;

export class CopilotUsagePanelManager {
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly usageService: CopilotUsageService,
	) { }

	async show(): Promise<void> {
		if (currentPanel) {
			currentPanel.reveal(vscode.ViewColumn.One);
			await this.pushUsageToWebview(currentPanel.webview, false);
			this.startPanelRefresh(currentPanel.webview);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'promptManager.copilotUsage',
			'Copilot Premium Usage',
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
			'dist/webview/copilotUsage.js',
			'Copilot Premium Usage',
			vscode.env.language,
		);

		currentPanel = panel;

		panel.onDidDispose(() => {
			this.stopPanelRefresh();
			currentPanel = undefined;
		});

		panel.webview.onDidReceiveMessage(async (msg: any) => {
			if (!msg || typeof msg !== 'object') {
				return;
			}

			if (msg.type === 'copilotUsage.ready') {
				await this.pushUsageToWebview(panel.webview, false);
				return;
			}

			if (msg.type === 'copilotUsage.refresh') {
				await this.pushUsageToWebview(panel.webview, true);
				await panel.webview.postMessage({ type: 'copilotUsage.refreshed', at: new Date().toISOString() });
				return;
			}

			if (msg.type === 'copilotUsage.auth') {
				await this.usageService.authenticate();
				await this.pushUsageToWebview(panel.webview, true);
				return;
			}

			if (msg.type === 'copilotUsage.switchAccount') {
				// switchCopilotChatAccountInteractively открывает пикер VS Code для Copilot Chat,
				// затем синхронизирует расширение. Статусбар показывает спиннер через событие сервиса.
				const result = await this.usageService.switchCopilotChatAccountInteractively();

				if (result.changed) {
					// Показываем overlay пока обновляются данные
					await panel.webview.postMessage({ type: 'copilotUsage.accountSwitching', isSwitching: true });
					// Обновляем данные для нового аккаунта
					await this.pushUsageToWebview(panel.webview, true);
					// Показываем результат
					await panel.webview.postMessage({ type: 'copilotUsage.accountSwitchResult', result });
					// Даём webview отрисовать новые данные
					await new Promise(resolve => setTimeout(resolve, 800));
				} else {
					await panel.webview.postMessage({ type: 'copilotUsage.accountSwitchResult', result });
				}
				// Сбрасываем статус переключения — статусбар и overlay обновятся одновременно
				this.usageService.endAccountSwitching();
				await panel.webview.postMessage({ type: 'copilotUsage.accountSwitching', isSwitching: false });
				return;
			}

			if (msg.type === 'copilotUsage.openSettings') {
				await vscode.commands.executeCommand('workbench.action.openSettings', 'promptManager.copilot');
				return;
			}

			if (msg.type === 'copilotUsage.openGitHub') {
				await vscode.env.openExternal(vscode.Uri.parse('https://github.com/settings/copilot'));
			}
		});

		await this.pushUsageToWebview(panel.webview, false);
		this.startPanelRefresh(panel.webview);
	}

	private startPanelRefresh(webview: vscode.Webview): void {
		this.stopPanelRefresh();
		panelRefreshTimer = setInterval(() => {
			void this.pushUsageToWebview(webview, false);
		}, PANEL_REFRESH_INTERVAL_MS);
	}

	private stopPanelRefresh(): void {
		if (panelRefreshTimer) {
			clearInterval(panelRefreshTimer);
			panelRefreshTimer = undefined;
		}
	}

	private async pushUsageToWebview(webview: vscode.Webview, forceRefresh: boolean): Promise<void> {
		const [usage, accountSummary] = await Promise.all([
			this.usageService.fetchUsage(forceRefresh),
			this.usageService.getAccountBindingSummary(),
		]);
		const debugLog = this.usageService.getLastDebugLog();
		const now = new Date();
		const start = new Date(usage.periodStart);
		const end = new Date(usage.periodEnd);
		const daysPassed = Math.max(1, Math.ceil((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
		const daysRemaining = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
		const percent = usage.limit > 0 ? (usage.used / usage.limit) * 100 : 0;
		const remaining = Math.max(0, usage.limit - usage.used);
		const recommendedPerDay = daysRemaining > 0 ? Math.round((remaining / daysRemaining) * 10) / 10 : 0;

		const timeline = usage.snapshots.length > 0
			? usage.snapshots
			: [{ date: new Date().toISOString().slice(0, 10), used: usage.used, limit: usage.limit }];

		await webview.postMessage({
			type: 'copilotUsage.data',
			data: {
				...usage,
				...this.buildAccountSummaryPayload(accountSummary),
				debugLog,
				percent,
				remaining,
				daysPassed,
				daysRemaining,
				recommendedPerDay,
				timeline,
			},
		});
	}

	private buildAccountSummaryPayload(accountSummary: CopilotUsageAccountSummary): Record<string, unknown> {
		return {
			copilotPreferredGitHubLabel: accountSummary.copilotPreferredGitHubLabel,
			promptManagerPreferredGitHubLabel: accountSummary.promptManagerPreferredGitHubLabel,
			activeGithubSessionAccountLabel: accountSummary.activeGithubSessionAccountLabel,
			githubSessionIssue: accountSummary.githubSessionIssue,
			availableGitHubAccounts: accountSummary.availableGitHubAccounts,
		};
	}

	dispose(): void {
		this.stopPanelRefresh();
		currentPanel?.dispose();
		currentPanel = undefined;
	}
}
