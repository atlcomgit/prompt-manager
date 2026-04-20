import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const originalLoad = (Module as any)._load;
const vscodeCommandCalls: Array<{ id: string; args: unknown[] }> = [];
let vscodeExecuteCommandHandler: ((id: string, ...args: unknown[]) => Promise<unknown>) | undefined;

function resetVsCodeCommandMock() {
	vscodeCommandCalls.length = 0;
	vscodeExecuteCommandHandler = undefined;
}

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
			joinPath: (base: { fsPath?: string }, ...parts: string[]) => ({
				fsPath: [base.fsPath || '', ...parts].join('/'),
			}),
			parse: (value: string) => ({
				value,
				toString: () => value,
			}),
		},
		window: {
			showWarningMessage: async () => undefined,
		},
		env: {
			language: 'en',
		},
		commands: {
			executeCommand: async (id: string, ...args: unknown[]) => {
				vscodeCommandCalls.push({ id, args });
				if (vscodeExecuteCommandHandler) {
					return vscodeExecuteCommandHandler(id, ...args);
				}
				return undefined;
			},
		},
	};
}

async function importTrackerPanelManager() {
	(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return createVsCodeMock();
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		return await import('../src/providers/trackerPanelManager.js');
	} finally {
		(Module as any)._load = originalLoad;
	}
}

function makePrompt(id: string, status: 'draft' | 'in-progress' | 'completed' | 'closed') {
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
		createdAt: '2026-04-06T00:00:00.000Z',
		updatedAt: '2026-04-06T00:00:00.000Z',
		content: '',
		report: '',
	};
}

test('TrackerPanelManager updates in-progress status with a next-request auto-complete gate', async () => {
	const { TrackerPanelManager } = await importTrackerPanelManager();
	const stored = new Map([
		['prompt-a', {
			...makePrompt('prompt-a', 'completed'),
			chatSessionIds: ['session-new'],
		}],
	]);
	const savedPrompts: Array<ReturnType<typeof makePrompt> & { chatRequestAutoCompleteAfter?: number }> = [];

	const storageService = {
		listPrompts: async () => Array.from(stored.values())
			.filter(prompt => !prompt.archived)
			.map(({ content, report, ...prompt }) => ({ ...prompt })),
		getPrompt: async (id: string) => stored.get(id) || null,
		savePrompt: async (prompt: ReturnType<typeof makePrompt> & { chatRequestAutoCompleteAfter?: number }) => {
			stored.set(prompt.id, { ...prompt } as any);
			savedPrompts.push({ ...prompt });
			return prompt;
		},
	};

	const manager = new TrackerPanelManager(
		{ fsPath: '/tmp/prompt-manager-extension' } as any,
		storageService as any,
		{} as any,
	);

	await (manager as any).handleMessage({
		type: 'updatePromptStatus',
		id: 'prompt-a',
		status: 'in-progress',
	});

	assert.equal(savedPrompts.length, 1);
	assert.equal(savedPrompts[0]?.status, 'in-progress');
	assert.ok(Number(savedPrompts[0]?.chatRequestAutoCompleteAfter || 0) > 0);
});

test('TrackerPanelManager moves all prompts from source status to the next status', async () => {
	const { TrackerPanelManager } = await importTrackerPanelManager();
	const stored = new Map([
		['draft-a', makePrompt('draft-a', 'draft')],
		['draft-b', makePrompt('draft-b', 'draft')],
		['closed-a', makePrompt('closed-a', 'closed')],
	]);
	const savedStatuses: Array<{ id: string; status: string }> = [];
	const cleanupCalls: string[] = [];

	const storageService = {
		listPrompts: async () => Array.from(stored.values())
			.filter(prompt => !prompt.archived)
			.map(({ content, report, ...prompt }) => ({ ...prompt })),
		getPrompt: async (id: string) => stored.get(id) || null,
		savePrompt: async (prompt: ReturnType<typeof makePrompt>) => {
			stored.set(prompt.id, { ...prompt });
			savedStatuses.push({ id: prompt.id, status: prompt.status });
			return prompt;
		},
	};

	const manager = new TrackerPanelManager(
		{ fsPath: '/tmp/prompt-manager-extension' } as any,
		storageService as any,
		{} as any,
		() => ({
			handlePromptStatusChange: async (prompt: { id: string; status: string }) => {
				cleanupCalls.push(`${prompt.id}:${prompt.status}`);
			},
		}) as any,
	);

	await (manager as any).handleMessage({ type: 'moveAllPromptsToNextStatus', status: 'draft' });

	assert.deepEqual(savedStatuses, [
		{ id: 'draft-a', status: 'in-progress' },
		{ id: 'draft-b', status: 'in-progress' },
	]);
	assert.equal(stored.get('closed-a')?.status, 'closed');
	assert.deepEqual(cleanupCalls, []);
});

test('TrackerPanelManager ignores move-all requests for the final status column', async () => {
	const { TrackerPanelManager } = await importTrackerPanelManager();
	const stored = new Map([
		['closed-a', makePrompt('closed-a', 'closed')],
	]);
	let saveCalls = 0;

	const storageService = {
		listPrompts: async () => Array.from(stored.values())
			.filter(prompt => !prompt.archived)
			.map(({ content, report, ...prompt }) => ({ ...prompt })),
		getPrompt: async (id: string) => stored.get(id) || null,
		savePrompt: async (prompt: ReturnType<typeof makePrompt>) => {
			saveCalls += 1;
			stored.set(prompt.id, { ...prompt });
			return prompt;
		},
	};

	const manager = new TrackerPanelManager(
		{ fsPath: '/tmp/prompt-manager-extension' } as any,
		storageService as any,
		{} as any,
	);

	await (manager as any).handleMessage({ type: 'moveAllPromptsToNextStatus', status: 'closed' });

	assert.equal(saveCalls, 0);
	assert.equal(stored.get('closed-a')?.status, 'closed');
});

test('TrackerPanelManager moves only selected prompts to an explicitly chosen status', async () => {
	const { TrackerPanelManager } = await importTrackerPanelManager();
	const stored = new Map([
		['draft-a', makePrompt('draft-a', 'draft')],
		['draft-b', makePrompt('draft-b', 'draft')],
		['closed-a', makePrompt('closed-a', 'closed')],
	]);
	const savedStatuses: Array<{ id: string; status: string }> = [];

	const storageService = {
		listPrompts: async () => Array.from(stored.values())
			.filter(prompt => !prompt.archived)
			.map(({ content, report, ...prompt }) => ({ ...prompt })),
		getPrompt: async (id: string) => stored.get(id) || null,
		savePrompt: async (prompt: ReturnType<typeof makePrompt>) => {
			stored.set(prompt.id, { ...prompt });
			savedStatuses.push({ id: prompt.id, status: prompt.status });
			return prompt;
		},
	};

	const manager = new TrackerPanelManager(
		{ fsPath: '/tmp/prompt-manager-extension' } as any,
		storageService as any,
		{} as any,
	);

	await (manager as any).handleMessage({
		type: 'moveSelectedPromptsToStatus',
		ids: ['draft-a', 'closed-a'],
		status: 'review',
	});

	assert.deepEqual(savedStatuses, [
		{ id: 'draft-a', status: 'review' },
		{ id: 'closed-a', status: 'review' },
	]);
	assert.equal(stored.get('draft-b')?.status, 'draft');
});

test('TrackerPanelManager archives only closed prompts from the requested ids', async () => {
	const { TrackerPanelManager } = await importTrackerPanelManager();
	const stored = new Map([
		['closed-a', makePrompt('closed-a', 'closed')],
		['completed-a', makePrompt('completed-a', 'completed')],
	]);
	const archivedIds: string[] = [];

	const storageService = {
		listPrompts: async () => Array.from(stored.values())
			.filter(prompt => !prompt.archived)
			.map(({ content, report, ...prompt }) => ({ ...prompt })),
		getPrompt: async (id: string) => stored.get(id) || null,
		archivePrompt: async (id: string) => {
			const prompt = stored.get(id);
			if (!prompt) {
				return null;
			}

			const archivedPrompt = { ...prompt, archived: true };
			stored.set(id, archivedPrompt);
			archivedIds.push(id);
			return archivedPrompt;
		},
	};

	const manager = new TrackerPanelManager(
		{ fsPath: '/tmp/prompt-manager-extension' } as any,
		storageService as any,
		{} as any,
	);

	await (manager as any).handleMessage({
		type: 'archivePrompts',
		ids: ['closed-a', 'completed-a'],
	});

	assert.deepEqual(archivedIds, ['closed-a']);
	assert.equal(stored.get('closed-a')?.archived, true);
	assert.equal(stored.get('completed-a')?.archived, false);
});

test('TrackerPanelManager openChat uses the validated stored session instead of a stale UI session id', async () => {
	const { TrackerPanelManager } = await importTrackerPanelManager();
	const stored = new Map([
		['prompt-a', {
			...makePrompt('prompt-a', 'draft'),
			chatSessionIds: ['session-fresh'],
		}],
	]);
	let openedSessionId = '';

	const storageService = {
		getPrompt: async (id: string) => {
			const prompt = stored.get(id);
			return prompt ? { ...prompt } : null;
		},
		savePrompt: async (prompt: ReturnType<typeof makePrompt>) => {
			stored.set(prompt.id, { ...prompt });
			return prompt;
		},
	};
	const stateService = {
		saveLastPromptId: async () => undefined,
		hasChatSession: async (sessionId: string) => sessionId === 'session-fresh',
	};

	const manager = new TrackerPanelManager(
		{ fsPath: '/tmp/prompt-manager-extension' } as any,
		storageService as any,
		stateService as any,
	);
	(manager as any).refresh = async () => undefined;
	(manager as any).openBoundChatSession = async (sessionId: string) => {
		openedSessionId = sessionId;
		return true;
	};

	await (manager as any).handleMessage({
		type: 'openChat',
		id: 'prompt-a',
		sessionId: 'session-stale',
	});

	assert.equal(openedSessionId, 'session-fresh');
	assert.deepEqual(stored.get('prompt-a')?.chatSessionIds, ['session-fresh']);
	assert.equal(stored.get('prompt-a')?.status, 'in-progress');
});

test('TrackerPanelManager openBoundChatSession uses only the direct session-resource open path', async () => {
	resetVsCodeCommandMock();
	vscodeExecuteCommandHandler = async (id: string) => {
		if (id === 'vscode.open') {
			return undefined;
		}

		throw new Error(`Unexpected command: ${id}`);
	};

	const { TrackerPanelManager } = await importTrackerPanelManager();
	const manager = new TrackerPanelManager(
		{ fsPath: '/tmp/prompt-manager-extension' } as any,
		{} as any,
		{} as any,
	);

	const opened = await (manager as any).openBoundChatSession('session-fresh');

	assert.equal(opened, true);
	assert.deepEqual(vscodeCommandCalls.map(call => call.id), ['vscode.open']);
	assert.match(
		String((vscodeCommandCalls[0]?.args[0] as { toString?: () => string })?.toString?.() || ''),
		/^vscode-chat-session:\/\/local\//,
	);
	resetVsCodeCommandMock();
});