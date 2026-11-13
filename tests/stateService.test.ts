import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { normalizePromptDashboardLayouts, PROMPT_DASHBOARD_SECTION_KEYS } from '../src/types/promptDashboard.js';
import { normalizePromptDashboardPreferences } from '../src/types/promptDashboardPreferences.js';
import { createDefaultEditorPromptViewState } from '../src/types/prompt.js';

const originalLoad = (Module as any)._load;

function createDisposable() {
	return { dispose() { } };
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

function createWorkspaceStateMock(
	initial: Record<string, unknown> = {},
	overrides?: {
		update?: (store: Map<string, unknown>, key: string, value: unknown) => Promise<void>;
	},
) {
	const store = new Map<string, unknown>(Object.entries(initial));
	return {
		get<T>(key: string, defaultValue?: T): T | undefined {
			return store.has(key) ? store.get(key) as T : defaultValue;
		},
		async update(key: string, value: unknown): Promise<void> {
			if (overrides?.update) {
				await overrides.update(store, key, value);
				return;
			}

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

test('StateService serializes prompt editor view-state save and migrate mutations', async () => {
	const { StateService } = await importStateService();
	const firstUpdateGate = createDeferred<void>();
	let updateCount = 0;
	const panelFallbackState = {
		...createDefaultEditorPromptViewState(),
		expandedSections: {
			...createDefaultEditorPromptViewState().expandedSections,
			report: true,
		},
	};
	const workspaceState = createWorkspaceStateMock({
		'promptManager.editorPromptViewState': {
			'panel:__prompt_editor_singleton__': panelFallbackState,
		},
	}, {
		update: async (store, key, value) => {
			updateCount += 1;
			if (updateCount === 1) {
				await firstUpdateGate.promise;
			}

			if (typeof value === 'undefined') {
				store.delete(key);
				return;
			}

			store.set(key, value);
		},
	});
	const service = new StateService({ workspaceState } as any);
	const promptAState = {
		...createDefaultEditorPromptViewState(),
		expandedSections: {
			...createDefaultEditorPromptViewState().expandedSections,
			files: true,
			workspace: false,
		},
	};

	const savePromise = service.savePromptEditorViewState({
		promptUuid: 'uuid-a',
		promptId: 'prompt-a',
	}, promptAState);
	const migratePromise = service.migratePromptEditorViewState([
		{ fallbackKey: 'panel:__prompt_editor_singleton__' },
	], {
		promptUuid: 'uuid-b',
		promptId: 'prompt-b',
		fallbackKey: 'panel:__prompt_editor_singleton__',
	});

	firstUpdateGate.resolve();
	await Promise.all([savePromise, migratePromise]);

	assert.equal(service.getPromptEditorViewState({
		promptUuid: 'uuid-a',
		promptId: 'prompt-a',
	}).expandedSections.files, true);
	assert.equal(service.getPromptEditorViewState({
		promptUuid: 'uuid-a',
		promptId: 'prompt-a',
	}).expandedSections.workspace, false);
	assert.equal(service.getPromptEditorViewState({
		promptUuid: 'uuid-b',
		promptId: 'prompt-b',
	}).expandedSections.report, true);
	assert.equal(service.getPromptEditorViewState({
		promptUuid: 'uuid-b',
		promptId: 'prompt-b',
	}).expandedSections.files, false);
});

test('StateService saves shared dashboard collapsed sections through a serialized workspace mutation queue', async () => {
	const { StateService } = await importStateService();
	const firstUpdateGate = createDeferred<void>();
	let updateCount = 0;
	const workspaceState = createWorkspaceStateMock({}, {
		update: async (store, key, value) => {
			updateCount += 1;
			if (updateCount === 1) {
				await firstUpdateGate.promise;
			}

			if (typeof value === 'undefined') {
				store.delete(key);
				return;
			}

			store.set(key, value);
		},
	});
	const service = new StateService({ workspaceState } as any);

	const firstSave = service.savePromptDashboardCollapsedSections({
		activity: true,
		status: false,
	});
	const secondSave = service.savePromptDashboardCollapsedSections({
		activity: false,
		status: true,
		parallelBranches: true,
	});

	firstUpdateGate.resolve();
	await Promise.all([firstSave, secondSave]);

	assert.equal(updateCount, 2);
	assert.deepEqual(service.getPromptDashboardCollapsedSections(), {
		status: true,
		parallelBranches: true,
	});
	assert.deepEqual(service.getPromptDashboardLayouts()['two-columns'].collapsedSections, {
		status: true,
		parallelBranches: true,
	});
});

test('StateService saves shared dashboard section order through a serialized workspace mutation queue', async () => {
	const { StateService } = await importStateService();
	const firstUpdateGate = createDeferred<void>();
	let updateCount = 0;
	const workspaceState = createWorkspaceStateMock({}, {
		update: async (store, key, value) => {
			updateCount += 1;
			if (updateCount === 1) {
				await firstUpdateGate.promise;
			}

			if (typeof value === 'undefined') {
				store.delete(key);
				return;
			}

			store.set(key, value);
		},
	});
	const service = new StateService({ workspaceState } as any);

	const firstSave = service.savePromptDashboardSectionOrder([
		['aiAnalysis', 'activity'],
		['status'],
	]);
	const secondSave = service.savePromptDashboardSectionOrder([
		['projectBranches', 'activity', 'parallelBranches'],
		['status', 'reviewRequests', 'projectCommits', 'aiAnalysis'],
	]);

	firstUpdateGate.resolve();
	await Promise.all([firstSave, secondSave]);

	assert.equal(updateCount, 2);
	assert.deepEqual(service.getPromptDashboardSectionOrder(), [
		['projectBranches', 'activity', 'parallelBranches', 'dockerContainers'],
		['status', 'reviewRequests', 'projectCommits', 'aiAnalysis', 'todos'],
	]);
	assert.deepEqual(service.getPromptDashboardLayouts()['two-columns'].sectionOrder, [
		['projectBranches', 'activity', 'parallelBranches', 'dockerContainers'],
		['status', 'reviewRequests', 'projectCommits', 'aiAnalysis', 'todos'],
	]);
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

/** Ожидание bootstrap включает новые записи очереди и не зависает после отказа предыдущей. */
test('StateService waits for dashboard saves added during a pending failed write', async () => {
	const { StateService } = await importStateService();
	const firstEntered = createDeferred<void>();
	const firstRelease = createDeferred<void>();
	const secondEntered = createDeferred<void>();
	const secondRelease = createDeferred<void>();
	let writes = 0;
	let completed = false;
	const workspaceState = createWorkspaceStateMock({}, { update: async (store, key, value) => {
		if (++writes === 1) {
			firstEntered.resolve();
			await firstRelease.promise;
			throw new Error('testing write failure');
		}
		secondEntered.resolve();
		await secondRelease.promise;
		store.set(key, value);
	} });
	const service = new StateService({ workspaceState } as unknown as ConstructorParameters<typeof StateService>[0]);
	const failure = assert.rejects(service.savePromptDashboardCollapsedSections({ todos: true }, 'two-columns'));
	await firstEntered.promise;
	const waiting = service.waitForPromptDashboardSaves().then(() => { completed = true; });
	const preferences = normalizePromptDashboardPreferences({ docker: { search: 'latest' } });
	const saving = service.savePromptDashboardPreferences(preferences);
	try {
		firstRelease.resolve();
		await secondEntered.promise;
		assert.equal(completed, false);
		secondRelease.resolve();
		await Promise.all([failure, saving, waiting]);
		assert.deepEqual(service.getPromptDashboardCollapsedSections('two-columns'), {});
		assert.deepEqual(service.getPromptDashboardPreferences(), preferences);
	} finally {
		firstRelease.resolve();
		secondRelease.resolve();
		await Promise.all([failure, saving, waiting]);
	}
});

/** Новый экземпляр восстанавливает профили из отдельного JSON-снимка, а не общей ссылки Memento. */
test('StateService keeps dashboard layouts isolated across queued saves and serialized restore', async () => {
	const { StateService } = await importStateService();
	const legacyOrder = [['todos', 'status'], ['activity']];
	const workspaceState = createWorkspaceStateMock({
		'promptManager.dashboardSectionOrder': legacyOrder,
		'promptManager.dashboardCollapsedSections': { activity: true },
	});
	const service = new StateService({ workspaceState } as any);
	const initial = normalizePromptDashboardLayouts(undefined, legacyOrder, { activity: true });
	assert.deepEqual(service.getPromptDashboardLayouts(), initial);

	// Несколько быстрых действий в разных режимах не должны перезаписывать соседние настройки.
	await Promise.all([
		service.savePromptDashboardSectionOrder([['aiAnalysis', 'todos', 'status']], 'single-column'),
		service.savePromptDashboardCollapsedSections({}, 'single-column'),
		service.savePromptDashboardSectionOrder([[], ['activity',
			...PROMPT_DASHBOARD_SECTION_KEYS.filter(key => key !== 'activity')]], 'two-columns'),
		service.savePromptDashboardCollapsedSections({ dockerContainers: true }, 'two-columns'),
	]);
	const restoredWorkspaceState = createWorkspaceStateMock(JSON.parse(JSON.stringify(
		Object.fromEntries(workspaceState.store),
	)));
	const reopened = new StateService({ workspaceState: restoredWorkspaceState } as any);
	assert.deepEqual(reopened.getPromptDashboardLayouts(), service.getPromptDashboardLayouts());
	assert.deepEqual(reopened.getPromptDashboardCollapsedSections('single-column'), {});
	assert.deepEqual(reopened.getPromptDashboardCollapsedSections('two-columns'), { dockerContainers: true });
	assert.deepEqual(reopened.getPromptDashboardSectionOrder('single-column')[0].slice(0, 3),
		['aiAnalysis', 'todos', 'status']);
	assert.equal(reopened.getPromptDashboardSectionOrder('single-column').length, 1);
	assert.equal(reopened.getPromptDashboardSectionOrder('two-columns').length, 2);
	assert.deepEqual(reopened.getPromptDashboardSectionOrder('two-columns')[0], []);
	assert.equal(reopened.getPromptDashboardSectionOrder('two-columns')[1][0], 'activity');
	assert.deepEqual(workspaceState.store.get('promptManager.dashboardSectionOrder'), legacyOrder);
});

/** Memento может обновить память до отказа записи: следующий патч не должен сохранить неудачный снимок. */
test('StateService does not expose or inherit an eagerly updated failed dashboard layout', async () => {
	const { StateService } = await importStateService();
	const entered = createDeferred<void>();
	const release = createDeferred<void>();
	let writes = 0;
	const workspaceState = createWorkspaceStateMock({}, {
		update: async (store, key, value) => {
			store.set(key, value);
			if (++writes === 1) {
				entered.resolve();
				await release.promise;
				throw new Error('simulated persistence failure');
			}
		},
	});
	const service = new StateService({ workspaceState } as any);
	const expected = service.getPromptDashboardLayouts();
	const saving = service.savePromptDashboardCollapsedSections({ status: true }, 'single-column');
	const rejected = assert.rejects(saving, /simulated persistence failure/);
	await entered.promise;
	try {
		assert.deepEqual(service.getPromptDashboardLayouts(), expected);
	} finally {
		release.resolve();
		await rejected;
	}
	assert.deepEqual(service.getPromptDashboardLayouts(), expected);
	await service.savePromptDashboardCollapsedSections({ todos: true }, 'two-columns');
	assert.deepEqual(service.getPromptDashboardCollapsedSections('single-column'), {});
	assert.deepEqual(service.getPromptDashboardCollapsedSections('two-columns'), { todos: true });
	await service.savePromptDashboardCollapsedSections({ activity: true }, 'single-column');
	assert.deepEqual(service.getPromptDashboardCollapsedSections('single-column'), { activity: true });
});

/** Ошибка одной записи не блокирует следующие сохранения обоих режимов. */
test('StateService recovers dashboard layout saves after a failed write', async () => {
	const { StateService } = await importStateService();
	let first = true;
	const workspaceState = createWorkspaceStateMock({}, {
		update: async (store, key, value) => {
			if (first) {
				first = false;
				throw new Error('write failed');
			}
			store.set(key, value);
		},
	});
	const service = new StateService({ workspaceState } as any);
	await assert.rejects(service.savePromptDashboardCollapsedSections({ status: true }, 'single-column'));
	await service.savePromptDashboardCollapsedSections({ activity: true }, 'two-columns');
	assert.deepEqual(service.getPromptDashboardCollapsedSections('two-columns'), { activity: true });
});

/** Отсутствие записи отличается от сохранённых defaults и не мешает миграции localStorage. */
test('StateService dashboard preferences stay absent until explicitly saved', async () => {
	const { StateService } = await importStateService();
	const workspaceState = createWorkspaceStateMock();
	const service = new StateService({ workspaceState } as any);
	assert.equal(service.getPromptDashboardPreferences(), undefined);
	assert.equal(workspaceState.store.size, 0);
	await service.savePromptDashboardPreferences(normalizePromptDashboardPreferences(undefined));
	assert.deepEqual(service.getPromptDashboardPreferences(), normalizePromptDashboardPreferences(undefined));
	assert.equal(workspaceState.store.has('promptManager.dashboardPreferences'), true);
});

/** Отдельный сериализованный Memento восстанавливает поиск, фильтры, false и пустые значения. */
test('StateService dashboard preferences survive serialized restore without sharing mutable values', async () => {
	const { StateService } = await importStateService();
	const workspaceState = createWorkspaceStateMock();
	const service = new StateService({ workspaceState } as any);
	const state = normalizePromptDashboardPreferences({
		docker: { viewMode: 'table', statusFilter: 'stopped', search: 'api', sortBy: 'cpu',
			expandedContainerIds: ['compose:api'] },
		todos: { selectedFileTypes: [' TS '], search: 'FIXME' },
		expanded: { 'project:api': false }, showAllBranchProjects: true,
	});
	const expected = normalizePromptDashboardPreferences(state);
	await service.savePromptDashboardPreferences(state);
	state.expanded['project:api'] = true;
	state.docker.search = 'modified input';
	const returned = service.getPromptDashboardPreferences()!;
	returned.todos.selectedFileTypes.push('php');
	returned.expanded['branch:other'] = true;
	const restored = new StateService({ workspaceState: createWorkspaceStateMock(JSON.parse(JSON.stringify(
		Object.fromEntries(workspaceState.store),
	))) } as any);
	assert.deepEqual(restored.getPromptDashboardPreferences(), expected);
	await restored.savePromptDashboardPreferences(normalizePromptDashboardPreferences({ expanded: {} }));
	assert.deepEqual(restored.getPromptDashboardPreferences()?.expanded, {});
	assert.equal(restored.getPromptDashboardPreferences()?.showAllBranchProjects, false);
});

/** Быстрые полные снимки сохраняются в порядке поступления, а отказ не публикует optimistic Memento. */
test('StateService dashboard preferences recover after eager failure and serialize newer snapshots', async () => {
	const { StateService } = await importStateService();
	const entered = createDeferred<void>();
	const release = createDeferred<void>();
	const retryEntered = createDeferred<void>();
	const retryRelease = createDeferred<void>();
	const writes: unknown[] = [];
	const workspaceState = createWorkspaceStateMock({}, { update: async (store, key, value) => {
		writes.push(value);
		store.set(key, value);
		if (writes.length === 1) {
			entered.resolve();
			await release.promise;
			throw new Error('preferences write failed');
		}
		if (writes.length === 2) {
			retryEntered.resolve();
			await retryRelease.promise;
		}
	} });
	const service = new StateService({ workspaceState } as any);
	const failed = service.savePromptDashboardPreferences(normalizePromptDashboardPreferences({
		docker: { search: 'failed' },
	}));
	const rejected = assert.rejects(failed, /preferences write failed/);
	await entered.promise;
	try {
		assert.equal(service.getPromptDashboardPreferences(), undefined);
	} finally {
		release.resolve();
		await rejected;
	}
	assert.equal(service.getPromptDashboardPreferences(), undefined);
	const first = normalizePromptDashboardPreferences({ docker: { search: 'first' } });
	const latest = normalizePromptDashboardPreferences({ expanded: { 'project:api': false }, todos: { search: 'latest' } });
	const saving = Promise.all([
		service.savePromptDashboardPreferences(first),
		service.savePromptDashboardCollapsedSections({ activity: true }, 'single-column'),
		service.savePromptDashboardPreferences(latest),
	]);
	await retryEntered.promise;
	try {
		assert.equal(writes.length, 2);
		assert.equal(service.getPromptDashboardPreferences(), undefined);
	} finally {
		retryRelease.resolve();
		await saving;
	}
	assert.deepEqual(writes[1], first);
	assert.deepEqual(writes[3], latest);
	assert.deepEqual(service.getPromptDashboardPreferences(), latest);
	assert.deepEqual(service.getPromptDashboardCollapsedSections('single-column'), { activity: true });
});
