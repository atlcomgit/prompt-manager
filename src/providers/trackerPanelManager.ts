/**
 * Tracker Panel Manager — opens a Kanban-like status tracker for prompts
 */

import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import {
	getNextPromptStatus,
	isPromptStatus,
	type PromptStatus,
} from '../types/prompt.js';
import type { ChatMemoryInstructionService } from '../services/chatMemoryInstructionService.js';
import type { StorageService } from '../services/storageService.js';
import type { StateService } from '../services/stateService.js';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../types/messages.js';

let currentPanel: vscode.WebviewPanel | undefined;

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

	private async updateStoredPromptStatus(promptId: string, status: PromptStatus): Promise<boolean> {
		const prompt = await this.storageService.getPrompt(promptId);
		if (!prompt || prompt.status === status) {
			return false;
		}

		prompt.status = status;
		await this.storageService.savePrompt(prompt);
		this._onDidSave.fire(prompt.id);
		if (prompt.status !== 'in-progress') {
			try {
				await this.getChatMemoryInstructionService?.()?.handlePromptStatusChange(prompt);
			} catch {
				// keep tracker responsive if session cleanup fails
			}
		}

		return true;
	}

	private async handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
			case 'getPrompts': {
				await this.refresh();
				break;
			}

			case 'getPrompt': {
				const prompt = await this.storageService.getPrompt(msg.id);
				const response: ExtensionToWebviewMessage = {
					type: 'prompt',
					prompt,
					reason: 'open',
					previousId: msg.id,
				};
				currentPanel?.webview.postMessage(response);
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
				await vscode.commands.executeCommand('promptManager.startChat', msg.id);
				break;
			}

			case 'openChat': {
				if (msg.id) {
					await this.stateService.saveLastPromptId(msg.id);
					const prompt = await this.storageService.getPrompt(msg.id);
					if (prompt && prompt.status !== 'in-progress') {
						prompt.status = 'in-progress';
						await this.storageService.savePrompt(prompt, { historyReason: 'status-change' });
						this._onDidSave.fire(prompt.id);
						await this.refresh();
					}
				}

				const openedBoundSession = await this.openBoundChatSession(msg.sessionId);
				if (!openedBoundSession) {
					try {
						await vscode.commands.executeCommand('workbench.action.chat.openAgent');
					} catch {
						await vscode.commands.executeCommand('workbench.action.chat.open');
					}
				}
				break;
			}

			case 'updatePromptStatus': {
				if (!isPromptStatus(msg.status)) {
					break;
				}
				const changed = await this.updateStoredPromptStatus(msg.id, msg.status);
				if (changed) {
					await this.refresh();
				}
				break;
			}

			case 'moveAllPromptsToNextStatus': {
				if (!isPromptStatus(msg.status)) {
					break;
				}

				const nextStatus = getNextPromptStatus(msg.status);
				if (!nextStatus) {
					break;
				}

				const prompts = await this.storageService.listPrompts();
				const promptIds = prompts
					.filter(prompt => prompt.status === msg.status)
					.map(prompt => prompt.id);

				let changed = false;
				for (const promptId of promptIds) {
					changed = (await this.updateStoredPromptStatus(promptId, nextStatus)) || changed;
				}

				if (changed) {
					await this.refresh();
				}
				break;
			}

			case 'moveSelectedPromptsToStatus': {
				if (!isPromptStatus(msg.status) || !Array.isArray(msg.ids) || msg.ids.length === 0) {
					break;
				}

				let changed = false;
				for (const promptId of msg.ids) {
					changed = (await this.updateStoredPromptStatus(promptId, msg.status)) || changed;
				}

				if (changed) {
					await this.refresh();
				}
				break;
			}

			case 'archivePrompts': {
				if (!Array.isArray(msg.ids) || msg.ids.length === 0) {
					break;
				}

				let changed = false;
				for (const promptId of msg.ids) {
					const prompt = await this.storageService.getPrompt(promptId);
					if (!prompt || prompt.archived || prompt.status !== 'closed') {
						continue;
					}

					await this.storageService.archivePrompt(promptId);
					this._onDidSave.fire(promptId);
					changed = true;
				}

				if (changed) {
					await this.refresh();
				}
				break;
			}

			default:
				break;
		}
	}

	private buildChatSessionResource(sessionId: string): vscode.Uri {
		const encoded = Buffer
			.from(sessionId, 'utf-8')
			.toString('base64')
			.replace(/=+$/g, '');

		return vscode.Uri.parse(`vscode-chat-session://local/${encoded}`);
	}

	private async openBoundChatSession(sessionId: string): Promise<boolean> {
		const trimmed = (sessionId || '').trim();
		if (!trimmed) {
			return false;
		}

		const sessionResource = this.buildChatSessionResource(trimmed);
		const isTargetSessionActive = async (): Promise<boolean> => {
			const activeSessionId = await this.stateService.getActiveChatSessionId(4500, 150);
			return activeSessionId === trimmed;
		};

		try {
			await vscode.commands.executeCommand('vscode.open', sessionResource);
			if (await isTargetSessionActive()) {
				return true;
			}
		} catch {
			// continue with compatibility variants
		}

		const openChatCmds = ['workbench.action.chat.openAgent', 'workbench.action.chat.open'];
		const argCandidates: unknown[] = [
			sessionResource,
			{ resource: sessionResource },
			{ uri: sessionResource },
			{ sessionId: trimmed },
			{ id: trimmed },
			{ chatSessionId: trimmed },
			{ session: trimmed },
			{ sessionId: trimmed, resource: sessionResource },
		];

		for (const openCmd of openChatCmds) {
			for (const arg of argCandidates) {
				try {
					await vscode.commands.executeCommand(openCmd, arg);
					if (await isTargetSessionActive()) {
						return true;
					}
				} catch {
					// try next argument variant
				}
			}
		}

		return false;
	}

	dispose(): void {
		currentPanel?.dispose();
		currentPanel = undefined;
	}
}
