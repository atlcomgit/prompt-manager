import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const originalLoad = (Module as any)._load;

function createDisposable() {
	return { dispose() { } };
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
			getConfiguration: () => ({
				get: (_key: string, defaultValue: unknown) => defaultValue,
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

async function createManager(options?: {
	generateTitle?: (content: string) => Promise<string>;
	generateDescription?: (content: string) => Promise<string>;
	initialPrompt?: Record<string, unknown> | null;
}) {
	const { EditorPanelManager } = await importEditorPanelManager();
	let storedPrompt = options?.initialPrompt ? createPrompt(options.initialPrompt) : null;

	const storageService = {
		getStorageDirectoryPath: () => '/tmp/workspace/.vscode/prompt-manager',
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
		savePrompt: async (prompt: any) => {
			storedPrompt = clonePrompt({
				...prompt,
				promptUuid: prompt.promptUuid || 'uuid-a',
				updatedAt: '2026-04-13T00:00:01.000Z',
			});
			return clonePrompt(storedPrompt);
		},
	};

	const aiService = {
		generateTitle: options?.generateTitle || (async () => 'AI title'),
		generateDescription: options?.generateDescription || (async () => 'AI description'),
	};

	const manager = new EditorPanelManager(
		{ fsPath: '/tmp/extension' } as any,
		storageService as any,
		aiService as any,
		{} as any,
		{} as any,
		{ saveStartupEditorRestoreState: async () => undefined } as any,
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

test('project instructions are wrapped with applyTo frontmatter and stripped for webview state', async () => {
	const { EditorPanelManager } = await importEditorPanelManager();
	const body = '# Project rules\n\nUse repository conventions.';

	const wrapped = (EditorPanelManager as any).wrapInstructionWithFrontmatter(body);
	assert.equal(
		wrapped,
		"---\napplyTo: '**'\n---\n\n# Project rules\n\nUse repository conventions.\n",
	);
	assert.equal((EditorPanelManager as any).stripInstructionFrontmatter(wrapped), body);
	assert.equal(
		(EditorPanelManager as any).wrapInstructionWithFrontmatter(''),
		"---\napplyTo: '**'\n---\n\n",
	);
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