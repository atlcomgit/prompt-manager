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
import type { PromptVoiceService } from '../services/promptVoice/promptVoiceService.js';
import type { WorkspaceService } from '../services/workspaceService.js';
import type { ChatMemoryInstructionService } from '../services/chatMemoryInstructionService.js';
import type { CodeMapChatInstructionService } from '../codemap/codeMapChatInstructionService.js';
import { GitService } from '../services/gitService.js';
import type { StateService } from '../services/stateService.js';
import { TimeTrackingService } from '../services/timeTrackingService.js';
import { decideFileReportSync, isLatestPersistedReport } from '../utils/reportSync.js';
import { buildChatContextFiles } from '../utils/chatContextFiles.js';
import { getPromptManagerOutputChannel } from '../utils/promptManagerOutput.js';
import { appendPromptAiLog } from '../utils/promptAiLogger.js';
import { filterPromptHookIdsForPhase } from '../utils/promptHookPhase.js';

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
	private silentClosePanels = new Set<vscode.WebviewPanel>();
	private pendingRestorePrompt: Prompt | null = null;
	private pendingRestoreIsDirty = false;
	private readonly hooksOutput = getPromptManagerOutputChannel();
	private readonly reportDebugOutput = getPromptManagerOutputChannel();
	private contentEditorByPanelKey = new Map<string, { uri: vscode.Uri; lastSyncedContent: string }>();
	private panelKeyByContentEditorUri = new Map<string, string>();
	private contentEditorLastActivityByPanelKey = new Map<string, number>();
	private reportEditorByPanelKey = new Map<string, { uri: vscode.Uri; lastSyncedContent: string; lastModifiedMs: number | null }>();
	private panelKeyByReportEditorUri = new Map<string, string>();
	private reportEditorPanels = new Map<string, vscode.WebviewPanel>();
	private panelBootIds = new Map<string, string>();
	private pendingReportPersistByPromptId = new Map<string, Promise<Prompt | null>>();
	private contentSyncDisposables: vscode.Disposable[] = [];
	private openPromptQueue: Promise<void> | null = null;
	private pendingOpenPromptId: string | null = null;
	private openPromptRequestVersion = 0;
	private isShuttingDown = false;
	private readonly markdownRenderer = new MarkdownIt({
		html: false,
		linkify: true,
		breaks: false,
		typographer: false,
	});

	private syncStartupEditorRestoreState(): void {
		if (this.isShuttingDown) {
			return;
		}

		const promptId = (this.panelPromptRefs.get(SINGLE_EDITOR_PANEL_KEY)?.id || '').trim() || null;
		void this.stateService.saveStartupEditorRestoreState(Boolean(openPanels.get(SINGLE_EDITOR_PANEL_KEY)), promptId);
	}

	private setPanelPromptRef(panelKey: string, prompt: Prompt): void {
		this.panelPromptRefs.set(panelKey, prompt);
		if (panelKey === SINGLE_EDITOR_PANEL_KEY) {
			this.syncStartupEditorRestoreState();
		}
	}

	prepareForShutdown(): void {
		this.isShuttingDown = true;
		const promptId = (this.panelPromptRefs.get(SINGLE_EDITOR_PANEL_KEY)?.id || '').trim() || null;
		void this.stateService.saveStartupEditorRestoreState(Boolean(openPanels.get(SINGLE_EDITOR_PANEL_KEY)), promptId);
	}

	private async runConfiguredHooks(
		hookIds: string[],
		payload: Record<string, unknown>,
		phase: 'beforeChat' | 'afterChat' | 'chatError' | 'afterChatCompleted'
	): Promise<void> {
		const selected = filterPromptHookIdsForPhase(
			(hookIds || []).map(h => h.trim()).filter(Boolean),
			phase,
		);
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

	private reportDebugPreview(value: unknown, maxLength: number = 120): string {
		const text = typeof value === 'string'
			? value
			: JSON.stringify(value ?? null);
		const normalized = String(text || '').replace(/\s+/g, ' ').trim();
		if (normalized.length <= maxLength) {
			return normalized;
		}
		return `${normalized.slice(0, maxLength - 1)}…`;
	}

	private logReportDebug(event: string, payload?: Record<string, unknown>): void {
		if (!this.isDebugLoggingEnabled()) {
			return;
		}
		const timestamp = new Date().toISOString();
		const serializedPayload = payload ? ` ${JSON.stringify(payload)}` : '';
		this.reportDebugOutput.appendLine(`[${timestamp}] [report-debug] ${event}${serializedPayload}`);
	}

	private isDebugLoggingEnabled(): boolean {
		return vscode.workspace
			.getConfiguration('promptManager')
			.get<boolean>('debugLogging.enabled', false) === true;
	}

	private extractAgentResponse(chatText: string): string {
		const text = (chatText || '').replace(/\r\n?/g, '\n').trim();
		if (!text) {
			return '';
		}

		type ChatSpeaker = 'assistant' | 'user' | 'other';
		const assistantInlinePatterns = [
			/^\s*(?:#{1,6}\s*)?(?:GitHub Copilot|Copilot)\s*:\s*(.+)$/i,
		];
		const userInlinePatterns = [
			/^\s*(?:#{1,6}\s*)?(?:You|User|Me)\s*:\s*(.+)$/i,
			/^\s*(?:#{1,6}\s*)?(?:Вы|Пользователь)\s*:\s*(.+)$/i,
		];
		const assistantMarkerPatterns = [
			/^\s*(?:#{1,6}\s*)?(?:GitHub Copilot|Copilot)\s*:??\s*$/i,
		];
		const userMarkerPatterns = [
			/^\s*(?:#{1,6}\s*)?(?:You|User|Me)\s*:??\s*$/i,
			/^\s*(?:#{1,6}\s*)?(?:Вы|Пользователь)\s*:??\s*$/i,
		];

		const sections: Array<{ speaker: ChatSpeaker; content: string }> = [];
		let currentSpeaker: ChatSpeaker = 'other';
		let currentLines: string[] = [];

		const flushSection = (): void => {
			const content = currentLines.join('\n').trim();
			if (!content) {
				currentLines = [];
				return;
			}
			sections.push({ speaker: currentSpeaker, content });
			currentLines = [];
		};

		for (const line of text.split('\n')) {
			const assistantInline = assistantInlinePatterns
				.map(pattern => line.match(pattern))
				.find(Boolean);
			if (assistantInline) {
				flushSection();
				currentSpeaker = 'assistant';
				currentLines = [assistantInline[1]];
				continue;
			}

			const userInline = userInlinePatterns
				.map(pattern => line.match(pattern))
				.find(Boolean);
			if (userInline) {
				flushSection();
				currentSpeaker = 'user';
				currentLines = [userInline[1]];
				continue;
			}

			if (assistantMarkerPatterns.some(pattern => pattern.test(line))) {
				flushSection();
				currentSpeaker = 'assistant';
				continue;
			}

			if (userMarkerPatterns.some(pattern => pattern.test(line))) {
				flushSection();
				currentSpeaker = 'user';
				continue;
			}

			currentLines.push(line);
		}

		flushSection();

		const latestAssistantSection = [...sections]
			.reverse()
			.find(section => section.speaker === 'assistant' && section.content.trim());
		if (latestAssistantSection) {
			return latestAssistantSection.content.trim();
		}

		return text;
	}

	private reportHtmlToText(reportHtml: string): string {
		const html = (reportHtml || '').trim();
		if (!html) {
			return '';
		}

		return html
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<li\b[^>]*>/gi, '- ')
			.replace(/<\/(?:p|div|section|article|li|ul|ol|h[1-6]|blockquote|pre|tr|table)>/gi, '\n')
			.replace(/<[^>]+>/g, '')
			.replace(/&nbsp;/gi, ' ')
			.replace(/&amp;/gi, '&')
			.replace(/&lt;/gi, '<')
			.replace(/&gt;/gi, '>')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
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

	private async tryReadChatMarkdownFromClipboard(): Promise<{ markdown: string; html: string }> {
		const commands = await vscode.commands.getCommands(true);
		const copyCommands = [
			'workbench.action.chat.copyResponse',
			'workbench.action.chat.copyLast',
			'workbench.action.chat.copy',
			'workbench.action.chat.copyAll',
		].filter(cmd => commands.includes(cmd));

		if (copyCommands.length === 0) {
			return { markdown: '', html: '' };
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
					return {
						markdown: agentMd,
						html: this.markdownToHtml(agentMd),
					};
				}
			} catch {
				// try next copy command
			}
		}

		await vscode.env.clipboard.writeText(originalClipboard);
		return { markdown: '', html: '' };
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

	private buildPreparedCommitContext(projects: Awaited<ReturnType<GitService['getPreparedCommitProjectData']>>): string {
		const MAX_DIFF_CHARS_PER_PROJECT = 12000;
		const MAX_TOTAL_CHARS = 28000;
		const sanitizeDiffForReportContext = (diff: string): string => diff
			.split('\n')
			.filter(line => !/^diff --git\s/.test(line))
			.filter(line => !/^index\s/.test(line))
			.filter(line => !/^---\s/.test(line))
			.filter(line => !/^\+\+\+\s/.test(line))
			.filter(line => !/^rename from\s/.test(line))
			.filter(line => !/^rename to\s/.test(line))
			.filter(line => !/^similarity index\s/.test(line))
			.filter(line => !/^new file mode\s/.test(line))
			.filter(line => !/^deleted file mode\s/.test(line))
			.join('\n')
			.trim();
		const sections = projects.map((project) => {
			const statusCounts = project.stagedFiles.reduce<Record<string, number>>((acc, file) => {
				acc[file.status] = (acc[file.status] || 0) + 1;
				return acc;
			}, {});
			const changeSummary = Object.entries(statusCounts)
				.map(([status, count]) => `${status}: ${count}`)
				.join(', ');
			const sanitizedDiff = sanitizeDiffForReportContext(project.diff);
			const trimmedDiff = sanitizedDiff.length > MAX_DIFF_CHARS_PER_PROJECT
				? `${sanitizedDiff.slice(0, MAX_DIFF_CHARS_PER_PROJECT)}\n...[diff truncated]`
				: sanitizedDiff;

			return [
				`Project: ${project.project}`,
				`Branch: ${project.branch || 'unknown'}`,
				`Change source: ${project.changeSource === 'staged' ? 'staged changes' : 'working tree changes'}`,
				`Changed items: ${project.stagedFiles.length}`,
				changeSummary ? `Change types: ${changeSummary}` : '',
				trimmedDiff ? `Code changes:\n${trimmedDiff}` : '',
			].filter(Boolean).join('\n');
		});

		return sections.join('\n\n---\n\n').slice(0, MAX_TOTAL_CHARS);
	}

	private async generateReportHtmlFromPrompt(promptSnapshot: Prompt): Promise<string> {
		const projectPaths = this.workspaceService.getWorkspaceFolderPaths();
		const selectedProjects = promptSnapshot.projects && promptSnapshot.projects.length > 0
			? promptSnapshot.projects
			: this.workspaceService.getWorkspaceFolders();
		const stagedProjects = await this.gitService.getPreparedCommitProjectData(projectPaths, selectedProjects);

		if (stagedProjects.length === 0) {
			throw new Error('Не найдено подготовленных к коммиту файлов или изменений рабочего дерева в выбранных проектах.');
		}

		const stagedChangesSummary = this.buildPreparedCommitContext(stagedProjects);
		const generatedReportMarkdown = await this.aiService.generateImplementationReport({
			promptTitle: promptSnapshot.title,
			taskNumber: promptSnapshot.taskNumber,
			projects: selectedProjects,
			languages: promptSnapshot.languages,
			frameworks: promptSnapshot.frameworks,
			promptContent: promptSnapshot.content,
			stagedChangesSummary,
		});

		return this.markdownToHtml(generatedReportMarkdown);
	}

	private async broadcastAvailableLanguagesAndFrameworks(
		extraSources: Array<Pick<Prompt, 'languages' | 'frameworks'>> = []
	): Promise<void> {
		const { languagesMessage, frameworksMessage } = await this.buildAvailableLanguagesAndFrameworksMessages(extraSources);

		for (const panel of openPanels.values()) {
			void panel.webview.postMessage(languagesMessage);
			void panel.webview.postMessage(frameworksMessage);
		}
	}

	private async buildAvailableLanguagesAndFrameworksMessages(
		extraSources: Array<Pick<Prompt, 'languages' | 'frameworks'>> = []
	): Promise<{
		languagesMessage: ExtensionToWebviewMessage;
		frameworksMessage: ExtensionToWebviewMessage;
	}> {
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

		return {
			languagesMessage,
			frameworksMessage,
		};
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

	private isStalePromptMessage(
		currentPrompt: Pick<Prompt, 'id' | 'promptUuid'>,
		incomingPrompt?: Partial<Pick<Prompt, 'id' | 'promptUuid'>> | null,
		incomingPromptId?: string,
	): boolean {
		const currentPromptUuid = (currentPrompt.promptUuid || '').trim();
		const incomingPromptUuid = (incomingPrompt?.promptUuid || '').trim();
		if (currentPromptUuid && incomingPromptUuid && currentPromptUuid !== incomingPromptUuid) {
			return true;
		}

		const currentPromptId = (currentPrompt.id || '').trim();
		const normalizedIncomingPromptId = (incomingPromptId || incomingPrompt?.id || '').trim();
		if (currentPromptId && normalizedIncomingPromptId && currentPromptId !== normalizedIncomingPromptId) {
			return true;
		}

		return false;
	}

	private mergeExternalReportIfUnchanged(snapshot: Prompt, persistedPrompt: Prompt | null, basePrompt: Prompt | null): void {
		if (!persistedPrompt || !basePrompt) {
			return;
		}

		const baseReport = basePrompt.report || '';
		if (snapshot.report === baseReport && persistedPrompt.report !== baseReport) {
			snapshot.report = persistedPrompt.report;
		}
	}

	private async refreshReportBindingFromDisk(panelKey: string): Promise<{ content: string; lastModifiedMs: number | null } | null> {
		const binding = this.reportEditorByPanelKey.get(panelKey);
		if (!binding) {
			return null;
		}

		let currentMtime: number | null = null;
		try {
			const stat = await vscode.workspace.fs.stat(binding.uri);
			currentMtime = typeof stat.mtime === 'number' ? stat.mtime : null;
		} catch {
			currentMtime = null;
		}

		if (binding.lastModifiedMs !== currentMtime) {
			await this.syncPromptReportFromFileUri(binding.uri);
		}

		const updatedBinding = this.reportEditorByPanelKey.get(panelKey);
		if (!updatedBinding) {
			return { content: '', lastModifiedMs: currentMtime };
		}

		return {
			content: updatedBinding.lastSyncedContent,
			lastModifiedMs: updatedBinding.lastModifiedMs,
		};
	}

	private async guardReportOverwriteBeforeSave(
		panelKey: string | undefined,
		promptToSave: Prompt,
		baseSnapshot: Prompt | null,
	): Promise<void> {
		if (!panelKey || !baseSnapshot || !promptToSave.id) {
			return;
		}

		const bindingState = await this.refreshReportBindingFromDisk(panelKey);
		if (!bindingState) {
			return;
		}

		const baseReport = baseSnapshot.report || '';
		const localReport = promptToSave.report || '';
		const externalReport = bindingState.content || '';
		const localChanged = localReport !== baseReport;
		const externalChanged = externalReport !== baseReport;

		if (!externalChanged) {
			return;
		}

		if (!localChanged) {
			promptToSave.report = externalReport;
			return;
		}

		if (localReport !== externalReport) {
			throw new Error('REPORT_CONFLICT');
		}
	}

	private async reconcileReportWithExtensionState(
		panelKey: string | undefined,
		promptToSave: Prompt,
		currentPrompt: Prompt,
	): Promise<void> {
		if (!panelKey) {
			return;
		}

		const bindingState = await this.refreshReportBindingFromDisk(panelKey);
		const diskReport = bindingState?.content;
		const extensionReport = this.panelPromptRefs.get(panelKey)?.report ?? currentPrompt.report;
		const nextReport = promptToSave.report || '';
		const hasLocalReportChange = nextReport !== (extensionReport || '');

		if (!diskReport) {
			return;
		}

		if (!hasLocalReportChange && extensionReport === diskReport && nextReport !== diskReport) {
			promptToSave.report = diskReport;
		}
	}

	private enqueueReportPersist(targetPromptId: string, task: () => Promise<Prompt | null>): Promise<Prompt | null> {
		const previousTask = this.pendingReportPersistByPromptId.get(targetPromptId) || Promise.resolve(null);
		const nextTask = previousTask
			.catch(() => null)
			.then(task)
			.finally(() => {
				if (this.pendingReportPersistByPromptId.get(targetPromptId) === nextTask) {
					this.pendingReportPersistByPromptId.delete(targetPromptId);
				}
			});

		this.pendingReportPersistByPromptId.set(targetPromptId, nextTask);
		return nextTask;
	}

	private async awaitPendingReportPersist(promptId?: string): Promise<void> {
		const normalizedPromptId = (promptId || '').trim();
		if (!normalizedPromptId) {
			return;
		}

		const pendingTask = this.pendingReportPersistByPromptId.get(normalizedPromptId);
		if (!pendingTask) {
			return;
		}

		await pendingTask.catch(() => null);
	}

	private async persistPromptSnapshotForSwitch(snapshot: Prompt, baseSnapshot?: Prompt | null, panelKey?: string): Promise<Prompt | null> {
		const promptToSave: Prompt = JSON.parse(JSON.stringify(snapshot));
		const saveStateId = (promptToSave.id || '__new__').trim() || '__new__';
		const previousPromptId = (promptToSave.id || '').trim() || undefined;
		if (!promptToSave.id && !this.hasPromptDataWithoutId(promptToSave)) {
			return null;
		}

		await this.awaitPendingReportPersist(promptToSave.id);

		this._onDidSaveStateChange.fire({ id: saveStateId, saving: true });
		try {

			if (!promptToSave.title && promptToSave.content) {
				promptToSave.title = await this.aiService.generateTitle(promptToSave.content);
			}
			if (!promptToSave.description && promptToSave.content) {
				promptToSave.description = await this.aiService.generateDescription(promptToSave.content);
			}
			const renameFromId = await this.ensurePromptIdMatchesTitle(promptToSave, previousPromptId);
			await this.guardReportOverwriteBeforeSave(panelKey, promptToSave, baseSnapshot || null);

			const existingPrompt = await this.storageService.getPrompt(renameFromId || promptToSave.id);
			this.mergeExternalReportIfUnchanged(promptToSave, existingPrompt, baseSnapshot || null);
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
				previousId: renameFromId,
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
		private readonly promptVoiceService: PromptVoiceService,
		private readonly getChatMemoryInstructionService?: () => ChatMemoryInstructionService | undefined,
		private readonly getCodeMapChatInstructionService?: () => CodeMapChatInstructionService | undefined,
	) {
		this.contentSyncDisposables.push(
			vscode.workspace.onDidChangeTextDocument((event) => {
				void this.syncPromptContentFromEditorDocument(event.document);
				if (this.panelKeyByReportEditorUri.has(event.document.uri.toString())) {
					void this.syncPromptReportFromDocument(event.document);
				}
			}),
			vscode.workspace.onDidSaveTextDocument((document) => {
				void this.syncPromptContentFromEditorDocument(document);
				if (this.panelKeyByReportEditorUri.has(document.uri.toString())) {
					void this.syncPromptReportFromDocument(document);
				}
				void this.handleContentEditorSaved(document);
			}),
			vscode.workspace.onDidCloseTextDocument((document) => {
				void this.handleContentEditorClosed(document);
			})
		);

		const reportWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(this.storageService.getStorageDirectoryPath(), '*/report.txt')
		);
		this.contentSyncDisposables.push(
			reportWatcher,
			reportWatcher.onDidCreate((uri) => {
				void this.syncPromptReportFromFileUri(uri);
			}),
			reportWatcher.onDidChange((uri) => {
				void this.syncPromptReportFromFileUri(uri);
			}),
			reportWatcher.onDidDelete((uri) => {
				void this.syncPromptReportFromFileUri(uri, '');
			})
		);
	}

	private chatMemoryInstructionService(): ChatMemoryInstructionService | undefined {
		return this.getChatMemoryInstructionService?.();
	}

	private codeMapChatInstructionService(): CodeMapChatInstructionService | undefined {
		return this.getCodeMapChatInstructionService?.();
	}

	private shouldCaptureAgentFinalResponse(): boolean {
		return vscode.workspace
			.getConfiguration('promptManager')
			.get<boolean>('captureAgentFinalResponse', false) === true;
	}

	private ensureContentEditorBinding(panelKey: string, prompt: Prompt): void {
		if (!prompt.id) {
			this.clearContentEditorBinding(panelKey);
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

	private ensureReportEditorBinding(panelKey: string, prompt: Prompt): void {
		if (!prompt.id) {
			this.clearReportEditorBinding(panelKey);
			return;
		}

		const fileUri = this.storageService.getPromptReportUri(prompt.id);
		const fileUriKey = fileUri.toString();
		const openDocument = vscode.workspace.textDocuments.find(d => d.uri.toString() === fileUriKey);
		const actualContent = openDocument ? openDocument.getText() : prompt.report;

		const existingBinding = this.reportEditorByPanelKey.get(panelKey);
		if (existingBinding && existingBinding.uri.toString() !== fileUriKey) {
			this.panelKeyByReportEditorUri.delete(existingBinding.uri.toString());
		}

		this.reportEditorByPanelKey.set(panelKey, {
			uri: fileUri,
			lastSyncedContent: actualContent,
			lastModifiedMs: null,
		});
		this.panelKeyByReportEditorUri.set(fileUriKey, panelKey);

		if (prompt.report !== actualContent) {
			prompt.report = actualContent;
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

	private rebindReportEditorPanelKey(oldKey: string, newKey: string): void {
		const binding = this.reportEditorByPanelKey.get(oldKey);
		if (!binding) {
			return;
		}
		this.reportEditorByPanelKey.delete(oldKey);
		this.reportEditorByPanelKey.set(newKey, binding);
		this.panelKeyByReportEditorUri.set(binding.uri.toString(), newKey);
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

	private clearReportEditorBinding(panelKey: string): void {
		const binding = this.reportEditorByPanelKey.get(panelKey);
		if (!binding) {
			return;
		}
		this.panelKeyByReportEditorUri.delete(binding.uri.toString());
		this.reportEditorByPanelKey.delete(panelKey);
	}

	private sanitizePromptSlugPart(value: string): string {
		return (value || '')
			.toLowerCase()
			.replace(/[\s_]+/g, '-')
			.replace(/[^a-zа-я0-9-]/gi, '')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '');
	}

	private makePromptIdBase(taskNumber: string, title: string, description: string): string {
		const titlePart = this.sanitizePromptSlugPart(title || description || '');
		const taskPart = this.sanitizePromptSlugPart(taskNumber || '');
		const combined = [taskPart, titlePart].filter(Boolean).join('-');
		const normalized = combined
			.substring(0, 40)
			.replace(/-+$/g, '');
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

	private async ensurePromptIdMatchesTitle(promptToSave: Prompt, previousId?: string): Promise<string | undefined> {
		const normalizedPreviousId = (previousId || promptToSave.id || '').trim() || undefined;
		const slugSource = (promptToSave.title || promptToSave.description || promptToSave.content || promptToSave.report || '').trim();

		if (!slugSource) {
			if (normalizedPreviousId) {
				promptToSave.id = normalizedPreviousId;
				return undefined;
			}

			promptToSave.id = await this.storageService.uniqueId('untitled');
			return undefined;
		}

		const nextId = await this.storageService.uniqueId(
			this.makePromptIdBase(promptToSave.taskNumber, promptToSave.title, promptToSave.description || promptToSave.content || promptToSave.report),
			normalizedPreviousId,
		);
		promptToSave.id = nextId;

		return normalizedPreviousId && normalizedPreviousId !== nextId ? normalizedPreviousId : undefined;
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

	private areAvailableModelsEqual(
		left: Array<{ id: string; name: string }>,
		right: Array<{ id: string; name: string }>,
	): boolean {
		if (left.length !== right.length) {
			return false;
		}

		return left.every((model, index) => {
			const other = right[index];
			return model.id === other?.id && model.name === other?.name;
		});
	}

	private isReadyCycleActive(panelKey: string, currentPrompt: Prompt, readyBootId: string): boolean {
		const activePromptRef = this.panelPromptRefs.get(panelKey);
		if (activePromptRef !== currentPrompt) {
			return false;
		}

		const activeBootId = (this.panelBootIds.get(panelKey) || '').trim();
		if (readyBootId && activeBootId && readyBootId !== activeBootId) {
			return false;
		}

		return true;
	}

	private scheduleAvailableModelsRefreshAfterReady(
		panelKey: string,
		panel: vscode.WebviewPanel,
		currentPrompt: Prompt,
		readyBootId: string,
		initialModels: Array<{ id: string; name: string }>,
	): void {
		if (initialModels.length > 1) {
			return;
		}

		const delaysMs = [1500, 5000];
		let lastModels = [...initialModels];

		for (const delayMs of delaysMs) {
			setTimeout(() => {
				void (async () => {
					if (!this.isReadyCycleActive(panelKey, currentPrompt, readyBootId)) {
						return;
					}

					const refreshedModels = await this.aiService.getAvailableModels();
					if (!this.isReadyCycleActive(panelKey, currentPrompt, readyBootId)) {
						return;
					}

					if (this.areAvailableModelsEqual(lastModels, refreshedModels)) {
						return;
					}

					lastModels = [...refreshedModels];
					try {
						await panel.webview.postMessage({ type: 'availableModels', models: refreshedModels } satisfies ExtensionToWebviewMessage);
					} catch {
						// panel/webview might be disposed; ignore
					}
				})();
			}, delayMs);
		}
	}

	private formatSaveConflictMessage(error: unknown): string {
		if (error instanceof Error && error.message === 'REPORT_CONFLICT') {
			return 'Отчет был изменен во внешнем файле. Сохранение отменено, чтобы не перезаписать внешние правки.';
		}

		return error instanceof Error ? error.message : String(error);
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

	private async syncPromptReportFromDocument(document: vscode.TextDocument): Promise<void> {
		await this.syncPromptReportFromFileUri(document.uri, document.getText());
	}

	private async syncPromptReportFromFileUri(uri: vscode.Uri, reportOverride?: string): Promise<void> {
		const uriKey = uri.toString();
		const panelKey = this.panelKeyByReportEditorUri.get(uriKey);
		if (!panelKey) {
			return;
		}

		const binding = this.reportEditorByPanelKey.get(panelKey);
		if (!binding) {
			this.logReportDebug('syncPromptReportFromFileUri.skip.noBinding', { panelKey, uri: uri.fsPath });
			return;
		}

		let report = typeof reportOverride === 'string' ? reportOverride : '';
		if (reportOverride === undefined) {
			const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uriKey);
			if (openDocument) {
				report = openDocument.getText();
			} else {
				try {
					const fileBytes = await vscode.workspace.fs.readFile(uri);
					report = Buffer.from(fileBytes).toString('utf-8');
				} catch {
					report = '';
				}
			}
		}

		const previousSyncedReport = binding.lastSyncedContent;
		const promptRef = this.panelPromptRefs.get(panelKey);
		const basePrompt = this.panelBasePrompts.get(panelKey);
		const latestSnapshot = this.panelLatestPromptSnapshots.get(panelKey);
		const syncDecision = decideFileReportSync({
			previousSyncedReport,
			incomingReport: report,
			baseReport: basePrompt?.report || '',
			localReport: latestSnapshot?.report ?? promptRef?.report ?? '',
		});
		if (syncDecision === 'skip-same-content') {
			this.logReportDebug('syncPromptReportFromFileUri.skip.sameContent', {
				panelKey,
				uri: uri.fsPath,
				reportLength: report.length,
			});
			return;
		}

		binding.lastSyncedContent = report;
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			binding.lastModifiedMs = typeof stat.mtime === 'number' ? stat.mtime : null;
		} catch {
			binding.lastModifiedMs = null;
		}

		const baseReport = basePrompt?.report || '';
		const localReport = latestSnapshot?.report ?? promptRef?.report ?? '';
		if (syncDecision === 'skip-local-changes') {
			this.logReportDebug('syncPromptReportFromFileUri.skip.localChanges', {
				panelKey,
				uri: uri.fsPath,
				baseLength: baseReport.length,
				localLength: localReport.length,
				incomingLength: report.length,
				localPreview: this.reportDebugPreview(localReport),
				incomingPreview: this.reportDebugPreview(report),
			});
			return;
		}

		this.logReportDebug('syncPromptReportFromFileUri.apply', {
			panelKey,
			uri: uri.fsPath,
			previousLength: previousSyncedReport.length,
			incomingLength: report.length,
			incomingPreview: this.reportDebugPreview(report),
		});

		if (promptRef && promptRef.report !== report) {
			promptRef.report = report;
		}

		if (basePrompt && !this.panelDirtyFlags.get(panelKey)) {
			basePrompt.report = report;
		}

		if (latestSnapshot && (latestSnapshot.report || '') === (previousSyncedReport || '')) {
			latestSnapshot.report = report;
		}

		const panel = openPanels.get(panelKey);
		if (panel) {
			void panel.webview.postMessage({
				type: 'reportContentUpdated',
				report,
			} satisfies ExtensionToWebviewMessage);
		}

		const promptId = (promptRef?.id || '').trim();
		if (promptId) {
			const reportPanel = this.reportEditorPanels.get(promptId);
			if (reportPanel) {
				void reportPanel.webview.postMessage({
					type: 'reportEditorExternalUpdate',
					report,
				} satisfies ExtensionToWebviewMessage);
			}
		}
	}

	private async refreshPromptReportForPanel(panelKey: string, panel: vscode.WebviewPanel): Promise<void> {
		const promptRef = this.panelPromptRefs.get(panelKey);
		const promptId = (promptRef?.id || '').trim();
		if (!promptRef || !promptId) {
			return;
		}

		const persistedPrompt = await this.storageService.getPrompt(promptId);
		if (!persistedPrompt) {
			return;
		}

		const basePrompt = this.panelBasePrompts.get(panelKey) || null;
		const latestSnapshot = this.panelLatestPromptSnapshots.get(panelKey) || null;
		const baseReport = basePrompt?.report || '';
		const latestReport = latestSnapshot?.report ?? promptRef.report ?? '';
		const hasLocalReportChanges = latestReport !== baseReport;

		if (hasLocalReportChanges && latestReport !== persistedPrompt.report) {
			return;
		}

		promptRef.report = persistedPrompt.report;
		promptRef.timeSpentWriting = Math.max(promptRef.timeSpentWriting || 0, persistedPrompt.timeSpentWriting || 0);
		promptRef.timeSpentOnTask = Math.max(promptRef.timeSpentOnTask || 0, persistedPrompt.timeSpentOnTask || 0);
		promptRef.updatedAt = persistedPrompt.updatedAt || promptRef.updatedAt;

		if (basePrompt) {
			basePrompt.report = persistedPrompt.report;
			basePrompt.timeSpentWriting = Math.max(basePrompt.timeSpentWriting || 0, persistedPrompt.timeSpentWriting || 0);
			basePrompt.timeSpentOnTask = Math.max(basePrompt.timeSpentOnTask || 0, persistedPrompt.timeSpentOnTask || 0);
			basePrompt.updatedAt = persistedPrompt.updatedAt || basePrompt.updatedAt;
		}

		if (latestSnapshot && latestSnapshot.report === baseReport) {
			latestSnapshot.report = persistedPrompt.report;
			latestSnapshot.timeSpentWriting = Math.max(latestSnapshot.timeSpentWriting || 0, persistedPrompt.timeSpentWriting || 0);
			latestSnapshot.timeSpentOnTask = Math.max(latestSnapshot.timeSpentOnTask || 0, persistedPrompt.timeSpentOnTask || 0);
			latestSnapshot.updatedAt = persistedPrompt.updatedAt || latestSnapshot.updatedAt;
		}

		this.ensureReportEditorBinding(panelKey, promptRef);
		void panel.webview.postMessage({
			type: 'reportContentUpdated',
			report: persistedPrompt.report,
			timeSpentWriting: persistedPrompt.timeSpentWriting,
			timeSpentOnTask: persistedPrompt.timeSpentOnTask,
			updatedAt: persistedPrompt.updatedAt,
		} satisfies ExtensionToWebviewMessage);
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
				this.makePromptIdBase(currentPrompt.taskNumber, currentPrompt.title, currentPrompt.description || content || currentPrompt.content)
			);
			currentPrompt.content = content || currentPrompt.content;
			const saved = await this.storageService.savePrompt(currentPrompt);

			// Update panel tracking from 'new-*' key to the real ID
			const panel = openPanels.get(panelKey);
			if (panel) {
				Object.assign(currentPrompt, saved);
				this.setPanelPromptRef(panelKey, currentPrompt);

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
			this.makePromptIdBase(currentPrompt.taskNumber, currentPrompt.title, currentPrompt.description || currentPrompt.content || currentPrompt.report)
		);

		const saved = await this.storageService.savePrompt(currentPrompt, { historyReason: 'manual' });

		Object.assign(currentPrompt, saved);
		this.setPanelPromptRef(panelKey, currentPrompt);
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

		const latestStoredPrompt = await this.storageService.getPrompt(promptId);
		if (latestStoredPrompt) {
			currentPrompt.report = latestStoredPrompt.report;
			currentPrompt.updatedAt = latestStoredPrompt.updatedAt || currentPrompt.updatedAt;
			this.setPanelPromptRef(panelKey, currentPrompt);
			this.ensureReportEditorBinding(panelKey, currentPrompt);
			postMessage({
				type: 'reportContentUpdated',
				report: latestStoredPrompt.report,
				timeSpentWriting: latestStoredPrompt.timeSpentWriting,
				timeSpentOnTask: latestStoredPrompt.timeSpentOnTask,
				updatedAt: latestStoredPrompt.updatedAt,
			});
		} else {
			this.ensureReportEditorBinding(panelKey, currentPrompt);
		}

		const existingPanel = this.reportEditorPanels.get(promptId);
		if (existingPanel) {
			existingPanel.reveal(vscode.ViewColumn.Beside);
			void existingPanel.webview.postMessage({
				type: 'reportEditorInit',
				promptId,
				title: currentPrompt.title || currentPrompt.id,
				report: latestStoredPrompt?.report || currentPrompt.report || '',
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

		const persistReport = async (
			targetPromptId: string,
			reportValue: string,
			previousReport: string | undefined,
			activityDeltaMs: number,
			saveMode: 'autosave' | 'manual'
		): Promise<Prompt | null> => {
			const storedPrompt = await this.storageService.getPrompt(targetPromptId);
			if (!storedPrompt) {
				return null;
			}

			if (
				typeof previousReport === 'string'
				&& storedPrompt.report !== previousReport
				&& reportValue !== storedPrompt.report
			) {
				throw new Error('REPORT_CONFLICT');
			}

			storedPrompt.report = reportValue;
			switch (TimeTrackingService.getBucketByStatus(storedPrompt.status)) {
				case 'writing':
					storedPrompt.timeSpentWriting = Math.max(0, storedPrompt.timeSpentWriting || 0) + activityDeltaMs;
					break;
				case 'task':
					storedPrompt.timeSpentOnTask = Math.max(0, storedPrompt.timeSpentOnTask || 0) + activityDeltaMs;
					break;
				case 'none':
				default:
					break;
			}

			const saved = saveMode === 'manual'
				? await this.storageService.savePrompt(storedPrompt, { historyReason: 'manual' })
				: await this.storageService.savePrompt(storedPrompt, {
					historyReason: 'autosave',
					skipHistory: true,
				});

			return {
				...storedPrompt,
				...saved,
			};
		};

		reportPanel.onDidDispose(() => {
			this.reportEditorPanels.delete(promptId);
		});

		reportPanel.webview.onDidReceiveMessage(async (msg: WebviewToExtensionMessage) => {
			switch (msg.type) {
				case 'debugLog': {
					this.logReportDebug(`webview.${msg.scope}.${msg.message}`, msg.payload && typeof msg.payload === 'object'
						? msg.payload as Record<string, unknown>
						: { value: msg.payload ?? null });
					break;
				}

				case 'reportEditorReady': {
					const readyPrompt = await this.storageService.getPrompt(promptId);
					void reportPanel.webview.postMessage({
						type: 'reportEditorInit',
						promptId,
						title: currentPrompt.title || currentPrompt.id,
						report: readyPrompt?.report || currentPrompt.report || '',
					} satisfies ExtensionToWebviewMessage);
					break;
				}

				case 'reportEditorUpdate': {
					const targetPromptId = (msg.promptId || promptId).trim();
					if (!targetPromptId) {
						break;
					}
					const nextReport = typeof msg.report === 'string' ? msg.report : '';

					this.logReportDebug('reportEditorUpdate.received', {
						panelKey,
						targetPromptId,
						currentPromptId: currentPrompt.id,
						previousLength: typeof msg.previousReport === 'string' ? msg.previousReport.length : null,
						incomingLength: nextReport.length,
						activityDeltaMs: Math.max(0, Number(msg.activityDeltaMs) || 0),
					});

					if (currentPrompt.id === targetPromptId) {
						currentPrompt.report = nextReport;
						this.setPanelPromptRef(panelKey, currentPrompt);
						this.ensureReportEditorBinding(panelKey, currentPrompt);
						this.logReportDebug('reportEditorUpdate.forwardedToMainPanel', {
							panelKey,
							targetPromptId,
							reportLength: nextReport.length,
							reportPreview: this.reportDebugPreview(nextReport),
						});
						postMessage({
							type: 'reportContentUpdated',
							report: nextReport,
						} satisfies ExtensionToWebviewMessage);
					}

					try {
						const saved = await this.enqueueReportPersist(targetPromptId, () =>
							persistReport(
								targetPromptId,
								nextReport,
								typeof msg.previousReport === 'string' ? msg.previousReport : undefined,
								Math.max(0, Number(msg.activityDeltaMs) || 0),
								'autosave'
							)
						);
						if (!saved) {
							break;
						}

						const isLatestLiveReport = currentPrompt.id === targetPromptId && isLatestPersistedReport({
							currentReport: currentPrompt.report || '',
							persistedReport: nextReport,
						});
						if (isLatestLiveReport) {
							currentPrompt.timeSpentWriting = Math.max(saved.timeSpentWriting || 0, currentPrompt.timeSpentWriting || 0);
							currentPrompt.timeSpentOnTask = Math.max(saved.timeSpentOnTask || 0, currentPrompt.timeSpentOnTask || 0);
							currentPrompt.updatedAt = saved.updatedAt || currentPrompt.updatedAt;
							this.setPanelPromptRef(panelKey, currentPrompt);
							this.ensureReportEditorBinding(panelKey, currentPrompt);
						} else {
							this.logReportDebug('reportEditorUpdate.persistedStale', {
								panelKey,
								targetPromptId,
								reportLength: nextReport.length,
								currentLength: currentPrompt.id === targetPromptId ? currentPrompt.report.length : null,
							});
						}

						this.logReportDebug('reportEditorUpdate.persisted', {
							panelKey,
							targetPromptId,
							reportLength: nextReport.length,
							updatedAt: saved.updatedAt || null,
						});

						if (isLatestLiveReport) {
							void reportPanel.webview.postMessage({
								type: 'reportEditorSynced',
								report: nextReport,
								updatedAt: saved.updatedAt,
							} satisfies ExtensionToWebviewMessage);
						}
					} catch (error) {
						this.logReportDebug('reportEditorUpdate.persistFailed', {
							panelKey,
							targetPromptId,
							message: error instanceof Error ? error.message : String(error),
						});
						const message = this.formatSaveConflictMessage(error);
						void reportPanel.webview.postMessage({ type: 'error', message } satisfies ExtensionToWebviewMessage);
						const storedPrompt = await this.storageService.getPrompt(targetPromptId);
						if (storedPrompt) {
							void reportPanel.webview.postMessage({
								type: 'reportEditorExternalUpdate',
								report: storedPrompt.report,
								updatedAt: storedPrompt.updatedAt,
							} satisfies ExtensionToWebviewMessage);
						}
					}
					break;
				}

				case 'reportEditorSave': {
					const targetPromptId = (msg.promptId || promptId).trim();
					if (!targetPromptId) {
						break;
					}

					this.logReportDebug('reportEditorSave.received', {
						panelKey,
						targetPromptId,
						previousLength: typeof msg.previousReport === 'string' ? msg.previousReport.length : null,
						incomingLength: typeof msg.report === 'string' ? msg.report.length : 0,
						activityDeltaMs: Math.max(0, Number(msg.activityDeltaMs) || 0),
					});

					try {
						const saved = await this.enqueueReportPersist(targetPromptId, () =>
							persistReport(
								targetPromptId,
								typeof msg.report === 'string' ? msg.report : '',
								typeof msg.previousReport === 'string' ? msg.previousReport : undefined,
								Math.max(0, Number(msg.activityDeltaMs) || 0),
								'manual'
							)
						);
						if (!saved) {
							void reportPanel.webview.postMessage({ type: 'error', message: 'Не удалось сохранить отчет.' } satisfies ExtensionToWebviewMessage);
							break;
						}

						this.logReportDebug('reportEditorSave.persisted', {
							panelKey,
							targetPromptId,
							reportLength: typeof msg.report === 'string' ? msg.report.length : 0,
							updatedAt: saved.updatedAt || null,
						});

						void reportPanel.webview.postMessage({
							type: 'reportEditorSaved',
							updatedAt: saved.updatedAt,
						} satisfies ExtensionToWebviewMessage);
					} catch (error) {
						this.logReportDebug('reportEditorSave.persistFailed', {
							panelKey,
							targetPromptId,
							message: error instanceof Error ? error.message : String(error),
						});
						const message = this.formatSaveConflictMessage(error);
						void reportPanel.webview.postMessage({ type: 'error', message } satisfies ExtensionToWebviewMessage);
					}
					break;
				}

				case 'reportEditorGenerate': {
					const targetPromptId = (msg.promptId || promptId).trim();
					if (!targetPromptId) {
						break;
					}

					const storedPrompt = await this.storageService.getPrompt(targetPromptId);
					if (!storedPrompt) {
						void reportPanel.webview.postMessage({ type: 'error', message: 'Не удалось загрузить промпт для генерации отчета.' } satisfies ExtensionToWebviewMessage);
						break;
					}

					try {
						const generatedReportHtml = await this.generateReportHtmlFromPrompt(storedPrompt);
						storedPrompt.report = generatedReportHtml;
						const saved = await this.storageService.savePrompt(storedPrompt, {
							historyReason: 'autosave',
							skipHistory: true,
						});

						if (currentPrompt.id === targetPromptId) {
							currentPrompt.report = storedPrompt.report;
							currentPrompt.updatedAt = saved.updatedAt || currentPrompt.updatedAt;
							this.setPanelPromptRef(panelKey, currentPrompt);
							this.ensureReportEditorBinding(panelKey, currentPrompt);
							postMessage({
								type: 'reportContentUpdated',
								report: storedPrompt.report,
								timeSpentWriting: saved.timeSpentWriting,
								timeSpentOnTask: saved.timeSpentOnTask,
								updatedAt: saved.updatedAt,
							});
						}

						void reportPanel.webview.postMessage({ type: 'generatedReport', report: generatedReportHtml } satisfies ExtensionToWebviewMessage);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						void reportPanel.webview.postMessage({ type: 'error', message } satisfies ExtensionToWebviewMessage);
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
		this.pendingOpenPromptId = promptId;
		this.openPromptRequestVersion += 1;

		if (!this.openPromptQueue) {
			this.openPromptQueue = this.processPendingOpenPromptRequests().finally(() => {
				this.openPromptQueue = null;
			});
		}

		await this.openPromptQueue;
	}

	private async processPendingOpenPromptRequests(): Promise<void> {
		while (this.pendingOpenPromptId) {
			const promptId = this.pendingOpenPromptId;
			const requestVersion = this.openPromptRequestVersion;
			this.pendingOpenPromptId = null;
			await this.openPromptInternal(promptId, requestVersion);
		}
	}

	private isOpenPromptRequestStale(requestVersion: number): boolean {
		return requestVersion !== this.openPromptRequestVersion;
	}

	private createPanelBootId(): string {
		return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	}

	private async openPromptInternal(promptId: string, requestVersion: number): Promise<void> {
		const isNew = promptId === '__new__';
		const panelKey = SINGLE_EDITOR_PANEL_KEY;

		const singletonPanel = openPanels.get(panelKey);
		const singletonPrompt = this.panelPromptRefs.get(panelKey);
		if (!isNew && singletonPanel && singletonPrompt?.id === promptId) {
			try {
				await singletonPanel.webview.postMessage({ type: 'clearNotice' } satisfies ExtensionToWebviewMessage);
			} catch {
				// panel/webview may be reloading
			}
			this.syncStartupEditorRestoreState();
			singletonPanel.reveal();
			return;
		}

		const existingEntries = [...openPanels.entries()];
		const panelsToDispose: vscode.WebviewPanel[] = [];

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
						const saved = await this.persistPromptSnapshotForSwitch(
							latestSnapshot,
							this.panelBasePrompts.get(existingKey) || null,
							existingKey,
						);
						if (saved?.id) {
							this._onDidSave.fire(saved.id);
						}
					} catch (err) {
						const message = this.formatSaveConflictMessage(err);
						const isRu = vscode.env.language.startsWith('ru');
						vscode.window.showErrorMessage(
							isRu ? `Ошибка сохранения перед переключением: ${message}` : `Save before switch error: ${message}`
						);
					}
				}
			}
			if (existingKey === panelKey) {
				continue;
			}
			panelsToDispose.push(existingPanel);
		}

		if (this.isOpenPromptRequestStale(requestVersion)) {
			return;
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

		if (this.isOpenPromptRequestStale(requestVersion)) {
			return;
		}

		this.ensureContentEditorBinding(panelKey, prompt);
		this.ensureReportEditorBinding(panelKey, prompt);
		this.panelPromptRefs.set(panelKey, prompt);
		this.panelDirtyFlags.set(panelKey, restoredUnsaved);
		this.panelLatestPromptSnapshots.set(panelKey, restoredUnsaved ? JSON.parse(JSON.stringify(prompt)) : null);
		this.panelBasePrompts.set(panelKey, JSON.parse(JSON.stringify(prompt)));

		const setPanelDirty = (v: boolean): void => {
			this.panelDirtyFlags.set(panelKey, v);
		};

		if (singletonPanel) {
			try {
				await singletonPanel.webview.postMessage({ type: 'promptLoading' } satisfies ExtensionToWebviewMessage);
				await new Promise(resolve => setTimeout(resolve, 40));
			} catch {
				// panel may already be reloading; continue with fresh html
			}
			this.panelDirtySetters.set(panelKey, setPanelDirty);
			const bootId = this.createPanelBootId();
			this.panelBootIds.set(panelKey, bootId);
			singletonPanel.title = restoredUnsaved
				? `⚡● ${prompt.title || prompt.id || (isRu ? 'Новый промпт' : 'New prompt')}`
				: `⚡ ${prompt.title || prompt.id || (isRu ? 'Новый промпт' : 'New prompt')}`;
			singletonPanel.webview.html = getWebviewHtml(
				singletonPanel.webview,
				this.extensionUri,
				'dist/webview/editor.js',
				`Prompt: ${title}`,
				vscode.env.language,
				bootId,
			);
			singletonPanel.reveal(vscode.ViewColumn.One);
			this.syncStartupEditorRestoreState();

			for (const existingPanel of panelsToDispose) {
				this.silentClosePanels.add(existingPanel);
				existingPanel.dispose();
			}
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
		const bootId = this.createPanelBootId();
		this.panelBootIds.set(panelKey, bootId);

		panel.webview.html = getWebviewHtml(
			panel.webview,
			this.extensionUri,
			'dist/webview/editor.js',
			`Prompt: ${title}`,
			vscode.env.language,
			bootId,
		);

		openPanels.set(panelKey, panel);
		this.panelDirtySetters.set(panelKey, setPanelDirty);
		this.syncStartupEditorRestoreState();

		for (const existingPanel of panelsToDispose) {
			this.silentClosePanels.add(existingPanel);
			existingPanel.dispose();
		}

		// Handle panel close — autosave unsaved changes silently
		panel.onDidDispose(async () => {
			await this.promptVoiceService.cancel(panelKey);
			const promptIdForWait = (this.panelPromptRefs.get(panelKey)?.id || '').trim();
			await this.awaitPendingReportPersist(promptIdForWait);
			const promptRefSnapshot = this.panelPromptRefs.get(panelKey)
				? JSON.parse(JSON.stringify(this.panelPromptRefs.get(panelKey))) as Prompt
				: null;
			const latestPromptSnapshot = this.panelLatestPromptSnapshots.get(panelKey)
				? JSON.parse(JSON.stringify(this.panelLatestPromptSnapshots.get(panelKey))) as Prompt
				: null;
			const basePromptSnapshot = this.panelBasePrompts.get(panelKey)
				? JSON.parse(JSON.stringify(this.panelBasePrompts.get(panelKey))) as Prompt
				: null;
			const linkedKeys = [...openPanels.entries()]
				.filter(([, p]) => p === panel)
				.map(([key]) => key);
			const disposedCurrentEditorPanel = linkedKeys.includes(SINGLE_EDITOR_PANEL_KEY);
			const skipUnsavedPrompt = this.silentClosePanels.has(panel);
			this.silentClosePanels.delete(panel);
			for (const key of linkedKeys) {
				openPanels.delete(key);
				this.panelPromptRefs.delete(key);
				this.panelBootIds.delete(key);
				this.chatTrackingDisposables.get(key)?.dispose();
				this.chatTrackingDisposables.delete(key);
				this.panelDirtySetters.delete(key);
				this.panelDirtyFlags.delete(key);
				this.panelLatestPromptSnapshots.delete(key);
				this.panelBasePrompts.delete(key);
				this.clearContentEditorBinding(key);
				this.clearReportEditorBinding(key);
			}

			if (disposedCurrentEditorPanel && !this.isShuttingDown) {
				await this.stateService.saveStartupEditorRestoreState(false, null);
			}

			if (skipUnsavedPrompt) {
				return;
			}
			const currentSnapshot: Prompt = latestPromptSnapshot
				? JSON.parse(JSON.stringify(latestPromptSnapshot))
				: promptRefSnapshot
					? JSON.parse(JSON.stringify(promptRefSnapshot))
					: basePromptSnapshot
						? JSON.parse(JSON.stringify(basePromptSnapshot))
						: createDefaultPrompt('');

			let hasUnsavedChanges = this.panelDirtyFlags.get(panelKey) || false;
			if (!hasUnsavedChanges) {
				if (currentSnapshot.id) {
					const persisted = await this.storageService.getPrompt(currentSnapshot.id);
					this.mergeExternalReportIfUnchanged(currentSnapshot, persisted, basePromptSnapshot);
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
				const dirtySnapshot: Prompt = latestPromptSnapshot
					? JSON.parse(JSON.stringify(latestPromptSnapshot))
					: promptRefSnapshot
						? JSON.parse(JSON.stringify(promptRefSnapshot))
						: basePromptSnapshot
							? JSON.parse(JSON.stringify(basePromptSnapshot))
							: createDefaultPrompt('');
				try {
					if (!dirtySnapshot.title && dirtySnapshot.content) {
						dirtySnapshot.title = await this.aiService.generateTitle(dirtySnapshot.content);
					}
					if (!dirtySnapshot.description && dirtySnapshot.content) {
						dirtySnapshot.description = await this.aiService.generateDescription(dirtySnapshot.content);
					}
					const renameFromId = await this.ensurePromptIdMatchesTitle(dirtySnapshot, dirtySnapshot.id || undefined);
					await this.guardReportOverwriteBeforeSave(panelKey, dirtySnapshot, basePromptSnapshot);
					const persistedPrompt = dirtySnapshot.id ? await this.storageService.getPrompt(renameFromId || dirtySnapshot.id) : null;
					this.mergeExternalReportIfUnchanged(dirtySnapshot, persistedPrompt, basePromptSnapshot);
					dirtySnapshot.timeSpentUntracked = Math.max(0, dirtySnapshot.timeSpentUntracked || 0);
					dirtySnapshot.timeSpentOnTask = Math.max(0, dirtySnapshot.timeSpentOnTask || 0);
					await this.storageService.savePrompt(dirtySnapshot, { previousId: renameFromId });
					this.panelDirtyFlags.set(panelKey, false);
					this.panelLatestPromptSnapshots.set(panelKey, null);
					this.panelBasePrompts.set(panelKey, JSON.parse(JSON.stringify(dirtySnapshot)));
					await this.broadcastAvailableLanguagesAndFrameworks();
					this._onDidSave.fire(dirtySnapshot.id);
				} catch (err) {
					const message = this.formatSaveConflictMessage(err);
					vscode.window.showErrorMessage(
						isRu ? `Ошибка сохранения: ${message}` : `Save error: ${message}`
					);
				}
			}
		});

		panel.onDidChangeViewState((event) => {
			if (!event.webviewPanel.visible) {
				void event.webviewPanel.webview.postMessage({ type: 'clearNotice' } satisfies ExtensionToWebviewMessage);
				return;
			}

			void event.webviewPanel.webview.postMessage({ type: 'clearNotice' } satisfies ExtensionToWebviewMessage);
			void this.refreshPromptReportForPanel(panelKey, event.webviewPanel);
		});

		// Handle messages
		panel.webview.onDidReceiveMessage(
			async (msg: WebviewToExtensionMessage) => {
				const currentPrompt = this.panelPromptRefs.get(panelKey);
				if (!currentPrompt) {
					return;
				}
				if (msg.type === 'ready') {
					const activeBootId = this.panelBootIds.get(panelKey) || '';
					if (activeBootId && (msg.bootId || '') !== activeBootId) {
						return;
					}
				}
				if (msg.type === 'debugLog') {
					this.logReportDebug(`webview.${msg.scope}.${msg.message}`, msg.payload && typeof msg.payload === 'object'
						? msg.payload as Record<string, unknown>
						: { value: msg.payload ?? null });
					return;
				}
				if (msg.type === 'markDirty') {
					if (this.isStalePromptMessage(currentPrompt, msg.prompt, msg.promptId)) {
						return;
					}

					const latestPromptState = this.panelLatestPromptSnapshots.get(panelKey) || null;
					const previousLanguages = latestPromptState?.languages || currentPrompt.languages;
					const previousFrameworks = latestPromptState?.frameworks || currentPrompt.frameworks;
					const previousCurrentReport = currentPrompt.report || '';

					this.panelDirtyFlags.set(panelKey, msg.dirty);
					if (msg.prompt) {
						Object.assign(currentPrompt, msg.prompt);
						this.setPanelPromptRef(panelKey, currentPrompt);
						this.panelLatestPromptSnapshots.set(panelKey, JSON.parse(JSON.stringify(msg.prompt)));
					} else if (msg.dirty && !latestPromptState) {
						this.panelLatestPromptSnapshots.set(panelKey, JSON.parse(JSON.stringify(currentPrompt)));
					} else if (!msg.dirty) {
						this.panelLatestPromptSnapshots.set(panelKey, null);
					}

					const updatedLatestPromptState = this.panelLatestPromptSnapshots.get(panelKey) || null;

					const debugReportSource = msg.prompt?.report
						?? updatedLatestPromptState?.report
						?? currentPrompt.report
						?? '';
					this.logReportDebug('markDirty', {
						panelKey,
						dirty: msg.dirty,
						reportLength: debugReportSource.length,
						reportPreview: this.reportDebugPreview(debugReportSource),
					});

					if (msg.prompt && currentPrompt.id) {
						const nextReport = msg.prompt.report || '';
						if (nextReport !== previousCurrentReport) {
							const reportPanel = this.reportEditorPanels.get(currentPrompt.id);
							if (reportPanel) {
								this.logReportDebug('markDirty.forwardedToReportEditor', {
									panelKey,
									promptId: currentPrompt.id,
									previousLength: previousCurrentReport.length,
									nextLength: nextReport.length,
								});
								void reportPanel.webview.postMessage({
									type: 'reportEditorExternalUpdate',
									report: nextReport,
								} satisfies ExtensionToWebviewMessage);
							}
						}
					}

					if (msg.prompt && msg.dirty) {
						const normalize = (items: string[]): string[] => [...items].map(v => v.trim()).filter(Boolean).sort();
						const languagesChanged = JSON.stringify(normalize(previousLanguages)) !== JSON.stringify(normalize(msg.prompt.languages || []));
						const frameworksChanged = JSON.stringify(normalize(previousFrameworks)) !== JSON.stringify(normalize(msg.prompt.frameworks || []));
						if (languagesChanged || frameworksChanged) {
							await this.broadcastAvailableLanguagesAndFrameworks([msg.prompt]);
						}
					}

					const displayTitle = (updatedLatestPromptState?.title || currentPrompt.title || currentPrompt.id || (isRu ? 'Новый промпт' : 'New prompt'));
					panel.title = (this.panelDirtyFlags.get(panelKey) || false) ? `⚡● ${displayTitle}` : `⚡ ${displayTitle}`;
					return;
				}
				await this.handleMessage(msg, panel, currentPrompt, panelKey, () => this.panelDirtyFlags.get(panelKey) || false, setPanelDirty);
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
				const readyBootId = (msg.bootId || '').trim();
				const isReadyCycleStale = (): boolean => {
					return !this.isReadyCycleActive(panelKey, currentPrompt, readyBootId);
				};

				if (isReadyCycleStale()) {
					break;
				}

				if (currentPrompt.chatSessionIds?.length) {
					const existingSessionIds: string[] = [];
					for (const sessionId of currentPrompt.chatSessionIds) {
						if (await this.stateService.hasChatSession(sessionId)) {
							existingSessionIds.push(sessionId);
						}
					}
					if (isReadyCycleStale()) {
						break;
					}
					if (existingSessionIds.length !== currentPrompt.chatSessionIds.length) {
						currentPrompt.chatSessionIds = existingSessionIds;
						await this.storageService.savePrompt(currentPrompt);
						if (isReadyCycleStale()) {
							break;
						}
						this._onDidSave.fire(currentPrompt.id);
					}
				}

				// Make ready initialization resilient: timebox and tolerate errors
				let models: Array<{ id: string; name: string }> = [];
				let skills: any[] = [];
				let mcpTools: any[] = [];
				let hooks: any[] = [];
				let availableLanguageAndFrameworkMessages: any = {
					languagesMessage: { type: 'availableLanguages', options: [] },
					frameworksMessage: { type: 'availableFrameworks', options: [] },
				};

				try {
					const results = await Promise.all([
						this.withTimeout(this.aiService.getAvailableModels(), 2000, [] as any),
						this.withTimeout(this.workspaceService.getSkills(), 2000, [] as any),
						this.withTimeout(this.workspaceService.getMcpTools(), 2000, [] as any),
						this.withTimeout(this.workspaceService.getHooks(), 2000, [] as any),
						this.withTimeout(this.buildAvailableLanguagesAndFrameworksMessages(), 2000, availableLanguageAndFrameworkMessages),
					]);

					models = results[0] || [];
					skills = results[1] || [];
					mcpTools = results[2] || [];
					hooks = results[3] || [];
					availableLanguageAndFrameworkMessages = results[4] || availableLanguageAndFrameworkMessages;
				} catch (err) {
					console.error('[PromptManager] ready initialization partially failed:', err);
				}

				if (isReadyCycleStale()) {
					break;
				}

				postMessage({ type: 'globalContext', context: this.stateService.getGlobalAgentContext() });
				postMessage({ type: 'workspaceFolders', folders: this.workspaceService.getWorkspaceFolders() });
				postMessage({ type: 'availableModels', models });
				postMessage({ type: 'availableSkills', skills });
				postMessage({ type: 'availableMcpTools', tools: mcpTools });
				postMessage({ type: 'availableHooks', hooks });
				postMessage({ type: 'allowedBranches', branches: this.getAllowedBranchesSetting() });
				postMessage(availableLanguageAndFrameworkMessages.languagesMessage);
				postMessage(availableLanguageAndFrameworkMessages.frameworksMessage);
				postMessage({ type: 'prompt', prompt: currentPrompt, reason: 'open' });
				this.scheduleAvailableModelsRefreshAfterReady(panelKey, panel, currentPrompt, readyBootId, models);
				break;
			}

			case 'savePrompt': {
				if (this.isStalePromptMessage(currentPrompt, msg.prompt, msg.prompt?.id)) {
					break;
				}
				const saveStateId = (msg.prompt.id || currentPrompt.id || '__new__').trim() || '__new__';
				this.logReportDebug('savePrompt.received', {
					panelKey,
					source: msg.source || 'manual',
					promptId: msg.prompt.id || currentPrompt.id || '',
					reportLength: (msg.prompt.report || '').length,
					reportPreview: this.reportDebugPreview(msg.prompt.report || ''),
				});
				this._onDidSaveStateChange.fire({ id: saveStateId, saving: true });
				postMessage({ type: 'promptSaving', id: saveStateId, saving: true });
				try {
					let promptToSave = msg.prompt;
					await this.awaitPendingReportPersist(promptToSave.id || currentPrompt.id);
					const saveSource = msg.source || 'manual';
					const previousPromptId = (currentPrompt.id || msg.prompt.id || '').trim() || undefined;

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
								? this.withTimeout(this.aiService.generateTitle(promptToSave.content), 3000, '')
								: Promise.resolve(''),
							needsDescription
								? this.withTimeout(this.aiService.generateDescription(promptToSave.content), 3000, '')
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

					const renameFromId = await this.ensurePromptIdMatchesTitle(promptToSave, previousPromptId);
					await this.reconcileReportWithExtensionState(panelKey, promptToSave, currentPrompt);
					const basePrompt = this.panelBasePrompts.get(panelKey);
					await this.guardReportOverwriteBeforeSave(panelKey, promptToSave, basePrompt || null);

					const existingPrompt = promptToSave.id ? await this.storageService.getPrompt(renameFromId || promptToSave.id) : null;
					const hasConcurrentUpdate = Boolean(existingPrompt && promptToSave.updatedAt && existingPrompt.updatedAt !== promptToSave.updatedAt);
					const allowStatusOverwrite = saveSource === 'status-change';
					if (existingPrompt && hasConcurrentUpdate && !allowStatusOverwrite) {
						if (this.statusRank(existingPrompt.status) >= this.statusRank(promptToSave.status)) {
							promptToSave.status = existingPrompt.status;
						}
					}
					if (existingPrompt) {
						if (
							basePrompt
							&& promptToSave.report === (basePrompt.report || '')
							&& existingPrompt.report !== (basePrompt.report || '')
						) {
							promptToSave.report = existingPrompt.report;
						}
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
						previousId: renameFromId,
					});
					this.logReportDebug('savePrompt.saved', {
						panelKey,
						promptId: promptToSave.id,
						source: saveSource,
						reportLength: (promptToSave.report || '').length,
						reportPreview: this.reportDebugPreview(promptToSave.report || ''),
					});
					const savedPrompt = await this.storageService.getPrompt(promptToSave.id);
					const promptForPanel = savedPrompt || promptToSave;

					const normalizedCurrentPromptId = (currentPrompt.id || '').trim();
					const shouldApplyToCurrentPanel = !normalizedCurrentPromptId
						|| normalizedCurrentPromptId === promptToSave.id
						|| Boolean(previousPromptId && normalizedCurrentPromptId === previousPromptId);

					if (shouldApplyToCurrentPanel) {
						setIsDirty(false);
						// Update current prompt reference
						Object.assign(currentPrompt, promptForPanel);
						this.setPanelPromptRef(panelKey, currentPrompt);
						this.ensureContentEditorBinding(panelKey, currentPrompt);
						this.ensureReportEditorBinding(panelKey, currentPrompt);
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
						this.panelBasePrompts.set(promptToSave.id, basePrompt ? JSON.parse(JSON.stringify(basePrompt)) : JSON.parse(JSON.stringify(promptForPanel)));
						this.rebindContentEditorPanelKey(panelKey, promptToSave.id);
						this.rebindReportEditorPanelKey(panelKey, promptToSave.id);
					}

					if (shouldApplyToCurrentPanel) {
						const stateKey = panelKey.startsWith('new-') ? promptToSave.id : panelKey;
						this.panelDirtyFlags.set(stateKey, false);
						this.panelLatestPromptSnapshots.set(stateKey, null);
						this.panelBasePrompts.set(stateKey, JSON.parse(JSON.stringify(promptForPanel)));
					}

					if (shouldApplyToCurrentPanel) {
						panel.title = `⚡ ${saved.title || saved.id}`;
						postMessage({ type: 'promptSaved', prompt: saved, previousId: renameFromId });
						postMessage({ type: 'prompt', prompt: promptForPanel, reason: 'save', previousId: renameFromId });
					}
					await this.broadcastAvailableLanguagesAndFrameworks();
					if (promptForPanel.status !== 'in-progress') {
						try {
							await this.chatMemoryInstructionService()?.handlePromptStatusChange(promptForPanel);
						} catch (error) {
							this.hooksOutput.appendLine(`[chat-memory] status cleanup after save failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}

					this._onDidSave.fire(promptToSave.id);
					if (promptToSave.id && promptToSave.id !== saveStateId) {
						this._onDidSaveStateChange.fire({ id: promptToSave.id, saving: false });
					}
					// vscode.window.showInformationMessage(`Промпт "${saved.title || saved.id}" сохранён.`);
				} catch (error) {
					const message = this.formatSaveConflictMessage(error);
					postMessage({ type: 'error', message: `Save failed: ${message}` });
				} finally {
					this._onDidSaveStateChange.fire({ id: saveStateId, saving: false });
					postMessage({ type: 'promptSaving', id: saveStateId, saving: false });
				}
				break;
			}

			case 'mainReportUpdate': {
				const targetPromptId = (msg.promptId || currentPrompt.id || '').trim();
				if (!targetPromptId || currentPrompt.id !== targetPromptId) {
					break;
				}

				const nextReport = typeof msg.report === 'string' ? msg.report : '';
				const previousReport = currentPrompt.report || '';
				currentPrompt.report = nextReport;
				this.setPanelPromptRef(panelKey, currentPrompt);
				const latestSnapshot = this.panelLatestPromptSnapshots.get(panelKey);
				if (latestSnapshot) {
					latestSnapshot.report = nextReport;
					this.panelLatestPromptSnapshots.set(panelKey, JSON.parse(JSON.stringify(latestSnapshot)));
				}

				const reportPanel = this.reportEditorPanels.get(targetPromptId);
				if (reportPanel && previousReport !== nextReport) {
					this.logReportDebug('mainReportUpdate.forwardedToReportEditor', {
						panelKey,
						promptId: targetPromptId,
						previousLength: previousReport.length,
						nextLength: nextReport.length,
					});
					void reportPanel.webview.postMessage({
						type: 'reportEditorExternalUpdate',
						report: nextReport,
					} satisfies ExtensionToWebviewMessage);
				}
				break;
			}

			case 'openPromptContentInEditor': {
				await this.openPromptContentInEditor(panelKey, currentPrompt, msg.content || '');
				break;
			}

			case 'startPromptVoiceRecording': {
				await this.promptVoiceService.start(panelKey, msg.sessionId, postMessage);
				break;
			}

			case 'pausePromptVoiceRecording': {
				await this.promptVoiceService.pause(panelKey, msg.sessionId);
				break;
			}

			case 'resumePromptVoiceRecording': {
				await this.promptVoiceService.resume(panelKey, msg.sessionId);
				break;
			}

			case 'confirmPromptVoiceRecording': {
				await this.promptVoiceService.confirm(panelKey, msg.sessionId);
				break;
			}

			case 'cancelPromptVoiceRecording': {
				await this.promptVoiceService.cancel(panelKey, msg.sessionId);
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
				this.setPanelPromptRef(panelKey, currentPrompt);
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
				const title = await this.aiService.generateTitle(msg.content);
				postMessage({ type: 'generatedTitle', title });
				break;
			}

			case 'generateDescription': {
				const description = await this.aiService.generateDescription(msg.content);
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

			case 'generateReportFromStagedChanges': {
				const promptSnapshot: Prompt = msg.prompt
					? JSON.parse(JSON.stringify(msg.prompt))
					: JSON.parse(JSON.stringify(currentPrompt));
				try {
					const generatedReportHtml = await this.generateReportHtmlFromPrompt(promptSnapshot);
					postMessage({ type: 'generatedReport', report: generatedReportHtml });
				} catch (error) {
					const warning = error instanceof Error ? error.message : String(error);
					vscode.window.showWarningMessage(warning);
					postMessage({ type: 'error', message: warning });
				}
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
				const startChatRequestId = (msg.requestId || '').trim();
				const initialStatus = prompt?.status || 'draft';
				const initialChatSessionIds = [...(prompt?.chatSessionIds || [])];
				let hookPayloadBase: Record<string, unknown> | null = null;
				let trackedSessionId = '';
				const defaultStartChatError = 'Не удалось запустить чат. Проверьте, что Copilot Chat доступен, и повторите попытку.';
				const formatStartChatErrorMessage = (error: unknown): string => {
					const raw = error instanceof Error ? error.message : String(error ?? '');
					const normalized = raw.trim();
					if (!normalized) {
						return defaultStartChatError;
					}
					if (normalized.startsWith('Не удалось')) {
						return normalized;
					}
					return `Не удалось запустить чат: ${normalized}`;
				};
				const restorePromptAfterStartFailure = async (): Promise<void> => {
					if (!prompt?.id) {
						return;
					}
					const promptFromStorage = await this.storageService.getPrompt(prompt.id);
					if (!promptFromStorage) {
						return;
					}
					const restoredChatSessionIds = shouldForceRebindChat ? [] : initialChatSessionIds;
					const changed = promptFromStorage.status !== initialStatus
						|| JSON.stringify(promptFromStorage.chatSessionIds || []) !== JSON.stringify(restoredChatSessionIds);
					if (!changed) {
						return;
					}
					promptFromStorage.status = initialStatus;
					promptFromStorage.chatSessionIds = restoredChatSessionIds;
					await this.storageService.savePrompt(promptFromStorage, { historyReason: 'status-change' });
					Object.assign(prompt, promptFromStorage);
					if (currentPrompt.id === promptFromStorage.id) {
						Object.assign(currentPrompt, promptFromStorage);
						postMessage({ type: 'prompt', prompt: promptFromStorage, reason: 'sync' });
					}
					this._onDidSave.fire(promptFromStorage.id);
				};
				const reportStartChatFailure = async (message: string): Promise<void> => {
					const finalMessage = (message || '').trim() || defaultStartChatError;
					this.hooksOutput.appendLine(`[chat-start] failed for prompt=${prompt?.id || '-'}: ${finalMessage}`);
					if (hookPayloadBase) {
						try {
							await this.runConfiguredHooks(prompt?.hooks || [], {
								event: 'chatError',
								error: finalMessage,
								...hookPayloadBase,
							}, 'chatError');
						} catch (error) {
							this.hooksOutput.appendLine(`[chat-start] chatError hook failed for prompt=${prompt?.id || '-'}: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					if (prompt?.promptUuid) {
						try {
							await this.chatMemoryInstructionService()?.noteChatError(
								prompt.promptUuid,
								finalMessage,
								trackedSessionId || undefined,
							);
						} catch (error) {
							this.hooksOutput.appendLine(`[chat-memory] noteChatError failed for prompt=${prompt.id}: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					try {
						await restorePromptAfterStartFailure();
					} catch (error) {
						this.hooksOutput.appendLine(`[chat-start] restore after failure failed for prompt=${prompt?.id || '-'}: ${error instanceof Error ? error.message : String(error)}`);
					}
					if (!panel.visible) {
						void vscode.window.showErrorMessage(finalMessage);
					}
					postMessage({ type: 'error', message: finalMessage, requestId: startChatRequestId || undefined });
				};

				if (!prompt || !prompt.content) {
					await reportStartChatFailure('Не удалось запустить чат: промпт пуст или не найден.');
					break;
				}

				try {
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
								postMessage({ type: 'chatStarted', promptId: prompt.id, requestId: startChatRequestId || undefined });
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
						try {
							await this.chatMemoryInstructionService()?.bindChatSession(promptFromStorage.promptUuid, normalizedSessionId);
						} catch (error) {
							this.hooksOutput.appendLine(`[chat-memory] bindChatSession failed for prompt=${promptFromStorage.id}: ${error instanceof Error ? error.message : String(error)}`);
						}
						Object.assign(prompt, promptFromStorage);
						if (currentPrompt.id === promptFromStorage.id) {
							Object.assign(currentPrompt, promptFromStorage);
							postMessage({ type: 'prompt', prompt: promptFromStorage, reason: 'sync' });
						}
						this._onDidSave.fire(promptFromStorage.id);
					};

					// Ensure prompt has id and persist latest editor state before starting chat
					if (!prompt.id) {
						await this.ensurePromptIdMatchesTitle(prompt);
					}
					const existingBeforeChat = await this.storageService.getPrompt(prompt.id);
					if (existingBeforeChat) {
						prompt.timeSpentWriting = Math.max(prompt.timeSpentWriting || 0, existingBeforeChat.timeSpentWriting || 0);
						prompt.timeSpentImplementing = Math.max(prompt.timeSpentImplementing || 0, existingBeforeChat.timeSpentImplementing || 0);
						prompt.timeSpentOnTask = Math.max(prompt.timeSpentOnTask || 0, existingBeforeChat.timeSpentOnTask || 0);
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
					try {
						await this.codeMapChatInstructionService()?.prepareInstruction(prompt);
					} catch (error) {
						this.hooksOutput.appendLine(`[codemap] prepareInstruction failed for prompt=${prompt.id}: ${error instanceof Error ? error.message : String(error)}`);
					}
					let sessionInstructionRecord: Awaited<ReturnType<ChatMemoryInstructionService['prepareSessionInstruction']>> | null = null;
					try {
						sessionInstructionRecord = await this.chatMemoryInstructionService()?.prepareSessionInstruction(prompt) ?? null;
					} catch (error) {
						this.hooksOutput.appendLine(`[chat-memory] prepareSessionInstruction failed for prompt=${prompt.id}: ${error instanceof Error ? error.message : String(error)}`);
					}

					parts.push(prompt.content);

					const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
					const chatContextFiles = buildChatContextFiles({
						workspaceRoot,
						storageDir: this.storageService.getStorageDirectoryPath(),
						promptContextFiles: prompt.contextFiles,
						sessionInstructionFilePath: sessionInstructionRecord?.instructionFilePath,
					});
					const fileUris = chatContextFiles.allAbsolutePaths.map(filePath => vscode.Uri.file(filePath));

					// Add context metadata
					const ctx: string[] = [];
					if (prompt.id) ctx.push(`Prompt ID: ${prompt.id}`);
					if (prompt.title) ctx.push(`Prompt title: ${prompt.title}`);
					if (prompt.id) {
						const promptDirectory = this.storageService.getPromptDirectoryPath(prompt.id);
						ctx.push(`Prompt directory: ${promptDirectory}`);
						ctx.push(`Prompt file: ${this.storageService.getPromptMarkdownUri(prompt.id).fsPath}`);
						ctx.push(`Report file: ${promptDirectory}/report.txt`);
					}
					if (prompt.projects.length > 0) ctx.push(`Projects: ${prompt.projects.join(', ')}`);
					if (prompt.languages.length > 0) ctx.push(`Languages: ${prompt.languages.join(', ')}`);
					if (prompt.frameworks.length > 0) ctx.push(`Frameworks: ${prompt.frameworks.join(', ')}`);
					if (prompt.skills.length > 0) ctx.push(`Skills: ${prompt.skills.join(', ')}`);
					if (prompt.mcpTools.length > 0) ctx.push(`MCP Tools: ${prompt.mcpTools.join(', ')}`);
					if (prompt.hooks.length > 0) ctx.push(`Hooks: ${prompt.hooks.join(', ')}`);
					if (prompt.model) ctx.push(`Preferred model: ${prompt.model}`);
					if (prompt.taskNumber) ctx.push(`Task: ${prompt.taskNumber}`);
					if (prompt.branch) ctx.push(`Branch: ${prompt.branch}`);
					if (chatContextFiles.promptContextReferences.length > 0) {
						ctx.push(`Context files: ${chatContextFiles.promptContextReferences.join(' ')}`);
					}
					if (chatContextFiles.instructionReferences.length > 0) {
						ctx.push(`Memory instruction files: ${chatContextFiles.instructionReferences.join(' ')}`);
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
					hookPayloadBase = {
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
						} catch {
							// keep default model if model switch fails
						}
					}

					const sendMessage = async (message: string): Promise<void> => {
						const modelForLog = String(
							requestModelIdentifier
							|| requestModelSelector?.id
							|| requestModelSelector?.family
							|| prompt.model
							|| '',
						).trim() || 'default';
						if (requestModelSelector) {
							try {
								const openArg: Record<string, unknown> = {
									query: message,
									modelSelector: requestModelSelector,
									mode: chatModeName,
								};
								await vscode.commands.executeCommand('workbench.action.chat.open', openArg);
								await appendPromptAiLog({
									kind: 'chat',
									prompt: message,
									callerMethod: 'EditorPanelManager.startChat',
									model: modelForLog,
								});
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
									await appendPromptAiLog({
										kind: 'chat',
										prompt: message,
										callerMethod: 'EditorPanelManager.startChat',
										model: modelForLog,
									});
									return;
								} catch {
									// try next variant
								}
							}
						}

						throw new Error('VS Code не принял команду отправки сообщения в чат.');
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
					postMessage({ type: 'chatStarted', promptId: prompt.id, requestId: startChatRequestId || undefined });

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
							postMessage({ type: 'chatOpened', promptId: prompt.id, requestId: startChatRequestId || undefined });
						} else {
							const activeSessionId = await this.stateService.getActiveChatSessionId(5000, 250);
							if (activeSessionId) {
								trackedSessionId = trackedSessionId || activeSessionId;
								await bindSessionToPrompt(activeSessionId);
								postMessage({ type: 'chatOpened', promptId: prompt.id, requestId: startChatRequestId || undefined });
							} else {
								this.hooksOutput.appendLine(`[chat-start] session confirmation timeout for prompt=${prompt.id}; chat message was dispatched but session was not detected yet`);
							}
						}

						const completion = await this.stateService.waitForChatRequestCompletion(
							requestStartTimestamp,
							180000,
							1000,
							trackedSessionId || undefined,
						);
						const shouldCaptureAgentFinalResponse = this.shouldCaptureAgentFinalResponse();
						const chatResponse = await this.tryReadChatMarkdownFromClipboard();
						const chatReportText = chatResponse.markdown;
						const chatReportHtml = chatResponse.html;
						const completionObserved = Number(completion.lastRequestEnded || 0) > Number(completion.lastRequestStarted || 0);
						this.hooksOutput.appendLine(
							`[chat-track] prompt=${prompt.id} trackedSessionId=${trackedSessionId || '-'} completionOk=${completion.ok} reason=${completion.reason || '-'} sessionId=${completion.sessionId || '-'} started=${completion.lastRequestStarted || 0} ended=${completion.lastRequestEnded || 0} pendingEdits=${String(completion.hasPendingEdits)} markdown=${chatReportHtml ? 'yes' : 'no'}`
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
								if (shouldCaptureAgentFinalResponse && chatReportHtml) {
									promptToComplete.report = chatReportHtml;
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
								report: shouldCaptureAgentFinalResponse ? (promptToComplete?.report || '') : '',
								reportText: shouldCaptureAgentFinalResponse
									? (chatReportText || this.reportHtmlToText(promptToComplete?.report || ''))
									: '',
								chatSessionId: trackedSessionId || '',
								timeSpentImplementing: promptToComplete?.timeSpentImplementing || 0,
							}, 'afterChatCompleted');
							try {
								await this.chatMemoryInstructionService()?.completeChatSession(
									prompt.promptUuid,
									'afterChatCompleted',
									trackedSessionId || undefined,
								);
							} catch (error) {
								this.hooksOutput.appendLine(`[chat-memory] completeChatSession failed for prompt=${prompt.id}: ${error instanceof Error ? error.message : String(error)}`);
							}
							return;
						}

						if (chatReportHtml) {
							const promptForTiming = await this.storageService.getPrompt(prompt.id);
							if (promptForTiming) {
								const startedAt = Number(completion.lastRequestStarted || requestStartTimestamp);
								const endedAt = Number(completion.lastRequestEnded || Date.now());
								const implementingDelta = Math.max(0, endedAt - startedAt);
								if (implementingDelta > 0) {
									promptForTiming.timeSpentImplementing = (promptForTiming.timeSpentImplementing || 0) + implementingDelta;
								}
								if (shouldCaptureAgentFinalResponse) {
									promptForTiming.report = chatReportHtml;
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
								report: shouldCaptureAgentFinalResponse ? (promptForTiming?.report || '') : '',
								reportText: shouldCaptureAgentFinalResponse
									? (chatReportText || this.reportHtmlToText(promptForTiming?.report || ''))
									: '',
								chatSessionId: trackedSessionId || '',
								timeSpentImplementing: promptForTiming?.timeSpentImplementing || 0,
							}, 'afterChatCompleted');
							try {
								await this.chatMemoryInstructionService()?.completeChatSession(
									prompt.promptUuid,
									'afterChatCompleted',
									trackedSessionId || undefined,
								);
							} catch (error) {
								this.hooksOutput.appendLine(`[chat-memory] completeChatSession fallback failed for prompt=${prompt.id}: ${error instanceof Error ? error.message : String(error)}`);
							}
							return;
						}

						await this.runConfiguredHooks(prompt?.hooks || [], {
							event: 'chatError',
							error: `Chat completion not detected (${completion.reason || 'unknown'})`,
							chatCompletion: completion,
							...hookPayloadBase,
						}, 'chatError');
						try {
							await this.chatMemoryInstructionService()?.noteChatError(
								prompt.promptUuid,
								`Chat completion not detected (${completion.reason || 'unknown'})`,
								trackedSessionId || undefined,
							);
						} catch (error) {
							this.hooksOutput.appendLine(`[chat-memory] noteChatError completion failed for prompt=${prompt.id}: ${error instanceof Error ? error.message : String(error)}`);
						}
						this.hooksOutput.appendLine(`[chat-track] chatError fired for prompt=${prompt.id}: completion not detected`);
					})();

					// Optional hook-based status policy (no modal)
					const hookStatus = this.resolveStatusFromHooks(prompt.hooks || []);
					if (hookStatus) {
						prompt.status = hookStatus;
						await this.storageService.savePrompt(prompt);
						try {
							await this.chatMemoryInstructionService()?.handlePromptStatusChange(prompt);
						} catch (error) {
							this.hooksOutput.appendLine(`[chat-memory] hook status cleanup failed for prompt=${prompt.id}: ${error instanceof Error ? error.message : String(error)}`);
						}
						this._onDidSave.fire(prompt.id);
						if (currentPrompt.id === prompt.id) {
							Object.assign(currentPrompt, prompt);
							postMessage({ type: 'prompt', prompt, reason: 'sync' });
						}
					}
				} catch (error) {
					await reportStartChatFailure(formatStartChatErrorMessage(error));
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

						if (promptFromStorage.status !== 'in-progress') {
							promptFromStorage.status = 'in-progress';
							await this.storageService.savePrompt(promptFromStorage, { historyReason: 'status-change' });
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
				if (currentPrompt.id && currentPrompt.status !== 'in-progress') {
					const promptFromStorage = await this.storageService.getPrompt(currentPrompt.id);
					if (promptFromStorage && promptFromStorage.status !== 'in-progress') {
						promptFromStorage.status = 'in-progress';
						await this.storageService.savePrompt(promptFromStorage, { historyReason: 'status-change' });
						Object.assign(currentPrompt, promptFromStorage);
						postMessage({ type: 'prompt', prompt: promptFromStorage, reason: 'sync' });
						this._onDidSave.fire(promptFromStorage.id);
					}
				}
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

			case 'pickHttpExamplesFile': {
				const uris = await vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: false,
					openLabel: 'Выбрать HTTP файл',
				});
				if (uris && uris.length > 0) {
					postMessage({ type: 'pickedHttpExamplesFile', file: uris[0].fsPath });
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
				const file = (msg.file || '').trim();
				if (!file) {
					vscode.window.showWarningMessage('Не указан файл для открытия.');
					break;
				}
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
				const fullPath = file.startsWith('/') ? file : `${workspaceRoot}/${file}`;
				try {
					const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
					await vscode.window.showTextDocument(doc, {
						viewColumn: vscode.ViewColumn.Beside,
						preview: false,
						preserveFocus: false,
					});
				} catch {
					vscode.window.showErrorMessage(`Не удалось открыть файл: ${file}`);
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
				const isSilentRecalc = msg.silent === true;
				const prompt = await this.storageService.getPrompt(msg.id);
				if (!prompt) {
					if (isSilentRecalc) {
						postMessage({ type: 'implementingTimeRecalculated', id: msg.id, timeMs: 0, sessionsCount: 0 });
					} else {
						postMessage({ type: 'error', message: 'Промпт не найден.' });
					}
					break;
				}
				const sessionIds = prompt.chatSessionIds || [];
				if (sessionIds.length === 0) {
					if (isSilentRecalc) {
						postMessage({
							type: 'implementingTimeRecalculated',
							id: prompt.id,
							timeMs: prompt.timeSpentImplementing || 0,
							sessionsCount: 0,
						});
					} else {
						postMessage({ type: 'error', message: 'У промпта нет привязанных чат-сессий.' });
					}
					break;
				}
				try {
					const totalMs = await this.stateService.getChatSessionsTotalElapsed(sessionIds);
					if (totalMs <= 0) {
						if (isSilentRecalc) {
							this.hooksOutput.appendLine(`[chat-track] silent recalc skipped for prompt=${prompt.id}: no session timing files available yet`);
							postMessage({
								type: 'implementingTimeRecalculated',
								id: prompt.id,
								timeMs: prompt.timeSpentImplementing || 0,
								sessionsCount: sessionIds.length,
							});
						} else {
							postMessage({ type: 'error', message: 'Не удалось извлечь тайминги из истории чата. Файлы сессий могут быть недоступны.' });
						}
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
					if (isSilentRecalc) {
						this.hooksOutput.appendLine(`[chat-track] silent recalc error for prompt=${prompt.id}: ${err?.message || err}`);
						postMessage({
							type: 'implementingTimeRecalculated',
							id: prompt.id,
							timeMs: prompt.timeSpentImplementing || 0,
							sessionsCount: sessionIds.length,
						});
					} else {
						postMessage({ type: 'error', message: `Ошибка при пересчёте: ${err?.message || err}` });
					}
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
		this.reportEditorByPanelKey.clear();
		this.panelKeyByReportEditorUri.clear();
		for (const panel of this.reportEditorPanels.values()) {
			panel.dispose();
		}
		this.reportEditorPanels.clear();
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
		this.silentClosePanels.add(panel);
		panel.dispose();
	}
}
