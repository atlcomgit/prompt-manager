import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizePromptDashboardLayouts, PROMPT_DASHBOARD_SECTION_KEYS } from '../src/types/promptDashboard.js';
import { normalizePromptDashboardPreferences } from '../src/types/promptDashboardPreferences.js';
import { createDefaultEditorPromptViewState } from '../src/types/prompt.js';
import { normalizePromptEditorLayout, PROMPT_EDITOR_TAB_SECTIONS } from '../src/types/promptEditorLayout.js';
import type { ExtensionContext } from 'vscode';

/** Настройки пользователя отделены от Memento и общие для всех подмен рабочих областей. */
function createConfigurationMock(
	initial: Record<string, unknown> = {},
	overrides?: {
		update?: (store: Map<string, unknown>, key: string, value: unknown) => Promise<void>;
		workspaceValues?: Record<string, unknown>;
	},
) {
	const store = new Map<string, unknown>(Object.entries(structuredClone(initial)));
	const writes: { key: string; value: unknown; target: number }[] = [];
	const inspected: string[] = [];
	return {
		store,
		writes,
		inspected,
		inspect<T>(key: string) {
			inspected.push(key);
			return {
				globalValue: structuredClone(store.get(key)) as T | undefined,
				workspaceValue: overrides?.workspaceValues?.[key] as T | undefined,
			};
		},
		async update(key: string, value: unknown, target: number): Promise<void> {
			assert.equal(target, 1, 'Настройки должны записываться в ConfigurationTarget.Global');
			writes.push({ key, value: structuredClone(value), target });
			if (overrides?.update) {
				await overrides.update(store, key, structuredClone(value));
				return;
			}
			store.set(key, structuredClone(value));
		},
	};
}

/** Барьер удерживает две записи разных окон до построения обоих патчей из одного подтверждённого снимка. */
function createConcurrentConfigurationMock() {
	const entered = createDeferred<void>();
	const released = createDeferred<void>();
	let armed = false;
	let blockedWrites = 0;
	const configuration = createConfigurationMock({}, { update: async (store, key, value) => {
		if (armed && blockedWrites < 2) {
			blockedWrites += 1;
			if (blockedWrites === 2) {
				entered.resolve();
			}
			await released.promise;
		}
		store.set(key, value);
	} });
	return {
		configuration,
		entered: entered.promise,
		arm: () => { armed = true; },
		release: () => { released.resolve(); },
	};
}

/** Текущий тест заменяет настройки, сохраняя закешированный модуль vscode между импортами. */
let activeConfiguration = createConfigurationMock();

/** Создаёт минимальный контекст без рабочих файлов, подключений и настоящего хранилища VS Code. */
function createStateContext(workspaceState = createWorkspaceStateMock()): ExtensionContext {
	return { workspaceState } as unknown as ExtensionContext;
}

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
		ConfigurationTarget: { Global: 1 },
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
			getConfiguration: (section: string) => {
				assert.equal(section, 'promptManager');
				return activeConfiguration;
			},
			fs: {
				stat: async () => ({ mtime: Date.now() }),
				readDirectory: async () => [],
			},
			onDidChangeConfiguration: () => createDisposable(),
		},
	};
}

async function importStateService(configuration = createConfigurationMock()) {
	activeConfiguration = configuration;
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

/** The saved plan view mode is separate for each prompt, even across reopens. */
test('StateService persists the plan mode independently per prompt', async () => {
	const { StateService } = await importStateService();
	const service = new StateService(createStateContext());
	const sourceA = { promptUuid: 'uuid-plan-a', promptId: 'plan-a' };
	const sourceB = { promptUuid: 'uuid-plan-b', promptId: 'plan-b' };
	assert.equal(service.getPromptEditorViewState(sourceA).planViewMode, 'compact');

	await service.savePromptEditorViewState(sourceA, {
		...createDefaultEditorPromptViewState(),
		planViewMode: 'full',
	});
	await service.savePromptEditorViewState(sourceB, createDefaultEditorPromptViewState());
	assert.equal(service.getPromptEditorViewState(sourceA).planViewMode, 'full');
	assert.equal(service.getPromptEditorViewState(sourceB).planViewMode, 'compact');

	await service.savePromptEditorViewState(sourceB, {
		...createDefaultEditorPromptViewState(),
		planViewMode: 'full',
	});
	assert.equal(service.getPromptEditorViewState(sourceA).planViewMode, 'full');
	assert.equal(service.getPromptEditorViewState(sourceB).planViewMode, 'full');
});

/** Explicit per-prompt plan mode survives stale layout snapshots and a new StateService instance. */
test('StateService keeps each plan view choice across close/reopen and stale full-state saves', async () => {
	const { StateService } = await importStateService();
	const workspaceState = createWorkspaceStateMock();
	const service = new StateService(createStateContext(workspaceState));
	const sourceA = { promptUuid: 'uuid-plan-a', promptId: 'plan-a' };
	const sourceB = { promptUuid: 'uuid-plan-b', promptId: 'plan-b' };

	await service.savePromptEditorViewState(sourceA, {
		...createDefaultEditorPromptViewState(), planViewMode: 'full',
	});
	await service.savePromptPlanViewMode(sourceA, 'compact');
	await service.savePromptPlanViewMode(sourceB, 'full');
	await service.savePromptEditorViewState(sourceA, {
		...createDefaultEditorPromptViewState(), planViewMode: 'full',
	});

	const reopened = new StateService(createStateContext(workspaceState));
	assert.equal(reopened.getPromptEditorViewState(sourceA).planViewMode, 'compact');
	assert.equal(reopened.getPromptEditorViewState(sourceB).planViewMode, 'full');
	assert.equal(reopened.getPromptEditorViewState({ promptUuid: 'new-uuid', promptId: 'new-prompt' }).planViewMode, 'compact');
	assert.equal(reopened.getPromptPlanViewMode(sourceA), 'compact');
});

/** Копия папки с тем же UUID не наследует выбор, а переименование переносит его вместе с состоянием редактора. */
test('StateService isolates plan mode of same-UUID folders and migrates it on rename', async () => {
	const { StateService } = await importStateService();
	const workspaceState = createWorkspaceStateMock();
	const service = new StateService(createStateContext(workspaceState));
	const original = { promptUuid: 'uuid-twin', promptId: 'task-171' };
	const copy = { promptUuid: 'uuid-twin', promptId: 'task-171-1' };
	const renamed = { promptUuid: 'uuid-twin', promptId: 'task-171-renamed' };

	await service.savePromptEditorViewState(copy, { ...createDefaultEditorPromptViewState(), planViewMode: 'full' });
	await service.savePromptPlanViewMode(original, 'compact');
	assert.equal(service.getPromptPlanViewMode(copy), null);
	assert.equal(service.getPromptEditorViewState(copy).planViewMode, 'full');

	await service.migratePromptEditorViewState([{ ...original, fallbackKey: 'panel:singleton' }], renamed);
	const reopened = new StateService(createStateContext(workspaceState));
	assert.equal(reopened.getPromptPlanViewMode(renamed), 'compact');
	assert.equal(reopened.getPromptPlanViewMode(original), null);
	assert.equal(reopened.getPromptEditorViewState(renamed).planViewMode, 'compact');
	assert.equal(reopened.getPromptEditorViewState(copy).planViewMode, 'full');
});

/** Обычное сохранение без переименования не перезаписывает карту режимов плана. */
test('StateService skips the plan mode write when a save migration changes nothing', async () => {
	const { StateService } = await importStateService();
	const planWrites: unknown[] = [];
	const workspaceState = createWorkspaceStateMock({}, {
		update: async (store, key, value) => {
			if (key === 'promptManager.editorPlanViewModes') {
				planWrites.push(value);
			}
			if (value === undefined) {
				store.delete(key);
			} else {
				store.set(key, value);
			}
		},
	});
	const service = new StateService(createStateContext(workspaceState));
	const source = { promptUuid: 'uuid-same', promptId: 'same' };

	await service.migratePromptEditorViewState([source], source);
	await service.savePromptPlanViewMode(source, 'full');
	await service.migratePromptEditorViewState([{ ...source, fallbackKey: 'panel:singleton' }], source);
	assert.deepEqual(planWrites, [{ 'promptUuid:uuid-same|promptId:same': 'full' }]);
	assert.equal(service.getPromptPlanViewMode(source), 'full');
});

/** Очередь сохраняет последние сворачивания через пользовательскую конфигурацию. */
test('StateService serializes global dashboard collapse writes', async () => {
	const entered = createDeferred<void>();
	const release = createDeferred<void>();
	let blocked = false;
	const configuration = createConfigurationMock({}, { update: async (store, key, value) => {
		if (!blocked) {
			blocked = true;
			entered.resolve();
			await release.promise;
		}
		store.set(key, value);
	} });
	const { StateService } = await importStateService(configuration);
	const workspaceState = createWorkspaceStateMock();
	const service = new StateService(createStateContext(workspaceState));
	const firstSave = service.savePromptDashboardCollapsedSections({ activity: true, status: false });
	const secondSave = service.savePromptDashboardCollapsedSections({ status: true, parallelBranches: true });
	await entered.promise;
	try {
		assert.equal(configuration.writes.length, 1);
		assert.deepEqual(service.getPromptDashboardCollapsedSections(), {});
	} finally {
		release.resolve();
		await Promise.all([firstSave, secondSave]);
	}
	assert.deepEqual(service.getPromptDashboardCollapsedSections(), { status: true, parallelBranches: true });
	assert.equal(configuration.store.get('dashboardLayouts.twoColumns.collapsed.status'), true);
	assert.equal(configuration.store.get('dashboardLayouts.twoColumns.collapsed.activity'), false);
	assert.equal(workspaceState.store.size, 0);
});

/** Перестановки одного профиля сериализуются и не меняют порядок другой ширины. */
test('StateService serializes global dashboard order writes independently of the other profile', async () => {
	const configuration = createConfigurationMock();
	const { StateService } = await importStateService(configuration);
	const service = new StateService(createStateContext());
	const narrowBefore = service.getPromptDashboardSectionOrder('single-column');
	await Promise.all([
		service.savePromptDashboardSectionOrder([['aiAnalysis', 'activity'], ['status']]),
		service.savePromptDashboardSectionOrder([
			['projectBranches', 'activity', 'parallelBranches'],
			['status', 'reviewRequests', 'projectCommits', 'aiAnalysis'],
		]),
	]);
	assert.deepEqual(service.getPromptDashboardSectionOrder(), [
		['projectBranches', 'activity', 'parallelBranches', 'dockerContainers', 'quickCommands'],
		['status', 'reviewRequests', 'projectCommits', 'aiAnalysis', 'todos', 'quickNotes'],
	]);
	assert.deepEqual(service.getPromptDashboardSectionOrder('single-column'), narrowBefore);
	assert.equal(configuration.writes.filter(write => write.key === 'dashboardLayouts.twoColumns.order').length, 2);
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

/** Чтение legacy ничего не записывает; первый жест переносит отсутствующие поля и только раскрытия main. */
test('StateService migrates legacy UI state only after an explicit save', async () => {
	const configuration = createConfigurationMock();
	const { StateService } = await importStateService(configuration);
	const legacyOrder = [['todos', 'status'], ['activity']];
	const preferences = normalizePromptDashboardPreferences({ docker: { search: 'legacy' } });
	const workspaceState = createWorkspaceStateMock({
		'promptManager.dashboardSectionOrder': legacyOrder,
		'promptManager.dashboardCollapsedSections': { activity: true },
		'promptManager.dashboardPreferences': preferences,
	});
	const service = new StateService(createStateContext(workspaceState));
	const source = { promptUuid: 'prompt-one', promptId: 'one' };
	const view = createDefaultEditorPromptViewState();
	view.expandedSections.workspace = false;
	view.expandedSections.files = true;
	view.expandedSections.report = true;
	view.expandedSections.notes = false;
	await service.savePromptEditorViewState(source, view);
	const workspaceBefore = structuredClone(Object.fromEntries(workspaceState.store));
	assert.deepEqual(service.getPromptDashboardLayouts(),
		normalizePromptDashboardLayouts(undefined, legacyOrder, { activity: true }));
	assert.deepEqual(service.getPromptDashboardPreferences(), preferences);
	assert.equal(service.getPromptEditorLayout().mainExpandedSections, undefined);
	assert.equal(configuration.writes.length, 0);

	await service.savePromptDashboardCollapsedSections({}, 'single-column', undefined, source);
	assert.deepEqual(service.getPromptDashboardCollapsedSections('single-column'), {});
	assert.deepEqual(service.getPromptDashboardCollapsedSections('two-columns'), { activity: true });
	assert.equal(service.getPromptEditorLayout().mainExpandedSections?.workspace, false);
	assert.equal(service.getPromptEditorLayout().mainExpandedSections?.files, true);
	assert.deepEqual([...configuration.store.keys()].filter(key => key.startsWith('editor.mainExpandedSections.'))
		.map(key => key.slice('editor.mainExpandedSections.'.length)).sort(), [...PROMPT_EDITOR_TAB_SECTIONS.main].sort());
	assert.equal(service.getPromptEditorViewState(source).expandedSections.report, true);
	assert.deepEqual(Object.fromEntries(workspaceState.store), workspaceBefore);
	assert.equal(configuration.store.get('dashboardPreferences.docker.search'), preferences.docker.search);
	assert.equal(configuration.store.get('dashboardPreferences.docker.viewMode'), null);
	assert.equal(configuration.store.has('dashboardPreferences.docker'), false);
	assert.equal(configuration.store.has('editor.mainExpandedSections'), false);
	assert.equal(configuration.store.has('dashboardLayouts.singleColumn.collapsed'), false);
	assert.ok(configuration.writes.every(write => write.target === 1));
});

/** Global имеет приоритет над legacy и workspaceValue; пустые объекты и false не считаются отсутствующими. */
test('StateService prefers explicit global settings over workspace profiles and workspace overrides', async () => {
	const globalOrder = [[], [...PROMPT_DASHBOARD_SECTION_KEYS]];
	const configuration = createConfigurationMock({
		'dashboardLayouts.twoColumns.order': globalOrder,
		'dashboardLayouts.twoColumns.collapsed.activity': false,
		'dashboardPreferences.expanded': {},
		'dashboardPreferences.showAllBranchProjects': false,
	}, { workspaceValues: { 'dashboardLayouts.twoColumns.collapsed.activity': true } });
	const { StateService } = await importStateService(configuration);
	const service = new StateService(createStateContext(createWorkspaceStateMock({
		'promptManager.dashboardCollapsedSections': { activity: true },
		'promptManager.dashboardPreferences': normalizePromptDashboardPreferences({
			expanded: { legacy: true }, showAllBranchProjects: true,
		}),
	})));
	assert.deepEqual(service.getPromptDashboardSectionOrder(), globalOrder);
	assert.deepEqual(service.getPromptDashboardCollapsedSections(), {});
	assert.deepEqual(service.getPromptDashboardPreferences()?.expanded, {});
	assert.equal(service.getPromptDashboardPreferences()?.showAllBranchProjects, false);
	assert.equal(configuration.writes.length, 0);
	assert.ok(configuration.inspected.includes('dashboardLayouts.twoColumns.collapsed.activity'));
});

/** Две рабочие области получают один пользовательский снимок и не мигрируют его повторно из чужого legacy. */
test('StateService shares saved UI settings between independent workspaces and serialized restore', async () => {
	const configuration = createConfigurationMock();
	const { StateService } = await importStateService(configuration);
	const firstWorkspace = createWorkspaceStateMock({
		'promptManager.dashboardCollapsedSections': { activity: true },
	});
	const secondWorkspace = createWorkspaceStateMock({
		'promptManager.dashboardCollapsedSections': { status: true },
	});
	const first = new StateService(createStateContext(firstWorkspace));
	const second = new StateService(createStateContext(secondWorkspace));
	await first.savePromptDashboardSectionOrder([[], [...PROMPT_DASHBOARD_SECTION_KEYS]], 'two-columns');
	await first.savePromptDashboardCollapsedSections({}, 'single-column');
	assert.deepEqual(second.getPromptDashboardLayouts(), first.getPromptDashboardLayouts());
	await second.savePromptDashboardCollapsedSections({ todos: true }, 'two-columns');
	assert.deepEqual(first.getPromptDashboardCollapsedSections(), { todos: true });

	const restoredConfiguration = createConfigurationMock(JSON.parse(JSON.stringify(
		Object.fromEntries(configuration.store),
	)));
	await importStateService(restoredConfiguration);
	const reopened = new StateService(createStateContext());
	assert.deepEqual(reopened.getPromptDashboardSectionOrder()[0], []);
	assert.deepEqual(reopened.getPromptDashboardCollapsedSections('single-column'), {});
	assert.deepEqual(reopened.getPromptDashboardCollapsedSections(), { todos: true });
	assert.deepEqual(firstWorkspace.store.get('promptManager.dashboardCollapsedSections'), { activity: true });
	assert.deepEqual(secondWorkspace.store.get('promptManager.dashboardCollapsedSections'), { status: true });
});

/** Запись фильтров копирует значения, сохраняет false и не возвращает удалённые внутренние раскрытия. */
test('StateService restores preferences without sharing mutable values and preserves empty settings', async () => {
	const configuration = createConfigurationMock();
	const { StateService } = await importStateService(configuration);
	const workspaceState = createWorkspaceStateMock();
	const service = new StateService(createStateContext(workspaceState));
	assert.equal(service.getPromptDashboardPreferences(), undefined);
	assert.equal(configuration.writes.length, 0);
	const state = normalizePromptDashboardPreferences({
		docker: { viewMode: 'table', statusFilter: 'stopped', search: 'api', sortBy: 'cpu',
			expandedContainerIds: ['compose:api'] },
		todos: { selectedFileTypes: [' TS '], search: 'FIXME' },
		expanded: { 'project:api': false }, showAllBranchProjects: true,
	});
	const expected = structuredClone(state);
	await service.savePromptDashboardPreferences(state);
	state.docker.search = 'changed input';
	service.getPromptDashboardPreferences()!.todos.selectedFileTypes.push('php');
	assert.deepEqual(service.getPromptDashboardPreferences(), expected);
	assert.equal(workspaceState.store.size, 0);
	await service.savePromptDashboardPreferences(normalizePromptDashboardPreferences({ expanded: {} }));
	assert.deepEqual(service.getPromptDashboardPreferences()?.expanded, {});
	assert.equal(service.getPromptDashboardPreferences()?.showAllBranchProjects, false);
	assert.deepEqual(service.getPromptDashboardPreferences()?.todos.selectedFileTypes, []);
});

/** Явный null после переноса не подхватывает старый режим другой рабочей области при независимом сохранении. */
test('StateService preserves migrated null Docker viewMode across workspaces with legacy preferences', async () => {
	const configuration = createConfigurationMock();
	const { StateService } = await importStateService(configuration);
	const service = new StateService(createStateContext());
	await service.savePromptDashboardPreferences(normalizePromptDashboardPreferences(undefined));
	assert.deepEqual(configuration.writes.filter(write => write.key === 'dashboardPreferences.docker.viewMode')
		.map(write => write.value), [null]);
	const secondWorkspace = createWorkspaceStateMock({
		'promptManager.dashboardPreferences': normalizePromptDashboardPreferences({ docker: { viewMode: 'cards' } }),
	});
	const secondService = new StateService(createStateContext(secondWorkspace));
	assert.equal(secondService.getPromptDashboardPreferences()?.docker.viewMode, undefined);
	await secondService.savePromptDashboardCollapsedSections({ activity: true }, 'two-columns', {});
	assert.deepEqual(configuration.writes.filter(write => write.key === 'dashboardPreferences.docker.viewMode')
		.map(write => write.value), [null]);
	assert.equal(service.getPromptDashboardPreferences()?.docker.viewMode, undefined);
	assert.equal(secondService.getPromptDashboardPreferences()?.docker.viewMode, undefined);
	assert.deepEqual(service.getPromptDashboardCollapsedSections(), { activity: true });
	assert.equal(configuration.store.get('dashboardPreferences.docker.viewMode'), null);
	assert.equal((secondWorkspace.store.get('promptManager.dashboardPreferences') as
		ReturnType<typeof normalizePromptDashboardPreferences>).docker.viewMode, 'cards');
});

/** Сброс null перекрывает legacy так же, как false и пустые значения; удалённый ключ снова разрешает fallback. */
test('StateService distinguishes explicit null resets from missing settings before normalization', async () => {
	const resets = {
		'dashboardLayouts.twoColumns.order': null,
		'dashboardLayouts.twoColumns.collapsed.activity': null,
		'editor.mainExpandedSections.files': null,
		'dashboardPreferences.docker.viewMode': null,
		'dashboardPreferences.docker.search': null,
		'dashboardPreferences.docker.expandedContainerIds': null,
		'dashboardPreferences.todos.search': null,
		'dashboardPreferences.todos.selectedFileTypes': null,
		'dashboardPreferences.expanded': null,
		'dashboardPreferences.showAllBranchProjects': null,
	};
	const configuration = createConfigurationMock(resets);
	const { StateService } = await importStateService(configuration);
	const service = new StateService(createStateContext(createWorkspaceStateMock({
		'promptManager.dashboardSectionOrder': [[], [...PROMPT_DASHBOARD_SECTION_KEYS]],
		'promptManager.dashboardCollapsedSections': { activity: true },
		'promptManager.dashboardPreferences': normalizePromptDashboardPreferences({
			docker: { viewMode: 'cards', search: 'legacy', expandedContainerIds: ['api'] },
			todos: { search: 'TODO', selectedFileTypes: ['ts'] },
			expanded: { legacy: true }, showAllBranchProjects: true,
		}),
	})));
	assert.deepEqual(service.getPromptDashboardPreferences(), normalizePromptDashboardPreferences(undefined));
	assert.deepEqual(service.getPromptDashboardSectionOrder(), normalizePromptDashboardLayouts()['two-columns'].sectionOrder);
	assert.deepEqual(service.getPromptDashboardCollapsedSections(), {});
	assert.equal(service.getPromptEditorLayout().mainExpandedSections?.files,
		createDefaultEditorPromptViewState().expandedSections.files);
	await service.savePromptDashboardCollapsedSections({ todos: true }, 'single-column', {});
	for (const key of Object.keys(resets)) {
		assert.equal(configuration.store.get(key), null, `${key} must not be migrated again`);
		assert.equal(configuration.writes.some(write => write.key === key), false);
	}
	configuration.store.delete('dashboardPreferences.docker.viewMode');
	service.invalidatePromptUiSettings();
	assert.equal(service.getPromptDashboardPreferences()?.docker.viewMode, 'cards');
	configuration.store.set('dashboardPreferences.docker.viewMode', null);
	service.invalidatePromptUiSettings();
	assert.equal(service.getPromptDashboardPreferences()?.docker.viewMode, undefined);
});

/** При отказе записи подтверждённый null и прежний режим защищены одинаково; повтор может успешно сбросить режим. */
for (const initialViewMode of [null, 'cards'] as const) {
	test(`StateService preserves confirmed Docker viewMode ${initialViewMode} through a failed write and retry`, async () => {
		const entered = createDeferred<void>();
		const release = createDeferred<void>();
		let fail = true;
		const configuration = createConfigurationMock({ 'dashboardPreferences.docker.viewMode': initialViewMode }, {
			update: async (store, key, value) => {
				store.set(key, value);
				if (fail && key === 'dashboardPreferences.docker.viewMode') {
					fail = false;
					entered.resolve();
					await release.promise;
					throw new Error('view mode write failed');
				}
			},
		});
		const { StateService } = await importStateService(configuration);
		const workspaceState = createWorkspaceStateMock({
			'promptManager.dashboardPreferences': normalizePromptDashboardPreferences({ docker: { viewMode: 'list' } }),
		});
		const service = new StateService(createStateContext(workspaceState));
		const base = service.getPromptDashboardPreferences()!;
		const next = structuredClone(base);
		next.docker.viewMode = initialViewMode === null ? 'cards' : undefined;
		const failed = assert.rejects(service.savePromptDashboardPreferences(next, base), /view mode write failed/);
		await entered.promise;
		try {
			assert.equal(service.getPromptDashboardPreferences()?.docker.viewMode, initialViewMode ?? undefined);
		} finally {
			release.resolve();
			await failed;
		}
		await service.savePromptDashboardCollapsedSections({ activity: true }, 'two-columns', {});
		assert.equal(service.getPromptDashboardPreferences()?.docker.viewMode, initialViewMode ?? undefined);
		assert.equal(configuration.writes.filter(write => write.key === 'dashboardPreferences.docker.viewMode').length, 1);
		await service.savePromptDashboardPreferences(next, base);
		assert.equal(service.getPromptDashboardPreferences()?.docker.viewMode, next.docker.viewMode);
		const restored = new StateService(createStateContext(workspaceState));
		assert.equal(restored.getPromptDashboardPreferences()?.docker.viewMode, next.docker.viewMode);
		assert.equal(configuration.store.get('dashboardPreferences.docker.viewMode'), next.docker.viewMode ?? null);
	});
}

/** Устаревший снимок меняет только свой фильтр, сохраняя свежие поля другого окна. */
test('StateService applies stale preference patches to the latest global settings', async () => {
	const configuration = createConfigurationMock();
	const { StateService } = await importStateService(configuration);
	const first = new StateService(createStateContext());
	const second = new StateService(createStateContext());
	const base = normalizePromptDashboardPreferences(undefined);
	await first.savePromptDashboardPreferences(base);
	const dockerChange = structuredClone(base);
	dockerChange.docker.search = 'api';
	dockerChange.expanded.first = false;
	await first.savePromptDashboardPreferences(dockerChange, base);
	const staleChange = structuredClone(base);
	staleChange.docker.sortBy = 'cpu';
	staleChange.todos.search = 'TODO';
	staleChange.expanded.second = true;
	await second.savePromptDashboardPreferences(staleChange, base);
	assert.equal(first.getPromptDashboardPreferences()?.docker.search, 'api');
	assert.equal(first.getPromptDashboardPreferences()?.docker.sortBy, 'cpu');
	assert.equal(first.getPromptDashboardPreferences()?.todos.search, 'TODO');
	assert.deepEqual(first.getPromptDashboardPreferences()?.expanded, { first: false, second: true });
});

/** Editing commands with an older snapshot preserves the agent chosen elsewhere. */
test('StateService persists the quick command agent separately from the command list', async () => {
	const base = normalizePromptDashboardPreferences(undefined);
	const configuration = createConfigurationMock({ 'dashboardPreferences.quickCommands.items': base.quickCommands.items });
	const { StateService } = await importStateService(configuration);
	const first = new StateService(createStateContext());
	const second = new StateService(createStateContext());
	await first.savePromptDashboardPreferences({ ...base, quickCommands: { ...base.quickCommands, target: 'codex' } }, base);
	await second.savePromptDashboardPreferences({ ...base, quickCommands: { items: ['/review'] } }, base);
	assert.deepEqual(second.getPromptDashboardPreferences()?.quickCommands, { items: ['/review'], target: 'codex' });
	assert.deepEqual(configuration.writes.filter(write => write.key.includes('.quickCommands.')), [
		{ key: 'dashboardPreferences.quickCommands.target', value: 'codex', target: 1 },
		{ key: 'dashboardPreferences.quickCommands.items', value: ['/review'], target: 1 },
	]);
});

/** Обе записи начинают update до завершения соседней; отдельные листья не затирают другой параметр Docker. */
test('StateService preserves simultaneous Docker search and sort changes from two windows', async () => {
	const barrier = createConcurrentConfigurationMock();
	const { StateService } = await importStateService(barrier.configuration);
	const first = new StateService(createStateContext());
	const second = new StateService(createStateContext());
	const base = normalizePromptDashboardPreferences(undefined);
	await first.savePromptDashboardPreferences(base);
	const searchChange = structuredClone(base);
	searchChange.docker.search = 'api';
	const sortChange = structuredClone(base);
	sortChange.docker.sortBy = 'cpu';
	barrier.arm();
	const saves = [
		first.savePromptDashboardPreferences(searchChange, base),
		second.savePromptDashboardPreferences(sortChange, base),
	];
	await barrier.entered;
	try {
		assert.equal(first.getPromptDashboardPreferences()?.docker.search, '');
		assert.equal(second.getPromptDashboardPreferences()?.docker.sortBy, base.docker.sortBy);
	} finally {
		barrier.release();
		await Promise.all(saves);
	}
	for (const service of [first, second]) {
		assert.equal(service.getPromptDashboardPreferences()?.docker.search, 'api');
		assert.equal(service.getPromptDashboardPreferences()?.docker.sortBy, 'cpu');
	}
	assert.equal(barrier.configuration.store.get('dashboardPreferences.docker.search'), 'api');
	assert.equal(barrier.configuration.store.get('dashboardPreferences.docker.sortBy'), 'cpu');
	assert.equal(barrier.configuration.store.has('dashboardPreferences.docker'), false);
});

/** Параллельные раскрытия main разных окон записываются независимо, даже когда исходный снимок общий. */
test('StateService preserves simultaneous independent main expansion flags from two windows', async () => {
	const barrier = createConcurrentConfigurationMock();
	const { StateService } = await importStateService(barrier.configuration);
	const first = new StateService(createStateContext());
	const second = new StateService(createStateContext());
	await first.savePromptEditorLayout(normalizePromptEditorLayout({ mainExpandedSections: {} }));
	const base = first.getPromptEditorLayout();
	const basicChange = structuredClone(base);
	basicChange.mainExpandedSections!.basic = !base.mainExpandedSections!.basic;
	const timeChange = structuredClone(base);
	timeChange.mainExpandedSections!.time = !base.mainExpandedSections!.time;
	barrier.arm();
	const saves = [first.savePromptEditorLayout(basicChange, base), second.savePromptEditorLayout(timeChange, base)];
	try {
		await barrier.entered;
	} finally {
		barrier.release();
		await Promise.all(saves);
	}
	for (const service of [first, second]) {
		assert.equal(service.getPromptEditorLayout().mainExpandedSections?.basic, !base.mainExpandedSections!.basic);
		assert.equal(service.getPromptEditorLayout().mainExpandedSections?.time, !base.mainExpandedSections!.time);
	}
	assert.equal(barrier.configuration.store.has('editor.mainExpandedSections'), false);
});

/** Сворачивание двух разных карточек не теряет соседний флаг при перекрывающихся записях двух окон. */
test('StateService preserves simultaneous independent dashboard collapse flags from two windows', async () => {
	const barrier = createConcurrentConfigurationMock();
	const { StateService } = await importStateService(barrier.configuration);
	const first = new StateService(createStateContext());
	const second = new StateService(createStateContext());
	await first.savePromptDashboardCollapsedSections({});
	const base = first.getPromptDashboardCollapsedSections();
	barrier.arm();
	const saves = [
		first.savePromptDashboardCollapsedSections({ status: true }, 'two-columns', base),
		second.savePromptDashboardCollapsedSections({ activity: true }, 'two-columns', base),
	];
	try {
		await barrier.entered;
	} finally {
		barrier.release();
		await Promise.all(saves);
	}
	assert.deepEqual(first.getPromptDashboardCollapsedSections(), { status: true, activity: true });
	assert.deepEqual(second.getPromptDashboardCollapsedSections(), { status: true, activity: true });
	assert.equal(barrier.configuration.store.has('dashboardLayouts.twoColumns.collapsed'), false);
});

/** Первый патч одного leaf сохраняет соседние legacy-фильтры и приоритет явно пустого global-значения. */
test('StateService migrates complete legacy preferences when the first explicit change affects one leaf', async () => {
	const configuration = createConfigurationMock({ 'dashboardPreferences.docker.search': '' });
	const { StateService } = await importStateService(configuration);
	const legacy = normalizePromptDashboardPreferences({
		docker: { search: 'workspace', sortBy: 'memory', statusFilter: 'stopped', expandedContainerIds: ['api'] },
		todos: { search: 'FIXME', selectedFileTypes: ['ts'] },
	});
	const service = new StateService(createStateContext(createWorkspaceStateMock({
		'promptManager.dashboardPreferences': legacy,
	})));
	const base = service.getPromptDashboardPreferences()!;
	assert.equal(base.docker.search, '');
	assert.equal(base.docker.sortBy, 'memory');
	const next = structuredClone(base);
	next.docker.sortBy = 'cpu';
	await service.savePromptDashboardPreferences(next, base);
	assert.deepEqual(service.getPromptDashboardPreferences(), next);
	assert.equal(configuration.store.get('dashboardPreferences.docker.search'), '');
	assert.equal(configuration.store.get('dashboardPreferences.docker.statusFilter'), 'stopped');
	assert.deepEqual(configuration.store.get('dashboardPreferences.docker.expandedContainerIds'), ['api']);
	assert.equal(configuration.store.get('dashboardPreferences.todos.search'), 'FIXME');
	assert.deepEqual(configuration.store.get('dashboardPreferences.todos.selectedFileTypes'), ['ts']);
});

/** Очередь раскрытий применяет оба изменения относительно одного старого снимка. */
test('StateService preserves independent queued collapse patches and explicit removals', async () => {
	const { StateService } = await importStateService();
	const service = new StateService(createStateContext());
	await service.savePromptDashboardCollapsedSections({ status: true });
	const base = service.getPromptDashboardCollapsedSections();
	await Promise.all([
		service.savePromptDashboardCollapsedSections({ status: true, todos: true }, 'two-columns', base),
		service.savePromptDashboardCollapsedSections({}, 'two-columns', base),
	]);
	assert.deepEqual(service.getPromptDashboardCollapsedSections(), { todos: true });
});

/** Порядок вкладок и раскрытия main разделены; автоматические flags Process никогда не уходят в global. */
test('StateService saves editor layout patches without globalizing Process expansion', async () => {
	const configuration = createConfigurationMock();
	const { StateService } = await importStateService(configuration);
	const service = new StateService(createStateContext());
	const source = { promptUuid: 'uuid-layout', promptId: 'layout' };
	const view = createDefaultEditorPromptViewState();
	view.expandedSections.plan = true;
	view.expandedSections.report = true;
	await service.savePromptEditorViewState(source, view);
	await service.savePromptEditorLayout(normalizePromptEditorLayout({
		main: ['time', 'basic'], process: ['report', 'plan'],
		mainExpandedSections: { basic: false, report: true, notes: false },
	}), undefined, source);
	const base = service.getPromptEditorLayout();
	const reordered = structuredClone(base);
	reordered.main = ['files', ...base.main.filter(key => key !== 'files')];
	await service.savePromptEditorLayout(reordered, base, source);
	const stale = structuredClone(base);
	stale.mainExpandedSections!.time = false;
	await service.savePromptEditorLayout(stale, base, source);
	assert.equal(service.getPromptEditorLayout().main[0], 'files');
	assert.equal(service.getPromptEditorLayout().mainExpandedSections?.basic, false);
	assert.equal(service.getPromptEditorLayout().mainExpandedSections?.time, false);
	assert.deepEqual(service.getPromptEditorLayout().process.slice(0, 2), ['report', 'plan']);
	assert.deepEqual([...configuration.store.keys()].filter(key => key.startsWith('editor.mainExpandedSections.'))
		.map(key => key.slice('editor.mainExpandedSections.'.length)).sort(), [...PROMPT_EDITOR_TAB_SECTIONS.main].sort());
	assert.equal(service.getPromptEditorViewState(source).expandedSections.plan, true);
	assert.equal(service.getPromptEditorViewState(source).expandedSections.report, true);
});

/** Доля ширины панелей общая для рабочих областей; чтение, перенос legacy и чужие правки её не записывают. */
test('StateService stores the panel split ratio globally and writes it only on explicit change', async () => {
	const configuration = createConfigurationMock();
	const { StateService } = await importStateService(configuration);
	const service = new StateService(createStateContext());
	const ratioWrites = () => configuration.writes.filter(write => write.key === 'editor.panelSplitRatio');
	const initial = service.getPromptEditorLayout();
	assert.equal(Object.hasOwn(initial, 'panelSplitRatio'), false);
	assert.equal(configuration.writes.length, 0);

	// Первый жест другой настройки переносит legacy-поля, но не создаёт ключ ширины.
	const reordered = structuredClone(initial);
	reordered.main = ['files', ...initial.main.filter(key => key !== 'files')];
	await service.savePromptEditorLayout(reordered, initial);
	assert.equal(configuration.store.has('editor.panelSplitRatio'), false);
	assert.equal(ratioWrites().length, 0);

	const base = service.getPromptEditorLayout();
	await service.savePromptEditorLayout({ ...base, panelSplitRatio: 0.612_345 }, base);
	assert.deepEqual(ratioWrites(), [{ key: 'editor.panelSplitRatio', value: 0.6123, target: 1 }]);
	const otherWorkspace = new StateService(createStateContext(createWorkspaceStateMock()));
	assert.equal(otherWorkspace.getPromptEditorLayout().panelSplitRatio, 0.6123);
	assert.equal(otherWorkspace.getPromptEditorLayout().main[0], 'files');

	// Старое сообщение без поля и правка раскрытия из того же снимка не сбрасывают ширину.
	const withRatio = service.getPromptEditorLayout();
	const legacyMessage = structuredClone(withRatio);
	delete legacyMessage.panelSplitRatio;
	legacyMessage.process = ['report', ...withRatio.process.filter(key => key !== 'report')];
	await service.savePromptEditorLayout(legacyMessage, withRatio);
	const expansion = service.getPromptEditorLayout();
	await service.savePromptEditorLayout({ ...expansion,
		mainExpandedSections: { ...expansion.mainExpandedSections, files: !expansion.mainExpandedSections?.files } },
	expansion);
	assert.equal(ratioWrites().length, 1);
	assert.equal(service.getPromptEditorLayout().panelSplitRatio, 0.6123);
	assert.equal(service.getPromptEditorLayout().process[0], 'report');

	// Сброс сохраняет явный null, а повтор того же значения ничего не пишет.
	const beforeReset = service.getPromptEditorLayout();
	await service.savePromptEditorLayout({ ...beforeReset, panelSplitRatio: null }, beforeReset);
	const afterReset = service.getPromptEditorLayout();
	await service.savePromptEditorLayout({ ...afterReset, panelSplitRatio: null }, afterReset);
	assert.equal(configuration.store.get('editor.panelSplitRatio'), null);
	assert.equal(afterReset.panelSplitRatio, null);
	assert.equal(ratioWrites().length, 2);

	// Некорректное ручное значение в settings.json читается как автоматическая ширина.
	configuration.store.set('editor.panelSplitRatio', 'wide');
	service.invalidatePromptUiSettings();
	assert.equal(service.getPromptEditorLayout().panelSplitRatio, null);
});

/** Каждая глобальная настройка интерфейса объявлена application-ключом, иначе Settings Sync её не передаст. */
test('PROMPT_UI_SETTING_KEYS are declared as application settings in package.json', async () => {
	const { PROMPT_UI_SETTING_KEYS } = await importStateService();
	const manifest = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
	const properties = manifest.contributes.configuration.properties as Record<string, Record<string, unknown>>;
	for (const key of PROMPT_UI_SETTING_KEYS) {
		assert.equal(properties[`promptManager.${key}`]?.scope, 'application', key);
	}
	const ratio = properties['promptManager.editor.panelSplitRatio'];
	assert.deepEqual([ratio.type, ratio.default, ratio.minimum, ratio.maximum], [['number', 'null'], null, 0, 1]);
});

/** Отказ записи ширины оставляет подтверждённое значение и не мешает повтору того же выбора. */
test('StateService keeps the confirmed panel split ratio after a failed write and accepts a retry', async () => {
	let fail = true;
	const configuration = createConfigurationMock({ 'editor.panelSplitRatio': 0.4 }, { update: async (store, key, value) => {
		if (fail && key === 'editor.panelSplitRatio') {
			fail = false;
			throw new Error('ratio write failed');
		}
		store.set(key, value);
	} });
	const { StateService } = await importStateService(configuration);
	const service = new StateService(createStateContext());
	const base = service.getPromptEditorLayout();
	await assert.rejects(service.savePromptEditorLayout({ ...base, panelSplitRatio: 0.7 }, base), /ratio write failed/);
	assert.equal(service.getPromptEditorLayout().panelSplitRatio, 0.4);
	await service.savePromptEditorLayout({ ...base, panelSplitRatio: 0.7 }, base);
	assert.equal(service.getPromptEditorLayout().panelSplitRatio, 0.7);
	assert.equal(configuration.store.get('editor.panelSplitRatio'), 0.7);
});

/** Eager update скрыт до подтверждения и после отказа; следующая запись другого профиля не наследует его. */
test('StateService hides eager failed global writes and recovers on later saves', async () => {
	const entered = createDeferred<void>();
	const release = createDeferred<void>();
	let first = true;
	const configuration = createConfigurationMock({}, { update: async (store, key, value) => {
		store.set(key, value);
		if (first) {
			first = false;
			entered.resolve();
			await release.promise;
			throw new Error('simulated persistence failure');
		}
	} });
	const { StateService } = await importStateService(configuration);
	const service = new StateService(createStateContext());
	const expected = service.getPromptDashboardLayouts();
	const rejected = assert.rejects(
		service.savePromptDashboardCollapsedSections({ status: true }, 'single-column'),
		/simulated persistence failure/,
	);
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
	configuration.store.set('dashboardLayouts.singleColumn.collapsed.activity', true);
	service.invalidatePromptUiSettings();
	assert.deepEqual(service.getPromptDashboardCollapsedSections('single-column'), { activity: true });
});

/** Отказ первого поля preferences не публикует фильтр и не мешает новым полным снимкам очереди. */
test('StateService recovers preferences after an eager failure and serializes newer snapshots', async () => {
	let fail = false;
	const configuration = createConfigurationMock({}, { update: async (store, key, value) => {
		store.set(key, value);
		if (fail && key === 'dashboardPreferences.docker.search') {
			fail = false;
			throw new Error('preferences write failed');
		}
	} });
	const { StateService } = await importStateService(configuration);
	const service = new StateService(createStateContext());
	const initial = normalizePromptDashboardPreferences(undefined);
	await service.savePromptDashboardPreferences(initial);
	configuration.writes.length = 0;
	fail = true;
	await assert.rejects(service.savePromptDashboardPreferences(normalizePromptDashboardPreferences({
		docker: { search: 'failed' },
	})), /preferences write failed/);
	assert.deepEqual(service.getPromptDashboardPreferences(), initial);
	const first = normalizePromptDashboardPreferences({ docker: { search: 'first' } });
	const latest = normalizePromptDashboardPreferences({ todos: { search: 'latest' }, expanded: { api: false } });
	await Promise.all([
		service.savePromptDashboardPreferences(first),
		service.savePromptDashboardCollapsedSections({ activity: true }, 'single-column'),
		service.savePromptDashboardPreferences(latest),
	]);
	assert.deepEqual(configuration.writes.filter(write => write.key === 'dashboardPreferences.docker.search')
		.map(write => write.value), ['failed', 'first', '']);
	assert.deepEqual(service.getPromptDashboardPreferences(), latest);
	assert.deepEqual(service.getPromptDashboardCollapsedSections('single-column'), { activity: true });
});

/** Bootstrap ожидает добавленные сохранения даже после отказа первого configuration.update. */
test('StateService waits for saves queued during a pending failed global update', async () => {
	const firstEntered = createDeferred<void>();
	const firstRelease = createDeferred<void>();
	const secondEntered = createDeferred<void>();
	const secondRelease = createDeferred<void>();
	let writes = 0;
	let completed = false;
	const configuration = createConfigurationMock({}, { update: async (store, key, value) => {
		writes += 1;
		if (writes === 1) {
			firstEntered.resolve();
			await firstRelease.promise;
			throw new Error('write failure');
		}
		if (writes === 2) {
			secondEntered.resolve();
			await secondRelease.promise;
		}
		store.set(key, value);
	} });
	const { StateService } = await importStateService(configuration);
	const service = new StateService(createStateContext());
	const failure = assert.rejects(service.savePromptDashboardCollapsedSections({ todos: true }));
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
		assert.deepEqual(service.getPromptDashboardCollapsedSections(), {});
		assert.deepEqual(service.getPromptDashboardPreferences(), preferences);
	} finally {
		firstRelease.resolve();
		secondRelease.resolve();
		await Promise.all([failure, saving, waiting]);
	}
});
