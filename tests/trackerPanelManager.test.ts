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
			joinPath: (base: { fsPath?: string }, ...parts: string[]) => ({
				fsPath: [base.fsPath || '', ...parts].join('/'),
			}),
			parse: (value: string) => ({ value }),
		},
		env: {
			language: 'en',
		},
		commands: {
			executeCommand: async () => undefined,
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

function makePrompt(id: string, status: 'draft' | 'completed' | 'closed') {
	return {
		id,
		promptUuid: `${id}-uuid`,
		title: id,
		description: '',
		status,
		favorite: false,
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
		listPrompts: async () => Array.from(stored.values()).map(({ content, report, ...prompt }) => ({ ...prompt })),
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
		listPrompts: async () => Array.from(stored.values()).map(({ content, report, ...prompt }) => ({ ...prompt })),
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