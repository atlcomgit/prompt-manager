/**
 * Tracker Panel Manager — opens a Kanban-like status tracker for prompts
 */

import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import type { PromptStatus } from '../types/prompt.js';
import type { ChatMemoryInstructionService } from '../services/chatMemoryInstructionService.js';
import type { StorageService } from '../services/storageService.js';
import type { StateService } from '../services/stateService.js';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../types/messages.js';

let currentPanel: vscode.WebviewPanel | undefined;

const STATUS_SET = new Set<PromptStatus>([
	'draft',
	'in-progress',
	'stopped',
	'cancelled',
	'completed',
	'report',
	'review',
	'closed',
]);

export class TrackerPanelManager {
	private _onDidOpenPrompt = new vscode.EventEmitter<string>();
	public readonly onDidOpenPrompt = this._onDidOpenPrompt.event;
	private _onDidSave = new vscode.EventEmitter<string>();
	public readonly onDidSave = this._onDidSave.event;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly storageService: StorageService,
		private readonly stateService: StateService,
		private readonly getChatMemoryInstructionService?: () => ChatMemoryInstructionService | undefined,
	) { }

	/** Open or focus the tracker panel */
	async show(): Promise<void> {
		if (currentPanel) {
			currentPanel.webview.html = getWebviewHtml(
				currentPanel.webview,
				this.extensionUri,
				'dist/webview/tracker.js',
				'Prompt Tracker',
				vscode.env.language
			);
			currentPanel.reveal();
			await this.refresh();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'promptManager.tracker',
			'🗂️ Трекер промптов',
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
			'dist/webview/tracker.js',
			'Prompt Tracker',
			vscode.env.language
		);

		currentPanel = panel;

		panel.onDidDispose(() => {
			currentPanel = undefined;
		});

		panel.webview.onDidReceiveMessage(async (msg: WebviewToExtensionMessage) => {
			await this.handleMessage(msg);
		});

		await this.refresh();
	}

	/** Refresh prompts in tracker panel */
	async refresh(): Promise<void> {
		if (!currentPanel) {
			return;
		}
		const prompts = await this.storageService.listPrompts();
		const sorted = [...prompts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		const response: ExtensionToWebviewMessage = { type: 'prompts', prompts: sorted };
		currentPanel.webview.postMessage(response);
	}

	private async handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
			case 'getPrompts': {
				await this.refresh();
				break;
			}

			case 'createPrompt': {
				this._onDidOpenPrompt.fire('__new__');
				break;
			}

			case 'openPrompt': {
				await this.stateService.saveLastPromptId(msg.id);
				this._onDidOpenPrompt.fire(msg.id);
				break;
			}

			case 'startChat': {
				await this.stateService.saveLastPromptId(msg.id);
				await vscode.commands.executeCommand('promptManager.startChat');
				break;
			}

			case 'updatePromptStatus': {
				if (!STATUS_SET.has(msg.status)) {
					break;
				}
				const prompt = await this.storageService.getPrompt(msg.id);
				if (!prompt || prompt.status === msg.status) {
					break;
				}
				prompt.status = msg.status;
				await this.storageService.savePrompt(prompt);
				this._onDidSave.fire(prompt.id);
				if (prompt.status !== 'in-progress') {
					try {
						await this.getChatMemoryInstructionService?.()?.handlePromptStatusChange(prompt);
					} catch {
						// keep tracker responsive if session cleanup fails
					}
				}
				await this.refresh();
				break;
			}

			default:
				break;
		}
	}

	dispose(): void {
		currentPanel?.dispose();
		currentPanel = undefined;
	}
}
