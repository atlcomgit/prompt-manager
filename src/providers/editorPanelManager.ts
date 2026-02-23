/**
 * Editor webview panel — shows prompt configuration form in a separate editor tab.
 * Multiple instances can be open simultaneously (one per prompt).
 */

import * as vscode from 'vscode';
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

export class EditorPanelManager {
	private _onDidSave = new vscode.EventEmitter<string>();
	public readonly onDidSave = this._onDidSave.event;
	private chatTrackingDisposables = new Map<string, vscode.Disposable>();
	private pendingRestorePrompt: Prompt | null = null;
	private pendingRestoreIsDirty = false;

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

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly storageService: StorageService,
		private readonly aiService: AiService,
		private readonly workspaceService: WorkspaceService,
		private readonly gitService: GitService,
		private readonly stateService: StateService,
	) { }

	/** Open or focus an editor panel for a prompt */
	async openPrompt(promptId: string): Promise<void> {
		const isNew = promptId === '__new__';
		const panelKey = isNew ? `new-${Date.now()}` : promptId;

		// If panel already open, reveal it
		const existing = openPanels.get(promptId);
		if (existing && !isNew) {
			existing.reveal();
			return;
		}

		// Load prompt data
		let prompt: Prompt;
		if (isNew) {
			prompt = createDefaultPrompt('');
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
		let isDirty = restoredUnsaved;
		let latestPromptState: Prompt | null = restoredUnsaved ? prompt : null;
		const normalizePromptForCompare = (p: Prompt): string => {
			const normalized = {
				...p,
				updatedAt: '',
			};
			return JSON.stringify(normalized);
		};
		if (isDirty) {
			const displayTitle = latestPromptState?.title || prompt.title || prompt.id || (isRu ? 'Новый промпт' : 'New prompt');
			panel.title = `⚡● ${displayTitle}`;
		}

		// Handle panel close — warn if unsaved changes
		panel.onDidDispose(async () => {
			openPanels.delete(panelKey);
			this.chatTrackingDisposables.get(panelKey)?.dispose();
			this.chatTrackingDisposables.delete(panelKey);
			const currentSnapshot: Prompt = latestPromptState
				? JSON.parse(JSON.stringify(latestPromptState))
				: JSON.parse(JSON.stringify(prompt));

			let hasUnsavedChanges = isDirty;
			if (!hasUnsavedChanges) {
				if (currentSnapshot.id) {
					const persisted = await this.storageService.getPrompt(currentSnapshot.id);
					hasUnsavedChanges = !persisted
						|| normalizePromptForCompare(currentSnapshot) !== normalizePromptForCompare(persisted);
				} else {
					hasUnsavedChanges = Boolean(
						currentSnapshot.title
						|| currentSnapshot.description
						|| currentSnapshot.content
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
				const saveLabel = isRu ? 'Сохранить' : 'Save';
				const discardLabel = isRu ? 'Отбросить' : 'Discard';
				const promptTitle = dirtySnapshot.title || dirtySnapshot.id || (isRu ? 'Новый промпт' : 'New prompt');
				const answer = await vscode.window.showWarningMessage(
					isRu
						? `Промпт "${promptTitle}" имеет несохранённые изменения. Сохранить?`
						: `Prompt "${promptTitle}" has unsaved changes. Save?`,
					{ modal: true },
					saveLabel,
					discardLabel
				);

				if (answer !== saveLabel && answer !== discardLabel) {
					this.pendingRestorePrompt = dirtySnapshot;
					this.pendingRestoreIsDirty = true;
					setTimeout(() => {
						void this.openPrompt(dirtySnapshot.id || '__new__');
					}, 0);
					return;
				}

				if (answer === saveLabel) {
					try {
						// Ensure prompt has an id before saving
						if (!dirtySnapshot.id) {
							const slug = await this.aiService.generateSlug(dirtySnapshot.title, dirtySnapshot.description);
							dirtySnapshot.id = await this.storageService.uniqueId(slug || 'untitled');
						}
						await this.storageService.savePrompt(dirtySnapshot);
						await this.broadcastAvailableLanguagesAndFrameworks();
						this._onDidSave.fire(dirtySnapshot.id);
						// vscode.window.showInformationMessage(
						// 	isRu
						// 		? `Промпт "${dirtySnapshot.title || dirtySnapshot.id}" сохранён.`
						// 		: `Prompt "${dirtySnapshot.title || dirtySnapshot.id}" saved.`
						// );
					} catch (err) {
						vscode.window.showErrorMessage(
							isRu ? `Ошибка сохранения: ${err}` : `Save error: ${err}`
						);
					}
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
					} else if (msg.dirty && !latestPromptState) {
						latestPromptState = JSON.parse(JSON.stringify(prompt));
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
				await this.handleMessage(msg, panel, prompt, panelKey, () => isDirty, (v: boolean) => { isDirty = v; });
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
		const postMessage = (m: ExtensionToWebviewMessage) => panel.webview.postMessage(m);

		switch (msg.type) {
			case 'ready': {
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
				let promptToSave = msg.prompt;

				// Generate missing fields via AI
				if (!promptToSave.title && promptToSave.content) {
					promptToSave.title = await this.aiService.generateTitle(promptToSave.content);
				}
				if (!promptToSave.description && promptToSave.content) {
					promptToSave.description = await this.aiService.generateDescription(promptToSave.content);
				}
				if (!promptToSave.id) {
					const slug = await this.aiService.generateSlug(promptToSave.title, promptToSave.description);
					promptToSave.id = await this.storageService.uniqueId(slug);
				}

				// Auto-detect languages & frameworks
				if (promptToSave.languages.length === 0 && promptToSave.content) {
					promptToSave.languages = await this.aiService.detectLanguages(promptToSave.content);
				}
				if (promptToSave.frameworks.length === 0 && promptToSave.content) {
					promptToSave.frameworks = await this.aiService.detectFrameworks(promptToSave.content);
				}

				const saved = await this.storageService.savePrompt(promptToSave);
				setIsDirty(false);

				// Update current prompt reference
				Object.assign(currentPrompt, promptToSave);

				// Update panel tracking
				if (panelKey.startsWith('new-')) {
					openPanels.delete(panelKey);
					openPanels.set(promptToSave.id, panel);
				}

				panel.title = `⚡ ${saved.title || saved.id}`;
				postMessage({ type: 'promptSaved', prompt: saved });
				postMessage({ type: 'prompt', prompt: promptToSave });
				await this.broadcastAvailableLanguagesAndFrameworks();

				this._onDidSave.fire(promptToSave.id);
				// vscode.window.showInformationMessage(`Промпт "${saved.title || saved.id}" сохранён.`);
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
				const slug = await this.aiService.generateSlug(msg.title, msg.description);
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
					// Ensure prompt has id and persist latest editor state before starting chat
					if (!prompt.id) {
						const slug = await this.aiService.generateSlug(prompt.title, prompt.description);
						prompt.id = await this.storageService.uniqueId(slug || 'untitled');
					}
					await this.storageService.savePrompt(prompt);
					Object.assign(currentPrompt, prompt);

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
						this._onDidSave.fire(prompt.id);
						postMessage({ type: 'prompt', prompt });
					}

					const query = parts.join('\n');
					let requestModelIdentifier = '';
					let requestModelSelector: vscode.LanguageModelChatSelector | undefined;

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
					} catch {
						// ignore optional compatibility attempts
					}

					// Notify webview that chat was started
					postMessage({ type: 'chatStarted', promptId: prompt.id });

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
				try {
					await vscode.commands.executeCommand('workbench.action.chat.openAgent');
				} catch {
					await vscode.commands.executeCommand('workbench.action.chat.open');
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
					postMessage({ type: 'info', message: `Branch "${msg.branch}" created.` });
				} else {
					postMessage({ type: 'error', message: `Errors: ${result.errors.join(', ')}` });
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
					const suggestions = await this.aiService.generateSuggestionVariants(msg.textBefore, 3);
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
		for (const d of this.chatTrackingDisposables.values()) {
			d.dispose();
		}
		this.chatTrackingDisposables.clear();
		for (const panel of openPanels.values()) {
			panel.dispose();
		}
		openPanels.clear();
	}
}
