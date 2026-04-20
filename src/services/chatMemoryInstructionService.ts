import * as path from 'path';
import * as vscode from 'vscode';
import type { Prompt } from '../types/prompt.js';
import type { StorageService } from './storageService.js';
import type { MemoryContextService, MemoryContextStats } from './memoryContextService.js';
import type { ChatMemoryInstructionComposer } from './chatMemoryInstructionComposer.js';
import type { GitService } from './gitService.js';
import type { WorkspaceService } from './workspaceService.js';
import { getPromptManagerOutputChannel } from '../utils/promptManagerOutput.js';
import { resolveEffectiveProjectNames } from '../utils/projectScope.js';

const SESSION_FOLDER_NAME = 'chat-memory';
const SESSION_FOLDER_RELATIVE_PATH = '.vscode/prompt-manager/chat-memory';
const REGISTRY_FILE_NAME = 'sessions.json';
const SESSION_FILE_PREFIX = 'session-';
const SESSION_FILE_SUFFIX = '.instructions.md';
const DEFAULT_STALE_TTL_MS = 60 * 60 * 1000;

export interface ChatMemorySessionRecord {
	promptUuid: string;
	promptId: string;
	instructionFilePath: string;
	createdAt: string;
	updatedAt: string;
	chatSessionId?: string;
	lastError?: string;
	/** Section-level stats collected during context generation */
	contextStats?: MemoryContextStats;
}

interface ChatMemorySessionRegistry {
	version: 1;
	sessions: ChatMemorySessionRecord[];
}

export class ChatMemoryInstructionService {
	private readonly output = getPromptManagerOutputChannel();

	constructor(
		private readonly storageService: StorageService,
		private readonly memoryContextService: MemoryContextService,
		private readonly composer: ChatMemoryInstructionComposer,
		private readonly gitService: GitService,
		private readonly workspaceService: WorkspaceService,
	) { }

	dispose(): void {
	}

	async ensureInstructionsLocationRegistered(): Promise<void> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return;
		}

		await vscode.workspace.fs.createDirectory(vscode.Uri.file(this.getSessionDirectoryPath()));

		const chatConfig = vscode.workspace.getConfiguration('chat', workspaceFolder.uri);
		await this.ensurePathInChatLocationsSetting(
			chatConfig,
			'instructionsFilesLocations',
			SESSION_FOLDER_RELATIVE_PATH,
			vscode.Uri.joinPath(workspaceFolder.uri, SESSION_FOLDER_RELATIVE_PATH).fsPath,
		);

		const includeApplyingInstructions = chatConfig.get<boolean>('includeApplyingInstructions');
		if (includeApplyingInstructions !== true) {
			await vscode.workspace.getConfiguration().update(
				'chat.includeApplyingInstructions',
				true,
				vscode.ConfigurationTarget.Workspace,
			);
		}

		const includeReferencedInstructions = chatConfig.get<boolean>('includeReferencedInstructions');
		if (includeReferencedInstructions !== true) {
			await vscode.workspace.getConfiguration().update(
				'chat.includeReferencedInstructions',
				true,
				vscode.ConfigurationTarget.Workspace,
			);
		}

		const useInstructionFiles = vscode.workspace.getConfiguration().get<boolean>('github.copilot.chat.codeGeneration.useInstructionFiles');
		if (useInstructionFiles !== true) {
			await vscode.workspace.getConfiguration().update(
				'github.copilot.chat.codeGeneration.useInstructionFiles',
				true,
				vscode.ConfigurationTarget.Workspace,
			);
		}

		this.logInfo('instructions-location-ready', {
			sessionDir: this.getSessionDirectoryPath(),
			relativePath: SESSION_FOLDER_RELATIVE_PATH,
		});
	}

	async prepareSessionInstruction(prompt: Prompt): Promise<ChatMemorySessionRecord | null> {
		if (!(prompt.promptUuid || '').trim()) {
			this.logError('prepare-session-missing-uuid', new Error('Prompt UUID is missing'), { promptId: prompt.id });
			return null;
		}

		await this.ensureInstructionsLocationRegistered();
		await this.cleanupStaleSessions();
		await this.removePromptSessionInstructions(prompt.promptUuid, 'new-chat');

		const projectPaths = this.workspaceService.getWorkspaceFolderPaths();
		const effectiveProjectNames = resolveEffectiveProjectNames(prompt.projects, Array.from(projectPaths.keys()));

		const uncommittedProjects = await this.gitService.getUncommittedProjectData(
			projectPaths,
			effectiveProjectNames,
		);

		const { context: rawMemoryContext, stats: contextStats } = await this.memoryContextService.getContextForChat(prompt.content, {
			maxChars: 6000,
			shortTermLimit: 15,
			projectNames: effectiveProjectNames,
			uncommittedProjects,
		});

		if (!rawMemoryContext.trim()) {
			this.logInfo('prepare-session-no-context', {
				promptUuid: prompt.promptUuid,
				promptId: prompt.id,
			});
			return null;
		}

		const fileName = `${SESSION_FILE_PREFIX}${prompt.promptUuid}-${Date.now()}${SESSION_FILE_SUFFIX}`;
		const filePath = path.join(this.getSessionDirectoryPath(), fileName);
		const content = this.composer.compose({
			prompt,
			effectiveProjectNames,
			rawMemoryContext,
			generatedAt: new Date().toISOString(),
		});

		await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(content, 'utf-8'));

		const registry = await this.readRegistry();
		const record: ChatMemorySessionRecord = {
			promptUuid: prompt.promptUuid,
			promptId: prompt.id,
			instructionFilePath: filePath,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			contextStats,
		};
		registry.sessions = registry.sessions.filter(session => session.promptUuid !== prompt.promptUuid);
		registry.sessions.push(record);
		await this.writeRegistry(registry);

		this.logInfo('session-instruction-created', {
			promptUuid: prompt.promptUuid,
			promptId: prompt.id,
			instructionFilePath: filePath,
			contentLength: content.length,
		});

		return record;
	}

	async bindChatSession(promptUuid: string, chatSessionId: string): Promise<void> {
		if (!promptUuid || !chatSessionId) {
			return;
		}

		const registry = await this.readRegistry();
		const record = registry.sessions.find(session => session.promptUuid === promptUuid);
		if (!record) {
			this.logInfo('bind-session-missing-record', { promptUuid, chatSessionId });
			return;
		}

		record.chatSessionId = chatSessionId;
		record.updatedAt = new Date().toISOString();
		await this.writeRegistry(registry);
		this.logInfo('session-bound', { promptUuid, promptId: record.promptId, chatSessionId });
	}

	async completeChatSession(promptUuid: string, reason: string, chatSessionId?: string): Promise<void> {
		await this.removePromptSessionInstructions(promptUuid, reason, chatSessionId);
	}

	async noteChatError(promptUuid: string, error: string, chatSessionId?: string): Promise<void> {
		const registry = await this.readRegistry();
		const record = registry.sessions.find(session => session.promptUuid === promptUuid);
		if (!record) {
			this.logInfo('chat-error-without-session-record', { promptUuid, chatSessionId, error });
			return;
		}

		record.lastError = error;
		record.updatedAt = new Date().toISOString();
		if (chatSessionId) {
			record.chatSessionId = chatSessionId;
		}
		await this.writeRegistry(registry);
		this.logInfo('chat-error-session-kept', {
			promptUuid,
			promptId: record.promptId,
			chatSessionId,
			error,
		});
	}

	async handlePromptStatusChange(prompt: Pick<Prompt, 'id' | 'promptUuid' | 'status'>): Promise<void> {
		if (!(prompt.promptUuid || '').trim()) {
			return;
		}
		if (prompt.status === 'in-progress') {
			return;
		}
		await this.removePromptSessionInstructions(prompt.promptUuid, `status:${prompt.status}`);
	}

	async cleanupStaleSessions(ttlMs: number = DEFAULT_STALE_TTL_MS): Promise<void> {
		const registry = await this.readRegistry();
		const now = Date.now();
		const activeSessions: ChatMemorySessionRecord[] = [];

		for (const record of registry.sessions) {
			const updatedTs = new Date(record.updatedAt || record.createdAt).getTime();
			const isStale = !Number.isFinite(updatedTs) || now - updatedTs > ttlMs;
			if (isStale) {
				await this.deleteInstructionFile(record.instructionFilePath, 'stale-cleanup', {
					promptUuid: record.promptUuid,
					promptId: record.promptId,
					chatSessionId: record.chatSessionId,
				});
				continue;
			}
			activeSessions.push(record);
		}

		registry.sessions = activeSessions;
		await this.writeRegistry(registry);
	}

	async recoverSessionsOnStartup(): Promise<void> {
		await this.ensureInstructionsLocationRegistered();
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(this.getSessionDirectoryPath()));

		const registry = await this.readRegistry();
		const fileUris = await vscode.workspace.fs.readDirectory(vscode.Uri.file(this.getSessionDirectoryPath()));
		const sessionFilePaths = new Set(
			fileUris
				.filter(([name, type]) => type === vscode.FileType.File && name.startsWith(SESSION_FILE_PREFIX) && name.endsWith(SESSION_FILE_SUFFIX))
				.map(([name]) => path.join(this.getSessionDirectoryPath(), name)),
		);

		const nextSessions: ChatMemorySessionRecord[] = [];
		for (const record of registry.sessions) {
			if (sessionFilePaths.has(record.instructionFilePath)) {
				nextSessions.push(record);
				sessionFilePaths.delete(record.instructionFilePath);
				continue;
			}
			this.logInfo('startup-registry-orphan-removed', {
				promptUuid: record.promptUuid,
				promptId: record.promptId,
				instructionFilePath: record.instructionFilePath,
			});
		}

		for (const orphanFilePath of sessionFilePaths) {
			await this.deleteInstructionFile(orphanFilePath, 'startup-orphan-file');
		}

		registry.sessions = nextSessions;
		await this.writeRegistry(registry);
		await this.cleanupStaleSessions();
	}

	private async removePromptSessionInstructions(promptUuid: string, reason: string, chatSessionId?: string): Promise<void> {
		if (!promptUuid) {
			return;
		}

		const registry = await this.readRegistry();
		const matching = registry.sessions.filter(session => session.promptUuid === promptUuid);
		if (matching.length === 0) {
			this.logInfo('remove-session-no-records', { promptUuid, reason, chatSessionId });
			return;
		}

		for (const record of matching) {
			await this.deleteInstructionFile(record.instructionFilePath, reason, {
				promptUuid: record.promptUuid,
				promptId: record.promptId,
				chatSessionId: chatSessionId || record.chatSessionId,
			});
		}

		registry.sessions = registry.sessions.filter(session => session.promptUuid !== promptUuid);
		await this.writeRegistry(registry);
	}

	private async deleteInstructionFile(
		instructionFilePath: string,
		reason: string,
		context?: Record<string, unknown>,
	): Promise<void> {
		try {
			await vscode.workspace.fs.delete(vscode.Uri.file(instructionFilePath));
			this.logInfo('session-instruction-deleted', {
				reason,
				instructionFilePath,
				...context,
			});
		} catch (error) {
			this.logError('delete-session-instruction-failed', error, {
				reason,
				instructionFilePath,
				...context,
			});
		}
	}

	private getSessionDirectoryPath(): string {
		return path.join(this.storageService.getStorageDirectoryPath(), SESSION_FOLDER_NAME);
	}

	private getRegistryPath(): string {
		return path.join(this.getSessionDirectoryPath(), REGISTRY_FILE_NAME);
	}

	private async readRegistry(): Promise<ChatMemorySessionRegistry> {
		try {
			const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(this.getRegistryPath()));
			const parsed = JSON.parse(Buffer.from(raw).toString('utf-8')) as Partial<ChatMemorySessionRegistry>;
			return {
				version: 1,
				sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
			};
		} catch {
			return { version: 1, sessions: [] };
		}
	}

	private async writeRegistry(registry: ChatMemorySessionRegistry): Promise<void> {
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(this.getSessionDirectoryPath()));
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(this.getRegistryPath()),
			Buffer.from(JSON.stringify(registry, null, 2), 'utf-8'),
		);
	}

	private async ensurePathInChatLocationsSetting(
		chatConfig: vscode.WorkspaceConfiguration,
		settingKey: 'instructionsFilesLocations' | 'promptFilesLocations',
		relativePath: string,
		absolutePath: string,
	): Promise<void> {
		const currentValue = chatConfig.get<unknown>(settingKey);
		const normalizedRelative = relativePath.replace(/\\/g, '/');
		const normalizedAbsolute = absolutePath.replace(/\\/g, '/');
		const hasPath = (value: unknown): boolean => {
			if (Array.isArray(value)) {
				return value
					.filter((item): item is string => typeof item === 'string')
					.some(item => {
						const normalized = item.replace(/\\/g, '/');
						return normalized === normalizedRelative || normalized === normalizedAbsolute;
					});
			}
			if (value && typeof value === 'object') {
				return Object.keys(value as Record<string, unknown>).some(key => {
					const normalized = key.replace(/\\/g, '/');
					return normalized === normalizedRelative || normalized === normalizedAbsolute;
				});
			}
			return false;
		};

		if (hasPath(currentValue)) {
			return;
		}

		if (Array.isArray(currentValue)) {
			const values = currentValue.filter((item): item is string => typeof item === 'string');
			await chatConfig.update(settingKey, [...values, relativePath], vscode.ConfigurationTarget.Workspace);
			return;
		}

		if (currentValue && typeof currentValue === 'object') {
			const entries = currentValue as Record<string, unknown>;
			const normalizedEntries: Record<string, boolean> = {};
			for (const [key, value] of Object.entries(entries)) {
				if (typeof value === 'boolean') {
					normalizedEntries[key] = value;
					continue;
				}
				if (typeof value === 'string' && /^\d+$/.test(key)) {
					normalizedEntries[value] = true;
				}
			}
			await chatConfig.update(
				settingKey,
				{
					...normalizedEntries,
					[relativePath]: true,
				},
				vscode.ConfigurationTarget.Workspace,
			);
			return;
		}

		await chatConfig.update(
			settingKey,
			{ [relativePath]: true },
			vscode.ConfigurationTarget.Workspace,
		);
	}

	private logInfo(message: string, context?: Record<string, unknown>): void {
		this.output.appendLine(`[chat-memory][info] ${message}${context ? ` ${JSON.stringify(context)}` : ''}`);
	}

	private logError(message: string, error: unknown, context?: Record<string, unknown>): void {
		const errorMessage = error instanceof Error ? error.message : String(error);
		this.output.appendLine(`[chat-memory][error] ${message}: ${errorMessage}${context ? ` ${JSON.stringify(context)}` : ''}`);
	}
}
