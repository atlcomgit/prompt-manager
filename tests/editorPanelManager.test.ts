import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const originalLoad = (Module as any)._load;
const vscodeCommandCalls: Array<{ id: string; args: unknown[] }> = [];
let vscodeExecuteCommandHandler: ((id: string, ...args: unknown[]) => Promise<unknown>) | undefined;
let vscodeAvailableCommands: string[] | undefined;
const vscodeConfigurationValues = new Map<string, unknown>();

function createDisposable() {
	return { dispose() { } };
}

function resetVsCodeCommandMock() {
	vscodeCommandCalls.length = 0;
	vscodeExecuteCommandHandler = undefined;
	vscodeAvailableCommands = undefined;
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

	const outputChannel = {
		appendLine() { },
		show() { },
		dispose() { },
	};

	const createWatcher = () => ({
		onDidCreate: () => createDisposable(),
		onDidChange: () => createDisposable(),
		onDidDelete: () => createDisposable(),
		dispose() { },
	});

	return {
		EventEmitter,
		Disposable,
		RelativePattern,
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
			textDocuments: [],
			getConfiguration: (section?: string) => ({
				get: (key: string, defaultValue: unknown) => {
					const fullKey = section ? `${section}.${key}` : key;
					return vscodeConfigurationValues.has(fullKey)
						? vscodeConfigurationValues.get(fullKey)
						: defaultValue;
				},
				update: async () => undefined,
			}),
			onDidChangeConfiguration: () => createDisposable(),
			onDidChangeTextDocument: () => createDisposable(),
			onDidSaveTextDocument: () => createDisposable(),
			onDidCloseTextDocument: () => createDisposable(),
			createFileSystemWatcher: () => createWatcher(),
			fs: {
				stat: async () => ({ mtime: Date.now() }),
				createDirectory: async () => undefined,
				readFile: async () => new Uint8Array(),
				writeFile: async () => undefined,
			},
		},
		window: {
			onDidChangeActiveTextEditor: () => createDisposable(),
			createOutputChannel: () => outputChannel,
			showErrorMessage: () => undefined,
			showInformationMessage: () => undefined,
		},
		commands: {
			executeCommand: async (id: string, ...args: unknown[]) => {
				vscodeCommandCalls.push({ id, args });
				if (vscodeExecuteCommandHandler) {
					return vscodeExecuteCommandHandler(id, ...args);
				}
				return undefined;
			},
			getCommands: async () => vscodeAvailableCommands || [],
		},
		env: {
			language: 'en',
		},
		ViewColumn: {
			One: 1,
			Beside: 2,
		},
		Range: class Range { },
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

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		return await import('../src/providers/editorPanelManager.js');
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

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function createManager(options?: {
	generateTitle?: (content: string) => Promise<string>;
	generateDescription?: (content: string) => Promise<string>;
	initialPrompt?: Record<string, unknown> | null;
	listPrompts?: Array<Record<string, unknown>>;
	savePrompt?: (prompt: any, options?: any) => Promise<any>;
	stateService?: Record<string, unknown>;
	workspaceService?: Record<string, unknown>;
	configurationValues?: Record<string, unknown>;
}) {
	setVsCodeConfigurationValues(options?.configurationValues);
	const { EditorPanelManager } = await importEditorPanelManager();
	let storedPrompt = options?.initialPrompt ? createPrompt(options.initialPrompt) : null;
	const stateService = {
		saveStartupEditorRestoreState: async () => undefined,
		getGlobalAgentContext: () => '',
		getGlobalAgentContextSource: () => 'empty',
		saveGlobalAgentContext: async () => undefined,
		...options?.stateService,
	};
	const workspaceService = {
		syncGlobalAgentInstructionsFile: async () => undefined,
		ensureProjectInstructionsFolderRegistered: async () => undefined,
		getWorkspaceFolderPaths: () => ['/tmp/workspace'],
		...options?.workspaceService,
	};

	const storageService = {
		getStorageDirectoryPath: () => '/tmp/workspace/.vscode/prompt-manager',
		getPromptDirectoryPath: (id: string) => `/tmp/workspace/.vscode/prompt-manager/prompts/${id}`,
		getPromptMarkdownUri: (id: string) => {
			const fsPath = `/tmp/workspace/.vscode/prompt-manager/prompts/${id}/prompt.md`;
			return {
				fsPath,
				toString: () => fsPath,
			};
		},
		uniqueId: async (base: string) => base,
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
		createAgentFile: async () => undefined,
	};

	const aiService = {
		generateTitle: options?.generateTitle || (async () => 'AI title'),
		generateDescription: options?.generateDescription || (async () => 'AI description'),
	};

	const manager = new EditorPanelManager(
		{ fsPath: '/tmp/extension' } as any,
		storageService as any,
		aiService as any,
		workspaceService as any,
		{} as any,
		stateService as any,
		{} as any,
		undefined,
		undefined,
	);

	return {
		manager,
		storageService,
		aiService,
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

test('persistPromptSnapshotForSwitch finishes without waiting for AI enrichment', async () => {
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
	assert.equal(typeof (result as any).description, 'string');
	assert.notEqual(((result as any).description || '').trim(), '');

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

test('createQuickAddPrompt stores input as content and finishes title/description enrichment in background', async () => {
	const content = [
		'Нужно реализовать быстрый сценарий создания промпта из сырого текста.',
		'Заголовок и описание должны появиться автоматически, как в обычном редакторе.',
	].join(' ');
	const aiStates: Array<{ promptId: string; title: boolean; description: boolean }> = [];
	const { manager, getStoredPrompt } = await createManager({
		generateTitle: async () => 'AI generated title',
		generateDescription: async () => 'AI generated description',
	});

	manager.onDidPromptAiEnrichmentStateChange((state) => {
		aiStates.push(state);
	});

	const saved = await manager.createQuickAddPrompt(content);

	assert.equal(saved?.content, content);
	assert.ok((saved?.title || '').trim().length > 0);
	assert.ok((saved?.description || '').trim().length > 0);
	assert.equal(getStoredPrompt()?.content, content);
	assert.ok(aiStates.some(state => state.title && state.description));

	await new Promise(resolve => setTimeout(resolve, 0));
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.equal(getStoredPrompt()?.title, 'AI generated title');
	assert.equal(getStoredPrompt()?.description, 'AI generated description');
	assert.ok(aiStates.some(state => !state.title && !state.description));
});

test('createQuickAddPrompt reuses the latest saved AI model', async () => {
	const { manager, getStoredPrompt } = await createManager({
		listPrompts: [
			{
				id: 'prompt-old',
				promptUuid: 'uuid-old',
				model: 'copilot/gpt-4o',
				updatedAt: '2026-04-11T00:00:00.000Z',
			},
			{
				id: 'prompt-new',
				promptUuid: 'uuid-new',
				model: 'copilot/claude-sonnet-4',
				updatedAt: '2026-04-13T00:00:00.000Z',
			},
		],
	});

	const saved = await manager.createQuickAddPrompt('Быстро создать новый промпт из буфера обмена.');

	assert.equal(saved?.model, 'copilot/claude-sonnet-4');
	assert.equal(getStoredPrompt()?.model, 'copilot/claude-sonnet-4');
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