/**
 * Prompt Manager — VS Code Extension Entry Point
 */

import * as vscode from 'vscode';
import { StorageService, AiService, WorkspaceService, GitService, StateService } from './services/index.js';
import { SidebarProvider, EditorPanelManager, StatisticsPanelManager, TrackerPanelManager } from './providers/index.js';

export function activate(context: vscode.ExtensionContext) {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		vscode.window.showWarningMessage('Prompt Manager: откройте рабочую область для использования расширения.');
		return;
	}

	// Initialize services
	const storageService = new StorageService(workspaceRoot);
	const aiService = new AiService();
	const workspaceService = new WorkspaceService();
	const gitService = new GitService();
	const stateService = new StateService(context);

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
	);

	const statisticsPanelManager = new StatisticsPanelManager(
		context.extensionUri,
		storageService,
	);

	const trackerPanelManager = new TrackerPanelManager(
		context.extensionUri,
		storageService,
		stateService,
	);

	// Register sidebar webview provider
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			SidebarProvider.viewType,
			sidebarProvider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);

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

	editorPanelManager.onDidSaveStateChange(({ id, saving }) => {
		sidebarProvider.postMessage({ type: 'promptSaving', id, saving });
	});

	trackerPanelManager.onDidOpenPrompt(async (id) => {
		await editorPanelManager.openPrompt(id);
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
				await editorPanelManager.openPrompt(selected.id);
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
				await editorPanelManager.openPrompt(newId);
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
					await editorPanelManager.openPrompt(imported.id);
				}
			}
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
					// --- Branch mismatch check ---
					if (prompt.projects.length > 0) {
						const paths = workspaceService.getWorkspaceFolderPaths();
						const mismatches = await gitService.getBranchMismatches(paths, prompt.projects, prompt.branch);
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
					parts.push(prompt.content);

					const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
					const fileUris = prompt.contextFiles.map(f => vscode.Uri.file(f.startsWith('/') ? f : `${workspaceRoot}/${f}`));

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
					if (ctx.length > 0) { parts.push(''); parts.push('---'); parts.push('Context:'); ctx.forEach(c => parts.push(`- ${c}`)); }

					if (prompt.status !== 'in-progress') {
						prompt.status = 'in-progress';
						await storageService.savePrompt(prompt);
						await sidebarProvider.refreshList();
					}

					const query = parts.join('\n');
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
					} catch {
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
	);

	// Cleanup
	context.subscriptions.push({
		dispose() {
			workspaceService.dispose();
			editorPanelManager.disposeAll();
			statisticsPanelManager.dispose();
			trackerPanelManager.dispose();
		},
	});

}

export function deactivate() {
}
