/**
 * Editor webview panel — shows prompt configuration form in a separate editor tab.
 * Multiple instances can be open simultaneously (one per prompt).
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import type { Prompt } from '../types/prompt.js';
import { createDefaultPrompt } from '../types/prompt.js';
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from '../types/messages.js';
import type { StorageService } from '../services/storageService.js';
import type { AiService } from '../services/aiService.js';
import type { WorkspaceService } from '../services/workspaceService.js';
import { GitService } from '../services/gitService.js';
import type { StateService } from '../services/stateService.js';

/** Tracks open editor panels */
const openPanels = new Map<string, vscode.WebviewPanel>();
const SINGLE_EDITOR_PANEL_KEY = '__prompt_editor_singleton__';

export class EditorPanelManager {
	private _onDidSave = new vscode.EventEmitter<string>();
	public readonly onDidSave = this._onDidSave.event;
	private _onDidSaveStateChange = new vscode.EventEmitter<{ id: string; saving: boolean }>();
	public readonly onDidSaveStateChange = this._onDidSaveStateChange.event;
	private chatTrackingDisposables = new Map<string, vscode.Disposable>();
	private panelDirtySetters = new Map<string, (v: boolean) => void>();
	private panelDirtyFlags = new Map<string, boolean>();
	private panelLatestPromptSnapshots = new Map<string, Prompt | null>();
	private panelBasePrompts = new Map<string, Prompt>();
	private panelPromptRefs = new Map<string, Prompt>();
	private silentClosePanels = new Set<string>();
	private pendingRestorePrompt: Prompt | null = null;
	private pendingRestoreIsDirty = false;
	private readonly hooksOutput = vscode.window.createOutputChannel('Prompt Manager Hooks');
	private contentEditorByPanelKey = new Map<string, { uri: vscode.Uri; lastSyncedContent: string }>();
	private panelKeyByContentEditorUri = new Map<string, string>();
	private contentEditorLastActivityByPanelKey = new Map<string, number>();
	private contentSyncDisposables: vscode.Disposable[] = [];
	private openPromptQueue: Promise<void> = Promise.resolve();

	private async runConfiguredHooks(
		hookIds: string[],
		payload: Record<string, unknown>,
		phase: 'beforeChat' | 'afterChat' | 'chatError' | 'afterChatCompleted'
	): Promise<void> {
		const selected = (hookIds || []).map(h => h.trim()).filter(Boolean);
		if (selected.length === 0) {
			return;
		}

		const resolved = await this.workspaceService.resolveHookExecutables(selected);
		for (const hookId of selected) {
			const executable = resolved.get(hookId);
			if (!executable) {
				this.hooksOutput.appendLine(`[${phase}] hook "${hookId}" not found in .vscode/hooks or ~/.copilot/hooks`);
				continue;
			}

			const ext = path.extname(executable).toLowerCase();
			let command = executable;
			let args: string[] = [];

			if (ext === '.py') {
				command = 'python3';
				args = [executable];
			} else if (ext === '.sh' || ext === '.bash' || ext === '.zsh') {
				command = 'bash';
				args = [executable];
			} else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
				command = 'node';
				args = [executable];
			}

			await this.executeHookProcess(command, args, payload, hookId, phase);
		}
	}

	private async executeHookProcess(
		command: string,
		args: string[],
		payload: Record<string, unknown>,
		hookId: string,
		phase: 'beforeChat' | 'afterChat' | 'chatError' | 'afterChatCompleted'
	): Promise<void> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const stdinPayload = JSON.stringify(payload, null, 2);

		await new Promise<void>((resolve) => {
			const child = spawn(command, args, {
				cwd: workspaceRoot,
				env: process.env,
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			let stdout = '';
			let stderr = '';
			let settled = false;

			const finish = () => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeoutHandle);
				resolve();
			};

			const timeoutHandle = setTimeout(() => {
				this.hooksOutput.appendLine(`[${phase}] hook "${hookId}" timeout after 30s`);
				try {
					child.kill('SIGTERM');
				} catch {
					// best effort
				}
				finish();
			}, 30000);

			child.stdout.on('data', (chunk: Buffer) => {
				stdout += chunk.toString('utf-8');
			});

			child.stderr.on('data', (chunk: Buffer) => {
				stderr += chunk.toString('utf-8');
			});

			child.on('error', (error) => {
				this.hooksOutput.appendLine(`[${phase}] hook "${hookId}" spawn error: ${error.message}`);
				finish();
			});

			child.on('close', (code) => {
				if (stdout.trim()) {
					this.hooksOutput.appendLine(`[${phase}] hook "${hookId}" stdout:\n${stdout.trim()}`);
				}
				if (stderr.trim()) {
					this.hooksOutput.appendLine(`[${phase}] hook "${hookId}" stderr:\n${stderr.trim()}`);
				}
				if (code !== 0) {
					this.hooksOutput.appendLine(`[${phase}] hook "${hookId}" exited with code ${code ?? 'unknown'}`);
				}
				finish();
			});

			try {
				child.stdin.write(stdinPayload);
				child.stdin.end();
			} catch {
				finish();
			}
		});
	}

	private async tryReadChatMarkdownFromClipboard(): Promise<string> {
		const commands = await vscode.commands.getCommands(true);
		const copyCommands = [
			'workbench.action.chat.copyAll',
			'workbench.action.chat.copyLast',
			'workbench.action.chat.copyResponse',
			'workbench.action.chat.copy',
		].filter(cmd => commands.includes(cmd));

		if (copyCommands.length === 0) {
			return '';
		}

		const openChatCmds = ['workbench.action.chat.openAgent', 'workbench.action.chat.open'];
		for (const openCmd of openChatCmds) {
			try {
				await vscode.commands.executeCommand(openCmd);
				break;
			} catch {
				// try next open command
			}
		}

		const originalClipboard = await vscode.env.clipboard.readText();
		for (const copyCmd of copyCommands) {
			try {
				await vscode.commands.executeCommand(copyCmd);
				await new Promise(resolve => setTimeout(resolve, 150));
				const copied = (await vscode.env.clipboard.readText()).trim();
				if (copied) {
					await vscode.env.clipboard.writeText(originalClipboard);
					return copied;
				}
			} catch {
				// try next copy command
			}
		}

		await vscode.env.clipboard.writeText(originalClipboard);
		return '';
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

	private async broadcastAvailableLanguagesAndFrameworks(
		extraSources: Array<Pick<Prompt, 'languages' | 'frameworks'>> = []
	): Promise<void> {
		const allPrompts = await this.storageService.listPrompts();
		const langSet = new Set<string>();
		const fwSet = new Set<string>();

		for (const p of allPrompts) {
			p.languages?.forEach(l => langSet.add(l));
			p.frameworks?.forEach(f => fwSet.add(f));
		}

		for (const source of extraSources) {
			source.languages?.forEach(l => langSet.add(l));
			source.frameworks?.forEach(f => fwSet.add(f));
		}

		const languagesMessage: ExtensionToWebviewMessage = {
			type: 'availableLanguages',
			options: [...langSet].sort().map(l => ({ id: l, name: l })),
		};
		const frameworksMessage: ExtensionToWebviewMessage = {
			type: 'availableFrameworks',
			options: [...fwSet].sort().map(f => ({ id: f, name: f })),
		};

		for (const panel of openPanels.values()) {
			void panel.webview.postMessage(languagesMessage);
			void panel.webview.postMessage(frameworksMessage);
		}
	}

	private resolveStatusFromHooks(hooks: string[]): 'completed' | 'stopped' | null {
		const values = hooks.map(h => h.toLowerCase());
		const completed = values.some(h =>
			h.includes('status-completed')
			|| h.includes('status_completed')
			|| h.includes('status:completed')
			|| h.includes('chat-completed')
			|| h.includes('chat-success')
		);
		const stopped = values.some(h =>
			h.includes('status-stopped')
			|| h.includes('status_stopped')
			|| h.includes('status:stopped')
			|| h.includes('chat-stopped')
			|| h.includes('chat-error')
			|| h.includes('chat-failed')
		);

		if (completed && !stopped) {
			return 'completed';
		}
		if (stopped && !completed) {
			return 'stopped';
		}
		return null;
	}

	private statusRank(status: Prompt['status']): number {
		switch (status) {
			case 'draft':
				return 10;
			case 'in-progress':
				return 20;
			case 'stopped':
				return 30;
			case 'cancelled':
				return 40;
			case 'completed':
				return 50;
			case 'report':
				return 60;
			case 'review':
				return 70;
			case 'closed':
				return 80;
			default:
				return 0;
		}
	}

	private mergeReport(existingReport: string, chatMarkdown: string): string {
		const incoming = (chatMarkdown || '').trim();
		if (!incoming) {
			return existingReport || '';
		}
		const current = (existingReport || '').trim();
		if (!current) {
			return incoming;
		}
		return `${current}\n\n${incoming}`;
	}

	private normalizePromptForCompare(p: Prompt): string {
		const normalized = {
			...p,
			updatedAt: '',
		};
		return JSON.stringify(normalized);
	}

	private hasPromptDataWithoutId(p: Prompt): boolean {
		return Boolean(
			p.title
			|| p.description
			|| p.content
			|| p.report
			|| p.projects.length
			|| p.languages.length
			|| p.frameworks.length
			|| p.skills.length
			|| p.mcpTools.length
			|| p.hooks.length
			|| p.taskNumber
			|| p.branch
			|| p.model
			|| p.contextFiles.length
		);
	}

	private async persistPromptSnapshotForSwitch(snapshot: Prompt): Promise<Prompt | null> {
		const promptToSave: Prompt = JSON.parse(JSON.stringify(snapshot));
		const globalContext = this.stateService.getGlobalAgentContext();
		const saveStateId = (promptToSave.id || '__new__').trim() || '__new__';
		if (!promptToSave.id && !this.hasPromptDataWithoutId(promptToSave)) {
			return null;
		}

		this._onDidSaveStateChange.fire({ id: saveStateId, saving: true });
		try {

			if (!promptToSave.title && promptToSave.content) {
				promptToSave.title = await this.aiService.generateTitle(promptToSave.content, globalContext);
			}
			if (!promptToSave.description && promptToSave.content) {
				promptToSave.description = await this.aiService.generateDescription(promptToSave.content, globalContext);
			}
			if (!promptToSave.id) {
				const slug = await this.aiService.generateSlug(promptToSave.title, promptToSave.description, globalContext);
				promptToSave.id = await this.storageService.uniqueId(slug || 'untitled');
			}

			const existingPrompt = await this.storageService.getPrompt(promptToSave.id);
			if (existingPrompt) {
				promptToSave.timeSpentWriting = Math.max(promptToSave.timeSpentWriting || 0, existingPrompt.timeSpentWriting || 0);
				promptToSave.timeSpentImplementing = Math.max(promptToSave.timeSpentImplementing || 0, existingPrompt.timeSpentImplementing || 0);
				promptToSave.timeSpentUntracked = Number.isFinite(promptToSave.timeSpentUntracked)
					? Math.max(0, promptToSave.timeSpentUntracked || 0)
					: (existingPrompt.timeSpentUntracked || 0);
				promptToSave.chatSessionIds = (promptToSave.chatSessionIds && promptToSave.chatSessionIds.length > 0)
					? promptToSave.chatSessionIds
					: (existingPrompt.chatSessionIds || []);
			} else {
				promptToSave.timeSpentUntracked = Math.max(0, promptToSave.timeSpentUntracked || 0);
			}

			await this.storageService.savePrompt(promptToSave);
			this._onDidSaveStateChange.fire({ id: saveStateId, saving: false });
			if (promptToSave.id && promptToSave.id !== saveStateId) {
				this._onDidSaveStateChange.fire({ id: promptToSave.id, saving: false });
			}
			return promptToSave;
		} catch (error) {
			this._onDidSaveStateChange.fire({ id: saveStateId, saving: false });
			throw error;
		}
	}

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly storageService: StorageService,
		private readonly aiService: AiService,
		private readonly workspaceService: WorkspaceService,
		private readonly gitService: GitService,
		private readonly stateService: StateService,
	) {
		this.contentSyncDisposables.push(
			vscode.workspace.onDidChangeTextDocument((event) => {
				void this.syncPromptContentFromEditorDocument(event.document);
			}),
			vscode.workspace.onDidSaveTextDocument((document) => {
				void this.syncPromptContentFromEditorDocument(document);
			})
		);
	}

	private ensureContentEditorBinding(panelKey: string, prompt: Prompt): void {
		if (!prompt.id) {
			return;
		}

		const fileUri = this.storageService.getPromptMarkdownUri(prompt.id);
		const fileUriKey = fileUri.toString();
		const openDocument = vscode.workspace.textDocuments.find(d => d.uri.toString() === fileUriKey);
		const actualContent = openDocument ? openDocument.getText() : prompt.content;

		const existingBinding = this.contentEditorByPanelKey.get(panelKey);
		if (existingBinding && existingBinding.uri.toString() !== fileUriKey) {
			this.panelKeyByContentEditorUri.delete(existingBinding.uri.toString());
		}

		this.contentEditorByPanelKey.set(panelKey, {
			uri: fileUri,
			lastSyncedContent: actualContent,
		});
		this.panelKeyByContentEditorUri.set(fileUriKey, panelKey);
		this.contentEditorLastActivityByPanelKey.set(panelKey, Date.now());

		if (prompt.content !== actualContent) {
			prompt.content = actualContent;
		}
	}

	private rebindContentEditorPanelKey(oldKey: string, newKey: string): void {
		const binding = this.contentEditorByPanelKey.get(oldKey);
		if (!binding) {
			return;
		}
		this.contentEditorByPanelKey.delete(oldKey);
		this.contentEditorByPanelKey.set(newKey, binding);
		this.panelKeyByContentEditorUri.set(binding.uri.toString(), newKey);
	}

	private clearContentEditorBinding(panelKey: string): void {
		const binding = this.contentEditorByPanelKey.get(panelKey);
		if (!binding) {
			return;
		}
		this.panelKeyByContentEditorUri.delete(binding.uri.toString());
		this.contentEditorByPanelKey.delete(panelKey);
		this.contentEditorLastActivityByPanelKey.delete(panelKey);
	}

	private makePromptIdBase(title: string, description: string): string {
		const source = (title || description || '').trim();
		const normalized = source
			.toLowerCase()
			.replace(/[\s_]+/g, '-')
			.replace(/[^a-zа-я0-9-]/gi, '')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
			.substring(0, 40);
		return normalized || 'untitled';
	}

	private makeTitleFallbackFromContent(content: string): string {
		const singleLine = content.replace(/\s+/g, ' ').trim();
		if (!singleLine) {
			return 'Untitled Prompt';
		}
		return singleLine.length > 60 ? `${singleLine.slice(0, 59)}…` : singleLine;
	}

	private makeDescriptionFallbackFromContent(content: string): string {
		const singleLine = content.replace(/\s+/g, ' ').trim();
		if (!singleLine) {
			return '';
		}
		return singleLine.length > 140 ? `${singleLine.slice(0, 139)}…` : singleLine;
	}

	private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
		let timeoutHandle: NodeJS.Timeout | undefined;
		try {
			return await Promise.race<T>([
				promise,
				new Promise<T>((resolve) => {
					timeoutHandle = setTimeout(() => resolve(fallback), timeoutMs);
				}),
			]);
		} finally {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
		}
	}

	private async syncPromptContentFromEditorDocument(document: vscode.TextDocument): Promise<void> {
		const uriKey = document.uri.toString();
		const panelKey = this.panelKeyByContentEditorUri.get(uriKey);
		if (!panelKey) {
			return;
		}

		const panel = openPanels.get(panelKey);
		if (!panel) {
			return;
		}

		const content = document.getText();
		const binding = this.contentEditorByPanelKey.get(panelKey);
		if (!binding || binding.lastSyncedContent === content) {
			return;
		}

		const now = Date.now();
		const lastActivity = this.contentEditorLastActivityByPanelKey.get(panelKey) || now;
		const rawDelta = now - lastActivity;
		const writingDeltaMs = rawDelta > 0 && rawDelta <= 5000 ? rawDelta : 0;
		this.contentEditorLastActivityByPanelKey.set(panelKey, now);

		binding.lastSyncedContent = content;
		void panel.webview.postMessage({ type: 'promptContentUpdated', content, writingDeltaMs } satisfies ExtensionToWebviewMessage);
	}

	private async openPromptContentInEditor(panelKey: string, currentPrompt: Prompt, content: string): Promise<void> {
		if (!currentPrompt.id) {
			const isRu = vscode.env.language.startsWith('ru');
			vscode.window.showWarningMessage(
				isRu
					? 'Сначала сохраните промпт, затем откройте prompt.md в редакторе.'
					: 'Save prompt first, then open prompt.md in the editor.'
			);
			return;
		}

		const fileUri = this.storageService.getPromptMarkdownUri(currentPrompt.id);
		const existingBinding = this.contentEditorByPanelKey.get(panelKey);
		if (existingBinding) {
			this.contentEditorLastActivityByPanelKey.set(panelKey, Date.now());
			const existingUri = existingBinding.uri.toString() === fileUri.toString()
				? existingBinding.uri
				: fileUri;
			const doc = await vscode.workspace.openTextDocument(existingUri);
			if (!doc.isDirty && doc.getText() !== content) {
				await vscode.workspace.fs.writeFile(existingUri, Buffer.from(content, 'utf-8'));
				existingBinding.lastSyncedContent = content;
			}
			if (existingBinding.uri.toString() !== existingUri.toString()) {
				this.panelKeyByContentEditorUri.delete(existingBinding.uri.toString());
				existingBinding.uri = existingUri;
				this.panelKeyByContentEditorUri.set(existingUri.toString(), panelKey);
			}
			await vscode.window.showTextDocument(existingUri, { preview: false, preserveFocus: false });
			return;
		}

		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(fileUri.fsPath)));

		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));

		this.contentEditorByPanelKey.set(panelKey, { uri: fileUri, lastSyncedContent: content });
		this.panelKeyByContentEditorUri.set(fileUri.toString(), panelKey);
		this.contentEditorLastActivityByPanelKey.set(panelKey, Date.now());

		const doc = await vscode.workspace.openTextDocument(fileUri);
		await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
	}

	/** Open or focus an editor panel for a prompt */
	async openPrompt(promptId: string): Promise<void> {
		this.openPromptQueue = this.openPromptQueue.then(async () => {
			await this.openPromptInternal(promptId);
		});
		await this.openPromptQueue;
	}

	private async openPromptInternal(promptId: string): Promise<void> {
		const isNew = promptId === '__new__';
		const panelKey = SINGLE_EDITOR_PANEL_KEY;

		const singletonPanel = openPanels.get(panelKey);
		const singletonPrompt = this.panelPromptRefs.get(panelKey);
		if (!isNew && singletonPanel && singletonPrompt?.id === promptId) {
			singletonPanel.reveal();
			return;
		}

		const existingEntries = [...openPanels.entries()];

		for (const [existingKey, existingPanel] of existingEntries) {
			const latestSnapshot = this.panelLatestPromptSnapshots.get(existingKey)
				|| this.panelBasePrompts.get(existingKey)
				|| null;
			if (latestSnapshot) {
				const isDirty = this.panelDirtyFlags.get(existingKey) || false;
				const hasUnsavedDraftData = !latestSnapshot.id && this.hasPromptDataWithoutId(latestSnapshot);
				let shouldPersistBeforeSwitch = isDirty || hasUnsavedDraftData;
				if (!shouldPersistBeforeSwitch && latestSnapshot.id) {
					const persistedSnapshot = await this.storageService.getPrompt(latestSnapshot.id);
					shouldPersistBeforeSwitch = !persistedSnapshot
						|| this.normalizePromptForCompare(latestSnapshot) !== this.normalizePromptForCompare(persistedSnapshot);
				}
				if (shouldPersistBeforeSwitch) {
					try {
						const saved = await this.persistPromptSnapshotForSwitch(latestSnapshot);
						if (saved?.id) {
							this._onDidSave.fire(saved.id);
						}
					} catch (err) {
						const isRu = vscode.env.language.startsWith('ru');
						vscode.window.showErrorMessage(
							isRu ? `Ошибка сохранения перед переключением: ${err}` : `Save before switch error: ${err}`
						);
					}
				}
			}
			if (existingKey !== panelKey) {
				this.silentClosePanels.add(existingKey);
				existingPanel.dispose();
			}
		}

		// Load prompt data
		let prompt: Prompt;
		if (isNew) {
			prompt = createDefaultPrompt('');
			const promptConfigs = await this.storageService.listPrompts();
			const lastPromptConfig = [...promptConfigs]
				.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
			if (lastPromptConfig) {
				prompt.languages = [...(lastPromptConfig.languages || [])];
				prompt.frameworks = [...(lastPromptConfig.frameworks || [])];
				prompt.skills = [...(lastPromptConfig.skills || [])];
				prompt.mcpTools = [...(lastPromptConfig.mcpTools || [])];
				prompt.hooks = [...(lastPromptConfig.hooks || [])];
				prompt.model = lastPromptConfig.model || '';
			}
		} else {
			const loaded = await this.storageService.getPrompt(promptId);
			if (!loaded) {
				vscode.window.showErrorMessage(`Промпт "${promptId}" не найден.`);
				return;
			}
			prompt = loaded;
		}

		let restoredUnsaved = false;
		if (this.pendingRestorePrompt) {
			const canRestore = (isNew && !this.pendingRestorePrompt.id)
				|| (!isNew && this.pendingRestorePrompt.id === promptId);
			if (canRestore) {
				prompt = this.pendingRestorePrompt;
				restoredUnsaved = this.pendingRestoreIsDirty;
				this.pendingRestorePrompt = null;
				this.pendingRestoreIsDirty = false;
			}
		}

		const title = isNew ? 'New prompt' : (prompt.title || prompt.id);
		const isRu = vscode.env.language.startsWith('ru');

		if (singletonPanel) {
			this.ensureContentEditorBinding(panelKey, prompt);

			const currentPromptRef = this.panelPromptRefs.get(panelKey);
			if (currentPromptRef) {
				Object.assign(currentPromptRef, prompt);
			}

			this.panelDirtyFlags.set(panelKey, restoredUnsaved);
			this.panelLatestPromptSnapshots.set(panelKey, restoredUnsaved ? JSON.parse(JSON.stringify(prompt)) : null);
			this.panelBasePrompts.set(panelKey, JSON.parse(JSON.stringify(prompt)));

			singletonPanel.title = restoredUnsaved
				? `⚡● ${prompt.title || prompt.id || (isRu ? 'Новый промпт' : 'New prompt')}`
				: `⚡ ${prompt.title || prompt.id || (isRu ? 'Новый промпт' : 'New prompt')}`;
			singletonPanel.reveal();
			void singletonPanel.webview.postMessage({ type: 'prompt', prompt });
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'promptManager.editor',
			`⚡ ${title}`,
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
			'dist/webview/editor.js',
			`Prompt: ${title}`,
			vscode.env.language
		);

		openPanels.set(panelKey, panel);
		this.ensureContentEditorBinding(panelKey, prompt);
		this.panelPromptRefs.set(panelKey, prompt);
		let isDirty = restoredUnsaved;
		let latestPromptState: Prompt | null = restoredUnsaved ? prompt : null;
		if (isDirty) {
			const displayTitle = latestPromptState?.title || prompt.title || prompt.id || (isRu ? 'Новый промпт' : 'New prompt');
			panel.title = `⚡● ${displayTitle}`;
		}
		this.panelDirtyFlags.set(panelKey, isDirty);
		this.panelLatestPromptSnapshots.set(panelKey, latestPromptState ? JSON.parse(JSON.stringify(latestPromptState)) : null);
		this.panelBasePrompts.set(panelKey, JSON.parse(JSON.stringify(prompt)));

		const setPanelDirty = (v: boolean): void => {
			isDirty = v;
			this.panelDirtyFlags.set(panelKey, v);
		};
		this.panelDirtySetters.set(panelKey, setPanelDirty);

		// Handle panel close — autosave unsaved changes silently
		panel.onDidDispose(async () => {
			const linkedKeys = [...openPanels.entries()]
				.filter(([, p]) => p === panel)
				.map(([key]) => key);
			const skipUnsavedPrompt = this.silentClosePanels.has(panelKey)
				|| linkedKeys.some(key => this.silentClosePanels.has(key));
			this.silentClosePanels.delete(panelKey);
			for (const key of linkedKeys) {
				this.silentClosePanels.delete(key);
				openPanels.delete(key);
				this.panelPromptRefs.delete(key);
				this.panelDirtySetters.delete(key);
				this.panelDirtyFlags.delete(key);
				this.panelLatestPromptSnapshots.delete(key);
				this.panelBasePrompts.delete(key);
				this.clearContentEditorBinding(key);
			}
			openPanels.delete(panelKey);
			this.panelPromptRefs.delete(panelKey);
			this.chatTrackingDisposables.get(panelKey)?.dispose();
			this.chatTrackingDisposables.delete(panelKey);
			this.panelDirtySetters.delete(panelKey);
			this.panelDirtyFlags.delete(panelKey);
			this.panelLatestPromptSnapshots.delete(panelKey);
			this.panelBasePrompts.delete(panelKey);
			this.clearContentEditorBinding(panelKey);

			if (skipUnsavedPrompt) {
				return;
			}
			const currentSnapshot: Prompt = latestPromptState
				? JSON.parse(JSON.stringify(latestPromptState))
				: JSON.parse(JSON.stringify(prompt));

			let hasUnsavedChanges = isDirty;
			if (!hasUnsavedChanges) {
				if (currentSnapshot.id) {
					const persisted = await this.storageService.getPrompt(currentSnapshot.id);
					hasUnsavedChanges = !persisted
						|| this.normalizePromptForCompare(currentSnapshot) !== this.normalizePromptForCompare(persisted);
				} else {
					hasUnsavedChanges = Boolean(
						currentSnapshot.title
						|| currentSnapshot.description
						|| currentSnapshot.content
						|| currentSnapshot.report
						|| currentSnapshot.projects.length
						|| currentSnapshot.languages.length
						|| currentSnapshot.frameworks.length
						|| currentSnapshot.skills.length
						|| currentSnapshot.mcpTools.length
						|| currentSnapshot.hooks.length
						|| currentSnapshot.taskNumber
						|| currentSnapshot.branch
						|| currentSnapshot.model
						|| currentSnapshot.contextFiles.length
					);
				}
			}

			if (hasUnsavedChanges) {
				const dirtySnapshot: Prompt = latestPromptState
					? JSON.parse(JSON.stringify(latestPromptState))
					: JSON.parse(JSON.stringify(prompt));
				const globalContext = this.stateService.getGlobalAgentContext();
				try {
					if (!dirtySnapshot.title && dirtySnapshot.content) {
						dirtySnapshot.title = await this.aiService.generateTitle(dirtySnapshot.content, globalContext);
					}
					if (!dirtySnapshot.description && dirtySnapshot.content) {
						dirtySnapshot.description = await this.aiService.generateDescription(dirtySnapshot.content, globalContext);
					}
					if (!dirtySnapshot.id) {
						const slug = await this.aiService.generateSlug(dirtySnapshot.title, dirtySnapshot.description, globalContext);
						dirtySnapshot.id = await this.storageService.uniqueId(slug || 'untitled');
					}
					dirtySnapshot.timeSpentUntracked = Math.max(0, dirtySnapshot.timeSpentUntracked || 0);
					await this.storageService.savePrompt(dirtySnapshot);
					this.panelDirtyFlags.set(panelKey, false);
					this.panelLatestPromptSnapshots.set(panelKey, null);
					this.panelBasePrompts.set(panelKey, JSON.parse(JSON.stringify(dirtySnapshot)));
					await this.broadcastAvailableLanguagesAndFrameworks();
					this._onDidSave.fire(dirtySnapshot.id);
				} catch (err) {
					vscode.window.showErrorMessage(
						isRu ? `Ошибка сохранения: ${err}` : `Save error: ${err}`
					);
				}
			}
		});

		// Handle messages
		panel.webview.onDidReceiveMessage(
			async (msg: WebviewToExtensionMessage) => {
				if (msg.type === 'markDirty') {
					const previousLanguages = latestPromptState?.languages || prompt.languages;
					const previousFrameworks = latestPromptState?.frameworks || prompt.frameworks;

					isDirty = msg.dirty;
					if (msg.prompt) {
						latestPromptState = msg.prompt;
						this.panelLatestPromptSnapshots.set(panelKey, JSON.parse(JSON.stringify(msg.prompt)));
					} else if (msg.dirty && !latestPromptState) {
						latestPromptState = JSON.parse(JSON.stringify(prompt));
						this.panelLatestPromptSnapshots.set(panelKey, JSON.parse(JSON.stringify(latestPromptState)));
					} else if (!msg.dirty) {
						latestPromptState = null;
						this.panelLatestPromptSnapshots.set(panelKey, null);
					}

					if (msg.prompt && msg.dirty) {
						const normalize = (items: string[]): string[] => [...items].map(v => v.trim()).filter(Boolean).sort();
						const languagesChanged = JSON.stringify(normalize(previousLanguages)) !== JSON.stringify(normalize(msg.prompt.languages || []));
						const frameworksChanged = JSON.stringify(normalize(previousFrameworks)) !== JSON.stringify(normalize(msg.prompt.frameworks || []));
						if (languagesChanged || frameworksChanged) {
							await this.broadcastAvailableLanguagesAndFrameworks([msg.prompt]);
						}
					}

					const displayTitle = (latestPromptState?.title || prompt.title || prompt.id || (isRu ? 'Новый промпт' : 'New prompt'));
					panel.title = isDirty ? `⚡● ${displayTitle}` : `⚡ ${displayTitle}`;
					return;
				}
				await this.handleMessage(msg, panel, prompt, panelKey, () => isDirty, setPanelDirty);
			}
		);
	}

	/** Handle messages from editor webview */
	private async handleMessage(
		msg: WebviewToExtensionMessage,
		panel: vscode.WebviewPanel,
		currentPrompt: Prompt,
		panelKey: string,
		getIsDirty: () => boolean,
		setIsDirty: (v: boolean) => void,
	): Promise<void> {
		const postMessage = (m: ExtensionToWebviewMessage): void => {
			try {
				void panel.webview.postMessage(m);
			} catch {
				// panel/webview might be disposed; ignore to keep background flows alive
			}
		};

		switch (msg.type) {
			case 'ready': {
				if (currentPrompt.chatSessionIds?.length) {
					const existingSessionIds: string[] = [];
					for (const sessionId of currentPrompt.chatSessionIds) {
						if (await this.stateService.hasChatSession(sessionId)) {
							existingSessionIds.push(sessionId);
						}
					}
					if (existingSessionIds.length !== currentPrompt.chatSessionIds.length) {
						currentPrompt.chatSessionIds = existingSessionIds;
						await this.storageService.savePrompt(currentPrompt);
						this._onDidSave.fire(currentPrompt.id);
					}
				}

				postMessage({ type: 'prompt', prompt: currentPrompt });

				// Send global agent context
				const globalCtx = this.stateService.getGlobalAgentContext();
				postMessage({ type: 'globalContext', context: globalCtx });

				// Send workspace info
				const folders = this.workspaceService.getWorkspaceFolders();
				postMessage({ type: 'workspaceFolders', folders });

				const models = await this.aiService.getAvailableModels();
				postMessage({ type: 'availableModels', models });

				const skills = await this.workspaceService.getSkills();
				postMessage({ type: 'availableSkills', skills });

				const mcpTools = await this.workspaceService.getMcpTools();
				postMessage({ type: 'availableMcpTools', tools: mcpTools });

				const hooks = await this.workspaceService.getHooks();
				postMessage({ type: 'availableHooks', hooks });

				await this.broadcastAvailableLanguagesAndFrameworks();
				break;
			}

			case 'savePrompt': {
				const saveStateId = (msg.prompt.id || currentPrompt.id || '__new__').trim() || '__new__';
				this._onDidSaveStateChange.fire({ id: saveStateId, saving: true });
				postMessage({ type: 'promptSaving', id: saveStateId, saving: true });
				try {
					let promptToSave = msg.prompt;
					const saveSource = msg.source || 'manual';
					const globalContext = this.stateService.getGlobalAgentContext();

					const needsTitle = !promptToSave.title && !!promptToSave.content;
					const needsDescription = !promptToSave.description && !!promptToSave.content;
					if (needsTitle || needsDescription) {
						const [generatedTitle, generatedDescription] = await Promise.all([
							needsTitle
								? this.withTimeout(this.aiService.generateTitle(promptToSave.content, globalContext), 3000, '')
								: Promise.resolve(''),
							needsDescription
								? this.withTimeout(this.aiService.generateDescription(promptToSave.content, globalContext), 3000, '')
								: Promise.resolve(''),
						]);
						if (needsTitle && generatedTitle) {
							promptToSave.title = generatedTitle;
						} else if (needsTitle) {
							promptToSave.title = this.makeTitleFallbackFromContent(promptToSave.content);
						}
						if (needsDescription && generatedDescription) {
							promptToSave.description = generatedDescription;
						} else if (needsDescription) {
							promptToSave.description = this.makeDescriptionFallbackFromContent(promptToSave.content);
						}
					}

					if (!promptToSave.id) {
						promptToSave.id = await this.storageService.uniqueId(
							this.makePromptIdBase(promptToSave.title, promptToSave.description || promptToSave.content)
						);
					}

					const existingPrompt = promptToSave.id ? await this.storageService.getPrompt(promptToSave.id) : null;
					const hasConcurrentUpdate = Boolean(existingPrompt && promptToSave.updatedAt && existingPrompt.updatedAt !== promptToSave.updatedAt);
					const allowStatusOverwrite = saveSource === 'status-change';
					if (existingPrompt && hasConcurrentUpdate && !allowStatusOverwrite) {
						if (this.statusRank(existingPrompt.status) >= this.statusRank(promptToSave.status)) {
							promptToSave.status = existingPrompt.status;
						}
					}
					if (existingPrompt) {
						promptToSave.timeSpentWriting = Math.max(promptToSave.timeSpentWriting || 0, existingPrompt.timeSpentWriting || 0);
						promptToSave.timeSpentImplementing = Math.max(promptToSave.timeSpentImplementing || 0, existingPrompt.timeSpentImplementing || 0);
						promptToSave.timeSpentUntracked = Number.isFinite(promptToSave.timeSpentUntracked)
							? Math.max(0, promptToSave.timeSpentUntracked || 0)
							: (existingPrompt.timeSpentUntracked || 0);
						promptToSave.chatSessionIds = (promptToSave.chatSessionIds && promptToSave.chatSessionIds.length > 0)
							? promptToSave.chatSessionIds
							: (existingPrompt.chatSessionIds || []);
					} else {
						promptToSave.timeSpentUntracked = Math.max(0, promptToSave.timeSpentUntracked || 0);
					}

					const saved = await this.storageService.savePrompt(promptToSave);
					setIsDirty(false);

					// Update current prompt reference
					Object.assign(currentPrompt, promptToSave);
					this.panelPromptRefs.set(panelKey, currentPrompt);

					// Update panel tracking
					if (panelKey.startsWith('new-')) {
						openPanels.delete(panelKey);
						openPanels.set(promptToSave.id, panel);
						const dirtySetter = this.panelDirtySetters.get(panelKey);
						if (dirtySetter) {
							this.panelDirtySetters.delete(panelKey);
							this.panelDirtySetters.set(promptToSave.id, dirtySetter);
						}
						const dirtyFlag = this.panelDirtyFlags.get(panelKey);
						this.panelDirtyFlags.delete(panelKey);
						this.panelDirtyFlags.set(promptToSave.id, Boolean(dirtyFlag));
						const latestSnapshot = this.panelLatestPromptSnapshots.get(panelKey);
						this.panelLatestPromptSnapshots.delete(panelKey);
						this.panelLatestPromptSnapshots.set(promptToSave.id, latestSnapshot ? JSON.parse(JSON.stringify(latestSnapshot)) : null);
						const basePrompt = this.panelBasePrompts.get(panelKey);
						this.panelBasePrompts.delete(panelKey);
						this.panelBasePrompts.set(promptToSave.id, basePrompt ? JSON.parse(JSON.stringify(basePrompt)) : JSON.parse(JSON.stringify(promptToSave)));
						this.rebindContentEditorPanelKey(panelKey, promptToSave.id);
					}

					const stateKey = panelKey.startsWith('new-') ? promptToSave.id : panelKey;
					this.panelDirtyFlags.set(stateKey, false);
					this.panelLatestPromptSnapshots.set(stateKey, null);
					this.panelBasePrompts.set(stateKey, JSON.parse(JSON.stringify(promptToSave)));

					panel.title = `⚡ ${saved.title || saved.id}`;
					postMessage({ type: 'promptSaved', prompt: saved });
					postMessage({ type: 'prompt', prompt: promptToSave });
					await this.broadcastAvailableLanguagesAndFrameworks();

					this._onDidSave.fire(promptToSave.id);
					if (promptToSave.id && promptToSave.id !== saveStateId) {
						this._onDidSaveStateChange.fire({ id: promptToSave.id, saving: false });
					}
					// vscode.window.showInformationMessage(`Промпт "${saved.title || saved.id}" сохранён.`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					postMessage({ type: 'error', message: `Save failed: ${message}` });
				} finally {
					this._onDidSaveStateChange.fire({ id: saveStateId, saving: false });
					postMessage({ type: 'promptSaving', id: saveStateId, saving: false });
				}
				break;
			}

			case 'openPromptContentInEditor': {
				await this.openPromptContentInEditor(panelKey, currentPrompt, msg.content || '');
				break;
			}

			case 'generateTitle': {
				const title = await this.aiService.generateTitle(msg.content, this.stateService.getGlobalAgentContext());
				postMessage({ type: 'generatedTitle', title });
				break;
			}

			case 'generateDescription': {
				const description = await this.aiService.generateDescription(msg.content, this.stateService.getGlobalAgentContext());
				postMessage({ type: 'generatedDescription', description });
				break;
			}

			case 'generateSlug': {
				const slug = await this.aiService.generateSlug(msg.title, msg.description, this.stateService.getGlobalAgentContext());
				postMessage({ type: 'generatedSlug', slug });
				break;
			}

			case 'getWorkspaceFolders': {
				const folders = this.workspaceService.getWorkspaceFolders();
				postMessage({ type: 'workspaceFolders', folders });
				break;
			}

			case 'getAvailableModels': {
				const models = await this.aiService.getAvailableModels();
				postMessage({ type: 'availableModels', models });
				break;
			}

			case 'getAvailableSkills': {
				const skills = await this.workspaceService.getSkills();
				postMessage({ type: 'availableSkills', skills });
				break;
			}

			case 'getAvailableMcpTools': {
				const tools = await this.workspaceService.getMcpTools();
				postMessage({ type: 'availableMcpTools', tools });
				break;
			}

			case 'getAvailableHooks': {
				const hooks = await this.workspaceService.getHooks();
				postMessage({ type: 'availableHooks', hooks });
				break;
			}

			case 'startChat': {
				let prompt: Prompt | null = msg.prompt ? { ...msg.prompt } : await this.storageService.getPrompt(msg.id);
				if (prompt && prompt.content) {
					const bindSessionToPrompt = async (sessionId: string): Promise<void> => {
						const normalizedSessionId = (sessionId || '').trim();
						if (!normalizedSessionId) {
							return;
						}

						const promptFromStorage = await this.storageService.getPrompt(prompt.id);
						if (!promptFromStorage) {
							return;
						}

						const updatedChatSessionIds = [
							normalizedSessionId,
							...(promptFromStorage.chatSessionIds || []).filter(id => id !== normalizedSessionId),
						];
						const changed = JSON.stringify(updatedChatSessionIds) !== JSON.stringify(promptFromStorage.chatSessionIds || []);
						if (!changed) {
							return;
						}

						promptFromStorage.chatSessionIds = updatedChatSessionIds;
						await this.storageService.savePrompt(promptFromStorage);
						Object.assign(prompt, promptFromStorage);
						Object.assign(currentPrompt, promptFromStorage);
						this._onDidSave.fire(promptFromStorage.id);
						postMessage({ type: 'prompt', prompt: promptFromStorage });
					};

					// Ensure prompt has id and persist latest editor state before starting chat
					if (!prompt.id) {
						const slug = await this.aiService.generateSlug(prompt.title, prompt.description, this.stateService.getGlobalAgentContext());
						prompt.id = await this.storageService.uniqueId(slug || 'untitled');
					}
					const existingBeforeChat = await this.storageService.getPrompt(prompt.id);
					if (existingBeforeChat) {
						prompt.timeSpentWriting = Math.max(prompt.timeSpentWriting || 0, existingBeforeChat.timeSpentWriting || 0);
						prompt.timeSpentImplementing = Math.max(prompt.timeSpentImplementing || 0, existingBeforeChat.timeSpentImplementing || 0);
						prompt.timeSpentUntracked = Number.isFinite(prompt.timeSpentUntracked)
							? Math.max(0, prompt.timeSpentUntracked || 0)
							: (existingBeforeChat.timeSpentUntracked || 0);
						prompt.chatSessionIds = prompt.chatSessionIds?.length ? prompt.chatSessionIds : (existingBeforeChat.chatSessionIds || []);
					}
					await this.storageService.savePrompt(prompt);
					Object.assign(currentPrompt, prompt);
					this._onDidSave.fire(prompt.id);

					// Compose query with prompt content and metadata
					const globalContext = this.stateService.getGlobalAgentContext();
					const parts: string[] = [];
					try {
						await this.workspaceService.ensureChatInstructionsFile(globalContext);
					} catch {
						// keep chat flow even if instructions file sync fails
					}

					parts.push(prompt.content);

					const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
					const fileUris = prompt.contextFiles
						.map(f => vscode.Uri.file(f.startsWith('/') ? f : `${workspaceRoot}/${f}`));

					// Add context metadata
					const ctx: string[] = [];
					if (prompt.projects.length > 0) ctx.push(`Projects: ${prompt.projects.join(', ')}`);
					if (prompt.languages.length > 0) ctx.push(`Languages: ${prompt.languages.join(', ')}`);
					if (prompt.frameworks.length > 0) ctx.push(`Frameworks: ${prompt.frameworks.join(', ')}`);
					if (prompt.skills.length > 0) ctx.push(`Skills: ${prompt.skills.join(', ')}`);
					if (prompt.mcpTools.length > 0) ctx.push(`MCP Tools: ${prompt.mcpTools.join(', ')}`);
					if (prompt.hooks.length > 0) ctx.push(`Hooks: ${prompt.hooks.join(', ')}`);
					if (prompt.model) ctx.push(`Preferred model: ${prompt.model}`);
					if (prompt.taskNumber) ctx.push(`Task: ${prompt.taskNumber}`);
					if (prompt.branch) ctx.push(`Branch: ${prompt.branch}`);
					if (prompt.contextFiles.length > 0) {
						ctx.push(`Context files: ${prompt.contextFiles.map(f => `#file:${f}`).join(' ')}`);
					}

					if (ctx.length > 0) {
						parts.push('');
						parts.push('---');
						parts.push('Context:');
						ctx.forEach(c => parts.push(`- ${c}`));
					}

					// Change status to in-progress and save
					if (prompt.status !== 'in-progress') {
						prompt.status = 'in-progress';
						await this.storageService.savePrompt(prompt);
						Object.assign(currentPrompt, prompt);
						setIsDirty(false);
						this._onDidSave.fire(prompt.id);
						postMessage({ type: 'prompt', prompt });
					}

					const query = parts.join('\n');
					const hookPayloadBase = {
						promptId: prompt.id,
						title: prompt.title,
						description: prompt.description,
						status: prompt.status,
						query,
						model: prompt.model,
						taskNumber: prompt.taskNumber,
						branch: prompt.branch,
						contextFiles: prompt.contextFiles,
						hooks: prompt.hooks,
						timestamp: new Date().toISOString(),
					};
					const requestStartTimestamp = Date.now();
					await this.runConfiguredHooks(prompt.hooks || [], {
						event: 'beforeChat',
						...hookPayloadBase,
					}, 'beforeChat');

					let requestModelIdentifier = '';
					let requestModelSelector: vscode.LanguageModelChatSelector | undefined;
					let trackedSessionId = '';

					const openChatCmds = ['workbench.action.chat.openAgent', 'workbench.action.chat.open'];
					let opened = false;
					for (const openCmd of openChatCmds) {
						try {
							await vscode.commands.executeCommand(openCmd);
							opened = true;
							break;
						} catch {
							// try next open command
						}
					}

					if (prompt.model) {
						try {
							await new Promise(resolve => setTimeout(resolve, 200));
							const storageModel = await this.aiService.resolveModelStorageIdentifier(prompt.model);
							requestModelIdentifier = storageModel || requestModelIdentifier;
							requestModelSelector = await this.aiService.resolveChatOpenModelSelector(prompt.model);
							await this.stateService.forcePersistChatCurrentLanguageModel(storageModel);
							await this.aiService.tryApplyChatModelSafely(prompt.model);
						} catch { }
					}

					const sendMessage = async (message: string): Promise<void> => {
						if (requestModelSelector) {
							try {
								await vscode.commands.executeCommand('workbench.action.chat.open', {
									query: message,
									modelSelector: requestModelSelector,
								});
								return;
							} catch {
								// fallback to compatibility variants
							}
						}

						const args: unknown[] = [
							{ query: message },
							message,
							{ message },
							{ prompt: message },
						];

						if (requestModelIdentifier) {
							args.unshift(
								{ query: message, userSelectedModelId: requestModelIdentifier },
								{ query: message, modelId: requestModelIdentifier },
								{ query: message, model: requestModelIdentifier },
								{ message, userSelectedModelId: requestModelIdentifier },
								{ prompt: message, userSelectedModelId: requestModelIdentifier },
								{ query: message, options: { userSelectedModelId: requestModelIdentifier } },
							);
						}

						for (const arg of args) {
							for (const openCmd of openChatCmds) {
								try {
									await vscode.commands.executeCommand(openCmd, arg);
									return;
								} catch {
									// try next variant
								}
							}
						}
					};

					const forceNewChatSession = async (): Promise<void> => {
						const commands = await vscode.commands.getCommands(true);
						const newSessionCmds = [
							'workbench.action.chat.newChat',
							'workbench.action.chat.new',
							'workbench.action.chat.openNew',
							'workbench.action.chat.clear',
						].filter(c => commands.includes(c));

						for (const cmd of newSessionCmds) {
							try {
								await vscode.commands.executeCommand(cmd);
								return;
							} catch {
								// try next command
							}
						}
					};

					let sendMessageSucceeded = false;
					// Best-effort model/files actions and single prompt send
					try {
						await new Promise(resolve => setTimeout(resolve, 150));
						const commands = await vscode.commands.getCommands(true);
						if (prompt.model) {
							const storageModel = await this.aiService.resolveModelStorageIdentifier(prompt.model);
							requestModelIdentifier = storageModel || requestModelIdentifier;
							requestModelSelector = await this.aiService.resolveChatOpenModelSelector(prompt.model);
							await this.stateService.forcePersistChatCurrentLanguageModel(storageModel);
							await forceNewChatSession();
							await new Promise(resolve => setTimeout(resolve, 120));
							await this.aiService.tryApplyChatModelSafely(prompt.model);
						}

						const attachFiles = async () => {
							const attachCmds = [
								'workbench.action.chat.attachFile',
								'workbench.action.chat.addFile',
								'workbench.action.chat.addContext',
								'workbench.action.chat.attachContext',
							].filter(c => commands.includes(c));

							for (const cmd of attachCmds) {
								for (const fileUri of fileUris) {
									try {
										await vscode.commands.executeCommand(cmd, fileUri);
									} catch {
										try {
											await vscode.commands.executeCommand(cmd, { uri: fileUri });
										} catch {
											// try next variant
										}
									}
								}
							}
						};

						if (fileUris.length > 0) {
							await attachFiles();
						}

						await sendMessage(query);
						const startedSessionImmediate = await this.stateService.waitForChatSessionStarted(requestStartTimestamp, 8000, 250);
						if (startedSessionImmediate.ok && startedSessionImmediate.sessionId) {
							trackedSessionId = startedSessionImmediate.sessionId;
							await bindSessionToPrompt(startedSessionImmediate.sessionId);
						} else {
							const activeSessionId = await this.stateService.getActiveChatSessionId(2500, 250);
							if (activeSessionId) {
								trackedSessionId = activeSessionId;
								await bindSessionToPrompt(activeSessionId);
							}
						}
						sendMessageSucceeded = true;
					} catch {
						await this.runConfiguredHooks(prompt.hooks || [], {
							event: 'chatError',
							error: 'Failed to dispatch chat message via VS Code chat commands',
							...hookPayloadBase,
						}, 'chatError');
						// ignore optional compatibility attempts
					}

					if (sendMessageSucceeded) {
						void (async () => {
							const startedSession = await this.stateService.waitForChatSessionStarted(
								requestStartTimestamp,
								15000,
								500,
								trackedSessionId || undefined,
							);
							if (startedSession.ok && startedSession.sessionId) {
								trackedSessionId = startedSession.sessionId;
								await bindSessionToPrompt(startedSession.sessionId);
							} else {
								const activeSessionId = await this.stateService.getActiveChatSessionId(5000, 250);
								if (activeSessionId) {
									trackedSessionId = trackedSessionId || activeSessionId;
									await bindSessionToPrompt(activeSessionId);
								}
							}

							const completion = await this.stateService.waitForChatRequestCompletion(
								requestStartTimestamp,
								180000,
								1000,
								trackedSessionId || undefined,
							);
							const chatMarkdown = await this.tryReadChatMarkdownFromClipboard();
							const completionObserved = Number(completion.lastRequestEnded || 0) > Number(completion.lastRequestStarted || 0);
							this.hooksOutput.appendLine(
								`[chat-track] prompt=${prompt.id} trackedSessionId=${trackedSessionId || '-'} completionOk=${completion.ok} reason=${completion.reason || '-'} sessionId=${completion.sessionId || '-'} started=${completion.lastRequestStarted || 0} ended=${completion.lastRequestEnded || 0} pendingEdits=${String(completion.hasPendingEdits)} markdown=${chatMarkdown ? 'yes' : 'no'}`
							);
							if (completion.ok || completionObserved) {
								const promptToComplete = await this.storageService.getPrompt(prompt.id);
								if (promptToComplete) {
									const startedAt = Number(completion.lastRequestStarted || requestStartTimestamp);
									const endedAt = Number(completion.lastRequestEnded || Date.now());
									const implementingDelta = Math.max(0, endedAt - startedAt);
									if (implementingDelta > 0) {
										promptToComplete.timeSpentImplementing = (promptToComplete.timeSpentImplementing || 0) + implementingDelta;
									}

									const sessionId = String(completion.sessionId || '').trim();
									if (sessionId) {
										promptToComplete.chatSessionIds = [
											sessionId,
											...(promptToComplete.chatSessionIds || []).filter(id => id !== sessionId),
										];
									}
									if (chatMarkdown) {
										promptToComplete.report = this.mergeReport(promptToComplete.report || '', chatMarkdown);
									}
									if (promptToComplete.status !== 'completed') {
										promptToComplete.status = 'completed';
									}
									await this.storageService.savePrompt(promptToComplete);
									Object.assign(currentPrompt, promptToComplete);
									this._onDidSave.fire(promptToComplete.id);
									postMessage({ type: 'prompt', prompt: promptToComplete });
								}

								await this.runConfiguredHooks(prompt?.hooks || [], {
									event: 'afterChatCompleted',
									chatCompletion: completion,
									chatMarkdown,
									...hookPayloadBase,
									status: 'completed',
									completionFallback: completion.ok ? false : true,
								}, 'afterChatCompleted');
								this.hooksOutput.appendLine(`[chat-track] afterChatCompleted fired for prompt=${prompt.id}`);
								return;
							}

							if (chatMarkdown) {
								const promptForTiming = await this.storageService.getPrompt(prompt.id);
								if (promptForTiming) {
									const startedAt = Number(completion.lastRequestStarted || requestStartTimestamp);
									const endedAt = Number(completion.lastRequestEnded || Date.now());
									const implementingDelta = Math.max(0, endedAt - startedAt);
									if (implementingDelta > 0) {
										promptForTiming.timeSpentImplementing = (promptForTiming.timeSpentImplementing || 0) + implementingDelta;
									}
									promptForTiming.report = this.mergeReport(promptForTiming.report || '', chatMarkdown);
									await this.storageService.savePrompt(promptForTiming);
									Object.assign(currentPrompt, promptForTiming);
									this._onDidSave.fire(promptForTiming.id);
									postMessage({ type: 'prompt', prompt: promptForTiming });
								}

								await this.runConfiguredHooks(prompt?.hooks || [], {
									event: 'afterChatCompleted',
									chatCompletion: completion,
									chatMarkdown,
									...hookPayloadBase,
									status: 'completed',
								}, 'afterChatCompleted');
								this.hooksOutput.appendLine(`[chat-track] afterChatCompleted fired via markdown fallback for prompt=${prompt.id}`);
								return;
							}

							await this.runConfiguredHooks(prompt?.hooks || [], {
								event: 'chatError',
								error: `Chat completion not detected (${completion.reason || 'unknown'})`,
								chatCompletion: completion,
								...hookPayloadBase,
							}, 'chatError');
							this.hooksOutput.appendLine(`[chat-track] chatError fired for prompt=${prompt.id}: completion not detected`);
						})();
					}

					if (sendMessageSucceeded) {
						postMessage({ type: 'chatStarted', promptId: prompt.id });
					} else {
						postMessage({ type: 'error', message: 'Не удалось отправить промпт в чат. Проверьте, что Copilot Chat доступен, и повторите попытку.' });
					}

					// Optional hook-based status policy (no modal)
					const hookStatus = this.resolveStatusFromHooks(prompt.hooks || []);
					if (hookStatus) {
						prompt.status = hookStatus;
						await this.storageService.savePrompt(prompt);
						this._onDidSave.fire(prompt.id);
						postMessage({ type: 'prompt', prompt });
					}
				}
				break;
			}

			case 'openChat': {
				if (msg.id) {
					const promptFromStorage = await this.storageService.getPrompt(msg.id);
					if (promptFromStorage) {
						const existingSessionIds: string[] = [];
						for (const sessionId of promptFromStorage.chatSessionIds || []) {
							if (await this.stateService.hasChatSession(sessionId)) {
								existingSessionIds.push(sessionId);
							}
						}
						if (existingSessionIds.length !== (promptFromStorage.chatSessionIds || []).length) {
							promptFromStorage.chatSessionIds = existingSessionIds;
							await this.storageService.savePrompt(promptFromStorage);
							Object.assign(currentPrompt, promptFromStorage);
							this._onDidSave.fire(promptFromStorage.id);
							postMessage({ type: 'prompt', prompt: promptFromStorage });
						}
					}
				}

				const openedBoundSession = await this.openBoundChatSession(msg.sessionId);
				if (!openedBoundSession) {
					if (msg.sessionId) {
						postMessage({ type: 'error', message: 'Не удалось открыть привязанный чат. Возможно, он удалён или недоступен.' });
					} else {
						try {
							await vscode.commands.executeCommand('workbench.action.chat.openAgent');
						} catch {
							await vscode.commands.executeCommand('workbench.action.chat.open');
						}
					}
				}
				break;
			}

			case 'checkBranchStatus': {
				const paths = this.workspaceService.getWorkspaceFolderPaths();
				const status = await this.gitService.checkBranchStatus(paths, msg.projects, msg.branch);
				postMessage({ type: 'branchStatus', hasChanges: status.hasChanges, details: status.details });
				break;
			}

			case 'switchBranch': {
				const paths = this.workspaceService.getWorkspaceFolderPaths();
				// Check for uncommitted changes first
				const status = await this.gitService.checkBranchStatus(paths, msg.projects, msg.branch);
				if (status.hasChanges) {
					const answer = await vscode.window.showWarningMessage(
						'Есть несохранённые изменения. Переключить ветку?',
						{ modal: true, detail: status.details },
						'Переключить',
						'Отмена'
					);
					if (answer !== 'Переключить') {
						return;
					}
				}
				const result = await this.gitService.switchBranch(paths, msg.projects, msg.branch);
				if (result.success) {
					postMessage({ type: 'info', message: `Ветка "${msg.branch}" активирована.` });
					const branches = await this.gitService.getBranches(paths, msg.projects);
					postMessage({ type: 'branches', branches });
				} else {
					postMessage({ type: 'error', message: `Ошибки: ${result.errors.join(', ')}` });
				}
				break;
			}

			case 'getBranches': {
				const paths = this.workspaceService.getWorkspaceFolderPaths();
				const branches = await this.gitService.getBranches(paths, msg.projects);
				postMessage({ type: 'branches', branches });
				break;
			}

			case 'pickFile': {
				const uris = await vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: true,
					openLabel: 'Добавить файл контекста',
				});
				if (uris && uris.length > 0) {
					const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
					const files = uris.map(u => {
						const fp = u.fsPath;
						return fp.startsWith(workspaceRoot) ? fp.slice(workspaceRoot.length + 1) : fp;
					});
					postMessage({ type: 'pickedFiles', files });
				}
				break;
			}

			case 'pasteFiles': {
				// Validate and normalize pasted paths
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
				const validFiles: string[] = [];
				for (const f of msg.files) {
					let filePath = f.trim();
					if (!filePath) continue;
					// If absolute, convert to relative
					if (filePath.startsWith(workspaceRoot)) {
						filePath = filePath.slice(workspaceRoot.length + 1);
					}
					// Check if file exists
					try {
						const fullPath = filePath.startsWith('/') ? filePath : `${workspaceRoot}/${filePath}`;
						await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
						validFiles.push(filePath);
					} catch {
						// Skip non-existent files, just add the path
						validFiles.push(filePath);
					}
				}
				if (validFiles.length > 0) {
					postMessage({ type: 'pickedFiles', files: validFiles });
				}
				break;
			}

			case 'openFile': {
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
				const fullPath = msg.file.startsWith('/') ? msg.file : `${workspaceRoot}/${msg.file}`;
				try {
					const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
					await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
				} catch {
					vscode.window.showErrorMessage(`Cannot open file: ${msg.file}`);
				}
				break;
			}

			case 'getGlobalContext': {
				const ctx = this.stateService.getGlobalAgentContext();
				postMessage({ type: 'globalContext', context: ctx });
				break;
			}

			case 'saveGlobalContext': {
				await this.stateService.saveGlobalAgentContext(msg.context);
				try {
					await this.workspaceService.ensureChatInstructionsFile(msg.context);
				} catch {
					// keep UI responsive even if file/settings sync fails
				}
				break;
			}

			case 'createBranch': {
				const paths = this.workspaceService.getWorkspaceFolderPaths();
				const result = await this.gitService.createBranch(paths, msg.projects, msg.branch);
				if (result.success) {
					postMessage({ type: 'info', message: `Ветка "${msg.branch}" активирована.` });
					const branches = await this.gitService.getBranches(paths, msg.projects);
					postMessage({ type: 'branches', branches });
				} else {
					const details = result.errors.join('\n');
					void vscode.window.showWarningMessage(
						'Не удалось переключить/создать ветку для всех выбранных проектов.',
						{ modal: true, detail: details }
					);
					postMessage({ type: 'error', message: `Ошибки: ${result.errors.join(', ')}` });
				}
				break;
			}

			case 'updateTimeSpent': {
				const prompt = await this.storageService.getPrompt(msg.id);
				if (prompt) {
					prompt[msg.field] += msg.delta;
					await this.storageService.savePrompt(prompt);
				}
				break;
			}

			case 'requestSuggestion': {
				try {
					const cancellation = new (await import('vscode')).CancellationTokenSource();
					// Timeout after 10 seconds
					const timeout = setTimeout(() => cancellation.cancel(), 10000);
					const globalContext = typeof msg.globalContext === 'string'
						? msg.globalContext
						: this.stateService.getGlobalAgentContext();
					const suggestions = await this.aiService.generateSuggestionVariants(msg.textBefore, 3, globalContext);
					clearTimeout(timeout);
					if (suggestions.length > 0) {
						postMessage({ type: 'inlineSuggestions', suggestions });
					} else {
						postMessage({ type: 'inlineSuggestion', suggestion: '' });
					}
				} catch {
					postMessage({ type: 'inlineSuggestion', suggestion: '' });
				}
				break;
			}

			default:
				break;
		}
	}

	/** Close all open panels */
	disposeAll(): void {
		for (const d of this.contentSyncDisposables) {
			d.dispose();
		}
		this.contentSyncDisposables = [];
		for (const d of this.chatTrackingDisposables.values()) {
			d.dispose();
		}
		this.chatTrackingDisposables.clear();
		for (const panel of openPanels.values()) {
			panel.dispose();
		}
		openPanels.clear();
		this.panelDirtySetters.clear();
		this.panelPromptRefs.clear();
		this.silentClosePanels.clear();
		this.contentEditorByPanelKey.clear();
		this.panelKeyByContentEditorUri.clear();
		this.contentEditorLastActivityByPanelKey.clear();
		this.hooksOutput.dispose();
	}

	/** Close prompt panel silently (without unsaved confirmation) */
	closePromptSilently(promptId: string): void {
		const panel = openPanels.get(SINGLE_EDITOR_PANEL_KEY);
		if (!panel) {
			return;
		}
		const currentPrompt = this.panelPromptRefs.get(SINGLE_EDITOR_PANEL_KEY);
		if (currentPrompt?.id && currentPrompt.id !== promptId) {
			return;
		}

		this.panelDirtySetters.get(SINGLE_EDITOR_PANEL_KEY)?.(false);
		this.silentClosePanels.add(SINGLE_EDITOR_PANEL_KEY);
		panel.dispose();
	}
}
