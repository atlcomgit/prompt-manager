/**
 * Sidebar webview provider — shows prompt list in the activity bar panel
 */

import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from '../types/messages.js';
import type { StorageService } from '../services/storageService.js';
import type { AiService } from '../services/aiService.js';
import type { WorkspaceService } from '../services/workspaceService.js';
import type { GitService } from '../services/gitService.js';
import type { StateService } from '../services/stateService.js';

export class SidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'promptManager.sidebar';

	private _view?: vscode.WebviewView;
	private _onDidOpenPrompt = new vscode.EventEmitter<string>();
	public readonly onDidOpenPrompt = this._onDidOpenPrompt.event;
	private _onDidDeletePrompt = new vscode.EventEmitter<string>();
	public readonly onDidDeletePrompt = this._onDidDeletePrompt.event;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly storageService: StorageService,
		private readonly aiService: AiService,
		private readonly workspaceService: WorkspaceService,
		private readonly gitService: GitService,
		private readonly stateService: StateService,
	) { }

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};

		webviewView.webview.html = getWebviewHtml(
			webviewView.webview,
			this.extensionUri,
			'dist/webview/sidebar.js',
			'Prompt Manager',
			vscode.env.language
		);

		webviewView.webview.onDidReceiveMessage(
			(msg: WebviewToExtensionMessage) => this.handleMessage(msg)
		);
	}

	/** Send message to sidebar webview */
	postMessage(msg: ExtensionToWebviewMessage): void {
		this._view?.webview.postMessage(msg);
	}

	/** Refresh the prompt list */
	async refreshList(): Promise<void> {
		const prompts = await this.storageService.listPrompts();
		this.postMessage({ type: 'prompts', prompts });
	}

	/** Handle messages from sidebar webview */
	private async handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
			case 'getPrompts': {
				await this.refreshList();
				const state = this.stateService.getSidebarState();
				this.postMessage({ type: 'sidebarState', state });
				break;
			}

			case 'openPrompt': {
				this._onDidOpenPrompt.fire(msg.id);
				await this.stateService.saveLastPromptId(msg.id);
				break;
			}

			case 'createPrompt': {
				this._onDidOpenPrompt.fire('__new__');
				break;
			}

			case 'deletePrompt': {
				await this.storageService.deletePrompt(msg.id);
				this._onDidDeletePrompt.fire(msg.id);
				this.postMessage({ type: 'promptDeleted', id: msg.id });
				await this.refreshList();
				break;
			}

			case 'duplicatePrompt': {
				const slug = await this.storageService.uniqueId(`${msg.id}-copy`);
				const dup = await this.storageService.duplicatePrompt(msg.id, slug);
				if (dup) {
					const { content, ...config } = dup;
					this.postMessage({ type: 'promptDuplicated', prompt: config });
					await this.refreshList();
					this._onDidOpenPrompt.fire(slug);
				}
				break;
			}

			case 'toggleFavorite': {
				const prompt = await this.storageService.getPrompt(msg.id);
				if (prompt) {
					prompt.favorite = !prompt.favorite;
					await this.storageService.savePrompt(prompt);
					await this.refreshList();
				}
				break;
			}

			case 'importPrompt': {
				const uris = await vscode.window.showOpenDialog({
					canSelectFolders: true,
					canSelectFiles: false,
					canSelectMany: false,
					openLabel: 'Импортировать промпт',
				});
				if (uris && uris.length > 0) {
					const imported = await this.storageService.importPrompt(uris[0].fsPath);
					if (imported) {
						await this.refreshList();
						this._onDidOpenPrompt.fire(imported.id);
						vscode.window.showInformationMessage(`Промпт "${imported.title || imported.id}" импортирован.`);
					}
				}
				break;
			}

			case 'exportPrompt': {
				const uris = await vscode.window.showOpenDialog({
					canSelectFolders: true,
					canSelectFiles: false,
					canSelectMany: false,
					openLabel: 'Экспортировать в папку',
				});
				if (uris && uris.length > 0) {
					await this.storageService.exportPrompt(msg.id, uris[0].fsPath);
					vscode.window.showInformationMessage(`Промпт экспортирован в ${uris[0].fsPath}`);
				}
				break;
			}

			case 'saveSidebarState': {
				await this.stateService.saveSidebarState(msg.state);
				break;
			}

			case 'getSidebarState': {
				const state = this.stateService.getSidebarState();
				this.postMessage({ type: 'sidebarState', state });
				break;
			}

			case 'showStatistics': {
				await vscode.commands.executeCommand('promptManager.showStatistics');
				break;
			}

			case 'getWorkspaceFolders': {
				const folders = this.workspaceService.getWorkspaceFolders();
				this.postMessage({ type: 'workspaceFolders', folders });
				break;
			}

			case 'getBranches': {
				const paths = this.workspaceService.getWorkspaceFolderPaths();
				const branches = await this.gitService.getBranches(paths, msg.projects);
				this.postMessage({ type: 'branches', branches });
				break;
			}

			default:
				break;
		}
	}
}
