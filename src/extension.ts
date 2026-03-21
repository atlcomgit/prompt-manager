/**
 * Prompt Manager — VS Code Extension Entry Point
 */

import * as vscode from 'vscode';
import { StorageService, AiService, WorkspaceService, GitService, StateService, CopilotUsageService, PromptVoiceService } from './services/index.js';
import {
	MemoryDatabaseService,
	MemoryCleanupService,
	MemoryHttpServerService,
	MemoryGitHookService,
	MemoryAnalyzerService,
	MemoryEmbeddingService,
	MemoryContextService,
	MemoryNotificationService,
	ChatMemoryInstructionComposer,
	ChatMemoryInstructionService,
	CodeMapDatabaseService,
	CodeMapBranchResolverService,
	CodeMapInstructionService,
	CodeMapMaterializerService,
	CodeMapOrchestratorService,
	CodeMapChatInstructionService,
	CodeMapAdminService,
	getCodeMapSettings,
} from './services/index.js';
import { SidebarProvider, AboutPanelManager, EditorPanelManager, StatisticsPanelManager, TrackerPanelManager, CopilotStatusBarProvider, CopilotUsagePanelManager, MemoryPanelManager } from './providers/index.js';
import type { MemoryCommit, HookCommitPayload, MemoryAnalysisDepth } from './types/index.js';
import { DEFAULT_COPILOT_MODEL_FAMILY } from './constants/ai.js';
import { buildChatContextFiles } from './utils/chatContextFiles.js';
import {
	disposePromptManagerOutputChannel,
	getPromptManagerOutputChannel,
	installPromptManagerConsoleInterceptor,
	showPromptManagerOutputChannel,
} from './utils/promptManagerOutput.js';
import { appendPromptAiLog } from './utils/promptAiLogger.js';

export function activate(context: vscode.ExtensionContext) {
	getPromptManagerOutputChannel();
	const consoleInterceptor = installPromptManagerConsoleInterceptor();
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		vscode.window.showWarningMessage('Prompt Manager: откройте рабочую область для использования расширения.');
		consoleInterceptor.dispose();
		disposePromptManagerOutputChannel();
		return;
	}

	const extensionSettingsQuery = '@ext:alek-fiend.copilot-prompt-manager';

	// Initialize services
	const storageService = new StorageService(workspaceRoot);
	const aiService = new AiService(context);
	const workspaceService = new WorkspaceService();
	const gitService = new GitService();
	const stateService = new StateService(context);
	const promptVoiceService = new PromptVoiceService(context.globalStorageUri.fsPath);
	const extensionPackage = context.extension.packageJSON as { description?: string; version?: string };
	const extensionVersion = String(extensionPackage.version || '0.0.0');

	void workspaceService.ensureChatInstructionsFile(stateService.getGlobalAgentContext()).catch(() => {
		// keep activation resilient if chat settings/files sync fails
	});

	// Initialize providers
	const sidebarProvider = new SidebarProvider(
		context.extensionUri,
		storageService,
		aiService,
		workspaceService,
		gitService,
		stateService,
	);

	const editorPanelManager = new EditorPanelManager(
		context.extensionUri,
		storageService,
		aiService,
		workspaceService,
		gitService,
		stateService,
		promptVoiceService,
		() => chatMemoryInstructionService,
		() => codeMapChatInstructionService,
	);
	context.subscriptions.push(new vscode.Disposable(() => {
		void promptVoiceService.dispose();
	}));

	const statisticsPanelManager = new StatisticsPanelManager(
		context.extensionUri,
		storageService,
	);

	const aboutPanelManager = new AboutPanelManager(
		context.extensionUri,
		extensionVersion,
		String(extensionPackage.description || ''),
	);

	const trackerPanelManager = new TrackerPanelManager(
		context.extensionUri,
		storageService,
		stateService,
		() => chatMemoryInstructionService,
	);

	// Initialize Copilot Premium usage status bar
	const copilotUsageService = new CopilotUsageService(context);
	void copilotUsageService.checkAuthenticationBindingOnActivation();
	const copilotUsagePanelManager = new CopilotUsagePanelManager(context.extensionUri, copilotUsageService);
	const copilotStatusBarProvider = new CopilotStatusBarProvider(copilotUsageService, copilotUsagePanelManager);

	// ---- Project Memory System ----
	const memoryEnabled = vscode.workspace.getConfiguration('promptManager').get<boolean>('memory.enabled', false);
	let memoryDb: MemoryDatabaseService | undefined;
	let memoryCleanup: MemoryCleanupService | undefined;
	let memoryHttpServer: MemoryHttpServerService | undefined;
	let memoryGitHook: MemoryGitHookService | undefined;
	let memoryAnalyzer: MemoryAnalyzerService | undefined;
	let memoryEmbedding: MemoryEmbeddingService | undefined;
	let memoryContext: MemoryContextService | undefined;
	let memoryNotification: MemoryNotificationService | undefined;
	let memoryPanelManager: MemoryPanelManager | undefined;
	let chatMemoryInstructionService: ChatMemoryInstructionService | undefined;
	let codeMapDb: CodeMapDatabaseService | undefined;
	let codeMapOrchestratorService: CodeMapOrchestratorService | undefined;
	let codeMapChatInstructionService: CodeMapChatInstructionService | undefined;
	let codeMapAdminService: CodeMapAdminService | undefined;
	let codeMapRealtimeWatcherRegistered = false;
	const codeMapSettings = getCodeMapSettings();

	if (codeMapSettings.enabled) {
		codeMapDb = new CodeMapDatabaseService(context.extensionUri);
		const codeMapBranchResolverService = new CodeMapBranchResolverService(gitService);
		const codeMapInstructionService = new CodeMapInstructionService(aiService, codeMapDb);
		const codeMapMaterializerService = new CodeMapMaterializerService();
		codeMapOrchestratorService = new CodeMapOrchestratorService(codeMapDb, codeMapInstructionService);
		codeMapChatInstructionService = new CodeMapChatInstructionService(
			storageService,
			workspaceService,
			gitService,
			codeMapDb,
			codeMapBranchResolverService,
			codeMapInstructionService,
			codeMapMaterializerService,
			codeMapOrchestratorService,
		);
		codeMapAdminService = new CodeMapAdminService(
			workspaceService,
			gitService,
			codeMapDb,
			codeMapBranchResolverService,
			codeMapOrchestratorService,
			codeMapChatInstructionService,
		);
		const registerCodeMapRealtimeWatcher = () => {
			if (codeMapRealtimeWatcherRegistered || !codeMapChatInstructionService) {
				return;
			}

			codeMapRealtimeWatcherRegistered = true;
			const watcher = vscode.workspace.createFileSystemWatcher('**/*');
			const handleRealtimeChange = (uri: vscode.Uri) => {
				codeMapChatInstructionService?.scheduleRealtimeRefreshForFile(uri);
			};
			watcher.onDidChange(handleRealtimeChange, null, context.subscriptions);
			watcher.onDidCreate(handleRealtimeChange, null, context.subscriptions);
			watcher.onDidDelete(handleRealtimeChange, null, context.subscriptions);
			context.subscriptions.push(watcher);
		};

		void (async () => {
			try {
				await codeMapDb!.initialize(workspaceRoot);
				registerCodeMapRealtimeWatcher();
				if (codeMapSettings.autoUpdate) {
					setTimeout(() => {
						codeMapChatInstructionService?.queueWorkspaceRefresh();
					}, codeMapSettings.startupDelayMs);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error('[PromptManager] Code map init failed:', msg);
			}
		})();
	}

	memoryDb = new MemoryDatabaseService(context.extensionUri);
	memoryGitHook = new MemoryGitHookService();
	memoryAnalyzer = new MemoryAnalyzerService();
	memoryEmbedding = new MemoryEmbeddingService();
	memoryContext = new MemoryContextService(memoryDb, memoryEmbedding);
	memoryPanelManager = new MemoryPanelManager(
		context.extensionUri,
		memoryDb,
		memoryContext,
		memoryEmbedding,
		memoryAnalyzer,
		memoryGitHook,
		aiService,
		codeMapAdminService,
	);

	const memoryDbReady = (async () => {
		try {
			await memoryDb!.initialize(workspaceRoot);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error('[PromptManager] Memory database init failed:', msg);
		}
	})();

	if (memoryEnabled) {
		memoryCleanup = new MemoryCleanupService(memoryDb);
		memoryHttpServer = new MemoryHttpServerService();
		memoryNotification = new MemoryNotificationService();
		const chatMemoryInstructionComposer = new ChatMemoryInstructionComposer();

		// Start memory subsystems only when Memory is enabled
		void (async () => {
			try {
				await memoryDbReady;
				memoryCleanup!.start();

				// Start HTTP server and install git hooks
				const { port, token } = await memoryHttpServer!.start();
				const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
				await memoryGitHook!.installHooksForWorkspace(folders, port, token);

				// Initialize embedding model in background
				const embeddingsEnabled = vscode.workspace.getConfiguration('promptManager').get<boolean>('memory.embeddings.enabled', true);
				if (embeddingsEnabled) {
					const cacheDir = context.globalStorageUri.fsPath;
					void memoryEmbedding!.initialize(cacheDir);
				}

				chatMemoryInstructionService = new ChatMemoryInstructionService(
					storageService,
					memoryContext!,
					chatMemoryInstructionComposer,
					gitService,
					workspaceService,
				);
				await chatMemoryInstructionService.recoverSessionsOnStartup();

				// Wire up pipeline: HTTP server → analyze → store → embed
				memoryHttpServer!.onCommitReceived(async (payload: HookCommitPayload) => {
					try {
						if (memoryDb!.hasCommit(payload.sha)) { return; }

						const config = vscode.workspace.getConfiguration('promptManager');
						const depth = config.get<MemoryAnalysisDepth>('memory.analysisDepth', 'standard');
						const diffLimit = config.get<number>('memory.diffLimit', 200000);
						const aiModel = aiService
							? await aiService.resolveFreeCopilotModel(config.get<string>('memory.aiModel', DEFAULT_COPILOT_MODEL_FAMILY))
							: '';
						if (!aiModel) {
							return;
						}

						// Classify and store commit
						const commitType = memoryAnalyzer!.classifyCommitType(payload.message);
						const commit: MemoryCommit = {
							sha: payload.sha,
							author: payload.author,
							email: payload.email,
							date: payload.date,
							branch: payload.branch,
							repository: payload.repository,
							parentSha: payload.parentSha,
							commitType,
							message: payload.message,
						};
						memoryDb!.insertCommit(commit);

						// Run AI analysis
						memoryAnalyzer!.setModelFamily(aiModel);
						const result = await memoryAnalyzer!.analyzeCommit(payload, depth, diffLimit);
						memoryDb!.insertAnalysis(result.analysis);
						memoryDb!.insertFileChanges(result.fileChanges);
						if (result.knowledgeNodes.length > 0) {
							memoryDb!.insertKnowledgeNodes(result.knowledgeNodes);
						}
						if (result.bugRelation) {
							memoryDb!.insertBugRelation(result.bugRelation);
						}

						// Generate embedding if enabled
						if (embeddingsEnabled && memoryEmbedding!.isReady()) {
							const text = `${payload.message}\n${result.analysis.summary}\n${result.analysis.keyInsights.join('\n')}`;
							const vector = await memoryEmbedding!.generateEmbedding(text);
							if (vector) {
								memoryDb!.insertEmbedding({
									commitSha: payload.sha,
									vector,
									text,
									createdAt: new Date().toISOString(),
								});
							}
						}

						memoryNotification!.notifyCommitAnalysed(payload.sha.substring(0, 7), result.analysis.summary);

						// Periodically update project summary
						void memoryContext!.updateProjectSummary(payload.repository);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						memoryNotification!.notifyError(`Memory analysis failed: ${msg}`);
					}
				});

				memoryNotification!.updateStatusBar(memoryDb!.getCommitCount(), false);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error('[PromptManager] Memory system init failed:', msg);
			}
		})();
	}

	// Register sidebar webview provider
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			SidebarProvider.viewType,
			sidebarProvider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);

	const openPromptOutsideSidebar = async (id: string): Promise<void> => {
		await editorPanelManager.openPrompt(id);
		if (id !== '__new__') {
			await stateService.saveLastPromptId(id);
		}
		await sidebarProvider.syncSelectedPrompt(id);
	};

	// Open prompt when selected in sidebar
	sidebarProvider.onDidOpenPrompt(async (id) => {
		await editorPanelManager.openPrompt(id);
	});

	// Close prompt editor tab immediately when prompt is deleted from sidebar
	sidebarProvider.onDidDeletePrompt((id) => {
		editorPanelManager.closePromptSilently(id);
	});

	// Refresh sidebar when prompt is saved in editor
	editorPanelManager.onDidSave(async () => {
		await sidebarProvider.refreshList();
		await trackerPanelManager.refresh();
	});

	trackerPanelManager.onDidSave(async () => {
		await sidebarProvider.refreshList();
	});

	editorPanelManager.onDidSaveStateChange(({ id, saving }) => {
		sidebarProvider.postMessage({ type: 'promptSaving', id, saving });
	});

	trackerPanelManager.onDidOpenPrompt(async (id) => {
		await openPromptOutsideSidebar(id);
	});

	// Background cache refresh — detects manual file-system changes with low disk/CPU pressure
	storageService.startBackgroundCacheRefresh(() => {
		void sidebarProvider.refreshList();
	});

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('promptManager.createPrompt', () => {
			const triggeredInSidebar = sidebarProvider.triggerCreatePromptUi();
			if (!triggeredInSidebar) {
				editorPanelManager.openPrompt('__new__');
			}
		}),

		vscode.commands.registerCommand('promptManager.openPrompt', async () => {
			const prompts = await storageService.listPrompts();
			if (prompts.length === 0) {
				vscode.window.showInformationMessage('Нет промптов. Создайте новый.');
				return;
			}
			const items = prompts.map(p => ({
				label: p.title || p.id,
				description: p.description,
				detail: `Статус: ${p.status} | Обновлён: ${new Date(p.updatedAt).toLocaleDateString()}`,
				id: p.id,
			}));
			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: 'Выберите промпт для открытия',
			});
			if (selected) {
				await openPromptOutsideSidebar(selected.id);
			}
		}),

		vscode.commands.registerCommand('promptManager.deletePrompt', async () => {
			const prompts = await storageService.listPrompts();
			const items = prompts.map(p => ({ label: p.title || p.id, id: p.id }));
			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: 'Выберите промпт для удаления',
			});
			if (selected) {
				await storageService.deletePrompt(selected.id);
				editorPanelManager.closePromptSilently(selected.id);
				await sidebarProvider.refreshList();
				vscode.window.showInformationMessage(`Промпт "${selected.label}" удалён.`);
			}
		}),

		vscode.commands.registerCommand('promptManager.duplicatePrompt', async () => {
			const prompts = await storageService.listPrompts();
			const items = prompts.map(p => ({ label: p.title || p.id, id: p.id }));
			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: 'Выберите промпт для дублирования',
			});
			if (selected) {
				const newId = await storageService.uniqueId(`${selected.id}-copy`);
				await storageService.duplicatePrompt(selected.id, newId);
				await sidebarProvider.refreshList();
				await openPromptOutsideSidebar(newId);
			}
		}),

		vscode.commands.registerCommand('promptManager.importPrompt', async () => {
			const uris = await vscode.window.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				openLabel: 'Импортировать промпт',
			});
			if (uris?.[0]) {
				const imported = await storageService.importPrompt(uris[0].fsPath);
				if (imported) {
					await sidebarProvider.refreshList();
					await openPromptOutsideSidebar(imported.id);
				}
			}
		}),

		vscode.commands.registerCommand('promptManager.showAbout', async () => {
			await aboutPanelManager.show();
		}),

		vscode.commands.registerCommand('promptManager.exportPrompt', async () => {
			const prompts = await storageService.listPrompts();
			const items = prompts.map(p => ({ label: p.title || p.id, id: p.id }));
			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: 'Выберите промпт для экспорта',
			});
			if (selected) {
				const uris = await vscode.window.showOpenDialog({
					canSelectFolders: true,
					canSelectFiles: false,
					canSelectMany: false,
					openLabel: 'Экспортировать в папку',
				});
				if (uris?.[0]) {
					await storageService.exportPrompt(selected.id, uris[0].fsPath);
					vscode.window.showInformationMessage('Промпт экспортирован.');
				}
			}
		}),

		vscode.commands.registerCommand('promptManager.refreshList', async () => {
			await sidebarProvider.refreshList();
		}),

		vscode.commands.registerCommand('promptManager.startChat', async () => {
			const lastId = stateService.getLastPromptId();
			if (lastId) {
				const prompt = await storageService.getPrompt(lastId);
				if (prompt?.content) {
					// Инкрементируем счётчик использования Copilot Premium запросов
					void copilotUsageService.incrementUsage();

					// --- Branch mismatch check ---
					if (prompt.projects.length > 0) {
						const paths = workspaceService.getWorkspaceFolderPaths();
						const allowedBranches = GitService.getConfiguredAllowedBranches();
						const mismatches = await gitService.getBranchMismatches(paths, prompt.projects, prompt.branch, allowedBranches);
						if (mismatches.length > 0) {
							const details = mismatches.map(m => `Ветка проекта ${m.project} переключена на ${m.currentBranch}`).join('\n');
							const answer = await vscode.window.showWarningMessage(
								details,
								{ modal: true },
								'Продолжить',
							);
							if (answer !== 'Продолжить') {
								return;
							}
						}
					}

					const globalContext = stateService.getGlobalAgentContext();
					const parts: string[] = [];
					try {
						await workspaceService.ensureChatInstructionsFile(globalContext);
					} catch {
						// keep chat flow even if instructions file sync fails
					}
					try {
						await codeMapChatInstructionService?.prepareInstruction(prompt);
					} catch (error) {
						console.error('[PromptManager] prepare codemap instruction failed:', error);
					}
					let sessionInstructionRecord: Awaited<ReturnType<ChatMemoryInstructionService['prepareSessionInstruction']>> | null = null;
					try {
						sessionInstructionRecord = await chatMemoryInstructionService?.prepareSessionInstruction(prompt) ?? null;
					} catch (error) {
						console.error('[PromptManager] prepareSessionInstruction failed:', error);
					}
					parts.push(prompt.content);

					const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
					const chatContextFiles = buildChatContextFiles({
						workspaceRoot,
						storageDir: storageService.getStorageDirectoryPath(),
						promptContextFiles: prompt.contextFiles,
						sessionInstructionFilePath: sessionInstructionRecord?.instructionFilePath,
					});
					const fileUris = chatContextFiles.allAbsolutePaths.map(filePath => vscode.Uri.file(filePath));

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
					if (chatContextFiles.promptContextReferences.length > 0) {
						ctx.push(`Context files: ${chatContextFiles.promptContextReferences.join(' ')}`);
					}
					if (chatContextFiles.instructionReferences.length > 0) {
						ctx.push(`Memory instruction files: ${chatContextFiles.instructionReferences.join(' ')}`);
					}
					if (ctx.length > 0) { parts.push(''); parts.push('---'); parts.push('Context:'); ctx.forEach(c => parts.push(`- ${c}`)); }

					if (prompt.status !== 'in-progress') {
						prompt.status = 'in-progress';
						await storageService.savePrompt(prompt);
						await sidebarProvider.refreshList();
					}

					const query = parts.join('\n');
					const requestStartTimestamp = Date.now();
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

					// Prefer switching model after chat is opened so current session picks it
					if (prompt.model) {
						try {
							await new Promise(resolve => setTimeout(resolve, 200));
							const storageModel = await aiService.resolveModelStorageIdentifier(prompt.model);
							requestModelIdentifier = storageModel || requestModelIdentifier;
							requestModelSelector = await aiService.resolveChatOpenModelSelector(prompt.model);
							await stateService.forcePersistChatCurrentLanguageModel(storageModel);
							await aiService.tryApplyChatModelSafely(prompt.model);
						} catch { }
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
									callerMethod: 'activate.promptManager.startChat',
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
										callerMethod: 'activate.promptManager.startChat',
										model: modelForLog,
									});
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

					try {
						await new Promise(resolve => setTimeout(resolve, 150));
						const commands = await vscode.commands.getCommands(true);
						if (prompt.model) {
							const storageModel = await aiService.resolveModelStorageIdentifier(prompt.model);
							requestModelIdentifier = storageModel || requestModelIdentifier;
							requestModelSelector = await aiService.resolveChatOpenModelSelector(prompt.model);
							await stateService.forcePersistChatCurrentLanguageModel(storageModel);
							await forceNewChatSession();
							await new Promise(resolve => setTimeout(resolve, 120));
							await aiService.tryApplyChatModelSafely(prompt.model);
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
						copilotStatusBarProvider.notifyChatStarted();
						void (async () => {
							let trackedSessionId = '';
							const startedSession = await stateService.waitForChatSessionStarted(requestStartTimestamp, 15000, 500);
							if (startedSession.ok && startedSession.sessionId) {
								trackedSessionId = startedSession.sessionId;
								try {
									await chatMemoryInstructionService?.bindChatSession(prompt.promptUuid, trackedSessionId);
								} catch (error) {
									console.error('[PromptManager] bindChatSession failed:', error);
								}
								const promptFromStorage = await storageService.getPrompt(prompt.id);
								if (promptFromStorage) {
									promptFromStorage.chatSessionIds = [
										trackedSessionId,
										...(promptFromStorage.chatSessionIds || []).filter(id => id !== trackedSessionId),
									];
									await storageService.savePrompt(promptFromStorage, { historyReason: 'start-chat' });
								}
							}

							const completion = await stateService.waitForChatRequestCompletion(
								requestStartTimestamp,
								180000,
								1000,
								trackedSessionId || undefined,
							);
							const completionObserved = Number(completion.lastRequestEnded || 0) > Number(completion.lastRequestStarted || 0);
							if (completion.ok || completionObserved) {
								try {
									await chatMemoryInstructionService?.completeChatSession(
										prompt.promptUuid,
										'afterChatCompleted',
										trackedSessionId || completion.sessionId || undefined,
									);
								} catch (error) {
									console.error('[PromptManager] completeChatSession failed:', error);
								}
								return;
							}

							try {
								await chatMemoryInstructionService?.noteChatError(
									prompt.promptUuid,
									`Chat completion not detected (${completion.reason || 'unknown'})`,
									trackedSessionId || completion.sessionId || undefined,
								);
							} catch (error) {
								console.error('[PromptManager] noteChatError failed:', error);
							}
						})();
					} catch (error) {
						void chatMemoryInstructionService?.noteChatError(
							prompt.promptUuid,
							error instanceof Error ? error.message : 'Failed to dispatch chat message',
						);
						// ignore optional compatibility attempts
					}
				}
			}
		}),

		vscode.commands.registerCommand('promptManager.openChat', async () => {
			try {
				await vscode.commands.executeCommand('workbench.action.chat.openAgent');
			} catch {
				await vscode.commands.executeCommand('workbench.action.chat.open');
			}
		}),

		vscode.commands.registerCommand('promptManager.showStatistics', async () => {
			await statisticsPanelManager.show();
		}),

		vscode.commands.registerCommand('promptManager.showTracker', async () => {
			await trackerPanelManager.show();
		}),

		vscode.commands.registerCommand('promptManager.openMemory', async () => {
			await memoryDbReady;
			await memoryPanelManager?.show();
		}),

		vscode.commands.registerCommand('promptManager.openSettings', async () => {
			await vscode.commands.executeCommand('workbench.action.openSettings', extensionSettingsQuery);
		}),

		vscode.commands.registerCommand('promptManager.copilotUsageDiagnostics', async () => {
			const report = await copilotUsageService.buildDiagnosticsReport();
			const output = getPromptManagerOutputChannel();
			output.appendLine('===== Copilot Usage Diagnostics =====');
			output.appendLine(report);
			output.appendLine('===== End Copilot Usage Diagnostics =====');
			showPromptManagerOutputChannel(false);
			await vscode.env.clipboard.writeText(report);
			vscode.window.showInformationMessage('Диагностика Copilot Usage скопирована в буфер и записана в Output: Prompt Manager.');
		}),
	);

	const startupConfig = vscode.workspace.getConfiguration('promptManager');
	const shouldOpenTrackerOnStartup = startupConfig.get<boolean>('startup.openTracker', false);
	const shouldRestoreLastOpenPromptOnStartup = startupConfig.get<boolean>('startup.restoreLastOpenPrompt', false);

	if (shouldOpenTrackerOnStartup || shouldRestoreLastOpenPromptOnStartup) {
		void (async () => {
			if (shouldOpenTrackerOnStartup) {
				await trackerPanelManager.show();
			}

			if (!shouldRestoreLastOpenPromptOnStartup) {
				return;
			}

			const { wasOpen, promptId } = stateService.getStartupEditorRestoreState();
			if (!wasOpen || !promptId) {
				return;
			}

			const prompt = await storageService.getPrompt(promptId);
			if (!prompt) {
				await stateService.saveStartupEditorRestoreState(false, null);
				return;
			}

			await openPromptOutsideSidebar(prompt.id);
		})();
	}

	// Cleanup
	context.subscriptions.push({
		dispose() {
			storageService.cancelBackgroundCacheRefresh();
			workspaceService.dispose();
			editorPanelManager.prepareForShutdown();
			editorPanelManager.disposeAll();
			statisticsPanelManager.dispose();
			trackerPanelManager.dispose();
			copilotUsagePanelManager.dispose();
			copilotStatusBarProvider.dispose();
			copilotUsageService.dispose();

			// Memory system cleanup
			memoryCleanup?.dispose();
			memoryHttpServer?.dispose();
			memoryEmbedding?.dispose();
			memoryNotification?.dispose();
			chatMemoryInstructionService?.dispose();
			codeMapChatInstructionService?.dispose();
			codeMapOrchestratorService?.dispose();
			codeMapDb?.close();
			memoryDb?.close();
			consoleInterceptor.dispose();
			disposePromptManagerOutputChannel();
		},
	});

}

export function deactivate() {
}
