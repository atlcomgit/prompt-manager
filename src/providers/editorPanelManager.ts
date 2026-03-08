/**
 * Editor webview panel — shows prompt configuration form in a separate editor tab.
 * Multiple instances can be open simultaneously (one per prompt).
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import MarkdownIt from 'markdown-it';
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
	private reportEditorPanels = new Map<string, vscode.WebviewPanel>();
	private contentSyncDisposables: vscode.Disposable[] = [];
	private openPromptQueue: Promise<void> = Promise.resolve();
	private readonly markdownRenderer = new MarkdownIt({
		html: false,
		linkify: true,
		breaks: false,
		typographer: false,
	});

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

	private extractAgentResponse(chatText: string): string {
		const text = (chatText || '').trim();
		if (!text) {
			return '';
		}
		// Find the last occurrence of "GitHub Copilot:" (or similar agent markers)
		const markers = ['GitHub Copilot:', 'Copilot:'];
		let lastIdx = -1;
		let markerLen = 0;
		for (const marker of markers) {
			const idx = text.lastIndexOf(marker);
			if (idx > lastIdx) {
				lastIdx = idx;
				markerLen = marker.length;
			}
		}
		if (lastIdx >= 0) {
			return text.substring(lastIdx + markerLen).trim();
		}
		return text;
	}

	/**
	 * Convert Markdown text to HTML suitable for RichTextEditor.
	 * Uses markdown-it parser to preserve list nesting and chat-like structure.
	 */
	private markdownToHtml(md: string): string {
		const text = (md || '').trim();
		if (!text) {
			return '';
		}

		let html = this.markdownRenderer.render(text).trim();

		html = html.replace(
			/^<p>\s*(?:Оптимизация выбора инструмента\.\.\.|Optimizing tool selection\.\.\.|Choosing the best tool\.\.\.)\s*/i,
			'<p>'
		);
		html = html.replace(/^<p>\s*<\/p>\s*/i, '').trim();

		return html;
	}

	private async tryReadChatMarkdownFromClipboard(): Promise<string> {
		const commands = await vscode.commands.getCommands(true);
		const copyCommands = [
			'workbench.action.chat.copyResponse',
			'workbench.action.chat.copyLast',
			'workbench.action.chat.copy',
			'workbench.action.chat.copyAll',
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
					const agentMd = this.extractAgentResponse(copied);
					return this.markdownToHtml(agentMd);
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

	private async readFilePreview(uri: vscode.Uri, maxChars: number): Promise<string> {
		try {
			const raw = await vscode.workspace.fs.readFile(uri);
			return Buffer.from(raw).toString('utf-8').slice(0, maxChars).trim();
		} catch {
			return '';
		}
	}

	private async buildProjectsContextSnapshot(projects: string[] = []): Promise<string> {
		const workspaceFolders = vscode.workspace.workspaceFolders || [];
		if (workspaceFolders.length === 0) {
			return '';
		}

		const selected = new Set((projects || []).map(p => p.trim()).filter(Boolean));
		const targets = selected.size > 0
			? workspaceFolders.filter(folder => selected.has(folder.name))
			: workspaceFolders;

		const effectiveTargets = targets.length > 0 ? targets : workspaceFolders;
		const chunks: string[] = [];

		for (const folder of effectiveTargets.slice(0, 8)) {
			let topEntries: string[] = [];
			try {
				const entries = await vscode.workspace.fs.readDirectory(folder.uri);
				topEntries = entries
					.map(([name]) => name)
					.filter(Boolean)
					.sort((a, b) => a.localeCompare(b, 'ru', { sensitivity: 'base' }))
					.slice(0, 30);
			} catch {
				// ignore read errors for a specific folder
			}

			const readme = await this.readFilePreview(vscode.Uri.joinPath(folder.uri, 'README.md'), 1400);
			const packageJsonRaw = await this.readFilePreview(vscode.Uri.joinPath(folder.uri, 'package.json'), 1600);
			let packageSummary = '';
			if (packageJsonRaw) {
				try {
					const parsed = JSON.parse(packageJsonRaw) as Record<string, unknown>;
					const scripts = parsed.scripts && typeof parsed.scripts === 'object'
						? Object.keys(parsed.scripts as Record<string, unknown>).slice(0, 12)
						: [];
					const dependencies = parsed.dependencies && typeof parsed.dependencies === 'object'
						? Object.keys(parsed.dependencies as Record<string, unknown>).slice(0, 12)
						: [];
					packageSummary = [
						typeof parsed.name === 'string' ? `name: ${parsed.name}` : '',
						typeof parsed.description === 'string' ? `description: ${parsed.description}` : '',
						scripts.length ? `scripts: ${scripts.join(', ')}` : '',
						dependencies.length ? `deps: ${dependencies.join(', ')}` : '',
					].filter(Boolean).join('\n');
				} catch {
					packageSummary = packageJsonRaw.slice(0, 400);
				}
			}

			chunks.push([
				`Project: ${folder.name}`,
				topEntries.length ? `Top-level entries: ${topEntries.join(', ')}` : '',
				packageSummary ? `package.json summary:\n${packageSummary}` : '',
				readme ? `README excerpt:\n${readme}` : '',
			].filter(Boolean).join('\n'));
		}

		return chunks.join('\n\n---\n\n').slice(0, 6000);
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
				promptToSave.timeSpentOnTask = Math.max(promptToSave.timeSpentOnTask || 0, existingPrompt.timeSpentOnTask || 0);
				promptToSave.timeSpentUntracked = Number.isFinite(promptToSave.timeSpentUntracked)
					? Math.max(0, promptToSave.timeSpentUntracked || 0)
					: (existingPrompt.timeSpentUntracked || 0);
				promptToSave.chatSessionIds = (promptToSave.chatSessionIds && promptToSave.chatSessionIds.length > 0)
					? promptToSave.chatSessionIds
					: (existingPrompt.chatSessionIds || []);
			} else {
				promptToSave.timeSpentOnTask = Math.max(0, promptToSave.timeSpentOnTask || 0);
				promptToSave.timeSpentUntracked = Math.max(0, promptToSave.timeSpentUntracked || 0);
			}

			await this.storageService.savePrompt(promptToSave, {
				historyReason: 'switch',
				forceHistory: true,
			});
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
				void this.handleContentEditorSaved(document);
			}),
			vscode.workspace.onDidCloseTextDocument((document) => {
				void this.handleContentEditorClosed(document);
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

	private getAllowedBranchesSetting(): string[] {
		return GitService.getConfiguredAllowedBranches();
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

	private static readonly UNTITLED_PROMPT_TITLE = 'Промпт без названия';

	private static wordCount(text: string): number {
		return text.trim().split(/\s+/).filter(Boolean).length;
	}

	/** Check if description is a fallback (prefix of content, possibly truncated with '…') */
	private static isDescriptionFallback(description: string, content: string): boolean {
		const normalizedDesc = description.replace(/…$/, '').trim();
		const normalizedContent = content.replace(/\s+/g, ' ').trim();
		return normalizedContent.startsWith(normalizedDesc);
	}

	private makeTitleFallbackFromContent(content: string): string {
		const singleLine = content.replace(/\s+/g, ' ').trim();
		if (!singleLine) {
			return EditorPanelManager.UNTITLED_PROMPT_TITLE;
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
			// Auto-save new prompt before opening in external editor
			if (!currentPrompt.title) {
				currentPrompt.title = this.makeTitleFallbackFromContent(content || currentPrompt.content);
			}
			if (!currentPrompt.description) {
				currentPrompt.description = this.makeDescriptionFallbackFromContent(content || currentPrompt.content);
			}
			currentPrompt.id = await this.storageService.uniqueId(
				this.makePromptIdBase(currentPrompt.title, currentPrompt.description || content || currentPrompt.content)
			);
			currentPrompt.content = content || currentPrompt.content;
			const saved = await this.storageService.savePrompt(currentPrompt);

			// Update panel tracking from 'new-*' key to the real ID
			const panel = openPanels.get(panelKey);
			if (panel) {
				Object.assign(currentPrompt, saved);
				this.panelPromptRefs.set(panelKey, currentPrompt);

				if (panelKey.startsWith('new-')) {
					openPanels.delete(panelKey);
					openPanels.set(currentPrompt.id, panel);
					const dirtySetter = this.panelDirtySetters.get(panelKey);
					if (dirtySetter) {
						this.panelDirtySetters.delete(panelKey);
						this.panelDirtySetters.set(currentPrompt.id, dirtySetter);
					}
					const dirtyFlag = this.panelDirtyFlags.get(panelKey);
					this.panelDirtyFlags.delete(panelKey);
					this.panelDirtyFlags.set(currentPrompt.id, Boolean(dirtyFlag));
					const latestSnapshot = this.panelLatestPromptSnapshots.get(panelKey);
					this.panelLatestPromptSnapshots.delete(panelKey);
					this.panelLatestPromptSnapshots.set(currentPrompt.id, latestSnapshot ? JSON.parse(JSON.stringify(latestSnapshot)) : null);
					const basePrompt = this.panelBasePrompts.get(panelKey);
					this.panelBasePrompts.delete(panelKey);
					this.panelBasePrompts.set(currentPrompt.id, basePrompt ? JSON.parse(JSON.stringify(basePrompt)) : JSON.parse(JSON.stringify(currentPrompt)));
					this.rebindContentEditorPanelKey(panelKey, currentPrompt.id);
					panelKey = currentPrompt.id;
				}

				panel.title = `⚡ ${saved.title || saved.id}`;
				void panel.webview.postMessage({ type: 'promptSaved', prompt: saved });
				void panel.webview.postMessage({ type: 'prompt', prompt: currentPrompt, reason: 'save' });
			}

			this._onDidSave.fire(currentPrompt.id);
		}

		const panel = openPanels.get(panelKey);

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
			if (panel) {
				void panel.webview.postMessage({ type: 'contentEditorOpened' } satisfies ExtensionToWebviewMessage);
			}
			return;
		}

		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(fileUri.fsPath)));

		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));

		this.contentEditorByPanelKey.set(panelKey, { uri: fileUri, lastSyncedContent: content });
		this.panelKeyByContentEditorUri.set(fileUri.toString(), panelKey);
		this.contentEditorLastActivityByPanelKey.set(panelKey, Date.now());

		const doc = await vscode.workspace.openTextDocument(fileUri);
		await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });

		if (panel) {
			void panel.webview.postMessage({ type: 'contentEditorOpened' } satisfies ExtensionToWebviewMessage);
		}
	}

	private applyElapsedTimeByStatus(prompt: Prompt, elapsedMs: number): void {
		const deltaMs = Math.max(0, elapsedMs);
		if (deltaMs <= 0) {
			return;
		}

		if (prompt.status === 'in-progress') {
			prompt.timeSpentOnTask = (prompt.timeSpentOnTask || 0) + deltaMs;
			return;
		}

		prompt.timeSpentWriting = (prompt.timeSpentWriting || 0) + deltaMs;
	}

	private async ensurePromptSavedForExternalEditor(
		panelKey: string,
		currentPrompt: Prompt,
		postMessage: (message: ExtensionToWebviewMessage) => void,
		panel: vscode.WebviewPanel
	): Promise<void> {
		if (currentPrompt.id) {
			return;
		}

		if (!currentPrompt.title) {
			currentPrompt.title = this.makeTitleFallbackFromContent(currentPrompt.content || currentPrompt.report);
		}
		if (!currentPrompt.description) {
			currentPrompt.description = this.makeDescriptionFallbackFromContent(currentPrompt.content || currentPrompt.report);
		}
		currentPrompt.id = await this.storageService.uniqueId(
			this.makePromptIdBase(currentPrompt.title, currentPrompt.description || currentPrompt.content || currentPrompt.report)
		);

		const saved = await this.storageService.savePrompt(currentPrompt, { historyReason: 'manual' });

		Object.assign(currentPrompt, saved);
		this.panelPromptRefs.set(panelKey, currentPrompt);
		panel.title = `⚡ ${saved.title || saved.id}`;
		postMessage({ type: 'promptSaved', prompt: saved });
		postMessage({ type: 'prompt', prompt: currentPrompt, reason: 'save' });
		this._onDidSave.fire(currentPrompt.id);
	}

	private async openPromptReportInEditor(
		panelKey: string,
		currentPrompt: Prompt,
		postMessage: (message: ExtensionToWebviewMessage) => void,
		panel: vscode.WebviewPanel
	): Promise<void> {
		await this.ensurePromptSavedForExternalEditor(panelKey, currentPrompt, postMessage, panel);

		const promptId = (currentPrompt.id || '').trim();
		if (!promptId) {
			return;
		}

		const existingPanel = this.reportEditorPanels.get(promptId);
		if (existingPanel) {
			existingPanel.reveal(vscode.ViewColumn.Beside);
			void existingPanel.webview.postMessage({
				type: 'reportEditorInit',
				promptId,
				title: currentPrompt.title || currentPrompt.id,
				report: currentPrompt.report || '',
			} satisfies ExtensionToWebviewMessage);
			return;
		}

		const reportPanel = vscode.window.createWebviewPanel(
			'promptManager.reportEditor',
			`Результат: ${currentPrompt.title || currentPrompt.id}`,
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [this.extensionUri],
			}
		);

		reportPanel.webview.html = getWebviewHtml(
			reportPanel.webview,
			this.extensionUri,
			'dist/webview/reportEditor.js',
			'Prompt Manager Report Editor'
		);

		reportPanel.onDidDispose(() => {
			this.reportEditorPanels.delete(promptId);
		});

		reportPanel.webview.onDidReceiveMessage(async (msg: WebviewToExtensionMessage) => {
			switch (msg.type) {
				case 'reportEditorReady': {
					void reportPanel.webview.postMessage({
						type: 'reportEditorInit',
						promptId,
						title: currentPrompt.title || currentPrompt.id,
						report: currentPrompt.report || '',
					} satisfies ExtensionToWebviewMessage);
					break;
				}

				case 'reportEditorUpdate': {
					const targetPromptId = (msg.promptId || promptId).trim();
					if (!targetPromptId) {
						break;
					}

					const storedPrompt = await this.storageService.getPrompt(targetPromptId);
					if (!storedPrompt) {
						break;
					}

					storedPrompt.report = typeof msg.report === 'string' ? msg.report : '';
					this.applyElapsedTimeByStatus(storedPrompt, Number(msg.activityDeltaMs) || 0);
					const saved = await this.storageService.savePrompt(storedPrompt, {
						historyReason: 'autosave',
						skipHistory: true,
					});

					if (currentPrompt.id === targetPromptId) {
						currentPrompt.report = storedPrompt.report;
						currentPrompt.timeSpentWriting = Math.max(saved.timeSpentWriting || 0, currentPrompt.timeSpentWriting || 0);
						currentPrompt.timeSpentOnTask = Math.max(saved.timeSpentOnTask || 0, currentPrompt.timeSpentOnTask || 0);
						currentPrompt.updatedAt = saved.updatedAt || currentPrompt.updatedAt;
						this.panelPromptRefs.set(panelKey, currentPrompt);
						postMessage({
							type: 'reportContentUpdated',
							report: storedPrompt.report,
							timeSpentWriting: saved.timeSpentWriting,
							timeSpentOnTask: saved.timeSpentOnTask,
							updatedAt: saved.updatedAt,
						});
					}
					break;
				}

				default:
					break;
			}
		});

		this.reportEditorPanels.set(promptId, reportPanel);
	}

	/**
	 * Called when a text document tracked as a content editor is closed.
	 * If the user closed without saving, revert the webview content to the last saved version.
	 */
	private async handleContentEditorClosed(document: vscode.TextDocument): Promise<void> {
		const uriKey = document.uri.toString();
		const panelKey = this.panelKeyByContentEditorUri.get(uriKey);
		if (!panelKey) {
			return;
		}

		const panel = openPanels.get(panelKey);
		const binding = this.contentEditorByPanelKey.get(panelKey);

		// Read the saved content from file to determine if there was a revert
		let savedContent = '';
		try {
			const fileBytes = await vscode.workspace.fs.readFile(document.uri);
			savedContent = Buffer.from(fileBytes).toString('utf-8');
		} catch {
			// File may not exist anymore
		}

		const lastSyncedContent = binding?.lastSyncedContent ?? '';
		const reverted = lastSyncedContent !== savedContent;

		// Clean up binding
		this.clearContentEditorBinding(panelKey);

		if (panel) {
			void panel.webview.postMessage({
				type: 'contentEditorClosed',
				reverted,
				content: savedContent,
			} satisfies ExtensionToWebviewMessage);
		}
	}

	/**
	 * Called when a content editor document is saved.
	 * Notifies the webview to trigger a prompt save.
	 */
	private async handleContentEditorSaved(document: vscode.TextDocument): Promise<void> {
		const uriKey = document.uri.toString();
		const panelKey = this.panelKeyByContentEditorUri.get(uriKey);
		if (!panelKey) {
			return;
		}

		const panel = openPanels.get(panelKey);
		if (panel) {
			void panel.webview.postMessage({ type: 'contentEditorSaved' } satisfies ExtensionToWebviewMessage);
		}
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

		// Show loading overlay immediately so the user doesn't see stale data
		if (singletonPanel) {
			void singletonPanel.webview.postMessage({ type: 'promptLoading' });
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
			void singletonPanel.webview.postMessage({ type: 'prompt', prompt, reason: 'open' });
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
					dirtySnapshot.timeSpentOnTask = Math.max(0, dirtySnapshot.timeSpentOnTask || 0);
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
					// Validate: ignore stale markDirty from a previous prompt
					const markDirtyPromptId = (msg.promptId || msg.prompt?.id || '').trim();
					const currentPanelPromptId = (prompt.id || '').trim();
					if (markDirtyPromptId && currentPanelPromptId && markDirtyPromptId !== currentPanelPromptId) {
						return;
					}

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

				postMessage({ type: 'prompt', prompt: currentPrompt, reason: 'open' });

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

				const allowedBranches = this.getAllowedBranchesSetting();
				postMessage({ type: 'allowedBranches', branches: allowedBranches });

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

					const isUntitledWithEnoughContent = promptToSave.title === EditorPanelManager.UNTITLED_PROMPT_TITLE
						&& !!promptToSave.content
						&& EditorPanelManager.wordCount(promptToSave.content) > 10;
					const needsTitle = (!promptToSave.title || isUntitledWithEnoughContent) && !!promptToSave.content;
					const hasEnoughContentForDescription = !!promptToSave.content && EditorPanelManager.wordCount(promptToSave.content) > 10;
					const isFallbackDescription = !!promptToSave.description
						&& hasEnoughContentForDescription
						&& EditorPanelManager.isDescriptionFallback(promptToSave.description, promptToSave.content);
					const needsDescription = ((!promptToSave.description && hasEnoughContentForDescription) || isFallbackDescription);
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
						promptToSave.timeSpentOnTask = Math.max(promptToSave.timeSpentOnTask || 0, existingPrompt.timeSpentOnTask || 0);
						promptToSave.timeSpentUntracked = Number.isFinite(promptToSave.timeSpentUntracked)
							? Math.max(0, promptToSave.timeSpentUntracked || 0)
							: (existingPrompt.timeSpentUntracked || 0);
						promptToSave.chatSessionIds = (promptToSave.chatSessionIds && promptToSave.chatSessionIds.length > 0)
							? promptToSave.chatSessionIds
							: (existingPrompt.chatSessionIds || []);
					} else {
						promptToSave.timeSpentOnTask = Math.max(0, promptToSave.timeSpentOnTask || 0);
						promptToSave.timeSpentUntracked = Math.max(0, promptToSave.timeSpentUntracked || 0);
					}

					const saved = await this.storageService.savePrompt(promptToSave, {
						historyReason: saveSource,
					});

					const normalizedCurrentPromptId = (currentPrompt.id || '').trim();
					const shouldApplyToCurrentPanel = !normalizedCurrentPromptId || normalizedCurrentPromptId === promptToSave.id;

					if (shouldApplyToCurrentPanel) {
						setIsDirty(false);
						// Update current prompt reference
						Object.assign(currentPrompt, promptToSave);
						this.panelPromptRefs.set(panelKey, currentPrompt);
					}

					// Update panel tracking
					if (shouldApplyToCurrentPanel && panelKey.startsWith('new-')) {
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

					if (shouldApplyToCurrentPanel) {
						const stateKey = panelKey.startsWith('new-') ? promptToSave.id : panelKey;
						this.panelDirtyFlags.set(stateKey, false);
						this.panelLatestPromptSnapshots.set(stateKey, null);
						this.panelBasePrompts.set(stateKey, JSON.parse(JSON.stringify(promptToSave)));
					}

					if (shouldApplyToCurrentPanel) {
						panel.title = `⚡ ${saved.title || saved.id}`;
						postMessage({ type: 'promptSaved', prompt: saved });
						postMessage({ type: 'prompt', prompt: promptToSave, reason: 'save' });
					}
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

			case 'openPromptReportInEditor': {
				currentPrompt.report = typeof msg.report === 'string' ? msg.report : currentPrompt.report;
				await this.openPromptReportInEditor(panelKey, currentPrompt, postMessage, panel);
				break;
			}

			case 'showPromptHistory': {
				const promptId = (msg.id || currentPrompt.id || '').trim();
				if (!promptId) {
					postMessage({ type: 'error', message: 'Сначала сохраните промпт, затем откройте историю.' });
					break;
				}

				const history = await this.storageService.listPromptHistory(promptId);
				if (history.length === 0) {
					vscode.window.showInformationMessage('История для этого промпта пуста.');
					break;
				}

				const items = history.map(entry => {
					const when = new Date(entry.createdAt);
					const label = `${when.toLocaleString('ru-RU')} • ${entry.reason}`;
					return {
						label,
						description: entry.id,
						entryId: entry.id,
					};
				});

				const selected = await vscode.window.showQuickPick(items, {
					placeHolder: 'Выберите ревизию для полного восстановления',
					matchOnDescription: true,
				});

				if (!selected) {
					break;
				}

				const restored = await this.storageService.restorePromptHistory(promptId, selected.entryId);
				if (!restored) {
					postMessage({ type: 'error', message: 'Не удалось восстановить выбранную ревизию.' });
					break;
				}

				Object.assign(currentPrompt, restored);
				this.panelPromptRefs.set(panelKey, currentPrompt);
				setIsDirty(false);
				this.panelDirtyFlags.set(panelKey, false);
				this.panelLatestPromptSnapshots.set(panelKey, null);
				this.panelBasePrompts.set(panelKey, JSON.parse(JSON.stringify(restored)));
				panel.title = `⚡ ${restored.title || restored.id}`;
				postMessage({ type: 'prompt', prompt: restored, reason: 'open' });
				await this.broadcastAvailableLanguagesAndFrameworks();
				this._onDidSave.fire(restored.id);
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

			case 'improvePromptText': {
				const projectContext = await this.buildProjectsContextSnapshot(msg.projects || currentPrompt.projects || []);
				const improvedContent = await this.aiService.improvePromptText(msg.content, projectContext);
				postMessage({ type: 'improvedPromptText', content: improvedContent });
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
				const shouldForceRebindChat = msg.forceRebindChat === true;
				if (prompt && prompt.content) {
					// --- Branch mismatch check ---
					if (prompt.projects.length > 0) {
						const paths = this.workspaceService.getWorkspaceFolderPaths();
						const allowedBranches = this.getAllowedBranchesSetting();
						const mismatches = await this.gitService.getBranchMismatches(paths, prompt.projects, prompt.branch, allowedBranches);
						if (mismatches.length > 0) {
							const details = mismatches.map(m => `Ветка проекта ${m.project} переключена на ${m.currentBranch}`).join('\n');
							const answer = await vscode.window.showWarningMessage(
								details,
								{ modal: true },
								'Продолжить',
							);
							if (answer !== 'Продолжить') {
								postMessage({ type: 'chatStarted', promptId: prompt.id });
								break;
							}
						}
					}

					const bindSessionToPrompt = async (sessionId: string): Promise<void> => {
						const normalizedSessionId = (sessionId || '').trim();
						if (!normalizedSessionId) {
							return;
						}

						const promptFromStorage = await this.storageService.getPrompt(prompt.id);
						if (!promptFromStorage) {
							return;
						}

						const updatedChatSessionIds = shouldForceRebindChat
							? [normalizedSessionId]
							: [
								normalizedSessionId,
								...(promptFromStorage.chatSessionIds || []).filter(id => id !== normalizedSessionId),
							];
						const changed = JSON.stringify(updatedChatSessionIds) !== JSON.stringify(promptFromStorage.chatSessionIds || []);
						if (!changed) {
							return;
						}

						promptFromStorage.chatSessionIds = updatedChatSessionIds;
						await this.storageService.savePrompt(promptFromStorage, { historyReason: 'start-chat' });
						Object.assign(prompt, promptFromStorage);
						if (currentPrompt.id === promptFromStorage.id) {
							Object.assign(currentPrompt, promptFromStorage);
							postMessage({ type: 'prompt', prompt: promptFromStorage, reason: 'sync' });
						}
						this._onDidSave.fire(promptFromStorage.id);
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
						if (shouldForceRebindChat) {
							prompt.chatSessionIds = [];
						} else {
							prompt.chatSessionIds = prompt.chatSessionIds?.length ? prompt.chatSessionIds : (existingBeforeChat.chatSessionIds || []);
						}
					}
					await this.storageService.savePrompt(prompt, { historyReason: 'start-chat' });
					if (currentPrompt.id === prompt.id) {
						Object.assign(currentPrompt, prompt);
					}
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
						await this.storageService.savePrompt(prompt, { historyReason: 'status-change' });
						if (currentPrompt.id === prompt.id) {
							Object.assign(currentPrompt, prompt);
							setIsDirty(false);
							postMessage({ type: 'prompt', prompt, reason: 'sync' });
						}
						this._onDidSave.fire(prompt.id);
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

					const chatMode = prompt.chatMode || 'agent';
					const chatModeName = chatMode === 'agent' ? 'Agent' : 'Plan';

					// Open chat in the requested mode using mode-specific commands first
					const openChatCmds = chatMode === 'agent'
						? ['workbench.action.chat.openAgent', 'workbench.action.chat.open']
						: [`workbench.action.chat.open${chatModeName}`, 'workbench.action.chat.open'];
					let opened = false;
					for (const openCmd of openChatCmds) {
						try {
							if (openCmd === 'workbench.action.chat.open') {
								await vscode.commands.executeCommand(openCmd, { mode: chatModeName });
							} else {
								await vscode.commands.executeCommand(openCmd);
							}
							opened = true;
							break;
						} catch {
							// try next open command
						}
					}

					// Ensure correct mode via toggleAgentMode (accepts both id and name)
					if (opened) {
						try {
							await vscode.commands.executeCommand(
								'workbench.action.chat.toggleAgentMode',
								{ modeId: chatMode },
							);
						} catch {
							// best-effort mode switch
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
								const openArg: Record<string, unknown> = {
									query: message,
									modelSelector: requestModelSelector,
									mode: chatModeName,
								};
								await vscode.commands.executeCommand('workbench.action.chat.open', openArg);
								return;
							} catch {
								// fallback to compatibility variants
							}
						}

						const args: unknown[] = [
							{ query: message, mode: chatModeName },
							{ query: message },
							message,
							{ message },
							{ prompt: message },
						];

						if (requestModelIdentifier) {
							args.unshift(
								{ query: message, userSelectedModelId: requestModelIdentifier, mode: chatModeName },
								{ query: message, userSelectedModelId: requestModelIdentifier },
								{ query: message, modelId: requestModelIdentifier, mode: chatModeName },
								{ query: message, model: requestModelIdentifier, mode: chatModeName },
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
						if (shouldForceRebindChat) {
							await forceNewChatSession();
							await new Promise(resolve => setTimeout(resolve, 120));
						}

						if (prompt.model) {
							const storageModel = await this.aiService.resolveModelStorageIdentifier(prompt.model);
							requestModelIdentifier = storageModel || requestModelIdentifier;
							requestModelSelector = await this.aiService.resolveChatOpenModelSelector(prompt.model);
							await this.stateService.forcePersistChatCurrentLanguageModel(storageModel);
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
						// Immediately notify UI that chat has been opened so the button switches
						postMessage({ type: 'chatOpened', promptId: prompt.id });
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
									if (chatMarkdown && !(promptToComplete.report || '').trim()) {
										promptToComplete.report = chatMarkdown;
									}
									if (promptToComplete.status !== 'completed') {
										promptToComplete.status = 'completed';
									}
									await this.storageService.savePrompt(promptToComplete);
									if (currentPrompt.id === promptToComplete.id) {
										Object.assign(currentPrompt, promptToComplete);
										postMessage({ type: 'prompt', prompt: promptToComplete, reason: 'sync' });
									}
									this._onDidSave.fire(promptToComplete.id);
									// Recalc implementing time from JSONL after VS Code finishes writing session data
									const recalcPromptId = promptToComplete.id;
									setTimeout(async () => {
										try {
											const freshPrompt = await this.storageService.getPrompt(recalcPromptId);
											if (freshPrompt && (freshPrompt.chatSessionIds || []).length > 0) {
												const totalMs = await this.stateService.getChatSessionsTotalElapsed(freshPrompt.chatSessionIds);
												if (totalMs > 0) {
													freshPrompt.timeSpentImplementing = totalMs;
													await this.storageService.savePrompt(freshPrompt);
													if (currentPrompt.id === freshPrompt.id) {
														Object.assign(currentPrompt, freshPrompt);
														postMessage({ type: 'prompt', prompt: freshPrompt, reason: 'sync' });
													}
													this._onDidSave.fire(freshPrompt.id);
												}
											}
										} catch (e: any) {
											this.hooksOutput.appendLine(`[chat-track] recalc implementing time error: ${e?.message || e}`);
										}
									}, 3000);
								}

								this.hooksOutput.appendLine(`[chat-track] afterChatCompleted fired for prompt=${prompt.id}`);
								await this.runConfiguredHooks(prompt?.hooks || [], {
									event: 'afterChatCompleted',
									...hookPayloadBase,
									status: promptToComplete?.status || prompt.status,
									report: promptToComplete?.report || '',
									chatSessionId: trackedSessionId || '',
									timeSpentImplementing: promptToComplete?.timeSpentImplementing || 0,
								}, 'afterChatCompleted');
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
									if (!(promptForTiming.report || '').trim()) {
										promptForTiming.report = chatMarkdown;
									}
									await this.storageService.savePrompt(promptForTiming);
									if (currentPrompt.id === promptForTiming.id) {
										Object.assign(currentPrompt, promptForTiming);
										postMessage({ type: 'prompt', prompt: promptForTiming, reason: 'sync' });
									}
									this._onDidSave.fire(promptForTiming.id);
									// Recalc implementing time from JSONL (markdown fallback path)
									const recalcPromptId2 = promptForTiming.id;
									setTimeout(async () => {
										try {
											const freshPrompt = await this.storageService.getPrompt(recalcPromptId2);
											if (freshPrompt && (freshPrompt.chatSessionIds || []).length > 0) {
												const totalMs = await this.stateService.getChatSessionsTotalElapsed(freshPrompt.chatSessionIds);
												if (totalMs > 0) {
													freshPrompt.timeSpentImplementing = totalMs;
													await this.storageService.savePrompt(freshPrompt);
													if (currentPrompt.id === freshPrompt.id) {
														Object.assign(currentPrompt, freshPrompt);
														postMessage({ type: 'prompt', prompt: freshPrompt, reason: 'sync' });
													}
													this._onDidSave.fire(freshPrompt.id);
												}
											}
										} catch (e: any) {
											this.hooksOutput.appendLine(`[chat-track] recalc implementing time (fallback) error: ${e?.message || e}`);
										}
									}, 3000);
								}

								// Rename chat session in agent history (markdown fallback path)
								const sessionToRename2 = String(completion.sessionId || trackedSessionId || '').trim();
								if (sessionToRename2) {
									const latestPrompt2 = await this.storageService.getPrompt(prompt.id);
									const renameTitle2 = latestPrompt2?.taskNumber
										? `${latestPrompt2.taskNumber} | ${latestPrompt2.title}`
										: (latestPrompt2?.title || '');
									if (renameTitle2) {
										this.hooksOutput.appendLine(`[chat-rename] (fallback) scheduling rename session=${sessionToRename2} title="${renameTitle2}" (5s delay)`);
										setTimeout(() => {
											void this.stateService.renameChatSession(sessionToRename2, renameTitle2).then(r => {
												this.hooksOutput.appendLine(`[chat-rename] (fallback) result: ok=${r.ok} reason=${r.reason || '-'}`);
												if (r.ok) {
													void vscode.window.showInformationMessage(
														`Chat session renamed to "${renameTitle2}". Title will appear after window reload.`,
													);
												}
											}).catch(e => {
												this.hooksOutput.appendLine(`[chat-rename] (fallback) error: ${e?.message || e}`);
											});
										}, 5000);
									}
								}

								this.hooksOutput.appendLine(`[chat-track] afterChatCompleted fired via markdown fallback for prompt=${prompt.id}`);
								await this.runConfiguredHooks(prompt?.hooks || [], {
									event: 'afterChatCompleted',
									...hookPayloadBase,
									status: promptForTiming?.status || prompt.status,
									report: promptForTiming?.report || '',
									chatSessionId: trackedSessionId || '',
									timeSpentImplementing: promptForTiming?.timeSpentImplementing || 0,
								}, 'afterChatCompleted');
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
						if (currentPrompt.id === prompt.id) {
							Object.assign(currentPrompt, prompt);
							postMessage({ type: 'prompt', prompt, reason: 'sync' });
						}
					}
				}
				break;
			}

			case 'openChat': {
				if (msg.id) {
					const promptFromStorage = await this.storageService.getPrompt(msg.id);
					if (promptFromStorage) {
						// --- Branch mismatch check ---
						if (promptFromStorage.projects.length > 0) {
							const paths = this.workspaceService.getWorkspaceFolderPaths();
							const allowedBranches = this.getAllowedBranchesSetting();
							const mismatches = await this.gitService.getBranchMismatches(paths, promptFromStorage.projects, promptFromStorage.branch, allowedBranches);
							if (mismatches.length > 0) {
								const details = mismatches.map(m => `Ветка проекта ${m.project} переключена на ${m.currentBranch}`).join('\n');
								const answer = await vscode.window.showWarningMessage(
									details,
									{ modal: true },
									'Продолжить',
								);
								if (answer !== 'Продолжить') {
									break;
								}
							}
						}

						const existingSessionIds: string[] = [];
						for (const sessionId of promptFromStorage.chatSessionIds || []) {
							if (await this.stateService.hasChatSession(sessionId)) {
								existingSessionIds.push(sessionId);
							}
						}
						if (existingSessionIds.length !== (promptFromStorage.chatSessionIds || []).length) {
							promptFromStorage.chatSessionIds = existingSessionIds;
							await this.storageService.savePrompt(promptFromStorage);
							if (currentPrompt.id === promptFromStorage.id) {
								Object.assign(currentPrompt, promptFromStorage);
								postMessage({ type: 'prompt', prompt: promptFromStorage, reason: 'sync' });
							}
							this._onDidSave.fire(promptFromStorage.id);
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

			case 'openChatPanel': {
				try {
					await vscode.commands.executeCommand('workbench.action.chat.openAgent');
				} catch {
					try {
						await vscode.commands.executeCommand('workbench.action.chat.open');
					} catch {
						// ignore
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
				const allowedBranches = this.getAllowedBranchesSetting();
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
				const result = await this.gitService.switchBranch(paths, msg.projects, msg.branch, allowedBranches);
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

			case 'getNextTaskNumber': {
				const allPrompts = await this.storageService.listPrompts();
				const taskNumbers = allPrompts
					.map(p => p.taskNumber?.trim())
					.filter((v): v is string => Boolean(v));

				if (taskNumbers.length === 0) {
					postMessage({ type: 'nextTaskNumber', taskNumber: '1' });
					break;
				}

				// Extract prefix + numeric suffix from each task number
				const parsed = taskNumbers.map(tn => {
					const match = tn.match(/^(.*?)(\d+)$/);
					if (match) {
						return { prefix: match[1], num: parseInt(match[2], 10) };
					}
					return null;
				}).filter((v): v is { prefix: string; num: number } => v !== null);

				if (parsed.length === 0) {
					postMessage({ type: 'nextTaskNumber', taskNumber: '1' });
					break;
				}

				const prefixed = parsed.filter(item => item.prefix.length > 0);
				const candidates = prefixed.length > 0 ? prefixed : parsed;

				// Prefer real prefixes when they exist; otherwise keep numeric-only numbering.
				const prefixCounts = new Map<string, number>();
				for (const { prefix } of candidates) {
					prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
				}
				let bestPrefix = '';
				let bestCount = 0;
				for (const [prefix, count] of prefixCounts) {
					if (count > bestCount) {
						bestPrefix = prefix;
						bestCount = count;
					}
				}

				// Find max number among entries with the best prefix
				const maxNum = Math.max(...candidates
					.filter(p => p.prefix === bestPrefix)
					.map(p => p.num));

				postMessage({ type: 'nextTaskNumber', taskNumber: `${bestPrefix}${maxNum + 1}` });
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
				const allowedBranches = this.getAllowedBranchesSetting();
				const result = await this.gitService.createBranch(paths, msg.projects, msg.branch, allowedBranches);
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

			case 'recalcImplementingTime': {
				const prompt = await this.storageService.getPrompt(msg.id);
				if (!prompt) {
					postMessage({ type: 'error', message: 'Промпт не найден.' });
					break;
				}
				const sessionIds = prompt.chatSessionIds || [];
				if (sessionIds.length === 0) {
					postMessage({ type: 'error', message: 'У промпта нет привязанных чат-сессий.' });
					break;
				}
				try {
					const totalMs = await this.stateService.getChatSessionsTotalElapsed(sessionIds);
					if (totalMs <= 0) {
						postMessage({ type: 'error', message: 'Не удалось извлечь тайминги из истории чата. Файлы сессий могут быть недоступны.' });
						break;
					}
					prompt.timeSpentImplementing = totalMs;
					await this.storageService.savePrompt(prompt);
					if (currentPrompt.id === prompt.id) {
						Object.assign(currentPrompt, prompt);
						postMessage({ type: 'prompt', prompt, reason: 'sync' });
					}
					this._onDidSave.fire(prompt.id);
					postMessage({ type: 'implementingTimeRecalculated', id: prompt.id, timeMs: totalMs, sessionsCount: sessionIds.length });
				} catch (err: any) {
					postMessage({ type: 'error', message: `Ошибка при пересчёте: ${err?.message || err}` });
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
		for (const panel of this.reportEditorPanels.values()) {
			panel.dispose();
		}
		this.reportEditorPanels.clear();
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
