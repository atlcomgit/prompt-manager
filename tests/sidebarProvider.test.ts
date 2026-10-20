import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const originalLoad = (Module as any)._load;

function createVsCodeMock() {
	class EventEmitter<T> {
		private readonly listeners: Array<(value: T) => void> = [];

		public readonly event = (listener: (value: T) => void) => {
			this.listeners.push(listener);
			return { dispose() { } };
		};

		fire(value: T): void {
			for (const listener of this.listeners) {
				listener(value);
			}
		}
	}

	return {
		EventEmitter,
		Uri: {
			file: (value: string) => ({ fsPath: value }),
			joinPath: (base: { fsPath?: string }, ...parts: string[]) => ({
				fsPath: [base.fsPath || '', ...parts].join('/'),
			}),
		},
		env: {
			language: 'en',
		},
		RelativePattern: class {
			constructor(public base: string, public pattern: string) { }
		},
		workspace: {
			createFileSystemWatcher: () => ({
				onDidCreate: () => ({ dispose() { } }),
				onDidChange: () => ({ dispose() { } }),
				onDidDelete: () => ({ dispose() { } }),
				dispose() { },
			}),
		},
	};
}

async function importSidebarProvider() {
	(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return createVsCodeMock();
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		return await import('../src/providers/sidebarProvider.js');
	} finally {
		(Module as any)._load = originalLoad;
	}
}

function makePrompt(id: string, status: 'in-progress' | 'review' | 'completed') {
	return {
		id,
		promptUuid: `${id}-uuid`,
		title: id,
		description: '',
		status,
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
		createdAt: '2026-04-10T00:00:00.000Z',
		updatedAt: '2026-04-10T00:00:00.000Z',
		content: '',
		report: '',
	};
}

test('SidebarProvider updates prompt status with status-change history and cleanup side effects', async () => {
	const { SidebarProvider } = await importSidebarProvider();
	const stored = new Map([
		['prompt-a', makePrompt('prompt-a', 'in-progress')],
	]);
	const saveCalls: Array<{ status: string; historyReason: string | undefined }> = [];
	const cleanupCalls: string[] = [];
	let emittedChanges: Array<{ config: { status: string } }> = [];

	const storageService = {
		getPrompt: async (id: string) => stored.get(id) || null,
		savePrompt: async (prompt: ReturnType<typeof makePrompt>, options?: { historyReason?: string }) => {
			const saved = {
				...prompt,
				updatedAt: '2026-04-10T01:00:00.000Z',
			};
			stored.set(prompt.id, saved);
			saveCalls.push({ status: saved.status, historyReason: options?.historyReason });
			return saved;
		},
		listPrompts: async () => Array.from(stored.values()).map(({ content, report, ...prompt }) => ({ ...prompt })),
		listArchivedPrompts: async () => [],
		getStorageDirectoryPath: () => '/tmp/prompt-manager-storage',
		readAgentProgress: async () => undefined,
	};

	const provider = new SidebarProvider(
		{ fsPath: '/tmp/prompt-manager-extension' } as any,
		storageService as any,
		{} as any,
		{} as any,
		{} as any,
		{} as any,
		() => ({
			handlePromptStatusChange: async (prompt: { id: string; status: string }) => {
				cleanupCalls.push(`${prompt.id}:${prompt.status}`);
			},
		}) as any,
	);

	provider.onDidSave((changes) => {
		emittedChanges = changes as Array<{ config: { status: string } }>;
	});

	await (provider as any).handleMessage({ type: 'updatePromptStatus', id: 'prompt-a', status: 'review' });

	assert.deepEqual(saveCalls, [
		{ status: 'review', historyReason: 'status-change' },
	]);
	assert.deepEqual(cleanupCalls, ['prompt-a:review']);
	assert.equal(emittedChanges.length, 1);
	assert.equal(emittedChanges[0]?.config.status, 'review');
});

test('SidebarProvider marks in-progress status changes to wait for the next chat request', async () => {
	const { SidebarProvider } = await importSidebarProvider();
	const stored = new Map([
		['prompt-a', {
			...makePrompt('prompt-a', 'completed'),
			chatSessionIds: ['session-new'],
		}],
	]);
	const savedPrompts: Array<ReturnType<typeof makePrompt> & { chatRequestAutoCompleteAfter?: number }> = [];

	const storageService = {
		getPrompt: async (id: string) => stored.get(id) || null,
		savePrompt: async (prompt: ReturnType<typeof makePrompt> & { chatRequestAutoCompleteAfter?: number }, options?: { historyReason?: string }) => {
			const saved = {
				...prompt,
				updatedAt: '2026-04-10T01:00:00.000Z',
			};
			stored.set(prompt.id, saved as any);
			savedPrompts.push(saved);
			return saved;
		},
		listPrompts: async () => Array.from(stored.values()).map(({ content, report, ...prompt }) => ({ ...prompt })),
		listArchivedPrompts: async () => [],
		getStorageDirectoryPath: () => '/tmp/prompt-manager-storage',
		readAgentProgress: async () => undefined,
	};

	const provider = new SidebarProvider(
		{ fsPath: '/tmp/prompt-manager-extension' } as any,
		storageService as any,
		{} as any,
		{} as any,
		{} as any,
		{} as any,
		undefined,
	);

	await (provider as any).handleMessage({ type: 'updatePromptStatus', id: 'prompt-a', status: 'in-progress' });

	assert.equal(savedPrompts.length, 1);
	assert.equal(savedPrompts[0]?.status, 'in-progress');
	assert.ok(Number(savedPrompts[0]?.chatRequestAutoCompleteAfter || 0) > 0);
});

/** Выделение сохраняется до ожидания Memento; смена фильтра не меняет активную задачу. */
test('SidebarProvider saves active task only when selection changes', async () => {
	const { SidebarProvider } = await importSidebarProvider();
	let state = { selectedPromptId: 'first' as string | null, selectedPromptUuid: 'uuid-first' as string | null };
	const calls: Array<{ id: string | null; uuid?: string | null }> = [];
	const provider = new SidebarProvider(
		{ fsPath: '/unused-extension' } as any,
		{
			getStorageDirectoryPath: () => '/unused-storage',
			saveActiveTask: async (id: string | null, uuid?: string | null) => { calls.push({ id, uuid }); },
		} as any,
		{} as any, {} as any, {} as any,
		{
			getSidebarState: () => state,
			saveSidebarState: async (next: typeof state) => { state = next; },
		} as any,
	);
	await (provider as any).handleMessage({ type: 'saveSidebarState', state: { ...state, sortOrder: 'asc' } });
	assert.deepEqual(calls, []);
	const save = (provider as any).handleMessage({
		type: 'saveSidebarState', state: { selectedPromptId: 'last', selectedPromptUuid: 'uuid-last' },
	});
	assert.deepEqual(calls, [{ id: 'last', uuid: 'uuid-last' }]);
	await save;
	await (provider as any).handleMessage({
		type: 'saveSidebarState', state: { selectedPromptId: null, selectedPromptUuid: null },
	});
	assert.deepEqual(calls[1], { id: null, uuid: null });
});

/** Начальное выделение экспортируется при готовности списка даже без открытия редактора. */
test('SidebarProvider restores active task before loading the prompt list', async () => {
	const { SidebarProvider } = await importSidebarProvider();
	const calls: unknown[][] = [];
	const state = { selectedPromptId: 'restored', selectedPromptUuid: 'uuid-restored' };
	const provider = new SidebarProvider(
		{ fsPath: '/unused-extension' } as any,
		{
			getStorageDirectoryPath: () => '/unused-storage',
			listPrompts: async () => [],
			listArchivedPrompts: async () => [],
			saveActiveTask: async (...args: unknown[]) => { calls.push(args); },
		} as any,
		{} as any, {} as any, {} as any,
		{ getSidebarState: () => state, saveSidebarState: async () => undefined } as any,
	);
	const ready = (provider as any).handleMessage({ type: 'ready' });
	assert.deepEqual(calls, [['restored', 'uuid-restored', { onlyIfUnset: true }]]);
	await ready;
	await (provider as any).handleMessage({ type: 'saveSidebarState', state: { ...state, sortOrder: 'asc' } });
	assert.equal(calls.length, 1);
});
