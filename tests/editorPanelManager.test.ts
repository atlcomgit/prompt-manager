import { normalizePromptEditorLayout } from '../src/types/promptEditorLayout.js';
import { normalizePromptDashboardLayouts } from '../src/types/promptDashboard.js';
import { normalizePromptDashboardPreferences, type DashboardQuickCommandTarget } from '../src/types/promptDashboardPreferences.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import Module from 'node:module';
import { DASHBOARD_QUICK_COMMAND_REPLY_TIMEOUT_MS, DASHBOARD_QUICK_COMMAND_TIMEOUT_MS, EDITOR_WEBVIEW_ASSET_VERSION } from '../src/constants/webview.js';
import { buildSaveQueueKey } from '../src/utils/promptSaveQueue.js';
import { confirmDashboardQuickCommand, type PendingDashboardQuickCommand } from '../src/utils/promptDashboard.js';
import type { OpenCodeCliRequest, OpenCodeCliService } from '../src/services/openCodeCliService.js';

const originalLoad = (Module as any)._load;
const vscodeCommandCalls: Array<{ id: string; args: unknown[] }> = [];
const vscodeNotices: Array<{ kind: 'info' | 'warning' | 'error'; message: string }> = [];
const vscodeCreatedWebviewPanels: any[] = [];
const vscodeCreatedWatchers: any[] = [];
const vscodeClosedTabs: any[] = [];
const vscodeTabChangeListeners: Array<(event: { opened: any[]; closed: any[]; changed: any[] }) => void> = [];
const vscodeTabs: any[] = [];
class MockChatTabInput {}
const vscodeAdditionalTabGroups: Array<{ viewColumn?: number; activeTab: { input: { viewType: string } | MockChatTabInput }; tabs: unknown[] }> = [];
let vscodeDashboardActiveColumn = 1;
let vscodeDashboardEditorLayout: unknown;
const vscodeTextDocuments: any[] = [];
const vscodeTextDocumentChangeListeners = new Set<(event: { document: any }) => void>();
const vscodeWorkspaceFiles = new Map<string, string>();
let vscodeExecuteCommandHandler: ((id: string, ...args: unknown[]) => Promise<unknown>) | undefined;
/** Подменяет запись в буфер обмена, например незавершающейся записью браузера без фокуса окна. */
let vscodeClipboardWriteHandler: ((value: string) => Promise<void>) | undefined;
let vscodeAvailableCommands: string[] | undefined;
/** Подмена Claude не активирует установленное расширение при unit-проверках. */
let vscodeClaudeExtension: any = { isActive: true };
let vscodeClipboardText = '';
let vscodeActiveTextEditor: any;
let vscodeActiveTerminal: { creationOptions: { env: Record<string, string> } } | undefined;
let vscodeWindowFocused = true;
let chooseHistoryRevision: ((items: Array<{ entryId: string }>) => { entryId: string }) | undefined;
/** Тип клиента отделён от Linux-хоста, чтобы проверить запрет серверных клавиш в туннеле. */
let vscodeUiKind = 1;
let vscodeRemoteName: string | undefined;
const vscodeConfigurationValues = new Map<string, unknown>();
/** Workspace override и задержка записи моделируются без изменения настоящих настроек VS Code. */
const vscodeWorkspaceConfigurationValues = new Map<string, unknown>();
let vscodeConfigurationUpdateHandler: ((key: string, value: unknown, target: unknown) => Promise<void>) | undefined;
/** Вызовы `WorkspaceConfiguration.update`, записанные заглушкой VS Code. */
const vscodeConfigurationUpdates: Array<{ key: string; value: unknown; target: unknown }> = [];
const childProcessSpawnCalls: Array<{ command: string; args: string[] }> = [];
let childProcessSpawnHandler: ((command: string, args: string[], options?: unknown) => unknown) | undefined;

const vscodePrimaryTabGroup: any = {
	isActive: true,
	viewColumn: 1,
	get activeTab() {
		return vscodeTabs.find(tab => tab.isActive);
	},
	get tabs() {
		return vscodeTabs;
	},
};

function createDisposable() {
	return { dispose() { } };
}

function resetVsCodeCommandMock() {
	vscodeCommandCalls.length = 0;
	vscodeNotices.length = 0;
	vscodeConfigurationUpdates.length = 0;
	vscodeWorkspaceConfigurationValues.clear();
	vscodeConfigurationUpdateHandler = undefined;
	vscodeCreatedWebviewPanels.length = 0;
	vscodeCreatedWatchers.length = 0;
	vscodeClosedTabs.length = 0;
	vscodeTabChangeListeners.length = 0;
	vscodeTabs.length = 0;
	vscodeAdditionalTabGroups.length = 0;
	vscodeDashboardActiveColumn = 1;
	vscodeDashboardEditorLayout = undefined;
	vscodeTextDocuments.length = 0;
	vscodeTextDocumentChangeListeners.clear();
	vscodeWorkspaceFiles.clear();
	vscodeExecuteCommandHandler = undefined;
	vscodeClipboardWriteHandler = undefined;
	vscodeAvailableCommands = undefined;
	vscodeClaudeExtension = { isActive: true };
	vscodeClipboardText = '';
	vscodeActiveTextEditor = undefined;
	vscodeActiveTerminal = undefined;
	vscodeWindowFocused = true;
	vscodeUiKind = 1;
	vscodeRemoteName = undefined;
	childProcessSpawnCalls.length = 0;
	childProcessSpawnHandler = undefined;
}

function emitVsCodeTabChange(event: { opened?: any[]; closed?: any[]; changed?: any[] }) {
	const normalized = {
		opened: event.opened || [],
		closed: event.closed || [],
		changed: event.changed || [],
	};
	for (const listener of vscodeTabChangeListeners) {
		listener(normalized);
	}
}

function removeVsCodeTab(tab: any) {
	const index = vscodeTabs.indexOf(tab);
	if (index >= 0) {
		vscodeTabs.splice(index, 1);
		emitVsCodeTabChange({ closed: [tab] });
	}
}

function createMockTextDocument(content = '', language = 'plaintext', uri?: { fsPath?: string; toString?: () => string }) {
	const lines = content.split(/\r?\n/);
	const fallbackUri = {
		fsPath: '',
		toString: () => `untitled:mock-${vscodeTextDocuments.length + 1}`,
	};
	const document = {
		uri: uri || fallbackUri,
		languageId: language,
		get lineCount() {
			return Math.max(1, lines.length);
		},
		lineAt: (line: number) => ({ text: lines[line] || '' }),
		getText: () => content,
	};
	vscodeTextDocuments.push(document);
	return document;
}

/** Модель поля штатного чата, доступная через тот же API документов, что и в VS Code. */
function createMockNativeChatInput(content = '') {
	const document = {
		uri: { scheme: 'chatSessionInput', toString: () => 'chatSessionInput:/chat-input' },
		version: 1,
		getText: () => content,
	};
	vscodeTextDocuments.push(document);
	return {
		setText(text: string) {
			content = text;
			document.version += 1;
			for (const listener of vscodeTextDocumentChangeListeners) listener({ document });
		},
	};
}

function createVsCodeTab(viewType: string, label: string, active = true, panel?: any) {
	if (active) {
		for (const tab of vscodeTabs) {
			tab.isActive = false;
		}
	}
	const tab: any = {
		label,
		group: vscodePrimaryTabGroup,
		input: { viewType },
		isActive: active,
		isDirty: false,
		isPinned: false,
		isPreview: false,
		panel,
	};
	vscodeTabs.push(tab);
	emitVsCodeTabChange({ opened: [tab] });
	return tab;
}

function seedPromptEditorTab(label = 'Prompt: Prompt A', active = true) {
	// TabInputWebview exposes VS Code's internal view type, unlike WebviewPanel.viewType.
	return createVsCodeTab('mainThreadWebview-promptManager.editor', label, active);
}

function createDetachedPromptEditorPanel(label = 'Prompt: Prompt A restored') {
	const disposeListeners: Array<() => void | Promise<void>> = [];
	const viewStateListeners: Array<(event: { webviewPanel: any }) => void> = [];
	const messageListeners: Array<(message: unknown) => void | Promise<void>> = [];
	const options = { retainContextWhenHidden: true };
	const panel: any = {
		viewType: 'promptManager.editor',
		title: label,
		options,
		visible: true,
		iconPath: undefined,
		disposed: false,
		revealed: false,
		postedMessages: [] as unknown[],
		webview: {
			html: '',
			options,
			cspSource: 'vscode-resource:',
			asWebviewUri: (uri: unknown) => uri,
			postMessage: async (message: unknown) => {
				panel.postedMessages.push(message);
				return true;
			},
			onDidReceiveMessage: (listener: (message: unknown) => void | Promise<void>) => {
				messageListeners.push(listener);
				return createDisposable();
			},
		},
		onDidDispose: (listener: () => void | Promise<void>) => {
			disposeListeners.push(listener);
			return createDisposable();
		},
		onDidChangeViewState: (listener: (event: { webviewPanel: any }) => void) => {
			viewStateListeners.push(listener);
			return createDisposable();
		},
		reveal: () => {
			panel.visible = true;
			for (const tab of vscodeTabs) {
				tab.isActive = false;
			}
			if (panel.tab) {
				panel.tab.isActive = true;
				emitVsCodeTabChange({ changed: [panel.tab] });
			}
			panel.revealed = true;
		},
		dispose: () => {
			if (panel.disposed) {
				return;
			}
			panel.disposed = true;
			if (panel.tab) {
				removeVsCodeTab(panel.tab);
			}
			for (const listener of disposeListeners) {
				void listener();
			}
		},
		emitMessage: async (message: unknown) => {
			for (const listener of messageListeners) {
				await listener(message);
			}
		},
		emitVisible: () => {
			panel.visible = true;
			for (const listener of viewStateListeners) {
				listener({ webviewPanel: panel });
			}
		},
	};
	panel.tab = createVsCodeTab('mainThreadWebview-promptManager.editor', label, true, panel);
	return panel;
}

function resetVsCodeConfigurationMock() {
	vscodeConfigurationValues.clear();
}

function setVsCodeConfigurationValues(values?: Record<string, unknown>) {
	resetVsCodeConfigurationMock();
	for (const [key, value] of Object.entries(values || {})) {
		vscodeConfigurationValues.set(key, value);
	}
}

function createVsCodeMock() {
	class EventEmitter<T> {
		private readonly listeners: Array<(value: T) => void> = [];

		public readonly event = (listener: (value: T) => void) => {
			this.listeners.push(listener);
			return createDisposable();
		};

		fire(value: T): void {
			for (const listener of this.listeners) {
				listener(value);
			}
		}
	}

	class Disposable {
		constructor(private readonly callback: () => void) { }

		static from(...disposables: Array<{ dispose(): void }>) {
			return new Disposable(() => {
				for (const disposable of disposables) {
					disposable.dispose();
				}
			});
		}

		dispose(): void {
			this.callback();
		}
	}

	class RelativePattern {
		constructor(
			public readonly base: string,
			public readonly pattern: string,
		) { }
	}

	class Position {
		constructor(
			public readonly line: number,
			public readonly character: number,
		) { }
	}

	class Selection {
		public readonly anchor: Position;
		public readonly active: Position;

		constructor(
			public readonly start: Position,
			public readonly end: Position,
		) {
			this.anchor = start;
			this.active = end;
		}
	}

	const outputChannel = {
		appendLine() { },
		show() { },
		dispose() { },
	};

	const createWatcher = (pattern?: unknown) => {
		const createListeners: Array<(uri?: unknown) => void> = [];
		const changeListeners: Array<(uri?: unknown) => void> = [];
		const deleteListeners: Array<(uri?: unknown) => void> = [];
		const watcher = {
			pattern,
			onDidCreate: (listener: (uri?: unknown) => void) => {
				createListeners.push(listener);
				return createDisposable();
			},
			onDidChange: (listener: (uri?: unknown) => void) => {
				changeListeners.push(listener);
				return createDisposable();
			},
			onDidDelete: (listener: (uri?: unknown) => void) => {
				deleteListeners.push(listener);
				return createDisposable();
			},
			emitCreate: (uri?: unknown) => {
				for (const listener of createListeners) {
					listener(uri);
				}
			},
			emitChange: (uri?: unknown) => {
				for (const listener of changeListeners) {
					listener(uri);
				}
			},
			emitDelete: (uri?: unknown) => {
				for (const listener of deleteListeners) {
					listener(uri);
				}
			},
			dispose() { },
		};
		vscodeCreatedWatchers.push(watcher);
		return watcher;
	};

	const createWebviewPanel = (viewType: string, title: string, _column: unknown, options: unknown) => {
		const disposeListeners: Array<() => void | Promise<void>> = [];
		const viewStateListeners: Array<(event: { webviewPanel: any }) => void> = [];
		const messageListeners: Array<(message: unknown) => void | Promise<void>> = [];
		const panel: any = {
			viewType,
			title,
			options,
			visible: true,
			iconPath: undefined,
			disposed: false,
			revealed: false,
			postedMessages: [] as unknown[],
			webview: {
				html: '',
				options,
				cspSource: 'vscode-resource:',
				asWebviewUri: (uri: unknown) => uri,
				postMessage: async (message: unknown) => {
					panel.postedMessages.push(message);
					return true;
				},
				onDidReceiveMessage: (listener: (message: unknown) => void | Promise<void>) => {
					messageListeners.push(listener);
					return createDisposable();
				},
			},
			onDidDispose: (listener: () => void | Promise<void>) => {
				disposeListeners.push(listener);
				return createDisposable();
			},
			onDidChangeViewState: (listener: (event: { webviewPanel: any }) => void) => {
				viewStateListeners.push(listener);
				return createDisposable();
			},
			reveal: () => {
				panel.visible = true;
				for (const tab of vscodeTabs) {
					tab.isActive = false;
				}
				if (panel.tab) {
					panel.tab.isActive = true;
					emitVsCodeTabChange({ changed: [panel.tab] });
				}
				panel.revealed = true;
			},
			dispose: () => {
				if (panel.disposed) {
					return;
				}
				panel.disposed = true;
				if (panel.tab) {
					removeVsCodeTab(panel.tab);
				}
				for (const listener of disposeListeners) {
					void listener();
				}
			},
			emitMessage: async (message: unknown) => {
				for (const listener of messageListeners) {
					await listener(message);
				}
			},
			emitVisible: () => {
				panel.visible = true;
				for (const listener of viewStateListeners) {
					listener({ webviewPanel: panel });
				}
			},
			/** Доставляет host настоящее событие скрытия, не меняя рабочие окна VS Code. */
			emitHidden: () => {
				panel.visible = false;
				for (const listener of viewStateListeners) {
					listener({ webviewPanel: panel });
				}
			},
		};
		panel.tab = createVsCodeTab(`mainThreadWebview-${viewType}`, title, true, panel);
		vscodeCreatedWebviewPanels.push(panel);
		return panel;
	};

	return {
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
		EventEmitter,
		Disposable,
		RelativePattern,
		Position,
		Selection,
		Uri: {
			file: (value: string) => ({
				fsPath: value,
				toString: () => value,
			}),
			parse: (value: string) => ({
				value,
				toString: () => value,
			}),
			joinPath: (base: { fsPath?: string }, ...parts: string[]) => {
				const fsPath = [base.fsPath || '', ...parts].join('/');
				return {
					fsPath,
					toString: () => fsPath,
				};
			},
		},
		workspace: {
			workspaceFolders: [{ uri: { fsPath: '/tmp/workspace' } }],
			textDocuments: vscodeTextDocuments,
			openTextDocument: async (input?: { content?: string; language?: string; fsPath?: string; toString?: () => string } | string) => {
				if (typeof input === 'string') {
					return createMockTextDocument('', 'plaintext');
				}
				if (typeof input?.fsPath === 'string') {
					const uriKey = input.toString?.() || input.fsPath || '';
					const content = vscodeWorkspaceFiles.get(uriKey) || '';
					return createMockTextDocument(content, 'markdown', input);
				}
				return createMockTextDocument(input?.content || '', input?.language || 'plaintext');
			},
			getConfiguration: (section?: string) => ({
				get: (key: string, defaultValue: unknown) => {
					const fullKey = section ? `${section}.${key}` : key;
					return vscodeConfigurationValues.has(fullKey)
						? vscodeConfigurationValues.get(fullKey)
						: defaultValue;
				},
				inspect: (key: string) => {
					const fullKey = section ? `${section}.${key}` : key;
					return {
						...(vscodeConfigurationValues.has(fullKey) ? { globalValue: vscodeConfigurationValues.get(fullKey) } : {}),
						...(vscodeWorkspaceConfigurationValues.has(fullKey)
							? { workspaceValue: vscodeWorkspaceConfigurationValues.get(fullKey) } : {}),
					};
				},
				update: async (key: string, value: unknown, target: unknown) => {
					vscodeConfigurationUpdates.push({ key: section ? `${section}.${key}` : key, value, target });
					await vscodeConfigurationUpdateHandler?.(section ? `${section}.${key}` : key, value, target);
				},
			}),
			onDidChangeConfiguration: () => createDisposable(),
			onDidChangeTextDocument: (listener: (event: { document: any }) => void) => {
				vscodeTextDocumentChangeListeners.add(listener);
				return { dispose: () => vscodeTextDocumentChangeListeners.delete(listener) };
			},
			onDidSaveTextDocument: () => createDisposable(),
			onDidCloseTextDocument: () => createDisposable(),
			createFileSystemWatcher: (pattern?: unknown) => createWatcher(pattern),
			fs: {
				stat: async () => ({ mtime: Date.now() }),
				createDirectory: async () => undefined,
				readFile: async () => new Uint8Array(),
				writeFile: async (uri: { fsPath?: string; toString?: () => string }, content: Uint8Array) => {
					vscodeWorkspaceFiles.set(uri.toString?.() || uri.fsPath || '', Buffer.from(content).toString('utf8'));
				},
				delete: async (uri: { fsPath?: string; toString?: () => string }) => {
					vscodeWorkspaceFiles.delete(uri.toString?.() || uri.fsPath || '');
				},
			},
		},
		window: {
			state: { get focused() { return vscodeWindowFocused; } },
			get activeTerminal() { return vscodeActiveTerminal; },
			get activeTextEditor() {
				return vscodeActiveTextEditor;
			},
			showTextDocument: async (document: any, options?: { selection?: unknown }) => {
				vscodeActiveTextEditor = {
					document,
					selection: options?.selection,
					selections: options?.selection ? [options.selection] : [],
				};
				if (document?.uri) {
					const uriText = document.uri.toString?.() || document.uri.fsPath || '';
					const existingTab = vscodeTabs.find(tab => tab.input?.uri?.toString?.() === uriText);
					if (existingTab) {
						for (const tab of vscodeTabs) {
							tab.isActive = false;
						}
						existingTab.isActive = true;
					} else {
						const label = uriText.split(/[\\/]/).pop() || 'Untitled';
						const tab = createVsCodeTab('textEditor', label, true);
						tab.input = { uri: document.uri };
					}
				}
				return vscodeActiveTextEditor;
			},
			onDidChangeActiveTextEditor: () => createDisposable(),
			tabGroups: {
				get all() {
					return [vscodePrimaryTabGroup, ...vscodeAdditionalTabGroups];
				},
				get activeTabGroup() {
					return vscodeAdditionalTabGroups.find(group => group.viewColumn === vscodeDashboardActiveColumn) ?? vscodePrimaryTabGroup;
				},
				onDidChangeTabs: (listener: (event: { opened: any[]; closed: any[]; changed: any[] }) => void) => {
					vscodeTabChangeListeners.push(listener);
					return createDisposable();
				},
				close: async (tabOrTabs: any | any[]) => {
					const tabsToClose = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs];
					vscodeClosedTabs.push(...tabsToClose);
					for (const tab of tabsToClose) {
						if (tab.panel && !tab.panel.disposed) {
							tab.panel.dispose();
						} else {
							removeVsCodeTab(tab);
						}
					}
					return true;
				},
			},
			createWebviewPanel,
			createOutputChannel: () => outputChannel,
			showQuickPick: async (items: Array<{ entryId: string }>) => chooseHistoryRevision?.(items),
			showErrorMessage: (message: string) => { vscodeNotices.push({ kind: 'error', message }); },
			showWarningMessage: (message: string) => { vscodeNotices.push({ kind: 'warning', message }); },
			showInformationMessage: (message: string) => { vscodeNotices.push({ kind: 'info', message }); },
		},
		commands: {
			executeCommand: async (id: string, ...args: unknown[]) => {
				vscodeCommandCalls.push({ id, args });
				if (id === 'vscode.getEditorLayout') return vscodeDashboardEditorLayout
					?? { groups: [vscodePrimaryTabGroup, ...vscodeAdditionalTabGroups].map(() => ({})) };
				if (vscodeExecuteCommandHandler) {
					return vscodeExecuteCommandHandler(id, ...args);
				}
				return undefined;
			},
			getCommands: async () => vscodeAvailableCommands || [],
		},
		extensions: {
			getExtension: (id: string) => id === 'anthropic.claude-code' ? vscodeClaudeExtension : ({}),
		},
		env: {
			language: 'en',
			get uiKind() { return vscodeUiKind; },
			get remoteName() { return vscodeRemoteName; },
			clipboard: {
				writeText: async (value: string) => {
					if (vscodeClipboardWriteHandler) {
						return vscodeClipboardWriteHandler(value);
					}
					vscodeClipboardText = value;
				},
				readText: async () => vscodeClipboardText,
			},
		},
		UIKind: { Desktop: 1, Web: 2 },
		TabInputChat: MockChatTabInput,
		ViewColumn: {
			One: 1,
			Beside: 2,
		},
		Range: class Range {
			constructor(
				public readonly start: unknown,
				public readonly end: unknown,
			) { }
		},
		WorkspaceEdit: class WorkspaceEdit {
			replace() { }
		},
	};
}

async function importEditorPanelManager() {
	(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return createVsCodeMock();
		}

		if (request === 'child_process') {
			const childProcess = originalLoad.call(this, request, parent, isMain);
			return {
				...childProcess,
				spawn: (command: string, args: string[] = [], options?: unknown) => {
					childProcessSpawnCalls.push({ command, args });
					if (childProcessSpawnHandler) {
						return childProcessSpawnHandler(command, args, options);
					}
					return childProcess.spawn(command, args, options);
				},
			};
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		// Обе production-реализации используют один изолированный VS Code transport.
		return {
			...await import('../src/providers/editorPanelManager.js'),
			...await import('../src/services/stateService.js'),
		};
	} finally {
		(Module as any)._load = originalLoad;
	}
}

function createPrompt(overrides: Record<string, unknown> = {}) {
	return {
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: '',
		description: '',
		status: 'draft',
		favorite: false,
		archived: false,
		projects: [],
		languages: [],
		frameworks: [],
		skills: [],
		mcpTools: [],
		hooks: [],
		taskNumber: '',
		branch: '',
		trackedBranch: '',
		trackedBranchesByProject: {},
		model: '',
		chatMode: 'agent',
		chatTarget: 'copilot',
		contextFiles: [],
		httpExamples: '',
		chatSessionIds: [],
		timeSpentWriting: 0,
		timeSpentImplementing: 0,
		timeSpentOnTask: 0,
		timeSpentUntracked: 0,
		createdAt: '2026-04-13T00:00:00.000Z',
		updatedAt: '2026-04-13T00:00:00.000Z',
		content: '',
		report: '',
		notes: '',
		...overrides,
	} as any;
}

function clonePrompt<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function createEditorViewState(overrides: Record<string, unknown> = {}) {
	return {
		activeTab: 'main',
		expandedSections: {
			basic: true,
			workspace: true,
			prompt: true,
			globalPrompt: false,
			report: false,
			notes: false,
			memory: false,
			plan: false,
			tech: false,
			integrations: false,
			agent: true,
			groups: false,
			files: false,
			time: true,
		},
		manualSectionOverrides: {},
		descriptionExpanded: false,
		branchesExpanded: false,
		branchesExpandedManual: false,
		contentHeights: {},
		sectionHeights: {},
		...overrides,
	} as any;
}

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createMockChildProcessExit(code: number = 0, stdout = '', stderr = '') {
	const listeners = new Map<string, (...args: unknown[]) => void>();
	const child = {
		stdout: {
			on: (event: string, listener: (chunk: string) => void) => {
				if (event === 'data' && stdout) {
					setTimeout(() => listener(stdout), 0);
				}
				return child.stdout;
			},
		},
		stderr: {
			on: (event: string, listener: (chunk: string) => void) => {
				if (event === 'data' && stderr) {
					setTimeout(() => listener(stderr), 0);
				}
				return child.stderr;
			},
		},
		once: (event: string, listener: (...args: unknown[]) => void) => {
			listeners.set(event, listener);
			if (event === 'exit') {
				setTimeout(() => listener(code, null), 0);
			}
			return child;
		},
		kill: () => undefined,
		listeners,
	};
	return child;
}

function createMockChildProcessError(message: string) {
	const listeners = new Map<string, (...args: unknown[]) => void>();
	const child = {
		once: (event: string, listener: (...args: unknown[]) => void) => {
			listeners.set(event, listener);
			if (event === 'error') {
				setTimeout(() => listener(new Error(message)), 0);
			}
			return child;
		},
		kill: () => undefined,
		listeners,
	};
	return child;
}

/** Собирает manager с изолированными сервисами, включая транспорт новых Codex-сессий. */
async function createManager(options?: {
	/** Изолирует новые Codex-сессии от установленного Agent Host во всех unit-сценариях. */
	prepareCopilotCodexSession?: (title: string, folders: string[]) => Promise<{ openLink: string }>;
	generateTitle?: (content: string) => Promise<string>;
	generateDescription?: (content: string) => Promise<string>;
	initialPrompt?: Record<string, unknown> | null;
	listPrompts?: Array<Record<string, unknown>>;
	savePrompt?: (prompt: any, options?: any) => Promise<any>;
	readAgentProgress?: (id: string) => Promise<number | undefined>;
	stateService?: Record<string, unknown>;
	workspaceService?: Record<string, unknown>;
	configurationValues?: Record<string, unknown>;
	storageDirectoryPath?: string;
	chatMemoryInstructionService?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
	codeMapChatInstructionService?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
	/** Overrides dashboard behavior required by a focused manager test. */
	promptDashboardService?: Record<string, unknown>;
}) {
	setVsCodeConfigurationValues(options?.configurationValues);
	const { EditorPanelManager } = await importEditorPanelManager();
	let storedPrompt = options?.initialPrompt ? createPrompt(options.initialPrompt) : null;
	const storageDirectoryPath = options?.storageDirectoryPath || '/tmp/workspace/.vscode/prompt-manager';
	let sidebarState = {
		selectedPromptId: (storedPrompt?.id || '').trim() || null,
		selectedPromptUuid: (storedPrompt?.promptUuid || '').trim() || null,
	};
	const stateService = {
		waitForPromptDashboardSaves: async () => undefined,
		getPromptEditorLayout: () => normalizePromptEditorLayout(),
		savePromptEditorLayout: async () => undefined,
		invalidatePromptUiSettings: () => undefined,
		observeQuickCommandListChange: () => undefined,
		saveStartupEditorRestoreState: async () => undefined,
		getStartupEditorRestoreState: () => ({ wasOpen: Boolean(storedPrompt?.id), promptId: storedPrompt?.id || null }),
		getPromptEditorViewState: () => createEditorViewState(),
		savePromptEditorViewState: async () => undefined,
		migratePromptEditorViewState: async () => undefined,
		getPromptDashboardLayouts: () => normalizePromptDashboardLayouts(
			undefined,
			stateService.getPromptDashboardSectionOrder(),
			stateService.getPromptDashboardCollapsedSections(),
		),
		getPromptDashboardCollapsedSections: () => ({}),
		savePromptDashboardCollapsedSections: async () => undefined,
		getPromptDashboardSectionOrder: () => [
			['status', 'projectBranches', 'parallelBranches', 'aiAnalysis'],
			['activity', 'reviewRequests', 'projectCommits'],
		],
		savePromptDashboardSectionOrder: async () => undefined,
		getPromptDashboardPreferences: () => undefined,
		savePromptDashboardPreferences: async () => undefined,
		saveLastPromptId: async () => undefined,
		getLastPromptId: () => storedPrompt?.id || null,
		getSidebarState: () => ({ ...sidebarState }),
		saveSidebarState: async (state: { selectedPromptId?: string | null; selectedPromptUuid?: string | null }) => {
			sidebarState = {
				selectedPromptId: state.selectedPromptId ?? null,
				selectedPromptUuid: state.selectedPromptUuid ?? null,
			};
		},
		hasChatSession: async () => true,
		getGitOverlayTrackedBranchPreference: () => '',
		getGitOverlayTrackedBranchesByProjectPreference: () => ({}),
		saveGitOverlayTrackedBranchPreference: async () => undefined,
		getGlobalAgentContext: () => '',
		getGlobalAgentContextSource: () => 'empty',
		saveGlobalAgentContext: async () => undefined,
		...options?.stateService,
	};
	const workspaceService = {
		syncGlobalAgentInstructionsFile: async () => undefined,
		ensureProjectInstructionsFolderRegistered: async () => undefined,
		getWorkspaceFolderPaths: () => ['/tmp/workspace'],
		getWorkspaceFolders: () => ['workspace'],
		getSkills: async () => [],
		getMcpTools: async () => [],
		getHooks: async () => [],
		...options?.workspaceService,
	};
	const dailyTimeChangeListeners = new Set<(event: Record<string, unknown>) => void>();

	const storageService = {
		/** Не пишет файлы при проверке событий открытия редактора. */
		saveActiveTask: async (_id: string | null, _promptUuid?: string | null): Promise<void> => undefined,
		getStorageDirectoryPath: () => storageDirectoryPath,
		getPromptDirectoryPath: (id: string) => `${storageDirectoryPath}/prompts/${id}`,
		getSavedPromptDirectoryPath: (id: string, uuid: string) => id && storedPrompt?.id === id && storedPrompt.promptUuid === uuid
			? `${storageDirectoryPath}/prompts/${id}` : undefined,
		getPromptMarkdownUri: (id: string) => {
			const fsPath = `${storageDirectoryPath}/prompts/${id}/prompt.md`;
			return {
				fsPath,
				toString: () => fsPath,
			};
		},
		getPromptReportUri: (id: string) => {
			const fsPath = `${storageDirectoryPath}/prompts/${id}/report.txt`;
			return {
				fsPath,
				toString: () => fsPath,
			};
		},
		getPromptPlanUri: (id: string) => {
			const fsPath = `${storageDirectoryPath}/prompts/${id}/plan.md`;
			return {
				fsPath,
				toString: () => fsPath,
			};
		},
		markInternalWatchedPromptFileWrite: () => undefined,
		uniqueId: async (base: string) => base,
		exists: async (id: string) => storedPrompt?.id === id,
		getPrompt: async (id: string) => {
			if (!storedPrompt || storedPrompt.id !== id) {
				return null;
			}
			return clonePrompt(storedPrompt);
		},
		getPromptByUuid: async (promptUuid: string) => {
			if (!storedPrompt || storedPrompt.promptUuid !== promptUuid) {
				return null;
			}
			return clonePrompt(storedPrompt);
		},
		listPrompts: async () => (options?.listPrompts || []).map(item => createPrompt(item)),
		savePrompt: async (prompt: any, saveOptions?: any) => {
			if (options?.savePrompt) {
				const savedPrompt = await options.savePrompt(prompt, saveOptions);
				storedPrompt = savedPrompt ? clonePrompt(savedPrompt) : savedPrompt;
				return clonePrompt(savedPrompt);
			}
			storedPrompt = clonePrompt({
				...prompt,
				promptUuid: prompt.promptUuid || 'uuid-a',
				updatedAt: '2026-04-13T00:00:01.000Z',
			});
			return clonePrompt(storedPrompt);
		},
		readAgentProgress: options?.readAgentProgress || (async () => undefined),
		createAgentFile: async () => undefined,
		onDidPromptDailyTimeChange: (listener: (event: Record<string, unknown>) => void) => {
			dailyTimeChangeListeners.add(listener);
			return {
				dispose: () => dailyTimeChangeListeners.delete(listener),
			};
		},
	};

	const aiService = {
		generateTitle: options?.generateTitle || (async () => 'AI title'),
		generateDescription: options?.generateDescription || (async () => 'AI description'),
		getAvailableModels: async () => [],
		// По умолчанию выбранный тип сессии не имеет отдельной запомненной модели.
		resolveSelectedSessionTypeModel: async () => undefined,
		// По умолчанию новый чат — обычная сессия Copilot.
		resolveSelectedChatSessionType: async () => '',
	};
	const promptVoiceService = {
		start: async () => undefined,
		pause: async () => undefined,
		resume: async () => undefined,
		confirm: async () => undefined,
		cancel: async () => undefined,
	};
	const promptDashboardService = {
		getSnapshot: () => null,
		refreshPrompt: async () => null,
		refreshPromptSnapshot: async () => null,
		refreshWidgetSnapshot: async () => null,
		refreshProjectsWidget: async () => null,
		switchProjectBranch: async () => ({ success: true, errors: [] }),
		switchProjectBranches: async () => ({ success: true, errors: [] }),
		setDockerWidgetCollapsed: () => undefined,
		setDockerLiveMetricsVisibility: () => undefined,
		pauseActiveScope: () => undefined,
		analyzeParallelReview: async () => ({ status: 'idle', model: '', content: '' }),
		...options?.promptDashboardService,
	};
	const dockerContainersService = {
		getWorkspaceContainer: async () => null,
		runContainerAction: async () => undefined,
		runWorkspaceAction: async () => ({ action: 'stopAll', rememberedCount: 0, requestedCount: 0, completedCount: 0, failedContainers: [] }),
		getContainerLogs: async () => ({ container: null, content: '' }),
		buildContainerTerminalCommand: () => 'docker exec -it container sh',
		shouldConfirmRemove: () => false,
	};

	const manager = new EditorPanelManager(
		{ fsPath: '/tmp/extension' } as any,
		storageService as any,
		aiService as any,
		workspaceService as any,
		{} as any,
		stateService as any,
		promptVoiceService as any,
		promptDashboardService as any,
		dockerContainersService as any,
		options?.chatMemoryInstructionService as any,
		options?.codeMapChatInstructionService as any,
		undefined,
		{ prepare: options?.prepareCopilotCodexSession ?? (async () => ({
			openLink: 'agent-host-session://ahp-session/testing-codex-session',
		})) },
	);

	return {
		manager,
		storageService,
		aiService,
		promptDashboardService,
		emitDailyTimeChange: (event: Record<string, unknown>) => {
			for (const listener of dailyTimeChangeListeners) {
				listener(event);
			}
		},
		getStoredPrompt: () => clonePrompt(storedPrompt),
	};
}

async function flushTurns(turns: number = 2) {
	for (let index = 0; index < turns; index += 1) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

async function withImmediateTimers<T>(run: () => Promise<T>): Promise<T> {
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((handler: any, _timeout?: number, ...args: any[]) => (
		originalSetTimeout(handler as (...args: any[]) => void, 0, ...args)
	)) as typeof setTimeout;
	try {
		return await run();
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
}

function createGitOverlayProjectSnapshot(project: string, overrides: Record<string, unknown> = {}) {
	return {
		project,
		repositoryPath: `/tmp/${project}`,
		available: true,
		error: '',
		commitError: '',
		currentBranch: 'feature/task-42',
		promptBranch: 'feature/task-42',
		dirty: false,
		hasConflicts: false,
		upstream: 'origin/feature/task-42',
		ahead: 0,
		behind: 0,
		lastCommit: null,
		branches: [],
		cleanupBranches: [],
		changeGroups: {
			merge: [],
			staged: [],
			workingTree: [],
			untracked: [],
		},
		changeDetailsHydrated: true,
		branchDetailsHydrated: true,
		reviewHydrated: true,
		review: { remote: null, request: null, error: '', setupAction: null, titlePrefix: '', unsupportedReason: null },
		recentCommits: [],
		staleLocalBranches: [],
		graph: { nodes: [], edges: [] },
		...overrides,
	} as any;
}

/** Switching to a same-name active copy during history selection or restore keeps that form intact. */
test('showPromptHistory follows the selected archive and leaves a newly opened form intact', async () => {
	for (const switchAt of ['pick', 'restore']) {
		const archived = createPrompt({ id: 'task', promptUuid: 'shared', archived: true, content: 'archive' });
		const active = createPrompt({ ...archived, archived: false, content: 'live' });
		const { manager, storageService } = await createManager({ initialPrompt: archived });
		const key = '__prompt_editor_singleton__';
		const refs = (manager as any).panelPromptRefs;
		refs.set(key, archived);
		const calls: string[] = [];
		const expected = { promptUuid: archived.promptUuid, archived: true };
		(storageService as any).listPromptHistory = async (id: string, owner: unknown) => {
			assert.equal(id, archived.id);
			assert.deepEqual(owner, expected);
			calls.push('list');
			return [{ id: 'earlier', createdAt: archived.createdAt, reason: 'manual' }];
		};
		chooseHistoryRevision = items => {
			if (switchAt === 'pick') { refs.set(key, active); }
			return items[0];
		};
		(storageService as any).restorePromptHistory = async (id: string, revision: string, owner: unknown) => {
			assert.equal(id, archived.id);
			assert.equal(revision, 'earlier');
			assert.deepEqual(owner, expected);
			calls.push('restore');
			refs.set(key, active);
			return { ...archived, content: 'restored' };
		};
		const messages: unknown[] = [];
		const panel = { webview: { postMessage: async (message: unknown) => { messages.push(message); return true; } } };
		try {
			await (manager as any).handleMessage({ type: 'showPromptHistory', id: archived.id }, panel, archived,
				key, () => false, () => assert.fail('Must preserve the new form'));
			assert.deepEqual(calls, switchAt === 'pick' ? ['list'] : ['list', 'restore']);
			assert.deepEqual(messages, []);
			assert.equal(refs.get(key), active);
			assert.equal(active.content, 'live');
		} finally { chooseHistoryRevision = undefined; manager.disposeAll(); }
	}
});

/** Регистрация выбора не ждёт файловой записи и охватывает повторное открытие. */
test('openPrompt persists active task without waiting for storage', async () => {
	resetVsCodeCommandMock();
	const { manager, storageService } = await createManager({
		initialPrompt: { id: 'prompt-a', promptUuid: 'uuid-a', title: 'Prompt A' },
	});
	const writes: Array<{ id: string | null; uuid?: string | null }> = [];
	const pendingWrite = createDeferred<void>();
	storageService.saveActiveTask = (id, uuid) => {
		writes.push({ id, uuid });
		return pendingWrite.promise;
	};
	try {
		await manager.openPrompt({ id: 'prompt-a', promptUuid: 'uuid-a' });
		await manager.openPrompt('prompt-a');
		assert.deepEqual(writes, [
			{ id: 'prompt-a', uuid: 'uuid-a' }, { id: 'prompt-a', uuid: undefined },
		]);
	} finally {
		pendingWrite.resolve();
		for (const panel of vscodeCreatedWebviewPanels) {
			panel.dispose();
		}
	}
});

test('openPrompt posts targeted loading before delayed target prompt resolves', async () => {
	resetVsCodeCommandMock();
	const { manager, storageService } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
		},
		stateService: {
			getPromptEditorViewState: (source: any) => {
				if (source?.promptUuid === 'uuid-b') {
					return createEditorViewState({
						activeTab: 'process',
						expandedSections: {
							...createEditorViewState().expandedSections,
							notes: true,
							plan: true,
							report: true,
						},
						descriptionExpanded: true,
						branchesExpanded: false,
						branchesExpandedManual: true,
						contentHeights: {
							promptContent: 444,
							report: 620,
						},
						sectionHeights: {
							prompt: 520,
							report: 710,
						},
					});
				}

				return createEditorViewState();
			},
		},
	});

	await (manager as any).openPrompt('prompt-a');
	const panel = vscodeCreatedWebviewPanels[0];
	assert.ok(panel);
	panel.postedMessages.length = 0;

	const deferredPrompt = createDeferred<any>();
	let promptBReadStarted = false;
	(storageService as any).getPrompt = async (id: string) => {
		if (id === 'prompt-a') {
			return createPrompt({ id: 'prompt-a', promptUuid: 'uuid-a', title: 'Prompt A' });
		}
		if (id === 'prompt-b') {
			promptBReadStarted = true;
			return deferredPrompt.promise;
		}
		return null;
	};

	const openPromise = (manager as any).openPrompt({ id: 'prompt-b', promptUuid: 'uuid-b' });
	await flushTurns(2);

	const loadingMessage = panel.postedMessages[0] as any;
	assert.equal(promptBReadStarted, true);
	assert.equal(loadingMessage?.type, 'promptLoading');
	assert.equal(loadingMessage?.promptId, 'prompt-b');
	assert.equal(loadingMessage?.promptUuid, 'uuid-b');
	assert.equal(typeof loadingMessage?.openRequestVersion, 'number');
	assert.equal(loadingMessage?.editorViewState?.activeTab, 'process');
	assert.equal(loadingMessage?.editorViewState?.expandedSections?.plan, true);
	assert.equal(loadingMessage?.editorViewState?.descriptionExpanded, true);
	assert.equal(loadingMessage?.editorViewState?.branchesExpanded, false);
	assert.equal(loadingMessage?.editorViewState?.branchesExpandedManual, true);
	assert.equal(loadingMessage?.editorViewState?.contentHeights?.promptContent, 444);
	assert.equal(loadingMessage?.editorViewState?.sectionHeights?.report, 710);

	deferredPrompt.resolve(createPrompt({
		id: 'prompt-b',
		promptUuid: 'uuid-b',
		title: 'Prompt B',
	}));
	await openPromise;

	const openMessage = panel.postedMessages.find((message: any) => message?.type === 'prompt') as any;
	assert.equal(openMessage?.prompt?.id, 'prompt-b');
	assert.equal(openMessage?.openRequestVersion, loadingMessage.openRequestVersion);
	panel.dispose();
});

test('openPrompt starts target prompt load without waiting for slow promptLoading postMessage', async () => {
	resetVsCodeCommandMock();
	const { manager, storageService } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
		},
	});

	await (manager as any).openPrompt('prompt-a');
	const panel = vscodeCreatedWebviewPanels[0];
	assert.ok(panel);
	panel.postedMessages.length = 0;

	const deferredPromptLoadingPost = createDeferred<boolean>();
	panel.webview.postMessage = async (message: unknown) => {
		panel.postedMessages.push(message);
		if ((message as any)?.type === 'promptLoading') {
			return deferredPromptLoadingPost.promise;
		}
		return true;
	};

	let promptBReadStarted = false;
	(storageService as any).getPrompt = async (id: string) => {
		if (id === 'prompt-a') {
			return createPrompt({ id: 'prompt-a', promptUuid: 'uuid-a', title: 'Prompt A' });
		}
		if (id === 'prompt-b') {
			promptBReadStarted = true;
			return createPrompt({ id: 'prompt-b', promptUuid: 'uuid-b', title: 'Prompt B' });
		}
		return null;
	};

	const openPromise = (manager as any).openPrompt({ id: 'prompt-b', promptUuid: 'uuid-b' });
	await flushTurns(2);

	assert.equal(promptBReadStarted, true);
	assert.equal((panel.postedMessages[0] as any)?.type, 'promptLoading');
	assert.equal((panel.postedMessages.find((message: any) => message?.type === 'prompt') as any)?.prompt?.id, 'prompt-b');

	deferredPromptLoadingPost.resolve(true);
	await openPromise;
	panel.dispose();
});

test('loadPromptForOpen returns a pending save snapshot without waiting for disk', async () => {
	resetVsCodeCommandMock();
	const { manager, storageService } = await createManager();
	const deferredSave = createDeferred<any>();
	let diskReadCount = 0;
	(storageService as any).getPrompt = async () => {
		diskReadCount += 1;
		return createPrompt({
			id: 'prompt-b',
			promptUuid: 'uuid-b',
			title: 'Prompt B from disk',
		});
	};

	(manager as any).pendingSaveQueue.set(buildSaveQueueKey('uuid-b', 'prompt-b'), {
		snapshot: createPrompt({
			id: 'prompt-b',
			promptUuid: 'uuid-b',
			title: 'Prompt B pending',
			content: 'pending content',
			report: 'pending report',
		}),
		promise: deferredSave.promise,
		operationId: 'op-1',
	});

	const loaded = await (manager as any).loadPromptForOpen('prompt-b');

	assert.equal(loaded?.title, 'Prompt B pending');
	assert.equal(loaded?.content, 'pending content');
	assert.equal(diskReadCount, 0);

	deferredSave.resolve(createPrompt({
		id: 'prompt-b',
		promptUuid: 'uuid-b',
		title: 'Prompt B saved',
	}));
	await flushTurns(1);
});

test('loadPromptForOpen returns a renamed pending save snapshot by promptUuid without waiting for disk', async () => {
	resetVsCodeCommandMock();
	const { manager, storageService } = await createManager();
	let diskReadCount = 0;
	(storageService as any).getPrompt = async () => {
		diskReadCount += 1;
		return createPrompt({
			id: 'prompt-b-old',
			promptUuid: 'uuid-b',
			title: 'Prompt B from disk',
		});
	};

	(manager as any).pendingSaveQueue.set(buildSaveQueueKey('uuid-b', 'prompt-b-renamed'), {
		snapshot: createPrompt({
			id: 'prompt-b-renamed',
			promptUuid: 'uuid-b',
			title: 'Prompt B pending rename',
			content: 'pending renamed content',
			report: 'pending renamed report',
		}),
		promise: Promise.resolve(createPrompt({
			id: 'prompt-b-renamed',
			promptUuid: 'uuid-b',
			title: 'Prompt B saved rename',
		})),
		operationId: 'op-rename',
	});

	const loaded = await (manager as any).loadPromptForOpen('prompt-b-old', 'uuid-b');

	assert.equal(loaded?.id, 'prompt-b-renamed');
	assert.equal(loaded?.title, 'Prompt B pending rename');
	assert.equal(loaded?.content, 'pending renamed content');
	assert.equal(diskReadCount, 0);
});

/** Копия с активным сохранением не подменяет открытую папку с тем же UUID. */
test('opening a completed prompt with a pending draft copy preserves the exact folder', async () => {
	resetVsCodeCommandMock();
	const completed = createPrompt({ id: 'completed', promptUuid: 'shared', status: 'completed' });
	const draft = createPrompt({ id: 'draft', promptUuid: 'shared', status: 'draft' });
	const { manager, storageService } = await createManager({ initialPrompt: completed });
	storageService.exists = async (id: string) => [completed.id, draft.id].includes(id);
	(manager as any).pendingSaveQueue.set(buildSaveQueueKey(draft.promptUuid, draft.id), {
		snapshot: draft, promise: Promise.resolve(draft), operationId: 'save-draft',
	});
	try {
		await manager.openPrompt({ id: completed.id, promptUuid: completed.promptUuid });
		const opened = (manager as any).panelPromptRefs.get('__prompt_editor_singleton__');
		assert.equal(opened?.id, completed.id);
		assert.equal(opened?.status, 'completed');
	} finally {
		manager.disposeAll();
	}
});

/** Переименованный промпт открывается по UUID, даже если прежний id уже занял другой промпт. */
test('loadPromptForOpen recovers a renamed prompt when its former id is reused', async () => {
	const renamed = createPrompt({ id: 'renamed', promptUuid: 'original-uuid' });
	const { manager, storageService } = await createManager({ initialPrompt: renamed });
	storageService.getPrompt = async id => createPrompt({ id, promptUuid: 'unrelated-uuid' });
	try {
		assert.equal((await (manager as any).loadPromptForOpen('old-id', renamed.promptUuid))?.id, renamed.id);
	} finally {
		manager.disposeAll();
	}
});

test('savePromptEditorViewState message queues persistence without blocking handler', async () => {
	resetVsCodeCommandMock();
	const deferredSave = createDeferred<void>();
	const savedSources: any[] = [];
	const savedStates: any[] = [];
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
		},
		stateService: {
			savePromptEditorViewState: async (source: any, state: any) => {
				savedSources.push(source);
				savedStates.push(state);
				await deferredSave.promise;
			},
		},
	});

	await (manager as any).openPrompt('prompt-a');
	const panel = vscodeCreatedWebviewPanels[0];
	assert.ok(panel);

	const emitPromise = panel.emitMessage({
		type: 'savePromptEditorViewState',
		promptId: 'prompt-a',
		promptUuid: 'uuid-a',
		state: createEditorViewState({ activeTab: 'process' }),
	});

	const handlerResult = await Promise.race([
		emitPromise.then(() => 'resolved'),
		new Promise(resolve => setTimeout(() => resolve('blocked'), 10)),
	]);
	assert.equal(handlerResult, 'resolved');

	await flushTurns(1);
	assert.equal(savedSources.length, 1);
	assert.equal(savedSources[0]?.promptUuid, 'uuid-a');
	assert.equal(savedSources[0]?.promptId, 'prompt-a');
	assert.equal(savedStates[0]?.activeTab, 'process');
	const latestQueuedState = (manager as any).getPromptLoadingEditorViewState('__prompt_editor_singleton__', {
		id: 'prompt-a',
		promptUuid: 'uuid-a',
	});
	assert.equal(latestQueuedState?.activeTab, 'process');

	deferredSave.resolve();
	await flushTurns(1);
	panel.dispose();
});

test('savePromptEditorViewState queue coalesces latest state for same prompt', async () => {
	resetVsCodeCommandMock();
	const savedStates: any[] = [];
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
		},
		stateService: {
			savePromptEditorViewState: async (_source: any, state: any) => {
				savedStates.push(state);
			},
		},
	});

	await (manager as any).openPrompt('prompt-a');
	const panel = vscodeCreatedWebviewPanels[0];
	assert.ok(panel);

	const firstEmit = panel.emitMessage({
		type: 'savePromptEditorViewState',
		promptId: 'prompt-a',
		promptUuid: 'uuid-a',
		state: createEditorViewState({ activeTab: 'main' }),
	});
	const secondEmit = panel.emitMessage({
		type: 'savePromptEditorViewState',
		promptId: 'prompt-a',
		promptUuid: 'uuid-a',
		state: createEditorViewState({ activeTab: 'process' }),
	});

	await Promise.all([firstEmit, secondEmit]);
	await flushTurns(2);

	assert.equal(savedStates.length, 1);
	assert.equal(savedStates[0]?.activeTab, 'process');
	panel.dispose();
});

test('manager startup collapses duplicate prompt editor webview tabs', async () => {
	resetVsCodeCommandMock();
	seedPromptEditorTab('Prompt: Prompt A', true);
	seedPromptEditorTab('Prompt: Prompt A copy', false);

	await createManager();
	await flushTurns(2);

	const promptEditorTabs = vscodeTabs.filter(tab => tab.input?.viewType === 'mainThreadWebview-promptManager.editor');
	assert.equal(promptEditorTabs.length, 1);
	assert.equal(promptEditorTabs[0]?.label, 'Prompt: Prompt A');
	assert.equal(vscodeClosedTabs.length, 1);
});

test('openPrompt closes orphan duplicate prompt editor tab after creating singleton panel', async () => {
	resetVsCodeCommandMock();
	seedPromptEditorTab('Prompt: Prompt A orphan', true);
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
		},
	});

	await (manager as any).openPrompt('prompt-a');
	await flushTurns(2);

	const promptEditorTabs = vscodeTabs.filter(tab => tab.input?.viewType === 'mainThreadWebview-promptManager.editor');
	assert.equal(vscodeCreatedWebviewPanels.length, 1);
	assert.equal(promptEditorTabs.length, 1);
	assert.equal(promptEditorTabs[0]?.panel, vscodeCreatedWebviewPanels[0]);
	assert.equal(vscodeClosedTabs.length, 1);
	vscodeCreatedWebviewPanels[0]?.dispose();
});

/** Late restoration must trigger cleanup through the real tabs API view type. */
test('late prompt editor tabs are deduplicated without closing other webviews with the same title', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({
		initialPrompt: { id: 'prompt-a', promptUuid: 'uuid-a', title: 'Prompt A' },
	});
	await manager.openPrompt('prompt-a');
	await flushTurns(2);
	const livePanel = vscodeCreatedWebviewPanels[0];
	try {
		const reportTab = createVsCodeTab('mainThreadWebview-promptManager.reportEditor', livePanel.title, false);
		const otherTab = createVsCodeTab('mainThreadWebview-other.promptManager.editor', livePanel.title, false);
		const restoredTab = seedPromptEditorTab(livePanel.title, false);
		await flushTurns(2);

		assert.deepEqual(vscodeClosedTabs, [restoredTab]);
		assert.deepEqual(vscodeTabs, [livePanel.tab, reportTab, otherTab]);
		assert.equal(livePanel.disposed, false);
		assert.equal((manager as any).resolveOpenEditorPanel('__prompt_editor_singleton__'), livePanel);
	} finally {
		livePanel.dispose();
	}
});

/** Keep compatibility with hosts exposing the public type alongside internally prefixed restored tabs. */
test('duplicate cleanup handles mixed public and internal prompt editor tab types', async () => {
	resetVsCodeCommandMock();
	const activeTab = createVsCodeTab('promptManager.editor', 'Prompt A', true);
	const restoredTab = seedPromptEditorTab('Prompt A', false);
	await createManager();
	await flushTurns(2);

	assert.deepEqual(vscodeTabs, [activeTab]);
	assert.deepEqual(vscodeClosedTabs, [restoredTab]);
});

/** Сериализатор восстанавливает singleton и настройки; подмена Memento не является перезапуском VS Code. */
test('revivePromptEditorPanel adopts the restored singleton tab without creating a second editor panel', async () => {
	resetVsCodeCommandMock();
	const layouts = normalizePromptDashboardLayouts();
	layouts['two-columns'].sectionOrder = [[], layouts['two-columns'].sectionOrder.flat()];
	layouts['single-column'].collapsedSections = { todos: true };
	const preferences = normalizePromptDashboardPreferences({
		docker: { viewMode: 'table', search: 'restored' }, expanded: { 'project:api': false },
	});
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
		},
		stateService: {
			getPromptDashboardLayouts: () => clonePrompt(layouts),
			getPromptDashboardPreferences: () => clonePrompt(preferences),
			getPromptEditorLayout: () => normalizePromptEditorLayout({ panelSplitRatio: 0.65 }),
		},
	});
	const revivedPanel = createDetachedPromptEditorPanel('Prompt: Prompt A restored');

	await (manager as any).revivePromptEditorPanel(revivedPanel, {
		'pm.editor.promptIdentity': {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
		},
	});
	await flushTurns(2);

	assert.equal(vscodeCreatedWebviewPanels.length, 0);
	assert.equal((manager as any).resolveOpenEditorPanel('__prompt_editor_singleton__'), revivedPanel);
	assert.ok(revivedPanel.webview.html.length > 0);
	const bootGlobalsMatch = revivedPanel.webview.html.match(/Object\.assign\(window, (\{[^\n]+\})\);/);
	assert.ok(bootGlobalsMatch);
	const bootGlobals = JSON.parse(bootGlobalsMatch[1]);
	assert.deepEqual(bootGlobals.__PROMPT_DASHBOARD_LAYOUTS__, layouts);
	assert.deepEqual(bootGlobals.__PROMPT_DASHBOARD_PREFERENCES__, preferences);
	// Первый кадр получает глобальную долю ширины без ожидания сообщения prompt.
	assert.equal(bootGlobals.__PROMPT_EDITOR_LAYOUT__.panelSplitRatio, 0.65);

	const bootId = (manager as any).panelBootIds.get('__prompt_editor_singleton__');
	assert.ok(bootId);
	await revivedPanel.emitMessage({ type: 'ready', bootId, assetVersion: EDITOR_WEBVIEW_ASSET_VERSION });

	const promptMessage = revivedPanel.postedMessages.find((message: any) => message?.type === 'prompt') as any;
	assert.equal(promptMessage?.prompt?.id, 'prompt-a');
	assert.deepEqual(promptMessage?.promptDashboardLayouts, layouts);
	assert.deepEqual(promptMessage?.promptDashboardPreferences, preferences);
	assert.equal(promptMessage?.editorLayout?.panelSplitRatio, 0.65);
	const promptEditorTabs = vscodeTabs.filter(tab => tab.input?.viewType === 'mainThreadWebview-promptManager.editor');
	assert.equal(promptEditorTabs.length, 1);
	revivedPanel.dispose();
});

test('ready posts prompt before slow ready hydration messages', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
		},
	});
	const modelsDeferred = createDeferred<Array<{ id: string; name: string }>>();
	(manager as any).aiService = {
		generateTitle: async () => 'AI title',
		generateDescription: async () => 'AI description',
		getAvailableModels: async () => modelsDeferred.promise,
	};

	await (manager as any).openPrompt('prompt-a');
	const panel = vscodeCreatedWebviewPanels[0];
	assert.ok(panel);
	panel.postedMessages.length = 0;

	const bootId = (manager as any).panelBootIds.get('__prompt_editor_singleton__');
	await panel.emitMessage({ type: 'ready', bootId, assetVersion: EDITOR_WEBVIEW_ASSET_VERSION });

	assert.equal(panel.postedMessages[0]?.type, 'prompt');
	assert.equal(panel.postedMessages.some((message: any) => message?.type === 'availableModels'), false);

	modelsDeferred.resolve([{ id: 'model-a', name: 'Model A' }]);
	await flushTurns(2);

	const modelsMessage = panel.postedMessages.find((message: any) => message?.type === 'availableModels') as any;
	assert.deepEqual(modelsMessage?.models, [{ id: 'model-a', name: 'Model A' }]);
	panel.dispose();
});

/** Пока провайдеры активируются, восстановленная вкладка показывает промпт и не ставит повторы загрузки моделей. */
test('restored editor defers model hydration and its retries until providers are ready', async () => {
	resetVsCodeCommandMock();
	const checkedSessions: string[] = [];
	const discovered: string[] = [];
	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: { id: 'prompt-a', promptUuid: 'uuid-a', chatSessionIds: ['session-a'] },
		stateService: { hasChatSession: async (id: string) => { checkedSessions.push(id); return true; } },
		workspaceService: {
			getSkills: async () => { discovered.push('skills'); return []; },
			getMcpTools: async () => { discovered.push('mcp'); return []; },
			getHooks: async () => { discovered.push('hooks'); return []; },
		},
	});
	const readiness = createDeferred<boolean>();
	(manager as any).whenProvidersReady = () => readiness.promise;
	const models = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
	let loads = 0;
	(manager as any).aiService.getAvailableModels = async () => { loads++; return models; };
	try {
		const panel = createDetachedPromptEditorPanel('Prompt A');
		await manager.revivePromptEditorPanel(panel as any, {
			'pm.editor.promptIdentity': { id: 'prompt-a', promptUuid: 'uuid-a' },
		});
		const bootId = (manager as any).panelBootIds.get('__prompt_editor_singleton__');
		panel.postedMessages.length = 0;
		await withImmediateTimers(async () => {
			const hydration = panel.emitMessage({ type: 'ready', bootId, assetVersion: EDITOR_WEBVIEW_ASSET_VERSION });
			await flushTurns(4);
			assert.equal(panel.postedMessages[0]?.type, 'prompt');
			assert.deepEqual(checkedSessions, []);
			assert.deepEqual(discovered, []);
			assert.equal(loads, 0);
			readiness.resolve(true);
			await hydration;
			await flushTurns(4);
		});
		assert.deepEqual(checkedSessions, ['session-a']);
		assert.deepEqual(getStoredPrompt()?.chatSessionIds, ['session-a']);
		assert.deepEqual(discovered.sort(), ['hooks', 'mcp', 'skills']);
		assert.equal(loads, 1);
		assert.deepEqual(panel.postedMessages.find((msg: any) => msg.type === 'availableModels')?.models, models);
	} finally {
		readiness.resolve(false);
		manager.disposeAll();
	}
});

test('ready from stale editor webview asset reboots the panel before sending prompt data', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
		},
	});

	await (manager as any).openPrompt('prompt-a');
	const panel = vscodeCreatedWebviewPanels[0];
	assert.ok(panel);
	panel.postedMessages.length = 0;

	const staleBootId = (manager as any).panelBootIds.get('__prompt_editor_singleton__');
	const staleHtml = panel.webview.html;
	await panel.emitMessage({ type: 'ready', bootId: staleBootId });

	const nextBootId = (manager as any).panelBootIds.get('__prompt_editor_singleton__');
	assert.notEqual(nextBootId, staleBootId);
	assert.notEqual(panel.webview.html, staleHtml);
	assert.equal(panel.postedMessages.some((message: any) => message?.type === 'prompt'), false);

	await panel.emitMessage({ type: 'ready', bootId: nextBootId, assetVersion: EDITOR_WEBVIEW_ASSET_VERSION });
	assert.equal(panel.postedMessages.some((message: any) => message?.type === 'prompt'), true);
	panel.dispose();
});

/** Повторное несовпадение после cache-bust открывает данные и не запускает бесконечную замену HTML. */
test('ready asset mismatch retries once then opens the prompt without another reboot', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({ initialPrompt: { id: 'prompt-a', promptUuid: 'uuid-a' } });
	try {
		await manager.openPrompt('prompt-a');
		const panel = vscodeCreatedWebviewPanels.at(-1);
		const key = '__prompt_editor_singleton__';
		const firstBoot = (manager as any).panelBootIds.get(key);
		await panel.emitMessage({ type: 'ready', bootId: firstBoot, assetVersion: 'other-build' });
		const retriedBoot = (manager as any).panelBootIds.get(key);
		assert.notEqual(retriedBoot, firstBoot);
		const htmlAfterRetry = panel.webview.html;
		for (let index = 0; index < 3; index++) {
			await panel.emitMessage({ type: 'ready', bootId: retriedBoot, assetVersion: 'other-build' });
		}
		assert.equal(panel.webview.html, htmlAfterRetry);
		assert.equal((manager as any).panelBootIds.get(key), retriedBoot);
		assert.ok(panel.postedMessages.some((m: { type: string; prompt?: { id: string } }) =>
			m.type === 'prompt' && m.prompt?.id === 'prompt-a'));
		assert.ok(panel.postedMessages.some((m: { type: string }) => m.type === 'info'));
	} finally { manager.disposeAll(); }
});

/** Два ready одного boot не обходят лимит, пока первая попытка ждёт сохранения. */
test('concurrent mismatched ready events share one asset reload attempt', async () => {
	resetVsCodeCommandMock();
	let gate: ReturnType<typeof createDeferred<void>> | undefined;
	const { manager } = await createManager({ initialPrompt: { id: 'prompt-a', promptUuid: 'uuid-a' },
		stateService: { waitForPromptDashboardSaves: () => gate?.promise ?? Promise.resolve() } });
	try {
		await manager.openPrompt('prompt-a');
		const panel = vscodeCreatedWebviewPanels.at(-1);
		const key = '__prompt_editor_singleton__';
		const bootId = (manager as any).panelBootIds.get(key);
		const html = panel.webview.html;
		gate = createDeferred<void>();
		const first = panel.emitMessage({ type: 'ready', bootId, assetVersion: 'other-build' });
		await panel.emitMessage({ type: 'ready', bootId, assetVersion: 'other-build' });
		assert.equal(panel.webview.html, html);
		gate.resolve();
		await first;
		assert.notEqual((manager as any).panelBootIds.get(key), bootId);
		assert.equal((manager as any).panelAssetReloadState.get(panel), 'retried');
	} finally { gate?.resolve(); manager.disposeAll(); }
});

test('ready retries available models after a same-prompt ref refresh', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
		},
	});

	let getAvailableModelsCalls = 0;
	const refreshedModels = [
		{ id: 'copilot/gpt-5.4', name: 'GPT-5.4' },
		{ id: 'copilot/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
	];
	const pendingInitialModels = createDeferred<Array<{ id: string; name: string }>>();
	(manager as any).aiService = {
		generateTitle: async () => 'AI title',
		generateDescription: async () => 'AI description',
		getAvailableModels: async () => {
			getAvailableModelsCalls += 1;
			if (getAvailableModelsCalls === 1) {
				return pendingInitialModels.promise;
			}
			return refreshedModels;
		},
	};

	await (manager as any).openPrompt('prompt-a');
	const panel = vscodeCreatedWebviewPanels[0];
	assert.ok(panel);
	panel.postedMessages.length = 0;

	const bootId = (manager as any).panelBootIds.get('__prompt_editor_singleton__');
	await withImmediateTimers(async () => {
		await panel.emitMessage({ type: 'ready', bootId, assetVersion: EDITOR_WEBVIEW_ASSET_VERSION });
		const currentPrompt = (manager as any).panelPromptRefs.get('__prompt_editor_singleton__');
		(manager as any).setPanelPromptRef('__prompt_editor_singleton__', { ...currentPrompt });
		await flushTurns(4);
	});

	const modelMessages = panel.postedMessages.filter((message: any) => message?.type === 'availableModels') as Array<{ models: Array<{ id: string; name: string }> }>;
	assert.deepEqual(modelMessages[0]?.models, []);
	assert.deepEqual(modelMessages[1]?.models, refreshedModels);
	assert.ok(getAvailableModelsCalls >= 2);
	panel.dispose();
});

/** Каждый завершённый прогрев доставляет список открытой панели одним обращением к общему кешу. */
test('catalog refresh re-broadcasts updated models for the open prompt editor without polling', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
		},
	});

	let getAvailableModelsCalls = 0;
	const initialModels = [
		{ id: 'copilot/gpt-5.4', name: 'GPT-5.4' },
	];
	const refreshedModels = [
		{ id: 'copilot/gpt-5.4', name: 'GPT-5.4' },
		{ id: 'copilot/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
	];
	(manager as any).aiService = {
		generateTitle: async () => 'AI title',
		generateDescription: async () => 'AI description',
		getAvailableModels: async () => {
			getAvailableModelsCalls += 1;
			return getAvailableModelsCalls === 1 ? initialModels : refreshedModels;
		},
	};

	await (manager as any).openPrompt('prompt-a');
	const panel = vscodeCreatedWebviewPanels[0];
	assert.ok(panel);
	panel.postedMessages.length = 0;

	manager.refreshAvailableModels();
	await flushTurns(4);
	assert.equal(getAvailableModelsCalls, 1);
	manager.refreshAvailableModels();
	await flushTurns(4);

	const modelMessages = panel.postedMessages.filter((message: any) => message?.type === 'availableModels') as Array<{ models: Array<{ id: string; name: string }> }>;
	assert.deepEqual(modelMessages.map((message) => message.models), [initialModels, refreshedModels]);
	assert.equal(getAvailableModelsCalls, 2);
	panel.dispose();
});

/** Загрузка каталога может завершиться после ready-таймаута; открытая панель получает результат, закрытая — нет. */
for (const disposeBeforeLoad of [false, true]) {
	test(`catalog refresh handles delayed completion with disposed=${disposeBeforeLoad}`, async () => {
		resetVsCodeCommandMock();
		const { manager } = await createManager({ initialPrompt: { id: 'prompt-a', promptUuid: 'uuid-a' } });
		try {
			await manager.openPrompt('prompt-a');
			const panel = vscodeCreatedWebviewPanels[0];
			const pending = createDeferred<Array<{ id: string; name: string }>>();
			(manager as any).aiService.getAvailableModels = () => pending.promise;
			panel.postedMessages.length = 0;
			manager.refreshAvailableModels();
			await flushTurns(2);
			assert.equal(panel.postedMessages.length, 0);
			if (disposeBeforeLoad) { panel.dispose(); }
			const models = [{ id: 'copilot/gpt-6-luna', name: 'GPT-6 Luna' }];
			pending.resolve(models);
			await flushTurns(4);
			const messages = panel.postedMessages.filter((message: { type: string }) => message.type === 'availableModels');
			assert.deepEqual(messages, disposeBeforeLoad ? [] : [{ type: 'availableModels', models }]);
		} finally { manager.disposeAll(); }
	});
}

test('reopening the same prompt rotates the singleton boot cycle before the next ready event', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
		},
	});

	await (manager as any).openPrompt('prompt-a');
	const panel = vscodeCreatedWebviewPanels[0];
	assert.ok(panel);

	const initialBootId = (manager as any).panelBootIds.get('__prompt_editor_singleton__');
	const initialHtml = panel.webview.html;
	panel.postedMessages.length = 0;

	await (manager as any).openPrompt('prompt-a');

	const nextBootId = (manager as any).panelBootIds.get('__prompt_editor_singleton__');
	assert.notEqual(nextBootId, initialBootId);
	assert.notEqual(panel.webview.html, initialHtml);
	assert.equal(vscodeCreatedWebviewPanels.length, 1);
	assert.equal(panel.postedMessages.some((message: any) => message?.type === 'prompt'), false);

	await panel.emitMessage({ type: 'ready', bootId: initialBootId, assetVersion: EDITOR_WEBVIEW_ASSET_VERSION });
	assert.equal(panel.postedMessages.some((message: any) => message?.type === 'prompt'), false);

	await panel.emitMessage({ type: 'ready', bootId: nextBootId, assetVersion: EDITOR_WEBVIEW_ASSET_VERSION });

	const promptMessage = panel.postedMessages.find((message: any) => message?.type === 'prompt') as any;
	assert.equal(promptMessage?.type, 'prompt');
	assert.equal(promptMessage?.reason, 'open');
	assert.equal(promptMessage?.prompt?.id, 'prompt-a');
	assert.equal(typeof promptMessage?.openRequestVersion, 'number');
	assert.ok((promptMessage?.openRequestVersion || 0) > 0);
	panel.dispose();
});

test('clean prompt switch does not reread current prompt from disk', async () => {
	resetVsCodeCommandMock();
	const { manager, storageService } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
		},
	});
	const readCounts = new Map<string, number>();
	(storageService as any).getPrompt = async (id: string) => {
		readCounts.set(id, (readCounts.get(id) || 0) + 1);
		if (id === 'prompt-a') {
			return createPrompt({ id: 'prompt-a', promptUuid: 'uuid-a', title: 'Prompt A' });
		}
		if (id === 'prompt-b') {
			return createPrompt({ id: 'prompt-b', promptUuid: 'uuid-b', title: 'Prompt B' });
		}
		return null;
	};

	await (manager as any).openPrompt('prompt-a');
	await (manager as any).openPrompt('prompt-b');

	assert.equal(readCounts.get('prompt-a'), 1);
	assert.equal(readCounts.get('prompt-b'), 1);
	vscodeCreatedWebviewPanels[0]?.dispose();
});

test('postGitOverlaySnapshot posts selected projects first and other projects later', async () => {
	const { manager } = await createManager();
	const postedMessages: any[] = [];
	const debugEvents: Array<{ event: string; payload?: Record<string, unknown> }> = [];
	const deferredOtherProjects = createDeferred<any[]>();
	const postMessage = (message: unknown) => {
		postedMessages.push(message);
	};
	(manager as any).logReportDebug = (event: string, payload?: Record<string, unknown>) => {
		debugEvents.push({ event, payload });
	};
	const currentPrompt = createPrompt({
		projects: ['selected'],
		branch: 'feature/task-42',
	});

	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
			['peer', '/tmp/peer'],
		]),
		getWorkspaceFolders: () => ['selected', 'peer'],
	};
	(manager as any).gitService = {
		getGitOverlaySnapshot: async () => ({
			generatedAt: '2026-04-24T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [createGitOverlayProjectSnapshot('selected')],
		}),
		getGitOverlayOtherProjectsSnapshot: async () => deferredOtherProjects.promise,
	};
	(manager as any).gitOverlaySessions.set('panel-a', {
		active: true,
		promptBranch: 'feature/task-42',
		selectedProjects: ['selected'],
		snapshotProjects: ['selected', 'peer'],
		snapshotVersion: 0,
		postMessage,
		refreshTimer: null,
		refreshInFlight: false,
		refreshQueued: false,
		queuedMode: null,
		queuedBusyReason: null,
	});

	await withImmediateTimers(async () => {
		await (manager as any).postGitOverlaySnapshot(postMessage, currentPrompt, 'feature/task-42', ['selected'], {
			metricSource: 'open',
		});
	});

	assert.equal(postedMessages.length, 1);
	assert.equal(postedMessages[0]?.type, 'gitOverlaySnapshot');
	assert.deepEqual(postedMessages[0]?.snapshot?.projects.map((project: any) => project.project), ['selected']);
	assert.deepEqual(postedMessages[0]?.snapshot?.otherProjects || [], []);

	deferredOtherProjects.resolve([
		createGitOverlayProjectSnapshot('peer', {
			dirty: true,
			changeGroups: {
				merge: [],
				staged: [{
					project: 'peer',
					path: 'README.md',
					status: 'M',
					group: 'staged',
					conflicted: false,
					staged: true,
					fileSizeBytes: 0,
					additions: null,
					deletions: null,
					isBinary: false,
				}],
				workingTree: [],
				untracked: [],
			},
		}),
	]);
	await flushTurns();

	assert.equal(postedMessages.length, 2);
	assert.equal(postedMessages[1]?.type, 'gitOverlayOtherProjectsSnapshot');
	assert.deepEqual(postedMessages[1]?.otherProjects.map((project: any) => project.project), ['peer']);
	const snapshotMetric = debugEvents.find(item => item.event === 'gitOverlay.snapshot.computed');
	const otherProjectsMetric = debugEvents.find(item => item.event === 'gitOverlay.otherProjectsSnapshot.computed');
	assert.ok(snapshotMetric);
	assert.ok(otherProjectsMetric);
	assert.equal(snapshotMetric.payload?.source, 'open');
	assert.equal(otherProjectsMetric.payload?.source, 'open');
	assert.equal(typeof snapshotMetric.payload?.durationMs, 'number');
	assert.equal(typeof otherProjectsMetric.payload?.durationMs, 'number');
});

test('postGitOverlaySnapshot keeps freshly created review requests visible when the first reread is still stale', async () => {
	const { manager } = await createManager();
	const postedMessages: any[] = [];
	const postMessage = (message: unknown) => {
		postedMessages.push(message);
	};
	const currentPrompt = createPrompt({
		projects: ['selected'],
		branch: 'feature/task-42',
	});
	const optimisticRequest = {
		id: '101',
		number: '101',
		title: 'Draft: Review overlay keeps progress',
		url: 'https://gitlab.example.com/acme/selected/-/merge_requests/101',
		state: 'open',
		createdAt: '2026-04-24T10:00:00.000Z',
		updatedAt: '2026-04-24T10:00:00.000Z',
		sourceBranch: 'feature/task-42',
		targetBranch: 'main',
		isDraft: true,
		comments: [],
	};

	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
		]),
		getWorkspaceFolders: () => ['selected'],
	};
	(manager as any).gitService = {
		getGitOverlaySnapshot: async () => ({
			generatedAt: '2026-04-24T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [createGitOverlayProjectSnapshot('selected', {
				review: {
					remote: {
						provider: 'gitlab',
						host: 'gitlab.example.com',
						remoteName: 'origin',
						remoteUrl: 'https://gitlab.example.com/acme/selected.git',
						repositoryPath: 'acme/selected',
						owner: 'acme',
						name: 'selected',
						supported: true,
						cliCommand: 'glab',
						cliAvailable: true,
						actionLabel: 'Merge request',
					},
					request: null,
					error: '',
					setupAction: null,
					titlePrefix: '',
					unsupportedReason: null,
				},
			})],
		}),
	};
	(manager as any).gitOverlaySessions.set('panel-a', {
		active: true,
		promptBranch: 'feature/task-42',
		selectedProjects: ['selected'],
		snapshotProjects: ['selected'],
		snapshotVersion: 0,
		postMessage,
		refreshTimer: null,
		refreshInFlight: false,
		refreshQueued: false,
		queuedMode: null,
		queuedBusyReason: null,
	});

	await (manager as any).postGitOverlaySnapshot(postMessage, currentPrompt, 'feature/task-42', ['selected'], {
		optimisticReviewRequestsByProject: {
			selected: optimisticRequest,
		},
	});

	assert.equal(postedMessages.length, 1);
	assert.equal(postedMessages[0]?.type, 'gitOverlaySnapshot');
	assert.deepEqual(postedMessages[0]?.snapshot?.projects?.[0]?.review?.request, optimisticRequest);
});

/** Проверяет параллельный bulk-запуск, независимый fallback, номер снимка и очистку по исходному SCM-тексту. */
test('gitOverlayGenerateCommitMessage runs selected projects in parallel with ordered fallback per project', async (t) => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({ configurationValues: {
		'promptManager.ai.enabled': true, 'promptManager.debugLogging.enabled': true,
	} });
	// AI gate загружает vscode лениво, уже после импорта coordinator.
	const previousLoad = (Module as any)._load;
	(Module as any)._load = function (request: string, ...args: unknown[]) {
		return request === 'vscode' ? createVsCodeMock() : previousLoad.call(this, request, ...args);
	};
	t.after(() => { (Module as any)._load = previousLoad; });
	const timingLogs: string[] = [];
	(manager as any).reportDebugOutput = { appendLine: (line: string) => timingLogs.push(line) };
	const postedMessages: any[] = [];
	const callOrder: string[] = [];
	// Запоминаем точные пути и ожидаемые сообщения только внешних генераторов.
	const clearCalls: unknown[][] = [];
	const firstProject = createDeferred<string>();
	const internalContext = createDeferred<void>();
	const currentPrompt = createPrompt({
		projects: ['api', 'web', 'docs', 'busy'],
		branch: 'feature/task-164',
		taskNumber: '167',
	});
	(manager as any).getTrackedBranchesSetting = () => ['master', 'develop'];
	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['api', '/tmp/api'],
			['web', '/tmp/web'],
			['docs', '/tmp/docs'],
			['busy', '/tmp/busy'],
		]),
		getWorkspaceFolders: () => ['api', 'web', 'docs', 'busy'],
	};
	(manager as any).postGitOverlaySnapshot = async () => { callOrder.push('snapshot'); };
	(manager as any).gitService = {
		stageAll: async (_paths: unknown, projects: string[], includeOther: boolean) => {
			assert.deepEqual(projects, ['api', 'web', 'docs']);
			assert.equal(includeOther, false);
			callOrder.push('stageAll');
			return { errors: [] };
		},
		getStagedCommitProjects: async (_paths: unknown, projects: string[]) => {
			assert.deepEqual(projects, ['api', 'web', 'docs']);
			callOrder.push('stagedCheck');
			return projects.map(project => ({ project, projectPath: `/tmp/${project}` }));
		},
		getStagedCommitProjectData: async (_paths: unknown, projects: string[]) => {
			assert.equal(projects.length, 1);
			const project = projects[0];
			assert.ok(project === 'web' || project === 'docs');
			callOrder.push(`context:${project}`);
			if (project === 'web') { await internalContext.promise; }
			return [{
				project, projectPath: `/tmp/${project}`, branch: 'feature/task-164', changeSource: 'staged',
				stagedFiles: [{ status: 'M', path: `src/${project}.ts` }], stat: '', diff: `compact ${project} diff`,
			}];
		},
		generateCommitMessageViaKilo: async (projectPath: string) => {
			callOrder.push(`kilo:${projectPath}`);
			if (projectPath === '/tmp/api') {
				return firstProject.promise;
			}
			// Пустой результат означает пропуск недоступного Kilo без ошибки для пользователя.
			if (projectPath === '/tmp/docs') {
				return '';
			}
			throw new Error('Kilo command failed');
		},
		generateCommitMessageViaCopilot: async (projectPath: string) => {
			callOrder.push(`copilot:${projectPath}`);
			// Только третий проект доходит до Copilot после пустого внутреннего ответа.
			if (projectPath === '/tmp/docs') {
				return '🅰️🅻🅴🅺 develop | update guide';
			}
			throw new Error('Copilot command failed');
		},
		createGeneratedCommitMessageCleanupToken: (projectPath: string, message: string) => {
			// Для безопасной очистки SCM нужен raw-ответ, даже когда в webview уже отправляется номер.
			assert.equal(message, projectPath === '/tmp/api'
				? '🅰️🅻🅴🅺 master | update api'
				: '🅰️🅻🅴🅺 develop | update guide');
			callOrder.push(`token:${projectPath}`);
			return `cleanup:${projectPath}`;
		},
		clearGeneratedCommitMessageInput: (cleanupToken: string) => {
			clearCalls.push([cleanupToken]);
			return true;
		},
	};
	(manager as any).aiService.generateCommitMessage = async (input: {
		projectName: string; projectPath: string; taskNumber: string; stagedChangesSummary: string;
	}) => {
		const { projectName, stagedChangesSummary } = input;
		assert.equal(input.taskNumber, '167');
		assert.equal(input.projectPath, `/tmp/${projectName}`);
		assert.ok(stagedChangesSummary.includes(`compact ${projectName} diff`));
		callOrder.push(`internal:${projectName}`);
		return projectName === 'docs' ? '' : `🅰️🅻🅴🅺 master | update ${projectName}`;
	};
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;

	const handling = (manager as any).handleMessage(
		{
			type: 'gitOverlayGenerateCommitMessage',
			prompt: currentPrompt,
			projects: ['api', 'web', 'docs'],
			includeAllChanges: true,
			requestId: 'req-generate-164',
		},
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(callOrder, [
		'stageAll', 'stagedCheck', 'kilo:/tmp/api', 'kilo:/tmp/web', 'kilo:/tmp/docs',
		'context:web', 'context:docs', 'internal:docs', 'copilot:/tmp/docs',
	]);
	assert.equal(postedMessages.length, 0);

	// Поздний ответ должен сохранить правило исходного запроса при изменении промпта и настроек.
	currentPrompt.taskNumber = '999';
	currentPrompt.branch = 'master';
	(manager as any).getTrackedBranchesSetting = () => [];
	firstProject.resolve('🅰️🅻🅴🅺 master | update api');
	await new Promise(resolve => setImmediate(resolve));
	// Ни резервный Copilot, ни завершившееся Kilo не выпускают token до окончания внутренней генерации.
	assert.ok(!callOrder.some(call => call.startsWith('token:')));
	assert.equal(postedMessages.length, 0);
	internalContext.resolve();
	await handling;

	assert.deepEqual(callOrder, [
		'stageAll',
		'stagedCheck',
		'kilo:/tmp/api',
		'kilo:/tmp/web',
		'kilo:/tmp/docs',
		'context:web',
		'context:docs',
		'internal:docs',
		'copilot:/tmp/docs',
		'internal:web',
		'token:/tmp/api',
		'token:/tmp/docs',
		'snapshot',
	]);
	assert.deepEqual(postedMessages.find(message => message.type === 'gitOverlayCommitMessagesGenerated'), {
		type: 'gitOverlayCommitMessagesGenerated',
		messages: [
			{ project: 'api', message: '🅰️🅻🅴🅺 167 | update api', scmCleanupToken: 'cleanup:/tmp/api' },
			{ project: 'web', message: '🅰️🅻🅴🅺 167 | update web' },
			{ project: 'docs', message: '🅰️🅻🅴🅺 167 | update guide', scmCleanupToken: 'cleanup:/tmp/docs' },
		],
		requestId: 'req-generate-164',
	});
	assert.deepEqual(clearCalls, []);
	await (manager as any).handleMessage(
		{
			type: 'gitOverlayCommitMessagesApplied',
			cleanupTokens: ['cleanup:/tmp/api', 'cleanup:/tmp/docs'],
			requestId: 'req-generate-164',
		},
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);
	assert.deepEqual(clearCalls, [['cleanup:/tmp/api'], ['cleanup:/tmp/docs']]);
	// Проверяется реальный coordinator-фильтр, без подмены logReportDebug.
	assert.ok(timingLogs.some(line => line.includes('gitOverlay.commitMessage.timing') && line.includes('"stage":"copilot"')));
	assert.ok(timingLogs.some(line => line.includes('"stage":"internalContext"') && line.includes('"durationMs":')));
	assert.ok(timingLogs.every(line => !line.includes('compact web diff') && !line.includes('🅰️🅻🅴🅺')));
	resetVsCodeCommandMock();
});

/** Ошибка отдельного проекта не завершает bulk раньше остальных и не теряет их сообщения или cleanup tokens. */
for (const failure of ['context', 'instructions', 'excluded', 'empty', 'copilot'] as const) {
	test(`gitOverlayGenerateCommitMessage preserves parallel successes after ${failure} failure`, async t => {
		resetVsCodeCommandMock();
		t.after(resetVsCodeCommandMock);
		const { manager } = await createManager({ configurationValues: { 'promptManager.ai.enabled': true } });
		const previousLoad = (Module as any)._load;
		(Module as any)._load = function (request: string, ...args: unknown[]) {
			return request === 'vscode' ? createVsCodeMock() : previousLoad.call(this, request, ...args);
		};
		t.after(() => { (Module as any)._load = previousLoad; });
		// Все API подменены; медленный успех завершается после ошибки другого проекта.
		const prompt = createPrompt({ projects: ['slow', 'broken', 'fast'], taskNumber: '172' });
		const paths = new Map<string, string>(prompt.projects.map((project: string) => [project, `/workspace/${project}`]));
		const slow = createDeferred<string>();
		const started: string[] = [];
		const posted: any[] = [];
		let internalCalls = 0;
		let copilotCalls = 0;
		(manager as any).workspaceService = {
			getWorkspaceFolderPaths: () => paths, getWorkspaceFolders: () => prompt.projects,
		};
		(manager as any).gitService = {
			getStagedCommitProjects: async () => [...paths].map(([project, projectPath]) => ({ project, projectPath })),
			generateCommitMessageViaKilo: async (projectPath: string) => {
				started.push(projectPath);
				return projectPath.endsWith('/slow') ? slow.promise : projectPath.endsWith('/fast') ? 'fast result' : '';
			},
			generateCommitMessageViaCopilot: async () => {
				copilotCalls++;
				if (failure === 'copilot') { throw new Error('private Copilot failure'); }
				return '';
			},
			getStagedCommitProjectData: async () => {
				if (failure === 'context') { throw new Error('private context failure'); }
				return failure === 'excluded' ? [] : [{ project: 'broken', stagedFiles: [], stat: '', diff: '+code' }];
			},
			createGeneratedCommitMessageCleanupToken: (projectPath: string, message: string) => {
				assert.equal(message, projectPath.endsWith('/slow') ? 'slow result' : 'fast result');
				return `token:${projectPath}`;
			},
		};
		(manager as any).aiService.generateCommitMessage = async () => {
			internalCalls++;
			if (failure === 'instructions') { throw new Error('private instruction failure'); }
			return '';
		};
		const handling = (manager as any).handleMessage(
			{ type: 'gitOverlayGenerateCommitMessage', prompt, projects: prompt.projects, requestId: 'parallel-error' },
			{ webview: { postMessage: async (message: unknown) => { posted.push(message); return true; } } },
			prompt, '__prompt_editor_singleton__', () => false, () => undefined,
		);
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(started, [...paths.values()]);
		assert.deepEqual(posted, []);
		slow.resolve('slow result');
		await handling;
		assert.equal(internalCalls, failure === 'context' || failure === 'excluded' ? 0 : 1);
		assert.equal(copilotCalls, failure === 'empty' || failure === 'copilot' ? 1 : 0);
		assert.deepEqual(posted, [
			{ type: 'error', message: 'Failed to generate commit messages for projects: broken. Try again.',
				requestId: 'parallel-error' },
			{ type: 'gitOverlayCommitMessagesGenerated', requestId: 'parallel-error', messages: [
				{ project: 'slow', message: 'slow result', scmCleanupToken: 'token:/workspace/slow' },
				{ project: 'fast', message: 'fast result', scmCleanupToken: 'token:/workspace/fast' },
			] },
		]);
	});
}

/** Внутренний успех обходит штатный Copilot и SCM; номер корректируется только у сгенерированного сообщения. */
test('gitOverlayGenerateCommitMessage prefers internal AI without rewriting manual commit text', async t => {
	resetVsCodeCommandMock();
	// Все внешние действия заменены: ни генератор, ни commit не обращаются к настоящему репозиторию.
	const { manager } = await createManager({ configurationValues: { 'promptManager.ai.enabled': true } });
	const previousLoad = (Module as any)._load;
	(Module as any)._load = function (request: string, ...args: unknown[]) {
		return request === 'vscode' ? createVsCodeMock() : previousLoad.call(this, request, ...args);
	};
	t.after(() => { (Module as any)._load = previousLoad; resetVsCodeCommandMock(); });
	const currentPrompt = createPrompt({ projects: ['api'], taskNumber: '167', branch: '' });
	const postedMessages: any[] = [];
	const committedMessages: unknown[] = [];
	const callOrder: string[] = [];
	const generatedMessage = '🅰️🅻🅴🅺 master | текст коммита';
	(manager as any).getTrackedBranchesSetting = () => ['master'];
	(manager as any).postGitOverlaySnapshot = async () => undefined;
	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([['api', '/tmp/api']]),
		getWorkspaceFolders: () => ['api'],
	};
	(manager as any).gitService = {
		getStagedCommitProjects: async () => [{ project: 'api', projectPath: '/tmp/api' }],
		generateCommitMessageViaKilo: async () => { callOrder.push('kilo'); return ''; },
		getStagedCommitProjectData: async () => {
			callOrder.push('context');
			return [{ project: 'api', stagedFiles: [{ status: 'M', path: 'src/api.ts' }], stat: '', diff: '+code' }];
		},
		generateCommitMessageViaCopilot: async () => { callOrder.push('copilot'); return 'wrong generator'; },
		createGeneratedCommitMessageCleanupToken: () => {
			throw new Error('Internal result must not create SCM cleanup tokens');
		},
		commitStagedChanges: async (_paths: unknown, messages: unknown) => {
			committedMessages.push(messages);
			return { success: true, errors: [], changedProjects: ['api'], skippedProjects: [] };
		},
	};
	(manager as any).aiService.generateCommitMessage = async () => {
		callOrder.push('internal');
		return generatedMessage;
	};
	const panel = { webview: { postMessage: async (message: unknown) => {
		postedMessages.push(message);
		return true;
	} } } as any;

	await (manager as any).handleMessage(
		{ type: 'gitOverlayGenerateCommitMessage', prompt: currentPrompt, project: 'api', requestId: 'single-167' },
		panel, currentPrompt, '__prompt_editor_singleton__', () => false, () => undefined,
	);
	assert.deepEqual(postedMessages.find(message => message.type === 'gitOverlayCommitMessagesGenerated'), {
		type: 'gitOverlayCommitMessagesGenerated',
		messages: [{ project: 'api', message: '🅰️🅻🅴🅺 167 | текст коммита' }],
		requestId: 'single-167',
	});
	assert.deepEqual(callOrder, ['kilo', 'context', 'internal']);

	// Пользователь намеренно вернул master: при commit этот текст должен пройти без повторной замены.
	const manualMessages = [{ project: 'api', message: '🅰️🅻🅴🅺 master | мой текст' }];
	await (manager as any).handleMessage(
		{ type: 'gitOverlayCommitStaged', prompt: currentPrompt, messages: manualMessages, requestId: 'manual-167' },
		panel, currentPrompt, '__prompt_editor_singleton__', () => false, () => undefined,
	);
	assert.deepEqual(committedMessages, [manualMessages]);
	resetVsCodeCommandMock();
});

/** Выключенный внутренний AI не требует даже компактного Git-контекста. */
test('gitOverlayGenerateCommitMessage skips internal AI and its context when disabled', async t => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({ configurationValues: { 'promptManager.ai.enabled': false } });
	const previousLoad = (Module as any)._load;
	(Module as any)._load = function (request: string, ...args: unknown[]) {
		return request === 'vscode' ? createVsCodeMock() : previousLoad.call(this, request, ...args);
	};
	t.after(() => { (Module as any)._load = previousLoad; resetVsCodeCommandMock(); });
	const prompt = createPrompt({ projects: ['api'] });
	const messages: any[] = [];
	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([['api', '/unused']]), getWorkspaceFolders: () => ['api'],
	};
	(manager as any).gitService = {
		getStagedCommitProjects: async () => [{ project: 'api', projectPath: '/unused' }],
		getStagedCommitProjectData: async () => { throw new Error('Disabled AI must not collect context'); },
		generateCommitMessageViaKilo: async () => '',
		generateCommitMessageViaCopilot: async () => 'native result',
		createGeneratedCommitMessageCleanupToken: () => 'cleanup:disabled',
	};
	(manager as any).aiService.generateCommitMessage = async () => {
		throw new Error('Disabled internal AI must not be invoked');
	};
	await (manager as any).handleMessage(
		{ type: 'gitOverlayGenerateCommitMessage', prompt, project: 'api' },
		{ webview: { postMessage: async (message: unknown) => { messages.push(message); return true; } } },
		prompt, '__prompt_editor_singleton__', () => false, () => undefined,
	);
	assert.deepEqual(messages[0].messages, [{ project: 'api', message: 'native result', scmCleanupToken: 'cleanup:disabled' }]);
	resetVsCodeCommandMock();
});

/** При пустом номере внутренний генератор получает действительную ветку, а не ветку из формы промпта. */
test('gitOverlayGenerateCommitMessage supplies current branch when task number is absent', async (t) => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({ configurationValues: { 'promptManager.ai.enabled': true } });
	const previousLoad = (Module as any)._load;
	(Module as any)._load = function (request: string, ...args: unknown[]) {
		return request === 'vscode' ? createVsCodeMock() : previousLoad.call(this, request, ...args);
	};
	t.after(() => { (Module as any)._load = previousLoad; resetVsCodeCommandMock(); });
	const prompt = createPrompt({ projects: ['api'], taskNumber: '', branch: 'planned-branch' });
	let generated = false;
	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([['api', '/workspace/api']]), getWorkspaceFolders: () => ['api'],
	};
	(manager as any).gitService = {
		getStagedCommitProjects: async () => [{ project: 'api', projectPath: '/workspace/api' }],
		getStagedCommitProjectData: async () => [{
			project: 'api', projectPath: '/workspace/api', stagedFiles: [{ status: 'M', path: 'src/api.ts' }],
			stat: '1 file changed', diff: '+code',
		}],
		generateCommitMessageViaKilo: async () => '',
		generateCommitMessageViaCopilot: async () => '',
		getCurrentBranch: async (projectPath: string) => {
			assert.equal(projectPath, '/workspace/api');
			return 'feature/ABC-172';
		},
	};
	(manager as any).aiService.generateCommitMessage = async (input: { currentBranch: string; taskNumber: string }) => {
		assert.equal(input.currentBranch, 'feature/ABC-172');
		assert.equal(input.taskNumber, '');
		generated = true;
		return 'Исправил обработку инструкций';
	};
	await (manager as any).handleMessage(
		{ type: 'gitOverlayGenerateCommitMessage', prompt, project: 'api' },
		{ webview: { postMessage: async () => true } },
		prompt, '__prompt_editor_singleton__', () => false, () => undefined,
	);
	assert.equal(generated, true);
});

/** Проверяет сохранение SCM при отказе доставки, отклонении отправки и уже закрытом webview. */
test('gitOverlayGenerateCommitMessage keeps SCM input when delivery fails or webview is disposed', async (t) => {
	// Все варианты недоставки проверяются последовательно с изолированными подменами зависимостей.
	for (const failure of ['false', 'rejected', 'disposed']) {
		await t.test(failure, async () => {
			resetVsCodeCommandMock();
			const { manager } = await createManager();
			const currentPrompt = createPrompt({ projects: ['api'] });
			const clearCalls: unknown[][] = [];
			let snapshotCalls = 0;
			(manager as any).workspaceService = {
				getWorkspaceFolderPaths: () => new Map([['api', '/tmp/api']]),
				getWorkspaceFolders: () => ['api'],
			};
			// Git полностью подменен: staged-данные и готовый SCM-результат существуют только в памяти.
			(manager as any).gitService = {
				stageAll: async () => ({ errors: [] }),
				getStagedCommitProjects: async () => [{ project: 'api', projectPath: '/tmp/api' }],
				generateCommitMessageViaKilo: async () => 'feat: generated',
				createGeneratedCommitMessageCleanupToken: () => 'cleanup:/tmp/api',
				clearGeneratedCommitMessageInput: (...args: unknown[]) => {
					clearCalls.push(args);
					return true;
				},
			};
			// Отдельно фиксируем обновление снимка после недоставленного ответа.
			(manager as any).postGitOverlaySnapshot = async () => { snapshotCalls += 1; };
			const panel = {
				// Закрытая панель может синхронно бросить исключение уже при получении webview.
				get webview() {
					if (failure === 'disposed') {
						throw new Error('Webview is disposed');
					}
					return {
						postMessage: async () => {
							if (failure === 'rejected') {
								throw new Error('Delivery failed');
							}
							return false;
						},
					};
				},
			};

			try {
				await (manager as any).handleMessage(
					{ type: 'gitOverlayGenerateCommitMessage', prompt: currentPrompt, includeAllChanges: true },
					panel, currentPrompt, '__prompt_editor_singleton__', () => false, () => undefined,
				);
				assert.deepEqual(clearCalls, []);
				assert.equal(snapshotCalls, 1);
			} finally {
				resetVsCodeCommandMock();
			}
		});
	}
});

/** Проверяет финальное сообщение tracked request при неожиданном исключении host-case. */
test('gitOverlayGenerateCommitMessage finishes tracked request after host exception', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager();
	const postedMessages: any[] = [];
	const debugMessages: string[] = [];
	const currentPrompt = createPrompt({
		projects: ['api'],
		branch: 'feature/task-164',
	});
	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([['api', '/tmp/api']]),
		getWorkspaceFolders: () => ['api'],
	};
	(manager as any).gitService = {
		getStagedCommitProjects: async () => {
			throw new Error('staged data failed');
		},
	};
	(manager as any).logReportDebug = (_event: string, payload?: { message?: string }) => {
		debugMessages.push(payload?.message || '');
	};
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;

	await (manager as any).handleMessage(
		{
			type: 'gitOverlayGenerateCommitMessage',
			prompt: currentPrompt,
			projects: ['api'],
			requestId: 'req-generate-error-164',
		},
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.deepEqual(postedMessages, [
		{
			type: 'error',
			message: 'Failed to generate commit messages. Try again.',
			requestId: 'req-generate-error-164',
		},
		{
			type: 'gitOverlayCommitMessagesGenerated',
			messages: [],
			requestId: 'req-generate-error-164',
		},
	]);
	assert.equal(debugMessages.some(message => message.includes('staged data failed')), true);
	resetVsCodeCommandMock();
});

/** Проверяет terminal response при stale prompt после переименования. */
test('gitOverlayGenerateCommitMessage finishes stale renamed prompt request', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager();
	const postedMessages: any[] = [];
	const currentPrompt = createPrompt({ id: 'renamed-prompt', promptUuid: 'uuid-164' });
	const incomingPrompt = createPrompt({ id: 'old-prompt', promptUuid: 'uuid-164' });
	(manager as any).gitService = {
		getStagedCommitProjects: async () => {
			throw new Error('stale request must not reach Git');
		},
	};

	await (manager as any).handleMessage(
		{
			type: 'gitOverlayGenerateCommitMessage',
			prompt: incomingPrompt,
			projects: ['api'],
			requestId: 'req-stale-generate-164',
		},
		{ webview: { postMessage: async (message: unknown) => postedMessages.push(message) } } as any,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.deepEqual(postedMessages, [{
		type: 'gitOverlayCommitMessagesGenerated',
		messages: [],
		requestId: 'req-stale-generate-164',
	}]);
	resetVsCodeCommandMock();
});

/** Проверяет stageAll, generated response и очистку SCM только после webview acknowledgment. */
test('gitOverlayGenerateCommitMessage preserves includeAllChanges stageAll semantics', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager();
	const postedMessages: any[] = [];
	const stageCalls: any[] = [];
	const snapshotCalls: any[] = [];
	// Порядок вызовов выявляет преждевременную очистку до применения webview state.
	const lifecycleCalls: string[] = [];
	const clearCalls: any[] = [];
	const delivery = createDeferred<boolean>();
	const paths = new Map([['api', '/tmp/api']]);
	const currentPrompt = createPrompt({
		projects: ['api'],
		branch: 'feature/task-164',
	});
	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => paths,
		getWorkspaceFolders: () => ['api'],
	};
	(manager as any).gitService = {
		stageAll: async (...args: unknown[]) => {
			stageCalls.push(args);
			return { success: true, errors: [], changedProjects: ['api'], skippedProjects: [] };
		},
		getStagedCommitProjects: async () => [{
			project: 'api',
			projectPath: '/tmp/api',
			branch: 'feature/task-164',
			changeSource: 'staged',
			stagedFiles: [{ status: 'M', path: 'src/api.ts' }],
			stat: '1 file changed',
			diff: 'api diff',
		}],
		generateCommitMessageViaKilo: async () => 'feat: generated',
		generateCommitMessageViaCopilot: async () => {
			throw new Error('Copilot must not run after Kilo success');
		},
		createGeneratedCommitMessageCleanupToken: () => 'cleanup:/tmp/api',
		clearGeneratedCommitMessageInput: (...args: unknown[]) => {
			lifecycleCalls.push('clear');
			clearCalls.push(args);
			return true;
		},
	};
	// Снимок отправляется после generated response, но очистка ожидает отдельный acknowledgment.
	(manager as any).postGitOverlaySnapshot = async (...args: unknown[]) => {
		lifecycleCalls.push('snapshot');
		snapshotCalls.push(args);
	};
	const panel = {
		webview: {
			// Доставка остается неподтвержденной до явного разрешения тестом.
			postMessage: async (message: unknown) => {
				lifecycleCalls.push('post');
				postedMessages.push(message);
				return delivery.promise;
			},
		},
	} as any;

	const handling = (manager as any).handleMessage(
		{
			type: 'gitOverlayGenerateCommitMessage',
			prompt: currentPrompt,
			projects: ['api'],
			includeAllChanges: true,
			requestId: 'req-stage-all-164',
		},
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	// Сам вызов postMessage не разрешает очистку SCM input.
	await flushTurns();
	assert.deepEqual(lifecycleCalls, ['post']);
	delivery.resolve(true);
	await handling;

	assert.deepEqual(stageCalls, [[paths, ['api'], false]]);
	assert.equal(snapshotCalls.length, 1);
	assert.equal(snapshotCalls[0]?.[4]?.requestId, 'req-stage-all-164');
	assert.deepEqual(clearCalls, []);
	assert.deepEqual(lifecycleCalls, ['post', 'snapshot']);
	assert.deepEqual(postedMessages, [{
		type: 'gitOverlayCommitMessagesGenerated',
		messages: [{
			project: 'api',
			message: 'feat: generated',
			scmCleanupToken: 'cleanup:/tmp/api',
		}],
		requestId: 'req-stage-all-164',
	}]);
	await (manager as any).handleMessage(
		{
			type: 'gitOverlayCommitMessagesApplied',
			cleanupTokens: ['cleanup:/tmp/api'],
			requestId: 'req-stage-all-164',
		},
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);
	assert.deepEqual(clearCalls, [['cleanup:/tmp/api']]);
	assert.deepEqual(lifecycleCalls, ['post', 'snapshot', 'clear']);
	resetVsCodeCommandMock();
});

test('gitOverlayCreateReviewRequest refreshes the current overlay scope with the tracked request id', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
			branch: 'feature/task-128',
			projects: ['api'],
		},
		workspaceService: {
			getWorkspaceFolderPaths: () => new Map([['api', '/tmp/api']]),
			getWorkspaceFolders: () => ['api'],
		},
	});

	const postedMessages: any[] = [];
	const snapshotCalls: any[] = [];
	const optimisticRequest = {
		id: '101',
		number: '101',
		title: 'Draft: Review refresh regression',
		url: 'https://gitlab.example.com/acme/api/-/merge_requests/101',
		state: 'open',
		createdAt: '2026-05-12T11:00:00.000Z',
		updatedAt: '2026-05-12T11:00:00.000Z',
		sourceBranch: 'feature/task-128',
		targetBranch: 'main',
		isDraft: true,
		comments: [],
	};

	(manager as any).gitService = {
		createReviewRequests: async () => ({
			success: true,
			errors: [],
			changedProjects: ['api'],
			skippedProjects: [],
			reviewRequestsByProject: {
				api: optimisticRequest,
			},
		}),
	};
	(manager as any).postGitOverlaySnapshot = async (
		_postMessage: unknown,
		promptArg: unknown,
		promptBranchArg: unknown,
		projectsArg: unknown,
		optionsArg: unknown,
	) => {
		snapshotCalls.push({
			prompt: promptArg,
			promptBranch: promptBranchArg,
			projects: projectsArg,
			options: optionsArg,
		});
		return null;
	};

	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt A',
		branch: 'feature/task-128',
		projects: ['api'],
	});

	await (manager as any).handleMessage(
		{
			type: 'gitOverlayCreateReviewRequest',
			prompt: currentPrompt,
			promptBranch: 'feature/task-128',
			projects: ['api'],
			requests: [{
				project: 'api',
				targetBranch: 'main',
				title: '128 Review refresh regression',
				draft: true,
				removeSourceBranch: false,
			}],
			requestId: 'req-review-refresh',
		},
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.equal(snapshotCalls.length, 1);
	assert.equal(snapshotCalls[0]?.promptBranch, 'feature/task-128');
	assert.deepEqual(snapshotCalls[0]?.projects, ['api']);
	assert.equal(snapshotCalls[0]?.options?.requestId, 'req-review-refresh');
	assert.deepEqual(snapshotCalls[0]?.options?.optimisticReviewRequestsByProject, { api: optimisticRequest });
	assert.equal(postedMessages.some(message =>
		(message as any)?.type === 'info'
		&& (message as any)?.requestId === 'req-review-refresh'
	), true);
	resetVsCodeCommandMock();
});

/** Проверяет, что push сообщает о завершении до snapshot, иначе webview бесконечно ждёт следующий snapshot. */
test('gitOverlayPush posts action completion before the final overlay snapshot', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({
		workspaceService: {
			getWorkspaceFolderPaths: () => new Map([['api', '/tmp/api']]),
			getWorkspaceFolders: () => ['api'],
		},
	});

	// Общий журнал сообщений webview и вызовов snapshot фиксирует порядок отправки.
	const events: string[] = [];
	(manager as any).gitService = {
		pushBranch: async () => ({ success: true, errors: [], changedProjects: ['api'], skippedProjects: [] }),
	};
	(manager as any).postGitOverlaySnapshot = async () => {
		events.push('snapshot');
		return null;
	};

	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				events.push(`message:${(message as any)?.type}`);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({ id: 'prompt-a', promptUuid: 'uuid-a', title: 'Prompt A', projects: ['api'] });

	await (manager as any).handleMessage(
		{ type: 'gitOverlayPush', promptBranch: '', projects: ['api'] },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	const completedIndex = events.indexOf('message:gitOverlayActionCompleted');
	assert.notEqual(completedIndex, -1);
	assert.ok(completedIndex < events.indexOf('snapshot'));
	resetVsCodeCommandMock();
});

test('gitOverlayCreateReviewRequest replays the cached overlay snapshot when reread fails after bulk MR/PR creation', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
			branch: 'feature/task-133',
			projects: ['api', 'web'],
		},
		workspaceService: {
			getWorkspaceFolderPaths: () => new Map([
				['api', '/tmp/api'],
				['web', '/tmp/web'],
			]),
			getWorkspaceFolders: () => ['api', 'web'],
		},
	});

	const postedMessages: any[] = [];
	const optimisticRequest = {
		id: '303',
		number: '303',
		title: 'Draft: Bulk fallback regression',
		url: 'https://gitlab.example.com/acme/api/-/merge_requests/303',
		state: 'open',
		createdAt: '2026-05-14T10:00:00.000Z',
		updatedAt: '2026-05-14T10:00:00.000Z',
		sourceBranch: 'feature/task-133',
		targetBranch: 'main',
		isDraft: true,
		comments: [],
	};

	(manager as any).gitService = {
		createReviewRequests: async () => ({
			success: true,
			errors: [],
			changedProjects: ['api'],
			skippedProjects: [],
			reviewRequestsByProject: {
				api: optimisticRequest,
			},
		}),
	};
	(manager as any).postGitOverlaySnapshot = async () => {
		throw new Error('snapshot refresh failed');
	};

	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt A',
		branch: 'feature/task-133',
		projects: ['api', 'web'],
	});
	const panelKey = '__prompt_editor_singleton__';
	(manager as any).gitOverlaySessions.set(panelKey, {
		active: true,
		promptBranch: 'feature/task-133',
		selectedProjects: ['api', 'web'],
		snapshotProjects: ['api', 'web'],
		snapshotVersion: 1,
		lastSnapshot: {
			generatedAt: '2026-05-14T09:59:00.000Z',
			promptBranch: 'feature/task-133',
			trackedBranches: ['main'],
			projects: [
				createGitOverlayProjectSnapshot('api', {
					currentBranch: 'feature/task-133',
					review: {
						remote: {
							provider: 'gitlab',
							host: 'gitlab.example.com',
							remoteName: 'origin',
							remoteUrl: 'https://gitlab.example.com/acme/api.git',
							repositoryPath: 'acme/api',
							owner: 'acme',
							name: 'api',
							supported: true,
							cliCommand: 'glab',
							cliAvailable: true,
							actionLabel: 'Merge request',
						},
						request: null,
						error: '',
						setupAction: null,
						titlePrefix: '',
						unsupportedReason: null,
					},
				}),
				createGitOverlayProjectSnapshot('web', {
					currentBranch: 'feature/task-133',
				}),
			],
			otherProjects: [],
		},
		postMessage: (message: unknown) => {
			postedMessages.push(message);
		},
		postMessageHistory: [],
		refreshTimer: null,
		refreshInFlight: false,
		refreshQueued: false,
		queuedMode: null,
		queuedBusyReason: null,
	});

	await (manager as any).handleMessage(
		{
			type: 'gitOverlayCreateReviewRequest',
			prompt: currentPrompt,
			promptBranch: 'feature/task-133',
			projects: ['api', 'web'],
			requests: [{
				project: 'api',
				targetBranch: 'main',
				title: '133 Bulk fallback regression',
				draft: true,
				removeSourceBranch: false,
			}],
			requestId: 'req-review-fallback',
		},
		panel,
		currentPrompt,
		panelKey,
		() => false,
		() => undefined,
	);

	const fallbackSnapshotMessage = postedMessages.find((message) => (message as any)?.type === 'gitOverlaySnapshot');
	assert.ok(fallbackSnapshotMessage);
	assert.equal((fallbackSnapshotMessage as any)?.requestId, 'req-review-fallback');
	assert.deepEqual((fallbackSnapshotMessage as any)?.snapshot?.projects?.[0]?.review?.request, optimisticRequest);
	assert.equal(postedMessages.some((message) =>
		(message as any)?.type === 'gitOverlayActionCompleted'
		&& (message as any)?.action === 'review-request'
	), true);
	resetVsCodeCommandMock();
});

test('postGitOverlaySnapshot can skip lazy other-project scheduling for initial summary open', async () => {
	const { manager } = await createManager();
	const postedMessages: any[] = [];
	const postMessage = (message: unknown) => {
		postedMessages.push(message);
	};
	const currentPrompt = createPrompt({
		projects: ['selected'],
		branch: 'feature/task-42',
	});

	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
			['peer', '/tmp/peer'],
		]),
		getWorkspaceFolders: () => ['selected', 'peer'],
	};
	(manager as any).gitService = {
		getGitOverlaySnapshot: async () => ({
			generatedAt: '2026-04-24T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [createGitOverlayProjectSnapshot('selected')],
		}),
		getGitOverlayOtherProjectsSnapshot: async () => {
			throw new Error('other projects should not be scheduled');
		},
	};
	(manager as any).gitOverlaySessions.set('panel-a', {
		active: true,
		promptBranch: 'feature/task-42',
		selectedProjects: ['selected'],
		snapshotProjects: ['selected', 'peer'],
		snapshotVersion: 0,
		postMessage,
		refreshTimer: null,
		refreshInFlight: false,
		refreshQueued: false,
		queuedMode: null,
		queuedBusyReason: null,
	});

	await withImmediateTimers(async () => {
		await (manager as any).postGitOverlaySnapshot(postMessage, currentPrompt, 'feature/task-42', ['selected'], {
			metricSource: 'open',
			detailLevel: 'summary',
			skipOtherProjects: true,
		});
		await flushTurns();
	});

	assert.equal(postedMessages.length, 1);
	assert.equal(postedMessages[0]?.type, 'gitOverlaySnapshot');
	assert.deepEqual(postedMessages[0]?.snapshot?.otherProjects || [], []);
});

test('postGitOverlaySnapshot keeps open summary snapshot alive when panel postMessage callback is refreshed', async () => {
	const { manager } = await createManager();
	const deferredSnapshot = createDeferred<any>();
	const postedMessagesA: any[] = [];
	const postedMessagesB: any[] = [];
	const postMessageA = (message: unknown) => {
		postedMessagesA.push(message);
	};
	const postMessageB = (message: unknown) => {
		postedMessagesB.push(message);
	};
	const currentPrompt = createPrompt({
		projects: ['selected'],
		branch: 'feature/task-42',
	});

	(manager as any).ensureGitOverlayReactiveSources = async () => undefined;
	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
		]),
		getWorkspaceFolders: () => ['selected'],
	};
	(manager as any).gitService = {
		getGitOverlaySnapshot: async () => deferredSnapshot.promise,
	};
	(manager as any).gitOverlaySessions.set('panel-a', {
		active: true,
		promptBranch: 'feature/task-42',
		selectedProjects: ['selected'],
		snapshotProjects: ['selected'],
		snapshotVersion: 0,
		postMessage: postMessageA,
		refreshTimer: null,
		refreshInFlight: false,
		refreshQueued: false,
		queuedMode: null,
		queuedBusyReason: null,
	});

	const snapshotPromise = (manager as any).postGitOverlaySnapshot(
		postMessageA,
		currentPrompt,
		'feature/task-42',
		['selected'],
		{
			metricSource: 'open',
			detailLevel: 'summary',
			skipOtherProjects: true,
		},
	);

	await flushTurns();
	await (manager as any).setGitOverlaySessionVisibility(
		'panel-a',
		postMessageB,
		currentPrompt,
		'feature/task-42',
		['selected'],
		true,
	);
	deferredSnapshot.resolve({
		generatedAt: '2026-04-24T00:00:00.000Z',
		promptBranch: 'feature/task-42',
		trackedBranches: ['main'],
		projects: [createGitOverlayProjectSnapshot('selected')],
	});
	await snapshotPromise;

	assert.equal(postedMessagesA.length, 1);
	assert.equal(postedMessagesA[0]?.type, 'gitOverlaySnapshot');
	assert.equal(postedMessagesB.length, 0);
});

test('scheduleGitOverlayOpenHydration defers branch and review state into lightweight follow-up patches', async () => {
	const { manager } = await createManager();
	const capturedSnapshotOptions: any[] = [];
	const capturedBranchCalls: any[] = [];
	const capturedReviewCalls: any[] = [];
	const deferredBranchHydration = createDeferred<{
		upstream: string;
		ahead: number;
		behind: number;
		lastCommit: null;
		branches: never[];
		cleanupBranches: never[];
		staleLocalBranches: never[];
		graph: { nodes: never[]; edges: never[] };
	}>();
	const postedMessages: any[] = [];
	const postMessage = (message: unknown) => {
		postedMessages.push(message);
	};
	const currentPrompt = createPrompt({
		projects: ['selected'],
		branch: 'feature/task-42',
	});

	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
		]),
		getWorkspaceFolders: () => ['selected'],
	};
	(manager as any).gitService = {
		getGitOverlaySnapshot: async (
			_paths: unknown,
			_selectedProjects: unknown,
			_promptBranch: unknown,
			_trackedBranches: unknown,
			options: unknown,
		) => {
			capturedSnapshotOptions.push(options);
			return {
				generatedAt: '2026-04-24T00:00:00.000Z',
				promptBranch: 'feature/task-42',
				trackedBranches: ['main'],
				projects: [createGitOverlayProjectSnapshot('selected', {
					reviewHydrated: false,
					branchDetailsHydrated: false,
					changeDetailsHydrated: false,
				})],
			};
		},
		getGitOverlayProjectBranchDetails: async (
			_paths: unknown,
			_projectName: unknown,
			_promptBranch: unknown,
			_trackedBranches: unknown,
		) => {
			capturedBranchCalls.push({
				projectName: _projectName,
				promptBranch: _promptBranch,
				trackedBranches: _trackedBranches,
			});
			return deferredBranchHydration.promise;
		},
		getGitOverlayProjectReviewState: async (
			_paths: unknown,
			_projectName: unknown,
			_promptBranch: unknown,
		) => {
			capturedReviewCalls.push({
				projectName: _projectName,
				promptBranch: _promptBranch,
			});
			return {
				upstream: 'origin/feature/task-42',
				ahead: 0,
				behind: 0,
				lastCommit: null,
				branches: [],
				cleanupBranches: [],
				staleLocalBranches: [],
				graph: { nodes: [], edges: [] },
			};
		},
		getGitOverlayProjectSnapshot: async (
			_paths: unknown,
			_projectName: unknown,
			_promptBranch: unknown,
			_trackedBranches: unknown,
			_options: unknown,
		) => {
			return createGitOverlayProjectSnapshot('selected', {
				reviewHydrated: true,
				changeDetailsHydrated: false,
			});
		},
	};
	(manager as any).gitOverlaySessions.set('panel-a', {
		active: true,
		promptBranch: 'feature/task-42',
		selectedProjects: ['selected'],
		snapshotProjects: ['selected'],
		snapshotVersion: 0,
		postMessage,
		refreshTimer: null,
		refreshInFlight: false,
		refreshQueued: false,
		queuedMode: null,
		queuedBusyReason: null,
	});

	await withImmediateTimers(async () => {
		(manager as any).scheduleGitOverlayOpenHydration(
			postMessage,
			currentPrompt,
			'feature/task-42',
			['selected'],
		);
		await flushTurns();
	});

	assert.equal(capturedSnapshotOptions.length, 1);
	assert.equal(capturedSnapshotOptions[0]?.prefetchedReviewStatesByProject, undefined);
	assert.equal(capturedSnapshotOptions[0]?.detailLevel, 'full');
	assert.equal(capturedSnapshotOptions[0]?.includeChangeDetails, false);
	assert.equal(capturedSnapshotOptions[0]?.includeBranchDetails, false);
	assert.equal(capturedSnapshotOptions[0]?.includeReviewState, false);
	assert.equal(capturedBranchCalls.length, 1);
	assert.equal(capturedBranchCalls[0]?.projectName, 'selected');
	assert.equal(capturedBranchCalls[0]?.promptBranch, 'feature/task-42');
	assert.equal(capturedReviewCalls.length, 1);
	assert.equal(capturedReviewCalls[0]?.projectName, 'selected');
	assert.equal(capturedReviewCalls[0]?.promptBranch, 'feature/task-42');

	deferredBranchHydration.resolve({
		upstream: 'origin/feature/task-42',
		ahead: 0,
		behind: 0,
		lastCommit: null,
		branches: [],
		cleanupBranches: [],
		staleLocalBranches: [],
		graph: { nodes: [], edges: [] },
	});
	await flushTurns();

	assert.equal(postedMessages.filter(message => (message as any)?.type === 'gitOverlayProjectSnapshot').length, 2);
});

test('scheduleGitOverlayOpenHydration starts review hydration without waiting for branch hydration', async () => {
	const { manager } = await createManager();
	const deferredBranchHydration = createDeferred<{
		upstream: string;
		ahead: number;
		behind: number;
		lastCommit: null;
		branches: never[];
		cleanupBranches: never[];
		staleLocalBranches: never[];
		graph: { nodes: never[]; edges: never[] };
	}>();
	const capturedReviewCalls: any[] = [];
	const postMessage = () => undefined;
	const currentPrompt = createPrompt({
		projects: ['selected'],
		branch: 'feature/task-42',
	});

	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
		]),
		getWorkspaceFolders: () => ['selected'],
	};
	(manager as any).gitService = {
		getGitOverlaySnapshot: async () => ({
			generatedAt: '2026-04-24T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [createGitOverlayProjectSnapshot('selected', {
				reviewHydrated: false,
				branchDetailsHydrated: false,
				changeDetailsHydrated: false,
			})],
		}),
		getGitOverlayProjectBranchDetails: async () => deferredBranchHydration.promise,
		getGitOverlayProjectReviewState: async () => {
			return {
				remote: null,
				request: null,
				error: '',
				setupAction: null,
				titlePrefix: '',
				unsupportedReason: null,
			};
		},
	};
	(manager as any).gitService.getGitOverlayProjectReviewState = async (
		_paths: unknown,
		_projectName: unknown,
		_promptBranch: unknown,
	) => {
		capturedReviewCalls.push({
			projectName: _projectName,
			promptBranch: _promptBranch,
		});
		return {
			remote: null,
			request: null,
			error: '',
			setupAction: null,
			titlePrefix: '',
			unsupportedReason: null,
		};
	};
	(manager as any).gitOverlaySessions.set('panel-a', {
		active: true,
		promptBranch: 'feature/task-42',
		selectedProjects: ['selected'],
		snapshotProjects: ['selected'],
		snapshotVersion: 0,
		postMessage,
		refreshTimer: null,
		refreshInFlight: false,
		refreshQueued: false,
		queuedMode: null,
		queuedBusyReason: null,
	});

	await withImmediateTimers(async () => {
		(manager as any).scheduleGitOverlayOpenHydration(
			postMessage,
			currentPrompt,
			'feature/task-42',
			['selected'],
		);
		await flushTurns();
	});

	assert.equal(capturedReviewCalls.length, 1);
	assert.equal(capturedReviewCalls[0]?.projectName, 'selected');
	assert.equal(capturedReviewCalls[0]?.promptBranch, 'feature/task-42');

	deferredBranchHydration.resolve({
		upstream: 'origin/feature/task-42',
		ahead: 0,
		behind: 0,
		lastCommit: null,
		branches: [],
		cleanupBranches: [],
		staleLocalBranches: [],
		graph: { nodes: [], edges: [] },
	});
	await flushTurns();
});

test('postGitOverlayProjectSnapshot posts a single hydrated project patch for the current overlay snapshot', async () => {
	const { manager } = await createManager();
	const postedMessages: any[] = [];
	const postMessage = (message: unknown) => {
		postedMessages.push(message);
	};
	const currentPrompt = createPrompt({
		projects: ['selected'],
		branch: 'feature/task-42',
	});

	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
		]),
		getWorkspaceFolders: () => ['selected'],
	};
	(manager as any).gitService = {
		getGitOverlayProjectSnapshot: async () => createGitOverlayProjectSnapshot('selected', {
			changeDetailsHydrated: true,
			changeGroups: {
				merge: [],
				staged: [{
					project: 'selected',
					path: 'src/index.ts',
					status: 'M',
					group: 'staged',
					conflicted: false,
					staged: true,
					fileSizeBytes: 120,
					additions: 12,
					deletions: 2,
					isBinary: false,
				}],
				workingTree: [],
				untracked: [],
			},
		}),
	};
	(manager as any).gitOverlaySessions.set('panel-a', {
		active: true,
		promptBranch: 'feature/task-42',
		selectedProjects: ['selected'],
		snapshotProjects: ['selected'],
		snapshotVersion: 0,
		postMessage,
		refreshTimer: null,
		refreshInFlight: false,
		refreshQueued: false,
		queuedMode: null,
		queuedBusyReason: null,
	});

	await (manager as any).postGitOverlayProjectSnapshot(
		postMessage,
		currentPrompt,
		'feature/task-42',
		['selected'],
		'selected',
		'2026-04-24T00:00:00.000Z',
	);

	assert.equal(postedMessages.length, 1);
	assert.equal(postedMessages[0]?.type, 'gitOverlayProjectSnapshot');
	assert.equal(postedMessages[0]?.snapshotGeneratedAt, '2026-04-24T00:00:00.000Z');
	assert.equal(postedMessages[0]?.projectSnapshot?.project, 'selected');
	assert.equal(postedMessages[0]?.projectSnapshot?.changeDetailsHydrated, true);
	assert.equal(postedMessages[0]?.projectSnapshot?.changeGroups?.staged?.[0]?.additions, 12);
});

test('postGitOverlaySnapshot drops stale lazy other-project updates after snapshot version changes', async () => {
	const { manager } = await createManager();
	const postedMessages: any[] = [];
	const deferredOtherProjects = createDeferred<any[]>();
	const postMessage = (message: unknown) => {
		postedMessages.push(message);
	};
	const currentPrompt = createPrompt({
		projects: ['selected'],
		branch: 'feature/task-42',
	});

	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
			['peer', '/tmp/peer'],
		]),
		getWorkspaceFolders: () => ['selected', 'peer'],
	};
	(manager as any).gitService = {
		getGitOverlaySnapshot: async () => ({
			generatedAt: '2026-04-24T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [createGitOverlayProjectSnapshot('selected')],
		}),
		getGitOverlayOtherProjectsSnapshot: async () => deferredOtherProjects.promise,
	};
	(manager as any).gitOverlaySessions.set('panel-a', {
		active: true,
		promptBranch: 'feature/task-42',
		selectedProjects: ['selected'],
		snapshotProjects: ['selected', 'peer'],
		snapshotVersion: 0,
		postMessage,
		refreshTimer: null,
		refreshInFlight: false,
		refreshQueued: false,
		queuedMode: null,
		queuedBusyReason: null,
	});

	await (manager as any).postGitOverlaySnapshot(postMessage, currentPrompt, 'feature/task-42', ['selected']);
	(manager as any).gitOverlaySessions.get('panel-a').snapshotVersion += 1;

	deferredOtherProjects.resolve([createGitOverlayProjectSnapshot('peer', { dirty: true })]);
	await flushTurns();

	assert.equal(postedMessages.length, 1);
	assert.equal(postedMessages[0]?.type, 'gitOverlaySnapshot');
});

test('scheduleGitOverlayAutoRefreshForActiveSessions refreshes only other projects for peer-only file changes', async () => {
	const { manager } = await createManager();
	const currentPrompt = createPrompt({
		projects: ['selected'],
		branch: 'feature/task-42',
	});
	let otherProjectsRefreshCalls = 0;
	let fullRefreshCalls = 0;

	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
			['peer', '/tmp/peer'],
		]),
		getWorkspaceFolders: () => ['selected', 'peer'],
	};
	(manager as any).panelPromptRefs.set('panel-a', currentPrompt);
	(manager as any).postGitOverlayOtherProjectsSnapshot = async () => {
		otherProjectsRefreshCalls += 1;
	};
	(manager as any).runGitOverlayRefresh = async () => {
		fullRefreshCalls += 1;
	};
	(manager as any).gitOverlaySessions.set('panel-a', {
		active: true,
		promptBranch: 'feature/task-42',
		selectedProjects: ['selected'],
		snapshotProjects: ['selected', 'peer'],
		snapshotVersion: 1,
		postMessage: () => undefined,
		refreshTimer: null,
		refreshInFlight: false,
		refreshQueued: false,
		queuedMode: null,
		queuedBusyReason: null,
	});

	await withImmediateTimers(async () => {
		(manager as any).scheduleGitOverlayAutoRefreshForActiveSessions('file', '/tmp/peer/src/changed.ts');
		await flushTurns();
	});

	assert.equal(otherProjectsRefreshCalls, 1);
	assert.equal(fullRefreshCalls, 0);
});

/** Проверяет точечный reactive refresh для selected и workspace-only проектов. */
test('scheduleGitReactiveAutoRefresh refreshes prompt dashboard for workspace file and git changes', async () => {
	const { manager } = await createManager();
	const currentPrompt = createPrompt({
		id: 'task-42',
		promptUuid: 'uuid-42',
		projects: ['selected'],
		branch: 'feature/task-42',
	});
	const postedMessages: any[] = [];
	let refreshCalls = 0;
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	};

	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
			['peer', '/tmp/peer'],
		]),
		getWorkspaceFolders: () => ['selected', 'peer'],
	};
	(manager as any).panelPromptRefs.set('panel-a', currentPrompt);
	(manager as any).resolveOpenEditorPanel = () => panel;
	const refreshModes: string[] = [];
	const refreshProjects: string[][] = [];
	let todoRefreshCalls = 0;
	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		refreshProjectsWidget: async (
			_prompt: unknown,
			postMessage?: (message: unknown) => void,
			_requestId?: string,
			mode?: string,
			projects?: string[],
		) => {
			refreshCalls += 1;
			refreshModes.push(mode || '');
			refreshProjects.push([...(projects || [])]);
			postMessage?.({
				type: 'promptDashboardWidgetSnapshot',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				widget: {
					kind: 'projects',
					cache: { status: 'fresh', source: 'refresh' },
					data: { projects: [] },
				},
			});
			return null;
		},
		refreshWidgetSnapshot: async (_prompt: unknown, widget: string) => {
			if (widget === 'todos') {
				todoRefreshCalls += 1;
			}
			return null;
		},
	};

	await withImmediateTimers(async () => {
		(manager as any).scheduleGitReactiveAutoRefresh('file', '/tmp/peer/src/changed.ts');
		await flushTurns();
	});
	assert.equal(refreshCalls, 1);

	await withImmediateTimers(async () => {
		(manager as any).scheduleGitReactiveAutoRefresh('file', '/tmp/selected/src/changed.ts');
		await flushTurns();
	});
	assert.equal(refreshCalls, 2);

	await withImmediateTimers(async () => {
		(manager as any).scheduleGitReactiveAutoRefresh('git', '/tmp/peer');
		await flushTurns();
	});
	assert.equal(refreshCalls, 3);

	await withImmediateTimers(async () => {
		(manager as any).scheduleGitReactiveAutoRefresh('git', '/tmp/selected');
		await flushTurns();
	});

	assert.equal(refreshCalls, 4);
	assert.deepEqual(refreshModes, [
		'reactive-branches',
		'reactive-branches',
		'reactive-branches',
		'reactive-branches',
	]);
	assert.deepEqual(refreshProjects, [['peer'], ['selected'], ['peer'], ['selected']]);
	assert.equal(postedMessages.some(message => message?.type === 'promptDashboardWidgetSnapshot'), true);
	assert.equal(todoRefreshCalls, 2);

	// File-причина и оба проекта сохраняются, даже если последним debounce-сигналом был Git.
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const pendingTimers = new Map<number, () => void>();
	let nextTimerId = 0;
	globalThis.setTimeout = ((handler: () => void) => {
		nextTimerId += 1;
		pendingTimers.set(nextTimerId, handler);
		return nextTimerId as unknown as NodeJS.Timeout;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((timer: NodeJS.Timeout) => {
		pendingTimers.delete(Number(timer));
	}) as typeof clearTimeout;
	try {
		(manager as any).scheduleGitReactiveAutoRefresh('file', '/tmp/peer/src/changed.ts');
		(manager as any).scheduleGitReactiveAutoRefresh('git', '/tmp/selected');
		assert.equal(pendingTimers.size, 1);
		Array.from(pendingTimers.values())[0]?.();
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
	await flushTurns();
	assert.equal(refreshCalls, 5);
	assert.deepEqual(refreshProjects[4], ['peer', 'selected']);
	assert.equal(todoRefreshCalls, 3);
});

/** Управляет таймерами обновления без ожидания реальных задержек. */
async function withControlledDashboardTimers(
	run: (
		timers: Map<number, { delay: number; fire: () => void }>,
		settle: () => Promise<void>,
	) => Promise<void>,
): Promise<void> {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const timers = new Map<number, { delay: number; fire: () => void }>();
	let nextTimerId = 0;
	globalThis.setTimeout = ((handler: () => void, delay = 0) => {
		const timerId = ++nextTimerId;
		timers.set(timerId, { delay, fire: () => { timers.delete(timerId); handler(); } });
		return timerId as unknown as NodeJS.Timeout;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((timer: NodeJS.Timeout) => { timers.delete(Number(timer)); }) as typeof clearTimeout;
	try {
		await run(timers, () => new Promise(resolve => originalSetTimeout(resolve, 0)));
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
}

/** Создаёт панель с подменёнными сервисами, без файлового хранилища и базы данных. */
async function createReactiveDashboardManager() {
	const { manager } = await createManager({
		workspaceService: {
			getWorkspaceFolderPaths: () => new Map([['selected', '/tmp/selected']]),
			getWorkspaceFolders: () => ['selected'],
		},
	});
	const panel = { visible: true, webview: { postMessage: async () => true } };
	(manager as any).panelPromptRefs.set('panel-a', createPrompt({ projects: ['selected'] }));
	(manager as any).resolveOpenEditorPanel = () => panel;
	return manager;
}

/** Шумные пути не запускают работу и не отменяют накопленное обновление проектов. */
test('dashboard ignored file events preserve a queued Git refresh with collapsed todos', async () => {
	const manager = await createReactiveDashboardManager();
	(manager as any).isPromptDashboardWidgetCollapsed = (widget: string) => widget === 'todos';
	(manager as any).getGitOverlayExcludedPathsSetting = () => ['node_modules', 'generated'];
	let projectsRefreshes = 0;
	(manager as any).promptDashboardService.refreshProjectsWidget = async () => { projectsRefreshes += 1; };
	await withControlledDashboardTimers(async (timers, settle) => {
		const ignoredPaths = [
			'/tmp/selected/node_modules/package/index.js',
			'/tmp/selected/.vscode/prompt-manager/prompts/task/report.txt',
			'/tmp/selected/generated/result.ts',
		];
		for (const filePath of ignoredPaths) {
			(manager as any).scheduleGitReactiveAutoRefresh('file', filePath);
		}
		assert.equal(timers.size, 0);
		(manager as any).scheduleGitReactiveAutoRefresh('git', '/tmp/selected');
		const queuedTimer = Array.from(timers.values())[0];
		assert.ok(queuedTimer);
		for (const filePath of ignoredPaths) {
			(manager as any).scheduleGitReactiveAutoRefresh('file', filePath);
		}
		assert.equal(timers.size, 1);
		assert.equal(Array.from(timers.values())[0], queuedTimer);
		queuedTimer.fire();
		await settle();
		assert.equal(projectsRefreshes, 1);
	});
});

/** Событие Git не отменяет очередь ToDo, когда проекты свёрнуты. */
test('dashboard Git events preserve queued todos when projects are collapsed', async () => {
	const manager = await createReactiveDashboardManager();
	(manager as any).isPromptDashboardWidgetCollapsed = (widget: string) => widget === 'projects';
	let todoRefreshes = 0;
	(manager as any).promptDashboardService.refreshWidgetSnapshot = async (_prompt: unknown, widget: string) => {
		assert.equal(widget, 'todos');
		todoRefreshes += 1;
	};
	await withControlledDashboardTimers(async (timers, settle) => {
		(manager as any).scheduleGitReactiveAutoRefresh('file', '/tmp/selected/src/task.ts');
		const queuedTimer = Array.from(timers.values())[0];
		assert.ok(queuedTimer);
		(manager as any).scheduleGitReactiveAutoRefresh('git', '/tmp/selected');
		assert.equal(timers.size, 1);
		assert.equal(Array.from(timers.values())[0], queuedTimer);
		queuedTimer.fire();
		await settle();
		assert.equal(todoRefreshes, 1);
	});
});

/** Поток событий не переносит срок обновления и не создаёт параллельные запросы. */
test('dashboard file bursts keep a fixed deadline and queue one refresh during an in-flight refresh', async () => {
	const manager = await createReactiveDashboardManager();
	const firstRefresh = createDeferred<void>();
	let projectsRefreshes = 0;
	(manager as any).promptDashboardService.refreshProjectsWidget = async () => {
		projectsRefreshes += 1;
		if (projectsRefreshes === 1) {
			await firstRefresh.promise;
		}
	};
	await withControlledDashboardTimers(async (timers, settle) => {
		(manager as any).scheduleGitReactiveAutoRefresh('file', '/tmp/selected/src/new.ts');
		const firstTimer = Array.from(timers.values())[0];
		assert.ok(firstTimer);
		assert.equal(firstTimer.delay, 5000);
		for (let index = 0; index < 20; index += 1) {
			(manager as any).scheduleGitReactiveAutoRefresh('file', '/tmp/selected/src/new.ts');
		}
		assert.equal(timers.size, 1);
		assert.equal(Array.from(timers.values())[0], firstTimer);
		firstTimer.fire();
		await settle();
		assert.equal(projectsRefreshes, 1);
		for (let index = 0; index < 20; index += 1) {
			(manager as any).scheduleGitReactiveAutoRefresh('file', '/tmp/selected/src/deleted.ts');
		}
		assert.ok(timers.size <= 1);
		// Даже истечение задержки во время запроса не должно запускать второй запрос параллельно.
		Array.from(timers.values())[0]?.fire();
		await settle();
		assert.equal(projectsRefreshes, 1);
		firstRefresh.resolve();
		await settle();
		Array.from(timers.values())[0]?.fire();
		await settle();
		assert.equal(projectsRefreshes, 2);
		assert.equal(timers.size, 0);
	});
});

/** Проверяет очистку debounce targets и причин при переключении промпта в singleton panel. */
test('setPanelPromptRef clears pending dashboard reactive state when prompt identity changes', async () => {
	const { manager } = await createManager();
	const panelKey = 'panel-a';
	(manager as any).panelPromptRefs.set(panelKey, createPrompt({ id: 'task-1', promptUuid: 'uuid-1' }));
	(manager as any).promptDashboardReactiveProjectsByPanel.set(panelKey, new Set(['peer']));
	(manager as any).promptDashboardReactiveFileRefreshByPanel.add(panelKey);
	// Очередь и незавершённый запрос принадлежат предыдущему промпту.
	(manager as any).promptDashboardReactiveGitRefreshByPanel.add(panelKey);
	(manager as any).promptDashboardReactiveRefreshInFlight.set(panelKey, {});
	(manager as any).promptDashboardReactiveRefreshStartedAt.set(panelKey, Date.now());
	(manager as any).promptDashboardPendingRefreshOnReveal.add(panelKey);
	(manager as any).promptDashboardReactiveRefreshTimers.set(panelKey, setTimeout(() => undefined, 60_000));

	(manager as any).setPanelPromptRef(panelKey, createPrompt({ id: 'task-2', promptUuid: 'uuid-2' }));

	assert.equal((manager as any).promptDashboardReactiveRefreshTimers.has(panelKey), false);
	assert.equal((manager as any).promptDashboardReactiveProjectsByPanel.has(panelKey), false);
	assert.equal((manager as any).promptDashboardReactiveFileRefreshByPanel.has(panelKey), false);
	assert.equal((manager as any).promptDashboardReactiveGitRefreshByPanel.has(panelKey), false);
	assert.equal((manager as any).promptDashboardReactiveRefreshInFlight.has(panelKey), false);
	assert.equal((manager as any).promptDashboardReactiveRefreshStartedAt.has(panelKey), false);
	assert.equal((manager as any).promptDashboardPendingRefreshOnReveal.has(panelKey), false);
});

/** Скрытие host останавливает polling даже без последнего сообщения из сохранённого webview. */
test('hidden prompt editor disables Docker metrics and rejects late visible messages until reveal', async () => {
	resetVsCodeCommandMock();
	const visibility: boolean[] = [];
	const { manager } = await createManager({
		initialPrompt: { id: 'prompt-a', promptUuid: 'uuid-a', title: 'Prompt A', projects: ['api'] },
		promptDashboardService: {
			setDockerLiveMetricsVisibility: (visible: boolean) => { visibility.push(visible); },
		},
	});
	await manager.openPrompt('prompt-a');
	const panel = vscodeCreatedWebviewPanels[0];
	try {
		await panel.emitMessage({ type: 'promptDashboardDockerLiveMetricsVisibility', visible: true });
		assert.deepEqual(visibility, [true]);
		panel.emitHidden();
		assert.equal(visibility.at(-1), false);
		await panel.emitMessage({ type: 'promptDashboardDockerLiveMetricsVisibility', visible: true });
		assert.equal(visibility.at(-1), false);
		panel.emitVisible();
		await panel.emitMessage({ type: 'promptDashboardDockerLiveMetricsVisibility', visible: true });
		assert.equal(visibility.at(-1), true);
		await panel.emitMessage({ type: 'promptDashboardDockerLiveMetricsVisibility', visible: false });
		assert.equal(visibility.at(-1), false);
	} finally {
		// Закрываем собственную singleton-панель до следующего теста host lifecycle.
		panel.dispose();
		await flushTurns();
	}
});

test('first visible prompt editor event skips bootstrap dashboard projects refresh', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
			projects: ['api'],
		},
	});
	let refreshCalls = 0;
	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		getSnapshot: () => null,
		refreshPrompt: async () => null,
		refreshPromptSnapshot: async () => null,
		refreshProjectsWidget: async () => {
			refreshCalls += 1;
			return null;
		},
		switchProjectBranch: async () => ({ success: true, errors: [] }),
		switchProjectBranches: async () => ({ success: true, errors: [] }),
		pauseActiveScope: () => undefined,
		analyzeParallelReview: async () => ({ status: 'idle', model: '', content: '' }),
	};

	await (manager as any).openPrompt('prompt-a');
	const panel = vscodeCreatedWebviewPanels[0];
	assert.ok(panel);

	panel.emitVisible();
	await flushTurns();
	assert.equal(refreshCalls, 0);

	panel.emitVisible();
	await flushTurns();
	assert.equal(refreshCalls, 0);
});

/** Реальное скрытое событие сохраняет причины обновления до показа панели. */
test('revealed prompt editor refreshes the dashboard when hidden changes were queued', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
			projects: ['api'],
		},
	});
	let refreshCalls = 0;
	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['api', '/tmp/api'],
		]),
		getWorkspaceFolders: () => ['api'],
	};
	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		getSnapshot: () => null,
		refreshPrompt: async () => null,
		refreshPromptSnapshot: async () => null,
		refreshProjectsWidget: async () => {
			refreshCalls += 1;
			return null;
		},
		switchProjectBranch: async () => ({ success: true, errors: [] }),
		switchProjectBranches: async () => ({ success: true, errors: [] }),
		pauseActiveScope: () => undefined,
		analyzeParallelReview: async () => ({ status: 'idle', model: '', content: '' }),
	};

	(manager as any).resolveOpenEditorPanel('__prompt_editor_singleton__')?.dispose();
	await flushTurns();
	await (manager as any).openPrompt('prompt-a');
	const panel = (manager as any).resolveOpenEditorPanel('__prompt_editor_singleton__') || vscodeCreatedWebviewPanels[0];
	assert.ok(panel);

	panel.visible = false;
	(manager as any).scheduleGitReactiveAutoRefresh('git', '/tmp/api');
	assert.equal(refreshCalls, 0);

	panel.emitVisible();
	await flushTurns();
	assert.equal(refreshCalls, 1);
});

test('restore waits for providers before creating Git watchers and ignores closed panels', async () => {
	const { manager } = await createManager();
	const ready = createDeferred<boolean>();
	let apiCalls = 0;
	(manager as any).whenProvidersReady = () => ready.promise;
	(manager as any).gitService = { getBuiltInGitApi: async () => { apiCalls++; return null; } };
	(manager as any).workspaceService = { getWorkspaceFolderPaths: () => new Map([['api', '/tmp/api']]) };
	const panel = { visible: true };
	(manager as any).promptEditorPanels.add(panel);
	vscodeCreatedWatchers.length = 0;
	const closed = (manager as any).ensureGitOverlayReactiveSources();
	(manager as any).disposeGitOverlayReactiveSources();
	panel.visible = false;
	ready.resolve(true);
	await closed;
	assert.equal(apiCalls, 0);
	assert.equal(vscodeCreatedWatchers.length, 0);
	panel.visible = true;
	await (manager as any).ensureGitOverlayReactiveSources();
	assert.equal(apiCalls, 1);
	assert.ok(vscodeCreatedWatchers.length > 0);
	(manager as any).disposeGitOverlayReactiveSources();
});

test('ensureGitOverlayReactiveSources starts watchers for a visible prompt editor without Git Overlay', async () => {
	const { manager } = await createManager();
	vscodeCreatedWatchers.length = 0;

	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
		]),
		getWorkspaceFolders: () => ['selected'],
	};
	(manager as any).gitService = {
		getBuiltInGitApi: async () => null,
	};
	(manager as any).promptEditorPanels.add({ visible: true });

	await (manager as any).ensureGitOverlayReactiveSources();

	assert.ok(vscodeCreatedWatchers.length > 0);
});

/** Создание и удаление неотслеживаемого файла обновляет проекты без Git-события. */
test('workspace file watcher refreshes prompt dashboard for a visible editor without Git Overlay session', async () => {
	const { manager } = await createManager();
	vscodeCreatedWatchers.length = 0;
	const currentPrompt = createPrompt({
		id: 'task-42',
		promptUuid: 'uuid-42',
		projects: ['selected'],
	});
	const panel = {
		visible: true,
		webview: {
			postMessage: async () => true,
		},
	};
	let refreshCalls = 0;

	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
		]),
		getWorkspaceFolders: () => ['selected'],
	};
	(manager as any).gitService = {
		getBuiltInGitApi: async () => null,
	};
	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		refreshProjectsWidget: async () => {
			refreshCalls += 1;
			return null;
		},
	};
	(manager as any).panelPromptRefs.set('panel-a', currentPrompt);
	(manager as any).resolveOpenEditorPanel = () => panel;
	(manager as any).promptEditorPanels.add(panel);

	await (manager as any).ensureGitOverlayReactiveSources();

	const workspaceWatcher = vscodeCreatedWatchers.find((watcher: any) => watcher?.pattern?.pattern === '**/*');
	assert.ok(workspaceWatcher);

	await withImmediateTimers(async () => {
		workspaceWatcher.emitChange({ fsPath: '/tmp/selected/src/changed.ts' });
		await flushTurns();
	});

	assert.equal(refreshCalls, 1);
	// Оба изменения состава файлов должны обновлять список незакоммиченных изменений.
	await withImmediateTimers(async () => {
		workspaceWatcher.emitCreate({ fsPath: '/tmp/selected/src/untracked.ts' });
		await flushTurns();
		workspaceWatcher.emitDelete({ fsPath: '/tmp/selected/src/untracked.ts' });
		await flushTurns();
	});
	assert.equal(refreshCalls, 3);
});

test('agent.json watcher posts promptAgentProgress to the open editor panel', async () => {
	resetVsCodeCommandMock();
	let agentProgress = 14;
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			status: 'in-progress',
			title: 'Prompt A',
		},
		readAgentProgress: async () => agentProgress,
	});

	await (manager as any).openPrompt('prompt-a');
	const panel = (manager as any).resolveOpenEditorPanel('__prompt_editor_singleton__') || vscodeCreatedWebviewPanels[0];
	assert.ok(panel);
	panel.postedMessages.length = 0;

	const agentWatcher = vscodeCreatedWatchers.find((watcher: any) => watcher?.pattern?.pattern === '**/agent.json');
	assert.ok(agentWatcher);

	agentProgress = 67;
	await withImmediateTimers(async () => {
		agentWatcher.emitChange({
			fsPath: '/tmp/workspace/.vscode/prompt-manager/prompts/prompt-a/agent.json',
			toString() {
				return this.fsPath;
			},
		});
		await flushTurns(3);
	});

	assert.equal(panel.postedMessages.some((message: any) => (
		message?.type === 'promptAgentProgress'
		&& message.promptId === 'prompt-a'
		&& message.promptUuid === 'uuid-a'
		&& message.progress === 67
	)), true);
	assert.equal((manager as any).panelPromptRefs.get('__prompt_editor_singleton__')?.progress, 67);
});

/** Скрытая панель пропускает чтение прогресса и догоняет его при показе без нового события. */
test('hidden prompt progress catches up on reveal without another file event', async () => {
	resetVsCodeCommandMock();
	let progress = 14;
	let progressReads = 0;
	const { manager } = await createManager({
		initialPrompt: { id: 'prompt-a', promptUuid: 'uuid-a', title: 'Prompt A', progress: 14 },
		readAgentProgress: async () => { progressReads += 1; return progress; },
	});
	// Удаляем общую панель прошлого теста вместе с её обработчиками показа.
	(manager as any).resolveOpenEditorPanel('__prompt_editor_singleton__')?.dispose();
	await flushTurns();
	await (manager as any).openPrompt('prompt-a');
	const panel = (manager as any).resolveOpenEditorPanel('__prompt_editor_singleton__');
	assert.ok(panel);
	await flushTurns();
	panel.visible = false;
	panel.postedMessages.length = 0;
	progress = 100;
	const readsBeforeHiddenSync = progressReads;
	await (manager as any).syncAgentProgressForOpenPanels();
	assert.equal(progressReads, readsBeforeHiddenSync);
	assert.equal((manager as any).panelPromptRefs.get('__prompt_editor_singleton__')?.progress, 14);
	assert.equal(panel.postedMessages.some((message: any) => message?.type === 'promptAgentProgress'), false);
	panel.emitVisible();
	await flushTurns();
	assert.equal((manager as any).panelPromptRefs.get('__prompt_editor_singleton__')?.progress, 100);
	assert.equal(panel.postedMessages.some((message: any) => message?.type === 'promptAgentProgress' && message.progress === 100), true);
	manager.disposeAll();
});

/** Завершение старого чтения прогресса не перезаписывает новый промпт той же панели. */
test('progress sync ignores an old read after switching the panel prompt', async () => {
	const pendingProgress = createDeferred<number | undefined>();
	const { manager } = await createManager({ readAgentProgress: async () => pendingProgress.promise });
	const panelKey = 'progress-race-panel';
	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: { postMessage: async (message: unknown) => { postedMessages.push(message); return true; } },
	};
	const previousPrompt = createPrompt({ id: 'prompt-a', promptUuid: 'uuid-a', progress: 14 });
	const currentPrompt = createPrompt({ id: 'prompt-b', promptUuid: 'uuid-b', progress: 35 });
	const currentSnapshot = clonePrompt(currentPrompt);
	(manager as any).resolveOpenEditorPanel = () => panel;
	(manager as any).setPanelPromptRef(panelKey, previousPrompt);
	const pendingSync = (manager as any).syncAgentProgressForPanel(panelKey);
	// Пользователь переключается на другой промпт до завершения чтения предыдущего.
	(manager as any).setPanelPromptRef(panelKey, currentPrompt);
	(manager as any).panelLatestPromptSnapshots.set(panelKey, currentSnapshot);
	pendingProgress.resolve(100);
	await pendingSync;
	assert.equal((manager as any).panelPromptRefs.get(panelKey), currentPrompt);
	assert.equal(currentPrompt.progress, 35);
	assert.equal((manager as any).panelLatestPromptSnapshots.get(panelKey), currentSnapshot);
	assert.equal(currentSnapshot.progress, 35);
	assert.equal(previousPrompt.progress, 14);
	assert.equal(postedMessages.some(message => message?.type === 'promptAgentProgress'), false);
});

test('built-in git openRepository bootstrap does not schedule reactive refresh', async () => {
	const { manager } = await createManager();
	const scheduledRefreshes: Array<{ reason: string; changedPath?: string }> = [];
	let openRepositoryListener: ((repository: any) => void) | undefined;

	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
		]),
		getWorkspaceFolders: () => ['selected'],
	};
	(manager as any).promptEditorPanels.add({ visible: true });
	(manager as any).scheduleGitReactiveAutoRefresh = (reason: string, changedPath?: string) => {
		scheduledRefreshes.push({ reason, changedPath });
	};
	(manager as any).gitService = {
		getBuiltInGitApi: async () => ({
			repositories: [],
			onDidOpenRepository: (listener: (repository: any) => void) => {
				openRepositoryListener = listener;
				return createDisposable();
			},
			onDidCloseRepository: () => createDisposable(),
		}),
	};

	await (manager as any).ensureGitOverlayReactiveSources();
	openRepositoryListener?.({
		rootUri: { fsPath: '/tmp/selected' },
		state: { onDidChange: () => createDisposable() },
		onDidCommit: () => createDisposable(),
		onDidCheckout: () => createDisposable(),
	});

	assert.deepEqual(scheduledRefreshes, []);
	assert.equal((manager as any).gitOverlayBuiltInRepositoryDisposables.has('/tmp/selected'), true);
});

test('getPromptDashboardSnapshot ignores boot-time placeholder prompt payload when host already has the real prompt', async () => {
	const { manager } = await createManager();
	const currentPrompt = createPrompt({
		id: 'task-42',
		promptUuid: 'uuid-42',
		projects: ['selected'],
		branch: 'feature/task-42',
	});
	const receivedPrompts: any[] = [];
	const panelMessages: any[] = [];
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				panelMessages.push(message);
				return true;
			},
		},
	};

	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		getSnapshot: (prompt: unknown) => {
			receivedPrompts.push(prompt);
			return { projects: null };
		},
	};

	await (manager as any).handleMessage(
		{
			type: 'getPromptDashboardSnapshot',
			prompt: createPrompt({
				id: '',
				promptUuid: 'boot-placeholder-uuid',
				title: '',
				content: '',
				projects: [],
				branch: '',
				trackedBranch: '',
				trackedBranchesByProject: {},
				model: '',
			}),
			requestId: 'dashboard-req-1',
		} as any,
		panel as any,
		currentPrompt,
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.equal(receivedPrompts[0]?.id, 'task-42');
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardSnapshot'), true);
});

test('hydratePromptDashboardProjectsDetails refreshes only the projects widget in details mode', async () => {
	const { manager } = await createManager();
	const receivedModes: string[] = [];
	const receivedProjects: string[][] = [];
	const panelMessages: any[] = [];
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				panelMessages.push(message);
				return true;
			},
		},
	};

	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		refreshProjectsWidget: async (
			_prompt: unknown,
			postMessage?: (message: unknown) => void,
			_requestId?: string,
			mode?: string,
			projects?: string[],
		) => {
			receivedModes.push(mode || '');
			receivedProjects.push([...(projects || [])]);
			postMessage?.({
				type: 'promptDashboardWidgetSnapshot',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				widget: {
					kind: 'projects',
					cache: { status: 'fresh', source: 'refresh' },
					data: { projects: [] },
				},
			});
			return null;
		},
	};

	await (manager as any).handleMessage(
		{
			type: 'hydratePromptDashboardProjectsDetails',
			prompt: createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
			projects: ['api'],
			requestId: 'dashboard-hydrate-1',
		} as any,
		panel as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.deepEqual(receivedModes, ['details']);
	assert.deepEqual(receivedProjects, [['api']]);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardWidgetSnapshot'), true);
});

/** Проверяет terminal response при collapse race после отправки project-details request. */
test('hydratePromptDashboardProjectsDetails completes request when projects widget collapsed before host handling', async () => {
	const { manager } = await createManager();
	const panelMessages: any[] = [];
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				panelMessages.push(message);
				return true;
			},
		},
	};
	(manager as any).isPromptDashboardWidgetCollapsed = (widget: string) => widget === 'projects';

	await (manager as any).handleMessage(
		{
			type: 'hydratePromptDashboardProjectsDetails',
			prompt: createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
			projects: ['api'],
			requestId: 'dashboard-hydrate-collapsed',
		} as any,
		panel as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.deepEqual(panelMessages, [{
		type: 'promptDashboardRequestCompleted',
		requestId: 'dashboard-hydrate-collapsed',
		target: 'projects',
	}]);
});

/** Проверяет terminal response для обычного widget refresh при collapse race. */
test('refreshPromptDashboardWidget completes request when target widget collapsed before host handling', async () => {
	const { manager } = await createManager();
	const panelMessages: any[] = [];
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				panelMessages.push(message);
				return true;
			},
		},
	};
	(manager as any).isPromptDashboardWidgetCollapsed = (widget: string) => widget === 'activity';

	await (manager as any).handleMessage(
		{
			type: 'refreshPromptDashboardWidget',
			prompt: createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
			widget: 'activity',
			requestId: 'dashboard-activity-collapsed',
		} as any,
		panel as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.deepEqual(panelMessages, [{
		type: 'promptDashboardRequestCompleted',
		requestId: 'dashboard-activity-collapsed',
		target: 'activity',
	}]);
});

test('promptDashboardOpenTodoMarker opens a workspace file at the requested line', async () => {
	const { manager } = await createManager({
		workspaceService: {
			getWorkspaceFolders: () => ['api'],
			getWorkspaceFolderPaths: () => new Map([['api', '/tmp/workspace/api']]),
		},
	});
	const filePath = '/tmp/workspace/api/src/app.ts';
	vscodeWorkspaceFiles.set(filePath, 'const a = 1;\n// todo: wire widget\nconst b = 2;');
	const panelMessages: any[] = [];
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				panelMessages.push(message);
				return true;
			},
		},
	};

	await (manager as any).handleMessage(
		{
			type: 'promptDashboardOpenTodoMarker',
			project: 'api',
			filePath: 'src/app.ts',
			line: 2,
			column: 4,
		} as any,
		panel as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.equal(vscodeActiveTextEditor?.document?.uri?.fsPath, filePath);
	assert.equal(vscodeActiveTextEditor?.selection?.start?.line, 1);
	assert.equal(vscodeActiveTextEditor?.selection?.start?.character, 3);
	assert.equal(panelMessages.some(message => message?.type === 'error'), false);
});

test('promptDashboardSwitchBranch refreshes only the projects widget and starts AI review without full snapshot blocking', async () => {
	const { manager } = await createManager();
	const refreshModes: string[] = [];
	const refreshProjects: string[][] = [];
	const analyzeProjects: string[][] = [];
	const analyzeSkipProjectsRefresh: boolean[] = [];
	const panelMessages: any[] = [];
	let refreshPromptCalls = 0;
	let analyzeCalls = 0;
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				panelMessages.push(message);
				return true;
			},
		},
	};

	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		switchProjectBranch: async () => ({ success: true, errors: [] }),
		refreshPrompt: async () => {
			refreshPromptCalls += 1;
			return null;
		},
		refreshProjectsWidget: async (
			_prompt: unknown,
			postMessage?: (message: unknown) => void,
			_requestId?: string,
			mode?: string,
			projects?: string[],
		) => {
			refreshModes.push(mode || '');
			refreshProjects.push([...(projects || [])]);
			postMessage?.({
				type: 'promptDashboardWidgetSnapshot',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				widget: {
					kind: 'projects',
					cache: { status: 'fresh', source: 'refresh' },
					data: { projects: [] },
				},
			});
			return null;
		},
		analyzeParallelReview: async (
			_prompt: unknown,
			postMessage?: (message: unknown) => void,
			_requestId?: string,
			options?: { projectNames?: string[]; skipProjectsRefresh?: boolean },
		) => {
			analyzeCalls += 1;
			analyzeProjects.push([...(options?.projectNames || [])]);
			analyzeSkipProjectsRefresh.push(options?.skipProjectsRefresh === true);
			postMessage?.({
				type: 'promptDashboardAnalysis',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				analysis: {
					status: 'running',
					model: 'gpt-5',
					content: '',
				},
			});
			return { status: 'running', model: 'gpt-5', content: '' };
		},
	};

	await (manager as any).handleMessage(
		{
			type: 'promptDashboardSwitchBranch',
			prompt: createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
			project: 'api',
			branch: 'develop',
			requestId: 'dashboard-switch-1',
		} as any,
		panel as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.equal(refreshPromptCalls, 0);
	assert.deepEqual(refreshModes, ['reactive-branches']);
	assert.deepEqual(refreshProjects, [['api']]);
	assert.equal(analyzeCalls, 1);
	assert.deepEqual(analyzeProjects, [['api']]);
	assert.deepEqual(analyzeSkipProjectsRefresh, [true]);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardWidgetSnapshot'), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardAnalysis'), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardSnapshot'), false);
});

test('promptDashboardPullProject refreshes only the projects widget and starts AI review without full snapshot blocking', async () => {
	const { manager } = await createManager();
	const refreshModes: string[] = [];
	const refreshProjects: string[][] = [];
	const analyzeProjects: string[][] = [];
	const analyzeSkipProjectsRefresh: boolean[] = [];
	const panelMessages: any[] = [];
	let pullCalls = 0;
	let analyzeCalls = 0;
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				panelMessages.push(message);
				return true;
			},
		},
	};

	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		pullProject: async () => {
			pullCalls += 1;
			return { success: true, errors: [] };
		},
		refreshProjectsWidget: async (
			_prompt: unknown,
			postMessage?: (message: unknown) => void,
			_requestId?: string,
			mode?: string,
			projects?: string[],
		) => {
			refreshModes.push(mode || '');
			refreshProjects.push([...(projects || [])]);
			postMessage?.({
				type: 'promptDashboardWidgetSnapshot',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				widget: {
					kind: 'projects',
					cache: { status: 'fresh', source: 'refresh' },
					data: { projects: [] },
				},
			});
			return null;
		},
		analyzeParallelReview: async (
			_prompt: unknown,
			postMessage?: (message: unknown) => void,
			_requestId?: string,
			options?: { projectNames?: string[]; skipProjectsRefresh?: boolean },
		) => {
			analyzeCalls += 1;
			analyzeProjects.push([...(options?.projectNames || [])]);
			analyzeSkipProjectsRefresh.push(options?.skipProjectsRefresh === true);
			postMessage?.({
				type: 'promptDashboardAnalysis',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				analysis: {
					status: 'running',
					model: 'gpt-5',
					content: '',
				},
			});
			return { status: 'running', model: 'gpt-5', content: '' };
		},
	};

	await (manager as any).handleMessage(
		{
			type: 'promptDashboardPullProject',
			prompt: createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
			project: 'api',
			requestId: 'dashboard-pull-1',
		} as any,
		panel as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.equal(pullCalls, 1);
	assert.deepEqual(refreshModes, ['reactive-branches']);
	assert.deepEqual(refreshProjects, [['api']]);
	assert.equal(analyzeCalls, 1);
	assert.deepEqual(analyzeProjects, [['api']]);
	assert.deepEqual(analyzeSkipProjectsRefresh, [true]);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardWidgetSnapshot'), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardAnalysis'), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardSnapshot'), false);
});

test('promptDashboardDockerWorkspaceAction refreshes only the Docker widget after a workspace batch action', async () => {
	const { manager } = await createManager();
	const panelMessages: any[] = [];
	const refreshTargets: string[] = [];
	let workspaceActionCalls = 0;
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				panelMessages.push(message);
				return true;
			},
		},
	};

	(manager as any).dockerContainersService = {
		runWorkspaceAction: async () => {
			workspaceActionCalls += 1;
			return { action: 'stopAll', rememberedCount: 2, requestedCount: 2, completedCount: 2, failedContainers: [] };
		},
	};
	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		refreshWidgetSnapshot: async (
			_prompt: unknown,
			widget: string,
			postMessage?: (message: unknown) => void,
			_requestId?: string,
			section?: string,
		) => {
			refreshTargets.push(`${widget}:${section || ''}`);
			postMessage?.({
				type: 'promptDashboardWidgetSnapshot',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				widget: {
					kind: 'docker',
					cache: { status: 'fresh', source: 'refresh' },
					data: {
						enabled: true,
						available: true,
						generatedAt: '2026-05-31T10:00:00.000Z',
						defaultViewMode: 'tree',
						composeFilePatterns: [],
						projects: [],
						totalContainers: 0,
						runningContainers: 0,
						stoppedContainers: 0,
						warningContainers: 0,
						errorContainers: 0,
					},
				},
			});
			return null;
		},
	};

	await (manager as any).handleMessage(
		{
			type: 'promptDashboardDockerWorkspaceAction',
			action: 'stopAll',
			prompt: createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
			requestId: 'docker-workspace-1',
		} as any,
		panel as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.equal(workspaceActionCalls, 1);
	assert.deepEqual(refreshTargets, ['docker:dockerContainers']);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardWidgetSnapshot'), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'info' && /Остановлены все запущенные контейнеры рабочей области: 2/.test(String(message?.message || ''))), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardSnapshot'), false);
});

test('promptDashboardDockerWorkspaceAction reports restartAll and refreshes only the Docker widget', async () => {
	const { manager } = await createManager();
	const panelMessages: any[] = [];
	const refreshTargets: string[] = [];
	let workspaceActionCalls = 0;
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				panelMessages.push(message);
				return true;
			},
		},
	};

	(manager as any).dockerContainersService = {
		runWorkspaceAction: async () => {
			workspaceActionCalls += 1;
			return { action: 'restartAll', rememberedCount: 2, requestedCount: 2, completedCount: 2, failedContainers: [] };
		},
	};
	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		refreshWidgetSnapshot: async (
			_prompt: unknown,
			widget: string,
			postMessage?: (message: unknown) => void,
			_requestId?: string,
			section?: string,
		) => {
			refreshTargets.push(`${widget}:${section || ''}`);
			postMessage?.({
				type: 'promptDashboardWidgetSnapshot',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				widget: {
					kind: 'docker',
					cache: { status: 'fresh', source: 'refresh' },
					data: {
						enabled: true,
						available: true,
						generatedAt: '2026-05-31T10:00:00.000Z',
						defaultViewMode: 'tree',
						composeFilePatterns: [],
						projects: [],
						totalContainers: 0,
						runningContainers: 0,
						stoppedContainers: 0,
						warningContainers: 0,
						errorContainers: 0,
					},
				},
			});
			return null;
		},
	};

	await (manager as any).handleMessage(
		{
			type: 'promptDashboardDockerWorkspaceAction',
			action: 'restartAll',
			prompt: createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
			requestId: 'docker-workspace-restart-1',
		} as any,
		panel as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.equal(workspaceActionCalls, 1);
	assert.deepEqual(refreshTargets, ['docker:dockerContainers']);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardWidgetSnapshot'), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'info' && /Перезапущены все запущенные контейнеры рабочей области: 2/.test(String(message?.message || ''))), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardSnapshot'), false);
});

test('promptDashboardPullProject still refreshes the projects widget when pull fails', async () => {
	const { manager } = await createManager();
	const refreshModes: string[] = [];
	const refreshProjects: string[][] = [];
	const analyzeProjects: string[][] = [];
	const analyzeSkipProjectsRefresh: boolean[] = [];
	const panelMessages: any[] = [];
	let pullCalls = 0;
	let analyzeCalls = 0;
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				panelMessages.push(message);
				return true;
			},
		},
	};

	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		pullProject: async () => {
			pullCalls += 1;
			return { success: false, errors: ['api: origin недоступен'], projectErrors: { api: 'origin недоступен' } };
		},
		refreshProjectsWidget: async (
			_prompt: unknown,
			postMessage?: (message: unknown) => void,
			_requestId?: string,
			mode?: string,
			projects?: string[],
		) => {
			refreshModes.push(mode || '');
			refreshProjects.push([...(projects || [])]);
			postMessage?.({
				type: 'promptDashboardWidgetSnapshot',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				widget: {
					kind: 'projects',
					cache: { status: 'fresh', source: 'refresh' },
					data: { projects: [] },
				},
			});
			return null;
		},
		analyzeParallelReview: async (
			_prompt: unknown,
			postMessage?: (message: unknown) => void,
			_requestId?: string,
			options?: { projectNames?: string[]; skipProjectsRefresh?: boolean },
		) => {
			analyzeCalls += 1;
			analyzeProjects.push([...(options?.projectNames || [])]);
			analyzeSkipProjectsRefresh.push(options?.skipProjectsRefresh === true);
			postMessage?.({
				type: 'promptDashboardAnalysis',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				analysis: {
					status: 'running',
					model: 'gpt-5',
					content: '',
				},
			});
			return { status: 'running', model: 'gpt-5', content: '' };
		},
	};

	await (manager as any).handleMessage(
		{
			type: 'promptDashboardPullProject',
			prompt: createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
			project: 'api',
			requestId: 'dashboard-pull-1',
		} as any,
		panel as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.equal(pullCalls, 1);
	assert.deepEqual(refreshModes, ['reactive-branches']);
	assert.deepEqual(refreshProjects, [['api']]);
	assert.equal(analyzeCalls, 1);
	assert.deepEqual(analyzeProjects, [['api']]);
	assert.deepEqual(analyzeSkipProjectsRefresh, [true]);
	assert.equal(panelMessages.some((message: any) => message?.type === 'error' && String(message?.message || '').includes('origin недоступен')), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardWidgetSnapshot'), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardAnalysis'), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardSnapshot'), false);
});

test('refreshPromptDashboard posts a refreshed snapshot before AI review finishes', async () => {
	const { manager } = await createManager();
	const panelMessages: any[] = [];
	let refreshPromptCalls = 0;
	let refreshPromptSnapshotCalls = 0;
	let analyzeCalls = 0;
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				panelMessages.push(message);
				return true;
			},
		},
	};

	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		refreshPrompt: async () => {
			refreshPromptCalls += 1;
			return null;
		},
		refreshPromptSnapshot: async () => {
			refreshPromptSnapshotCalls += 1;
			return {
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				generatedAt: '2026-05-03T12:00:00.000Z',
				scopeKey: 'task-42::dashboard',
				activity: { kind: 'activity', cache: { status: 'fresh', source: 'refresh' }, data: { thresholdMs: 300000, today: [], yesterday: [] } },
				status: { kind: 'status', cache: { status: 'fresh', source: 'refresh' }, data: { status: 'in-progress', progress: 55, totalTimeMs: 0, updatedAt: '2026-05-03T12:00:00.000Z' } },
				projects: { kind: 'projects', cache: { status: 'fresh', source: 'refresh' }, data: { projects: [] } },
				docker: { kind: 'docker', cache: { status: 'fresh', source: 'refresh' }, data: { enabled: true, available: true, generatedAt: '2026-05-03T12:00:00.000Z', defaultViewMode: 'tree', composeFilePatterns: [], projects: [], totalContainers: 0, runningContainers: 0, stoppedContainers: 0, warningContainers: 0, errorContainers: 0 } },
				aiAnalysis: { kind: 'aiAnalysis', cache: { status: 'fresh', source: 'cache' }, data: { status: 'idle', model: 'gpt-5', content: '' } },
			};
		},
		analyzeParallelReview: async (_prompt: unknown, postMessage?: (message: unknown) => void) => {
			analyzeCalls += 1;
			postMessage?.({
				type: 'promptDashboardAnalysis',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				analysis: {
					status: 'running',
					model: 'gpt-5',
					content: '',
				},
			});
			return { status: 'running', model: 'gpt-5', content: '' };
		},
	};

	await (manager as any).handleMessage(
		{
			type: 'refreshPromptDashboard',
			prompt: createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
			requestId: 'dashboard-refresh-1',
		} as any,
		panel as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.equal(refreshPromptCalls, 0);
	assert.equal(refreshPromptSnapshotCalls, 1);
	assert.equal(analyzeCalls, 1);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardSnapshot'), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardAnalysis'), true);
});

test('promptDashboardSwitchBranches refreshes only targeted project rows and starts AI review without full snapshot blocking', async () => {
	const { manager } = await createManager();
	const refreshModes: string[] = [];
	const refreshProjects: string[][] = [];
	const analyzeProjects: string[][] = [];
	const analyzeSkipProjectsRefresh: boolean[] = [];
	const panelMessages: any[] = [];
	let analyzeCalls = 0;
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				panelMessages.push(message);
				return true;
			},
		},
	};

	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		switchProjectBranches: async () => ({ success: true, errors: [] }),
		refreshProjectsWidget: async (
			_prompt: unknown,
			postMessage?: (message: unknown) => void,
			_requestId?: string,
			mode?: string,
			projects?: string[],
		) => {
			refreshModes.push(mode || '');
			refreshProjects.push([...(projects || [])]);
			postMessage?.({
				type: 'promptDashboardWidgetSnapshot',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				widget: {
					kind: 'projects',
					cache: { status: 'fresh', source: 'refresh' },
					data: { projects: [] },
				},
			});
			return null;
		},
		analyzeParallelReview: async (
			_prompt: unknown,
			postMessage?: (message: unknown) => void,
			_requestId?: string,
			options?: { projectNames?: string[]; skipProjectsRefresh?: boolean },
		) => {
			analyzeCalls += 1;
			analyzeProjects.push([...(options?.projectNames || [])]);
			analyzeSkipProjectsRefresh.push(options?.skipProjectsRefresh === true);
			postMessage?.({
				type: 'promptDashboardAnalysis',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				analysis: {
					status: 'running',
					model: 'gpt-5',
					content: '',
				},
			});
			return { status: 'running', model: 'gpt-5', content: '' };
		},
	};

	await (manager as any).handleMessage(
		{
			type: 'promptDashboardSwitchBranches',
			prompt: createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api', 'web'] }),
			branchesByProject: { api: 'develop', web: 'release' },
			requestId: 'dashboard-switch-many-1',
		} as any,
		panel as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api', 'web'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.deepEqual(refreshModes, ['reactive-branches']);
	assert.deepEqual(refreshProjects, [['api', 'web']]);
	assert.equal(analyzeCalls, 1);
	assert.deepEqual(analyzeProjects, [['api', 'web']]);
	assert.deepEqual(analyzeSkipProjectsRefresh, [true]);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardWidgetSnapshot'), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardAnalysis'), true);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardSnapshot'), false);
});

test('refreshPromptDashboardWidget uses the just-saved expanded dashboard state before collapse persistence finishes', async () => {
	const saveGate = createDeferred<void>();
	let refreshWidgetCalls = 0;
	const refreshSections: string[] = [];
	const { manager } = await createManager({
		stateService: {
			getPromptDashboardCollapsedSections: () => ({
				projectBranches: true,
				reviewRequests: true,
				parallelBranches: true,
				projectCommits: true,
			}),
			savePromptDashboardCollapsedSections: async () => {
				await saveGate.promise;
			},
		},
	});
	const panelMessages: any[] = [];
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				panelMessages.push(message);
				return true;
			},
		},
	};

	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		refreshWidgetSnapshot: async (
			_prompt: unknown,
			_widget: unknown,
			postMessage?: (message: unknown) => void,
			_requestId?: string,
			section?: string,
		) => {
			refreshWidgetCalls += 1;
			refreshSections.push(section || '');
			postMessage?.({
				type: 'promptDashboardWidgetSnapshot',
				promptId: 'task-42',
				promptUuid: 'uuid-42',
				widget: {
					kind: 'projects',
					cache: { status: 'fresh', source: 'refresh' },
					data: { projects: [] },
				},
			});
			return null;
		},
	};

	const savePromise = (manager as any).handleMessage(
		{
			type: 'savePromptDashboardCollapsedSections',
			state: {},
		} as any,
		panel as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	await (manager as any).handleMessage(
		{
			type: 'refreshPromptDashboardWidget',
			prompt: createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
			widget: 'projects',
			section: 'projectBranches',
			requestId: 'dashboard-widget-refresh-after-expand',
		} as any,
		panel as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	saveGate.resolve();
	await savePromise;

	assert.equal(refreshWidgetCalls, 1);
	assert.deepEqual(refreshSections, ['projectBranches']);
	assert.equal(panelMessages.some((message: any) => message?.type === 'promptDashboardWidgetSnapshot'), true);
});

/** Verify that any completed daily time write refreshes the visible global activity widget once. */
test('daily time change refreshes the visible global activity widget without a loading snapshot', async () => {
	resetVsCodeCommandMock();
	const refreshCalls: Array<{ widget: string; showLoadingState: boolean | undefined }> = [];
	const { manager, emitDailyTimeChange } = await createManager({
		initialPrompt: { id: 'task-161', promptUuid: 'uuid-161', title: 'Task 161' },
		promptDashboardService: {
			refreshWidgetSnapshot: async (
				prompt: any,
				widget: string,
				postMessage?: (message: unknown) => void,
				_requestId?: string,
				_section?: string,
				options?: { showLoadingState?: boolean },
			) => {
				refreshCalls.push({ widget, showLoadingState: options?.showLoadingState });
				postMessage?.({
					type: 'promptDashboardWidgetSnapshot',
					promptId: prompt.id,
					promptUuid: prompt.promptUuid,
					widget: { kind: 'activity', cache: { status: 'fresh' }, data: { today: [], yesterday: [] } },
				});
				return null;
			},
		},
	});

	await manager.openPrompt('task-161');
	const panel = (manager as any).resolveOpenEditorPanel('__prompt_editor_singleton__');
	assert.ok(panel);
	panel.postedMessages.length = 0;

	await withImmediateTimers(async () => {
		emitDailyTimeChange({ id: 'task-other', promptUuid: 'uuid-other', archived: false });
		emitDailyTimeChange({ id: 'task-other', promptUuid: 'uuid-other', archived: false });
		await flushTurns(3);
	});

	assert.deepEqual(refreshCalls, [{ widget: 'activity', showLoadingState: false }]);
	assert.equal(
		panel.postedMessages.some((message: any) => message?.type === 'promptDashboardWidgetSnapshot'),
		true,
	);
	manager.disposeAll();
});

/** Verify that hidden and collapsed activity targets ignore completed daily time writes. */
test('daily time change skips hidden and collapsed prompt panels', async () => {
	resetVsCodeCommandMock();
	let refreshCalls = 0;
	const { manager, emitDailyTimeChange } = await createManager({
		initialPrompt: { id: 'task-161', promptUuid: 'uuid-161', title: 'Task 161' },
		promptDashboardService: {
			refreshWidgetSnapshot: async () => {
				refreshCalls += 1;
				return null;
			},
		},
	});

	await manager.openPrompt('task-161');
	const panel = (manager as any).resolveOpenEditorPanel('__prompt_editor_singleton__');
	assert.ok(panel);

	await withImmediateTimers(async () => {
		panel.visible = false;
		emitDailyTimeChange({ id: 'task-161', promptUuid: 'uuid-161', archived: false });
		panel.visible = true;
		(manager as any).promptDashboardLayoutsState['two-columns'].collapsedSections = { activity: true };
		emitDailyTimeChange({ id: 'task-161', promptUuid: 'uuid-161', archived: false });
		await flushTurns(3);
	});

	assert.equal(refreshCalls, 0);
	manager.disposeAll();
});

/** Verify that an activity result is dropped when the panel switches prompts during refresh. */
test('daily time change drops activity messages after the prompt panel switches', async () => {
	resetVsCodeCommandMock();
	const refreshGate = createDeferred<void>();
	let activityPostMessage: ((message: unknown) => void) | undefined;
	const { manager, emitDailyTimeChange } = await createManager({
		initialPrompt: { id: 'task-161', promptUuid: 'uuid-161', title: 'Task 161' },
		promptDashboardService: {
			refreshWidgetSnapshot: async (
				_prompt: unknown,
				_widget: string,
				postMessage?: (message: unknown) => void,
			) => {
				activityPostMessage = postMessage;
				await refreshGate.promise;
				return null;
			},
		},
	});

	await manager.openPrompt('task-161');
	const panelKey = '__prompt_editor_singleton__';
	const panel = (manager as any).resolveOpenEditorPanel(panelKey);
	assert.ok(panel);
	panel.postedMessages.length = 0;

	await withImmediateTimers(async () => {
		emitDailyTimeChange({ id: 'task-other', promptUuid: 'uuid-other', archived: false });
		await flushTurns(2);
	});
	assert.ok(activityPostMessage);

	(manager as any).panelPromptRefs.set(panelKey, createPrompt({ id: 'task-162', promptUuid: 'uuid-162' }));
	activityPostMessage?.({
		type: 'promptDashboardWidgetSnapshot',
		promptId: 'task-161',
		promptUuid: 'uuid-161',
		widget: { kind: 'activity', cache: { status: 'fresh' }, data: { today: [], yesterday: [] } },
	});
	refreshGate.resolve();
	await flushTurns(2);

	assert.equal(
		panel.postedMessages.some((message: any) => message?.type === 'promptDashboardWidgetSnapshot'),
		false,
	);
	manager.disposeAll();
});

test('savePromptDashboardCollapsedSections syncs prompt dashboard collapsed sections into PromptDashboardService immediately', async () => {
	const syncedCollapsedStates: Array<Record<string, boolean>> = [];
	const layouts = normalizePromptDashboardLayouts();
	const { manager } = await createManager({ stateService: {
		getPromptDashboardLayouts: () => clonePrompt(layouts),
		savePromptDashboardCollapsedSections: async (state: Record<string, boolean>) => {
			layouts['two-columns'].collapsedSections = { ...state };
		},
	} });
	(manager as any).promptDashboardService = {
		setCollapsedSections: (state: Record<string, boolean>) => {
			syncedCollapsedStates.push({ ...state });
		},
	};

	await (manager as any).handleMessage(
		{
			type: 'savePromptDashboardCollapsedSections',
			state: { dockerContainers: true },
		} as any,
		{ webview: {} } as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	await (manager as any).handleMessage(
		{
			type: 'savePromptDashboardCollapsedSections',
			state: {},
		} as any,
		{ webview: {} } as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.deepEqual(syncedCollapsedStates, [{ dockerContainers: true }, {}]);
});

test('analyzePromptDashboardReview skips AI refresh while the AI widget is collapsed', async () => {
	let analyzeCalls = 0;
	const { manager } = await createManager();
	(manager as any).promptDashboardLayoutsState['two-columns'].collapsedSections = { aiAnalysis: true };
	(manager as any).promptDashboardService = {
		analyzeParallelReview: () => {
			analyzeCalls += 1;
			return Promise.resolve({ status: 'completed', model: 'copilot:gpt-5', content: 'ok' });
		},
		setDockerWidgetCollapsed: () => undefined,
	};

	await (manager as any).handleMessage(
		{
			type: 'analyzePromptDashboardReview',
			prompt: createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
			requestId: 'dashboard-ai-collapsed',
		} as any,
		{ webview: {} } as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.equal(analyzeCalls, 0);
});

test('savePromptDashboardSectionOrder persists the shared widget order in the host state service', async () => {
	const savedOrders: string[][][] = [];
	const { manager } = await createManager({
		stateService: {
			savePromptDashboardSectionOrder: async (order: string[][]) => {
				savedOrders.push(order.map(column => [...column]));
			},
		},
	});

	await (manager as any).handleMessage(
		{
			type: 'savePromptDashboardSectionOrder',
			order: [
				['aiAnalysis', 'activity', 'reviewRequests', 'projectCommits'],
				['status', 'projectBranches', 'parallelBranches'],
			],
		} as any,
		{ webview: {} } as any,
		createPrompt({ id: 'task-42', promptUuid: 'uuid-42' }),
		'panel-a',
		() => false,
		() => undefined,
	);

	assert.deepEqual(savedOrders, [[
		['aiAnalysis', 'activity', 'reviewRequests', 'projectCommits'],
		['status', 'projectBranches', 'parallelBranches'],
	]]);
	assert.deepEqual((manager as any).getPromptDashboardSectionOrder(), [
		['aiAnalysis', 'activity', 'reviewRequests', 'projectCommits', 'dockerContainers', 'quickCommands'],
		['status', 'projectBranches', 'parallelBranches', 'todos', 'quickNotes', 'bashScripts'],
	]);
});

test('runGitOverlayRefresh emits refresh timing metrics with snapshot source refresh', async () => {
	const { manager } = await createManager();
	const debugEvents: Array<{ event: string; payload?: Record<string, unknown> }> = [];
	const currentPrompt = createPrompt({
		projects: ['selected'],
		branch: 'feature/task-42',
	});

	(manager as any).logReportDebug = (event: string, payload?: Record<string, unknown>) => {
		debugEvents.push({ event, payload });
	};
	(manager as any).workspaceService = {
		getWorkspaceFolderPaths: () => new Map([
			['selected', '/tmp/selected'],
		]),
		getWorkspaceFolders: () => ['selected'],
	};
	const postMessage = () => undefined;
	(manager as any).gitOverlaySessions.set('panel-a', {
		active: true,
		promptBranch: 'feature/task-42',
		selectedProjects: ['selected'],
		snapshotProjects: ['selected'],
		snapshotVersion: 0,
		postMessage,
		refreshTimer: null,
		refreshInFlight: false,
		refreshQueued: false,
		queuedMode: null,
		queuedBusyReason: null,
	});
	(manager as any).gitService = {
		fetchProjects: async () => ({ success: true, errors: [], changedProjects: ['selected'], skippedProjects: [] }),
		getGitOverlaySnapshot: async () => ({
			generatedAt: '2026-04-24T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [createGitOverlayProjectSnapshot('selected')],
		}),
	};

	await (manager as any).runGitOverlayRefresh(
		'panel-a',
		postMessage,
		currentPrompt,
		'feature/task-42',
		['selected'],
		'fetch',
		false,
	);

	const snapshotMetric = debugEvents.find(item => item.event === 'gitOverlay.snapshot.computed');
	const refreshMetric = debugEvents.find(item => item.event === 'gitOverlay.refresh.completed');
	assert.ok(snapshotMetric);
	assert.ok(refreshMetric);
	assert.equal(snapshotMetric.payload?.source, 'refresh');
	assert.equal(refreshMetric.payload?.mode, 'fetch');
	assert.equal(typeof refreshMetric.payload?.durationMs, 'number');
	assert.equal(typeof refreshMetric.payload?.gitOperationDurationMs, 'number');
});

test('registerGitOverlayBuiltInRepositoryWatcher ignores noisy repository state changes', async () => {
	const { manager } = await createManager();
	const scheduledRefreshes: Array<{ reason: string; changedPath?: string }> = [];
	let stateSubscriptionCount = 0;
	let commitListener: (() => void) | undefined;
	let checkoutListener: (() => void) | undefined;

	(manager as any).scheduleGitOverlayAutoRefreshForActiveSessions = (reason: string, changedPath?: string) => {
		scheduledRefreshes.push({ reason, changedPath });
	};

	(manager as any).registerGitOverlayBuiltInRepositoryWatcher({
		rootUri: { fsPath: '/tmp/repo' },
		state: {
			onDidChange: () => {
				stateSubscriptionCount += 1;
				return createDisposable();
			},
		},
		onDidCommit: (listener: () => void) => {
			commitListener = listener;
			return createDisposable();
		},
		onDidCheckout: (listener: () => void) => {
			checkoutListener = listener;
			return createDisposable();
		},
	});

	assert.equal(stateSubscriptionCount, 0);
	assert.ok(commitListener);
	assert.ok(checkoutListener);

	commitListener?.();
	checkoutListener?.();

	assert.deepEqual(scheduledRefreshes, [
		{ reason: 'git', changedPath: '/tmp/repo' },
		{ reason: 'git', changedPath: '/tmp/repo' },
	]);
});

test('persistPromptSnapshotForSwitch keeps Description empty while still avoiding save-time AI waits', async () => {
	const { manager } = await createManager({
		generateTitle: async () => new Promise(resolve => setTimeout(() => resolve('AI title'), 40)),
		generateDescription: async () => new Promise(resolve => setTimeout(() => resolve('AI description'), 40)),
	});

	const snapshot = createPrompt({
		content: 'This prompt content is long enough to require generated metadata before chat starts.',
	});

	const result = await Promise.race([
		(manager as any).persistPromptSnapshotForSwitch(snapshot, null, '__prompt_editor_singleton__'),
		new Promise(resolve => setTimeout(() => resolve('timeout'), 10)),
	]);

	assert.notEqual(result, 'timeout');
	assert.equal(typeof (result as any).title, 'string');
	assert.notEqual(((result as any).title || '').trim(), '');
	assert.equal(((result as any).description || '').trim(), '');

	await new Promise(resolve => setTimeout(resolve, 60));
});

test('persistPromptSnapshotForSwitch preserves newer persisted status and report', async () => {
	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'prompt-a',
			status: 'in-progress',
			report: 'Persisted report',
			updatedAt: '2026-04-13T00:00:02.000Z',
		},
	});

	const baseSnapshot = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'prompt-a',
		status: 'draft',
		report: '',
		updatedAt: '2026-04-13T00:00:00.000Z',
	});
	const snapshot = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'prompt-a',
		status: 'draft',
		report: '',
		updatedAt: '2026-04-13T00:00:00.000Z',
	});

	const saved = await (manager as any).persistPromptSnapshotForSwitch(
		snapshot,
		baseSnapshot,
		'__prompt_editor_singleton__',
	);

	assert.equal(saved?.status, 'in-progress');
	assert.equal(saved?.report, 'Persisted report');
	assert.equal(getStoredPrompt()?.status, 'in-progress');
	assert.equal(getStoredPrompt()?.report, 'Persisted report');
});

test('savePrompt persists a detached stale save after the panel switches to another prompt', async () => {
	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
			content: 'Old content',
		},
	});

	const panelKey = '__prompt_editor_singleton__';
	const switchedPrompt = createPrompt({
		id: 'prompt-b',
		promptUuid: 'uuid-b',
		title: 'Prompt B',
		content: 'Other content',
	});
	(manager as any).panelPromptRefs.set(panelKey, switchedPrompt);

	const postedMessages: any[] = [];
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;

	await (manager as any).handleMessage(
		{
			type: 'savePrompt',
			source: 'manual',
			requestId: 'save-1',
			prompt: createPrompt({
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt A',
				content: 'Updated detached content',
			}),
		},
		panel,
		switchedPrompt,
		panelKey,
		() => false,
		() => undefined,
	);

	assert.equal(getStoredPrompt()?.content, 'Updated detached content');
	assert.ok(!postedMessages.some(message => (message as any)?.type === 'prompt' && (message as any)?.reason === 'save'));
});

/** Старая форма не может переименовать обратно завершённую папку или сделать её черновиком. */
test('late manual and status saves after rename leave the completed prompt and a reused folder intact', async () => {
	for (const source of ['manual', 'status-change']) {
		for (const reused of [false, true]) {
			const old = createPrompt({ id: 'draft', promptUuid: 'shared', title: 'Draft', status: 'draft' });
			const completed = createPrompt({ ...old, id: 'done', title: 'Done', status: 'completed', report: 'Full report' });
			const replacement = createPrompt({ id: 'draft', promptUuid: 'another', content: 'Unrelated' });
			const rows = new Map([[completed.id, completed]]);
			if (reused) { rows.set(replacement.id, replacement); }
			let writes = 0;
			const { manager, storageService } = await createManager({ initialPrompt: completed,
				savePrompt: async prompt => { writes++; return prompt; } });
			storageService.getPrompt = async id => rows.has(id) ? clonePrompt(rows.get(id)!) : null;
			const messages: any[] = [];
			const panel = { webview: { postMessage: async (message: unknown) => { messages.push(message); return true; } } };
			const key = '__prompt_editor_singleton__';
			(manager as any).panelPromptRefs.set(key, completed);
			try {
				await (manager as any).handleMessage({ type: 'savePrompt', source, prompt: old, requestId: 'old-save', localRevision: 66 },
					panel, completed, key, () => false, () => undefined);
				assert.equal(writes, 0);
				assert.equal(completed.id, 'done');
				assert.equal(completed.status, 'completed');
				assert.equal(completed.report, 'Full report');
				assert.equal(replacement.content, 'Unrelated');
				assert.ok(messages.some(message => message.type === 'error' && message.requestId === 'old-save'));
				assert.equal(messages.some(message => message.type === 'promptSaved'), false);
				assert.equal((manager as any).pendingSaveQueue.size, 0);
				assert.equal((manager as any).getPanelLatestLocalPromptRevision(key), 0);
			} finally { manager.disposeAll(); }
		}
	}
});

/** Изменение существующей копии сохраняется по её собственному пути; новый промпт может получить первый id. */
test('savePrompt keeps the original folder for separate copies and a fresh rename, and supports first save', async () => {
	for (const mode of ['copy', 'rename', 'new']) {
		const current = createPrompt({ id: mode === 'new' ? '' : 'main', title: 'Main', promptUuid: 'shared' });
		const id = mode === 'copy' ? 'copy' : current.id;
		const form = createPrompt({ id, promptUuid: current.promptUuid, title: mode === 'copy' ? 'Copy' : 'Next' });
		const writes: Array<{ id: string; previous?: string }> = [];
		const { manager, storageService } = await createManager({ initialPrompt: current,
			savePrompt: async (saved, options) => { writes.push({ id: saved.id, previous: options.previousId }); return saved; } });
		storageService.getPrompt = async requested => requested === id && id ? clonePrompt(form) : null;
		const messages: any[] = [];
		const panel = { webview: { postMessage: async (message: unknown) => { messages.push(message); return true; } } };
		const key = '__prompt_editor_singleton__';
		(manager as any).panelPromptRefs.set(key, current);
		try {
			await (manager as any).handleMessage({ type: 'savePrompt', source: 'manual', prompt: form, requestId: mode },
				panel, current, key, () => false, () => undefined);
			assert.deepEqual(writes, [{ id: mode === 'copy' ? 'copy' : 'next', previous: id || undefined }]);
			assert.equal(messages.some(message => message.type === 'promptSaved'), mode !== 'copy');
			assert.equal(current.id, mode === 'copy' ? 'main' : 'next');
		} finally { manager.disposeAll(); }
	}
});

/** Ручная отмена правки сохраняется после переименования, смены статуса и сбоя промежуточной записи. */
test('queued saves preserve both a stale status change and an explicit undo after rename or first save', async () => {
	for (const oldId of ['old', '']) {
		const entered = createDeferred<void>();
		const release = createDeferred<void>();
		const original = createPrompt({ id: oldId, promptUuid: 'same', title: 'Old', content: 'Original', status: 'draft' });
		const writes: Array<{ id: string; previous?: string; title: string; content: string; status: string; notes: string }> = [];
		let rejected = 0;
		const { manager } = await createManager({ initialPrompt: oldId ? original : undefined,
			savePrompt: async (saved, options) => {
				if (saved.notes === 'fail once') { rejected++; throw new Error('write failed'); }
				writes.push({ id: saved.id, previous: options.previousId, title: saved.title, content: saved.content,
					status: saved.status, notes: saved.notes });
				if (writes.length === 1) { entered.resolve(); await release.promise; }
				return clonePrompt(saved);
			} });
		const key = '__prompt_editor_singleton__';
		(manager as any).panelPromptRefs.set(key, original);
		(manager as any).panelBasePrompts.set(key, clonePrompt(original));
		(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
		const panel = { webview: { postMessage: async () => true } };
		let revision = 0;
		const send = (source: string, prompt: any) => (manager as any).handleMessage(
			{ type: 'savePrompt', source, prompt, requestId: String(++revision), localRevision: revision },
			panel, original, key, () => false, () => undefined,
		);
		try {
			const rename = send('manual', { ...original, title: 'Next', content: 'New contents' });
			await entered.promise;
			const status = send('status-change', { ...original, status: 'review' });
			const undone = { ...original, title: 'Next', status: 'review' };
			const failed = send('manual', { ...undone, notes: 'fail once' });
			const undo = send('manual', undone);
			const next = send('autosave', { ...undone, notes: 'new note' });
			release.resolve();
			await Promise.all([rename, status, failed, undo, next]);
			assert.equal(rejected, 1);
			assert.deepEqual(writes, [
				{ id: 'next', previous: oldId || undefined, title: 'Next', content: 'New contents', status: 'draft', notes: '' },
				{ id: 'next', previous: 'next', title: 'Next', content: 'New contents', status: 'review', notes: '' },
				{ id: 'next', previous: 'next', title: 'Next', content: 'Original', status: 'review', notes: '' },
				{ id: 'next', previous: 'next', title: 'Next', content: 'Original', status: 'review', notes: 'new note' },
			]);
		} finally { release.resolve(); manager.disposeAll(); }
	}
});

test('savePrompt serializes overlapping saves for the same prompt', async () => {
	const firstSave = createDeferred<any>();
	const secondSave = createDeferred<any>();
	const saveCalls: string[] = [];
	let saveCallCount = 0;

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
			content: 'Initial content',
		},
		savePrompt: async (prompt: any) => {
			saveCallCount += 1;
			saveCalls.push(prompt.content);
			if (saveCallCount === 1) {
				return firstSave.promise;
			}
			return secondSave.promise;
		},
	});

	const panelKey = '__prompt_editor_singleton__';
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt A',
		content: 'Initial content',
	});
	(manager as any).panelPromptRefs.set(panelKey, currentPrompt);

	const panel = {
		webview: {
			postMessage: async () => true,
		},
	} as any;

	const firstTask = (manager as any).handleMessage(
		{
			type: 'savePrompt',
			source: 'manual',
			requestId: 'save-1',
			prompt: createPrompt({
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt A',
				content: 'First content',
			}),
		},
		panel,
		currentPrompt,
		panelKey,
		() => false,
		() => undefined,
	);

	await flushTurns(1);

	const secondTask = (manager as any).handleMessage(
		{
			type: 'savePrompt',
			source: 'manual',
			requestId: 'save-2',
			prompt: createPrompt({
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt A',
				content: 'Second content',
			}),
		},
		panel,
		currentPrompt,
		panelKey,
		() => false,
		() => undefined,
	);

	await flushTurns(2);
	assert.deepEqual(saveCalls, ['First content']);

	firstSave.resolve(createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt A',
		content: 'First content',
		updatedAt: '2026-04-13T00:00:01.000Z',
	}));

	await flushTurns(2);
	assert.deepEqual(saveCalls, ['First content', 'Second content']);

	secondSave.resolve(createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt A',
		content: 'Second content',
		updatedAt: '2026-04-13T00:00:02.000Z',
	}));

	await Promise.all([firstTask, secondTask]);

	assert.equal(getStoredPrompt()?.content, 'Second content');
});

test('savePrompt keeps a newer dirty snapshot when it arrives during an in-flight save', async () => {
	resetVsCodeCommandMock();
	const deferredSave = createDeferred<any>();
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt A',
			content: 'Initial content',
		},
		savePrompt: async (prompt: any) => {
			await deferredSave.promise;
			return createPrompt({
				...prompt,
				updatedAt: '2026-04-13T00:00:02.000Z',
			});
		},
	});

	const panelKey = '__prompt_editor_singleton__';
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt A',
		content: 'Initial content',
	});
	(manager as any).panelPromptRefs.set(panelKey, currentPrompt);
	(manager as any).panelBasePrompts.set(panelKey, clonePrompt(currentPrompt));
	(manager as any).panelLatestLocalPromptRevisions = new Map<string, number>();

	const savePromise = (manager as any).handleMessage(
		{
			type: 'savePrompt',
			source: 'manual',
			requestId: 'save-keep-newer-local',
			localRevision: 1,
			prompt: createPrompt({
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt A',
				content: 'Saved content',
			}),
		},
		{ visible: true, webview: { postMessage: async () => true } } as any,
		currentPrompt,
		panelKey,
		() => false,
		() => undefined,
	);

	await flushTurns(2);

	(manager as any).panelDirtyFlags.set(panelKey, true);
	(manager as any).panelLatestPromptSnapshots.set(panelKey, createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt A',
		content: 'Newer local content',
	}));
	(manager as any).panelLatestLocalPromptRevisions.set(panelKey, 2);

	deferredSave.resolve(createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt A',
		content: 'Saved content',
		updatedAt: '2026-04-13T00:00:02.000Z',
	}));

	await savePromise;

	assert.equal(currentPrompt.content, 'Saved content');
	assert.equal((manager as any).panelDirtyFlags.get(panelKey), true);
	assert.equal((manager as any).panelLatestPromptSnapshots.get(panelKey)?.content, 'Newer local content');
	assert.equal((manager as any).panelBasePrompts.get(panelKey)?.content, 'Saved content');
});

/** Проверяет сохранение Quick Add и последующее фоновое обогащение названия. */
test('createQuickAddPrompt stores input as content and only enriches title in background', async () => {
	const content = [
		'Нужно реализовать быстрый сценарий создания промпта из сырого текста.',
		'Заголовок больше не обязан ждать ручного описания перед первым сохранением.',
	].join(' ');
	const aiStates: Array<{ promptId: string; title: boolean; description: boolean }> = [];
	const { manager, getStoredPrompt } = await createManager({
		generateTitle: async () => 'AI generated title',
		generateDescription: async () => 'AI generated description',
		configurationValues: {
			'promptManager.ai.enabled': true,
		},
	});

	manager.onDidPromptAiEnrichmentStateChange((state) => {
		aiStates.push(state);
	});

	const saved = await manager.createQuickAddPrompt(content);

	assert.equal(saved?.content, content);
	assert.ok((saved?.title || '').trim().length > 0);
	assert.equal((saved?.description || '').trim(), '');
	assert.equal(getStoredPrompt()?.content, content);
	assert.ok(aiStates.some(state => state.title && !state.description));

	await new Promise(resolve => setTimeout(resolve, 0));
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.equal(getStoredPrompt()?.title, 'AI generated title');
	assert.equal((getStoredPrompt()?.description || '').trim(), '');
	assert.ok(aiStates.some(state => !state.title && !state.description));
});

/** Проверяет локальное название без планирования фонового запроса при выключенной настройке. */
test('createQuickAddPrompt keeps fallback title without background generation when disabled', async () => {
	let generateTitleCalls = 0;
	const enrichmentStates: Array<{ title: boolean; description: boolean }> = [];
	const content = 'Нужно сохранить локальное название и не запускать фоновый запрос для выключенной настройки.';
	const { manager, getStoredPrompt } = await createManager({
		generateTitle: async () => {
			generateTitleCalls += 1;
			return 'Generated title';
		},
		configurationValues: {
			'promptManager.ai.enabled': false,
		},
	});
	manager.onDidPromptAiEnrichmentStateChange(state => enrichmentStates.push(state));

	const saved = await manager.createQuickAddPrompt(content);
	await flushTurns(2);

	assert.ok((saved?.title || '').trim());
	assert.equal(getStoredPrompt()?.title, saved?.title);
	assert.equal(generateTitleCalls, 0);
	assert.equal(enrichmentStates.some(state => state.title || state.description), false);
	assert.equal((manager as any).pendingEnrichmentPromptKeys.size, 0);
});

/** Проверяет удаление устаревшего pending-признака перед ready-ответом. */
test('consumePendingReadyPromptMessage removes stale enrichment state', async () => {
	const { manager } = await createManager();
	const panelKey = '__prompt_editor_singleton__';
	(manager as any).panelPromptRefs.set(panelKey, createPrompt({
		id: 'prompt-final',
		promptUuid: 'uuid-a',
		title: 'Итоговое название',
	}));
	(manager as any).pendingReadyPromptMessages.set(panelKey, {
		type: 'prompt',
		prompt: createPrompt({ id: 'prompt-stale', promptUuid: 'uuid-a', title: 'Старое название' }),
		reason: 'open',
		aiEnrichment: { title: true, description: false },
	});

	const message = (manager as any).consumePendingReadyPromptMessage(panelKey);

	assert.equal(message?.type, 'prompt');
	assert.equal('aiEnrichment' in message, false);
	assert.equal(message?.prompt?.id, 'prompt-final');
	assert.equal(message?.prompt?.title, 'Итоговое название');
});

/** Проверяет добавление активного pending-состояния в ready-ответ. */
test('consumePendingReadyPromptMessage adds active enrichment state', async () => {
	const { manager } = await createManager();
	const panelKey = '__prompt_editor_singleton__';
	const prompt = createPrompt({ id: 'prompt-a', promptUuid: 'uuid-a' });
	(manager as any).setPendingPromptAiEnrichmentState(prompt.id, prompt.promptUuid, {
		title: true,
		description: false,
	});
	(manager as any).pendingReadyPromptMessages.set(panelKey, {
		type: 'prompt',
		prompt,
		reason: 'open',
	});

	const message = (manager as any).consumePendingReadyPromptMessage(panelKey);

	assert.deepEqual(message?.aiEnrichment, { title: true, description: false });
});

/** Проверяет доставку через ключ актуальной панели и обязательный завершающий false. */
test('scheduleBackgroundAiEnrichment posts full prompt and terminal state to current panel', async () => {
	const content = 'Нужно проверить доставку результата после закрытия и повторного открытия панели редактора промпта.';
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: '',
			content,
		},
		generateTitle: async () => 'Generated title',
	});
	const panelKey = '__prompt_editor_singleton__';
	const events: Array<{ panelKey: string; message?: any; type: 'message' | 'sync' }> = [];
	const enrichmentStates: Array<{ promptId: string; title: boolean; description: boolean }> = [];
	(manager as any).storageService.uniqueId = async (requestedIdBase: string) => requestedIdBase;
	manager.onDidPromptAiEnrichmentStateChange(state => enrichmentStates.push(state));
	(manager as any).panelPromptRefs.set(panelKey, createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: '',
		content,
	}));
	(manager as any).postMessageToCurrentPanel = async (targetPanelKey: string, message: any) => {
		events.push({ panelKey: targetPanelKey, message, type: 'message' });
		return true;
	};
	(manager as any).syncTrackedPromptFilesForPanel = async () => {
		events.push({ panelKey, type: 'sync' });
	};

	await (manager as any).scheduleBackgroundAiEnrichment(
		'prompt-a',
		'uuid-a',
		content,
		true,
		false,
		panelKey,
	);

	const fullPromptIndex = events.findIndex(event => (
		event.message?.type === 'prompt' && event.message?.reason === 'ai-enrichment'
	));
	const syncIndex = events.findIndex(event => event.type === 'sync');
	const terminalStateIndexes = events.flatMap((event, index) => (
		index > fullPromptIndex
		&& event.message?.type === 'promptAiEnrichmentState'
		&& !event.message.title
		&& !event.message.description
			? [index]
			: []
	));
	assert.ok(events.every(event => event.panelKey === panelKey));
	assert.ok(events.some(event => event.message?.type === 'promptAiEnrichmentState' && event.message.title));
	assert.ok(fullPromptIndex >= 0);
	assert.ok(syncIndex > fullPromptIndex);
	assert.equal(terminalStateIndexes.length, 1);
	assert.ok((terminalStateIndexes[0] ?? -1) > fullPromptIndex);
	assert.ok((terminalStateIndexes[0] ?? Number.MAX_SAFE_INTEGER) < syncIndex);
	assert.equal(enrichmentStates[0]?.promptId, 'prompt-a');
	assert.equal(enrichmentStates[enrichmentStates.length - 1]?.promptId, 'prompt-a');
	assert.equal((manager as any).pendingPromptAiEnrichmentStates.size, 0);
	assert.equal((manager as any).pendingEnrichmentPromptKeys.size, 0);
});

/** Проверяет, что завершённый старый запуск не очищает состояние нового во время синхронизации. */
test('background title lifecycle finishes before optional tracked file sync', async () => {
	const content = 'Нужно проверить независимое завершение двух последовательных фоновых операций названия промпта.';
	const secondGeneratedTitle = createDeferred<string>();
	const firstSyncStarted = createDeferred<void>();
	const releaseFirstSync = createDeferred<void>();
	let generateTitleCalls = 0;
	let syncCalls = 0;
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: '',
			content,
		},
		generateTitle: async () => {
			generateTitleCalls += 1;
			return generateTitleCalls === 1 ? 'Первое итоговое название' : secondGeneratedTitle.promise;
		},
	});
	const panelKey = '__prompt_editor_singleton__';
	(manager as any).panelPromptRefs.set(panelKey, createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: '',
		content,
	}));
	(manager as any).postMessageToCurrentPanel = async () => true;
	(manager as any).syncTrackedPromptFilesForPanel = async () => {
		syncCalls += 1;
		if (syncCalls === 1) {
			firstSyncStarted.resolve();
			await releaseFirstSync.promise;
		}
	};

	const firstOperation = (manager as any).scheduleBackgroundAiEnrichment(
		'prompt-a',
		'uuid-a',
		content,
		true,
		false,
		panelKey,
	);
	await firstSyncStarted.promise;
	const secondOperation = (manager as any).scheduleBackgroundAiEnrichment(
		'prompt-a',
		'uuid-a',
		content,
		true,
		false,
		panelKey,
	);
	assert.equal((manager as any).pendingPromptAiEnrichmentStates.get('uuid:uuid-a')?.title, true);

	releaseFirstSync.resolve();
	await firstOperation;
	assert.equal((manager as any).pendingPromptAiEnrichmentStates.get('uuid:uuid-a')?.title, true);
	assert.equal((manager as any).pendingEnrichmentPromptKeys.has('uuid:uuid-a'), true);

	secondGeneratedTitle.resolve('Второе итоговое название');
	await secondOperation;
	assert.equal((manager as any).pendingPromptAiEnrichmentStates.size, 0);
	assert.equal((manager as any).pendingEnrichmentPromptKeys.size, 0);
});

/** Проверяет запрет отложенной записи и событий завершения после остановки manager. */
test('background title lifecycle stops before persistence during shutdown', async () => {
	const generatedTitle = createDeferred<string>();
	const states: Array<{ title: boolean; description: boolean }> = [];
	let savePromptCalls = 0;
	const content = 'Нужно проверить остановку фонового названия без записи после завершения работы расширения.';
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: '',
			content,
		},
		generateTitle: async () => generatedTitle.promise,
		savePrompt: async prompt => {
			savePromptCalls += 1;
			return prompt;
		},
	});
	manager.onDidPromptAiEnrichmentStateChange(state => states.push(state));

	const operation = (manager as any).scheduleBackgroundAiEnrichment(
		'prompt-a',
		'uuid-a',
		content,
		true,
		false,
		'__prompt_editor_singleton__',
	);
	await flushTurns(1);
	manager.prepareForShutdown();
	generatedTitle.resolve('Итоговое название');
	await operation;

	assert.equal(savePromptCalls, 0);
	assert.equal(states.length, 1);
	assert.equal(states[0]?.title, true);
	assert.equal((manager as any).pendingPromptAiEnrichmentStates.size, 0);
	assert.equal((manager as any).pendingEnrichmentPromptKeys.size, 0);
});

/** Проверяет доставку результата в новую singleton-панель после закрытия исходного окна. */
test('background title completion reaches the reopened singleton panel', async () => {
	resetVsCodeCommandMock();
	const generatedTitle = createDeferred<string>();
	const activeState = createDeferred<void>();
	const terminalState = createDeferred<void>();
	const content = 'Нужно проверить завершение фонового названия после закрытия и повторного открытия окна промпта.';
	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-reopened-title',
			title: '',
			content,
		},
		generateTitle: async () => generatedTitle.promise,
		configurationValues: {
			'promptManager.ai.enabled': true,
		},
	});
	(manager as any).storageService.uniqueId = async (requestedIdBase: string) => requestedIdBase;
	let enrichmentStarted = false;
	manager.onDidPromptAiEnrichmentStateChange((state) => {
		if (state.title) {
			enrichmentStarted = true;
			activeState.resolve();
		}
		if (enrichmentStarted && !state.title && !state.description) {
			terminalState.resolve();
		}
	});

	await manager.openPrompt('prompt-a');
	const disposedPanel = vscodeCreatedWebviewPanels[0];
	assert.ok(disposedPanel);
	await disposedPanel.emitMessage({
		type: 'savePrompt',
		source: 'manual',
		requestId: 'save-before-reopen',
		prompt: createPrompt({
			id: 'prompt-a',
			promptUuid: 'uuid-reopened-title',
			title: '',
			content,
		}),
	});
	await activeState.promise;

	const fallbackPromptId = getStoredPrompt()?.id;
	assert.ok(fallbackPromptId);
	disposedPanel.dispose();
	await flushTurns(2);
	await manager.openPrompt(fallbackPromptId);
	const reopenedPanel = vscodeCreatedWebviewPanels[1];
	assert.ok(reopenedPanel);
	reopenedPanel.postedMessages.length = 0;
	let acceptsMessages = false;
	reopenedPanel.webview.postMessage = async (message: any) => {
		if (!acceptsMessages) {
			return false;
		}
		reopenedPanel.postedMessages.push(message);
		return true;
	};
	let disposedCompletionMessages = 0;
	disposedPanel.webview.postMessage = async (message: any) => {
		if (message?.type === 'promptAiEnrichmentState' || message?.reason === 'ai-enrichment') {
			disposedCompletionMessages += 1;
		}
		return false;
	};

	generatedTitle.resolve('Итоговое название промпта');
	await terminalState.promise;
	await flushTurns(3);
	acceptsMessages = true;
	const reopenedBootId = (manager as any).panelBootIds.get('__prompt_editor_singleton__');
	assert.ok(reopenedBootId);
	await reopenedPanel.emitMessage({
		type: 'ready',
		bootId: reopenedBootId,
		assetVersion: EDITOR_WEBVIEW_ASSET_VERSION,
	});

	const fullPromptMessage = reopenedPanel.postedMessages.find((message: any) => (
		message?.type === 'prompt' && message?.reason === 'open'
	)) as any;
	assert.ok(fullPromptMessage);
	assert.equal(fullPromptMessage?.prompt?.promptUuid, 'uuid-reopened-title');
	assert.equal(fullPromptMessage?.prompt?.title, 'Итоговое название промпта');
	assert.notEqual(fullPromptMessage?.prompt?.id, fallbackPromptId);
	assert.equal('aiEnrichment' in fullPromptMessage, false);
	assert.equal(disposedCompletionMessages, 0);
	reopenedPanel.dispose();
});

/** Проверяет перенос последних сохраненных настроек чата в быстрый новый промпт. */
test('createQuickAddPrompt reuses the latest saved chat defaults by updatedAt', async () => {
	const { manager, getStoredPrompt } = await createManager({
		listPrompts: [
			{
				// The newest config is first so array order cannot accidentally drive recent defaults.
				id: 'prompt-new',
				promptUuid: 'uuid-new',
				model: ' copilot/claude-sonnet-4 ',
				chatTarget: 'kilo',
				chatMode: 'plan',
				autoStartChat: false,
				autoStartChatWithXdotool: true,
				taskNumber: '161',
				branch: 'feature/should-not-copy',
				trackedBranch: 'main',
				updatedAt: '2026-04-13T00:00:00.000Z',
			},
			{
				id: 'prompt-old',
				promptUuid: 'uuid-old',
				model: 'copilot/gpt-4o',
				chatTarget: 'copilot',
				chatMode: 'agent',
				autoStartChatWithXdotool: false,
				updatedAt: '2026-04-11T00:00:00.000Z',
			},
		],
	});

	const saved = await manager.createQuickAddPrompt('Быстро создать новый промпт из буфера обмена.');

	assert.equal(saved?.model, 'copilot/claude-sonnet-4');
	assert.equal(saved?.chatTarget, 'kilo');
	assert.equal(saved?.chatMode, 'plan');
	assert.equal(saved?.autoStartChat, false);
	assert.equal(saved?.autoStartChatWithXdotool, true);
	assert.equal(saved?.taskNumber, '');
	assert.equal(saved?.branch, '');
	assert.equal(saved?.trackedBranch, '');
	assert.equal(getStoredPrompt()?.model, 'copilot/claude-sonnet-4');
	assert.equal(getStoredPrompt()?.chatTarget, 'kilo');
	assert.equal(getStoredPrompt()?.chatMode, 'plan');
	assert.equal(getStoredPrompt()?.autoStartChat, false);
	assert.equal(getStoredPrompt()?.autoStartChatWithXdotool, true);
});

/** Verify that invalid legacy chat-launch fields cannot overwrite new-prompt defaults. */
test('openPrompt new draft keeps default chat values for legacy optional prompt config', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager({
		listPrompts: [
			{
				// Legacy optional chat fields must leave createDefaultPrompt defaults untouched.
				id: 'prompt-legacy',
				promptUuid: 'uuid-legacy',
				model: undefined,
				chatTarget: undefined,
				chatMode: 'legacy-plan',
				autoStartChatWithXdotool: 'true',
				updatedAt: '2026-04-13T00:00:00.000Z',
			},
			{
				id: 'prompt-valid-old',
				promptUuid: 'uuid-valid-old',
				model: 'copilot/gpt-4o',
				chatTarget: 'codex',
				chatMode: 'plan',
				autoStartChatWithXdotool: true,
				updatedAt: '2026-04-11T00:00:00.000Z',
			},
		],
	});

	await (manager as any).openPrompt('');
	const panel = (manager as any).resolveOpenEditorPanel('__prompt_editor_singleton__');
	assert.ok(panel);

	const bootId = (manager as any).panelBootIds.get('__prompt_editor_singleton__');
	await panel.emitMessage({ type: 'ready', bootId, assetVersion: EDITOR_WEBVIEW_ASSET_VERSION });

	const promptMessage = panel.postedMessages.find((message: any) => message?.type === 'prompt') as any;
	assert.equal(promptMessage?.prompt?.model, '');
	assert.equal(promptMessage?.prompt?.chatTarget, 'copilot');
	assert.equal(promptMessage?.prompt?.chatMode, 'agent');
	assert.equal(promptMessage?.prompt?.autoStartChatWithXdotool, false);
	panel.dispose();
});

test('resolvePromptIdBase ignores report-only fallback', async () => {
	const { manager } = await createManager();

	assert.equal(
		(manager as any).resolvePromptIdBase({
			taskNumber: '77',
			title: '',
			description: '',
			content: '',
			report: 'Filled report should not affect prompt id',
		}),
		undefined,
	);
});

test('resolveStartChatFailureRecovery keeps started state after persistence or dispatch', async () => {
	const { EditorPanelManager } = await importEditorPanelManager();

	assert.equal(
		(EditorPanelManager as any).resolveStartChatFailureRecovery({
			startStatePersisted: false,
			chatMessageDispatched: false,
		}),
		'restore',
	);
	assert.equal(
		(EditorPanelManager as any).resolveStartChatFailureRecovery({
			startStatePersisted: true,
			chatMessageDispatched: false,
		}),
		'keep-started',
	);
	assert.equal(
		(EditorPanelManager as any).resolveStartChatFailureRecovery({
			startStatePersisted: false,
			chatMessageDispatched: true,
		}),
		'keep-started',
	);
});

test('shouldFinalizeTrackedChatCompletion requires a confirmed session binding', async () => {
	const { EditorPanelManager } = await importEditorPanelManager();

	assert.equal(
		(EditorPanelManager as any).shouldFinalizeTrackedChatCompletion({
			sessionBindingSucceeded: false,
			trackedSessionId: 'session-1',
			completionSessionId: 'session-1',
		}),
		false,
	);
	assert.equal(
		(EditorPanelManager as any).shouldFinalizeTrackedChatCompletion({
			sessionBindingSucceeded: true,
			trackedSessionId: '',
			completionSessionId: '',
		}),
		false,
	);
	assert.equal(
		(EditorPanelManager as any).shouldFinalizeTrackedChatCompletion({
			sessionBindingSucceeded: true,
			trackedSessionId: 'session-1',
			completionSessionId: '',
		}),
		true,
	);
});

test('openChat opens the validated stored session instead of a stale UI session id', async () => {
	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			status: 'draft',
			chatSessionIds: ['session-fresh'],
		},
		stateService: {
			hasChatSession: async (sessionId: string) => sessionId === 'session-fresh',
		},
	});
	const postedMessages: any[] = [];
	let openedSessionId = '';
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	};
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		status: 'draft',
		chatSessionIds: ['session-stale'],
	});

	(manager as any).openBoundChatSession = async (sessionId: string) => {
		openedSessionId = sessionId;
		return true;
	};

	await (manager as any).handleMessage(
		{ type: 'openChat', id: 'prompt-a', sessionId: 'session-stale' },
		panel as any,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.equal(openedSessionId, 'session-fresh');
	assert.deepEqual(getStoredPrompt()?.chatSessionIds, ['session-fresh']);
	assert.deepEqual(currentPrompt.chatSessionIds, ['session-fresh']);
	assert.ok(postedMessages.some(message => (message as any)?.type === 'prompt'));
	assert.ok(postedMessages.some(message => (message as any)?.type === 'chatOpened'));
});

test('openChat resolves the stored session even when the UI no longer has a session id', async () => {
	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			status: 'in-progress',
			chatSessionIds: ['session-fresh'],
		},
		stateService: {
			hasChatSession: async (sessionId: string) => sessionId === 'session-fresh',
		},
	});
	const postedMessages: any[] = [];
	let openedSessionId = '';
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	};
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		status: 'in-progress',
		chatSessionIds: [],
	});

	(manager as any).openBoundChatSession = async (sessionId: string) => {
		openedSessionId = sessionId;
		return true;
	};

	await (manager as any).handleMessage(
		{ type: 'openChat', id: 'prompt-a', sessionId: '' },
		panel as any,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.equal(openedSessionId, 'session-fresh');
	assert.deepEqual(getStoredPrompt()?.chatSessionIds, ['session-fresh']);
	assert.ok(postedMessages.some(message => (message as any)?.type === 'chatOpened'));
});

test('openChat reports an error instead of opening an empty chat when all stored sessions are stale', async () => {
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			status: 'in-progress',
			chatSessionIds: ['session-stale'],
		},
		stateService: {
			hasChatSession: async () => false,
		},
	});
	const postedMessages: any[] = [];
	let openCalls = 0;
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	};
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		status: 'in-progress',
		chatSessionIds: ['session-stale'],
	});

	(manager as any).openBoundChatSession = async () => {
		openCalls += 1;
		return true;
	};

	await (manager as any).handleMessage(
		{ type: 'openChat', id: 'prompt-a', sessionId: 'session-stale' },
		panel as any,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.equal(openCalls, 0);
	assert.ok(
		postedMessages.some(message =>
			(message as any)?.type === 'error'
			&& String((message as any)?.message || '').includes('Не удалось открыть привязанный чат')),
	);
});

test('openBoundChatSession accepts a direct session-resource open without falling back to generic chat commands', async () => {
	resetVsCodeCommandMock();
	vscodeExecuteCommandHandler = async (id: string) => {
		if (id === 'vscode.open') {
			return undefined;
		}

		throw new Error(`Unexpected command: ${id}`);
	};

	const { manager } = await createManager();
	const opened = await (manager as any).openBoundChatSession('session-fresh');

	assert.equal(opened, true);
	assert.deepEqual(vscodeCommandCalls.map(call => call.id), ['vscode.open']);
	assert.match(
		String((vscodeCommandCalls[0]?.args[0] as { toString?: () => string })?.toString?.() || ''),
		/^vscode-chat-session:\/\/local\//,
	);
	resetVsCodeCommandMock();
});

test('openBoundChatSession stops after a direct open failure instead of opening a generic empty chat', async () => {
	resetVsCodeCommandMock();
	vscodeExecuteCommandHandler = async (id: string) => {
		if (id === 'vscode.open') {
			throw new Error('direct open failed');
		}

		throw new Error(`Unexpected command: ${id}`);
	};

	const { manager } = await createManager();
	const opened = await (manager as any).openBoundChatSession('session-fresh');

	assert.equal(opened, false);
	assert.deepEqual(vscodeCommandCalls.map(call => call.id), ['vscode.open']);
	resetVsCodeCommandMock();
});

test('stopChat focuses the bound session before canceling the running agent request', async () => {
	resetVsCodeCommandMock();
	vscodeAvailableCommands = ['workbench.action.chat.cancel'];
	vscodeExecuteCommandHandler = async (id: string) => {
		if (id === 'vscode.open' || id === 'workbench.action.chat.cancel') {
			return undefined;
		}

		throw new Error(`Unexpected command: ${id}`);
	};

	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			status: 'in-progress',
			chatSessionIds: ['session-fresh'],
		},
		stateService: {
			hasChatSession: async (sessionId: string) => sessionId === 'session-fresh',
		},
	});

	await (manager as any).handleMessage(
		{ type: 'stopChat', id: 'prompt-a' },
		{ webview: { postMessage: async () => true } } as any,
		createPrompt({
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			status: 'in-progress',
			chatSessionIds: ['session-fresh'],
		}),
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.deepEqual(vscodeCommandCalls.map(call => call.id), ['vscode.open', 'workbench.action.chat.cancel']);
	assert.match(
		String((vscodeCommandCalls[0]?.args[0] as { toString?: () => string })?.toString?.() || ''),
		/^vscode-chat-session:\/\/local\//,
	);
	resetVsCodeCommandMock();
});

test('resolvePromptForChatSessionRename falls back to promptUuid when the prompt id has changed', async () => {
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-b',
			promptUuid: 'uuid-a',
			title: 'Renamed prompt',
			taskNumber: '77',
		},
	});

	const resolved = await (manager as any).resolvePromptForChatSessionRename({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Old prompt',
		taskNumber: '',
	});

	assert.equal(resolved?.id, 'prompt-b');
	assert.equal(resolved?.title, 'Renamed prompt');
	assert.equal(resolved?.taskNumber, '77');
});

test('savePrompt schedules bound chat session rename when the saved prompt title changes', async () => {
	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Old prompt',
			chatSessionIds: ['session-fresh', 'session-stale'],
		},
		stateService: {
			hasChatSession: async (sessionId: string) => sessionId === 'session-fresh',
		},
	});

	const scheduledRenames: Array<{
		sessionId: string;
		prompt: any;
		logSuffix: string;
		options?: { notifyOnSuccess?: boolean };
	}> = [];
	(manager as any).scheduleChatSessionRename = async (
		sessionId: string,
		prompt: any,
		logSuffix: string = '',
		options?: { notifyOnSuccess?: boolean },
	) => {
		scheduledRenames.push({ sessionId, prompt, logSuffix, options });
	};

	const postedMessages: any[] = [];
	const panelKey = '__prompt_editor_singleton__';
	const panel = {
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Old prompt',
		chatSessionIds: ['session-fresh', 'session-stale'],
	});
	(manager as any).panelPromptRefs.set(panelKey, currentPrompt);

	await (manager as any).handleMessage(
		{
			type: 'savePrompt',
			source: 'manual',
			prompt: createPrompt({
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'New prompt title',
				chatSessionIds: ['session-fresh', 'session-stale'],
			}),
		},
		panel,
		currentPrompt,
		panelKey,
		() => false,
		() => undefined,
	);

	await new Promise(resolve => setTimeout(resolve, 0));

	assert.equal(getStoredPrompt()?.title, 'New prompt title');
	assert.deepEqual(scheduledRenames.map(item => item.sessionId), ['session-fresh']);
	assert.equal(scheduledRenames[0]?.prompt?.id, 'prompt-a');
	assert.equal(scheduledRenames[0]?.prompt?.promptUuid, 'uuid-a');
	assert.equal(scheduledRenames[0]?.prompt?.title, 'New prompt title');
	assert.equal(scheduledRenames[0]?.options?.notifyOnSuccess, true);
});

test('tryRefreshChatSessionTitleInUi dispatches the built-in panel prompt command for local sessions', async () => {
	resetVsCodeCommandMock();
	vscodeAvailableCommands = ['workbench.action.chat.openSessionWithPrompt.local'];

	const { manager } = await createManager();
	const refreshed = await (manager as any).tryRefreshChatSessionTitleInUi(
		'session-fresh',
		'77 | Renamed prompt',
	);

	assert.equal(refreshed, true);
	assert.deepEqual(vscodeCommandCalls.map(call => call.id), ['workbench.action.chat.openSessionWithPrompt.local']);
	assert.equal((vscodeCommandCalls[0]?.args[0] as { prompt?: string })?.prompt, '/rename 77 | Renamed prompt');
	assert.match(
		String((vscodeCommandCalls[0]?.args[0] as { resource?: { toString?: () => string } })?.resource?.toString?.() || ''),
		/^vscode-chat-session:\/\/local\//,
	);
	resetVsCodeCommandMock();
});

test('scheduleChatSessionRename keeps retrying live refresh after the title patch is already persisted', async () => {
	resetVsCodeCommandMock();
	const renameCalls: string[] = [];
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			taskNumber: '77',
		},
		stateService: {
			renameChatSession: async (_sessionId: string, newTitle: string) => {
				renameCalls.push(newTitle);
				return { ok: true, reason: 'persisted' };
			},
		},
	});

	const liveRefreshCalls: string[] = [];
	(manager as any).tryRefreshChatSessionTitleInUi = async (_sessionId: string, title: string) => {
		liveRefreshCalls.push(title);
		return true;
	};

	await (manager as any).scheduleChatSessionRename(
		'session-fresh',
		createPrompt({
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			taskNumber: '77',
		}),
		' (bind)',
		{
			notifyOnSuccess: false,
			attemptDelaysMs: [0, 1, 1],
			keepRetryingLiveRefreshAfterPersist: true,
		},
	);

	assert.deepEqual(renameCalls, ['77 | Prompt title']);
	assert.deepEqual(liveRefreshCalls, ['77 | Prompt title', '77 | Prompt title', '77 | Prompt title']);
	resetVsCodeCommandMock();
});

test('startChat schedules an early rename after the chat session is bound', async () => {
	resetVsCodeCommandMock();

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			taskNumber: '77',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => '',
			getActiveChatSessionId: async () => '',
			waitForChatSessionStarted: async () => ({ ok: true, sessionId: 'session-new', reason: '' }),
			waitForChatRequestCompletion: async () => ({
				ok: false,
				reason: 'timeout',
				sessionId: 'session-new',
				lastRequestStarted: 0,
				lastRequestEnded: 0,
				hasPendingEdits: false,
			}),
		},
	});

	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;
	(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });

	const scheduledRenames: Array<{
		sessionId: string;
		prompt: any;
		logSuffix: string;
		options?: {
			notifyOnSuccess?: boolean;
			attemptDelaysMs?: number[];
			onInitialAttemptStateChange?: (state: 'started' | 'completed') => void;
		};
	}> = [];
	(manager as any).scheduleChatSessionRename = async (
		sessionId: string,
		prompt: any,
		logSuffix: string = '',
		options?: {
			notifyOnSuccess?: boolean;
			attemptDelaysMs?: number[];
			onInitialAttemptStateChange?: (state: 'started' | 'completed') => void;
		},
	) => {
		options?.onInitialAttemptStateChange?.('started');
		options?.onInitialAttemptStateChange?.('completed');
		scheduledRenames.push({ sessionId, prompt, logSuffix, options });
	};

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		taskNumber: '77',
		status: 'draft',
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-1' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	await new Promise(resolve => setTimeout(resolve, 0));
	await new Promise(resolve => setTimeout(resolve, 0));
	const renameWaitDeadline = Date.now() + 500;
	while (
		Date.now() < renameWaitDeadline
		&& !scheduledRenames.some(item => item.sessionId === 'session-new' && item.logSuffix === ' (bind)')
	) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}

	assert.ok(
		scheduledRenames.some(item =>
			item.sessionId === 'session-new'
			&& item.logSuffix === ' (bind)'
			&& item.options?.notifyOnSuccess === false),
	);
	assert.ok(postedMessages.some(message => (message as any)?.type === 'chatRequestStarted' && (message as any)?.sessionId === 'session-new'));
	assert.ok(postedMessages.some(message => (message as any)?.type === 'chatLaunchRenameState' && (message as any)?.state === 'started'));
	assert.ok(postedMessages.some(message => (message as any)?.type === 'chatLaunchRenameState' && (message as any)?.state === 'completed'));
	assert.deepEqual(getStoredPrompt()?.chatSessionIds, ['session-new']);
	assert.ok(postedMessages.some(message => (message as any)?.type === 'chatOpened'));
	resetVsCodeCommandMock();
});

/** Проверяет заполнение поля Copilot Chat без отправки при отключенном автостарте. */
test('startChat opens Copilot Chat without submitting when Copilot auto-start is disabled', async () => {
	resetVsCodeCommandMock();

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			autoStartChat: false,
			content: 'Implement the requested workflow changes.',
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			getGlobalAgentContext: () => '',
			getActiveChatSessionId: async () => '',
		},
	});

	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		autoStartChat: false,
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-copilot-manual' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.ok(vscodeCommandCalls.some(call => call.id === 'workbench.action.chat.openAgent'));
	const partialChatCall = vscodeCommandCalls.find(call => (
		call.id === 'workbench.action.chat.open'
		&& call.args.some(arg => (
			arg
			&& typeof arg === 'object'
			&& 'query' in arg
			&& 'isPartialQuery' in arg
		))
	));
	assert.ok(partialChatCall);
	const partialChatArg = partialChatCall?.args.find(arg => (
		arg
		&& typeof arg === 'object'
		&& 'query' in arg
		&& 'isPartialQuery' in arg
	)) as { query?: unknown; isPartialQuery?: unknown } | undefined;
	assert.match(String(partialChatArg?.query || ''), /Implement the requested workflow changes/);
	assert.equal(partialChatArg?.isPartialQuery, true);
	assert.equal(postedMessages.some(message => message?.type === 'chatStarted'), false);
	assert.equal(postedMessages.some(message => message?.type === 'chatRequestStarted'), false);
	assert.ok(postedMessages.some(message => message?.type === 'chatOpened'));
	assert.equal(getStoredPrompt()?.status, 'in-progress');
	assert.deepEqual(getStoredPrompt()?.chatSessionIds, []);
	resetVsCodeCommandMock();
});

/** Verify that the keep-current selection reaches chat dispatch without resolving another selection. */
test('startChat keeps the active chat model unchanged for the keep-current selection', async () => {
	resetVsCodeCommandMock();

	// Track any attempt to replace the active chat selection during launch.
	const modelResolutionCalls: string[] = [];
	const { manager, aiService } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			model: 'keep-current-model',
			content: 'Implement the requested workflow changes.',
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			getGlobalAgentContext: () => '',
			getActiveChatSessionId: async () => '',
			waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
			waitForChatRequestCompletion: async () => ({
				ok: false,
				reason: 'timeout',
				sessionId: '',
				lastRequestStarted: 0,
				lastRequestEnded: 0,
				hasPendingEdits: false,
			}),
		},
	});

	(aiService as any).resolveModelStorageIdentifier = async (value: string) => {
		modelResolutionCalls.push(`storage:${value}`);
		return value;
	};
	(aiService as any).resolveChatOpenModelSelector = async (value: string) => {
		modelResolutionCalls.push(`selector:${value}`);
		return undefined;
	};
	(aiService as any).tryApplyChatModelSafely = async (value: string) => {
		modelResolutionCalls.push(`apply:${value}`);
		return { ok: true };
	};

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		model: 'keep-current-model',
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-keep-current' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.deepEqual(modelResolutionCalls, []);
	assert.ok(vscodeCommandCalls.some(call => call.id === 'workbench.action.chat.openAgent'));
	assert.ok(postedMessages.some(message => message?.type === 'chatStarted'));
	resetVsCodeCommandMock();
});

/** Verify that a Plan prompt opens a new Codex chat in Agent mode. */
test('startChat opens a Codex agent host chat in Agent mode even for a Plan prompt', async () => {
	resetVsCodeCommandMock();

	const { manager, aiService } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			chatMode: 'plan',
			model: 'keep-current-model',
			content: 'Implement the requested workflow changes.',
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			getGlobalAgentContext: () => '',
			getActiveChatSessionId: async () => '',
			waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
			waitForChatRequestCompletion: async () => ({
				ok: false,
				reason: 'timeout',
				sessionId: '',
				lastRequestStarted: 0,
				lastRequestEnded: 0,
				hasPendingEdits: false,
			}),
		},
	});
	(aiService as any).resolveSelectedChatSessionType = async () => 'agent-host-codex';

	const panel = {
		visible: true,
		webview: { postMessage: async () => true },
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		chatMode: 'plan',
		model: 'keep-current-model',
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-codex-agent-mode' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.ok(vscodeCommandCalls.some(call => call.id === 'workbench.action.chat.openAgent'));
	assert.ok(!vscodeCommandCalls.some(call => call.id === 'workbench.action.chat.openPlan'));
	const toggleCall = vscodeCommandCalls.find(call => call.id === 'workbench.action.chat.toggleAgentMode');
	assert.deepEqual(toggleCall?.args[0], { modeId: 'agent' });
	const queryModes = vscodeCommandCalls
		.filter(call => (call.id === 'workbench.action.chat.open' || call.id === 'workbench.action.chat.openAgent')
			&& typeof (call.args[0] as any)?.query === 'string')
		.map(call => (call.args[0] as any)?.mode);
	assert.ok(queryModes.includes('Agent'));
	assert.ok(!queryModes.includes('Plan'));
	assert.deepEqual(vscodeConfigurationUpdates, [{ key: 'chat.newSession.defaultMode', value: 'agent', target: true }]);
	resetVsCodeCommandMock();
});

/** Проверяет настройку разрешений до подготовки или отправки и сохранение исходной модели при открытии. */
const codexLaunchState = {
	getActiveChatSessionId: async () => '',
	waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
	waitForChatRequestCompletion: async () => ({ ok: false, reason: 'timeout', sessionId: '',
		lastRequestStarted: 0, lastRequestEnded: 0, hasPendingEdits: false }),
};

/** Readonly-исключения Prompt Manager не должны удалять корни из контекста нового чата VS Code. */
test('prepareCopilotCodexChat retains readonly workspace roots as context', async () => {
	resetVsCodeCommandMock();
	let folders: string[] = [];
	const { manager } = await createManager({
		workspaceService: { getWorkspaceFolderPaths: (includeExcluded: boolean) => new Map(
			includeExcluded ? [['readonly-project', '/testing/readonly-project']] : [],
		) },
		prepareCopilotCodexSession: async (_title, paths) => {
			folders = paths;
			return { openLink: 'agent-host-session://ahp-session/testing-readonly-context' };
		},
	});
	await (manager as any).prepareCopilotCodexChat(createPrompt());
	assert.deepEqual(folders, ['/testing/readonly-project']);
	manager.disposeAll();
	resetVsCodeCommandMock();
});

/** Ручной и автоматический запуск используют одинаково подтверждённые разрешения. */
for (const autoStartChat of [false, true]) {
	test(`startChat prepares Codex Full Access before ${autoStartChat ? 'sending' : 'prefilling'} the prompt`, async () => {
		resetVsCodeCommandMock();
		const preparation = createDeferred<{ openLink: string }>();
		const enteredPreparation = createDeferred<void>();
		const initialPrompt = createPrompt({ model: 'keep-current-model', autoStartChat, content: 'Test Full Access.' });
		const { manager, aiService } = await createManager({ initialPrompt, stateService: codexLaunchState,
			prepareCopilotCodexSession: async () => { enteredPreparation.resolve(); return preparation.promise; } });
		aiService.resolveSelectedChatSessionType = async () => 'agent-host-codex';
		const selector = { vendor: 'agent-host-codex', id: '@provider=openai:remembered-model' };
		Object.assign(aiService, { resolveSelectedSessionTypeModel: async () => ({
			sessionType: 'agent-host-codex', identifier: 'remembered', selector,
		}) });
		// Новый picker может выбрать иной default, но запуск должен сохранить ранее запомненную модель.
		vscodeExecuteCommandHandler = async id => {
			if (id === 'vscode.open') Object.assign(aiService, { resolveSelectedSessionTypeModel: async () => ({
				sessionType: 'agent-host-codex', identifier: 'new-default',
				selector: { vendor: 'agent-host-codex', id: 'new-default' },
			}) });
		};
		const events: Array<Record<string, unknown>> = [];
		const panel = { visible: true, webview: { postMessage: async (event: Record<string, unknown>) => events.push(event) } };
		await withImmediateTimers(async () => {
			const start = (manager as any).handleMessage(
				{ type: 'startChat', id: initialPrompt.id, forceRebindChat: true }, panel, initialPrompt,
				'__prompt_editor_singleton__', () => false, () => undefined,
			);
			await enteredPreparation.promise;
			assert.equal(vscodeCommandCalls.some(call => typeof (call.args[0] as { query?: unknown })?.query === 'string'), false);
			preparation.resolve({ openLink: 'agent-host-session://ahp-session/testing-exact-session' });
			await start;
		});
		const openIndex = vscodeCommandCalls.findIndex(call => call.id === 'vscode.open');
		const queryIndex = vscodeCommandCalls.findIndex(call => typeof (call.args[0] as { query?: unknown })?.query === 'string');
		assert.ok(openIndex >= 0 && queryIndex > openIndex);
		assert.equal(String(vscodeCommandCalls[openIndex].args[0]), 'agent-host-session://ahp-session/testing-exact-session');
		const query = vscodeCommandCalls[queryIndex].args[0] as Record<string, unknown>;
		assert.deepEqual(query.modelSelector, selector);
		assert.equal(query.isPartialQuery === true, !autoStartChat);
		assert.equal(vscodeCommandCalls.some(call => call.id === 'workbench.action.chat.newChat'), false);
		assert.equal(events.some(event => event.type === 'chatStarted'), autoStartChat);
		manager.disposeAll();
		resetVsCodeCommandMock();
	});
}

/** Параллельный запуск не перехватывает composer и не откатывает статус первой задачи. */
test('startChat rejects a concurrent Codex launch without changing the first launch state', async () => {
	resetVsCodeCommandMock();
	const entered = createDeferred<void>();
	const prepared = createDeferred<{ openLink: string }>();
	let calls = 0;
	const prompt = createPrompt({ content: 'Concurrent launch', autoStartChat: false });
	const { manager, aiService, getStoredPrompt } = await createManager({ initialPrompt: prompt,
		stateService: codexLaunchState, prepareCopilotCodexSession: async () => {
			calls++; entered.resolve(); return prepared.promise;
		} });
	aiService.resolveSelectedChatSessionType = async () => 'agent-host-codex';
	const events: Array<Record<string, unknown>> = [];
	const panel = { visible: true, webview: { postMessage: async (event: Record<string, unknown>) => events.push(event) } };
	await withImmediateTimers(async () => {
		const start = (manager as any).handleMessage({ type: 'startChat', id: prompt.id }, panel, prompt,
			'__prompt_editor_singleton__', () => false, () => undefined);
		await entered.promise;
		const before = getStoredPrompt();
		await (manager as any).handleMessage({ type: 'startChat', id: prompt.id, requestId: 'second' }, panel, prompt,
			'__prompt_editor_singleton__', () => false, () => undefined);
		assert.equal(calls, 1);
		assert.deepEqual(getStoredPrompt(), before);
		assert.ok(events.some(event => event.type === 'error' && event.requestId === 'second'));
		prepared.resolve({ openLink: 'agent-host-session://ahp-session/testing-first' });
		await start;
	});
	manager.disposeAll();
	resetVsCodeCommandMock();
});

/** Отказ подготовки не отправляет запрос, сохраняет текст и не очищает план задачи. */
test('startChat stops Codex launch and preserves prompt text when Full Access cannot be confirmed', async () => {
	resetVsCodeCommandMock();
	const initialPrompt = createPrompt({ content: 'Keep this prompt.', autoStartChat: true });
	const { manager, aiService } = await createManager({ initialPrompt, stateService: codexLaunchState,
		prepareCopilotCodexSession: async () => { throw new Error('Full Access unavailable'); } });
	aiService.resolveSelectedChatSessionType = async () => 'agent-host-codex';
	let cleared = false;
	(manager as any).clearPromptPlanFileIfExists = async () => { cleared = true; };
	const events: Array<Record<string, unknown>> = [];
	await withImmediateTimers(() => (manager as any).handleMessage(
		{ type: 'startChat', id: initialPrompt.id },
		{ visible: true, webview: { postMessage: async (event: Record<string, unknown>) => events.push(event) } },
		initialPrompt, '__prompt_editor_singleton__', () => false, () => undefined,
	));
	assert.equal(vscodeCommandCalls.some(call => typeof (call.args[0] as { query?: unknown })?.query === 'string'), false);
	assert.match(vscodeClipboardText, /Keep this prompt/);
	assert.equal(cleared, false);
	assert.equal(events.some(event => event.type === 'chatStarted'), false);
	assert.ok(events.some(event => event.type === 'error' && String(event.message).includes('Full Access unavailable')));
	manager.disposeAll();
	resetVsCodeCommandMock();
});

/** Verify that keep-current explicitly reapplies the remembered Codex model through modelSelector. */
test('startChat reapplies the remembered session type model for the keep-current selection', async () => {
	resetVsCodeCommandMock();

	const { manager, aiService } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			model: 'keep-current-model',
			content: 'Implement the requested workflow changes.',
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			getGlobalAgentContext: () => '',
			getActiveChatSessionId: async () => '',
			waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
			waitForChatRequestCompletion: async () => ({
				ok: false,
				reason: 'timeout',
				sessionId: '',
				lastRequestStarted: 0,
				lastRequestEnded: 0,
				hasPendingEdits: false,
			}),
		},
	});

	// Запомненная модель Codex с провайдером OpenAI, которую нужно выбрать явно.
	const selector = { vendor: 'agent-host-codex', id: '@provider=openai:gpt-6-astra' };
	(aiService as any).resolveSelectedSessionTypeModel = async () => ({
		sessionType: 'agent-host-codex',
		identifier: 'agent-host-codex:@provider=openai:gpt-6-astra',
		selector,
	});

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		model: 'keep-current-model',
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-keep-current-session-model' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	const queryCall = vscodeCommandCalls.find(call => call.id === 'workbench.action.chat.open'
		&& typeof (call.args[0] as any)?.query === 'string');
	assert.deepEqual((queryCall?.args[0] as any)?.modelSelector, selector);
	assert.ok(postedMessages.some(message => message?.type === 'chatStarted'));
	resetVsCodeCommandMock();
});

/** Создаёт Claude harness без файлов, SDK worker, сети, рабочих hooks и реальных нажатий клавиш. */
async function createClaudeManager(overrides: Record<string, unknown> = {}) {
	resetVsCodeCommandMock();
	vscodeAvailableCommands = ['claude-vscode.editor.open'];
	vscodeConfigurationUpdateHandler = async (key, value) => { vscodeConfigurationValues.set(key, value); };
	const initialPrompt = createPrompt({ title: 'Claude task', chatTarget: 'claude', content: 'Test Claude.', ...overrides });
	const harness = await createManager({ initialPrompt, stateService: { getChatSessionsTotalElapsed: async () => 300 },
		workspaceService: { getWorkspaceFolderPaths: () => new Map([['workspace', '/tmp/workspace']]) } });
	const service: any = {
		findSession: async () => undefined,
		readSession: async () => undefined,
		hasSession: async () => false,
		renameSession: async () => undefined,
		watch: () => createDisposable(),
		dispose: () => undefined,
	};
	(harness.manager as any).claudeChatService = service;
	(harness.manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	const messages: any[] = [];
	const panel: any = { visible: true, webview: { postMessage: async (message: unknown) => messages.push(message) } };
	/** Отправляет сообщение только изолированному обработчику manager. */
	const send = (message: any) => (harness.manager as any).handleMessage(
		message, panel, initialPrompt, '__prompt_editor_singleton__', () => false, () => undefined,
	);
	return { ...harness, service, initialPrompt, messages, send };
}

/** Изолирует OpenCode от настоящих терминалов, сокетов, рабочих файлов и моделей. */
async function createOpenCodeManager(autoStart = false, overrides: Record<string, unknown> = {}) {
	resetVsCodeCommandMock();
	const prompt = createPrompt({ title: 'OpenCode task', content: 'Test OpenCode.', chatMode: 'plan',
		chatTarget: 'opencode-cli', autoStartOpenCodeChat: autoStart, chatSessionIds: ['old-copilot'], ...overrides });
	const harness = await createManager({ initialPrompt: prompt,
		workspaceService: { getWorkspaceFolderPaths: () => new Map([['workspace', '/tmp/workspace']]) } });
	const requests: OpenCodeCliRequest[] = [];
	const messages: Array<{ type?: string; message?: string }> = [];
	let cleared = 0, created = 0, opened = 0;
	const internals = harness.manager as unknown as {
		openCodeCliService: Pick<OpenCodeCliService, 'start' | 'open' | 'dispose'>;
		syncTrackedPromptFilesForPanel: () => Promise<void>;
		clearPromptPlanFileIfExists: () => Promise<void>;
		handleMessage: (...args: unknown[]) => Promise<void>;
	};
	internals.openCodeCliService = {
		start: async request => { requests.push(request); return { dispatched: request.autoStart, message: 'Prepared' }; },
		open: () => { opened++; return true; }, dispose() {},
	};
	internals.syncTrackedPromptFilesForPanel = async () => undefined;
	internals.clearPromptPlanFileIfExists = async () => { cleared++; };
	harness.storageService.createAgentFile = async () => { created++; };
	const panel = { visible: true, webview: { postMessage: async (message: { type?: string; message?: string }) => messages.push(message) } };
	return { ...harness, requests, messages, internals,
		counts: () => ({ cleared, created, opened }),
		send: (message: Record<string, unknown>) => internals.handleMessage(message, panel, prompt,
			'__prompt_editor_singleton__', () => false, () => undefined),
	};
}

/** Черновик сохраняет план, старые Copilot IDs и независимую настройку отправки. */
test('OpenCode manager prepares common context without clearing a draft plan or rebinding Copilot', async () => {
	const fixture = await createOpenCodeManager();
	try {
		await fixture.send({ type: 'startChat', id: 'prompt-a', forceRebindChat: true });
		assert.equal(fixture.requests.length, 1);
		assert.equal(fixture.requests[0].autoStart, false);
		assert.equal(fixture.requests[0].cwd, '/tmp/workspace');
		assert.match(fixture.requests[0].query, /Test OpenCode\./);
		assert.match(fixture.requests[0].query, /Create a detailed implementation plan/);
		assert.deepEqual(fixture.getStoredPrompt()?.chatSessionIds, ['old-copilot']);
		assert.deepEqual(fixture.counts(), { cleared: 0, created: 0, opened: 0 });
		assert.ok(fixture.messages.some(message => message.type === 'chatOpened'));
		assert.equal(fixture.messages.some(message => message.type === 'chatRequestStarted'), false);
		assert.equal(vscodeCommandCalls.some(call => call.id.startsWith('workbench.action.chat.')), false);
	} finally { fixture.manager.disposeAll(); }
});

/** OpenCode использует тот же формат названия, что Copilot, сохраняя строковый номер без преобразования. */
test('OpenCode manager shares the Number | Title format with Copilot', async () => {
	for (const taskNumber of ['172', '00172', '']) {
		const fixture = await createOpenCodeManager(false, { taskNumber, title: ' Проверка Kilo ' });
		try {
			await fixture.send({ type: 'startChat', id: 'prompt-a' });
			assert.equal(fixture.requests[0].title, taskNumber ? `${taskNumber} | Проверка Kilo` : 'Проверка Kilo');
		} finally { fixture.manager.disposeAll(); }
	}
});

/** Поколение проверяется повторно после чтения, чтобы ответ старой сессии не очистил новый план. */
test('OpenCode manager ignores a manual confirmation invalidated during prompt lookup', async () => {
	const fixture = await createOpenCodeManager();
	try {
		await fixture.send({ type: 'startChat', id: 'prompt-a' });
		const latest = fixture.getStoredPrompt();
		let resolveLatest!: (value: typeof latest) => void;
		const lookup = new Promise<typeof latest>(resolve => { resolveLatest = resolve; });
		fixture.storageService.getPromptByUuid = async () => lookup;
		let current = true;
		const confirmation = fixture.requests[0].onManualSubmission!(() => current);
		current = false;
		resolveLatest(latest);
		await confirmation;
		assert.deepEqual(fixture.counts(), { cleared: 0, created: 0, opened: 0 });
		assert.equal(fixture.messages.some(message => message.type === 'chatRequestStarted'), false);
	} finally { fixture.manager.disposeAll(); }
});

/** Подтверждение актуального запуска сохраняет штатную очистку даже без зарегистрированной панели. */
test('OpenCode manager accepts a current manual confirmation', async () => {
	const fixture = await createOpenCodeManager();
	try {
		await fixture.send({ type: 'startChat', id: 'prompt-a' });
		await fixture.requests[0].onManualSubmission!(() => true);
		assert.deepEqual(fixture.counts(), { cleared: 1, created: 1, opened: 0 });
	} finally { fixture.manager.disposeAll(); }
});

/** Поколение координатора защищает новый план ещё до передачи нового запуска в CLI-сервис. */
test('OpenCode manager invalidates the old callback while the next launch waits for beforeChat', async () => {
	const fixture = await createOpenCodeManager();
	let resume!: () => void, entered!: () => void;
	const waiting = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { resume = resolve; });
	let second: Promise<void> | undefined;
	try {
		await fixture.send({ type: 'startChat', id: 'prompt-a' });
		const previous = fixture.requests[0];
		await fixture.storageService.savePrompt({ ...fixture.getStoredPrompt(), content: 'New prompt B', status: 'draft' });
		(fixture.manager as unknown as { runConfiguredHooks: (
			hooks: unknown, payload: { event: string },
		) => Promise<void> }).runConfiguredHooks = async (_hooks, payload) => {
			if (payload.event === 'beforeChat') { entered(); await gate; }
		};
		second = fixture.send({ type: 'startChat', id: 'prompt-a' });
		await waiting;
		assert.equal(fixture.requests.length, 1);
		await previous.onManualSubmission!(() => true);
		assert.deepEqual(fixture.counts(), { cleared: 0, created: 0, opened: 0 });
	} finally {
		resume();
		await second;
		fixture.manager.disposeAll();
	}
});

/** Отложенный stat не даёт старому подтверждению стереть план после смены поколения запуска. */
test('OpenCode plan cleanup checks launch ownership again after file stat', async () => {
	resetVsCodeCommandMock();
	const { manager, storageService } = await createManager({ initialPrompt: { id: 'prompt-a', promptUuid: 'uuid-a' } });
	const planUri = storageService.getPromptPlanUri('prompt-a');
	vscodeWorkspaceFiles.set(planUri.toString(), 'New plan B');
	let current = true;
	storageService.getPromptPlanUri = () => {
		queueMicrotask(() => { current = false; });
		return planUri;
	};
	try {
		await (manager as unknown as { clearPromptPlanFileIfExists: (
			panelKey: string, promptId: string, isCurrent: () => boolean,
		) => Promise<void> }).clearPromptPlanFileIfExists('__prompt_editor_singleton__', 'prompt-a', () => current);
		assert.equal(vscodeWorkspaceFiles.get(planUri.toString()), 'New plan B');
	} finally { manager.disposeAll(); }
});

/** План и служебный файл меняются только после подтверждённого приёма запроса OpenCode. */
test('OpenCode manager clears the plan and emits request events only for confirmed auto-send', async () => {
	const fixture = await createOpenCodeManager(true);
	try {
		await fixture.send({ type: 'startChat', id: 'prompt-a' });
		assert.equal(fixture.requests[0].autoStart, true);
		assert.deepEqual(fixture.counts(), { cleared: 1, created: 1, opened: 0 });
		assert.ok(fixture.messages.some(message => message.type === 'chatStarted'));
		assert.ok(fixture.messages.some(message => message.type === 'chatRequestStarted'));
	} finally { fixture.manager.disposeAll(); }
});

/** Ошибка нового dispatch возвращает исходный статус и сохраняет существующую историю/план. */
test('OpenCode manager restores draft status after a failed terminal launch', async () => {
	const fixture = await createOpenCodeManager();
	fixture.internals.openCodeCliService.start = async () => { throw new Error('OpenCode unavailable'); };
	try {
		await fixture.send({ type: 'startChat', id: 'prompt-a' });
		assert.equal(fixture.getStoredPrompt()?.status, 'draft');
		assert.deepEqual(fixture.getStoredPrompt()?.chatSessionIds, ['old-copilot']);
		assert.equal(fixture.counts().cleared, 0);
		assert.ok(fixture.messages.some(message => message.type === 'error' && message.message?.includes('OpenCode unavailable')));
	} finally { fixture.manager.disposeAll(); }
});

/** Открытие и Stop не выполняют команды встроенного Copilot, даже при наличии его старой привязки. */
test('OpenCode manager routes open, stop and timing actions without touching old Copilot sessions', async () => {
	const fixture = await createOpenCodeManager();
	try {
		for (const type of ['openChat', 'openChatPanel', 'stopChat', 'recalcImplementingTime']) {
			await fixture.send({ type, id: 'prompt-a', silent: true });
		}
		assert.equal(fixture.counts().opened, 2);
		assert.equal(fixture.requests.length, 0);
		assert.deepEqual(fixture.getStoredPrompt()?.chatSessionIds, ['old-copilot']);
		assert.equal(vscodeCommandCalls.some(call => call.id.startsWith('workbench.action.chat.')), false);
		assert.ok(fixture.messages.some(message => message.message?.includes('терминале OpenCode CLI')));
	} finally { fixture.manager.disposeAll(); }
});

/** Не считает prefill отправкой и не удаляет план, включая случай прежней сессии Copilot. */
test('Claude start prefills the native sidebar and preserves plan and Copilot history', async () => {
	const fixture = await createClaudeManager({ chatMode: 'plan', model: 'copilot-model', chatSessionIds: ['old-copilot'] });
	let clearedPlan = false;
	(fixture.manager as any).clearPromptPlanFileIfExists = async () => { clearedPlan = true; };
	await fixture.send({ type: 'startChat', id: 'prompt-a', forceRebindChat: true, requestId: 'claude-test' });
	await flushTurns();
	const open = vscodeCommandCalls.find(call => call.id === 'claude-vscode.editor.open');
	assert.ok(open);
	assert.equal(open.args[0], undefined);
	assert.match(String(open.args[1]), /^\[\[prompt-manager-claude:[\da-f-]+\]\]\n/);
	assert.match(String(open.args[1]), /Test Claude\.|Create a detailed implementation plan/);
	assert.doesNotMatch(String(open.args[1]), /Preferred model:.*copilot-model|^\/plan/);
	assert.deepEqual(open.args.slice(2), [undefined, undefined, undefined, { programmatic: 'honor-preferred-location' }]);
	assert.deepEqual(vscodeConfigurationUpdates, [{ key: 'claudeCode.preferredLocation', value: 'sidebar', target: true }]);
	assert.equal(vscodeCommandCalls.some(call => call.id === 'claude-vscode.primaryEditor.open'), false);
	assert.deepEqual(fixture.getStoredPrompt()?.chatSessionIds, ['old-copilot']);
	assert.ok(fixture.getStoredPrompt()?.claudeChat.pendingLaunch);
	assert.equal(fixture.getStoredPrompt()?.claudeChat.copilotAccountedMs, 300);
	assert.equal(clearedPlan, false);
	assert.equal(childProcessSpawnCalls.length, 0);
	assert.equal(fixture.messages.some(message => message.type === 'chatStarted'), false);
	assert.ok(fixture.messages.some(message => message.type === 'chatOpened'));
	assert.equal(vscodeCommandCalls.some(call => call.id.startsWith('workbench.action.chat.')), false);
	fixture.manager.disposeAll();
});

/** Предпочтение sidebar не перезаписывается; настройка проекта не подменяется глобальной. */
test('Claude sidebar routing preserves an existing preference and the workspace setting scope', async () => {
	for (const scope of ['sidebar', 'workspace']) {
		const fixture = await createClaudeManager();
		vscodeConfigurationValues.set('claudeCode.preferredLocation', scope === 'sidebar' ? 'sidebar' : 'panel');
		if (scope === 'workspace') { vscodeWorkspaceConfigurationValues.set('claudeCode.preferredLocation', 'panel'); }
		await fixture.send({ type: 'startChat', id: 'prompt-a' });
		assert.deepEqual(vscodeConfigurationUpdates, scope === 'sidebar' ? []
			: [{ key: 'claudeCode.preferredLocation', value: 'sidebar', target: false }]);
		assert.ok(vscodeCommandCalls.some(call => call.id === 'claude-vscode.editor.open'
			&& (call.args[5] as any)?.programmatic === 'honor-preferred-location'));
		fixture.manager.disposeAll();
	}
});

/** editor.open не должен увидеть старое panel до завершения асинхронной записи настройки. */
test('Claude waits for the sidebar preference before dispatching the initial prompt', async () => {
	const fixture = await createClaudeManager();
	const started = createDeferred<void>();
	const release = createDeferred<void>();
	vscodeConfigurationUpdateHandler = async () => { started.resolve(); await release.promise; };
	const launching = fixture.send({ type: 'startChat', id: 'prompt-a' });
	try {
		await started.promise;
		assert.equal(vscodeCommandCalls.some(call => call.id === 'claude-vscode.editor.open'), false);
	} finally {
		release.resolve();
		await launching;
		fixture.manager.disposeAll();
	}
	assert.ok(vscodeCommandCalls.some(call => call.id === 'claude-vscode.editor.open'));
});

/** При отказе настройки не появляется ни editor tab, ни ложное подтверждение открытия. */
test('Claude reports a sidebar configuration error without falling back to an editor tab', async () => {
	const fixture = await createClaudeManager();
	vscodeConfigurationUpdateHandler = async () => { throw new Error('settings are read-only'); };
	await fixture.send({ type: 'startChat', id: 'prompt-a' });
	assert.equal(vscodeCommandCalls.some(call => call.id.startsWith('claude-vscode.')), false);
	assert.equal(fixture.messages.some(message => message.type === 'chatOpened'), false);
	assert.ok(fixture.messages.some(message => message.type === 'error' && /settings are read-only/.test(message.message)));
	fixture.manager.disposeAll();
});

/** Активация происходит до повторного чтения списка команд, без fallback в другой чат. */
test('Claude activates extension and reports missing command or extension without a false launch', async () => {
	for (const missing of ['extension', 'command', 'none']) {
		const fixture = await createClaudeManager();
		let activated = false;
		vscodeAvailableCommands = missing === 'command' ? ['claude-vscode.primaryEditor.open'] : [];
		vscodeClaudeExtension = missing === 'extension' ? undefined : {
			isActive: false,
			activate: async () => {
				activated = true;
				if (missing === 'none') { vscodeAvailableCommands = ['claude-vscode.editor.open']; }
			},
		};
		await fixture.send({ type: 'startChat', id: 'prompt-a' });
		assert.equal(activated, missing !== 'extension');
		assert.equal(vscodeCommandCalls.some(call => call.id === 'claude-vscode.editor.open'), missing === 'none');
		assert.equal(vscodeCommandCalls.some(call => call.id === 'claude-vscode.primaryEditor.open'), false);
		assert.equal(fixture.messages.some(message => message.type === 'chatOpened'), missing === 'none');
		assert.equal(vscodeCommandCalls.some(call => call.id.startsWith('workbench.action.chat.')), false);
		fixture.manager.disposeAll();
	}
});

/** Первое подтверждённое сообщение привязывается и переименовывается, время начисляется один раз. */
test('Claude binding survives manual send and refresh accounts duration once while preserving manual time', async () => {
	const fixture = await createClaudeManager({ status: 'in-progress', timeSpentImplementing: 7000 });
	await fixture.send({ type: 'startChat', id: 'prompt-a' });
	await flushTurns();
	const binding = { sessionId: '11111111-1111-4111-8111-111111111111', projectPath: '/tmp/workspace', accountedMs: 0 };
	fixture.service.findSession = async () => binding;
	let title = '';
	fixture.service.readSession = async () => ({ totalElapsedMs: 2000, customTitle: title, completed: false });
	let renames = 0;
	fixture.service.renameSession = async (_binding: unknown, nextTitle: string) => { title = nextTitle; renames++; };
	await (fixture.manager as any).refreshClaudePrompt(fixture.initialPrompt);
	await (fixture.manager as any).refreshClaudePrompt(fixture.initialPrompt);
	assert.equal(fixture.getStoredPrompt()?.timeSpentImplementing, 9000);
	assert.equal(fixture.getStoredPrompt()?.claudeChat.pendingLaunch, undefined);
	assert.equal(fixture.getStoredPrompt()?.claudeChat.sessions[0].sessionId, binding.sessionId);
	assert.equal(fixture.getStoredPrompt()?.claudeChat.sessions[0].accountedMs, 2000);
	assert.deepEqual(fixture.getStoredPrompt()?.chatSessionIds, []);
	assert.equal(renames, 1);
	assert.equal(title, 'Claude task');
	fixture.manager.disposeAll();
});

/** Фоновая сверка времени обращается к своей папке и не заменяет открытую копию другим статусом. */
test('Claude refresh and panel synchronization preserve the exact folder with duplicate UUIDs', async () => {
	const fixture = await createClaudeManager({ id: 'completed', status: 'completed', timeSpentImplementing: 5600 });
	const copy = createPrompt({ id: 'draft', status: 'draft', promptUuid: fixture.initialPrompt.promptUuid });
	fixture.storageService.getPromptByUuid = async () => copy;
	const manager = fixture.manager as any;
	manager.panelPromptRefs.set('__prompt_editor_singleton__', copy);
	try {
		const refreshed = await manager.refreshClaudePrompt(fixture.initialPrompt);
		assert.equal(refreshed.totalMs, 5600);
		manager.syncClaudePromptToPanels(fixture.initialPrompt);
		assert.equal(copy.id, 'draft');
		assert.equal(copy.status, 'draft');
	} finally {
		fixture.manager.disposeAll();
	}
});

/** Данные Claude никогда не используются как команда остановки Copilot. */
test('Claude stop with stale Copilot IDs only explains manual stop', async () => {
	const fixture = await createClaudeManager({ chatSessionIds: ['old-copilot'] });
	await fixture.send({ type: 'stopChat', id: 'prompt-a' });
	assert.equal(vscodeCommandCalls.length, 0);
	assert.ok(fixture.messages.some(message => message.type === 'info' && /inside Claude Code/.test(message.message)));
	fixture.manager.disposeAll();
});

/** Не подменяет отсутствующий разговор новой сессией при переходе. */
test('Claude reopen uses exact persisted session or fails without opening a replacement', async () => {
	for (const exists of [true, false]) {
		const sessionId = '11111111-1111-4111-8111-111111111111';
		const fixture = await createClaudeManager({ status: 'completed', chatSessionIds: ['old-copilot'],
			claudeChat: { sessions: [{ sessionId, projectPath: '/tmp/workspace', accountedMs: 0 }] } });
		fixture.service.hasSession = async () => exists;
		await fixture.send({ type: 'openChat', id: 'prompt-a', sessionId: 'old-copilot' });
		const call = vscodeCommandCalls.find(item => item.id === 'claude-vscode.editor.open');
		assert.equal(Boolean(call), exists);
		if (exists) {
			assert.deepEqual(call?.args, [sessionId, undefined, undefined, undefined, undefined,
				{ programmatic: 'honor-preferred-location' }]);
		}
		assert.equal(vscodeCommandCalls.some(item => item.id === 'claude-vscode.primaryEditor.open'), false);
		assert.equal(fixture.getStoredPrompt()?.status, exists ? 'in-progress' : 'completed');
		assert.equal(vscodeCommandCalls.some(item => item.id.startsWith('workbench.action.chat.')), false);
		fixture.manager.disposeAll();
	}
});

/** Фиксирует завершение только один раз; закрытый промпт не получает новое время или статус. */
test('Claude completion hooks are idempotent and closed timing is frozen', async () => {
	for (const status of ['in-progress', 'closed']) {
		const fixture = await createClaudeManager({ status, timeSpentImplementing: 500, chatRequestAutoCompleteAfter: 1000,
			claudeChat: { sessions: [{ sessionId: '11111111-1111-4111-8111-111111111111',
				projectPath: '/tmp/workspace', accountedMs: 100 }] } });
		fixture.service.readSession = async () => ({ totalElapsedMs: 600, customTitle: 'Claude task',
			completed: true, lastRequestStarted: 2000, lastRequestEnded: 3000 });
		let hooks = 0;
		(fixture.manager as any).runConfiguredHooks = async () => { hooks++; };
		await (fixture.manager as any).refreshClaudePrompt(fixture.initialPrompt);
		await (fixture.manager as any).refreshClaudePrompt(fixture.initialPrompt);
		assert.equal(fixture.getStoredPrompt()?.timeSpentImplementing, status === 'closed' ? 500 : 1000);
		assert.equal(fixture.getStoredPrompt()?.status, status === 'closed' ? 'closed' : 'completed');
		assert.equal(hooks, status === 'closed' ? 0 : 1);
		fixture.manager.disposeAll();
	}
});

/** Смена статуса не откатывает binding и время, полученные после открытия панели. */
test('Claude binding survives status-only save with a real panel baseline', async () => {
	const fixture = await createClaudeManager({ status: 'in-progress', timeSpentImplementing: 100,
		claudeChat: { sessions: [{ sessionId: '11111111-1111-4111-8111-111111111111',
			projectPath: '/tmp/workspace', accountedMs: 0 }] } });
	const key = '__prompt_editor_singleton__';
	(fixture.manager as any).panelPromptRefs.set(key, fixture.initialPrompt);
	(fixture.manager as any).panelBasePrompts.set(key, clonePrompt(fixture.initialPrompt));
	fixture.service.readSession = async () => ({ totalElapsedMs: 200, customTitle: 'Claude task', completed: false });
	await (fixture.manager as any).refreshClaudePrompt(fixture.initialPrompt);
	assert.equal((fixture.manager as any).panelBasePrompts.get(key).claudeChat.sessions[0].accountedMs, 200);
	await fixture.send({ type: 'savePrompt', source: 'status-change',
		prompt: { ...fixture.getStoredPrompt(), status: 'stopped' } });
	await (fixture.manager as any).refreshClaudePrompt(fixture.initialPrompt);
	assert.equal(fixture.getStoredPrompt()?.claudeChat.sessions[0].accountedMs, 200);
	assert.equal(fixture.getStoredPrompt()?.timeSpentImplementing, 300);
	assert.equal(fixture.getStoredPrompt()?.status, 'stopped');
	fixture.manager.disposeAll();
});

/** Не теряет событие во время чтения и не завершает более новый активный запрос старым финалом. */
test('Claude coalesces refresh events without blocking saves or completing an active session', async () => {
	const fixture = await createClaudeManager({ status: 'in-progress', chatRequestAutoCompleteAfter: 1000,
		claudeChat: { sessions: [
			{ sessionId: '11111111-1111-4111-8111-111111111111', projectPath: '/tmp/workspace', accountedMs: 0 },
			{ sessionId: '22222222-2222-4222-8222-222222222222', projectPath: '/tmp/workspace', accountedMs: 0 },
		] } });
	const gate = createDeferred<void>();
	let reads = 0;
	fixture.service.readSession = async (binding: { sessionId: string }) => {
		if (++reads === 1) { await gate.promise; }
		return binding.sessionId.startsWith('111')
			? { totalElapsedMs: 0, customTitle: 'Claude task', completed: false, lastRequestStarted: 5000 }
			: { totalElapsedMs: 300, customTitle: 'Claude task', completed: true, lastRequestStarted: 2000, lastRequestEnded: 4000 };
	};
	const first = (fixture.manager as any).refreshClaudePrompt(fixture.initialPrompt);
	await flushTurns();
	const repeated = (fixture.manager as any).refreshClaudePrompt(fixture.initialPrompt);
	let saved = false;
	await (fixture.manager as any).enqueuePromptSaveOperation(fixture.initialPrompt, async () => { saved = true; });
	assert.equal(saved, true);
	gate.resolve();
	await Promise.all([first, repeated]);
	await flushTurns(12);
	assert.ok(reads >= 4);
	assert.equal(fixture.getStoredPrompt()?.status, 'in-progress');
	assert.equal(fixture.getStoredPrompt()?.timeSpentImplementing, 300);
	fixture.manager.disposeAll();
});

/** Переименование не зависит от поддержки истории длительностей. */
test('Claude renames confirmed sessions independently of unsupported timing', async () => {
	const fixture = await createClaudeManager({ timeSpentImplementing: 500,
		claudeChat: { sessions: [{ sessionId: '11111111-1111-4111-8111-111111111111',
			projectPath: '/tmp/workspace', accountedMs: 100 }] } });
	fixture.service.readSession = async () => { throw new Error('unsupported transcript'); };
	let renames = 0;
	fixture.service.renameSession = async () => { renames++; };
	await (fixture.manager as any).refreshClaudePrompt(fixture.initialPrompt);
	await (fixture.manager as any).refreshClaudePrompt(fixture.initialPrompt);
	assert.equal(renames, 1);
	assert.equal(fixture.getStoredPrompt()?.timeSpentImplementing, 500);
	fixture.manager.disposeAll();
});

/** Прирост Copilot добавляется один раз поверх сохранённого Claude-времени. */
test('mixed-provider refresh preserves Claude time with one Copilot baseline', async () => {
	const fixture = await createClaudeManager({ chatTarget: 'copilot', timeSpentImplementing: 2300,
		chatSessionIds: ['old-copilot'], claudeChat: { sessions: [], copilotAccountedMs: 300 } });
	(fixture.manager as any).stateService.getChatSessionsTotalElapsed = async () => 400;
	await (fixture.manager as any).refreshPromptFromTrackedChatSessions('prompt-a', null, undefined, 'test');
	await (fixture.manager as any).refreshPromptFromTrackedChatSessions('prompt-a', null, undefined, 'test');
	assert.equal(fixture.getStoredPrompt()?.timeSpentImplementing, 2400);
	assert.equal(fixture.getStoredPrompt()?.claudeChat.copilotAccountedMs, 400);
	fixture.manager.disposeAll();
});

/** Изменённый извне config не позволяет переименовать разговор другого проекта. */
test('Claude ignores persisted bindings and launch scopes outside the workspace', async () => {
	const fixture = await createClaudeManager({ claudeChat: {
		sessions: [{ sessionId: '11111111-1111-4111-8111-111111111111', projectPath: '/other-project', accountedMs: 0 }],
		pendingLaunch: { marker: '[[prompt-manager-claude:22222222-2222-4222-8222-222222222222]]',
			projectPaths: ['/other-project'], startedAt: 1000 },
	} });
	let accesses = 0;
	fixture.service.findSession = fixture.service.readSession = fixture.service.renameSession
		= fixture.service.hasSession = async () => { accesses++; };
	await (fixture.manager as any).refreshClaudePrompt(fixture.initialPrompt);
	await fixture.send({ type: 'openChat', id: 'prompt-a' });
	assert.equal(accesses, 0);
	assert.equal(vscodeCommandCalls.some(call => call.id === 'claude-vscode.primaryEditor.open'), false);
	assert.equal(vscodeCommandCalls.some(call => call.id === 'claude-vscode.editor.open'), false);
	fixture.manager.disposeAll();
});

/** Активная вкладка не доказывает фокус composer: неизвестная поверхность не получает Enter. */
test('Claude does not send Xdotool keys without verified composer focus even when enabled', async () => {
	const fixture = await createClaudeManager({ autoStartChatWithXdotool: true });
	createVsCodeTab('claudeVSCodePanel', 'Claude Code');
	await fixture.send({ type: 'startChat', id: 'prompt-a' });
	assert.equal(childProcessSpawnCalls.length, 0);
	assert.ok(fixture.messages.some(message => message.type === 'info' && /input focus cannot be verified/.test(message.message)));
	assert.ok(fixture.getStoredPrompt()?.claudeChat.pendingLaunch);
	fixture.manager.disposeAll();
});

test('startChat dispatches Kilo Code target through bridge without Copilot session binding', async () => {
	resetVsCodeCommandMock();
	vscodeAvailableCommands = ['kilo-code.new.startTask'];

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			chatTarget: 'kilo',
			chatMode: 'plan',
			contextFiles: ['src/index.ts'],
			content: 'Implement Kilo routing.',
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => '',
		},
	});

	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		chatTarget: 'kilo',
		chatMode: 'plan',
		contextFiles: ['src/index.ts'],
		content: 'Implement Kilo routing.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-kilo' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	const bridgeCall = vscodeCommandCalls.find(call => call.id === 'kilo-code.new.startTask');
	assert.ok(bridgeCall);
	const bridgePayload = bridgeCall.args[0] as any;
	assert.equal(bridgePayload.source, 'prompt-manager');
	assert.equal(bridgePayload.promptId, 'prompt-a');
	assert.equal(bridgePayload.mode, 'plan');
	assert.match(bridgePayload.text, /Implement Kilo routing/);
	assert.match(bridgePayload.text, /## Work mode/);
	assert.match(bridgePayload.text, /Create a detailed implementation plan first/);
	assert.deepEqual(bridgePayload.files, ['/tmp/workspace/src/index.ts']);
	assert.equal(vscodeCommandCalls.some(call => call.id.startsWith('workbench.action.chat.')), false);
	assert.equal(getStoredPrompt()?.status, 'in-progress');
	assert.deepEqual(getStoredPrompt()?.chatSessionIds, []);
	assert.ok(postedMessages.some(message => message?.type === 'chatStarted'));
	assert.ok(postedMessages.some(message => message?.type === 'chatOpened'));
	resetVsCodeCommandMock();
});

/** Команда Kilo получает полный запрос без лишнего обращения к clipboard клиента. */
test('startChat prepares Kilo Code context without a redundant clipboard write', async () => {
	resetVsCodeCommandMock();
	let insertedText = '';
	vscodeExecuteCommandHandler = async id => {
		if (id === 'kilo-code.new.addToContext') {
			insertedText = vscodeActiveTextEditor.document.getText();
		}
	};
	vscodeAvailableCommands = ['kilo-code.new.addToContext', 'kilo-code.new.focusChatInput'];

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			chatTarget: 'kilo',
			chatMode: 'plan',
			contextFiles: ['src/index.ts'],
			content: 'Implement Kilo routing.',
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => '',
		},
	});

	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		chatTarget: 'kilo',
		chatMode: 'plan',
		contextFiles: ['src/index.ts'],
		content: 'Implement Kilo routing.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-kilo-missing' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.equal(getStoredPrompt()?.status, 'in-progress');
	assert.equal(vscodeCommandCalls.some(call => call.id === 'kilo-code.new.startTask'), false);
	assert.ok(vscodeCommandCalls.some(call => call.id === 'kilo-code.new.addToContext'));
	assert.ok(vscodeClosedTabs.some(tab => tab.input?.uri?.fsPath?.includes('prompt-manager-kilo-context')));
	assert.equal(vscodeWorkspaceFiles.size, 0);
	assert.equal(vscodeCommandCalls.some(call => call.id === 'workbench.action.revertAndCloseActiveEditor'), false);
	assert.equal(vscodeCommandCalls.some(call => call.id === 'workbench.action.closeActiveEditor'), false);
	assert.ok(vscodeCommandCalls.some(call => call.id === 'kilo-code.SidebarProvider.focus'));
	assert.ok(vscodeCommandCalls.some(call => call.id === 'kilo-code.new.focusChatInput'));
	assert.equal(vscodeClipboardText, '');
	assert.match(insertedText, /Implement Kilo routing/);
	assert.match(insertedText, /## Work mode/);
	assert.match(insertedText, /Create a detailed implementation plan first/);
	assert.match(insertedText, /@\/tmp\/workspace\/src\/index\.ts/);
	assert.ok(postedMessages.some(message => message?.type === 'chatOpened'));
	assert.ok(postedMessages.some(message => message?.type === 'info' && /Add to Context/.test(message.message)));
	assert.equal(postedMessages.some(message => message?.type === 'error'), false);
	assert.equal(postedMessages.some(message => message?.type === 'chatStarted'), false);
	resetVsCodeCommandMock();
});

test('startChat auto-sends Kilo Code fallback after closing the temporary context editor', async () => {
	resetVsCodeCommandMock();
	vscodeAvailableCommands = ['kilo-code.new.addToContext', 'kilo-code.new.focusChatInput'];
	childProcessSpawnHandler = () => createMockChildProcessExit(0);
	const originalDisplay = process.env.DISPLAY;
	process.env.DISPLAY = originalDisplay || ':99';

	try {
		const { manager, getStoredPrompt } = await createManager({
			initialPrompt: {
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt title',
				status: 'draft',
				chatTarget: 'kilo',
				autoStartChatWithXdotool: true,
				contextFiles: ['src/index.ts'],
				content: 'Implement Kilo routing.',
			},
			stateService: {
				saveLastPromptId: async () => undefined,
				getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
				saveSidebarState: async () => undefined,
				getGlobalAgentContext: () => '',
			},
		});

		(manager as any).isXdotoolPlatformSupported = () => true;
		(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
		(manager as any).clearPromptPlanFileIfExists = async () => undefined;

		const postedMessages: any[] = [];
		const panel = {
			visible: true,
			webview: {
				postMessage: async (message: unknown) => {
					postedMessages.push(message);
					return true;
				},
			},
		} as any;
		const currentPrompt = createPrompt({
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			chatTarget: 'kilo',
			autoStartChatWithXdotool: true,
			contextFiles: ['src/index.ts'],
			content: 'Implement Kilo routing.',
		});

		await (manager as any).handleMessage(
			{ type: 'startChat', id: 'prompt-a', requestId: 'req-kilo-xdotool' },
			panel,
			currentPrompt,
			'__prompt_editor_singleton__',
			() => false,
			() => undefined,
		);

		assert.equal(getStoredPrompt()?.status, 'in-progress');
		assert.equal(childProcessSpawnCalls.length, 1);
		assert.match(childProcessSpawnCalls[0]?.command || '', /xdotool$/);
		assert.deepEqual(childProcessSpawnCalls[0]?.args, ['key', '--clearmodifiers', 'Return']);
		assert.ok(vscodeClosedTabs.some(tab => tab.input?.uri?.fsPath?.includes('prompt-manager-kilo-context')));
		assert.equal(vscodeWorkspaceFiles.size, 0);
		assert.equal(vscodeCommandCalls.some(call => call.id === 'workbench.action.revertAndCloseActiveEditor'), false);
		assert.ok(vscodeCommandCalls.some(call => call.id === 'kilo-code.SidebarProvider.focus'));
		assert.ok(vscodeCommandCalls.some(call => call.id === 'kilo-code.new.focusChatInput'));
		assert.ok(postedMessages.some(message => message?.type === 'chatStarted'));
		assert.ok(postedMessages.some(message => message?.type === 'chatRequestStarted'));
		assert.ok(postedMessages.some(message => message?.type === 'info' && /xdotool/.test(message.message)));
	} finally {
		if (originalDisplay === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDisplay;
		}
		resetVsCodeCommandMock();
	}
});

/** DISPLAY на сервере не даёт права отправлять клавиши вместо браузерного/удалённого клиента. */
for (const client of [{ uiKind: 2, remoteName: 'tunnel' }, { uiKind: 1, remoteName: 'ssh-remote' }]) {
	test(`external chat rejects server keyboard automation for ${client.remoteName}`, async () => {
		resetVsCodeCommandMock();
		vscodeUiKind = client.uiKind;
		vscodeRemoteName = client.remoteName;
		try {
			const { manager } = await createManager();
			const input = { autoStartChatWithXdotool: true };
			assert.equal((await (manager as any).runXdotoolEnter()).ok, false);
			assert.equal((await (manager as any).maybeSubmitKiloPromptWithXdotool(input, [])).ok, false);
			assert.equal((await (manager as any).prepareCodexPromptWithXdotool(input, 'text')).ok, false);
			assert.deepEqual(childProcessSpawnCalls, []);
			assert.deepEqual(vscodeCommandCalls, []);
		} finally {
			resetVsCodeCommandMock();
		}
	});
}

test('Kilo Code xdotool fallback reports startup errors', async () => {
	resetVsCodeCommandMock();
	childProcessSpawnHandler = () => createMockChildProcessError('spawn xdotool ENOENT');
	const originalDisplay = process.env.DISPLAY;
	process.env.DISPLAY = originalDisplay || ':99';

	try {
		const { manager } = await createManager();
		(manager as any).isXdotoolPlatformSupported = () => true;
		const result = await (manager as any).runXdotoolEnter();

		assert.equal(result.ok, false);
		assert.match(result.reason, /ENOENT/);
		assert.equal(childProcessSpawnCalls.length, 1);
		assert.match(childProcessSpawnCalls[0]?.command || '', /xdotool$/);
	} finally {
		if (originalDisplay === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDisplay;
		}
		resetVsCodeCommandMock();
	}
});

test('startChat dispatches Codex direct bridge with selected chat mode', async () => {
	resetVsCodeCommandMock();
	vscodeAvailableCommands = ['chatgpt.startThread'];

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			chatTarget: 'codex',
			chatMode: 'plan',
			contextFiles: ['src/index.ts'],
			content: 'Implement Codex routing.',
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => '',
		},
	});

	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		chatTarget: 'codex',
		chatMode: 'plan',
		contextFiles: ['src/index.ts'],
		content: 'Implement Codex routing.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-codex-direct' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	const bridgeCall = vscodeCommandCalls.find(call => call.id === 'chatgpt.startThread');
	assert.ok(bridgeCall);
	const bridgePayload = bridgeCall.args[0] as any;
	assert.equal(bridgePayload.source, 'prompt-manager');
	assert.equal(bridgePayload.promptId, 'prompt-a');
	assert.equal(bridgePayload.mode, 'plan');
	assert.match(bridgePayload.text, /Implement Codex routing/);
	assert.match(bridgePayload.text, /## Work mode/);
	assert.match(bridgePayload.text, /Create a detailed implementation plan first/);
	assert.deepEqual(bridgePayload.files, ['/tmp/workspace/src/index.ts']);
	assert.equal(getStoredPrompt()?.status, 'in-progress');
	assert.ok(postedMessages.some(message => message?.type === 'chatStarted'));
	assert.ok(postedMessages.some(message => message?.type === 'chatOpened'));
	resetVsCodeCommandMock();
});

/** Проверяет подготовку composer без запуска внутренней TODO-команды и без автоматической отправки. */
test('startChat prepares Codex composer without auto-submit when implementTodo is available', async () => {
	resetVsCodeCommandMock();
	vscodeAvailableCommands = ['editor.action.clipboardPasteAction', 'chatgpt.sidebarSecondaryView.focus', 'chatgpt.openSidebar', 'chatgpt.newChat', 'chatgpt.implementTodo', 'chatgpt.addToThread', 'chatgpt.addFileToThread'];
	childProcessSpawnHandler = (_command, args) => {
		if (args[0] === 'getactivewindow') {
			return createMockChildProcessExit(0, '42\n');
		}
		if (args[0] === 'getwindowpid') {
			return createMockChildProcessExit(0, '4242\n');
		}
		return args[0] === 'getwindowgeometry'
			? createMockChildProcessExit(0, 'X=0\nY=0\nWIDTH=1200\nHEIGHT=800\nSCREEN=0\n')
			: createMockChildProcessExit(0);
	};
	const originalDisplay = process.env.DISPLAY;
	process.env.DISPLAY = originalDisplay || ':99';

	try {
		const { manager, getStoredPrompt } = await createManager({
			initialPrompt: {
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt title',
				status: 'draft',
				chatTarget: 'codex',
				chatMode: 'plan',
				contextFiles: ['src/index.ts'],
				content: 'Implement Codex routing.',
			},
			stateService: {
				saveLastPromptId: async () => undefined,
				getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
				saveSidebarState: async () => undefined,
				getGlobalAgentContext: () => '',
			},
		});

		let clearedPlanCount = 0;
		(manager as any).isXdotoolPlatformSupported = () => true;
		(manager as any).isVisualStudioCodeWindowProcess = () => true;
		(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
		(manager as any).clearPromptPlanFileIfExists = async () => {
			clearedPlanCount += 1;
		};

		const postedMessages: any[] = [];
		const panel = {
			visible: true,
			webview: {
				postMessage: async (message: unknown) => {
					postedMessages.push(message);
					return true;
				},
			},
		} as any;
		const currentPrompt = createPrompt({
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			chatTarget: 'codex',
			chatMode: 'plan',
			contextFiles: ['src/index.ts'],
			content: 'Implement Codex routing.',
		});

		await (manager as any).handleMessage(
			{ type: 'startChat', id: 'prompt-a', requestId: 'req-codex-prepare' },
			panel,
			currentPrompt,
			'__prompt_editor_singleton__',
			() => false,
			() => undefined,
		);

		assert.equal(vscodeCommandCalls.some(call => call.id === 'chatgpt.implementTodo'), false);
		assert.ok(vscodeCommandCalls.some(call => call.id === 'chatgpt.openSidebar'));
		const newChatCallIndex = vscodeCommandCalls.findIndex(call => call.id === 'chatgpt.newChat');
		const fileCallIndexes = vscodeCommandCalls
			.map((call, index) => call.id === 'chatgpt.addFileToThread' ? index : -1)
			.filter(index => index >= 0);
		assert.ok(newChatCallIndex >= 0);
		assert.equal(vscodeCommandCalls.some(call => call.id === 'chatgpt.addToThread'), false);
		assert.equal(fileCallIndexes.length, 1);
		assert.ok(fileCallIndexes[0] > newChatCallIndex);
		const fileCall = vscodeCommandCalls[fileCallIndexes[0]];
		assert.equal((fileCall.args[0] as any)?.fsPath, '/tmp/workspace/src/index.ts');
		assert.deepEqual(childProcessSpawnCalls, []);
		const pasteIndex = vscodeCommandCalls.findIndex(call => call.id === 'editor.action.clipboardPasteAction');
		assert.ok(pasteIndex > fileCallIndexes[0]);
		assert.ok(vscodeCommandCalls.some(call => call.id === 'chatgpt.sidebarSecondaryView.focus'));
		assert.equal(getStoredPrompt()?.status, 'in-progress');
		assert.equal(clearedPlanCount, 0);
		assert.match(vscodeClipboardText, /Implement Codex routing/);
		assert.match(vscodeClipboardText, /## Work mode/);
		assert.ok(postedMessages.some(message => message?.type === 'chatOpened'));
		assert.ok(postedMessages.some(message => message?.type === 'info' && /вставлен в поле сообщения/.test(message.message)));
		assert.equal(postedMessages.some(message => message?.type === 'chatStarted'), false);
		assert.equal(postedMessages.some(message => message?.type === 'chatRequestStarted'), false);
		assert.equal(postedMessages.some(message => message?.type === 'error'), false);
	} finally {
		if (originalDisplay === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDisplay;
		}
		resetVsCodeCommandMock();
	}
});

/** Проверяет безопасный clipboard fallback, когда Xdotool не смог сфокусировать composer Codex. */
test('startChat keeps Codex prompt in clipboard when xdotool preparation fails', async () => {
	resetVsCodeCommandMock();
	vscodeAvailableCommands = ['chatgpt.openSidebar', 'chatgpt.newChat', 'chatgpt.addToThread', 'chatgpt.addFileToThread'];

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			chatTarget: 'codex',
			chatMode: 'plan',
			contextFiles: ['src/index.ts'],
			content: 'Implement Codex routing.',
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => '',
		},
	});

	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	let clearedPlanCount = 0;
	(manager as any).clearPromptPlanFileIfExists = async () => {
		clearedPlanCount += 1;
	};
	(manager as any).prepareCodexPromptWithXdotool = async () => ({
		ok: false,
		reason: 'composer focus failed',
		stage: 'focus',
	});

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		chatTarget: 'codex',
		chatMode: 'plan',
		contextFiles: ['src/index.ts'],
		content: 'Implement Codex routing.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-codex-missing' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.equal(getStoredPrompt()?.status, 'in-progress');
	assert.equal(vscodeCommandCalls.some(call => call.id === 'chatgpt.startThread'), false);
	assert.equal(vscodeCommandCalls.some(call => call.id === 'chatgpt.sendMessage'), false);
	assert.ok(vscodeCommandCalls.some(call => call.id === 'chatgpt.openSidebar'));
	assert.ok(vscodeCommandCalls.some(call => call.id === 'chatgpt.newChat'));
	assert.equal(vscodeCommandCalls.some(call => call.id === 'chatgpt.addToThread'), false);
	assert.ok(vscodeCommandCalls.some(call => call.id === 'chatgpt.addFileToThread'));
	assert.equal(vscodeClosedTabs.length, 0);
	assert.equal(vscodeWorkspaceFiles.size, 0);
	assert.equal(vscodeCommandCalls.some(call => call.id === 'workbench.action.revertAndCloseActiveEditor'), false);
	assert.equal(vscodeCommandCalls.some(call => call.id === 'workbench.action.closeActiveEditor'), false);
	assert.match(vscodeClipboardText, /Implement Codex routing/);
	assert.match(vscodeClipboardText, /## Work mode/);
	assert.match(vscodeClipboardText, /Create a detailed implementation plan first/);
	assert.deepEqual(childProcessSpawnCalls, []);
	assert.equal(clearedPlanCount, 0);
	assert.ok(postedMessages.some(message => message?.type === 'chatOpened'));
	assert.ok(postedMessages.some(message => message?.type === 'info' && /не удалось вставить/.test(message.message)));
	assert.equal(postedMessages.some(message => message?.type === 'error'), false);
	assert.equal(postedMessages.some(message => message?.type === 'chatStarted'), false);
	resetVsCodeCommandMock();
});

const codexNativePasteCommands = ['chatgpt.sidebarSecondaryView.focus', 'editor.action.clipboardPasteAction'];

/** Один файл в индексе и рабочем дереве должен открываться относительно разных версий без чтения SCM. */
test('dashboard opens the selected dirty-file comparison directly by Git URIs', async () => {
	resetVsCodeCommandMock();
	try {
		const { manager } = await createManager({
			workspaceService: { getWorkspaceFolderPaths: () => new Map([['repo', '/tmp/repo']]) },
		});
		(manager as any).gitService.getBuiltInGitApi = async () => ({
			getRepository: () => ({}),
			toGitUri: (uri: { fsPath: string }, ref: string) => ({ ...uri, ref }),
		});
		const panel = { webview: { postMessage: async () => true } };
		for (const group of ['staged', 'working-tree']) {
			await (manager as any).handleMessage(
				{ type: 'gitOverlayOpenDiff', project: 'repo', filePath: 'src/file.ts', change: { status: 'M', group } },
				panel, createPrompt(), 'panel', () => false, () => undefined,
			);
		}
		assert.deepEqual(vscodeCommandCalls.map(call => call.id), ['vscode.diff', 'vscode.diff']);
		assert.deepEqual(vscodeCommandCalls.map(call => call.args.slice(0, 2).map(uri => (uri as { ref?: string }).ref)), [
			['HEAD', ''],
			['', undefined],
		]);
		assert.equal((vscodeCommandCalls[1].args[1] as { fsPath: string }).fsPath, '/tmp/repo/src/file.ts');
	} finally {
		resetVsCodeCommandMock();
	}
});

/** Проверяет путь открытия переименованного файла и независимость чтения правой стороны от merge-base. */
test('dashboard branch diff starts right-side reads before merge base and opens the exact rename', async () => {
	resetVsCodeCommandMock();
	const base = createDeferred<string>();
	const calls: string[] = [];
	let diffDirectory: string | undefined;
	try {
		const { manager } = await createManager({
			workspaceService: { getWorkspaceFolderPaths: () => new Map([['repo', '/tmp/repo']]) },
		});
		Object.assign((manager as any).gitService, {
			getMergeBase: async () => base.promise,
			getFileContentAtRef: async (_project: string, ref: string, file: string) => {
				calls.push(ref + ':' + file);
				return ref + '\n';
			},
			getFileAuthorAtRef: async () => {
				calls.push('author');
				return 'Автор';
			},
		});
		vscodeExecuteCommandHandler = async (id, ...args) => {
			if (id !== 'vscode.diff') return;
			const [left, right, title] = args as [{ fsPath: string }, { fsPath: string }, string];
			diffDirectory = dirname(left.fsPath);
			assert.match(left.fsPath, /left-before\.ts$/);
			assert.equal(readFileSync(left.fsPath, 'utf8'), 'merge-base\n');
			assert.equal(readFileSync(right.fsPath, 'utf8'), 'origin/main\n');
			assert.match(title, /Опережающие файлы \(Автор\) \| after\.ts \| repo/);
		};
		const open = (manager as any).openPromptDashboardFilePatch({
			project: 'repo', filePath: 'after.ts', previousPath: 'before.ts', mode: 'branch', ref: 'origin/main',
		});
		assert.deepEqual(calls, ['origin/main:after.ts', 'author']);
		base.resolve('merge-base');
		await open;
		assert.equal(calls.at(-1), 'merge-base:before.ts');
		assert.deepEqual(vscodeCommandCalls.map(call => call.id), ['vscode.diff']);
	} finally {
		if (diffDirectory) rmSync(diffDirectory, { recursive: true, force: true });
		resetVsCodeCommandMock();
	}
});

/** Сообщение после подтверждения виджетом, пока ещё хватает времени на штатную вставку. */
function quickCommandInsert(requestId: string, target: DashboardQuickCommandTarget, text = '/review') {
	return { type: 'promptDashboardQuickCommandInsert', requestId, text, target, promptUuid: 'uuid-a', promptId: 'prompt-a',
		hostDeadline: performance.now() + DASHBOARD_QUICK_COMMAND_REPLY_TIMEOUT_MS };
}

/** Предпросмотр, вставка и копирование получают один текст. Только действия пользователя меняют чат и буфер. */
test('quick command preview, insert, copy and manual fallback use the originating prompt and its workspace', async () => {
	resetVsCodeCommandMock();
	const prompt = createPrompt({ taskNumber: '007', title: 'Проверка' });
	const { manager } = await createManager({ storageDirectoryPath: '/stored', initialPrompt: prompt });
	const replies: unknown[] = [];
	const panel = { webview: { postMessage: async (message: unknown) => { replies.push(message); return true; } } };
	const handle = (message: object) => (manager as any).handleMessage(message, panel, prompt, 'panel', () => false, () => undefined);
	const template = '  {{workspaceName}}\n{{workspacePath}}\n{{workspaceRelativePath}}\n{{taskNumber}} {{promptTitle}}\n{{promptDirectory}}  ';
	const expected = `  workspace\n/tmp/workspace\n${relative(homedir(), '/tmp/workspace')}\n007 Проверка\n/stored/prompts/prompt-a  `;
	const draft = createMockNativeChatInput();
	vscodeExecuteCommandHandler = async (id, query) => {
		if (id === 'workbench.action.chat.open') draft.setText((query as { query: string }).query);
	};
	try {
		vscodeClipboardText = 'Исходный буфер';
		await handle({ type: 'promptDashboardQuickCommandPreview', requestId: 'preview', promptId: prompt.id, promptUuid: prompt.promptUuid, text: template });
		assert.deepEqual(replies, [{ type: 'promptDashboardQuickCommandPreviewResult', requestId: 'preview', result: { text: expected } }]);
		assert.equal(vscodeClipboardText, 'Исходный буфер');
		assert.deepEqual(vscodeCommandCalls, []);
		assert.equal(vscodeNotices.length, 0);
		await handle(quickCommandInsert('insert', 'copilot', template));
		assert.deepEqual(vscodeCommandCalls.at(-1), { id: 'workbench.action.chat.open', args: [{ query: expected, isPartialQuery: true }] });
		assert.equal(vscodeNotices.length, 0);
		await handle({ type: 'promptDashboardQuickCommandCopy', promptId: prompt.id, promptUuid: prompt.promptUuid, text: template });
		assert.equal(vscodeClipboardText, expected);
		vscodeClipboardText = '';
		await handle(quickCommandInsert('manual', 'opencode-cli', template));
		assert.equal(vscodeClipboardText, expected);
		assert.equal(vscodeNotices.at(-1)?.kind, 'error');
	} finally {
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** Архивирование или удаление открытого каталога обновляет предпросмотр даже без изменений полей формы. */
test('quick command preview invalidates when its prompt directory moves in another window', async () => {
	const prompt = createPrompt();
	const { manager } = await createManager();
	const replies: unknown[] = [];
	(manager as any).setPanelPromptRef('panel', prompt);
	(manager as any).resolveOpenEditorPanel = () => ({ webview: { postMessage: async (message: unknown) => { replies.push(message); return true; } } });
	const change = { id: prompt.id, archived: false, kind: 'deleted' as const, config: null,
		uri: { fsPath: '/old/config.json' } as import('vscode').Uri, externalChangedAt: null };
	try {
		await manager.handleExternalPromptConfigChanges([{ ...change, id: 'other' }]);
		assert.deepEqual(replies, []);
		await manager.handleExternalPromptConfigChanges([change, { ...change, id: 'renamed', kind: 'created', archived: true, config: prompt }]);
		assert.deepEqual(replies, [{ type: 'promptDashboardQuickCommandPreviewInvalidated' }]);
	} finally {
		manager.disposeAll();
	}
});

/** Пустой текст, неизвестное значение известной переменной и смена промпта не трогают чат и буфер. */
test('empty quick commands, missing values and stale prompt requests warn without side effects', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager();
	const prompt = createPrompt({ id: '', taskNumber: '' });
	const replies: Array<{ type: string; requestId: string; result?: { error: string } }> = [];
	const panel = { webview: { postMessage: async (message: typeof replies[number]) => { replies.push(message); return true; } } };
	vscodeClipboardText = 'Сохранить буфер';
	try {
		for (const [template, source, id, explanation] of [
			[' \n ', 'uuid-a', '', 'Не задан текст команды'], ['задача {{taskNumber}}', 'uuid-a', '', '{{taskNumber}}'],
			['{{promptDirectory}}', 'uuid-a', '', '{{promptDirectory}}'], ['текст', 'другой', '', 'Открыт другой промпт'],
			['текст', 'uuid-a', 'копия', 'Открыт другой промпт'],
		]) {
			vscodeNotices.length = 0;
			await (manager as any).handleMessage({ type: 'promptDashboardQuickCommandPreview', requestId: 'check',
				text: template, promptUuid: source, promptId: id }, panel, prompt, 'panel', () => false, () => undefined);
			assert.equal(replies.at(-1)?.type, 'promptDashboardQuickCommandPreviewResult');
			assert.equal(replies.at(-1)?.requestId, 'check');
			assert.ok(replies.at(-1)?.result?.error.includes(explanation));
			assert.equal(vscodeNotices.length, 0);
			for (const message of [quickCommandInsert('invalid', 'copilot', template), { type: 'promptDashboardQuickCommandCopy', text: template }]) {
				vscodeNotices.length = 0;
				await (manager as any).handleMessage({ ...message, promptUuid: source, promptId: id }, panel, prompt, 'panel', () => false, () => undefined);
				assert.equal(vscodeNotices.length, 1);
				assert.equal(vscodeNotices[0].kind, 'warning');
				assert.ok(vscodeNotices[0].message.includes(explanation));
			}
		}
		assert.deepEqual(vscodeCommandCalls, []);
		assert.equal(vscodeClipboardText, 'Сохранить буфер');
	} finally {
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** Просроченная доставка в любую сторону Tunnel не запускает вставку. У клиента и хоста разные часы. */
test('dashboard quick commands require a current confirmation from the originating widget', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager();
	const replies: any[] = [];
	const panel = { webview: { postMessage: async (reply: unknown) => { replies.push(reply); return true; } } };
	const deliver = (message: object) => (manager as any).handleMessage(
		message, panel, createPrompt(), 'panel', () => false, () => undefined,
	);
	const dispatched: string[] = [];
	(manager as any).insertDashboardQuickCommand = async (_target: string, _uuid: string, text: string) => {
		dispatched.push(text);
		return 'dispatched';
	};
	const clientTime = 900_000;
	const pending: PendingDashboardQuickCommand = { requestId: 'first', promptId: 'prompt-a', promptUuid: 'uuid-a', text: '/review', target: 'codex',
		clientDeadline: clientTime + DASHBOARD_QUICK_COMMAND_REPLY_TIMEOUT_MS, sent: false };
	try {
		await deliver({ type: 'promptDashboardQuickCommandPrepare', requestId: pending.requestId });
		const ready = replies.shift();
		assert.equal(ready.type, 'promptDashboardQuickCommandReady');
		assert.equal(ready.requestId, 'first');
		// Виджет уже закончил ожидание, начал новую попытку или пока не успел обработать свой таймер.
		assert.equal(confirmDashboardQuickCommand(null, ready.requestId, ready.hostTime, clientTime), undefined);
		assert.equal(confirmDashboardQuickCommand({ ...pending, requestId: 'second' }, ready.requestId, ready.hostTime, clientTime), undefined);
		assert.equal(confirmDashboardQuickCommand(pending, ready.requestId, ready.hostTime, pending.clientDeadline), undefined);
		const late = confirmDashboardQuickCommand({ ...pending }, ready.requestId, ready.hostTime - 1_000, pending.clientDeadline - 100);
		assert.ok(late);
		await deliver(late);
		assert.deepEqual(dispatched, []);
		assert.deepEqual(replies.shift(), { type: 'promptDashboardQuickCommandFinished', requestId: 'first', expired: true });
		const valid = confirmDashboardQuickCommand(pending, ready.requestId, ready.hostTime, clientTime + 100);
		assert.ok(valid);
		assert.equal(confirmDashboardQuickCommand(pending, ready.requestId, ready.hostTime, clientTime + 101), undefined);
		await deliver(valid);
		assert.deepEqual(dispatched, ['/review']);
		assert.deepEqual(replies, [{ type: 'promptDashboardQuickCommandFinished', requestId: 'first' }]);
	} finally {
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** Проверяет передачу быстрой команды как частичного запроса Copilot. */
test('dashboard quick command populates the Copilot draft without sending', async () => {
	resetVsCodeCommandMock();
	const draft = createMockNativeChatInput();
	vscodeExecuteCommandHandler = async id => {
		if (id === 'workbench.action.chat.open') draft.setText('/review');
	};
	try {
		const { manager } = await createManager();
		const panel = { webview: { postMessage: async () => true } };
		await (manager as any).handleMessage(quickCommandInsert('copilot', 'copilot'),
			panel, createPrompt(), 'panel', () => false, () => undefined);
		assert.deepEqual(vscodeCommandCalls, [
			{ id: 'workbench.action.chat.open', args: [{ query: '/review', isPartialQuery: true }] },
		]);
		assert.equal(vscodeClipboardText, '');
		assert.deepEqual(childProcessSpawnCalls, []);
		assert.deepEqual(vscodeNotices, []);
	} finally {
		resetVsCodeCommandMock();
	}
});

/** Для обоих вариантов адресата проверяет место фокуса, текст вставки и отсутствие открытия новой сессии. */
test('Claude quick command pastes once into the existing conversation', async t => {
	const text = '/review\nвторая строка';
	const paste = 'editor.action.clipboardPasteAction';
	for (const scenario of [
		{ name: 'explicit primary sidebar', sidebar: 'claudeVSCodeSidebar', target: 'claude' },
		{ name: 'current secondary sidebar', sidebar: 'claudeVSCodeSidebarSecondary', target: 'current' },
		{ name: 'editor in a split', target: 'current' },
		{ name: 'only hidden editor', target: 'claude', hidden: true },
	] as const) {
		await t.test(scenario.name, async () => {
			resetVsCodeCommandMock();
			const dashboard = seedPromptEditorTab();
			const sidebar = 'sidebar' in scenario ? scenario.sidebar : undefined;
			const hidden = 'hidden' in scenario;
			const tab = sidebar ? undefined : createVsCodeTab('mainThreadWebview-claudeVSCodePanel', 'Claude', false);
			if (tab && !hidden) {
				const group = { viewColumn: 2, tabs: [tab], activeTab: tab };
				tab.group = group;
				vscodeTabs.splice(vscodeTabs.indexOf(tab), 1);
				vscodeAdditionalTabGroups.push(group);
			}
			const focus = 'claude-vscode.focus';
			const reveal = 'claude-vscode.focusLastMessage';
			vscodeAvailableCommands = [focus, paste, reveal];
			vscodeExecuteCommandHandler = async id => {
				if (id === '_getAllCommands') return quickCommandPalette(sidebar ? [`view.${sidebar}.visible`] : []);
				if (id === reveal && tab) setImmediate(() => { dashboard.isActive = false; tab.isActive = true; });
				if (id === focus && tab && !hidden) vscodeDashboardActiveColumn = 2;
				if (id === paste) assert.equal(vscodeClipboardText, text);
			};
			const { manager } = await createManager();
			try {
				await (manager as any).handleMessage(quickCommandInsert('draft', scenario.target, text),
					{ webview: { postMessage: async () => true } }, createPrompt(), 'panel', () => false, () => undefined);
				const dispatched = vscodeCommandCalls.filter(call => !['_getAllCommands', 'vscode.getEditorLayout'].includes(call.id));
				assert.deepEqual(dispatched.map(call => call.id), [...(sidebar ? [`${sidebar}.focus`] : hidden ? [reveal] : []), focus, paste]);
				assert.ok(dispatched.every(call => !call.args.length));
				assert.deepEqual(vscodeNotices, []);
			} finally {
				manager.disposeAll();
				resetVsCodeCommandMock();
			}
		});
	}
});

/** Закрытый чат, неоднозначная раскладка и браузер оставляют команду для ручной вставки. */
test('Claude quick command falls back without opening a conversation or blindly pasting', async t => {
	for (const scenario of ['closed', 'sidebar and editor', 'web', 'lost focus', 'sidebar closed during copy', 'missing focus command']) {
		await t.test(scenario, async () => {
			resetVsCodeCommandMock();
			seedPromptEditorTab();
			const sidebar = 'claudeVSCodeSidebarSecondary';
			let visible = scenario !== 'closed';
			if (scenario === 'sidebar closed during copy') {
				vscodeClipboardWriteHandler = async value => { vscodeClipboardText = value; visible = false; };
			}
			if (scenario === 'sidebar and editor') createVsCodeTab('claudeVSCodePanel', 'Claude');
			if (scenario === 'web') vscodeUiKind = 2;
			vscodeAvailableCommands = scenario === 'missing focus command' ? ['claude-vscode.editor.open'] : ['claude-vscode.focus'];
			vscodeExecuteCommandHandler = async id => {
				if (id === '_getAllCommands') return quickCommandPalette(visible ? [`view.${sidebar}.visible`] : []);
				if (scenario === 'lost focus' && id === 'claude-vscode.focus') vscodeWindowFocused = false;
			};
			const { manager } = await createManager();
			try {
				await (manager as any).handleMessage(quickCommandInsert('draft', 'claude'),
					{ webview: { postMessage: async () => true } }, createPrompt(), 'panel', () => false, () => undefined);
				const actions = vscodeCommandCalls.map(call => call.id).filter(id => id !== '_getAllCommands');
				const startedFocus = scenario === 'lost focus' || scenario === 'sidebar closed during copy';
				assert.deepEqual(actions, startedFocus ? [`${sidebar}.focus`, 'claude-vscode.focus'] : []);
				assert.equal(vscodeClipboardText, '/review');
				assert.match(vscodeNotices[0].message, /Команда скопирована/);
			} finally {
				manager.disposeAll();
				resetVsCodeCommandMock();
			}
		});
	}
});

/** Текущий встроенный чат подтверждает фактическое изменение поля после завершения команды. */
test('Current quick command awaits the native draft and acknowledges the original request', async () => {
	resetVsCodeCommandMock();
	const ready = createDeferred<void>();
	const draft = createMockNativeChatInput();
	vscodeExecuteCommandHandler = async id => id === 'workbench.action.chat.open' ? ready.promise : undefined;
	const { manager } = await createManager();
	const replies: unknown[] = [];
	const panel = { webview: { postMessage: async (reply: unknown) => replies.push(reply) } };
	try {
		const pending = (manager as any).handleMessage(
			quickCommandInsert('current', 'current'),
			panel, { ...createPrompt(), chatTarget: 'codex' }, 'panel', () => false, () => undefined,
		);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(vscodeCommandCalls, [
			{ id: '_getAllCommands', args: [true] },
			{ id: 'workbench.action.chat.open', args: [{ query: '/review', isPartialQuery: true }] },
		]);
		assert.deepEqual(replies, []);
		assert.deepEqual(vscodeNotices, []);
		ready.resolve();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(replies, []);
		draft.setText('/review');
		await pending;
		assert.deepEqual(replies, [{ type: 'promptDashboardQuickCommandFinished', requestId: 'current' }]);
		assert.deepEqual(vscodeNotices, []);
	} finally {
		ready.resolve();
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** Текущий агент определяется по выбранной вкладке рядом с виджетом, после чего работает штатная вставка. */
test('Current quick command selects a visible agent editor only when the Desktop target is clear', async t => {
	const codex = 'mainThreadWebview-chatgpt.panelView';
	const claude = 'mainThreadWebview-claudeVSCodePanel';
	const scenarios = [
		{ name: 'Codex editor in a split', visible: [codex], uiKind: 1, expected: 'codex' },
		{ name: 'Claude editor in a split', visible: [claude], uiKind: 1, expected: 'claude' },
		{ name: 'two different agent editors', visible: [codex, claude], uiKind: 1, expected: undefined },
		{ name: 'Codex editor in Web', visible: [codex], uiKind: 2, expected: undefined },
		{ name: 'only inactive Codex editor', visible: [], uiKind: 1, expected: undefined },
	];
	for (const scenario of scenarios) {
		await t.test(scenario.name, async () => {
			resetVsCodeCommandMock();
			vscodeUiKind = scenario.uiKind;
			createVsCodeTab(codex, 'Скрытый Codex', false);
			seedPromptEditorTab();
			for (const viewType of scenario.visible) {
				const tab = { input: { viewType } };
				vscodeAdditionalTabGroups.push({ activeTab: tab, tabs: [tab] });
			}
			const { manager } = await createManager();
			const dispatches: Array<{ target: string; text: string }> = [];
			(manager as any).insertDashboardQuickCommand = async (target: string, _promptUuid: string, text: string) => {
				dispatches.push({ target, text });
				return 'dispatched';
			};
			try {
				await (manager as any).handleMessage(
					quickCommandInsert('current', 'current'),
					{ webview: { postMessage: async () => true } }, createPrompt(), 'panel', () => false, () => undefined,
				);
				assert.deepEqual(dispatches, scenario.expected ? [{ target: scenario.expected, text: '/review' }] : []);
				assert.equal(vscodeClipboardText, scenario.expected ? '' : '/review');
			} finally {
				manager.disposeAll();
				resetVsCodeCommandMock();
			}
		});
	}
});

/** Вычисляет поддерживаемые условия манифеста для конкретного расположения окон и панелей. */
function quickCommandPalette(visible: string[], auxiliaryIndex?: number, unfiltered = false) {
	const menu: Array<{ command: string; when: string }> =
		JSON.parse(readFileSync('package.json', 'utf8')).contributes.menus.commandPalette;
	function matches(term: string) {
		if (term === 'isAuxiliaryWindowFocusedContext') return auxiliaryIndex !== undefined;
		if (term === '!isAuxiliaryWindowFocusedContext') return auxiliaryIndex === undefined;
		if (term === 'activeEditorGroupIndex <= 1') return auxiliaryIndex === 1;
		if (term === 'activeEditorGroupIndex > 1') return (auxiliaryIndex ?? 0) > 1;
		return term.startsWith('!') ? !visible.includes(term.slice(1)) : visible.includes(term);
	}
	return menu.filter(row => unfiltered || row.when.split(' || ').some(clause => clause.split(' && ').every(matches)))
		.map(row => ({ command: row.command, precondition: row.when }));
}

/** Проверяет маршрутизацию по реальным условиям обеих боковых панелей, когда фокус уже у виджета. */
test('Current quick command routes the double click to the chat visible in this window', async t => {
	const primary = 'view.chatgpt.sidebarView.visible';
	const secondary = 'view.chatgpt.sidebarSecondaryView.visible';
	const claude = 'view.claudeVSCodeSidebar.visible';
	const claudeSecondary = 'view.claudeVSCodeSidebarSecondary.visible';
	const copilot = 'view.workbench.panel.chat.view.copilot.visible';
	const cases: Array<{ name: string; visible: string[]; expected?: string; editor?: string; unfiltered?: boolean }> = [
		{ name: 'Codex primary with a stale native draft', visible: [primary], expected: 'codex' },
		{ name: 'Codex secondary through a Desktop Tunnel', visible: [secondary], expected: 'codex' },
		{ name: 'Claude primary', visible: [claude], expected: 'claude' },
		{ name: 'Claude secondary', visible: [claudeSecondary], expected: 'claude' },
		{ name: 'native chat body', visible: [copilot], expected: 'copilot' },
		{ name: 'all sidebars closed with a stale native draft', visible: [], expected: undefined },
		{ name: 'two sidebars', visible: [primary, claudeSecondary], expected: undefined },
		{ name: 'native and Codex simultaneously', visible: [copilot, secondary], expected: undefined },
		{ name: 'sidebar and different editor', visible: [primary], editor: 'claudeVSCodePanel', expected: undefined },
		{ name: 'same agent in sidebar and editor', visible: [primary], editor: 'chatgpt.panelView', expected: 'codex' },
		{ name: 'native chat in another editor group', visible: [], editor: 'native', expected: 'copilot' },
		{ name: 'native editor alongside Codex sidebar', visible: [secondary], editor: 'native', expected: undefined },
		{ name: 'VS Code 1.95 returns both alternatives', visible: [], unfiltered: true, expected: undefined },
	];
	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			resetVsCodeCommandMock();
			vscodeRemoteName = 'tunnel';
			seedPromptEditorTab();
			if (scenario.editor === 'native') {
				const tab = { input: new MockChatTabInput() };
				vscodeAdditionalTabGroups.push({ activeTab: tab, tabs: [tab] });
			} else if (scenario.editor) {
				createVsCodeTab(scenario.editor, 'Agent', true);
			}
			if (!scenario.unfiltered) createMockNativeChatInput();
			vscodeExecuteCommandHandler = async (id, ...args) => {
				assert.equal(id, '_getAllCommands');
				assert.deepEqual(args, [true]);
				return quickCommandPalette(scenario.visible, undefined, scenario.unfiltered);
			};
			const { manager } = await createManager();
			const targets: string[] = [];
			(manager as any).insertDashboardQuickCommand = async (target: string, _uuid: string, draft: string) => {
				assert.equal(draft, '/review');
				targets.push(target);
				return 'dispatched';
			};
			try {
				await (manager as any).handleMessage(
					quickCommandInsert('sidebar', 'current'),
					{ webview: { postMessage: async () => true } }, createPrompt(), 'panel', () => false, () => undefined,
				);
				assert.deepEqual(targets, scenario.expected ? [scenario.expected] : []);
				assert.equal(vscodeClipboardText, scenario.expected ? '' : '/review');
			} finally {
				manager.disposeAll();
				resetVsCodeCommandMock();
			}
		});
	}
});

/** В одном workbench вкладки вынесенных окон имеют сквозные колонки, а боковые панели принадлежат главному. */
test('Current quick command scopes chat detection to the physical window with the dashboard', async t => {
	const codex = 'chatgpt.panelView';
	const claude = 'claudeVSCodePanel';
	const dashboard = 'promptManager.editor';
	const visibleSidebar = ['view.chatgpt.sidebarSecondaryView.visible'];
	const cases = [
		{ name: 'main sidebar with detached Claude', views: [dashboard, claude], active: 1, local: 1, sidebar: true, target: 'codex' },
		{ name: 'no chat in main window', views: [dashboard, claude], active: 1, local: 1 },
		{ name: 'main split with another floating window', views: [dashboard, codex, claude], active: 1, local: 2, target: 'codex' },
		{ name: 'dashboard alone in auxiliary', views: [claude, dashboard], active: 2, local: 1, index: 1, sidebar: true },
		{ name: 'first group in second auxiliary', views: [codex, codex, dashboard, claude], active: 3, local: 2, index: 1, sidebar: true, target: 'claude' },
		{ name: 'second group in first auxiliary', views: [codex, claude, dashboard, codex], active: 3, local: 2, index: 2, sidebar: true, target: 'claude' },
		{ name: 'indeterminate auxiliary boundaries', views: [codex, claude, codex, dashboard, claude, codex], active: 4, local: 3, index: 2 },
	];
	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			resetVsCodeCommandMock();
			createVsCodeTab(scenario.views[0], 'First editor', true);
			for (const [i, viewType] of scenario.views.slice(1).entries()) {
				const tab = { input: { viewType } };
				vscodeAdditionalTabGroups.push({ viewColumn: i + 2, activeTab: tab, tabs: [tab] });
			}
			vscodeDashboardActiveColumn = scenario.active;
			vscodeDashboardEditorLayout = { groups: [{ groups: Array.from({ length: scenario.local }, () => ({})) }] };
			vscodeExecuteCommandHandler = async () => quickCommandPalette(scenario.sidebar ? visibleSidebar : [], scenario.index);
			const { manager } = await createManager();
			try {
				assert.equal(await (manager as any).resolveCurrentDashboardQuickCommandTarget(), scenario.target);
			} finally {
				manager.disposeAll();
				resetVsCodeCommandMock();
			}
		});
	}
});

/** Запрос из потерявшей фокус панели не выбирает адресата в новом окне и сохраняет буфер обмена. */
test('Current quick command checks the source panel before and after looking up the destination', async () => {
	resetVsCodeCommandMock();
	const lookup = createDeferred<void>();
	const { manager } = await createManager();
	const panel = { active: false, webview: { postMessage: async () => true } };
	vscodeExecuteCommandHandler = async () => {
		await lookup.promise;
		return quickCommandPalette(['view.chatgpt.sidebarSecondaryView.visible']);
	};
	const insert = () => (manager as any).handleMessage(
		quickCommandInsert('source-panel', 'current'), panel, createPrompt(), 'panel', () => false, () => undefined,
	);
	try {
		await insert();
		assert.deepEqual(vscodeCommandCalls, []);
		panel.active = true;
		const pending = insert();
		panel.active = false;
		lookup.resolve();
		await pending;
		assert.deepEqual(vscodeCommandCalls, [{ id: '_getAllCommands', args: [true] }]);
		assert.equal(vscodeClipboardText, '');
		assert.equal(vscodeNotices.length, 2);
		assert.ok(vscodeNotices.every(n => n.kind === 'error' && n.message.includes('потерял фокус')));
	} finally {
		lookup.resolve();
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** Запоздалый снимок видимости после таймаута не должен инициировать вставку в чат. */
test('Current quick command discards a late lookup after the widget receives its timeout', async t => {
	resetVsCodeCommandMock();
	const palette = createDeferred<unknown>();
	const { manager } = await createManager();
	const tab = { input: { viewType: 'chatgpt.panelView' } };
	vscodeAdditionalTabGroups.push({ activeTab: tab, tabs: [tab] });
	vscodeExecuteCommandHandler = async () => palette.promise;
	const insert = t.mock.method(manager as any, 'insertDashboardQuickCommand', async () => 'dispatched');
	t.mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const pending = (manager as any).runDashboardQuickCommand('current', 'prompt', '/review');
		t.mock.timers.tick(DASHBOARD_QUICK_COMMAND_TIMEOUT_MS);
		await pending;
		palette.resolve(undefined);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(insert.mock.callCount(), 0);
		assert.equal(vscodeNotices.length, 1);
		assert.match(vscodeNotices[0].message, /Истекло время/);
	} finally {
		palette.resolve(undefined);
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** activeTerminal может указывать на скрытый терминал, открывавшийся ранее. */
test('Current quick command copies the draft when the native chat and last focused OpenCode are ambiguous', async () => {
	resetVsCodeCommandMock();
	vscodeActiveTerminal = { creationOptions: { env: { PROMPT_MANAGER_OPENCODE_UUID: 'other-prompt' } } };
	createMockNativeChatInput();
	const { manager } = await createManager();
	const insertions: unknown[][] = [];
	(manager as any).openCodeCliService = {
		insertIntoOpenChat: (...args: unknown[]) => { insertions.push(args); return true; },
		dispose: () => undefined,
	};
	try {
		await (manager as any).handleMessage(
			quickCommandInsert('cli', 'current'),
			{ webview: { postMessage: async () => true } }, createPrompt(), 'panel', () => false, () => undefined,
		);
		assert.deepEqual(insertions, []);
		assert.deepEqual(vscodeCommandCalls, [{ id: '_getAllCommands', args: [true] }]);
		assert.equal(vscodeClipboardText, '/review');
		assert.deepEqual(vscodeNotices, [{ kind: 'error', message: 'Не удалось определить текущий чат. Команда скопирована. Выберите агента или вставьте команду вручную.' }]);
	} finally {
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** Доставка команды и подтверждение содержимого поля различаются у клиентов, скрывающих модель чата. */
test('dashboard native draft distinguishes an unpublished model from an unchanged draft or rejected command', async t => {
	for (const scenario of ['hidden', 'late match', 'late mismatch', 'command rejected'] as const) {
		await t.test(scenario, async t => {
			resetVsCodeCommandMock();
			vscodeClipboardText = 'мой буфер';
			const { manager } = await createManager();
			t.mock.timers.enable({ apis: ['setTimeout'] });
			vscodeExecuteCommandHandler = async id => {
				assert.equal(id, 'workbench.action.chat.open');
				if (scenario === 'command rejected') throw new Error('Chat unavailable');
			};
			try {
				const pending = (manager as any).runDashboardQuickCommand('copilot', 'prompt', '/review');
				await new Promise<void>(resolve => setImmediate(resolve));
				if (scenario === 'late match' || scenario === 'late mismatch') {
					const model = createMockNativeChatInput();
					model.setText(scenario === 'late match' ? '/review' : 'другой текст');
				}
				t.mock.timers.tick(1500);
				await pending;
				const failed = scenario === 'late mismatch' || scenario === 'command rejected';
				assert.equal(vscodeClipboardText, failed ? '/review' : 'мой буфер');
				if (failed) {
					assert.equal(vscodeNotices.length, 1);
					assert.equal(vscodeNotices[0].kind, 'error');
					const reason = scenario === 'late mismatch' ? 'VS Code не подтвердил вставку.' : 'Не удалось вставить команду.';
					assert.ok(vscodeNotices[0].message.startsWith(reason));
				} else {
					assert.deepEqual(vscodeNotices, []);
				}
			} finally {
				manager.disposeAll();
				resetVsCodeCommandMock();
			}
		});
	}
});

/** Команда VS Code может успешно завершиться, не изменив даже уже совпадающий текст. */
test('dashboard quick command reports an unconfirmed native draft when chat.open changes no input', async t => {
	resetVsCodeCommandMock();
	createMockNativeChatInput('@participant /review');
	const { manager } = await createManager();
	const initialListeners = vscodeTextDocumentChangeListeners.size;
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const replies: unknown[] = [];
	try {
		const pending = (manager as any).handleMessage(
			quickCommandInsert('no-op', 'copilot', '@participant /review'),
			{ webview: { postMessage: async (reply: unknown) => replies.push(reply) } },
			createPrompt(), 'panel', () => false, () => undefined,
		);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(vscodeNotices.length, 0);
		assert.equal(vscodeTextDocumentChangeListeners.size, initialListeners + 1);
		t.mock.timers.tick(2000);
		await pending;
		assert.equal(vscodeClipboardText, '@participant /review');
		assert.deepEqual(replies, [{ type: 'promptDashboardQuickCommandFinished', requestId: 'no-op' }]);
		assert.equal(vscodeNotices.length, 1);
		assert.equal(vscodeNotices[0].kind, 'error');
		assert.match(vscodeNotices[0].message, /VS Code не подтвердил вставку.*Команда скопирована/);
		assert.equal(vscodeTextDocumentChangeListeners.size, initialListeners);
	} finally {
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** Запоздавшая активация провайдера не вставляет команду после таймаута и освобождения виджета. */
test('dashboard quick command times out a hung activation and releases copy without inserting late', async t => {
	resetVsCodeCommandMock();
	const activation = createDeferred<void>();
	vscodeClaudeExtension = { isActive: false, activate: () => activation.promise };
	vscodeAvailableCommands = ['claude-vscode.focus'];
	const { manager } = await createManager();
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const replies: unknown[] = [];
	const handle = (message: object) => (manager as any).handleMessage(
		message, { webview: { postMessage: async (reply: unknown) => replies.push(reply) } },
		createPrompt(), 'panel', () => false, () => undefined,
	);
	try {
		const pending = handle(quickCommandInsert('hung', 'claude'));
		assert.deepEqual(replies, []);
		t.mock.timers.tick(DASHBOARD_QUICK_COMMAND_TIMEOUT_MS);
		await pending;
		await handle({ type: 'promptDashboardQuickCommandCopy', promptId: 'prompt-a', promptUuid: 'uuid-a', text: '/next' });
		activation.resolve();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(vscodeCommandCalls, []);
		assert.equal(vscodeClipboardText, '/next');
		assert.deepEqual(replies, [{ type: 'promptDashboardQuickCommandFinished', requestId: 'hung' }]);
		assert.deepEqual(vscodeNotices.map(notice => notice.kind), ['error', 'info']);
		assert.match(vscodeNotices[0].message, /Истекло время ожидания вставки/);
	} finally {
		activation.resolve();
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** Local X11 insertion targets the composer and ignores the prompt's automatic submit setting. */
test('dashboard quick command prepares a Codex composer draft on local X11', async () => {
	resetVsCodeCommandMock();
	const originalDisplay = process.env.DISPLAY;
	process.env.DISPLAY = ':99';
	try {
		const { manager } = await createManager();
		const drafts: Array<{ text: string; autoStart: boolean }> = [];
		(manager as any).isXdotoolPlatformSupported = () => true;
		(manager as any).prepareCodexPromptWithXdotool = async (
			prompt: { autoStartChatWithXdotool: boolean }, text: string,
		) => {
			drafts.push({ text, autoStart: prompt.autoStartChatWithXdotool });
			return { ok: true, stage: 'paste' };
		};
		await (manager as any).handleMessage(
			quickCommandInsert('desktop', 'codex'),
			{ webview: { postMessage: async () => true } },
			{ ...createPrompt(), autoStartChatWithXdotool: true }, 'panel', () => false, () => undefined,
		);
		assert.deepEqual(drafts, [{ text: '/review', autoStart: false }]);
		assert.deepEqual(vscodeCommandCalls, []);
		assert.equal(vscodeClipboardText, '');
	} finally {
		if (originalDisplay === undefined) delete process.env.DISPLAY;
		else process.env.DISPLAY = originalDisplay;
		resetVsCodeCommandMock();
	}
});

/** Проверяет отказ браузерной вставки на фактической точке входа быстрых команд. */
test('dashboard quick command copies Codex draft in the browser without dispatching paste', async () => {
	resetVsCodeCommandMock();
	vscodeUiKind = 2;
	vscodeRemoteName = 'tunnel';
	vscodeAvailableCommands = codexNativePasteCommands;
	vscodeExecuteCommandHandler = async id => {
		if (id === 'chatgpt.openSidebar') assert.equal(vscodeClipboardText, '/review');
	};
	try {
		const { manager } = await createManager();
		const replies: unknown[] = [];
		await (manager as any).handleMessage(
			quickCommandInsert('browser', 'codex'),
			{ webview: { postMessage: async (reply: unknown) => replies.push(reply) } },
			createPrompt(), 'panel', () => false, () => undefined,
		);
		assert.deepEqual(vscodeCommandCalls.map(call => call.id), ['chatgpt.openSidebar']);
		assert.equal(vscodeClipboardText, '/review');
		assert.deepEqual(replies, [{ type: 'promptDashboardQuickCommandFinished', requestId: 'browser' }]);
		assert.equal(vscodeNotices.length, 1);
		assert.equal(vscodeNotices[0].kind, 'error');
		assert.match(vscodeNotices[0].message, /Не удалось вставить.*Ctrl\+V/);
	} finally {
		resetVsCodeCommandMock();
	}
});

/** Копирование сообщает об успехе после записи и об отказе при недоступном буфере. */
test('Quick Command copy uses the clipboard without focusing any chat', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager();
	const copy = () => (manager as any).handleMessage(
		{ type: 'promptDashboardQuickCommandCopy', promptId: 'prompt-a', promptUuid: 'uuid-a', text: '/review' },
		{ webview: { postMessage: async () => true } }, createPrompt(), 'panel', () => false, () => undefined,
	);
	try {
		await copy();
		assert.equal(vscodeClipboardText, '/review');
		vscodeClipboardWriteHandler = async () => { throw new Error('Clipboard unavailable'); };
		await copy();
		assert.deepEqual(vscodeCommandCalls, []);
		assert.deepEqual(vscodeNotices, [
			{ kind: 'info', message: 'Команда скопирована.' },
			{ kind: 'error', message: 'Не удалось скопировать команду.' },
		]);
	} finally {
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** Доступность команды VS Code не означает поддержку paste внутри браузерного iframe. */
test('prepareCodexPrompt reports unsupported browser paste without clipboard or keyboard commands', async () => {
	resetVsCodeCommandMock();
	vscodeUiKind = 2;
	vscodeRemoteName = 'tunnel';
	try {
		const { manager } = await createManager();
		const result = await (manager as any).prepareCodexPrompt(
			{ autoStartChatWithXdotool: true }, 'Полный тестовый текст', codexNativePasteCommands,
		);
		assert.equal(result.ok, false);
		assert.equal(result.stage, 'paste');
		assert.match(result.reason, /браузер/);
		assert.equal(result.partialPaste, undefined);
		assert.equal(vscodeClipboardText, '');
		assert.deepEqual(vscodeCommandCalls, []);
		assert.deepEqual(childProcessSpawnCalls, []);
	} finally {
		resetVsCodeCommandMock();
	}
});

/** Полный Web fallback открывает чат, но не сообщает о вставке или отправке неподготовленного сообщения. */
test('dispatchCodexChatTarget keeps browser fallback text without reporting a successful insertion', async () => {
	resetVsCodeCommandMock();
	vscodeUiKind = 2;
	vscodeRemoteName = 'tunnel';
	try {
		const { manager } = await createManager();
		const result = await (manager as any).dispatchCodexChatTarget(
			createPrompt(), 'Browser prompt', [], [...codexNativePasteCommands, 'chatgpt.newChat'],
		);
		assert.equal(result.dispatched, false);
		assert.match(result.message, /не удалось вставить.*браузер/);
		assert.match(vscodeClipboardText, /Browser prompt/);
		assert.deepEqual(vscodeCommandCalls.map(call => call.id), ['chatgpt.openSidebar', 'chatgpt.newChat']);
		assert.deepEqual(childProcessSpawnCalls, []);
	} finally {
		resetVsCodeCommandMock();
	}
});

/** В браузере полный текст передаётся файлом запроса: он прикрепляется первым, сообщение не отправляется. */
test('dispatchCodexChatTarget attaches the request file in the browser without pasting or sending', async () => {
	resetVsCodeCommandMock();
	vscodeUiKind = 2;
	vscodeRemoteName = 'tunnel';
	try {
		const { manager } = await createManager();
		// Повторное прикрепление во время загрузки панели проверяется отдельным тестом.
		(manager as any).codexWebPanelLoadWindowMs = 0;
		const text = `# Задача\r\n\r\n${'я'.repeat(12000)} **MD** <tag> & 😀`;
		const contextFile = { fsPath: '/tmp/workspace/context.md', toString: () => '/tmp/workspace/context.md' };
		const result = await (manager as any).dispatchCodexChatTarget(
			createPrompt(), text, [contextFile],
			[...codexNativePasteCommands, 'chatgpt.newChat', 'chatgpt.addFileToThread'],
		);
		const requestFilePath = '/tmp/workspace/.vscode/prompt-manager/prompts/prompt-a/task.md';
		assert.equal(result.dispatched, false);
		assert.match(result.message, /прикреплён файл task\.md.*«Отправить»\. Текст задачи также скопирован в буфер обмена\.$/);
		assert.ok(vscodeWorkspaceFiles.get(requestFilePath)?.endsWith(`\n\n---\n\n${text}`));
		assert.equal(vscodeWorkspaceFiles.size, 1);
		assert.equal(vscodeClipboardText, text);
		assert.deepEqual(vscodeCommandCalls.map(call => call.id), [
			'chatgpt.openSidebar', 'chatgpt.newChat', 'chatgpt.addFileToThread', 'chatgpt.addFileToThread',
		]);
		assert.equal((vscodeCommandCalls[2].args[0] as { fsPath: string }).fsPath, requestFilePath);
		assert.equal(vscodeCommandCalls[3].args[0], contextFile);
		assert.deepEqual(childProcessSpawnCalls, []);
	} finally {
		resetVsCodeCommandMock();
	}
});

/** Отказ команды Codex или отсутствие папки промпта возвращают прежнее сообщение о ручной вставке. */
for (const failure of ['command', 'unsaved prompt'] as const) {
	test(`dispatchCodexChatTarget falls back to manual paste when the request file fails: ${failure}`, async () => {
		resetVsCodeCommandMock();
		vscodeUiKind = 2;
		vscodeRemoteName = 'tunnel';
		vscodeExecuteCommandHandler = async id => {
			if (id === 'chatgpt.addFileToThread') {
				throw new Error('Codex rejected the file');
			}
			return undefined;
		};
		try {
			const { manager } = await createManager();
			const result = await (manager as any).dispatchCodexChatTarget(
				createPrompt(failure === 'unsaved prompt' ? { id: '__new__' } : {}), 'Browser prompt', [],
				[...codexNativePasteCommands, 'chatgpt.newChat', 'chatgpt.addFileToThread'],
			);
			assert.equal(result.dispatched, false);
			assert.match(result.message, /не удалось вставить.*браузер/);
			assert.doesNotMatch(result.message, /прикреплён файл/);
			assert.equal(vscodeClipboardText, 'Browser prompt');
			assert.equal(vscodeWorkspaceFiles.size, failure === 'command' ? 1 : 0);
			assert.equal(vscodeCommandCalls.some(call => call.id === 'editor.action.clipboardPasteAction'), false);
		} finally {
			resetVsCodeCommandMock();
		}
	});
}

/** Браузер без фокуса окна не завершает запись в буфер: запуск не зависает и не сообщает о копировании. */
for (const withRequestFile of [true, false]) {
	test(`dispatchCodexChatTarget does not wait for a pending browser clipboard write: request file ${withRequestFile}`, async () => {
		resetVsCodeCommandMock();
		vscodeUiKind = 2;
		vscodeRemoteName = 'tunnel';
		vscodeClipboardWriteHandler = () => new Promise<void>(() => { });
		// Ограничивающий таймер не удерживает цикл событий, поэтому ожидание в тесте поддерживает отдельный таймер.
		const keepAlive = setTimeout(() => { }, 10_000);
		try {
			const { manager } = await createManager();
			(manager as any).codexWebPanelLoadWindowMs = 0;
			const result = await (manager as any).dispatchCodexChatTarget(
				createPrompt(), 'Browser prompt', [],
				[...codexNativePasteCommands, 'chatgpt.newChat', ...(withRequestFile ? ['chatgpt.addFileToThread'] : [])],
			);
			assert.equal(result.dispatched, false);
			assert.doesNotMatch(result.message, /скопирован в буфер обмена/);
			assert.match(result.message, withRequestFile
				? /прикреплён файл task\.md.*«Отправить»\.$/
				: /не удалось вставить текст задачи автоматически.*Браузер не подтвердил запись/);
			assert.equal(vscodeWorkspaceFiles.size, withRequestFile ? 1 : 0);
			assert.equal(vscodeClipboardText, '');
		} finally {
			clearTimeout(keepAlive);
			resetVsCodeCommandMock();
		}
	});
}

/** Отказ записи в буфер браузера не прерывает запуск: текст задачи остаётся в прикреплённом файле. */
test('dispatchCodexChatTarget keeps the request file when the browser clipboard write is rejected', async () => {
	resetVsCodeCommandMock();
	vscodeUiKind = 2;
	vscodeRemoteName = 'tunnel';
	vscodeClipboardWriteHandler = async () => {
		throw new Error('Document is not focused');
	};
	try {
		const { manager } = await createManager();
		(manager as any).codexWebPanelLoadWindowMs = 0;
		const result = await (manager as any).dispatchCodexChatTarget(
			createPrompt(), 'Browser prompt', [],
			[...codexNativePasteCommands, 'chatgpt.newChat', 'chatgpt.addFileToThread'],
		);
		assert.equal(result.dispatched, false);
		assert.match(result.message, /прикреплён файл task\.md/);
		assert.doesNotMatch(result.message, /скопирован в буфер обмена/);
		assert.equal(vscodeWorkspaceFiles.size, 1);
	} finally {
		resetVsCodeCommandMock();
	}
});

/**
 * Пока панель Codex загружается, отложенный «Новый чат» сбрасывает файлы: первый запуск в сеансе
 * повторяет прикрепление в прежнем порядке, следующие запуски прикрепляют файлы один раз.
 */
test('dispatchCodexChatTarget repeats the attachment while the Codex panel may still be loading', async () => {
	resetVsCodeCommandMock();
	vscodeUiKind = 2;
	vscodeRemoteName = 'tunnel';
	try {
		const { manager } = await createManager();
		(manager as any).codexWebPanelLoadWindowMs = 90;
		(manager as any).codexWebAttachRetryIntervalMs = 30;
		const contextFile = { fsPath: '/tmp/workspace/context.md', toString: () => '/tmp/workspace/context.md' };
		const commands = [...codexNativePasteCommands, 'chatgpt.newChat', 'chatgpt.addFileToThread'];
		const attachedPaths = () => vscodeCommandCalls
			.filter(call => call.id === 'chatgpt.addFileToThread')
			.map(call => (call.args[0] as { fsPath: string }).fsPath.split('/').pop());

		const first = await (manager as any).dispatchCodexChatTarget(createPrompt(), 'Browser prompt', [contextFile], commands);
		const firstPaths = attachedPaths();
		assert.match(first.message, /прикреплён файл task\.md/);
		assert.ok(firstPaths.length >= 4 && firstPaths.length % 2 === 0);
		assert.ok(firstPaths.every((name, index) => name === (index % 2 === 0 ? 'task.md' : 'context.md')));
		assert.equal(vscodeWorkspaceFiles.size, 1);

		vscodeCommandCalls.length = 0;
		const second = await (manager as any).dispatchCodexChatTarget(createPrompt(), 'Browser prompt', [contextFile], commands);
		assert.match(second.message, /прикреплён файл task\.md/);
		assert.deepEqual(attachedPaths(), ['task.md', 'context.md']);
	} finally {
		resetVsCodeCommandMock();
	}
});

/** Desktop сохраняет вставку текста в поле: файл запроса не создаётся и не прикрепляется. */
test('dispatchCodexChatTarget keeps the desktop paste path without a request file', async () => {
	resetVsCodeCommandMock();
	try {
		const { manager } = await createManager();
		const result = await (manager as any).dispatchCodexChatTarget(
			createPrompt(), 'Desktop prompt', [],
			[...codexNativePasteCommands, 'chatgpt.newChat', 'chatgpt.addFileToThread'],
		);
		assert.equal(result.dispatched, false);
		assert.match(result.message, /Текст задачи вставлен в поле сообщения/);
		assert.equal(vscodeWorkspaceFiles.size, 0);
		assert.equal(vscodeCommandCalls.some(call => call.id === 'chatgpt.addFileToThread'), false);
		assert.ok(vscodeCommandCalls.some(call => call.id === 'editor.action.clipboardPasteAction'));
	} finally {
		resetVsCodeCommandMock();
	}
});

/** Вставка не зависит от X11, DISPLAY и платформы, когда доступна штатная команда VS Code. */
test('prepareCodexPrompt pastes multiline text natively without X11 or xdotool', async () => {
	resetVsCodeCommandMock();
	const originalDisplay = process.env.DISPLAY;
	delete process.env.DISPLAY;
	try {
		const { manager } = await createManager();
		(manager as any).isXdotoolPlatformSupported = () => false;
		const text = 'Задача\nВторая строка';
		const result = await (manager as any).prepareCodexPrompt({ autoStartChatWithXdotool: false }, text, codexNativePasteCommands);
		assert.deepEqual(result, { ok: true, stage: 'paste' });
		assert.equal(vscodeClipboardText, text);
		assert.deepEqual(vscodeCommandCalls.map(call => call.id), codexNativePasteCommands);
		assert.deepEqual(childProcessSpawnCalls, []);
	} finally {
		if (originalDisplay === undefined) { delete process.env.DISPLAY; } else { process.env.DISPLAY = originalDisplay; }
		resetVsCodeCommandMock();
	}
});

/** Ошибки фокуса/вставки не запускают повторную вставку и не отправляют сообщение. */
for (const failure of ['focus', 'paste'] as const) {
	test(`prepareCodexPrompt stops after native ${failure} fails`, async () => {
		resetVsCodeCommandMock();
		try {
			const { manager } = await createManager();
			const failedCommand = codexNativePasteCommands[failure === 'focus' ? 0 : 1];
			vscodeExecuteCommandHandler = async id => {
				if (id === failedCommand) { throw new Error('native command failed'); }
			};
			const result = await (manager as any).prepareCodexPrompt({ autoStartChatWithXdotool: true }, 'Prepared prompt', codexNativePasteCommands);
			assert.deepEqual(result, { ok: false, stage: failure, reason: 'native command failed', ...(failure === 'paste' ? { partialPaste: true } : {}) });
			assert.equal(vscodeCommandCalls.filter(call => call.id === 'editor.action.clipboardPasteAction').length, failure === 'focus' ? 0 : 1);
			assert.deepEqual(childProcessSpawnCalls, []);
		} finally { resetVsCodeCommandMock(); }
	});
}

/** Webview reads clipboard after executeCommand resolves; subsequent chunks must not overtake it. */
test('prepareCodexPrompt keeps a long prompt inline and restores the full clipboard after asynchronous paste', async () => {
	resetVsCodeCommandMock();
	try {
		const { manager } = await createManager();
		const text = 'Начало\n' + 'я'.repeat(3991) + '😀\r\n' + 'Длинный текст\n'.repeat(650) + '\nКонец  ';
		const received: string[] = [];
		vscodeExecuteCommandHandler = async id => {
			if (id === 'editor.action.clipboardPasteAction') {
				setTimeout(() => received.push(vscodeClipboardText), 30);
			}
		};
		const result = await (manager as any).prepareCodexPrompt({ autoStartChatWithXdotool: false }, text, codexNativePasteCommands);
		assert.deepEqual(result, { ok: true, stage: 'paste' });
		assert.ok(received.length > 1);
		assert.ok(received.every(part => part.length < 5000));
		assert.equal(received.join(''), text);
		assert.equal(vscodeClipboardText, text);
		assert.deepEqual(childProcessSpawnCalls, []);
	} finally { resetVsCodeCommandMock(); }
});

for (const interruption of ['command-error', 'focus-lost', 'clipboard-changed']) {
	test(`prepareCodexPrompt cancels a partial long paste on ${interruption} without submitting or retrying`, async () => {
		resetVsCodeCommandMock();
		try {
			const { manager } = await createManager();
			const text = 'я'.repeat(12000);
			let pasteCalls = 0;
			vscodeExecuteCommandHandler = async id => {
				if (id !== 'editor.action.clipboardPasteAction') { return; }
				pasteCalls++;
				if (interruption === 'command-error' && pasteCalls === 2) { throw new Error('paste interrupted'); }
				if (interruption === 'focus-lost') { vscodeWindowFocused = false; }
				if (interruption === 'clipboard-changed') { vscodeClipboardText = 'User copied something else'; }
			};
			const result = await (manager as any).prepareCodexPrompt({ autoStartChatWithXdotool: true }, text, codexNativePasteCommands);
			assert.equal(result.ok, false);
			assert.equal(result.stage, 'paste');
			assert.equal(result.partialPaste, true);
			assert.equal(pasteCalls, interruption === 'command-error' ? 2 : 1);
			assert.equal(vscodeClipboardText, interruption === 'clipboard-changed' ? 'User copied something else' : text);
			assert.deepEqual(childProcessSpawnCalls, []);
		} finally { resetVsCodeCommandMock(); }
	});
}

test('prepareCodexPromptWithXdotool also splits long text below the attachment threshold', async () => {
	resetVsCodeCommandMock();
	try {
		const { manager } = await createManager();
		const text = 'я'.repeat(9000);
		const received: string[] = [];
		(manager as any).focusCodexComposerWithXdotool = async () => ({ ok: true, stdout: '42' });
		(manager as any).runXdotoolCommand = async () => ({ ok: true, stdout: '42\n' });
		(manager as any).runXdotoolKeys = async (keys: string[]) => {
			assert.deepEqual(keys, ['ctrl+v']);
			received.push(vscodeClipboardText);
			return { ok: true };
		};
		const result = await (manager as any).prepareCodexPromptWithXdotool({ autoStartChatWithXdotool: false }, text);
		assert.equal(result.ok, true);
		assert.ok(received.length > 1);
		assert.ok(received.every(part => part.length < 5000));
		assert.equal(received.join(''), text);
		assert.equal(vscodeClipboardText, text);
	} finally { resetVsCodeCommandMock(); }
});

test('prepareCodexPrompt skips native paste when the VS Code window loses focus', async () => {
	resetVsCodeCommandMock();
	try {
		const { manager } = await createManager();
		vscodeExecuteCommandHandler = async id => {
			if (id === codexNativePasteCommands[0]) { vscodeWindowFocused = false; }
		};
		const result = await (manager as any).prepareCodexPrompt({ autoStartChatWithXdotool: true }, 'Prepared prompt', codexNativePasteCommands);
		assert.equal(result.ok, false);
		assert.equal(result.stage, 'focus');
		assert.match(result.reason, /lost focus/);
		assert.equal(vscodeCommandCalls.some(call => call.id === 'editor.action.clipboardPasteAction'), false);
		assert.deepEqual(childProcessSpawnCalls, []);
	} finally { resetVsCodeCommandMock(); }
});

/** Воспроизводит native Wayland: XWayland возвращает служебное окно без PID, но текст уже вставлен. */
test('prepareCodexPrompt preserves native paste when XWayland has no window PID', async () => {
	resetVsCodeCommandMock();
	const originalDisplay = process.env.DISPLAY;
	process.env.DISPLAY = originalDisplay || ':99';
	try {
		const { manager } = await createManager();
		(manager as any).isXdotoolPlatformSupported = () => true;
		childProcessSpawnHandler = (_command, args) => args[0] === 'getactivewindow'
			? createMockChildProcessExit(0, '6291459\n')
			: createMockChildProcessExit(1, '', 'window 6291459 has no pid associated with it.');
		const result = await (manager as any).prepareCodexPrompt({ autoStartChatWithXdotool: true }, 'Prepared prompt', codexNativePasteCommands);
		assert.equal(result.ok, false);
		assert.equal(result.stage, 'submit');
		assert.match(result.reason, /has no pid/);
		assert.equal(vscodeCommandCalls.filter(call => call.id === 'editor.action.clipboardPasteAction').length, 1);
		assert.deepEqual(childProcessSpawnCalls.map(call => call.args), [['getactivewindow'], ['getwindowpid', '6291459']]);
	} finally {
		if (originalDisplay === undefined) { delete process.env.DISPLAY; } else { process.env.DISPLAY = originalDisplay; }
		resetVsCodeCommandMock();
	}
});

for (const windowChanges of [false, true]) {
	test(`prepareCodexPrompt ${windowChanges ? 'cancels' : 'performs'} X11 submission after native paste`, async () => {
		resetVsCodeCommandMock();
		const originalDisplay = process.env.DISPLAY;
		process.env.DISPLAY = originalDisplay || ':99';
		try {
			const { manager } = await createManager();
			(manager as any).isXdotoolPlatformSupported = () => true;
			(manager as any).isVisualStudioCodeWindowProcess = () => true;
			vscodeConfigurationValues.set('chatgpt.composerEnterBehavior', 'cmdIfMultiline');
			let windowReads = 0;
			childProcessSpawnHandler = (_command, args) => {
				if (args[0] === 'getactivewindow') {
					return createMockChildProcessExit(0, ++windowReads === 2 && windowChanges ? '43\n' : '42\n');
				}
				return createMockChildProcessExit(0, args[0] === 'getwindowpid' ? '4242\n' : '');
			};
			const result = await (manager as any).prepareCodexPrompt({ autoStartChatWithXdotool: true }, 'First\nSecond', codexNativePasteCommands);
			assert.equal(result.ok, !windowChanges);
			assert.equal(result.stage, 'submit');
			assert.equal(vscodeCommandCalls.filter(call => call.id === 'editor.action.clipboardPasteAction').length, 1);
			const keyCalls = childProcessSpawnCalls.filter(call => call.args[0] === 'key').map(call => call.args);
			assert.deepEqual(keyCalls, windowChanges ? [] : [['key', '--clearmodifiers', 'ctrl+Return']]);
			assert.equal(childProcessSpawnCalls.some(call => call.args[0] === 'mousemove'), false);
		} finally {
			vscodeConfigurationValues.delete('chatgpt.composerEnterBehavior');
			if (originalDisplay === undefined) { delete process.env.DISPLAY; } else { process.env.DISPLAY = originalDisplay; }
			resetVsCodeCommandMock();
		}
	});
}

/** Проверяет клавишу отправки для всех поддерживаемых настроек composer Codex. */
test('resolveCodexSubmitKey respects Codex composer enter behavior', async () => {
	resetVsCodeCommandMock();
	const { manager } = await createManager();

	try {
		vscodeConfigurationValues.set('chatgpt.composerEnterBehavior', 'enter');
		assert.equal((manager as any).resolveCodexSubmitKey('single line'), 'Return');
		assert.equal((manager as any).resolveCodexSubmitKey('multiple\nlines'), 'Return');

		vscodeConfigurationValues.set('chatgpt.composerEnterBehavior', 'cmdIfMultiline');
		assert.equal((manager as any).resolveCodexSubmitKey('single line'), 'Return');
		assert.equal((manager as any).resolveCodexSubmitKey('multiple\nlines'), 'ctrl+Return');

		vscodeConfigurationValues.set('chatgpt.composerEnterBehavior', 'cmdAlways');
		assert.equal((manager as any).resolveCodexSubmitKey('single line'), 'ctrl+Return');
		assert.equal((manager as any).resolveCodexSubmitKey('multiple\nlines'), 'ctrl+Return');
	} finally {
		vscodeConfigurationValues.delete('chatgpt.composerEnterBehavior');
		resetVsCodeCommandMock();
	}
});

/** Проверяет отказ от вставки, если активное окно изменилось после фокусировки Codex. */
test('prepareCodexPromptWithXdotool aborts paste after active window changes', async () => {
	resetVsCodeCommandMock();
	let activeWindowReadCount = 0;
	childProcessSpawnHandler = (_command, args) => {
		if (args[0] === 'getactivewindow') {
			activeWindowReadCount += 1;
			return createMockChildProcessExit(0, activeWindowReadCount === 1 ? '42\n' : '43\n');
		}
		if (args[0] === 'getwindowpid') {
			return createMockChildProcessExit(0, '4242\n');
		}
		return args[0] === 'getwindowgeometry'
			? createMockChildProcessExit(0, 'X=0\nY=0\nWIDTH=1200\nHEIGHT=800\nSCREEN=0\n')
			: createMockChildProcessExit(0);
	};
	const originalDisplay = process.env.DISPLAY;
	process.env.DISPLAY = originalDisplay || ':99';

	try {
		const { manager } = await createManager();
		(manager as any).isXdotoolPlatformSupported = () => true;
		(manager as any).isVisualStudioCodeWindowProcess = () => true;
		const result = await (manager as any).prepareCodexPromptWithXdotool(
			{ autoStartChatWithXdotool: false },
			'Prepared prompt',
		);

		assert.equal(result.ok, false);
		assert.equal(result.stage, 'focus');
		assert.match(result.reason, /active window changed/);
		assert.equal(childProcessSpawnCalls.some(call => call.args.includes('ctrl+v')), false);
	} finally {
		if (originalDisplay === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDisplay;
		}
		resetVsCodeCommandMock();
	}
});

/** Проверяет, что ошибка открытия Codex не приводит к вставке в текущее активное окно. */
test('prepareCodexPromptWithXdotool skips automation when Codex focus command fails', async () => {
	resetVsCodeCommandMock();
	vscodeExecuteCommandHandler = async (id) => {
		if (id === 'chatgpt.openSidebar') {
			throw new Error('Codex is unavailable');
		}
		return undefined;
	};

	try {
		const { manager } = await createManager();
		const result = await (manager as any).prepareCodexPromptWithXdotool(
			{ autoStartChatWithXdotool: false },
			'Prepared prompt',
		);

		assert.equal(result.ok, false);
		assert.equal(result.stage, 'focus');
		assert.match(result.reason, /sidebar focus command failed/);
		assert.deepEqual(childProcessSpawnCalls, []);
	} finally {
		resetVsCodeCommandMock();
	}
});

/** Проверяет безопасный отказ Codex fallback при отсутствии X11 DISPLAY. */
test('prepareCodexPromptWithXdotool skips automation without DISPLAY', async () => {
	resetVsCodeCommandMock();
	const originalDisplay = process.env.DISPLAY;
	delete process.env.DISPLAY;

	try {
		const { manager } = await createManager();
		(manager as any).isXdotoolPlatformSupported = () => true;
		const result = await (manager as any).prepareCodexPromptWithXdotool(
			{ autoStartChatWithXdotool: true },
			'Prepared prompt',
		);

		assert.equal(result.ok, false);
		assert.equal(result.stage, 'focus');
		assert.match(result.reason, /requires DISPLAY/);
		assert.deepEqual(childProcessSpawnCalls, []);
	} finally {
		if (originalDisplay === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDisplay;
		}
		resetVsCodeCommandMock();
	}
});

/** Проверяет отказ от вставки при некорректной геометрии окна VS Code. */
test('prepareCodexPromptWithXdotool rejects invalid window geometry', async () => {
	resetVsCodeCommandMock();
	childProcessSpawnHandler = (_command, args) => {
		if (args[0] === 'getactivewindow') {
			return createMockChildProcessExit(0, '42\n');
		}
		if (args[0] === 'getwindowpid') {
			return createMockChildProcessExit(0, '4242\n');
		}
		return args[0] === 'getwindowgeometry'
			? createMockChildProcessExit(0, 'invalid geometry')
			: createMockChildProcessExit(0);
	};
	const originalDisplay = process.env.DISPLAY;
	process.env.DISPLAY = originalDisplay || ':99';

	try {
		const { manager } = await createManager();
		(manager as any).isXdotoolPlatformSupported = () => true;
		(manager as any).isVisualStudioCodeWindowProcess = () => true;
		const result = await (manager as any).prepareCodexPromptWithXdotool(
			{ autoStartChatWithXdotool: true },
			'Prepared prompt',
		);

		assert.equal(result.ok, false);
		assert.equal(result.stage, 'focus');
		assert.match(result.reason, /geometry/);
		assert.equal(childProcessSpawnCalls.some(call => call.args.includes('ctrl+v')), false);
	} finally {
		if (originalDisplay === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDisplay;
		}
		resetVsCodeCommandMock();
	}
});

/** Проверяет, что ошибка вставки не приводит к последующему нажатию клавиши отправки. */
test('prepareCodexPromptWithXdotool stops after paste failure', async () => {
	resetVsCodeCommandMock();
	childProcessSpawnHandler = (_command, args) => {
		if (args[0] === 'getactivewindow') {
			return createMockChildProcessExit(0, '42\n');
		}
		if (args[0] === 'getwindowpid') {
			return createMockChildProcessExit(0, '4242\n');
		}
		if (args[0] === 'getwindowgeometry') {
			return createMockChildProcessExit(0, 'X=0\nY=0\nWIDTH=1200\nHEIGHT=800\nSCREEN=0\n');
		}
		return args.includes('ctrl+v')
			? createMockChildProcessExit(1, '', 'paste failed')
			: createMockChildProcessExit(0);
	};
	const originalDisplay = process.env.DISPLAY;
	process.env.DISPLAY = originalDisplay || ':99';

	try {
		const { manager } = await createManager();
		(manager as any).isXdotoolPlatformSupported = () => true;
		(manager as any).isVisualStudioCodeWindowProcess = () => true;
		const result = await (manager as any).prepareCodexPromptWithXdotool(
			{ autoStartChatWithXdotool: true },
			'Prepared prompt',
		);

		assert.equal(result.ok, false);
		assert.equal(result.stage, 'paste');
		assert.match(result.reason, /paste failed/);
		assert.equal(childProcessSpawnCalls.some(call => call.args.includes('Return')), false);
		assert.equal(childProcessSpawnCalls.some(call => call.args.includes('ctrl+Return')), false);
	} finally {
		if (originalDisplay === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDisplay;
		}
		resetVsCodeCommandMock();
	}
});

/** Проверяет явный результат ошибки отправки после успешной вставки текста. */
test('prepareCodexPromptWithXdotool reports submit failure after paste', async () => {
	resetVsCodeCommandMock();
	childProcessSpawnHandler = (_command, args) => {
		if (args[0] === 'getactivewindow') {
			return createMockChildProcessExit(0, '42\n');
		}
		if (args[0] === 'getwindowpid') {
			return createMockChildProcessExit(0, '4242\n');
		}
		if (args[0] === 'getwindowgeometry') {
			return createMockChildProcessExit(0, 'X=0\nY=0\nWIDTH=1200\nHEIGHT=800\nSCREEN=0\n');
		}
		return args.includes('Return')
			? createMockChildProcessExit(1, '', 'submit failed')
			: createMockChildProcessExit(0);
	};
	const originalDisplay = process.env.DISPLAY;
	process.env.DISPLAY = originalDisplay || ':99';

	try {
		const { manager } = await createManager();
		(manager as any).isXdotoolPlatformSupported = () => true;
		(manager as any).isVisualStudioCodeWindowProcess = () => true;
		const result = await (manager as any).prepareCodexPromptWithXdotool(
			{ autoStartChatWithXdotool: true },
			'Prepared prompt',
		);

		assert.equal(result.ok, false);
		assert.equal(result.stage, 'submit');
		assert.match(result.reason, /submit failed/);
		assert.ok(childProcessSpawnCalls.some(call => call.args.includes('ctrl+v')));
	} finally {
		if (originalDisplay === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDisplay;
		}
		resetVsCodeCommandMock();
	}
});

/** Проверяет вставку и отправку текста Codex через Xdotool при включенном автостарте. */
test('startChat auto-sends Codex fallback from the clipboard with xdotool', async () => {
	resetVsCodeCommandMock();
	vscodeAvailableCommands = ['chatgpt.openSidebar', 'chatgpt.newChat', 'chatgpt.addToThread', 'chatgpt.addFileToThread'];
	childProcessSpawnHandler = (_command, args) => {
		if (args[0] === 'getactivewindow') {
			return createMockChildProcessExit(0, '42\n');
		}
		if (args[0] === 'getwindowpid') {
			return createMockChildProcessExit(0, '4242\n');
		}
		return args[0] === 'getwindowgeometry'
			? createMockChildProcessExit(0, 'X=0\nY=0\nWIDTH=1200\nHEIGHT=800\nSCREEN=0\n')
			: createMockChildProcessExit(0);
	};
	const originalDisplay = process.env.DISPLAY;
	process.env.DISPLAY = originalDisplay || ':99';

	try {
		const { manager, getStoredPrompt } = await createManager({
			initialPrompt: {
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt title',
				status: 'draft',
				chatTarget: 'codex',
				autoStartChatWithXdotool: true,
				contextFiles: ['src/index.ts'],
				content: 'Implement Codex routing.',
			},
			stateService: {
				saveLastPromptId: async () => undefined,
				getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
				saveSidebarState: async () => undefined,
				getGlobalAgentContext: () => '',
			},
		});

		vscodeConfigurationValues.set('chatgpt.composerEnterBehavior', 'cmdAlways');
		(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
		let clearedPlanCount = 0;
		(manager as any).isXdotoolPlatformSupported = () => true;
		(manager as any).isVisualStudioCodeWindowProcess = () => true;
		(manager as any).clearPromptPlanFileIfExists = async () => {
			clearedPlanCount += 1;
		};

		const postedMessages: any[] = [];
		const panel = {
			visible: true,
			webview: {
				postMessage: async (message: unknown) => {
					postedMessages.push(message);
					return true;
				},
			},
		} as any;
		const currentPrompt = createPrompt({
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			chatTarget: 'codex',
			autoStartChatWithXdotool: true,
			contextFiles: ['src/index.ts'],
			content: 'Implement Codex routing.',
		});

		await (manager as any).handleMessage(
			{ type: 'startChat', id: 'prompt-a', requestId: 'req-codex-xdotool' },
			panel,
			currentPrompt,
			'__prompt_editor_singleton__',
			() => false,
			() => undefined,
		);

		assert.equal(getStoredPrompt()?.status, 'in-progress');
		assert.equal(childProcessSpawnCalls.length, 7);
		assert.match(childProcessSpawnCalls[0]?.command || '', /xdotool$/);
		assert.deepEqual(childProcessSpawnCalls[0]?.args, ['getactivewindow']);
		assert.match(childProcessSpawnCalls[1]?.command || '', /xdotool$/);
		assert.deepEqual(childProcessSpawnCalls[1]?.args, ['getwindowpid', '42']);
		assert.match(childProcessSpawnCalls[2]?.command || '', /xdotool$/);
		assert.deepEqual(childProcessSpawnCalls[2]?.args, ['getwindowgeometry', '--shell', '42']);
		assert.match(childProcessSpawnCalls[3]?.command || '', /xdotool$/);
		assert.deepEqual(childProcessSpawnCalls[3]?.args, ['mousemove', '980', '680', 'click', '1']);
		assert.match(childProcessSpawnCalls[4]?.command || '', /xdotool$/);
		assert.deepEqual(childProcessSpawnCalls[4]?.args, ['getactivewindow']);
		assert.match(childProcessSpawnCalls[5]?.command || '', /xdotool$/);
		assert.deepEqual(childProcessSpawnCalls[5]?.args, ['key', '--clearmodifiers', 'ctrl+v']);
		assert.match(childProcessSpawnCalls[6]?.command || '', /xdotool$/);
		assert.deepEqual(childProcessSpawnCalls[6]?.args, ['key', '--clearmodifiers', 'ctrl+Return']);
		assert.ok(vscodeCommandCalls.some(call => call.id === 'chatgpt.openSidebar'));
		assert.ok(vscodeCommandCalls.some(call => call.id === 'chatgpt.newChat'));
		assert.equal(vscodeCommandCalls.some(call => call.id === 'chatgpt.addToThread'), false);
		assert.ok(vscodeCommandCalls.some(call => call.id === 'chatgpt.addFileToThread'));
		assert.equal(vscodeClosedTabs.length, 0);
		assert.equal(vscodeWorkspaceFiles.size, 0);
		assert.match(vscodeClipboardText, /Implement Codex routing/);
		assert.equal(clearedPlanCount, 0);
		assert.equal(postedMessages.some(message => message?.type === 'chatStarted'), false);
		assert.equal(postedMessages.some(message => message?.type === 'chatRequestStarted'), false);
		assert.ok(postedMessages.some(message => message?.type === 'info' && /не подтверждает прием/.test(message.message)));
	} finally {
		vscodeConfigurationValues.delete('chatgpt.composerEnterBehavior');
		if (originalDisplay === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDisplay;
		}
		resetVsCodeCommandMock();
	}
});

test('startChat refreshes remote global context before syncing instructions when auto-load is enabled', async () => {
	resetVsCodeCommandMock();

	const syncedContexts: string[] = [];
	const savedGlobalContexts: Array<{ context: string; source?: string }> = [];
	const { manager } = await createManager({
		configurationValues: {
			'promptManager.editor.globalContextUrl': 'https://example.com/default.instructions.md',
			'promptManager.editor.autoLoadContext': true,
		},
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
		},
		workspaceService: {
			syncGlobalAgentInstructionsFile: async (context: string) => {
				syncedContexts.push(context);
			},
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => 'Stored remote context',
			getGlobalAgentContextSource: () => 'remote',
			saveGlobalAgentContext: async (context: string, source?: string) => {
				savedGlobalContexts.push({ context, source });
			},
			getActiveChatSessionId: async () => '',
			waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
			waitForChatRequestCompletion: async () => ({
				ok: false,
				reason: 'timeout',
				sessionId: '',
				lastRequestStarted: 0,
				lastRequestEnded: 0,
				hasPendingEdits: false,
			}),
		},
	});

	(manager as any).loadRemoteGlobalAgentContext = async () => 'Refreshed remote context';
	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;
	(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });

	const panel = {
		visible: true,
		webview: {
			postMessage: async () => true,
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-autoload-1' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.deepEqual(savedGlobalContexts, [{ context: 'Refreshed remote context', source: 'remote' }]);
	assert.equal(syncedContexts[0], 'Refreshed remote context');
	resetVsCodeCommandMock();
});

for (const enabled of [false, true]) {
	test(`startChat resolves startup instruction services only when enabled=${enabled}`, async t => {
		resetVsCodeCommandMock();
		vscodeAvailableCommands = ['workbench.action.chat.attachFile'];

		// Проверка контекста внешних чатов не использует общий каталог другой задачи.
		const storageDirectoryPath = mkdtempSync(join(tmpdir(), 'prompt-manager-instructions-'));
		const chatMemoryDirectory = `${storageDirectoryPath}/chat-memory`;
		const staleCodemapPath = `${chatMemoryDirectory}/codemap.instructions.md`;
		mkdirSync(chatMemoryDirectory, { recursive: true });
		writeFileSync(staleCodemapPath, 'stale codemap content');

		const chatMemoryCalls: string[] = [];
		const codeMapCalls: string[] = [];
		const initialized = createDeferred<void>();
		const contextRequested = createDeferred<void>();
		const waitForContext = () => {
			assert.equal(enabled, true, 'выключенный источник не должен запрашиваться');
			contextRequested.resolve();
			return initialized.promise;
		};

		try {
			const { manager } = await createManager({
				storageDirectoryPath,
				configurationValues: {
					'promptManager.memory.enabled': enabled,
					'promptManager.codemap.enabled': enabled,
				},
				initialPrompt: {
					id: 'prompt-a',
					promptUuid: 'uuid-a',
					title: 'Prompt title',
					status: 'draft',
					content: 'Implement the requested workflow changes.',
				},
				stateService: {
					saveLastPromptId: async () => undefined,
					getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
					saveSidebarState: async () => undefined,
					getGlobalAgentContext: () => '',
					getActiveChatSessionId: async () => '',
					waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
					waitForChatRequestCompletion: async () => ({
						ok: false,
						reason: 'timeout',
						sessionId: '',
						lastRequestStarted: 0,
						lastRequestEnded: 0,
						hasPendingEdits: false,
					}),
				},
				chatMemoryInstructionService: () => waitForContext().then(() => ({
					prepareSessionInstruction: async () => {
						chatMemoryCalls.push('prepareSessionInstruction');
						return {
							promptUuid: 'uuid-a',
							promptId: 'prompt-a',
							instructionFilePath: `${chatMemoryDirectory}/session-uuid-a.instructions.md`,
							createdAt: '2026-06-01T00:00:00.000Z',
							updatedAt: '2026-06-01T00:00:00.000Z',
						};
					},
				})),
				codeMapChatInstructionService: () => waitForContext().then(() => ({
					prepareInstruction: async () => {
						codeMapCalls.push('prepareInstruction');
						return null;
					},
				})),
			});

			// Конфигурация этих сервисов запрашивает vscode динамически при самом старте чата.
			const previousLoad = (Module as any)._load;
			(Module as any)._load = function (request: string, ...args: unknown[]) {
				return request === 'vscode' ? createVsCodeMock() : previousLoad.call(this, request, ...args);
			};
			t.after(() => { (Module as any)._load = previousLoad; });
			(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
			(manager as any).clearPromptPlanFileIfExists = async () => undefined;
			(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });

			const postedMessages: any[] = [];
			const panel = {
				visible: true,
				webview: {
					postMessage: async (message: unknown) => {
						postedMessages.push(message);
						return true;
					},
				},
			} as any;
			const currentPrompt = createPrompt({
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt title',
				status: 'draft',
				content: 'Implement the requested workflow changes.',
			});

			const start = (manager as any).handleMessage(
				{ type: 'startChat', id: 'prompt-a', requestId: 'req-disabled-memory-context' },
				panel,
				currentPrompt,
				'__prompt_editor_singleton__',
				() => false,
				() => undefined,
			);

			if (enabled) await contextRequested.promise;
			assert.deepEqual(chatMemoryCalls, []);
			assert.deepEqual(codeMapCalls, []);
			// Ручная команда при выключенных настройках завершается до открытия барьера.
			if (!enabled) await start;
			initialized.resolve();
			await start;
			assert.deepEqual(chatMemoryCalls, enabled ? ['prepareSessionInstruction'] : []);
			assert.deepEqual(codeMapCalls, enabled ? ['prepareInstruction'] : []);
			assert.ok(postedMessages.some(message => message.type === 'chatStarted'));
			if (!enabled) {
				assert.equal(vscodeCommandCalls.filter(call => call.id === 'workbench.action.chat.attachFile').length, 0);
				const summary = postedMessages.find(message => message.type === 'chatMemorySummary')?.memorySummary;
				assert.ok(summary);
				assert.equal(summary.codemap, null);
				assert.ok(summary.instructionFiles.every((file: { sourceKind: string }) =>
					file.sourceKind !== 'codemap' && file.sourceKind !== 'session'));
			}
		} finally {
			rmSync(storageDirectoryPath, { recursive: true, force: true });
			resetVsCodeCommandMock();
		}
	});
}

test('startChat excludes only workspace projects that still exist from the readonly section', async () => {
	resetVsCodeCommandMock();

	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
		},
		workspaceService: {
			getExcludedProjectNames: () => ['core', 'ghost-project'],
			resolveEffectiveProjectNames: (requestedProjects: string[], options?: {
				fallbackToWorkspaceWhenSelectionInvalid?: boolean;
				includeExcluded?: boolean;
			}) => {
				assert.equal(options?.includeExcluded, true);
				assert.equal(options?.fallbackToWorkspaceWhenSelectionInvalid, false);
				return requestedProjects.filter(project => project === 'core');
			},
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => '',
			getActiveChatSessionId: async () => '',
			waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
			waitForChatRequestCompletion: async () => ({
				ok: false,
				reason: 'timeout',
				sessionId: '',
				lastRequestStarted: 0,
				lastRequestEnded: 0,
				hasPendingEdits: false,
			}),
		},
	});

	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;
	(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });

	const panel = {
		visible: true,
		webview: {
			postMessage: async () => true,
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-excluded-projects' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	const sentChatQuery = vscodeCommandCalls
		.map(call => call.args[0] as { query?: string; prompt?: string; message?: string } | undefined)
		.find(arg => typeof arg?.query === 'string')?.query;

	assert.equal(typeof sentChatQuery, 'string');
	assert.ok(sentChatQuery?.includes('## Excluded projects'));
	assert.ok(sentChatQuery?.includes('- core'));
	assert.ok(!sentChatQuery?.includes('ghost-project'));
	resetVsCodeCommandMock();
});

test('startChat uses the latest webview global context source before deciding whether to auto-load', async () => {
	resetVsCodeCommandMock();

	const syncedContexts: string[] = [];
	const savedGlobalContexts: Array<{ context: string; source?: string }> = [];
	let storedGlobalContext = 'Stored manual context';
	let storedGlobalContextSource: 'manual' | 'remote' | 'empty' = 'manual';
	const { manager } = await createManager({
		configurationValues: {
			'promptManager.editor.globalContextUrl': 'https://example.com/default.instructions.md',
			'promptManager.editor.autoLoadContext': true,
		},
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
		},
		workspaceService: {
			syncGlobalAgentInstructionsFile: async (context: string) => {
				syncedContexts.push(context);
			},
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => storedGlobalContext,
			getGlobalAgentContextSource: () => storedGlobalContextSource,
			saveGlobalAgentContext: async (context: string, source?: string) => {
				storedGlobalContext = context;
				storedGlobalContextSource = (source as typeof storedGlobalContextSource | undefined) ?? 'manual';
				savedGlobalContexts.push({ context, source });
			},
			getActiveChatSessionId: async () => '',
			waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
			waitForChatRequestCompletion: async () => ({
				ok: false,
				reason: 'timeout',
				sessionId: '',
				lastRequestStarted: 0,
				lastRequestEnded: 0,
				hasPendingEdits: false,
			}),
		},
	});

	(manager as any).loadRemoteGlobalAgentContext = async () => 'Refreshed remote context';
	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;
	(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });

	const panel = {
		visible: true,
		webview: {
			postMessage: async () => true,
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{
			type: 'startChat',
			id: 'prompt-a',
			requestId: 'req-autoload-3',
			globalContext: 'Webview remote context',
			globalContextSource: 'remote',
		},
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.deepEqual(savedGlobalContexts, [
		{ context: 'Webview remote context', source: 'remote' },
		{ context: 'Refreshed remote context', source: 'remote' },
	]);
	assert.equal(syncedContexts[0], 'Refreshed remote context');
	resetVsCodeCommandMock();
});

test('startChat refreshes remote global context when the latest webview context is empty', async () => {
	resetVsCodeCommandMock();

	const syncedContexts: string[] = [];
	const savedGlobalContexts: Array<{ context: string; source?: string }> = [];
	let storedGlobalContext = 'Stored manual context';
	let storedGlobalContextSource: 'manual' | 'remote' | 'empty' = 'manual';
	const { manager } = await createManager({
		configurationValues: {
			'promptManager.editor.globalContextUrl': 'https://example.com/default.instructions.md',
			'promptManager.editor.autoLoadContext': true,
		},
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
		},
		workspaceService: {
			syncGlobalAgentInstructionsFile: async (context: string) => {
				syncedContexts.push(context);
			},
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => storedGlobalContext,
			getGlobalAgentContextSource: () => storedGlobalContextSource,
			saveGlobalAgentContext: async (context: string, source?: string) => {
				storedGlobalContext = context;
				storedGlobalContextSource = (source as typeof storedGlobalContextSource | undefined) ?? 'manual';
				savedGlobalContexts.push({ context, source });
			},
			getActiveChatSessionId: async () => '',
			waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
			waitForChatRequestCompletion: async () => ({
				ok: false,
				reason: 'timeout',
				sessionId: '',
				lastRequestStarted: 0,
				lastRequestEnded: 0,
				hasPendingEdits: false,
			}),
		},
	});

	(manager as any).loadRemoteGlobalAgentContext = async () => 'Refreshed remote context';
	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;
	(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });

	const panel = {
		visible: true,
		webview: {
			postMessage: async () => true,
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{
			type: 'startChat',
			id: 'prompt-a',
			requestId: 'req-autoload-empty',
			globalContext: '',
			globalContextSource: 'empty',
		},
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.deepEqual(savedGlobalContexts, [
		{ context: '', source: 'empty' },
		{ context: 'Refreshed remote context', source: 'remote' },
	]);
	assert.equal(syncedContexts[0], 'Refreshed remote context');
	resetVsCodeCommandMock();
});

test('startChat falls back to the stored global context when remote auto-refresh fails', async () => {
	resetVsCodeCommandMock();

	const syncedContexts: string[] = [];
	const savedGlobalContexts: Array<{ context: string; source?: string }> = [];
	const postedMessages: any[] = [];
	const { manager } = await createManager({
		configurationValues: {
			'promptManager.editor.globalContextUrl': 'https://example.com/default.instructions.md',
			'promptManager.editor.autoLoadContext': true,
		},
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
		},
		workspaceService: {
			syncGlobalAgentInstructionsFile: async (context: string) => {
				syncedContexts.push(context);
			},
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => 'Stored remote context',
			getGlobalAgentContextSource: () => 'remote',
			saveGlobalAgentContext: async (context: string, source?: string) => {
				savedGlobalContexts.push({ context, source });
			},
			getActiveChatSessionId: async () => '',
			waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
			waitForChatRequestCompletion: async () => ({
				ok: false,
				reason: 'timeout',
				sessionId: '',
				lastRequestStarted: 0,
				lastRequestEnded: 0,
				hasPendingEdits: false,
			}),
		},
	});

	(manager as any).loadRemoteGlobalAgentContext = async () => {
		throw new Error('offline');
	};
	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;
	(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });

	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-autoload-2' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.deepEqual(savedGlobalContexts, []);
	assert.equal(syncedContexts[0], 'Stored remote context');
	assert.ok(postedMessages.some(message => (message as any)?.type === 'chatStarted'));
	resetVsCodeCommandMock();
});

test('startChat reports a real timeout notice only after session confirmation fails', async () => {
	resetVsCodeCommandMock();

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => '',
			getActiveChatSessionId: async () => '',
			waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
			waitForChatRequestCompletion: async () => ({
				ok: false,
				reason: 'timeout',
				sessionId: '',
				lastRequestStarted: 0,
				lastRequestEnded: 0,
				hasPendingEdits: false,
			}),
		},
	});

	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;
	(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-bind-timeout' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	await new Promise(resolve => setTimeout(resolve, 0));
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.ok(postedMessages.some(message => (message as any)?.type === 'chatStarted'));
	assert.ok(!postedMessages.some(message => (message as any)?.type === 'chatRequestStarted'));
	assert.ok(!postedMessages.some(message => (message as any)?.type === 'chatOpened'));
	assert.ok(postedMessages.some(message =>
		(message as any)?.type === 'error'
		&& (message as any)?.requestId === 'req-bind-timeout'
		&& (message as any)?.message === 'Запуск чата не подтвердился. Можно попробовать ещё раз.'));
	assert.deepEqual(getStoredPrompt()?.chatSessionIds, []);
	resetVsCodeCommandMock();
});

test('startChat does not report timeout when request completion later confirms the session', async () => {
	resetVsCodeCommandMock();

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => '',
			getActiveChatSessionId: async () => '',
			waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
			waitForChatRequestCompletion: async () => ({
				ok: false,
				reason: 'timeout',
				sessionId: 'session-new',
				lastRequestStarted: 100,
				lastRequestEnded: 0,
				hasPendingEdits: true,
			}),
		},
	});

	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;
	(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });
	(manager as any).scheduleChatSessionRename = async () => undefined;

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-completion-fallback' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	await new Promise(resolve => setTimeout(resolve, 0));
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.ok(postedMessages.some(message =>
		(message as any)?.type === 'chatRequestStarted'
		&& (message as any)?.requestId === 'req-completion-fallback'
		&& (message as any)?.sessionId === 'session-new'));
	assert.ok(postedMessages.some(message =>
		(message as any)?.type === 'chatOpened'
		&& (message as any)?.requestId === 'req-completion-fallback'));
	assert.ok(!postedMessages.some(message =>
		(message as any)?.type === 'error'
		&& (message as any)?.requestId === 'req-completion-fallback'
		&& (message as any)?.message === 'Запуск чата не подтвердился. Можно попробовать ещё раз.'));
	assert.deepEqual(getStoredPrompt()?.chatSessionIds, ['session-new']);
	resetVsCodeCommandMock();
});

test('startChat waits through the confirmation grace window before reporting timeout', async () => {
	resetVsCodeCommandMock();

	let activeSessionLookupCount = 0;
	let completionLookupCount = 0;
	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => '',
			getActiveChatSessionId: async () => {
				activeSessionLookupCount += 1;
				return activeSessionLookupCount >= 3 ? 'session-new' : '';
			},
			waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
			waitForChatRequestCompletion: async () => {
				completionLookupCount += 1;
				if (completionLookupCount === 1) {
					return {
						ok: false,
						reason: 'timeout',
						sessionId: '',
						lastRequestStarted: 0,
						lastRequestEnded: 0,
						hasPendingEdits: false,
					};
				}

				return {
					ok: false,
					reason: 'timeout',
					sessionId: 'session-new',
					lastRequestStarted: 100,
					lastRequestEnded: 0,
					hasPendingEdits: false,
				};
			},
		},
	});

	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;
	(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });
	(manager as any).scheduleChatSessionRename = async () => undefined;

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-confirmation-grace' },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	const waitDeadline = Date.now() + 500;
	while (Date.now() < waitDeadline && getStoredPrompt()?.chatSessionIds?.[0] !== 'session-new') {
		await new Promise(resolve => setTimeout(resolve, 10));
	}

	assert.ok(postedMessages.some(message =>
		(message as any)?.type === 'chatRequestStarted'
		&& (message as any)?.requestId === 'req-confirmation-grace'
		&& (message as any)?.sessionId === 'session-new'));
	assert.ok(postedMessages.some(message =>
		(message as any)?.type === 'chatOpened'
		&& (message as any)?.requestId === 'req-confirmation-grace'));
	assert.ok(!postedMessages.some(message =>
		(message as any)?.type === 'error'
		&& (message as any)?.requestId === 'req-confirmation-grace'
		&& (message as any)?.message === 'Запуск чата не подтвердился. Можно попробовать ещё раз.'));
	assert.deepEqual(getStoredPrompt()?.chatSessionIds, ['session-new']);
	resetVsCodeCommandMock();
});

test('startChat does not apply completion hook tokens immediately at launch', async () => {
	resetVsCodeCommandMock();

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
			hooks: ['chat-success'],
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => '',
			getActiveChatSessionId: async () => '',
			waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
			waitForChatRequestCompletion: async () => ({
				ok: false,
				reason: 'timeout',
				sessionId: '',
				lastRequestStarted: 0,
				lastRequestEnded: 0,
				hasPendingEdits: false,
			}),
		},
	});

	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;
	(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });
	(manager as any).runConfiguredHooks = async () => undefined;

	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		content: 'Implement the requested workflow changes.',
		hooks: ['chat-success'],
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-hook-status' },
		{ visible: true, webview: { postMessage: async () => true } } as any,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.equal(getStoredPrompt()?.status, 'in-progress');
	await flushTurns();
	assert.equal(getStoredPrompt()?.status, 'in-progress');
	resetVsCodeCommandMock();
});

test('startChat keeps prompt in-progress when completion is only observed but not stable', async () => {
	await withImmediateTimers(async () => {
		resetVsCodeCommandMock();

		const { manager, getStoredPrompt } = await createManager({
			initialPrompt: {
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt title',
				status: 'draft',
				content: 'Implement the requested workflow changes.',
			},
			stateService: {
				saveLastPromptId: async () => undefined,
				getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
				saveSidebarState: async () => undefined,
				getGlobalAgentContext: () => '',
				getActiveChatSessionId: async () => '',
				waitForChatSessionStarted: async () => ({ ok: true, sessionId: 'session-new', reason: '' }),
				waitForChatRequestCompletion: async () => ({
					ok: false,
					reason: 'timeout',
					sessionId: 'session-new',
					lastRequestStarted: 100,
					lastRequestEnded: 200,
					lastResponseState: 2,
					requestModelState: 0,
					hasRequestResult: false,
					hasPendingEdits: false,
				}),
				getChatSessionsTotalElapsed: async () => 0,
			},
		});

		(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
		(manager as any).clearPromptPlanFileIfExists = async () => undefined;
		(manager as any).tryReadChatMarkdownFromClipboard = async () => ({
			markdown: 'fallback report',
			html: '<p>fallback report</p>',
		});
		(manager as any).scheduleChatSessionRename = async () => undefined;
		(manager as any).runConfiguredHooks = async () => undefined;

		const currentPrompt = createPrompt({
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
		});

		await (manager as any).handleMessage(
			{ type: 'startChat', id: 'prompt-a', requestId: 'req-observed-only' },
			{ visible: true, webview: { postMessage: async () => true } } as any,
			currentPrompt,
			'__prompt_editor_singleton__',
			() => false,
			() => undefined,
		);

		const waitDeadline = Date.now() + 200;
		while (Date.now() < waitDeadline && getStoredPrompt()?.chatSessionIds?.[0] !== 'session-new') {
			await flushTurns(1);
		}

		assert.deepEqual(getStoredPrompt()?.chatSessionIds, ['session-new']);
		assert.equal(getStoredPrompt()?.status, 'in-progress');
		resetVsCodeCommandMock();
	});
});

test('startChat catches up completed status after delayed terminal session markers arrive', async () => {
	await withImmediateTimers(async () => {
		resetVsCodeCommandMock();

		let trackedCompletionLookupCount = 0;
		const requestStartedAt = Date.now() + 10;
		const initialRequestEndedAt = requestStartedAt + 100;
		const completedRequestEndedAt = requestStartedAt + 500;
		const { manager, getStoredPrompt } = await createManager({
			initialPrompt: {
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt title',
				status: 'draft',
				content: 'Implement the requested workflow changes.',
			},
			stateService: {
				saveLastPromptId: async () => undefined,
				getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
				saveSidebarState: async () => undefined,
				getGlobalAgentContext: () => '',
				getActiveChatSessionId: async () => '',
				waitForChatSessionStarted: async () => ({ ok: true, sessionId: 'session-new', reason: '' }),
				waitForChatRequestCompletion: async () => ({
					ok: false,
					reason: 'timeout',
					sessionId: 'session-new',
					lastRequestStarted: requestStartedAt,
					lastRequestEnded: initialRequestEndedAt,
					lastResponseState: 2,
					requestModelState: 0,
					hasRequestResult: false,
					hasPendingEdits: false,
				}),
				getChatSessionsTotalElapsed: async () => (trackedCompletionLookupCount >= 2 ? 600 : 0),
				getLatestTrackedChatRequestCompletion: async () => {
					trackedCompletionLookupCount += 1;
					if (trackedCompletionLookupCount >= 2) {
						return {
							ok: true,
							sessionId: 'session-new',
							lastRequestStarted: requestStartedAt,
							lastRequestEnded: completedRequestEndedAt,
							lastResponseState: 2,
							requestModelState: 1,
							hasRequestResult: true,
							hasPendingEdits: false,
						};
					}
					return {
						ok: false,
						reason: 'not-completed',
						sessionId: 'session-new',
						lastRequestStarted: requestStartedAt,
						lastRequestEnded: initialRequestEndedAt,
						lastResponseState: 2,
						requestModelState: 0,
						hasRequestResult: false,
						hasPendingEdits: false,
					};
				},
			},
		});

		(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
		(manager as any).clearPromptPlanFileIfExists = async () => undefined;
		(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });
		(manager as any).scheduleChatSessionRename = async () => undefined;
		(manager as any).runConfiguredHooks = async () => undefined;

		const currentPrompt = createPrompt({
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
		});

		await (manager as any).handleMessage(
			{ type: 'startChat', id: 'prompt-a', requestId: 'req-delayed-terminal-markers' },
			{ visible: true, webview: { postMessage: async () => true } } as any,
			currentPrompt,
			'__prompt_editor_singleton__',
			() => false,
			() => undefined,
		);

		const waitDeadline = Date.now() + 200;
		while (Date.now() < waitDeadline && getStoredPrompt()?.status !== 'completed') {
			await flushTurns(1);
		}

		assert.deepEqual(getStoredPrompt()?.chatSessionIds, ['session-new']);
		assert.equal(getStoredPrompt()?.timeSpentImplementing, 600);
		assert.equal(getStoredPrompt()?.status, 'completed');
		resetVsCodeCommandMock();
	});
});

test('startChat auto-completes only after stable completion is confirmed', async () => {
	await withImmediateTimers(async () => {
		resetVsCodeCommandMock();

		const { manager, getStoredPrompt } = await createManager({
			initialPrompt: {
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt title',
				status: 'draft',
				content: 'Implement the requested workflow changes.',
			},
			stateService: {
				saveLastPromptId: async () => undefined,
				getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
				saveSidebarState: async () => undefined,
				getGlobalAgentContext: () => '',
				getActiveChatSessionId: async () => '',
				waitForChatSessionStarted: async () => ({ ok: true, sessionId: 'session-new', reason: '' }),
				waitForChatRequestCompletion: async () => ({
					ok: true,
					reason: '',
					sessionId: 'session-new',
					lastRequestStarted: 100,
					lastRequestEnded: 400,
					lastResponseState: 3,
					requestModelState: 3,
					hasRequestResult: true,
					hasPendingEdits: false,
				}),
				getChatSessionsTotalElapsed: async () => 0,
			},
		});

		(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
		(manager as any).clearPromptPlanFileIfExists = async () => undefined;
		(manager as any).tryReadChatMarkdownFromClipboard = async () => ({
			markdown: 'final report',
			html: '<p>final report</p>',
		});
		(manager as any).scheduleChatSessionRename = async () => undefined;
		(manager as any).runConfiguredHooks = async () => undefined;

		const currentPrompt = createPrompt({
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
		});

		await (manager as any).handleMessage(
			{ type: 'startChat', id: 'prompt-a', requestId: 'req-stable-completion' },
			{ visible: true, webview: { postMessage: async () => true } } as any,
			currentPrompt,
			'__prompt_editor_singleton__',
			() => false,
			() => undefined,
		);

		const waitDeadline = Date.now() + 200;
		while (Date.now() < waitDeadline && getStoredPrompt()?.status !== 'completed') {
			await flushTurns(1);
		}

		assert.deepEqual(getStoredPrompt()?.chatSessionIds, ['session-new']);
		assert.equal(getStoredPrompt()?.status, 'completed');
		resetVsCodeCommandMock();
	});
});

test('startChat applies stopped status tokens only in the terminal chatError branch', async () => {
	await withImmediateTimers(async () => {
		resetVsCodeCommandMock();

		const { manager, getStoredPrompt } = await createManager({
			initialPrompt: {
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt title',
				status: 'draft',
				content: 'Implement the requested workflow changes.',
				hooks: ['chat-error'],
			},
			stateService: {
				saveLastPromptId: async () => undefined,
				getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
				saveSidebarState: async () => undefined,
				getGlobalAgentContext: () => '',
				getActiveChatSessionId: async () => '',
				waitForChatSessionStarted: async () => ({ ok: true, sessionId: 'session-new', reason: '' }),
				waitForChatRequestCompletion: async () => ({
					ok: false,
					reason: 'timeout',
					sessionId: 'session-new',
					lastRequestStarted: 0,
					lastRequestEnded: 0,
					hasPendingEdits: false,
				}),
			},
		});

		(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
		(manager as any).clearPromptPlanFileIfExists = async () => undefined;
		(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });
		(manager as any).scheduleChatSessionRename = async () => undefined;
		(manager as any).runConfiguredHooks = async () => undefined;

		const currentPrompt = createPrompt({
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
			hooks: ['chat-error'],
		});

		await (manager as any).handleMessage(
			{ type: 'startChat', id: 'prompt-a', requestId: 'req-chat-error-status' },
			{ visible: true, webview: { postMessage: async () => true } } as any,
			currentPrompt,
			'__prompt_editor_singleton__',
			() => false,
			() => undefined,
		);

		const waitDeadline = Date.now() + 200;
		while (Date.now() < waitDeadline && getStoredPrompt()?.status !== 'stopped') {
			await flushTurns(1);
		}

		assert.equal(getStoredPrompt()?.status, 'stopped');
		resetVsCodeCommandMock();
	});
});

test('recalcImplementingTime synchronizes completed status from tracked chat sessions', async () => {
	resetVsCodeCommandMock();

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'in-progress',
			content: 'Implement the requested workflow changes.',
			chatSessionIds: ['session-new'],
			timeSpentImplementing: 0,
		},
		stateService: {
			getChatSessionsTotalElapsed: async () => 900,
			getLatestTrackedChatRequestCompletion: async () => ({
				ok: true,
				sessionId: 'session-new',
				lastRequestStarted: 100,
				lastRequestEnded: 1000,
				lastResponseState: 2,
				requestModelState: 1,
				hasRequestResult: true,
				hasPendingEdits: false,
			}),
		},
	});

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'in-progress',
		content: 'Implement the requested workflow changes.',
		chatSessionIds: ['session-new'],
	});

	await (manager as any).handleMessage(
		{ type: 'recalcImplementingTime', id: 'prompt-a', silent: true },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.equal(getStoredPrompt()?.timeSpentImplementing, 900);
	assert.equal(getStoredPrompt()?.status, 'completed');
	assert.ok(postedMessages.some(message => (message as any)?.type === 'prompt' && (message as any)?.reason === 'sync'));
	resetVsCodeCommandMock();
});

test('recalcImplementingTime keeps prompt in-progress when completion belongs to an older request', async () => {
	resetVsCodeCommandMock();

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'in-progress',
			content: 'Implement the requested workflow changes.',
			chatSessionIds: ['session-new'],
			chatRequestAutoCompleteAfter: 1000,
			timeSpentImplementing: 0,
		},
		stateService: {
			getChatSessionsTotalElapsed: async () => 900,
			getLatestTrackedChatRequestCompletion: async () => ({
				ok: true,
				sessionId: 'session-new',
				lastRequestStarted: 900,
				lastRequestEnded: 1000,
				lastResponseState: 2,
				requestModelState: 1,
				hasRequestResult: true,
				hasPendingEdits: false,
			}),
		},
	});

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'in-progress',
		content: 'Implement the requested workflow changes.',
		chatSessionIds: ['session-new'],
		chatRequestAutoCompleteAfter: 1000,
	});

	await (manager as any).handleMessage(
		{ type: 'recalcImplementingTime', id: 'prompt-a', silent: true },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.equal(getStoredPrompt()?.timeSpentImplementing, 900);
	assert.equal(getStoredPrompt()?.status, 'in-progress');
	assert.ok(postedMessages.some(message => (message as any)?.type === 'prompt' && (message as any)?.reason === 'sync'));
	resetVsCodeCommandMock();
});

test('recalcImplementingTime keeps closed prompt timing frozen', async () => {
	resetVsCodeCommandMock();

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'closed',
			content: 'Implement the requested workflow changes.',
			chatSessionIds: ['session-new'],
			timeSpentImplementing: 120,
		},
		stateService: {
			getChatSessionsTotalElapsed: async () => 900,
			getLatestTrackedChatRequestCompletion: async () => ({
				ok: true,
				sessionId: 'session-new',
				lastRequestStarted: 100,
				lastRequestEnded: 1000,
				lastResponseState: 2,
				requestModelState: 1,
				hasRequestResult: true,
				hasPendingEdits: false,
			}),
		},
	});

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'closed',
		content: 'Implement the requested workflow changes.',
		chatSessionIds: ['session-new'],
		timeSpentImplementing: 120,
	});

	await (manager as any).handleMessage(
		{ type: 'recalcImplementingTime', id: 'prompt-a', silent: true },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.equal(getStoredPrompt()?.timeSpentImplementing, 120);
	assert.equal(getStoredPrompt()?.status, 'closed');
	assert.equal(postedMessages.some(message => (message as any)?.type === 'prompt' && (message as any)?.reason === 'sync'), false);
	resetVsCodeCommandMock();
});

test('startChat keeps closed prompt timing frozen when completion lands after the prompt closes', async () => {
	await withImmediateTimers(async () => {
		resetVsCodeCommandMock();

		const { manager, getStoredPrompt } = await createManager({
			initialPrompt: {
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt title',
				status: 'draft',
				content: 'Implement the requested workflow changes.',
				timeSpentImplementing: 120,
			},
			savePrompt: async (prompt: any, saveOptions?: any) => createPrompt({
				...prompt,
				status: saveOptions?.historyReason === 'start-chat' ? 'closed' : prompt.status,
				timeSpentImplementing: saveOptions?.historyReason === 'start-chat'
					? 120
					: (prompt.timeSpentImplementing || 0),
				updatedAt: '2026-04-13T00:00:01.000Z',
			}),
			stateService: {
				saveLastPromptId: async () => undefined,
				getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
				saveSidebarState: async () => undefined,
				getGlobalAgentContext: () => '',
				getActiveChatSessionId: async () => '',
				waitForChatSessionStarted: async () => ({ ok: true, sessionId: 'session-new', reason: '' }),
				waitForChatRequestCompletion: async () => ({
					ok: true,
					reason: '',
					sessionId: 'session-new',
					lastRequestStarted: 100,
					lastRequestEnded: 400,
					lastResponseState: 3,
					requestModelState: 3,
					hasRequestResult: true,
					hasPendingEdits: false,
				}),
				getChatSessionsTotalElapsed: async () => 0,
			},
		});

		(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
		(manager as any).clearPromptPlanFileIfExists = async () => undefined;
		(manager as any).tryReadChatMarkdownFromClipboard = async () => ({
			markdown: 'final report',
			html: '<p>final report</p>',
		});
		(manager as any).scheduleChatSessionRename = async () => undefined;
		(manager as any).runConfiguredHooks = async () => undefined;

		const currentPrompt = createPrompt({
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
			timeSpentImplementing: 120,
		});

		await (manager as any).handleMessage(
			{ type: 'startChat', id: 'prompt-a', requestId: 'req-closed-after-start' },
			{ visible: true, webview: { postMessage: async () => true } } as any,
			currentPrompt,
			'__prompt_editor_singleton__',
			() => false,
			() => undefined,
		);

		const waitDeadline = Date.now() + 200;
		while (Date.now() < waitDeadline && getStoredPrompt()?.chatSessionIds?.[0] !== 'session-new') {
			await flushTurns(1);
		}

		assert.equal(getStoredPrompt()?.status, 'closed');
		assert.equal(getStoredPrompt()?.timeSpentImplementing, 120);
		assert.deepEqual(getStoredPrompt()?.chatSessionIds, ['session-new']);
		resetVsCodeCommandMock();
	});
});

test('savePrompt status-change to in-progress stores chat auto-complete gate', async () => {
	resetVsCodeCommandMock();

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'completed',
			content: 'Implement the requested workflow changes.',
			chatSessionIds: ['session-new'],
		},
	});

	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'completed',
		content: 'Implement the requested workflow changes.',
		chatSessionIds: ['session-new'],
	});

	await (manager as any).handleMessage(
		{
			type: 'savePrompt',
			source: 'status-change',
			requestId: 'save-status-gate',
			prompt: createPrompt({
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt title',
				status: 'in-progress',
				content: 'Implement the requested workflow changes.',
				chatSessionIds: ['session-new'],
			}),
		},
		{ visible: true, webview: { postMessage: async () => true } } as any,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.equal(getStoredPrompt()?.status, 'in-progress');
	assert.ok(Number(getStoredPrompt()?.chatRequestAutoCompleteAfter || 0) > 0);
	resetVsCodeCommandMock();
});

test('manual savePrompt reuses one report binding refresh for reconcile and overwrite guard', async () => {
	resetVsCodeCommandMock();

	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			report: 'Stored report',
		},
	});
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		report: 'Stored report',
	});
	let refreshCount = 0;

	(manager as any).panelBasePrompts.set('__prompt_editor_singleton__', clonePrompt(currentPrompt));
	(manager as any).refreshReportBindingFromDisk = async () => {
		refreshCount += 1;
		return { content: 'Stored report', lastModifiedMs: 123 };
	};

	await (manager as any).handleMessage(
		{
			type: 'savePrompt',
			source: 'manual',
			requestId: 'save-report-refresh',
			prompt: createPrompt({
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt title',
				status: 'completed',
				report: 'Stored report',
			}),
		},
		{ visible: true, webview: { postMessage: async () => true } } as any,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.equal(refreshCount, 1);
	resetVsCodeCommandMock();
});

test('status-change savePrompt uses cached report binding and loaded base prompt', async () => {
	resetVsCodeCommandMock();

	const { manager, storageService } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			report: 'Stored report',
		},
	});
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		report: 'Stored report',
	});

	(manager as any).panelBasePrompts.set('__prompt_editor_singleton__', clonePrompt(currentPrompt));
	(manager as any).reportEditorByPanelKey.set('__prompt_editor_singleton__', {
		uri: { fsPath: '/tmp/workspace/.vscode/prompt-manager/prompts/prompt-a/report.txt', toString: () => 'report-a' },
		lastSyncedContent: 'Stored report',
		lastModifiedMs: 123,
	});
	let refreshCount = 0;
	(manager as any).refreshReportBindingFromDisk = async () => {
		refreshCount += 1;
		return { content: 'Stored report', lastModifiedMs: 123 };
	};
	let getPromptCount = 0;
	(storageService as any).getPrompt = async () => {
		getPromptCount += 1;
		return clonePrompt(currentPrompt);
	};
	let awaitReportPersistCount = 0;
	(manager as any).awaitPendingReportPersist = async () => {
		awaitReportPersistCount += 1;
	};
	let uniqueIdCount = 0;
	const originalUniqueId = (storageService as any).uniqueId.bind(storageService);
	(storageService as any).uniqueId = async (...args: unknown[]) => {
		uniqueIdCount += 1;
		return originalUniqueId(...args as [string, string | undefined]);
	};

	await (manager as any).handleMessage(
		{
			type: 'savePrompt',
			source: 'status-change',
			requestId: 'save-status-fast-path',
			prompt: createPrompt({
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt title',
				status: 'completed',
				report: 'Stored report',
			}),
		},
		{ visible: true, webview: { postMessage: async () => true } } as any,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	assert.equal(refreshCount, 0);
	assert.equal(getPromptCount, 0);
	assert.equal(awaitReportPersistCount, 0);
	assert.equal(uniqueIdCount, 0);

	resetVsCodeCommandMock();
});

test('status-change savePrompt clears visible saving before post-save sync completes', async () => {
	resetVsCodeCommandMock();

	const postSaveSync = createDeferred<void>();
	const { manager } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			report: 'Stored report',
		},
		stateService: {
			migratePromptEditorViewState: async () => postSaveSync.promise,
		},
	});
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		report: 'Stored report',
	});
	(manager as any).panelPromptRefs.set('__prompt_editor_singleton__', currentPrompt);
	(manager as any).panelBasePrompts.set('__prompt_editor_singleton__', clonePrompt(currentPrompt));
	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: any) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;

	const savePromise = (manager as any).handleMessage(
		{
			type: 'savePrompt',
			source: 'status-change',
			requestId: 'save-status-visible-finish',
			prompt: createPrompt({
				id: 'prompt-a',
				promptUuid: 'uuid-a',
				title: 'Prompt title',
				status: 'completed',
				report: 'Stored report',
			}),
		},
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	await flushTurns(3);
	const savingMessages = postedMessages.filter(message => message?.type === 'promptSaving');
	assert.deepEqual(savingMessages.map(message => message.saving), [true, false]);
	assert.equal(postedMessages.some(message => message?.type === 'promptSaved'), false);

	let saveSettled = false;
	void savePromise.then(() => { saveSettled = true; });
	await flushTurns(1);
	assert.equal(saveSettled, false);

	postSaveSync.resolve();
	await savePromise;
	assert.equal(saveSettled, true);

	resetVsCodeCommandMock();
});

test('reportEditorSave pushes the saved report back into the main prompt panel state', async () => {
	resetVsCodeCommandMock();
	vscodeCreatedWebviewPanels.length = 0;

	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'completed',
			report: 'Stored report',
		},
	});

	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'completed',
		report: 'Stored report',
	});
	const postedMessages: any[] = [];
	const mainPanel = {
		title: 'Prompt title',
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;

	await (manager as any).openPromptReportInEditor(
		'__prompt_editor_singleton__',
		currentPrompt,
		(message: unknown) => {
			postedMessages.push(message);
		},
		mainPanel,
	);

	const reportPanel = vscodeCreatedWebviewPanels[vscodeCreatedWebviewPanels.length - 1];
	assert.ok(reportPanel);

	await reportPanel.emitMessage({
		type: 'reportEditorSave',
		promptId: 'prompt-a',
		report: 'Updated report',
		previousReport: 'Stored report',
		activityDeltaMs: 0,
	});

	assert.equal(getStoredPrompt()?.report, 'Updated report');
	assert.equal(currentPrompt.report, 'Updated report');
	assert.ok(postedMessages.some((message) => (message as any)?.type === 'reportContentUpdated' && (message as any)?.report === 'Updated report'));

	resetVsCodeCommandMock();
});

test('startChat binds a new chat session through late rebind fallback before reporting chatOpened', async () => {
	resetVsCodeCommandMock();

	let activeSessionLookupCallCount = 0;
	const { manager, getStoredPrompt } = await createManager({
		initialPrompt: {
			id: 'prompt-a',
			promptUuid: 'uuid-a',
			title: 'Prompt title',
			status: 'draft',
			content: 'Implement the requested workflow changes.',
		},
		stateService: {
			saveLastPromptId: async () => undefined,
			getSidebarState: () => ({ selectedPromptId: 'prompt-a', selectedPromptUuid: 'uuid-a' }),
			saveSidebarState: async () => undefined,
			getGlobalAgentContext: () => '',
			getActiveChatSessionId: async () => {
				activeSessionLookupCallCount += 1;
				return activeSessionLookupCallCount >= 2 ? 'session-late' : '';
			},
			waitForChatSessionStarted: async () => ({ ok: false, reason: 'timeout' }),
			waitForChatRequestCompletion: async () => ({
				ok: false,
				reason: 'timeout',
				sessionId: '',
				lastRequestStarted: 0,
				lastRequestEnded: 0,
				hasPendingEdits: false,
			}),
		},
	});

	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	(manager as any).clearPromptPlanFileIfExists = async () => undefined;
	(manager as any).tryReadChatMarkdownFromClipboard = async () => ({ markdown: '', html: '' });
	// Убираем фоновую retry-цепочку rename, чтобы late rebind тест не держал процесс 42 секунды.
	(manager as any).scheduleChatSessionRename = async () => undefined;

	const postedMessages: any[] = [];
	const panel = {
		visible: true,
		webview: {
			postMessage: async (message: unknown) => {
				postedMessages.push(message);
				return true;
			},
		},
	} as any;
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		title: 'Prompt title',
		status: 'draft',
		content: 'Implement the requested workflow changes.',
	});

	await (manager as any).handleMessage(
		{ type: 'startChat', id: 'prompt-a', requestId: 'req-late-rebind', forceRebindChat: true },
		panel,
		currentPrompt,
		'__prompt_editor_singleton__',
		() => false,
		() => undefined,
	);

	await new Promise(resolve => setTimeout(resolve, 0));
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.ok(postedMessages.some(message => (message as any)?.type === 'chatStarted'));
	assert.ok(postedMessages.some(message => (message as any)?.type === 'chatRequestStarted' && (message as any)?.sessionId === 'session-late'));
	assert.ok(postedMessages.some(message => (message as any)?.type === 'chatOpened'));
	assert.deepEqual(getStoredPrompt()?.chatSessionIds, ['session-late']);
	resetVsCodeCommandMock();
});

test('applyPersistedPromptToPanelState refreshes base prompt and clears dirty flags when requested', async () => {
	const { manager } = await createManager();
	const panelKey = '__prompt_editor_singleton__';
	const currentPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		status: 'draft',
		report: '',
	});
	const persistedPrompt = createPrompt({
		id: 'prompt-a',
		promptUuid: 'uuid-a',
		status: 'in-progress',
		report: 'Persisted report',
		updatedAt: '2026-04-13T00:00:02.000Z',
	});

	(manager as any).panelPromptRefs.set(panelKey, currentPrompt);
	(manager as any).panelDirtyFlags.set(panelKey, true);
	(manager as any).panelLatestPromptSnapshots.set(panelKey, createPrompt({ status: 'draft', report: '' }));
	(manager as any).panelBasePrompts.set(panelKey, createPrompt({ status: 'draft', report: '' }));

	(manager as any).applyPersistedPromptToPanelState(panelKey, currentPrompt, persistedPrompt, {
		clearDirty: true,
	});

	assert.equal((manager as any).panelPromptRefs.get(panelKey).status, 'in-progress');
	assert.equal((manager as any).panelPromptRefs.get(panelKey).report, 'Persisted report');
	assert.equal((manager as any).panelDirtyFlags.get(panelKey), false);
	assert.equal((manager as any).panelLatestPromptSnapshots.get(panelKey), null);
	assert.equal((manager as any).panelBasePrompts.get(panelKey).status, 'in-progress');
	assert.equal((manager as any).panelBasePrompts.get(panelKey).report, 'Persisted report');
});

test('hasMeaningfulPromptDiff ignores title and description changes while AI enrichment is pending', async () => {
	const { manager } = await createManager();
	const content = 'This prompt content is long enough to keep fallback metadata stable while AI is still running.';
	const snapshot = createPrompt({ content });
	const fallbackTitle = (manager as any).makeTitleFallbackFromContent(content);
	const fallbackDescription = (manager as any).makeDescriptionFallbackFromContent(content);
	const fallbackPrompt = createPrompt({
		content,
		title: fallbackTitle,
		description: fallbackDescription,
	});
	const enrichedPrompt = createPrompt({
		content,
		title: 'Generated AI title',
		description: 'Generated AI description',
	});

	(manager as any).setPendingPromptAiEnrichmentState(snapshot.id, snapshot.promptUuid, {
		title: true,
		description: true,
	});

	assert.equal((manager as any).hasMeaningfulPromptDiff(fallbackPrompt, enrichedPrompt), false);
	assert.equal(
		(manager as any).hasMeaningfulPromptDiff(
			createPrompt({ ...fallbackPrompt, content: `${content} Extra user change.` }),
			enrichedPrompt,
		),
		true,
	);
});

test('setPendingPromptAiEnrichmentState emits sidebar-friendly state changes only when flags change', async () => {
	const { manager } = await createManager();
	const snapshot = createPrompt();
	const events: Array<{ promptId: string; promptUuid?: string; title: boolean; description: boolean }> = [];

	manager.onDidPromptAiEnrichmentStateChange((event) => {
		events.push(event);
	});

	(manager as any).setPendingPromptAiEnrichmentState(snapshot.id, snapshot.promptUuid, {
		title: true,
		description: false,
	});
	(manager as any).setPendingPromptAiEnrichmentState(snapshot.id, snapshot.promptUuid, {
		title: true,
		description: false,
	});
	(manager as any).setPendingPromptAiEnrichmentState(snapshot.id, snapshot.promptUuid, null);

	assert.deepEqual(events, [
		{
			promptId: snapshot.id,
			promptUuid: snapshot.promptUuid,
			title: true,
			description: false,
		},
		{
			promptId: snapshot.id,
			promptUuid: snapshot.promptUuid,
			title: false,
			description: false,
		},
	]);
});

test('project instructions are normalized without applyTo frontmatter and stripped for webview state', async () => {
	const { EditorPanelManager } = await importEditorPanelManager();
	const body = '# Project rules\n\nUse repository conventions.';
	const legacyWrapped = "---\napplyTo: '**'\n---\n\n# Project rules\n\nUse repository conventions.\n";
	const customFrontmatter = `---\ntitle: Project rules\n---\n\n${body}`;

	assert.equal(
		(EditorPanelManager as any).stripInstructionFrontmatter(legacyWrapped),
		body,
	);
	assert.equal((EditorPanelManager as any).normalizeInstructionContent(body), `${body}\n`);
	assert.equal((EditorPanelManager as any).normalizeInstructionContent(legacyWrapped), `${body}\n`);
	assert.equal((EditorPanelManager as any).normalizeInstructionContent(customFrontmatter), `${customFrontmatter}\n`);
	assert.equal((EditorPanelManager as any).normalizeInstructionContent(''), '');
});

test('getEditorWebviewLocalResourceRoots skips redundant child roots for clipboard files in workspace storage', async () => {
	const { manager } = await createManager();
	const roots = (manager as any).getEditorWebviewLocalResourceRoots([
		'/tmp/workspace/.vscode/prompt-manager/clipboard-context/clipboard-image.png',
	]);
	const rootPaths = roots.map((uri: { fsPath: string }) => uri.fsPath);

	assert.ok(rootPaths.includes('/tmp/workspace'));
	assert.ok(rootPaths.includes('/tmp/extension'));
	assert.ok(!rootPaths.includes('/tmp/workspace/.vscode/prompt-manager/clipboard-context'));
});

test('updateEditorWebviewOptions avoids resetting identical roots for clipboard previews inside workspace', async () => {
	const { manager } = await createManager();
	const initialOptions = (manager as any).getEditorWebviewOptions([]);
	let assignedCount = 0;
	let storedOptions = initialOptions;
	const panel = {
		webview: {
			get options() {
				return storedOptions;
			},
			set options(value: typeof initialOptions) {
				assignedCount += 1;
				storedOptions = value;
			},
		},
	};

	(manager as any).updateEditorWebviewOptions(panel as any, [
		'/tmp/workspace/.vscode/prompt-manager/clipboard-context/clipboard-image.png',
	]);

	assert.equal(assignedCount, 0);
});

test('updateEditorWebviewOptions still expands roots for files outside current workspace coverage', async () => {
	const { manager } = await createManager();
	const initialOptions = (manager as any).getEditorWebviewOptions([]);
	let assignedCount = 0;
	let storedOptions = initialOptions;
	const panel = {
		webview: {
			get options() {
				return storedOptions;
			},
			set options(value: typeof initialOptions) {
				assignedCount += 1;
				storedOptions = value;
			},
		},
	};

	(manager as any).updateEditorWebviewOptions(panel as any, [
		'/tmp/external-assets/clipboard-image.png',
	]);

	assert.equal(assignedCount, 1);
});

test('buildChatMemorySummary aggregates attached files, missing context and codemap counters', async () => {
	const { manager } = await createManager();
	const prompt = createPrompt({
		contextFiles: ['/tmp/workspace/src/services/memory.ts', '/tmp/workspace/docs/missing.md'],
	});
	const sessionRecord = {
		contextStats: {
			totalChars: 3200,
			shortTermCommits: 4,
			longTermSummaries: 2,
			hasProjectMap: true,
			uncommittedProjects: 1,
		},
	};
	const instructionFiles = [
		{
			label: 'Global agent instructions',
			fileName: 'prompt-manager.instructions.md',
			sourceKind: 'global',
			description: 'Core rules',
			exists: true,
			sizeBytes: 1536,
			sizeLabel: '1.5 KB',
			modifiedAt: '2026-04-13T11:59:00.000Z',
		},
		{
			label: 'Project instructions',
			fileName: 'feature.instructions.md',
			sourceKind: 'project',
			description: 'Workspace rules',
			exists: false,
			sizeBytes: 0,
			sizeLabel: '-',
		},
	];
	const contextFileCards = [
		{
			path: '/tmp/workspace/src/services/memory.ts',
			displayName: 'memory.ts',
			directoryLabel: 'src/services',
			extension: '.ts',
			tileLabel: 'TS',
			kind: 'code',
			typeLabel: 'TypeScript',
			exists: true,
			sizeBytes: 2048,
			sizeLabel: '2 KB',
			modifiedAt: '2026-04-13T11:58:00.000Z',
		},
		{
			path: '/tmp/workspace/docs/missing.md',
			displayName: 'missing.md',
			directoryLabel: 'docs',
			extension: '.md',
			tileLabel: 'MD',
			kind: 'text',
			typeLabel: 'Markdown',
			exists: false,
			sizeBytes: 0,
			sizeLabel: '-',
		},
	];
	const codemap = {
		repositoryCount: 1,
		instructionCount: 2,
		queuedRefreshCount: 1,
		totalFileCount: 9,
		describedFilesCount: 7,
		describedSymbolsCount: 22,
		describedMethodLikeCount: 13,
		totalSizeBytes: 8192,
		totalCompressedSizeBytes: 4096,
		repositories: [],
	};

	(manager as any).buildInstructionFileSummaries = async () => instructionFiles;
	(manager as any).buildContextFileCards = async () => contextFileCards;

	const summary = await (manager as any).buildChatMemorySummary(
		sessionRecord,
		{
			instructionReferences: ['#file:/tmp/workspace/.vscode/prompt-manager/prompt-manager.instructions.md'],
			promptContextReferences: ['/tmp/workspace/src/services/memory.ts', '/tmp/workspace/docs/missing.md'],
			allAbsolutePaths: ['/tmp/workspace/src/services/memory.ts', '/tmp/workspace/docs/missing.md'],
		},
		prompt,
		{} as any,
		codemap,
	);

	assert.equal(summary.totalChars, 3200);
	assert.equal(summary.shortTermCommits, 4);
	assert.equal(summary.longTermSummaries, 2);
	assert.equal(summary.hasProjectMap, true);
	assert.equal(summary.uncommittedProjects, 1);
	assert.equal(summary.instructionFiles.length, 2);
	assert.equal(summary.contextFiles.totalCount, 2);
	assert.equal(summary.contextFiles.existingCount, 1);
	assert.equal(summary.contextFiles.missingCount, 1);
	assert.equal(summary.contextFiles.kindBreakdown.length, 1);
	assert.equal(summary.contextFiles.kindBreakdown[0]?.kind, 'code');
	assert.equal(summary.totals.instructionFilesCount, 1);
	assert.equal(summary.totals.attachedFilesCount, 2);
	assert.equal(summary.totals.totalSizeBytes, 3584);
	assert.equal(summary.totals.describedFilesCount, 7);
	assert.equal(summary.totals.describedSymbolsCount, 22);
	assert.equal(summary.totals.describedMethodLikeCount, 13);
	assert.equal(summary.codemap, codemap);
	assert.ok(!Number.isNaN(Date.parse(summary.generatedAt)));
});

/** Host переключает правила загрузки сразу, даже пока сохранение другого режима ожидает запись. */
test('dashboard layout switching isolates pending saves and active refresh policy', async () => {
	const gate = createDeferred<void>();
	const savedModes: string[] = [];
	const layouts = normalizePromptDashboardLayouts();
	const { manager } = await createManager({
		stateService: {
			getPromptDashboardLayouts: () => clonePrompt(layouts),
			savePromptDashboardCollapsedSections: async (state: Record<string, boolean>, mode: 'single-column' | 'two-columns') => {
				savedModes.push(mode);
				await gate.promise;
				layouts[mode].collapsedSections = { ...state };
			},
		},
	});
	const prompt = createPrompt({ id: 'task-42', promptUuid: 'uuid-42' });
	/** Вызывает реальный обработчик сообщений без файловой системы и рабочих сервисов. */
	const dispatch = (message: unknown) => (manager as any).handleMessage(
		message, { webview: {} }, prompt, 'panel-a', () => false, () => undefined,
	);
	await dispatch({ type: 'promptDashboardLayoutModeChanged', layoutMode: 'single-column' });
	const saving = dispatch({
		type: 'savePromptDashboardCollapsedSections', layoutMode: 'single-column', state: { activity: true },
	});
	assert.equal((manager as any).isPromptDashboardWidgetCollapsed('activity'), true);
	await dispatch({ type: 'promptDashboardLayoutModeChanged', layoutMode: 'two-columns' });
	assert.equal((manager as any).isPromptDashboardWidgetCollapsed('activity'), false);
	gate.resolve();
	await saving;
	assert.equal((manager as any).isPromptDashboardWidgetCollapsed('activity'), false);
	await dispatch({ type: 'promptDashboardLayoutModeChanged', layoutMode: 'single-column' });
	assert.equal((manager as any).isPromptDashboardWidgetCollapsed('activity'), true);
	assert.deepEqual(savedModes, ['single-column']);
	const message = (manager as any).buildPromptMessage(prompt);
	assert.deepEqual(message.promptDashboardLayouts['single-column'].collapsedSections, { activity: true });
	assert.deepEqual(message.promptDashboardLayouts['two-columns'].collapsedSections, {});
});

/** Подтверждение каждого вида layout приходит только после фактического завершения записи. */
test('dashboard persistence acknowledges layout requests only after successful writes', async () => {
	for (const type of ['savePromptDashboardCollapsedSections', 'savePromptDashboardSectionOrder'] as const) {
		const release = createDeferred<void>();
		const messages: Array<{ type: string; requestId?: string }> = [];
		const { manager } = await createManager({ stateService: { [type]: () => release.promise } });
		const panel = { webview: { postMessage: async (message: { type: string }) => { messages.push(message); } } };
		const saving = (manager as any).handleMessage({ type, requestId: type, layoutMode: 'single-column',
			state: { activity: true }, order: [['todos', 'activity']] },
		panel, createPrompt(), 'panel-a', () => false, () => undefined);
		try {
			assert.deepEqual(messages, []);
		} finally {
			release.resolve();
			await saving;
			manager.disposeAll();
		}
		assert.deepEqual(messages.map(({ type, requestId }) => ({ type, requestId })),
			[{ type: 'promptDashboardStateSaved', requestId: type }]);
		assert.ok((messages[0] as any).settings.editorLayout);
	}
});

/** Отказ записи не отменяет видимый layout; bootstrap продолжает использовать подтверждённое хранилище. */
test('dashboard persistence reports failed layout writes without reverting the visible state', async () => {
	for (const type of ['savePromptDashboardCollapsedSections', 'savePromptDashboardSectionOrder'] as const) {
		const messages: Array<{ type: string; requestId?: string }> = [];
		const { manager } = await createManager({ stateService: {
			[type]: async () => { throw new Error('simulated write failure'); },
		} });
		const before = clonePrompt((manager as any).promptDashboardLayoutsState);
		const panel = { webview: { postMessage: async (message: { type: string }) => { messages.push(message); } } };
		try {
			await (manager as any).handleMessage({ type, requestId: type, layoutMode: 'single-column',
				state: { activity: true }, order: [['todos', 'activity']] },
			panel, createPrompt(), 'panel-a', () => false, () => undefined);
			const active = (manager as any).promptDashboardLayoutsState['single-column'];
			if (type === 'savePromptDashboardCollapsedSections') {
				assert.deepEqual(active.collapsedSections, { activity: true });
			} else {
				assert.deepEqual(active.sectionOrder[0].slice(0, 2), ['todos', 'activity']);
			}
			assert.equal(messages.length, 1);
			assert.equal(messages[0].type, 'error');
			assert.equal(messages[0].requestId, type);
			const restoredPanel = createDetachedPromptEditorPanel();
			(manager as any).rebootPromptPanelWebview('panel-a', restoredPanel, createPrompt(),
				(manager as any).buildPromptMessage(createPrompt()));
			assert.deepEqual((manager as any).consumePendingReadyPromptMessage('panel-a').promptDashboardLayouts, before);
			assert.deepEqual((manager as any).promptDashboardLayoutsState, before);
		} finally {
			manager.disposeAll();
		}
	}
});

/** Раскрытие с отказом хранения не должно блокировать последующее ручное обновление видимой карточки. */
test('dashboard manual refresh remains available after an expanded widget fails to persist', async () => {
	// Подтверждённое хранилище остаётся свёрнутым, а текущий интерфейс уже показывает TODO.
	const savedLayouts = normalizePromptDashboardLayouts();
	savedLayouts['single-column'].collapsedSections = { todos: true };
	const { manager } = await createManager({ stateService: {
		getPromptDashboardLayouts: () => clonePrompt(savedLayouts),
		savePromptDashboardCollapsedSections: async () => { throw new Error('simulated write failure'); },
	} });
	const messages: Array<{ type: string; requestId?: string }> = [];
	const refreshedWidgets: string[] = [];
	const panel = { webview: { postMessage: async (message: { type: string }) => { messages.push(message); } } };
	(manager as any).promptDashboardService.refreshWidgetSnapshot = async (_prompt: unknown, widget: string) => {
		refreshedWidgets.push(widget);
	};
	/** Доставляет события реальному обработчику без рабочего workspace. */
	const dispatch = (message: unknown) => (manager as any).handleMessage(
		message, panel, createPrompt(), 'panel-a', () => false, () => undefined,
	);
	try {
		await dispatch({ type: 'promptDashboardLayoutModeChanged', layoutMode: 'single-column' });
		assert.equal((manager as any).isPromptDashboardWidgetCollapsed('todos'), true);
		await dispatch({ type: 'savePromptDashboardCollapsedSections', layoutMode: 'single-column',
			state: { todos: false }, requestId: 'failed-expansion' });
		// Событие другой настройки не должно возвращать сохранённое сворачивание в политику видимой страницы.
		await (manager as any).broadcastPromptUiSettings();
		assert.equal((manager as any).isPromptDashboardWidgetCollapsed('todos'), false);

		await dispatch({ type: 'refreshPromptDashboardWidget', widget: 'todos', requestId: 'manual-refresh' });
		assert.deepEqual(refreshedWidgets, ['todos']);
		assert.equal(messages.some(message => message.type === 'error' && message.requestId === 'failed-expansion'), true);
		assert.equal(messages.some(message => message.type === 'promptDashboardStateSaved'), false);
		const restoredPanel = createDetachedPromptEditorPanel();
		(manager as any).rebootPromptPanelWebview('panel-a', restoredPanel, createPrompt(),
			(manager as any).buildPromptMessage(createPrompt()));
		assert.deepEqual((manager as any).consumePendingReadyPromptMessage('panel-a').promptDashboardLayouts, savedLayouts);
		assert.equal((manager as any).isPromptDashboardWidgetCollapsed('todos'), true);
	} finally {
		manager.disposeAll();
	}
});

/** Поздний отказ старого сохранения не откатывает более новое действие в том же профиле. */
test('dashboard persistence does not roll back a newer layout while an older request fails', async () => {
	const release = createDeferred<void>();
	let writes = 0;
	const layouts = normalizePromptDashboardLayouts();
	const { manager } = await createManager({ stateService: {
		getPromptDashboardLayouts: () => clonePrompt(layouts),
		savePromptDashboardCollapsedSections: async (state: Record<string, boolean>) => {
			if (++writes === 1) { await release.promise; throw new Error('older write failed'); }
			layouts['two-columns'].collapsedSections = { ...state };
		},
	} });
	const messages: Array<{ type: string; requestId?: string }> = [];
	const panel = { webview: { postMessage: async (message: { type: string }) => { messages.push(message); } } };
	/** Доставка двух сообщений не зависит от таймеров или настоящего extension host. */
	const dispatch = (requestId: string, state: Record<string, boolean>) => (manager as any).handleMessage({
		type: 'savePromptDashboardCollapsedSections', requestId, state,
	}, panel, createPrompt(), 'panel-a', () => false, () => undefined);
	const older = dispatch('older', { activity: true });
	try {
		await dispatch('newer', { todos: true });
	} finally {
		release.resolve();
		await older;
		manager.disposeAll();
	}
	assert.deepEqual((manager as any).getPromptDashboardCollapsedSections(), { todos: true });
	assert.deepEqual(messages.map(message => [message.type, message.requestId]), [
		['promptDashboardStateSaved', 'newer'], ['error', 'older'],
	]);
});

/** Reopen ждёт принятую запись: новое дерево не затирает успешно сохранённую карту следующим действием. */
test('dashboard reopen waits for a pending collapse save before replacing the webview', async () => {
	for (const rejectFirstWrite of [false, true]) {
		resetVsCodeCommandMock();
		const { StateService } = await importEditorPanelManager();
		// Отдельный Memento и управляемая задержка не обращаются к рабочему хранилищу.
		const entered = createDeferred<void>();
		const release = createDeferred<void>();
		let writes = 0;
		const stateService = new StateService({ workspaceState: {
			get: (_key: string, fallback: unknown) => fallback,
		} } as unknown as ConstructorParameters<typeof StateService>[0]);
		const { manager } = await createManager({ initialPrompt: createPrompt(), stateService: {
			getPromptDashboardLayouts: () => stateService.getPromptDashboardLayouts(),
			savePromptDashboardCollapsedSections: stateService.savePromptDashboardCollapsedSections.bind(stateService),
			waitForPromptDashboardSaves: () => stateService.waitForPromptDashboardSaves(),
		} });
		vscodeConfigurationUpdateHandler = async (key, value) => {
			if (++writes === 1) {
				entered.resolve();
				await release.promise;
				if (rejectFirstWrite) { throw new Error('testing dashboard write failure'); }
			}
			vscodeConfigurationValues.set(key, structuredClone(value));
		};
		await manager.openPrompt('prompt-a');
		const panel = vscodeCreatedWebviewPanels.at(-1);
		const key = '__prompt_editor_singleton__';
		const prompt = createPrompt();
		const previousHtml = panel.webview.html;
		/** Передаёт полную карту из отображаемого дерева, как обработчик сворачивания webview. */
		const dispatch = (state: Record<string, boolean>) => (manager as any).handleMessage({
			type: 'savePromptDashboardCollapsedSections', layoutMode: 'two-columns', requestId: 'save-review', state,
		}, panel, prompt, key, () => false, () => undefined);
		const saving = dispatch({ todos: true });
		await entered.promise;
		let reopened = false;
		const reopening = manager.openPrompt('prompt-a').then(() => { reopened = true; });
		try {
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(reopened, false);
			assert.equal(panel.webview.html, previousHtml);
			release.resolve();
			await Promise.all([saving, reopening]);
			const ready = (manager as any).consumePendingReadyPromptMessage(key);
			const expected = rejectFirstWrite ? {} : { todos: true };
			assert.deepEqual(ready.promptDashboardCollapsedSections, expected);
			assert.deepEqual((manager as any).getPromptDashboardCollapsedSections(), expected);
			await dispatch({ ...ready.promptDashboardCollapsedSections, activity: true });
			assert.deepEqual(stateService.getPromptDashboardCollapsedSections('two-columns'), {
				...expected, activity: true,
			});
		} finally {
			release.resolve();
			await Promise.all([saving, reopening]);
			manager.disposeAll();
		}
	}
});

/** Отложенный ready обновляет workspace-снимок, сохраняя identity и версию открытия промпта. */
test('dashboard persistence refreshes stale pending ready layouts and preferences', async () => {
	let savedLayouts = normalizePromptDashboardLayouts();
	let savedPreferences = normalizePromptDashboardPreferences({ docker: { search: 'old' } });
	const { manager } = await createManager({ stateService: {
		getPromptDashboardLayouts: () => clonePrompt(savedLayouts),
		getPromptDashboardPreferences: () => clonePrompt(savedPreferences),
	} });
	const key = '__prompt_editor_singleton__';
	const prompt = createPrompt();
	(manager as any).pendingReadyPromptMessages.set(key, {
		type: 'prompt', prompt, reason: 'open', openRequestVersion: 7,
		promptDashboardLayouts: clonePrompt(savedLayouts), promptDashboardPreferences: clonePrompt(savedPreferences),
	});
	savedLayouts = normalizePromptDashboardLayouts({
		'single-column': { sectionOrder: [['todos']], collapsedSections: {} },
		'two-columns': { sectionOrder: [[], ['todos', 'status', 'activity', 'projectBranches',
			'reviewRequests', 'projectCommits', 'parallelBranches', 'aiAnalysis', 'dockerContainers']],
		collapsedSections: { activity: true } },
	});
	savedPreferences = normalizePromptDashboardPreferences({ expanded: { 'project:api': false } });
	(manager as any).promptDashboardLayoutsState = clonePrompt(savedLayouts);
	try {
		const message = (manager as any).consumePendingReadyPromptMessage(key);
		assert.deepEqual(message.promptDashboardLayouts, savedLayouts);
		assert.deepEqual(message.promptDashboardCollapsedSections, { activity: true });
		assert.deepEqual(message.promptDashboardSectionOrder, savedLayouts['two-columns'].sectionOrder);
		assert.deepEqual(message.promptDashboardPreferences, savedPreferences);
		assert.equal(message.openRequestVersion, 7);
		assert.equal(message.prompt.promptUuid, prompt.promptUuid);
		assert.equal((manager as any).consumePendingReadyPromptMessage(key), undefined);
	} finally {
		manager.disposeAll();
	}
});

/** Ready согласует загрузчик с новым bootstrap, но не отменяет раннее действие нового дерева webview. */
test('dashboard ready synchronizes loading policy unless a local layout action already occurred', async () => {
	for (const editedBeforeReady of [false, true]) {
		// Запись может завершиться между HTML bootstrap и получением ready.
		let savedLayouts = normalizePromptDashboardLayouts();
		const gate = createDeferred<void>();
		let localSave: Promise<void> | undefined;
		const { manager } = await createManager({ stateService: {
			getPromptDashboardLayouts: () => clonePrompt(savedLayouts),
			savePromptDashboardCollapsedSections: async (state: Record<string, boolean>) => {
				await gate.promise;
				savedLayouts['two-columns'].collapsedSections = { ...state };
			},
		} });
		const panel = createDetachedPromptEditorPanel();
		const prompt = createPrompt();
		try {
			(manager as any).rebootPromptPanelWebview('panel-a', panel, prompt,
				(manager as any).buildPromptMessage(prompt));
			savedLayouts['two-columns'].collapsedSections = { todos: true };
			if (editedBeforeReady) {
				localSave = (manager as any).handleMessage({ type: 'savePromptDashboardCollapsedSections',
					layoutMode: 'two-columns', state: { activity: true } },
				panel, prompt, 'panel-a', () => false, () => undefined);
			}
			const message = (manager as any).consumePendingReadyPromptMessage('panel-a');
			assert.deepEqual(message.promptDashboardLayouts, savedLayouts);
			assert.deepEqual((manager as any).getPromptDashboardCollapsedSections(),
				editedBeforeReady ? { activity: true } : { todos: true });
		} finally {
			gate.resolve();
			await localSave;
			manager.disposeAll();
		}
	}
});

/** Сохранение preferences подтверждается после await; повторный полный снимок восстанавливает отказ. */
test('dashboard persistence handles preferences acknowledgement failure and full retry', async () => {
	const release = createDeferred<void>();
	const messages: Array<{ type: string; requestId?: string }> = [];
	const writes: unknown[] = [];
	let saved = normalizePromptDashboardPreferences({ docker: { search: 'initial' } });
	const { manager } = await createManager({ stateService: {
		getPromptDashboardPreferences: () => clonePrompt(saved),
		savePromptDashboardPreferences: async (state: typeof saved) => {
			writes.push(clonePrompt(state));
			if (writes.length === 1) { await release.promise; throw new Error('preferences write failed'); }
			saved = clonePrompt(state);
		},
	} });
	const panel = { webview: { postMessage: async (message: { type: string }) => { messages.push(message); } } };
	const next = normalizePromptDashboardPreferences({ todos: { search: 'latest' }, expanded: { 'project:api': false } });
	/** Вызывает новый транспорт напрямую без рабочего workspace и побочных действий. */
	const dispatch = (requestId: string) => (manager as any).handleMessage({
		type: 'savePromptDashboardPreferences', requestId, state: next,
	}, panel, createPrompt(), 'panel-a', () => false, () => undefined);
	const failed = dispatch('failed');
	try {
		assert.equal(messages.length, 0);
		assert.equal((manager as any).buildPromptMessage(createPrompt()).promptDashboardPreferences.docker.search, 'initial');
		release.resolve();
		await failed;
		assert.equal((manager as any).buildPromptMessage(createPrompt()).promptDashboardPreferences.docker.search, 'initial');
		assert.equal(messages[0]?.type, 'error');
		assert.equal(messages[0]?.requestId, 'failed');
		await dispatch('retry');
		assert.equal(messages[1].type, 'promptDashboardStateSaved');
		assert.equal(messages[1].requestId, 'retry');
		assert.deepEqual((manager as any).buildPromptMessage(createPrompt()).promptDashboardPreferences, next);
		assert.deepEqual(writes, [next, next]);
	} finally {
		release.resolve();
		await failed;
		manager.disposeAll();
	}
});

/** An error replies to the modal with the persisted state. Only the matching successful retry publishes the command. */
test('quick command modal saves just its command and receives the confirmed settings on failure and retry', async () => {
	let saved = normalizePromptDashboardPreferences({ quickCommands: { items: [{ title: 'A', text: 'old' }] } });
	const baseState = clonePrompt(saved);
	const edit = { original: saved.quickCommands.items[0], command: { title: 'A', text: 'новый {{taskNumber}}' } };
	let fail = true;
	const { manager } = await createManager({ stateService: {
		getPromptDashboardPreferences: () => clonePrompt(saved),
		saveDashboardQuickCommand: async (actual: typeof edit) => {
			assert.deepEqual(actual, edit);
			if (fail) { fail = false; throw new Error('busy'); }
			saved = { ...saved, quickCommands: { items: [actual.command] } };
		},
	} });
	const messages: Array<{ type: string; requestId: string; error?: string; settings: { dashboardPreferences: typeof saved } }> = [];
	const panel = { webview: { postMessage: async (message: typeof messages[number]) => { messages.push(message); return true; } } };
	const send = (requestId: string) => (manager as any).handleMessage({ type: 'savePromptDashboardQuickCommand',
		requestId, edit }, panel, createPrompt(), 'panel-a', () => false, () => undefined);
	try {
		await send('first');
		assert.equal(messages[0].type, 'promptDashboardQuickCommandSaved');
		assert.equal(messages[0].requestId, 'first');
		assert.ok(messages[0].error);
		assert.deepEqual(messages[0].settings.dashboardPreferences, baseState);
		await send('retry');
		assert.equal(messages[1].requestId, 'retry');
		assert.equal(messages[1].error, undefined);
		assert.deepEqual(messages[1].settings.dashboardPreferences, { ...baseState, quickCommands: { items: [edit.command] } });
	} finally { manager.disposeAll(); }
});

/** Bootstrap не подставляет defaults вместо отсутствия записи и безопасно передаёт сохранённый JSON. */
test('dashboard persistence boot injects confirmed preferences and preserves absent migration state', async () => {
	for (const preferences of [undefined, normalizePromptDashboardPreferences({
		docker: { search: '</script><script>unsafe</script>' }, expanded: { 'project:api': false },
	})]) {
		const { manager } = await createManager({ stateService: { getPromptDashboardPreferences: () => preferences } });
		const panel = createDetachedPromptEditorPanel();
		const prompt = createPrompt();
		try {
			(manager as any).rebootPromptPanelWebview('panel-a', panel, prompt,
				(manager as any).buildPromptMessage(prompt));
			const match = panel.webview.html.match(/Object\.assign\(window, (\{[^\n]+\})\);/);
			assert.ok(match);
			const globals = JSON.parse(match[1]);
			assert.deepEqual(globals.__PROMPT_DASHBOARD_PREFERENCES__, preferences);
			assert.equal(Object.hasOwn(globals, '__PROMPT_DASHBOARD_PREFERENCES__'), preferences !== undefined);
			assert.equal(panel.webview.html.includes('</script><script>unsafe</script>'), false);
		} finally {
			manager.disposeAll();
		}
	}
});

/** Правки, пришедшие во время ручного сохранения, должны попасть на диск до перехода. */
test('openPrompt preserves a newer revision received during a pending save', async () => {
	resetVsCodeCommandMock();
	const started = createDeferred<void>();
	const release = createDeferred<void>();
	const writes: string[] = [];
	const { manager, storageService, getStoredPrompt } = await createManager({
		initialPrompt: { title: 'prompt-a', description: 'Description', content: 'Base' },
		savePrompt: async prompt => {
			writes.push(prompt.content);
			if (writes.length === 1) { started.resolve(); await release.promise; }
			return clonePrompt(prompt);
		},
	});
	const key = '__prompt_editor_singleton__';
	const originalGet = storageService.getPrompt;
	storageService.getPrompt = async id => id === 'prompt-b'
		? createPrompt({ id, promptUuid: 'uuid-b', title: 'prompt-b' }) : originalGet(id);
	try {
		await manager.openPrompt('prompt-a');
		const panel = vscodeCreatedWebviewPanels.at(-1)!;
		const current = clonePrompt((manager as any).panelPromptRefs.get(key));
		const saving = panel.emitMessage({ type: 'savePrompt', localRevision: 1,
			prompt: { ...current, content: 'First edit' } });
		await started.promise;
		await panel.emitMessage({ type: 'markDirty', dirty: true, localRevision: 2,
			prompt: { ...current, content: 'Latest edit' } });
		const switching = manager.openPrompt('prompt-b');
		await flushTurns();
		release.resolve();
		await Promise.all([saving, switching]);
		assert.deepEqual(writes, ['First edit', 'Latest edit']);
		assert.equal(getStoredPrompt().content, 'Latest edit');
		assert.equal((manager as any).panelPromptRefs.get(key).id, 'prompt-b');
	} finally {
		release.resolve();
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** Ошибка записи не разрешает заменить новый черновик другим промптом. */
test('openPrompt keeps unsaved draft and cancels loading after a save failure', async () => {
	resetVsCodeCommandMock();
	const { manager, storageService } = await createManager({
		savePrompt: async () => { throw new Error('EACCES simulated'); },
	});
	const key = '__prompt_editor_singleton__';
	storageService.getPrompt = async id => id === 'prompt-b'
		? createPrompt({ id, promptUuid: 'uuid-b', title: 'prompt-b' }) : null;
	try {
		await manager.openPrompt('__new__');
		const panel = vscodeCreatedWebviewPanels.at(-1)!;
		const draft = { ...(manager as any).panelPromptRefs.get(key), title: 'Draft', content: 'Unsaved text' };
		await panel.emitMessage({ type: 'markDirty', dirty: true, localRevision: 1, prompt: draft });
		await manager.openPrompt('prompt-b');
		assert.equal((manager as any).panelPromptRefs.get(key).id, '');
		assert.equal((manager as any).panelLatestPromptSnapshots.get(key).content, 'Unsaved text');
		assert.equal((manager as any).panelDirtyFlags.get(key), true);
		assert.ok(panel.postedMessages.some((message: any) => message.type === 'promptLoadingCancelled'));
	} finally {
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** Фоновое название и ручное сохранение используют одну очередь по UUID. */
test('background title enrichment cannot overwrite a concurrent manual task number and text', async () => {
	resetVsCodeCommandMock();
	const entered = createDeferred<void>();
	const release = createDeferred<void>();
	const original = createPrompt({ content: 'Original text', description: 'Description' });
	const { manager, storageService, getStoredPrompt } = await createManager({ initialPrompt: original });
	const key = '__prompt_editor_singleton__';
	let first = true;
	storageService.uniqueId = async base => {
		if (first) { first = false; entered.resolve(); await release.promise; }
		return base;
	};
	(manager as any).panelPromptRefs.set(key, original);
	(manager as any).panelBasePrompts.set(key, clonePrompt(original));
	(manager as any).syncTrackedPromptFilesForPanel = async () => undefined;
	try {
		const enrichment = (manager as any).scheduleBackgroundAiEnrichment(
			original.id, original.promptUuid, original.content, true, false, key);
		await entered.promise;
		const manual = (manager as any).handleMessage({ type: 'savePrompt', localRevision: 1,
			prompt: { ...original, title: 'Edited title', taskNumber: '169', content: 'Edited text' } },
			{ webview: { postMessage: async () => true } }, original, key, () => true, () => undefined);
		await flushTurns();
		release.resolve();
		await Promise.all([enrichment, manual]);
		assert.equal(getStoredPrompt().taskNumber, '169');
		assert.equal(getStoredPrompt().content, 'Edited text');
		assert.equal(getStoredPrompt().title, 'Edited title');
	} finally {
		release.resolve();
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** Отказ уже запущенного ручного сохранения также отменяет переключение панели. */
test('openPrompt cancels switching when an awaited manual save rejects', async () => {
	resetVsCodeCommandMock();
	const started = createDeferred<void>();
	const release = createDeferred<void>();
	const { manager, storageService } = await createManager({
		initialPrompt: { title: 'prompt-a', description: 'Description', content: 'Base' },
		savePrompt: async () => { started.resolve(); await release.promise; throw new Error('EACCES simulated'); },
	});
	const key = '__prompt_editor_singleton__';
	const originalGet = storageService.getPrompt;
	storageService.getPrompt = async id => id === 'prompt-b'
		? createPrompt({ id, promptUuid: 'uuid-b', title: 'prompt-b' }) : originalGet(id);
	try {
		await manager.openPrompt('prompt-a');
		const panel = vscodeCreatedWebviewPanels.at(-1)!;
		const draft = { ...(manager as any).panelPromptRefs.get(key), content: 'Unsaved text' };
		await panel.emitMessage({ type: 'markDirty', dirty: true, localRevision: 1, prompt: draft });
		const saving = panel.emitMessage({ type: 'savePrompt', prompt: draft, localRevision: 1 });
		await started.promise;
		const switching = manager.openPrompt('prompt-b');
		await flushTurns();
		release.resolve();
		await Promise.all([saving, switching]);
		assert.equal((manager as any).panelPromptRefs.get(key).id, 'prompt-a');
		assert.equal((manager as any).panelLatestPromptSnapshots.get(key).content, 'Unsaved text');
		assert.equal((manager as any).panelDirtyFlags.get(key), true);
	} finally {
		release.resolve();
		manager.disposeAll();
		resetVsCodeCommandMock();
	}
});

/** Сохранение глобального порядка подтверждается снимком после записи, включая настройки другого окна. */
test('editor layout persistence waits for the write and returns authoritative settings', async () => {
	const gate = createDeferred<void>();
	let layout = normalizePromptEditorLayout();
	const { manager } = await createManager({ stateService: {
		getPromptEditorLayout: () => structuredClone(layout),
		savePromptEditorLayout: async (next: typeof layout) => { await gate.promise; layout = next; },
	} });
	const messages: Array<{ type: string; requestId?: string; settings?: { editorLayout: typeof layout } }> = [];
	const panel = { webview: { postMessage: async (message: { type: string }) => { messages.push(message); } } };
	const next = { ...layout, process: [...layout.process].reverse(), mainExpandedSections: { time: false } };
	const saving = (manager as any).handleMessage({ type: 'savePromptEditorLayout', state: next,
		baseState: layout, requestId: 'form-order' }, panel, createPrompt(), 'panel-a', () => false, () => undefined);
	try {
		assert.equal(messages.length, 0);
		gate.resolve();
		await saving;
		assert.equal(messages[0].type, 'promptDashboardStateSaved');
		assert.equal(messages[0].requestId, 'form-order');
		assert.deepEqual(messages[0].settings?.editorLayout, next);
	} finally { gate.resolve(); await saving; manager.disposeAll(); }
});

/** Серия событий конфигурации доставляется живому редактору один раз после принятой очереди. */
test('external UI settings updates coalesce and preserve local Process view state', async () => {
	resetVsCodeCommandMock();
	let gate: ReturnType<typeof createDeferred<void>> | undefined;
	const layout = normalizePromptEditorLayout({ mainExpandedSections: { time: false } });
	const { manager } = await createManager({ initialPrompt: createPrompt(), stateService: {
		getPromptEditorLayout: () => structuredClone(layout),
		waitForPromptDashboardSaves: () => gate?.promise ?? Promise.resolve(),
	} });
	try {
		await manager.openPrompt('prompt-a');
		const panel = vscodeCreatedWebviewPanels.at(-1);
		panel.postedMessages.length = 0;
		gate = createDeferred<void>();
		const first = (manager as any).broadcastPromptUiSettings();
		const second = (manager as any).broadcastPromptUiSettings();
		assert.equal(panel.postedMessages.filter((m: { type: string }) => m.type === 'promptUiSettingsChanged').length, 0);
		gate.resolve();
		await Promise.all([first, second]);
		const messages = panel.postedMessages.filter((m: { type: string }) => m.type === 'promptUiSettingsChanged');
		assert.equal(messages.length, 1);
		assert.deepEqual(messages[0].settings.editorLayout, layout);
		assert.equal('editorViewState' in messages[0], false);
		assert.equal('notes' in messages[0].settings.editorLayout.mainExpandedSections, false);
	} finally { gate?.resolve(); manager.disposeAll(); }
});

/** Последняя вкладка немедленно доступна reopen, даже пока долговременная запись ещё не завершена. */
test('prompt reopen retains the latest tab while its view-state save is pending', async () => {
	resetVsCodeCommandMock();
	const gate = createDeferred<void>();
	const stored = new Map<string, ReturnType<typeof createEditorViewState>>([
		['prompt-a', createEditorViewState({ activeTab: 'process' })],
		['prompt-b', createEditorViewState({ activeTab: 'process' })],
	]);
	const { manager } = await createManager({ initialPrompt: { id: 'prompt-a', promptUuid: 'uuid-a' }, stateService: {
		getPromptEditorViewState: (source: { promptId: string }) => stored.get(source.promptId) || createEditorViewState(),
		savePromptEditorViewState: async (source: { promptId: string }, state: ReturnType<typeof createEditorViewState>) => {
			await gate.promise;
			stored.set(source.promptId, state);
		},
	} });
	try {
		await manager.openPrompt('prompt-a');
		const firstPanel = vscodeCreatedWebviewPanels.at(-1);
		await firstPanel.emitMessage({ type: 'savePromptEditorViewState', promptId: 'prompt-a', promptUuid: 'uuid-a',
			state: createEditorViewState({ activeTab: 'main' }) });
		firstPanel.dispose();
		await flushTurns(2);
		await manager.openPrompt('prompt-a');
		const reopened = vscodeCreatedWebviewPanels.at(-1);
		await reopened.emitMessage({ type: 'ready',
			bootId: (manager as any).panelBootIds.get('__prompt_editor_singleton__'),
			assetVersion: EDITOR_WEBVIEW_ASSET_VERSION });
		const opened = reopened.postedMessages.filter((message: { type: string; reason?: string }) =>
			message.type === 'prompt' && message.reason === 'open').at(-1);
		assert.equal(opened.editorViewState.activeTab, 'main');
		assert.equal(stored.get('prompt-a')?.activeTab, 'process');
		assert.equal((manager as any).getPromptLoadingEditorViewState('__prompt_editor_singleton__',
			{ id: 'prompt-b', promptUuid: 'uuid-b' }).activeTab, 'process');
		gate.resolve();
		await (manager as any).promptEditorViewStateSaveQueue;
		assert.equal(stored.get('prompt-a')?.activeTab, 'main');
	} finally { gate.resolve(); manager.disposeAll(); }
});

/** Plan mode survives closing and reopening before the dedicated preference has finished persisting. */
test('prompt reopen restores compact plan mode despite an older full-state snapshot', async () => {
	resetVsCodeCommandMock();
	const gate = createDeferred<void>();
	const modes = new Map<string, 'compact' | 'full'>();
	const { manager } = await createManager({
		initialPrompt: { id: 'prompt-a', promptUuid: 'uuid-a' },
		stateService: {
			getPromptEditorViewState: () => createEditorViewState({ planViewMode: 'full' }),
			getPromptPlanViewMode: (source: { promptUuid: string }) => modes.get(source.promptUuid) || null,
			savePromptPlanViewMode: async (source: { promptUuid: string }, mode: 'compact' | 'full') => {
				await gate.promise;
				modes.set(source.promptUuid, mode);
			},
		},
	});
	try {
		await manager.openPrompt('prompt-a');
		const firstPanel = vscodeCreatedWebviewPanels.at(-1)!;
		const selection = firstPanel.emitMessage({
			type: 'savePromptPlanViewMode', promptId: 'prompt-a', promptUuid: 'uuid-a', mode: 'compact',
		});
		await flushTurns(2);
		// The general layout channel can still deliver an older Full snapshot during close.
		await firstPanel.emitMessage({
			type: 'savePromptEditorViewState', promptId: 'prompt-a', promptUuid: 'uuid-a',
			state: createEditorViewState({ planViewMode: 'full' }),
		});
		firstPanel.dispose();
		await flushTurns(2);
		await manager.openPrompt('prompt-a');
		const reopened = vscodeCreatedWebviewPanels.at(-1)!;
		await reopened.emitMessage({ type: 'ready',
			bootId: (manager as any).panelBootIds.get('__prompt_editor_singleton__'),
			assetVersion: EDITOR_WEBVIEW_ASSET_VERSION });
		const opened = reopened.postedMessages.filter((message: { type: string; reason?: string }) =>
			message.type === 'prompt' && message.reason === 'open').at(-1);
		assert.equal(opened.editorViewState.planViewMode, 'compact');
		assert.equal((manager as any).getPromptLoadingEditorViewState('__prompt_editor_singleton__',
			{ id: 'prompt-b', promptUuid: 'uuid-b' }).planViewMode, 'full');
		gate.resolve();
		await selection;
		assert.equal(modes.get('uuid-a'), 'compact');

		// Durable storage must beat an unrelated stale Full snapshot even after the cache clears.
		await reopened.emitMessage({
			type: 'savePromptEditorViewState', promptId: 'prompt-a', promptUuid: 'uuid-a',
			state: createEditorViewState({ planViewMode: 'full' }),
		});
		const durable = (manager as any).getPromptEditorViewState('__prompt_editor_singleton__',
			{ id: 'prompt-a', promptUuid: 'uuid-a' });
		assert.equal(durable.planViewMode, 'compact');
	} finally { gate.resolve(); manager.disposeAll(); resetVsCodeCommandMock(); }
});

/** Успех независимого флага не отменяет ошибочное раскрытие другой карточки; bootstrap сбрасывает overlay. */
test('dashboard keeps failed collapse fields through an unrelated successful save and external update', async () => {
	resetVsCodeCommandMock();
	const confirmed = normalizePromptDashboardLayouts();
	confirmed['two-columns'].collapsedSections = { activity: true, todos: true };
	let writes = 0;
	const { manager } = await createManager({ stateService: {
		getPromptDashboardLayouts: () => clonePrompt(confirmed),
		savePromptDashboardCollapsedSections: async () => {
			if (++writes === 1) { throw new Error('activity write failed'); }
			confirmed['two-columns'].collapsedSections = { activity: true };
		},
	} });
	const panel = createDetachedPromptEditorPanel();
	const dispatch = (requestId: string, state: Record<string, boolean>, baseState: Record<string, boolean>) =>
		(manager as any).handleMessage({ type: 'savePromptDashboardCollapsedSections', layoutMode: 'two-columns',
			requestId, state, baseState }, panel, createPrompt(), 'panel-a', () => false, () => undefined);
	try {
		await dispatch('failed-activity', { todos: true }, { activity: true, todos: true });
		await dispatch('saved-todos', {}, { todos: true });
		await (manager as any).broadcastPromptUiSettings();
		assert.equal((manager as any).isPromptDashboardWidgetCollapsed('activity'), false);
		assert.equal((manager as any).isPromptDashboardWidgetCollapsed('todos'), false);
		assert.deepEqual(confirmed['two-columns'].collapsedSections, { activity: true });
		(manager as any).rebootPromptPanelWebview('panel-a', panel, createPrompt(),
			(manager as any).buildPromptMessage(createPrompt()));
		assert.equal((manager as any).isPromptDashboardWidgetCollapsed('activity'), true);
		assert.equal((manager as any).isPromptDashboardWidgetCollapsed('todos'), false);
	} finally { manager.disposeAll(); }
});

test('refreshPromptDashboardWidget skips widgets hidden by the widgets menu and loads them right after they are shown', async () => {
	const saveGate = createDeferred<void>();
	const refreshed: string[] = [];
	const collapsedSent: unknown[] = [];
	const { manager } = await createManager({
		stateService: {
			getPromptDashboardCollapsedSections: () => ({}),
			getPromptDashboardPreferences: () => ({ hiddenSections: ['todos'] }),
			savePromptDashboardPreferences: async () => {
				await saveGate.promise;
			},
		},
	});
	const panelMessages: any[] = [];
	const panel = { webview: { postMessage: async (message: unknown) => { panelMessages.push(message); return true; } } };
	(manager as any).promptDashboardHiddenSections = ['todos'];
	(manager as any).promptDashboardService = {
		setDockerWidgetCollapsed: () => undefined,
		setCollapsedSections: (state: unknown) => { collapsedSent.push(state); },
		refreshWidgetSnapshot: async (_prompt: unknown, widget: string) => {
			refreshed.push(widget);
			return null;
		},
	};
	const prompt = createPrompt({ id: 'task-42', promptUuid: 'uuid-42', projects: ['api'] });
	const dispatch = (message: unknown) => (manager as any).handleMessage(message, panel, prompt, 'panel-a', () => false, () => undefined);

	await dispatch({ type: 'refreshPromptDashboardWidget', prompt, widget: 'todos', section: 'todos', requestId: 'hidden-refresh' });
	assert.deepEqual(refreshed, []);
	assert.equal(panelMessages.some(message => message?.type === 'promptDashboardRequestCompleted' && message.requestId === 'hidden-refresh'), true);

	// Сохранение показа и запрос данных приходят подряд: запись ещё не завершена, а запрос уже не пропускается.
	const savePromise = dispatch({ type: 'savePromptDashboardPreferences', state: { hiddenSections: [] } });
	await dispatch({ type: 'refreshPromptDashboardWidget', prompt, widget: 'todos', section: 'todos', requestId: 'shown-refresh' });
	saveGate.resolve();
	await savePromise;
	assert.deepEqual(refreshed, ['todos']);
	assert.deepEqual(collapsedSent.at(-1), {});
});
