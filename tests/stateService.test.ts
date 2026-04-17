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