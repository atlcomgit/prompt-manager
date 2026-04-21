import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const originalLoad = (Module as any)._load;

function createDisposable() {
	return { dispose() { } };
}

function createVsCodeMock() {
	return {
		FileType: {
			Directory: 2,
		},
		Uri: {
			file: (value: string) => ({
				fsPath: value,
				toString: () => value,
			}),
		},
		workspace: {
			fs: {
				stat: async () => ({ mtime: Date.now() }),
				readDirectory: async () => [],
			},
			onDidChangeConfiguration: () => createDisposable(),
		},
	};
}

async function importStateService() {
	(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return createVsCodeMock();
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		return await import('../src/services/stateService.js');
	} finally {
		(Module as any)._load = originalLoad;
	}
}

function createWorkspaceStateMock(initial: Record<string, unknown> = {}) {
	const store = new Map<string, unknown>(Object.entries(initial));
	return {
		get<T>(key: string, defaultValue?: T): T | undefined {
			return store.has(key) ? store.get(key) as T : defaultValue;
		},
		async update(key: string, value: unknown): Promise<void> {
			if (typeof value === 'undefined') {
				store.delete(key);
				return;
			}

			store.set(key, value);
		},
		store,
	};
}

test('StateService treats legacy non-empty global context as manual source', async () => {
	const { StateService } = await importStateService();
	const workspaceState = createWorkspaceStateMock({
		'promptManager.globalAgentContext': 'Legacy instructions',
	});
	const service = new StateService({ workspaceState } as any);

	assert.equal(service.getGlobalAgentContext(), 'Legacy instructions');
	assert.equal(service.getGlobalAgentContextSource(), 'manual');
});

test('StateService saveGlobalAgentContext persists inferred and explicit sources', async () => {
	const { StateService } = await importStateService();
	const workspaceState = createWorkspaceStateMock();
	const service = new StateService({ workspaceState } as any);

	await service.saveGlobalAgentContext('Remote instructions', 'remote');
	assert.equal(service.getGlobalAgentContext(), 'Remote instructions');
	assert.equal(service.getGlobalAgentContextSource(), 'remote');
	assert.equal(workspaceState.store.get('promptManager.globalAgentContextSource'), 'remote');

	await service.saveGlobalAgentContext('Manual override');
	assert.equal(service.getGlobalAgentContext(), 'Manual override');
	assert.equal(service.getGlobalAgentContextSource(), 'manual');
	assert.equal(workspaceState.store.get('promptManager.globalAgentContextSource'), 'manual');

	await service.saveGlobalAgentContext('');
	assert.equal(service.getGlobalAgentContext(), '');
	assert.equal(service.getGlobalAgentContextSource(), 'empty');
	assert.equal(workspaceState.store.get('promptManager.globalAgentContextSource'), 'empty');
});

test('StateService chat session relevance ignores sessions completed before the tracked start', async () => {
	const { StateService } = await importStateService();

	assert.equal((StateService as any).isChatSessionRelevantToReference({
		timing: {
			lastRequestStarted: 1000,
			lastRequestEnded: 1500,
		},
	}, 2000), false);

	assert.equal((StateService as any).isChatSessionRelevantToReference({
		timing: {
			lastRequestStarted: 1000,
			lastRequestEnded: 2200,
		},
	}, 2000), true);

	assert.equal((StateService as any).isChatSessionRelevantToReference({
		timing: {
			lastRequestStarted: 2100,
			lastRequestEnded: 0,
		},
	}, 2000), true);
});

test('StateService recent chat candidate selection requires the hinted session id', async () => {
	const { StateService } = await importStateService();
	const sessions = [
		{ sessionId: 'session-new', timing: { lastRequestStarted: 3000, lastRequestEnded: 0 } },
		{ sessionId: 'session-old', timing: { lastRequestStarted: 2500, lastRequestEnded: 2600 } },
	];

	assert.equal((StateService as any).selectRecentChatSessionCandidate(sessions, 'missing-session'), null);
	assert.equal((StateService as any).selectRecentChatSessionCandidate(sessions, 'session-old')?.sessionId, 'session-old');
	assert.equal((StateService as any).selectRecentChatSessionCandidate(sessions)?.sessionId, 'session-new');
});

test('StateService active chat candidate skips excluded session ids', async () => {
	const { StateService } = await importStateService();

	assert.equal(
		(StateService as any).selectActiveChatSessionIdCandidate({
			sessionId: 'session-old',
			history: {
				copilot: [
					{ sessionId: 'session-old' },
					{ sessionId: 'session-new' },
				],
			},
		}, new Set(['session-old'])),
		'session-new',
	);

	assert.equal(
		(StateService as any).selectActiveChatSessionIdCandidate({
			sessionId: 'session-old',
			history: {
				copilot: [
					{ sessionId: 'session-old' },
				],
			},
		}, new Set(['session-old'])),
		'',
	);
});

test('getRecentChatSessionsFromIndex keeps only sessions relevant to the current chat start', async () => {
	const { StateService } = await importStateService();
	const service = new StateService({} as any);

	const recent = (service as any).getRecentChatSessionsFromIndex({
		entries: {
			old: {
				sessionId: 'session-old',
				timing: {
					lastRequestStarted: 1000,
					lastRequestEnded: 1500,
				},
			},
			carried: {
				sessionId: 'session-carried',
				timing: {
					lastRequestStarted: 1000,
					lastRequestEnded: 2300,
				},
			},
			newest: {
				sessionId: 'session-newest',
				timing: {
					lastRequestStarted: 2600,
					lastRequestEnded: 0,
				},
			},
		},
	}, 2000);

	assert.deepEqual(recent.map((entry: any) => entry.sessionId), ['session-newest', 'session-carried']);
});

test('StateService scopes chat session storage to the current workspace bucket', async () => {
	const { StateService } = await importStateService();
	const service = new StateService({
		storageUri: {
			fsPath: '/tmp/workspaceStorage/current/storage',
		},
	} as any);

	assert.deepEqual(
		(service as any).scopeWorkspaceStateDbPathsToCurrentWorkspace([
			'/tmp/workspaceStorage/current/state.vscdb',
			'/tmp/workspaceStorage/other/state.vscdb',
		]),
		['/tmp/workspaceStorage/current/state.vscdb'],
	);

	assert.deepEqual(
		(service as any).scopeWorkspaceStateDbPathsToCurrentWorkspace([
			'/tmp/workspaceStorage/other/state.vscdb',
		]),
		[],
	);
});

test('StateService extracts the latest request state from JSONL snapshots and patches', async () => {
	const { StateService } = await importStateService();
	const raw = [
		JSON.stringify({
			kind: 0,
			v: {
				requests: [
					{ modelState: { value: 0 }, result: null },
					{ modelState: { value: 0 }, result: null },
				],
			},
		}),
		JSON.stringify({ kind: 2, k: ['requests', 1, 'response'], v: [{ kind: 'progressTaskSerialized' }] }),
		JSON.stringify({ kind: 1, k: ['requests', 1, 'result'], v: { timings: { totalElapsed: 1234 } } }),
		JSON.stringify({ kind: 1, k: ['requests', 1, 'modelState'], v: { value: 3 } }),
	].join('\n');

	assert.deepEqual((StateService as any).extractLatestChatRequestStateFromJsonl(raw), {
		requestIndex: 1,
		requestModelState: 3,
		hasRequestResult: true,
	});
});

test('StateService keeps progress-only requests non-terminal when JSONL has no result marker', async () => {
	const { StateService } = await importStateService();
	const raw = [
		JSON.stringify({
			kind: 0,
			v: {
				requests: [
					{ modelState: { value: 0 }, result: null },
				],
			},
		}),
		JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'progressTaskSerialized' }] }),
		JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'markdownContent' }] }),
	].join('\n');

	assert.deepEqual((StateService as any).extractLatestChatRequestStateFromJsonl(raw), {
		requestIndex: 0,
		requestModelState: 0,
		hasRequestResult: false,
	});
});

test('StateService completion snapshot selects the newest tracked session with a terminal result marker', async () => {
	const { StateService } = await importStateService();
	const service = new StateService({
		storageUri: {
			fsPath: '/tmp/workspaceStorage/current/storage',
		},
	} as any);

	(service as any).resolveWorkspaceStateDbPaths = async () => ['/tmp/workspaceStorage/current/state.vscdb'];
	(service as any).scopeWorkspaceStateDbPathsToCurrentWorkspace = (paths: string[]) => paths;
	(service as any).readChatSessionStoreIndex = async () => ({
		entries: {
			old: {
				sessionId: 'session-old',
				timing: {
					lastRequestStarted: 100,
					lastRequestEnded: 200,
				},
				lastResponseState: 1,
				hasPendingEdits: false,
			},
			newest: {
				sessionId: 'session-new',
				timing: {
					lastRequestStarted: 300,
					lastRequestEnded: 900,
				},
				lastResponseState: 2,
				hasPendingEdits: false,
			},
		},
	});
	(service as any).readLatestChatRequestState = async (sessionId: string) => {
		if (sessionId === 'session-new') {
			return {
				requestIndex: 2,
				requestModelState: 1,
				hasRequestResult: true,
			};
		}

		return {
			requestIndex: 0,
			requestModelState: 0,
			hasRequestResult: false,
		};
	};

	assert.deepEqual(await service.getLatestTrackedChatRequestCompletion(['session-old', 'session-new']), {
		ok: true,
		sessionId: 'session-new',
		lastRequestStarted: 300,
		lastRequestEnded: 900,
		lastResponseState: 2,
		requestModelState: 1,
		hasRequestResult: true,
		hasPendingEdits: false,
		dbPath: '/tmp/workspaceStorage/current/state.vscdb',
	});
});