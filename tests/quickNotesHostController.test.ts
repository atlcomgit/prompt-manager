import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { normalizePromptDashboardPreferences } from '../src/types/promptDashboardPreferences.js';

/* ── vscode mock ── */
const originalLoad = (Module as any)._load;
const configurationListeners: Array<(event: { affectsConfiguration(section: string): boolean }) => void> = [];
/** Информационные сообщения контроллера: модуль кешируется, поэтому журнал общий для всех тестов файла. */
const informationMessages: string[] = [];

/** Минимальный API VS Code для контроллера заметок. */
function createVsCodeMock() {
	return {
		Uri: { file: (value: string) => ({ fsPath: value, toString: () => value }) },
		workspace: {
			onDidChangeConfiguration: (listener: (event: { affectsConfiguration(section: string): boolean }) => void) => {
				configurationListeners.push(listener);
				return { dispose() { } };
			},
		},
		window: {
			showErrorMessage: async () => undefined,
			showInformationMessage: async (message: string) => { informationMessages.push(message); return undefined; },
			createOutputChannel: () => ({ appendLine() { }, append() { }, show() { }, dispose() { } }),
		},
	};
}

/** Загружает контроллер с заглушкой модуля vscode. */
async function importController() {
	(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return createVsCodeMock();
		}
		return originalLoad.call(this, request, parent, isMain);
	};
	try {
		return await import('../src/providers/quickNotesHostController.js');
	} finally {
		(Module as any)._load = originalLoad;
	}
}

/** Контроллер с подменёнными зависимостями и журналом отправленных сообщений. */
async function createController(stateService: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	const { QuickNotesHostController } = await importController();
	const posted: Array<Record<string, unknown>> = [];
	const channel = { webview: {} as never, post: async (message: Record<string, unknown>) => { posted.push(message); } };
	configurationListeners.length = 0;
	const controller = new QuickNotesHostController({
		service: { onDidChange: () => ({ dispose() { } }), getFilesRoot: () => null } as never,
		aiService: {} as never,
		storageService: {} as never,
		stateService: { getPromptDashboardPreferences: () => undefined, ...stateService } as never,
		getChannels: () => [channel as never],
		createPrompt: async () => null,
		openPrompt: async () => undefined,
		openBoard: async () => undefined,
		resolveFileReference: () => null,
		...extra,
	} as never);
	return { controller, posted, channel };
}

/** Событие конфигурации приходит до конца собственной записи: настройки рассылаются только после неё. */
test('QuickNotesHostController broadcasts view preferences after pending dashboard saves', async () => {
	let releaseSave: () => void = () => undefined;
	let current = normalizePromptDashboardPreferences(undefined);
	const { posted } = await createController({
		getPromptDashboardPreferences: () => current,
		waitForPromptDashboardSaves: () => new Promise<void>(resolve => { releaseSave = resolve; }),
	});
	assert.equal(configurationListeners.length, 1);
	configurationListeners[0]({ affectsConfiguration: section => section === 'promptManager.dashboardPreferences.quickNotes' });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(posted.length, 0);
	current = { ...current, quickNotes: { ...current.quickNotes, boardGroupBy: 'color' } };
	releaseSave();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(posted.length, 1);
	assert.equal(posted[0].type, 'quickNotesPreferences');
	assert.equal((posted[0].state as { boardGroupBy: string }).boardGroupBy, 'color');
});

/** Страница доски открывается сообщением виджета; настройки сохраняются с базой только для полей заметок. */
test('QuickNotesHostController opens the board page and saves preferences against base', async () => {
	const saved: unknown[][] = [];
	let boardOpened = 0;
	const initial = normalizePromptDashboardPreferences(undefined);
	const { controller, channel } = await createController({
		getPromptDashboardPreferences: () => initial,
		savePromptDashboardPreferences: async (...args: unknown[]) => { saved.push(args); },
		waitForPromptDashboardSaves: async () => undefined,
	}, { openBoard: async () => { boardOpened += 1; } });
	const { isQuickNotesWebviewMessage } = await importController();
	assert.equal(isQuickNotesWebviewMessage({ type: 'quickNotesOpenBoard' } as never), true);
	await controller.handleMessage({ type: 'quickNotesOpenBoard' } as never, channel as never);
	assert.equal(boardOpened, 1);
	const next = { ...initial.quickNotes, boardShowDone: true };
	await controller.handleMessage({ type: 'quickNotesSavePreferences', state: next, baseState: initial.quickNotes } as never, channel as never);
	assert.equal(saved.length, 1);
	const [nextPreferences, basePreferences] = saved[0] as [typeof initial, typeof initial];
	assert.equal(nextPreferences.quickNotes.boardShowDone, true);
	assert.equal(basePreferences.quickNotes.boardShowDone, false);
	assert.deepEqual({ ...nextPreferences, quickNotes: null }, { ...basePreferences, quickNotes: null });
});

/** Неверная операция из webview отклоняется до сервиса, а панель получает ответ и не ждёт таймаута. */
test('QuickNotesHostController rejects malformed operations before the storage service', async () => {
	let applied = 0;
	const state = { scopes: {}, notes: [] };
	const { controller, posted, channel } = await createController({
		getPromptDashboardPreferences: () => undefined,
		waitForPromptDashboardSaves: async () => undefined,
	}, {
		service: {
			onDidChange: () => ({ dispose() { } }),
			getFilesRoot: () => null,
			getState: async () => state,
			applyOperation: async () => { applied += 1; return { result: { ok: true }, state }; },
		},
	});
	await controller.handleMessage({
		type: 'quickNotesApply', requestId: 'r1',
		operation: { kind: 'changeScope', scope: 'global', toScope: 'bogus', id: 'a', at: 'T' },
	} as never, channel as never);
	assert.equal(applied, 0);
	assert.equal(posted.length, 1);
	assert.equal(posted[0].requestId, 'r1');
	assert.equal((posted[0].result as { ok: boolean; code: string }).code, 'failed');
});

/** Заметка со ссылкой на промпт второй промпт не создаёт, даже если запрос пришёл из другой панели. */
test('QuickNotesHostController does not create a second prompt for a linked note', async () => {
	let created = 0;
	const linked = { id: 'n1', scope: 'workspace', title: 'Заметка', files: [], prompt: { id: 'p1', promptUuid: 'u1' } };
	const { controller, posted, channel } = await createController({}, {
		service: {
			onDidChange: () => ({ dispose() { } }),
			getFilesRoot: () => null,
			getState: async () => ({ scopes: {}, notes: [linked] }),
		},
		createPrompt: async () => { created += 1; return null; },
	});
	await controller.handleMessage({ type: 'quickNotesCreatePrompt', scope: 'workspace', noteId: 'n1', requestId: 'r2' } as never, channel as never);
	assert.equal(created, 0);
	assert.equal(posted[0].type, 'quickNotesPromptCreated');
	assert.equal(posted[0].ok, false);
});


/** После сохранения длинной заметки AI меняет только временный заголовок и рассылает новое состояние. */
test('QuickNotesHostController asynchronously generates a title after persisting a long note', async () => {
	const { applyQuickNoteOperation } = await import('../src/utils/quickNotes.js');
	const description = 'Подробное описание работы над системой доступа с проверкой ошибок, журналов, конфигурации и способов восстановления.';
	const original = {
		id: 'long-note', title: 'Подробное описание работы…', description, color: '', done: false,
		order: 0, items: [], files: [], createdAt: '2026-11-18T08:00:00Z', updatedAt: '2026-11-18T08:00:00Z',
	};
	let state: any = { scopes: {
		workspace: { scope: 'workspace', available: true, filePath: '/ws/quick-notes.json' },
		global: { scope: 'global', available: true, filePath: '/home/quick-notes.json' },
	}, notes: [] };
	const operations: string[] = [];
	let aiCalls = 0;
	const { controller, channel } = await createController({}, {
		service: {
			onDidChange: () => ({ dispose() { } }), getFilesRoot: () => null,
			getState: async () => state,
			applyOperation: async (operation: any) => {
				operations.push(operation.kind);
				const result = applyQuickNoteOperation(state.notes, operation);
				state = { ...state, notes: result.notes };
				return { result: result.result, state };
			},
		},
		aiService: { generateQuickNoteTitle: async () => { aiCalls++; return '## Проверка системы доступа'; } },
	});
	await controller.handleMessage({
		type: 'quickNotesApply', requestId: 'create-long',
		operation: { kind: 'create', scope: 'workspace', note: original, autoTitle: true },
	} as never, channel as never);
	await (controller as any).titleGenerationQueue;
	assert.deepEqual(operations, ['create', 'setGeneratedTitle']);
	assert.equal(aiCalls, 1);
	assert.equal(state.notes[0].title, 'Проверка системы доступа');
	assert.equal(state.notes[0].description, description);
	controller.dispose();
});

/** Если пользователь отредактировал заметку, пока AI работал, результат не заменяет его название. */
test('QuickNotesHostController does not override a manual title edit during generation', async () => {
	const { applyQuickNoteOperation } = await import('../src/utils/quickNotes.js');
	const original = {
		id: 'editing-note', title: 'Временный заголовок', description: 'Большая заметка', color: '', done: false,
		order: 0, items: [], files: [], createdAt: '2026-11-18T08:00:00Z', updatedAt: '2026-11-18T08:00:00Z',
	};
	let state: any = { scopes: {
		workspace: { scope: 'workspace', available: true, filePath: '/ws/quick-notes.json' },
		global: { scope: 'global', available: true, filePath: '/home/quick-notes.json' },
	}, notes: [] };
	let release: ((value: string) => void) | undefined;
	const { controller, channel } = await createController({}, {
		service: {
			onDidChange: () => ({ dispose() { } }), getFilesRoot: () => null,
			getState: async () => state,
			applyOperation: async (operation: any) => {
				const outcome = applyQuickNoteOperation(state.notes, operation);
				state = { ...state, notes: outcome.notes };
				return { result: outcome.result, state };
			},
		},
		aiService: {
			generateQuickNoteTitle: async () => new Promise<string>(resolve => { release = resolve; }),
		},
	});
	await controller.handleMessage({
		type: 'quickNotesApply', requestId: 'editing-create',
		operation: { kind: 'create', scope: 'workspace', note: original, autoTitle: true },
	} as never, channel as never);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.ok(release);
	state.notes[0].title = 'Ручное название пользователя';
	release!('Название от модели');
	await (controller as any).titleGenerationQueue;
	assert.equal(state.notes[0].title, 'Ручное название пользователя');
	controller.dispose();
});


/** Uploading a local browser file chunk is routed to the quick-notes service and acknowledged by requestId. */
test('QuickNotesHostController routes browser upload chunks and returns a finished file', async () => {
	const file = { id: 'file1', name: 'local.txt', storedName: 'local.txt', size: 4, addedAt: '2026-11-19T00:00:00Z' };
	let uploads = 0;
	const { controller, channel, posted } = await createController({}, {
		service: {
			onDidChange: () => ({ dispose() { } }),
			getFilesRoot: () => null,
			importBrowserChunk: async () => { uploads++; return file; },
		},
	});
	const { isQuickNotesWebviewMessage } = await importController();
	const request = {
		type: 'quickNotesUploadChunk', scope: 'workspace', draftId: 'draft1', requestId: 'upload-1',
		uploadId: 'qn-upload-abc123', name: 'local.txt',
		fileSize: 4, chunkIndex: 0, chunkCount: 1, dataBase64: Buffer.from('data').toString('base64'),
	};
	assert.equal(isQuickNotesWebviewMessage(request as never), true);
	await controller.handleMessage(request as never, channel as never);
	assert.equal(uploads, 1);
	assert.equal(posted[0].type, 'quickNotesUploadResult');
	assert.equal(posted[0].requestId, 'upload-1');
	assert.deepEqual(posted[0].file, file);
	controller.dispose();
});

/** Title generation reports its start and finish to every open notes view. */
test('QuickNotesHostController broadcasts title-generation progress before and after AI', async () => {
	const { applyQuickNoteOperation } = await import('../src/utils/quickNotes.js');
	const original = {
		id: 'spinner1', title: 'Готовится', description: 'Длинный текст', color: '', done: false,
		order: 0, items: [], files: [], createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z',
	};
	let state: any = { scopes: {}, notes: [] };
	let finish: ((value: string) => void) | undefined;
	const { controller, channel, posted } = await createController({}, {
		service: {
			onDidChange: () => ({ dispose() { } }),
			getFilesRoot: () => null,
			getState: async () => state,
			applyOperation: async (operation: any) => {
				const outcome = applyQuickNoteOperation(state.notes, operation);
				state = { ...state, notes: outcome.notes };
				return { result: outcome.result, state };
			},
		},
		aiService: { generateQuickNoteTitle: async () => new Promise<string>(resolve => { finish = resolve; }) },
	});
	await controller.handleMessage({
		type: 'quickNotesApply', requestId: 'spinner-create',
		operation: { kind: 'create', scope: 'workspace', note: original, autoTitle: true },
	} as never, channel as never);
	await new Promise(resolve => setImmediate(resolve));
	const notifications = posted.filter(x => x.type === 'quickNotesTitleGeneration');
	assert.ok(notifications.some(x => (x.generatingTitleKeys as string[]).includes('workspace:spinner1')));
	assert.ok(finish);
	finish!('Создано название');
	await (controller as any).titleGenerationQueue;
	await new Promise(resolve => setImmediate(resolve));
	const finalNotification = posted.filter(x => x.type === 'quickNotesTitleGeneration').at(-1);
	assert.deepEqual(finalNotification?.generatingTitleKeys, []);
	controller.dispose();
});


/** Deleting a prompt immediately clears a stale link without removing or editing the note itself. */
test('QuickNotesHostController clears only the deleted prompt association and publishes it', async () => {
	const { applyQuickNoteOperation } = await import('../src/utils/quickNotes.js');
	const base = {
		color: '', done: false, order: 0, description: '', items: [], files: [],
		createdAt: 'T', updatedAt: 'T', scope: 'workspace',
	};
	let state: any = {
		scopes: { workspace: { scope: 'workspace', filePath: '/tmp/test-notes.json', available: true },
			global: { scope: 'global', filePath: '/tmp/global-notes.json', available: true } },
		notes: [
			{ ...base, id: 'linked', title: 'Старая связь', prompt: { id: 'old-prompt', promptUuid: 'uuid-old' } },
			{ ...base, id: 'new-link', title: 'Новая связь', prompt: { id: 'old-prompt', promptUuid: 'uuid-new' } },
		],
	};
	const { controller, posted } = await createController({}, {
		service: {
			onDidChange: () => ({ dispose() {} }),
			getFilesRoot: () => null,
			getState: async () => state,
			applyOperation: async (op: any) => {
				const outcome = applyQuickNoteOperation(state.notes, op);
				state = { ...state, notes: outcome.notes };
				return { result: outcome.result, state };
			},
		},
	});
	await controller.handleDeletedPrompt({ id: 'old-prompt', promptUuid: 'uuid-old' });
	assert.equal(state.notes[0].prompt, undefined);
	assert.equal(state.notes[1].prompt.promptUuid, 'uuid-new');
	assert.equal(posted.some(msg => msg.type === 'quickNotesState'), true);
	controller.dispose();
});

/** Сервис заметок поверх состояния в памяти с журналом применённых операций. */
async function createMemoryNotesService(notes: any[]) {
	const { applyQuickNoteOperation } = await import('../src/utils/quickNotes.js');
	const operations: any[] = [];
	const holder: { state: any } = {
		state: {
			scopes: {
				workspace: { scope: 'workspace', filePath: '/ws/quick-notes.json', available: true },
				global: { scope: 'global', filePath: '/home/quick-notes.json', available: true },
			},
			notes,
		},
	};
	const service = {
		onDidChange: () => ({ dispose() { } }),
		getFilesRoot: () => null,
		getState: async () => holder.state,
		applyOperation: async (operation: any) => {
			operations.push(operation);
			const outcome = applyQuickNoteOperation(holder.state.notes, operation);
			holder.state = { ...holder.state, notes: outcome.notes };
			return { result: outcome.result, state: holder.state };
		},
	};
	return { service, operations, holder };
}

/** Сообщение окна или виджета об открытии промпта по ссылке заметки. */
function openPromptMessage(link: { id: string; promptUuid: string }): never {
	return { type: 'quickNotesOpenPrompt', promptId: link.id, promptUuid: link.promptUuid } as never;
}

/** Заметка со ссылкой на промпт для проверок открытия. */
function linkedNote(id: string, scope: 'workspace' | 'global', prompt: { id: string; promptUuid: string }) {
	return {
		id, scope, title: id, description: '', color: '', done: false, order: 0, items: [], files: [],
		createdAt: 'T', updatedAt: 'T', prompt,
	};
}

/**
 * Глобальная заметка из другой рабочей области: промпт с тем же id, но другим UUID не открывается,
 * а ссылка сохраняется с сообщением о другой рабочей области (handleOpenPrompt).
 */
test('QuickNotesHostController keeps a global link when its prompt lives in another workspace', async () => {
	const link = { id: 'shared-id', promptUuid: 'uuid-other-workspace' };
	const { service, operations, holder } = await createMemoryNotesService([linkedNote('g1', 'global', link)]);
	const opened: unknown[] = [];
	const foreign = { id: 'shared-id', promptUuid: 'uuid-local' };
	const { controller, channel } = await createController({}, {
		service,
		storageService: {
			listPrompts: async () => [foreign],
			exists: async (id: string) => id === 'shared-id',
			getPrompt: async (id: string) => (id === 'shared-id' ? foreign : null),
		},
		openPrompt: async (target: unknown) => { opened.push(target); },
	});
	informationMessages.length = 0;
	await controller.handleMessage(openPromptMessage(link), channel as never);
	assert.deepEqual(opened, []);
	assert.deepEqual(operations, []);
	assert.deepEqual(holder.state.notes[0].prompt, link);
	assert.equal(informationMessages.length, 1);
	assert.match(informationMessages[0], /не найден в этой рабочей области/);
	controller.dispose();
});

/** Промпт, найденный по id без расхождения UUID, по-прежнему открывается из проверки наличия папки. */
test('QuickNotesHostController opens a prompt found by id when its UUID matches', async () => {
	const link = { id: 'local-id', promptUuid: 'uuid-1' };
	const { service } = await createMemoryNotesService([linkedNote('w1', 'workspace', link)]);
	const opened: unknown[] = [];
	const { controller, channel } = await createController({}, {
		service,
		storageService: {
			listPrompts: async () => [],
			exists: async () => true,
			getPrompt: async () => ({ id: 'local-id', promptUuid: 'uuid-1' }),
		},
		openPrompt: async (target: unknown) => { opened.push(target); },
	});
	await controller.handleMessage(openPromptMessage(link), channel as never);
	assert.deepEqual(opened, [link]);
	controller.dispose();
});

/**
 * У заметки проекта ссылка на ненайденный промпт снимается условной операцией, а ссылки глобальной заметки
 * и заметки с тем же id, но другим UUID, не меняются (handleOpenPrompt).
 */
test('QuickNotesHostController conditionally clears only matching workspace links of a missing prompt', async () => {
	const link = { id: 'gone', promptUuid: 'uuid-gone' };
	const other = { id: 'gone', promptUuid: 'uuid-new' };
	const { service, operations, holder } = await createMemoryNotesService([
		linkedNote('w1', 'workspace', link),
		linkedNote('w2', 'workspace', other),
		linkedNote('g1', 'global', link),
	]);
	const opened: unknown[] = [];
	const { controller, channel, posted } = await createController({}, {
		service,
		storageService: { listPrompts: async () => [], exists: async () => false, getPrompt: async () => null },
		openPrompt: async (target: unknown) => { opened.push(target); },
	});
	informationMessages.length = 0;
	await controller.handleMessage(openPromptMessage(link), channel as never);
	assert.deepEqual(opened, []);
	assert.deepEqual(operations, [{
		kind: 'clearDeletedPromptLink', scope: 'workspace', id: 'w1', promptId: 'gone', promptUuid: 'uuid-gone',
	}]);
	const byId = Object.fromEntries(holder.state.notes.map((entry: any) => [entry.id, entry.prompt]));
	assert.equal(byId.w1, undefined);
	assert.deepEqual(byId.w2, other);
	assert.deepEqual(byId.g1, link);
	assert.equal(posted.some(message => message.type === 'quickNotesState'), true);
	assert.match(informationMessages[0], /Ссылка в глобальной заметке сохранена/);
	controller.dispose();
});
