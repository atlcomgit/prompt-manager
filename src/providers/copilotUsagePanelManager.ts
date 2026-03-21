/**
 * Copilot Usage Panel Manager — отдельная webview-страница
 * с детальной статистикой использования Copilot Premium.
 */

import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import type { CopilotUsageAccountSummary, CopilotUsageService, CopilotUsageSnapshot } from '../services/copilotUsageService.js';
import { appendPromptManagerLog } from '../utils/promptManagerOutput.js';

let currentPanel: vscode.WebviewPanel | undefined;
let panelRefreshTimer: ReturnType<typeof setInterval> | undefined;
const PANEL_REFRESH_INTERVAL_MS = 30 * 1000;

export class CopilotUsagePanelManager {
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly usageService: CopilotUsageService,
	) {
		this.disposables.push(
			this.usageService.onDidChangeAccountSwitchState((state) => {
				if (!currentPanel) {
					return;
				}
				void currentPanel.webview.postMessage({ type: 'copilotUsage.accountSwitching', state });
			}),
		);
	}

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
				appendPromptManagerLog(`[${new Date().toISOString()}] [panel] switch account requested from Copilot Premium Usage page`);
				const result = await this.usageService.switchCopilotChatAccountInteractively();

				if (!result.changed) {
					appendPromptManagerLog(
						`[${new Date().toISOString()}] [panel] switch account finished without change cancelled=${result.cancelled ? 'true' : 'false'} message=${result.message}`,
					);
					if (!result.cancelled) {
						await panel.webview.postMessage({ type: 'copilotUsage.accountSwitchResult', result });
					}
					return;
				}

				this.stopPanelRefresh();
				try {
					const completion = await this.usageService.completeAccountSwitch(result.accountLabel || '');
					await this.pushUsageToWebview(panel.webview, false, completion);
					await panel.webview.postMessage({
						type: 'copilotUsage.accountSwitchResult',
						result: {
							changed: true,
							message: completion.message,
							accountLabel: completion.accountLabel,
						},
					});
					appendPromptManagerLog(
						`[${new Date().toISOString()}] [panel] switch account completed for ${completion.accountLabel}`,
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					appendPromptManagerLog(`[${new Date().toISOString()}] [panel] switch account failed: ${message}`);
					await panel.webview.postMessage({
						type: 'copilotUsage.accountSwitchResult',
						result: { changed: false, message },
					});
				} finally {
					if (currentPanel === panel) {
						this.startPanelRefresh(panel.webview);
					}
				}
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

	private async pushUsageToWebview(webview: vscode.Webview, forceRefresh: boolean, snapshot?: CopilotUsageSnapshot): Promise<void> {
		const resolvedSnapshot = snapshot ?? await this.usageService.getUsageSnapshot(forceRefresh);
		const { usage, accountSummary, debugLog } = resolvedSnapshot;
		const switchState = this.usageService.getAccountSwitchState();
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
		appendPromptManagerLog(
			`[${new Date().toISOString()}] [panel] push usage to webview forceRefresh=${forceRefresh} active=${accountSummary.activeGithubSessionAccountLabel || 'none'} used=${usage.used}/${usage.limit} switching=${switchState.isSwitching}`,
		);

		await webview.postMessage({
			type: 'copilotUsage.data',
			data: {
				...usage,
				...this.buildAccountSummaryPayload(accountSummary),
				accountSwitchState: switchState,
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
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		currentPanel?.dispose();
		currentPanel = undefined;
	}
}
