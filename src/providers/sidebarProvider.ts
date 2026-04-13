/**
 * Sidebar webview provider — shows prompt list in the activity bar panel
 */

import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from '../types/messages.js';
import { isPromptStatus, type PromptStatus } from '../types/prompt.js';
import type { ChatMemoryInstructionService } from '../services/chatMemoryInstructionService.js';
import type { ExternalPromptConfigChange, StorageService } from '../services/storageService.js';
import type { AiService } from '../services/aiService.js';
import type { WorkspaceService } from '../services/workspaceService.js';
import type { GitService } from '../services/gitService.js';
import type { StateService } from '../services/stateService.js';

export class SidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'promptManager.sidebar';

	private static readonly AGENT_JSON_DEBOUNCE_MS = 300;

	private _view?: vscode.WebviewView;
	private _onDidOpenPrompt = new vscode.EventEmitter<string>();
	public readonly onDidOpenPrompt = this._onDidOpenPrompt.event;
	private _onDidDeletePrompt = new vscode.EventEmitter<string>();
	public readonly onDidDeletePrompt = this._onDidDeletePrompt.event;
	private _onDidSave = new vscode.EventEmitter<ExternalPromptConfigChange[]>();
	public readonly onDidSave = this._onDidSave.event;

	/** FileSystemWatcher for agent.json changes (progress updates) */
	private agentJsonWatcher: vscode.FileSystemWatcher | null = null;
	private agentJsonWatcherDisposables: vscode.Disposable[] = [];
	private agentJsonDebounceTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly storageService: StorageService,
		private readonly aiService: AiService,
		private readonly workspaceService: WorkspaceService,
		private readonly gitService: GitService,
		private readonly stateService: StateService,
		private readonly getChatMemoryInstructionService?: () => ChatMemoryInstructionService | undefined,
	) {
		this.initializeAgentJsonWatcher();
	}

	private async updateStoredPromptStatus(promptId: string, status: PromptStatus): Promise<ExternalPromptConfigChange[] | null> {
		const prompt = await this.storageService.getPrompt(promptId);
		if (!prompt || prompt.status === status) {
			return null;
		}

		prompt.status = status;
		const savedPrompt = await this.storageService.savePrompt(prompt, { historyReason: 'status-change' });
		if (savedPrompt.status !== 'in-progress') {
			try {
				await this.getChatMemoryInstructionService?.()?.handlePromptStatusChange(savedPrompt);
			} catch {
				// keep sidebar responsive if session cleanup fails
			}
		}

		const { content, report, ...config } = savedPrompt;
		return [{
			id: savedPrompt.id,
			archived: Boolean(savedPrompt.archived),
			kind: 'changed',
			config,
			uri: vscode.Uri.file(''),
			externalChangedAt: Date.now(),
		}];
	}

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

	/** Trigger create flow in sidebar UI (same as "+ Новый") */
	triggerCreatePromptUi(): boolean {
		if (!this._view) {
			return false;
		}
		this.postMessage({ type: 'triggerCreatePrompt' });
		return true;
	}

	/** Refresh the prompt list */
	async refreshList(): Promise<void> {
		const [prompts, archivedPrompts] = await Promise.all([
			this.storageService.listPrompts(),
			this.storageService.listArchivedPrompts(),
		]);

		/* Enrich in-progress prompts with agent.json progress */
		const inProgressPrompts = prompts.filter(p => p.status === 'in-progress');
		if (inProgressPrompts.length > 0) {
			const progressResults = await Promise.all(
				inProgressPrompts.map(p => this.storageService.readAgentProgress(p.id)),
			);
			for (let i = 0; i < inProgressPrompts.length; i++) {
				inProgressPrompts[i].progress = progressResults[i];
			}
		}

		this.postMessage({ type: 'prompts', prompts, archivedPrompts });
	}

	/** Sync selected prompt in persisted sidebar state and active webview */
	async syncSelectedPrompt(id: string | null): Promise<void> {
		const normalizedId = (id || '').trim() || null;
		let selectedPromptUuid: string | null = null;

		if (normalizedId && normalizedId !== '__new__') {
			const prompt = await this.storageService.getPrompt(normalizedId);
			selectedPromptUuid = (prompt?.promptUuid || '').trim() || null;
		}

		const state = this.stateService.getSidebarState();
		if (state.selectedPromptId !== normalizedId || state.selectedPromptUuid !== selectedPromptUuid) {
			await this.stateService.saveSidebarState({
				...state,
				selectedPromptId: normalizedId,
				selectedPromptUuid,
			});
		}
		this.postMessage({ type: 'sidebarSelectionChanged', id: normalizedId });
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
				await this.syncSelectedPrompt(msg.id);
				break;
			}

			case 'createPrompt': {
				this._onDidOpenPrompt.fire('__new__');
				break;
			}

			case 'deletePrompt': {
				await this.storageService.deletePrompt(msg.id);
				const selectedPromptId = (this.stateService.getSidebarState().selectedPromptId || '').trim() || null;
				if (msg.id === '__new__' || selectedPromptId === msg.id) {
					await this.syncSelectedPrompt(null);
				}
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

			case 'updatePromptStatus': {
				if (!isPromptStatus(msg.status)) {
					break;
				}

				const changes = await this.updateStoredPromptStatus(msg.id, msg.status);
				if (changes) {
					this._onDidSave.fire(changes);
					await this.refreshList();
				}
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

	/** Initialize FileSystemWatcher for agent.json changes to update progress in real time */
	private initializeAgentJsonWatcher(): void {
		if (this.agentJsonWatcher) {
			return;
		}

		const storageDir = this.storageService.getStorageDirectoryPath();
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(storageDir, '**/agent.json'),
		);

		this.agentJsonWatcher = watcher;

		const handleChange = () => {
			if (this.agentJsonDebounceTimer) {
				clearTimeout(this.agentJsonDebounceTimer);
			}
			this.agentJsonDebounceTimer = setTimeout(() => {
				this.agentJsonDebounceTimer = null;
				void this.refreshList();
			}, SidebarProvider.AGENT_JSON_DEBOUNCE_MS);
		};

		this.agentJsonWatcherDisposables = [
			watcher,
			watcher.onDidCreate(handleChange),
			watcher.onDidChange(handleChange),
			watcher.onDidDelete(handleChange),
		];
	}

	/** Dispose watcher resources */
	dispose(): void {
		if (this.agentJsonDebounceTimer) {
			clearTimeout(this.agentJsonDebounceTimer);
			this.agentJsonDebounceTimer = null;
		}
		for (const disposable of this.agentJsonWatcherDisposables) {
			disposable.dispose();
		}
		this.agentJsonWatcherDisposables = [];
		this.agentJsonWatcher = null;
		this._onDidOpenPrompt.dispose();
		this._onDidDeletePrompt.dispose();
		this._onDidSave.dispose();
	}
}
