import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const originalLoad = (Module as any)._load;
const vscodeFsWritePaths: string[] = [];
const vscodeFsStatPaths: string[] = [];
const vscodeFsReadPaths: string[] = [];

function createDisposable() {
	return { dispose() { } };
}

function toFileType(entry: fs.Stats | fs.Dirent): number {
	if (entry.isDirectory()) {
		return 2;
	}

	return 1;
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

		dispose(): void {
			this.listeners.length = 0;
		}
	}

	class RelativePattern {
		constructor(
			public readonly base: string,
			public readonly pattern: string,
		) { }
	}

	return {
		EventEmitter,
		FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
		RelativePattern,
		Uri: {
			file: (value: string) => ({
				fsPath: value,
				toString: () => value,
			}),
			joinPath: (base: { fsPath?: string }, ...parts: string[]) => {
				const fsPath = path.join(base.fsPath || '', ...parts);
				return {
					fsPath,
					toString: () => fsPath,
				};
			},
		},
		workspace: {
			fs: {
				readFile: async (uri: { fsPath: string }) => {
					vscodeFsReadPaths.push(uri.fsPath);
					return fsp.readFile(uri.fsPath);
				},
				writeFile: async (uri: { fsPath: string }, data: Uint8Array) => {
					vscodeFsWritePaths.push(uri.fsPath);
					await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
					await fsp.writeFile(uri.fsPath, Buffer.from(data));
				},
				stat: async (uri: { fsPath: string }) => {
					vscodeFsStatPaths.push(uri.fsPath);
					const stat = await fsp.stat(uri.fsPath);
					return {
						type: toFileType(stat),
						size: stat.size,
						mtime: stat.mtimeMs,
					};
				},
				createDirectory: async (uri: { fsPath: string }) => {
					await fsp.mkdir(uri.fsPath, { recursive: true });
				},
				readDirectory: async (uri: { fsPath: string }) => {
					const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
					return entries.map(entry => [entry.name, toFileType(entry)] as [string, number]);
				},
				delete: async (uri: { fsPath: string }, options?: { recursive?: boolean }) => {
					await fsp.rm(uri.fsPath, {
						recursive: options?.recursive === true,
						force: true,
					});
				},
				rename: async (
					oldUri: { fsPath: string },
					newUri: { fsPath: string },
					options?: { overwrite?: boolean },
				) => {
					if (options?.overwrite === false) {
						try {
							await fsp.stat(newUri.fsPath);
							throw new Error(`Target exists: ${newUri.fsPath}`);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
								throw error;
							}
						}
					}

					await fsp.mkdir(path.dirname(newUri.fsPath), { recursive: true });
					await fsp.rename(oldUri.fsPath, newUri.fsPath);
				},
			},
			createFileSystemWatcher: () => ({
				onDidCreate: () => createDisposable(),
				onDidChange: () => createDisposable(),
				onDidDelete: () => createDisposable(),
				dispose() { },
			}),
		},
		env: {
			language: 'en',
		},
	};
}

async function importStorageService() {
	(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return createVsCodeMock();
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		return await import('../src/services/storageService.js');
	} finally {
		(Module as any)._load = originalLoad;
	}
}

function createTempWorkspace(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-context-files-'));
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	await fsp.writeFile(filePath, content, 'utf-8');
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fsp.readFile(filePath, 'utf-8')) as Record<string, unknown>;
}

async function seedPrompt(
	workspaceRoot: string,
	promptId: string,
	contextFiles: string[],
): Promise<string> {
	const promptDir = path.join(workspaceRoot, '.vscode', 'prompt-manager', promptId);
	await writeTextFile(path.join(promptDir, 'config.json'), JSON.stringify({
		id: promptId,
		promptUuid: `uuid-${promptId}`,
		title: promptId,
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
		contextFiles,
		httpExamples: '',
		chatSessionIds: [],
		timeSpentWriting: 0,
		timeSpentImplementing: 0,
		timeSpentOnTask: 0,
		timeSpentUntracked: 0,
		notes: '',
		customGroupIds: [],
		createdAt: '2026-04-19T00:00:00.000Z',
		updatedAt: '2026-04-19T00:00:00.000Z',
	}, null, 2));
	await writeTextFile(path.join(promptDir, 'prompt.md'), '# Prompt\n');
	await writeTextFile(path.join(promptDir, 'report.txt'), '');
	await fsp.mkdir(path.join(promptDir, 'context'), { recursive: true });
	return promptDir;
}

test('getPrompt repairs stale prompt-local context file references after prompt rename', async () => {
	const { StorageService } = await importStorageService();
	const workspaceRoot = createTempWorkspace();

	try {
		const promptId = '87-dashboard-memory';
		const promptDir = await seedPrompt(workspaceRoot, promptId, [
			'.vscode/prompt-manager/old-memory/context/first.png',
			'assets/reference.png',
			'.vscode/prompt-manager/legacy-memory/context/nested/second.png',
		]);
		await writeTextFile(path.join(workspaceRoot, 'assets', 'reference.png'), 'ref');
		await writeTextFile(path.join(promptDir, 'context', 'first.png'), 'first');
		await writeTextFile(path.join(promptDir, 'context', 'nested', 'second.png'), 'second');

		const service = new (StorageService as any)(workspaceRoot);
		const prompt = await service.getPrompt(promptId);

		assert.ok(prompt, 'prompt should be loaded');
		assert.deepEqual(prompt.contextFiles, [
			`.vscode/prompt-manager/${promptId}/context/first.png`,
			'assets/reference.png',
			`.vscode/prompt-manager/${promptId}/context/nested/second.png`,
		]);

		const savedConfig = await readJson(path.join(promptDir, 'config.json'));
		assert.deepEqual(savedConfig.contextFiles, prompt.contextFiles);
	} finally {
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});

test('savePrompt rewrites prompt-local context file references when prompt id changes', async () => {
	const { StorageService } = await importStorageService();
	const workspaceRoot = createTempWorkspace();

	try {
		const oldId = 'draft-memory-dashboard';
		const newId = '87-memory-dashboard';
		const oldPromptDir = await seedPrompt(workspaceRoot, oldId, [
			`.vscode/prompt-manager/${oldId}/context/first.png`,
			'assets/reference.png',
		]);
		await writeTextFile(path.join(workspaceRoot, 'assets', 'reference.png'), 'ref');
		await writeTextFile(path.join(oldPromptDir, 'context', 'first.png'), 'first');

		const service = new (StorageService as any)(workspaceRoot);
		const prompt = await service.getPrompt(oldId);

		assert.ok(prompt, 'prompt should be loaded before rename');
		prompt.id = newId;
		prompt.title = 'Memory dashboard';

		const saved = await service.savePrompt(prompt, {
			previousId: oldId,
			skipHistory: true,
		});

		assert.equal(saved.id, newId);
		assert.deepEqual(saved.contextFiles, [
			`.vscode/prompt-manager/${newId}/context/first.png`,
			'assets/reference.png',
		]);
		assert.equal(fs.existsSync(oldPromptDir), false);

		const newPromptDir = path.join(workspaceRoot, '.vscode', 'prompt-manager', newId);
		assert.equal(fs.existsSync(path.join(newPromptDir, 'context', 'first.png')), true);

		const savedConfig = await readJson(path.join(newPromptDir, 'config.json'));
		assert.deepEqual(savedConfig.contextFiles, saved.contextFiles);
	} finally {
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});

test('savePrompt keeps same-id saves on direct identity path before uuid list scan', async () => {
	const { StorageService } = await importStorageService();
	const workspaceRoot = createTempWorkspace();

	try {
		const promptId = 'status-save-existing-prompt';
		await seedPrompt(workspaceRoot, promptId, []);

		const service = new (StorageService as any)(workspaceRoot);
		const prompt = await service.getPrompt(promptId);
		assert.ok(prompt, 'prompt should be loaded before save');

		service.findPromptLocationByUuid = async () => {
			throw new Error('same-id save should not scan all prompt configs by uuid');
		};

		prompt.status = 'completed';
		const saved = await service.savePrompt(prompt, { skipHistory: true });

		assert.equal(saved.id, promptId);
		assert.equal(saved.status, 'completed');
	} finally {
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});

test('savePrompt skips unchanged content and report files for status-only saves', async () => {
	const { StorageService } = await importStorageService();
	const workspaceRoot = createTempWorkspace();

	try {
		const promptId = 'status-only-file-write-skip';
		await seedPrompt(workspaceRoot, promptId, []);

		const service = new (StorageService as any)(workspaceRoot);
		const prompt = await service.getPrompt(promptId);
		assert.ok(prompt, 'prompt should be loaded before save');

		vscodeFsWritePaths.length = 0;
		vscodeFsStatPaths.length = 0;
		vscodeFsReadPaths.length = 0;
		const existingPrompt = { ...prompt };
		prompt.status = 'completed';
		await service.savePrompt(prompt, { skipHistory: true, existingPrompt });
		const storedConfig = await readJson(path.join(
			workspaceRoot,
			'.vscode/prompt-manager',
			promptId,
			'config.json',
		));

		assert.equal(vscodeFsWritePaths.some(filePath => filePath.endsWith('/prompt.md')), false);
		assert.equal(vscodeFsWritePaths.some(filePath => filePath.endsWith('/report.txt')), false);
		assert.equal(vscodeFsWritePaths.some(filePath => filePath.endsWith('/config.json')), false);
		assert.equal(vscodeFsStatPaths.some(filePath => filePath.endsWith('/report.txt')), false);
		assert.equal(vscodeFsStatPaths.some(filePath => filePath.endsWith('/context')), false);
		assert.equal(vscodeFsReadPaths.some(filePath => filePath.endsWith('/config.json')), false);
		assert.equal(storedConfig.status, 'completed');
	} finally {
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});

/** Создаёт изолированное хранилище с явно ожидаемыми фоновыми записями. */
async function createTimeSaveFixture(t: TestContext) {
	const { StorageService } = await importStorageService();
	const workspaceRoot = createTempWorkspace();
	const service = new (StorageService as any)(workspaceRoot);
	const tasks: Array<() => Promise<void>> = [];
	// Не запускаем таймеры: дневной учёт и очистка выполняются по команде теста.
	service.scheduleBackgroundStorageTask = (task: () => Promise<void>) => { tasks.push(task); };
	// Запись файлового кэша также должна завершиться до удаления временного каталога.
	const writeListCacheFile = service.writeListCacheFile.bind(service);
	service.writeListCacheFile = async (configs: unknown[]) => {
		tasks.push(() => writeListCacheFile(configs));
	};
	/** Выполняет все отложенные записи, включая добавленные во время ожидания. */
	const flush = async () => {
		while (tasks.length > 0) {
			await tasks.shift()!();
		}
	};
	// Очистка гарантирована и при падении проверки; незавершённых записей не оставляем.
	t.after(async () => {
		try {
			await flush();
		} finally {
			service.dispose();
			fs.rmSync(workspaceRoot, { recursive: true, force: true });
		}
	});
	return { service, workspaceRoot, flush };
}

// Проверяем оба пути записи, смену каталога и сочетание переименования с архивированием.
for (const scenario of [
	{ name: 'async content save', content: true, rename: false, archived: false },
	{ name: 'sync status-only save', content: false, rename: false, archived: false },
	{ name: 'rename', content: false, rename: true, archived: false },
	{ name: 'archive', content: false, rename: false, archived: true },
	{ name: 'rename and archive', content: true, rename: true, archived: true },
]) {
	/** Устаревший ноль не затирает время с диска и не начисляет его повторно за день. */
	test(`savePrompt preserves persisted implementing time with stale existingPrompt: ${scenario.name}`, async t => {
		const { service, workspaceRoot, flush } = await createTimeSaveFixture(t);
		const oldId = 'time-save-existing';
		const oldDir = await seedPrompt(workspaceRoot, oldId, []);
		const existingPrompt = await service.getPrompt(oldId);
		assert.ok(existingPrompt);
		service._listCache = [{ ...existingPrompt }];

		// Файл обновлён после загрузки снимка; дневное время уже учтено в прошлом дне.
		const persistedTime = 120_000;
		const dailyTime = { '2026-01-01': { writing: 0, implementing: persistedTime, onTask: 0, untracked: 0 } };
		await writeTextFile(path.join(oldDir, 'config.json'), JSON.stringify({
			...await readJson(path.join(oldDir, 'config.json')),
			timeSpentImplementing: persistedTime,
		}));
		await writeTextFile(path.join(oldDir, 'daily-time.json'), JSON.stringify(dailyTime));
		const prompt = {
			...existingPrompt,
			id: scenario.rename ? 'time-save-renamed' : oldId,
			archived: scenario.archived,
			status: 'completed',
			content: scenario.content ? '# Changed\n' : existingPrompt.content,
		};
		vscodeFsReadPaths.length = 0;
		vscodeFsWritePaths.length = 0;
		const saved = await service.savePrompt(prompt, { existingPrompt, previousId: oldId, skipHistory: true });
		const finalDir = path.join(workspaceRoot, '.vscode/prompt-manager',
			...(scenario.archived ? ['archive'] : []), prompt.id);

		// Проверяем входной объект, результат, конфигурацию и быстрый путь без чтения через VS Code.
		assert.equal(prompt.timeSpentImplementing, persistedTime);
		assert.equal(saved.timeSpentImplementing, persistedTime);
		assert.equal(saved.status, 'completed');
		assert.equal(saved.archived, scenario.archived);
		assert.equal((await readJson(path.join(finalDir, 'config.json'))).timeSpentImplementing, persistedTime);
		assert.equal(await fsp.readFile(path.join(finalDir, 'prompt.md'), 'utf-8'), prompt.content);
		assert.equal(vscodeFsReadPaths.some(filePath => filePath.endsWith('/config.json')), false);
		assert.equal(vscodeFsWritePaths.includes(path.join(finalDir, 'config.json')),
			scenario.content || scenario.rename || scenario.archived);
		if (scenario.rename || scenario.archived) {
			assert.equal(fs.existsSync(oldDir), false);
		}

		// Архив исключается из списка; в остальных случаях обновляется запись нового идентификатора.
		assert.deepEqual(service._listCache.map((entry: { id: string; timeSpentImplementing: number }) =>
			[entry.id, entry.timeSpentImplementing]), scenario.archived ? [] : [[prompt.id, persistedTime]]);
		await flush();
		assert.deepEqual(await readJson(path.join(finalDir, 'daily-time.json')), dailyTime);
		assert.deepEqual(JSON.parse(await fsp.readFile(
			path.join(workspaceRoot, '.vscode/prompt-manager/prompt-list.json'), 'utf-8')), service._listCache);
	});
}

// Положительное значение является явным обновлением, а не попыткой сброса времени.
for (const incomingTime of [30_000, 180_000]) {
	/** Разрешает как уменьшение, так и увеличение ранее сохранённого времени. */
	test(`savePrompt accepts positive implementing time ${incomingTime}`, async t => {
		const { service, workspaceRoot, flush } = await createTimeSaveFixture(t);
		const promptDir = await seedPrompt(workspaceRoot, 'positive-time', []);
		const existingPrompt = await service.getPrompt('positive-time');
		assert.ok(existingPrompt);
		service._listCache = [{ ...existingPrompt }];
		// На диске значение отличается и от снимка, и от нового явного значения.
		await writeTextFile(path.join(promptDir, 'config.json'), JSON.stringify({
			...await readJson(path.join(promptDir, 'config.json')), timeSpentImplementing: 120_000,
		}));
		const saved = await service.savePrompt({ ...existingPrompt, timeSpentImplementing: incomingTime },
			{ existingPrompt, skipHistory: true });
		await flush();
		assert.equal(saved.timeSpentImplementing, incomingTime);
		assert.equal((await readJson(path.join(promptDir, 'config.json'))).timeSpentImplementing, incomingTime);
		assert.equal(service._listCache[0].timeSpentImplementing, incomingTime);
	});
}

// Новый каталог не должен наследовать накопленное время исходного промпта.
for (const duplicate of [false, true]) {
	/** Сохраняет ноль при создании нового промпта и при штатном копировании. */
	test(`savePrompt keeps zero implementing time for ${duplicate ? 'duplicate' : 'new prompt'}`, async t => {
		const { service, workspaceRoot, flush } = await createTimeSaveFixture(t);
		const sourceDir = await seedPrompt(workspaceRoot, 'time-source', []);
		await writeTextFile(path.join(sourceDir, 'config.json'), JSON.stringify({
			...await readJson(path.join(sourceDir, 'config.json')), timeSpentImplementing: 120_000,
		}));
		const source = await service.getPrompt('time-source');
		assert.ok(source);
		service._listCache = [{ ...source }];
		const saved = duplicate
			? await service.duplicatePrompt(source.id, 'time-new')
			: await service.savePrompt({ ...source, id: 'time-new', promptUuid: '', timeSpentImplementing: 0 },
				{ existingPrompt: null, skipHistory: true });
		await flush();
		assert.ok(saved);
		assert.equal(saved.id, 'time-new');
		assert.notEqual(saved.promptUuid, source.promptUuid);
		assert.equal(saved.timeSpentImplementing, 0);
		assert.equal((await readJson(path.join(workspaceRoot,
			'.vscode/prompt-manager/time-new/config.json'))).timeSpentImplementing, 0);
		assert.equal(service._listCache.find((entry: { id: string }) => entry.id === saved.id).timeSpentImplementing, 0);
		assert.equal((await readJson(path.join(sourceDir, 'config.json'))).timeSpentImplementing, 120_000);
	});
}

/** Копия и импорт не должны управлять Claude-разговором исходной задачи. */
test('duplicate and import preserve Claude target without inheriting its session binding', async t => {
	const { service, workspaceRoot, flush } = await createTimeSaveFixture(t);
	const sourceDir = await seedPrompt(workspaceRoot, 'claude-source', []);
	const state = { sessions: [{ sessionId: '11111111-1111-4111-8111-111111111111',
		projectPath: workspaceRoot, accountedMs: 200 }] };
	await writeTextFile(path.join(sourceDir, 'config.json'), JSON.stringify({
		...await readJson(path.join(sourceDir, 'config.json')), chatTarget: 'claude', claudeChat: state,
	}));
	const copy = await service.duplicatePrompt('claude-source', 'claude-copy');
	const imported = await service.importPrompt(sourceDir);
	await flush();
	for (const prompt of [copy, imported]) {
		assert.ok(prompt);
		assert.equal(prompt.chatTarget, 'claude');
		assert.equal(prompt.claudeChat, undefined);
	}
	assert.deepEqual((await readJson(path.join(sourceDir, 'config.json'))).claudeChat, state);
});

/** Повреждённая конфигурация не должна молча заменяться устаревшим нулём. */
test('savePrompt rejects malformed persisted config when incoming implementing time is zero', async t => {
	const { service, workspaceRoot } = await createTimeSaveFixture(t);
	const promptDir = await seedPrompt(workspaceRoot, 'malformed-time', []);
	const existingPrompt = await service.getPrompt('malformed-time');
	assert.ok(existingPrompt);
	await writeTextFile(path.join(promptDir, 'config.json'), '{broken');
	await assert.rejects(service.savePrompt({ ...existingPrompt, status: 'completed' },
		{ existingPrompt, skipHistory: true }), SyntaxError);
	assert.equal(await fsp.readFile(path.join(promptDir, 'config.json'), 'utf-8'), '{broken');
});

/** Выбор экспортирует метаданные и абсолютный путь, сохраняя строковый номер без чтения содержимого. */
test('saveActiveTask writes selected metadata without reading prompt content', async t => {
	const { service, workspaceRoot } = await createTimeSaveFixture(t);
	const promptDir = await seedPrompt(workspaceRoot, 'selected', []);
	await writeTextFile(path.join(promptDir, 'config.json'), JSON.stringify({
		id: 'stale-folder', promptUuid: 'uuid-selected', taskNumber: 'TASK-007', title: 'Название задачи',
		content: 'private content', notes: 'private notes',
	}));
	vscodeFsReadPaths.length = 0;
	await service.saveActiveTask('selected');
	assert.deepEqual(await readJson(path.join(service.getStorageDirectoryPath(), 'task-active.json')), {
		id: 'selected', promptUuid: 'uuid-selected', taskNumber: 'TASK-007', title: 'Название задачи', archived: false,
		promptDirectory: promptDir,
	});
	assert.deepEqual(vscodeFsReadPaths, [path.join(promptDir, 'config.json')]);
	assert.equal((await fsp.readdir(service.getStorageDirectoryPath())).some(name => name.endsWith('.tmp')), false);
});

/** Архив, переименование и полный путь определяются по фактическому каталогу и стабильному UUID. */
test('saveActiveTask resolves renamed archived prompts and empty task numbers', async t => {
	const { service, workspaceRoot } = await createTimeSaveFixture(t);
	const promptDir = await seedPrompt(workspaceRoot, 'renamed', []);
	const archiveDir = path.join(service.getStorageDirectoryPath(), 'archive');
	await fsp.mkdir(archiveDir);
	await fsp.rename(promptDir, path.join(archiveDir, 'renamed'));
	await service.saveActiveTask('old-name', 'uuid-renamed');
	assert.deepEqual(await readJson(path.join(service.getStorageDirectoryPath(), 'task-active.json')), {
		id: 'renamed', promptUuid: 'uuid-renamed', taskNumber: '', title: 'renamed', archived: true,
		promptDirectory: path.join(archiveDir, 'renamed'),
	});
});

/** Ошибочный путь, отсутствующая задача и повреждённая конфигурация не заменяют корректный снимок. */
test('saveActiveTask preserves previous selection for invalid or missing prompts', async t => {
	const { service, workspaceRoot } = await createTimeSaveFixture(t);
	const promptDir = await seedPrompt(workspaceRoot, 'selected', []);
	const targetPath = path.join(service.getStorageDirectoryPath(), 'task-active.json');
	await service.saveActiveTask('selected');
	const expected = await readJson(targetPath);
	for (const id of ['missing', '../selected', '..\\selected', '.', 'archive']) {
		await service.saveActiveTask(id);
		assert.deepEqual(await readJson(targetPath), expected);
	}
	await writeTextFile(path.join(promptDir, 'config.json'), '{broken');
	await service.saveActiveTask('selected');
	assert.deepEqual(await readJson(targetPath), expected);
	// Новый несохранённый промпт и снятое выделение не оставляют номер предыдущей задачи.
	for (const id of ['__new__', null]) {
		await service.saveActiveTask(id);
		assert.equal(await readJson(targetPath), null);
	}
});

/** Позднее завершение записи не публикует устаревший выбор поверх более нового. */
test('saveActiveTask keeps the latest selection during delayed writes', async t => {
	const { service, workspaceRoot } = await createTimeSaveFixture(t);
	await seedPrompt(workspaceRoot, 'first', []);
	await seedPrompt(workspaceRoot, 'last', []);
	// Управляем только первой временной записью, без таймеров и фоновой работы после теста.
	const writeFile = fs.promises.writeFile;
	let release!: () => void;
	let started!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const writing = new Promise<void>(resolve => { started = resolve; });
	let firstWrite = true;
	t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
		if (firstWrite) {
			firstWrite = false;
			started();
			await blocked;
		}
		return writeFile(...args);
	});
	const first = service.saveActiveTask('first');
	await writing;
	const last = service.saveActiveTask('last');
	release();
	await Promise.all([first, last]);
	assert.equal((await readJson(path.join(service.getStorageDirectoryPath(), 'task-active.json'))).id, 'last');
	assert.equal((await fsp.readdir(service.getStorageDirectoryPath())).some(name => name.endsWith('.tmp')), false);
});

/** Неудачная атомарная замена сохраняет прежний JSON, удаляет временный файл и не ломает очередь. */
test('saveActiveTask recovers after a failed atomic replacement', async t => {
	const { service, workspaceRoot } = await createTimeSaveFixture(t);
	await seedPrompt(workspaceRoot, 'first', []);
	await seedPrompt(workspaceRoot, 'last', []);
	const targetPath = path.join(service.getStorageDirectoryPath(), 'task-active.json');
	await service.saveActiveTask('first');
	const rename = t.mock.method(fs.promises, 'rename', async () => { throw new Error('write denied'); });
	await service.saveActiveTask('last');
	assert.equal((await readJson(targetPath)).id, 'first');
	assert.equal((await fsp.readdir(service.getStorageDirectoryPath())).some(name => name.endsWith('.tmp')), false);
	rename.mock.restore();
	await service.saveActiveTask('last');
	assert.equal((await readJson(targetPath)).id, 'last');
});

/** Восстановление выделения создаёт снимок, но не отменяет даже ещё не завершённый явный выбор. */
test('saveActiveTask restores initial selection only before explicit requests', async t => {
	const { service, workspaceRoot } = await createTimeSaveFixture(t);
	await seedPrompt(workspaceRoot, 'restored', []);
	await seedPrompt(workspaceRoot, 'selected', []);
	const targetPath = path.join(service.getStorageDirectoryPath(), 'task-active.json');
	await service.saveActiveTask('restored', undefined, { onlyIfUnset: true });
	assert.equal((await readJson(targetPath)).id, 'restored');
	const selected = service.saveActiveTask('selected');
	const lateRestore = service.saveActiveTask('restored', undefined, { onlyIfUnset: true });
	await Promise.all([selected, lateRestore]);
	assert.equal((await readJson(targetPath)).id, 'selected');
});

/** Управляемая пауза воспроизводит порядок файловых событий без зависимости от скорости диска. */
function createStorageGate() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

/** Два экземпляра используют общую временную папку, имитируя локальное окно и туннель. */
async function createSharedStorageFixture(t: TestContext, ids = ['old-title']) {
	const { StorageService } = await importStorageService();
	const root = createTempWorkspace();
	for (const id of ids) { await seedPrompt(root, id, []); }
	const local = new StorageService(root);
	const remote = new StorageService(root);
	t.after(async () => {
		local.dispose();
		remote.dispose();
		await Promise.all([(local as any).listCacheWriteQueue, (remote as any).listCacheWriteQueue]);
		await fsp.rm(root, { recursive: true, force: true });
	});
	await Promise.all([local.listPrompts(), remote.listPrompts()]);
	const configUri = (id: string) => ({ fsPath: path.join(root, '.vscode', 'prompt-manager', id, 'config.json') });
	return { root, local, remote, configUri };
}

/** Запоздавшие операции второго окна не восстанавливают прежнее имя и не перезаписывают другой промпт. */
test('stale saves after rename preserve the single completed prompt and a reused slug', async t => {
	const { local, remote, configUri } = await createSharedStorageFixture(t);
	const old = (await local.getPrompt('old-title'))!;
	const finalId = 'tre-137-with-schedule';
	await remote.savePrompt({ ...old, id: finalId, status: 'completed', content: 'final content', report: 'final report' },
		{ previousId: old.id, skipHistory: true });
	await assert.rejects(local.savePrompt({ ...old, id: 'tre-137-and-schedule' }, { previousId: old.id, existingPrompt: null }));
	await assert.rejects(local.savePrompt({ ...old, content: 'stale edit' }, { existingPrompt: old }));
	const other = await remote.savePrompt({ ...old, promptUuid: 'other-uuid', content: 'other content' });
	assert.equal(other.id, old.id);
	await assert.rejects(local.savePrompt({ ...old, id: 'stale-rename' }, { previousId: old.id, existingPrompt: old }));
	await local.saveActiveTask(old.id, old.promptUuid);
	assert.equal((await readJson(path.join(local.getStorageDirectoryPath(), 'task-active.json'))).id, finalId);
	assert.equal((await remote.getPrompt(old.id))?.content, 'other content');
	assert.equal((await readJson(configUri(finalId).fsPath)).status, 'completed');
	assert.equal((await remote.getPrompt(finalId))?.report, 'final report');
	const rows = await local.listPrompts({ forceRefresh: true });
	assert.deepEqual(rows.filter(row => row.promptUuid === old.promptUuid).map(row => row.id), [finalId]);
});

/** Два одновременных первых сохранения одного UUID с разными заголовками создают только одну задачу. */
test('simultaneous first saves with different titles cannot duplicate a UUID', async t => {
	const { local, remote } = await createSharedStorageFixture(t);
	const template = (await local.getPrompt('old-title'))!;
	const results = await Promise.allSettled([local, remote].map((service, i) => service.savePrompt({
		...template, id: 'new-title-' + i, promptUuid: 'new-prompt-uuid',
	}, { existingPrompt: null, skipHistory: true })));
	assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
	const rows = await local.listPrompts({ forceRefresh: true });
	assert.equal(rows.filter(row => row.promptUuid === 'new-prompt-uuid').length, 1);
});

/** Publishing through a temporary directory must preserve normal access to prompts and their files. */
for (const mode of [0o2770, 0o700]) {
	test(`new and imported prompts inherit storage permissions for mode ${mode.toString(8)}`,
		{ skip: process.platform === 'win32' }, async t => {
			const { local, configUri } = await createSharedStorageFixture(t);
			const root = local.getStorageDirectoryPath();
			await fsp.chmod(root, mode);
			const reference = path.join(root, 'reference');
			await fsp.mkdir(reference);
			await fsp.writeFile(path.join(reference, 'sample'), '');
			const source = (await local.getPrompt('old-title'))!;
			const saved = await local.savePrompt({ ...source, id: 'new-title', promptUuid: 'uuid-new' });
			const imported = await local.importPrompt(path.dirname(configUri(source.id).fsPath));
			assert.ok(imported);
			const publishedIds: string[] = [saved.id, imported.id];
			for (const relative of ['', 'config.json']) {
				const expected = await fsp.stat(relative ? path.join(reference, 'sample') : reference);
				for (const id of publishedIds) {
					const actual = await fsp.stat(path.join(root, id, relative));
					assert.equal(actual.mode & 0o7777, expected.mode & 0o7777);
					assert.equal(actual.gid, expected.gid);
				}
			}
		});
}

/** Readers must discover new prompts through the final rename even when a second window refreshes mid-save. */
test('staged saves and imports stay out of prompt lookup and watchers until published', async t => {
	const { local, remote, configUri } = await createSharedStorageFixture(t);
	const root = local.getStorageDirectoryPath();
	const source = (await local.getPrompt('old-title'))!;
	const rename = fs.promises.rename;
	const publications: string[] = [];
	t.mock.method(fs.promises, 'rename', async (...args: Parameters<typeof rename>) => {
		const [from, to] = args.map(String);
		if (path.dirname(to) === root && ['new-title', 'old-title-1'].includes(path.basename(to))) {
			const stagedConfig = path.join(from, 'config.json');
			const { promptUuid } = await readJson(stagedConfig);
			assert.equal(typeof promptUuid, 'string');
			assert.equal((await remote.listPrompts({ forceRefresh: true })).some(row => row.promptUuid === promptUuid), false);
			assert.equal(await remote.getPromptByUuid(promptUuid as string), null);
			assert.equal((remote as any).resolvePromptStorageFilePathDetails({ fsPath: stagedConfig }, 'config.json'), null);
			publications.push(path.basename(to));
		}
		return rename(...args);
	});
	await local.savePrompt({ ...source, id: 'new-title', promptUuid: 'uuid-new' });
	await local.importPrompt(path.dirname(configUri(source.id).fsPath));
	assert.deepEqual(publications, ['new-title', 'old-title-1']);
	assert.equal(await local.importPrompt(root), null);
});

/** После сбоя записи первого черновика тот же slug можно сохранить повторно без следов частичного каталога. */
test('failed first save can retry under its original slug', async t => {
	const { local } = await createSharedStorageFixture(t);
	const source = (await local.getPrompt('old-title'))!;
	const draft = { ...source, id: 'first-save', promptUuid: 'first-save-uuid' };
	const mkdir = fs.promises.mkdir;
	const failing = t.mock.method(fs.promises, 'mkdir', async (...args: Parameters<typeof mkdir>) => {
		if (String(args[0]).endsWith(path.sep + 'context')) { throw new Error('context write failed'); }
		return mkdir(...args);
	});
	await assert.rejects(local.savePrompt(draft), /context write failed/);
	failing.mock.restore();
	assert.equal(await local.exists(draft.id), false);
	assert.equal((await local.savePrompt(draft)).id, draft.id);
});

/** При перемещении в архив отложенные операции и устаревшее окно не воссоздают активный черновик. */
test('archiving and renaming retains delayed history and daily time in the archived folder', async t => {
	const { local, remote } = await createSharedStorageFixture(t);
	const old = (await local.getPrompt('old-title'))!;
	const background: Array<() => Promise<void>> = [];
	(local as any).scheduleBackgroundStorageTask = (run: () => Promise<void>) => background.push(run);
	const saved = await local.savePrompt({ ...old, content: 'updated text', timeSpentWriting: 100 });
	await remote.savePrompt({ ...saved, id: 'archived-title', archived: true, status: 'completed' },
		{ previousId: saved.id, skipHistory: true });
	await assert.rejects(local.savePrompt({ ...saved, content: 'stale' }, { existingPrompt: saved }));
	for (const run of background) { await run(); }
	assert.equal(await local.exists(old.id), false);
	assert.equal((await local.listPromptHistory('archived-title')).length, 1);
	assert.equal(Object.values(await local.getDailyTime('archived-title'))[0].writing, 100);
	const archived = (await remote.getPrompt('archived-title'))!;
	assert.equal(archived.content, 'updated text');
	assert.equal(archived.status, 'completed');
});

/** Импорт публикует ровно одну самостоятельную копию с вложениями и отдельным UUID. */
test('import leaves only the original UUID and one independent imported copy', async t => {
	const { local, configUri } = await createSharedStorageFixture(t);
	const sourceDir = path.dirname(configUri('old-title').fsPath);
	await writeTextFile(path.join(sourceDir, 'context', 'example.md'), 'attached');
	const snapshot = (await local.getPrompt('old-title'))!;
	await writeTextFile(path.join(sourceDir, 'history', 'historical.json'), JSON.stringify({
		id: 'historical', promptId: snapshot.id, createdAt: snapshot.createdAt, reason: 'manual',
		prompt: { ...snapshot, content: 'restored content' },
	}));
	const imported = await local.importPrompt(sourceDir);
	assert.ok(imported);
	assert.equal(imported.id, 'old-title-1');
	assert.notEqual(imported.promptUuid, 'uuid-old-title');
	assert.equal(await fsp.readFile(path.join(local.getPromptDirectoryPath(imported.id), 'context', 'example.md'), 'utf8'), 'attached');
	const restored = await local.restorePromptHistory(imported.id, 'historical');
	assert.equal(restored?.promptUuid, imported.promptUuid);
	assert.equal(restored?.content, 'restored content');
	assert.equal((await local.getPrompt('old-title'))?.content, snapshot.content);
	const rows = await local.listPrompts({ forceRefresh: true });
	assert.equal(rows.length, 2);
	assert.equal(new Set(rows.map(row => row.promptUuid)).size, 2);
});

/** Imported history may restore content but only the copy owns its current Claude session binding. */
test('restoring imported history preserves the current Claude binding or its absence', async t => {
	const { local, root, configUri } = await createSharedStorageFixture(t);
	const source = (await local.getPrompt('old-title'))!;
	const sourceDir = path.dirname(configUri(source.id).fsPath);
	const sourceSession = { sessionId: '11111111-1111-4111-8111-111111111111', projectPath: root, accountedMs: 200 };
	await writeTextFile(path.join(sourceDir, 'history', 'source-revision.json'), JSON.stringify({
		id: 'source-revision', promptId: source.id, createdAt: source.createdAt, reason: 'manual',
		prompt: { ...source, chatTarget: 'claude', content: 'previous text', claudeChat: { sessions: [sourceSession] } },
	}));
	const imported = (await local.importPrompt(sourceDir))!;
	const restored = await local.restorePromptHistory(imported.id, 'source-revision');
	assert.ok(restored);
	assert.equal(restored.content, 'previous text');
	assert.equal(restored.claudeChat, undefined);

	const ownBinding = { sessions: [{ ...sourceSession, sessionId: '22222222-2222-4222-8222-222222222222' }] };
	await local.savePrompt({ ...restored, content: 'another edit', claudeChat: ownBinding }, { skipHistory: true });
	const restoredAgain = await local.restorePromptHistory(imported.id, 'source-revision');
	assert.deepEqual(restoredAgain?.claudeChat, ownBinding);
	assert.equal(restoredAgain?.content, 'previous text');
});

/** Use the archived owner's history for throttling, deduplication and trimming after its name is reused. */
test('queued snapshots consult and trim only the archived prompt history under a reused id', async t => {
	const { local, remote, root, configUri } = await createSharedStorageFixture(t);
	const old = (await local.getPrompt('old-title'))!;
	const pending: Array<() => Promise<void>> = [];
	(local as any).scheduleBackgroundStorageTask = (run: () => Promise<void>) => pending.push(run);
	const first = await local.savePrompt({ ...old, content: 'first edit' }, { historyReason: 'autosave' });
	await local.savePrompt({ ...first, content: 'second edit' }, { historyReason: 'autosave' });
	await remote.archivePrompt(old.id);
	const archiveHistory = path.join(local.getStorageDirectoryPath(), 'archive', old.id, 'history');
	const activeDir = await seedPrompt(root, old.id, []);
	await writeTextFile(configUri(old.id).fsPath, JSON.stringify({ ...old, promptUuid: 'uuid-new-owner' }));
	const activeHistory = path.join(activeDir, 'history');
	const now = new Date().toISOString();
	for (let index = 0; index < 20; index++) {
		const id = '2000-' + String(index).padStart(2, '0');
		const entry = { id, promptId: old.id, createdAt: '2000-01-01T00:00:00.000Z', reason: 'manual' };
		await writeTextFile(path.join(archiveHistory, id + '.json'), JSON.stringify({
			...entry, prompt: { ...old, content: 'earlier archived content' },
		}));
		await writeTextFile(path.join(activeHistory, id + '.json'), JSON.stringify({
			...entry, createdAt: now, prompt: { ...old, promptUuid: 'uuid-new-owner' },
		}));
	}
	await writeTextFile(path.join(activeHistory, 'extra.json'), JSON.stringify({
		id: 'extra', promptId: old.id, createdAt: now, reason: 'manual', prompt: { ...old, promptUuid: 'uuid-new-owner' },
	}));
	const activeFiles = (await fsp.readdir(activeHistory)).sort();
	for (const run of pending) { await run(); }
	assert.deepEqual((await fsp.readdir(activeHistory)).sort(), activeFiles);
	const archiveFiles = await fsp.readdir(archiveHistory);
	assert.equal(archiveFiles.length, 20);
	assert.ok(!archiveFiles.includes('2000-00.json'));
	const captured = archiveFiles.filter(name => !name.startsWith('2000-'));
	assert.equal(captured.length, 1);
	const snapshot = JSON.parse(await fsp.readFile(path.join(archiveHistory, captured[0]), 'utf8'));
	assert.equal(snapshot.prompt.content, old.content);
	assert.equal(snapshot.prompt.promptUuid, old.promptUuid);
});

/** Select the history of the open archive even if a live prompt reuses its id and revision filenames. */
test('history selection restores the archived folder and rejects a later occupant', async t => {
	const { local, configUri } = await createSharedStorageFixture(t);
	const active = (await local.getPrompt('old-title'))!;
	const activeDir = path.dirname(configUri(active.id).fsPath);
	const archiveDir = path.join(local.getStorageDirectoryPath(), 'archive', active.id);
	await fsp.cp(activeDir, archiveDir, { recursive: true });
	const archived = { ...active, promptUuid: 'archive-owner', archived: true };
	await writeTextFile(path.join(archiveDir, 'config.json'), JSON.stringify(archived));
	for (const [dir, prompt] of [[activeDir, active], [archiveDir, archived]] as const) {
		const revision = {
			id: 'same-revision', promptId: prompt.id, createdAt: prompt.createdAt, reason: 'manual',
			prompt: { ...prompt, content: 'snapshot for ' + prompt.promptUuid },
		};
		await writeTextFile(path.join(dir, 'history', 'same-revision.json'), JSON.stringify(revision));
		await writeTextFile(path.join(dir, 'history', prompt.promptUuid + '.json'), JSON.stringify({
			...revision, id: prompt.promptUuid,
		}));
	}
	assert.deepEqual((await local.listPromptHistory(active.id, archived)).map(entry => entry.id).sort(),
		['archive-owner', 'same-revision']);
	const restored = await local.restorePromptHistory(active.id, 'same-revision', archived);
	assert.equal(restored?.content, 'snapshot for archive-owner');
	assert.equal(await fsp.readFile(path.join(archiveDir, 'prompt.md'), 'utf8'), restored?.content);
	assert.equal((await local.getPrompt(active.id))?.content, active.content);
	assert.equal((await local.listPrompts()).find(prompt => prompt.id === active.id)?.promptUuid, active.promptUuid);

	await writeTextFile(path.join(archiveDir, 'config.json'), JSON.stringify({ ...archived, promptUuid: 'next-owner' }));
	assert.deepEqual(await local.listPromptHistory(active.id, archived), []);
	assert.equal(await local.restorePromptHistory(active.id, 'same-revision', archived), null);
});

/** Поиск только по UUID возвращает результат лишь при единственной физической папке, включая архив. */
test('UUID lookup rejects ambiguous folders and resolves an archived prompt under a reused id', async t => {
	const { local, configUri } = await createSharedStorageFixture(t);
	const sourceDir = path.dirname(configUri('old-title').fsPath);
	const archiveDir = path.join(local.getStorageDirectoryPath(), 'archive', 'old-title');
	await fsp.cp(sourceDir, archiveDir, { recursive: true });
	assert.equal(await local.getPromptByUuid('uuid-old-title'), null);
	await writeTextFile(configUri('old-title').fsPath, JSON.stringify({ promptUuid: 'new-owner' }));
	assert.equal((await local.getPromptByUuid('uuid-old-title'))?.archived, true);
	await local.saveActiveTask('old-title', 'uuid-old-title');
	assert.equal((await readJson(path.join(local.getStorageDirectoryPath(), 'task-active.json'))).promptDirectory, archiveDir);
});

/** Отсутствующий после переименования родитель не создаётся при устаревшем чтении legacy report. */
test('delayed report backfill does not resurrect the previous prompt folder', async t => {
	const { local, configUri } = await createSharedStorageFixture(t);
	const oldDir = path.dirname(configUri('old-title').fsPath);
	await fsp.unlink(path.join(oldDir, 'report.txt'));
	const entered = createStorageGate(), resume = createStorageGate();
	const ensureReport = (local as any).ensurePromptReportFile.bind(local);
	(local as any).ensurePromptReportFile = async (...args: unknown[]) => {
		entered.resolve();
		await resume.promise;
		return ensureReport(...args);
	};
	const pending = local.getPrompt('old-title');
	await entered.promise;
	await fsp.rename(oldDir, path.dirname(configUri('renamed').fsPath));
	resume.resolve();
	await pending;
	assert.equal(fs.existsSync(oldDir), false);
});

/** A reader publishes a complete migration before the next window can commit its edit. */
test('config backfill and a concurrent save keep the complete newer JSON', async t => {
	const { local, remote, configUri } = await createSharedStorageFixture(t);
	const before = (await local.getPrompt('old-title'))!;
	const configPath = configUri(before.id).fsPath;
	const legacy = { ...await readJson(configPath), promptUuid: ` ${before.promptUuid} ` };
	await writeTextFile(configPath, JSON.stringify(legacy));
	const entered = createStorageGate(), resume = createStorageGate(), saving = createStorageGate();
	const rename = fs.promises.rename;
	t.mock.method(fs.promises, 'rename', async (...args: Parameters<typeof rename>) => {
		if (args[1] === configPath) { entered.resolve(); await resume.promise; }
		return rename(...args);
	});
	const lock = (remote as any).withPromptWriteLock.bind(remote);
	t.mock.method(remote as any, 'withPromptWriteLock', (...args: unknown[]) => {
		saving.resolve();
		return lock(...args);
	});
	const reading = local.getPrompt(before.id);
	await entered.promise;
	const title = 'longer title '.repeat(300);
	const writing = remote.savePrompt({ ...before, title }, { existingPrompt: before, skipHistory: true });
	try {
		await saving.promise;
		assert.deepEqual(await readJson(configPath), legacy);
	} finally { resume.resolve(); }
	await Promise.all([reading, writing]);
	assert.equal((await readJson(configPath)).title, title);
	assert.equal((await local.getPrompt(before.id))?.title, title);
});

/** A different writer may change the file after a reader decides it needs migration. */
test('config backfill returns a newer edit and rejects a replacement owner', async t => {
	const { local, configUri } = await createSharedStorageFixture(t);
	const configPath = configUri('old-title').fsPath;
	const before = await readJson(configPath);
	for (const owner of [before.promptUuid, 'new-owner']) {
		await writeTextFile(configPath, JSON.stringify({ ...before, promptUuid: ` ${before.promptUuid} ` }));
		const open = fs.promises.open;
		const mock = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof open>) => {
			if (args[0] === configPath && args[1] === 'r+') {
				await writeTextFile(configPath, JSON.stringify({ ...before, promptUuid: owner, title: 'Latest' }));
			}
			return open(...args);
		});
		const prompt = await local.getPrompt('old-title');
		mock.mock.restore();
		if (owner === before.promptUuid) { assert.equal(prompt?.title, 'Latest'); }
		else { assert.equal(prompt, null); }
		assert.equal((await readJson(configPath)).promptUuid, owner);
	}
});

/** A valid read-only legacy folder stays selectable across scans and editor opens. */
test('read-only legacy config retains its UUID, content and report without writing a migration', async t => {
	const { local, remote, configUri } = await createSharedStorageFixture(t);
	const configPath = configUri('old-title').fsPath;
	const legacy = await readJson(configPath);
	delete legacy.promptUuid;
	await writeTextFile(configPath, JSON.stringify(legacy));
	const directory = path.dirname(configPath);
	await fsp.rename(path.join(directory, 'report.txt'), path.join(directory, 'report.md'));
	await writeTextFile(path.join(directory, 'report.md'), 'Legacy report');
	const denied = Object.assign(new Error('read-only filesystem'), { code: 'EROFS' });
	const open = fs.promises.open;
	t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof open>) => {
		if (args[0] === configPath && args[1] === 'r+') { throw denied; }
		return open(...args);
	});
	const rows = await local.listPrompts({ forceRefresh: true });
	const viewed = await remote.getPrompt('old-title');
	assert.ok(viewed);
	assert.equal(rows.length, 1);
	assert.equal(viewed.promptUuid, rows[0].promptUuid);
	assert.equal(viewed.content, '# Prompt\n');
	assert.equal(viewed.report, 'Legacy report');
	assert.equal((await remote.getPromptByUuid(rows[0].promptUuid))?.content, viewed.content);
	const hoverTarget = { id: viewed.id, promptUuid: rows[0].promptUuid, archived: false };
	assert.deepEqual(await local.getPromptHoverPreview(hoverTarget), { state: 'ready', content: viewed.content });
	assert.deepEqual(await readJson(configPath), legacy);
});

/** Переименование сохраняет физическую папку; её прежнее имя может занять другой старый промпт. */
test('lookup and preview keep the read-only legacy owner after a folder name is reused',
	{ skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
		const { local, remote, configUri } = await createSharedStorageFixture(t);
		const configPath = configUri('old-title').fsPath;
		const legacy = await readJson(configPath);
		delete legacy.promptUuid;
		await writeTextFile(configPath, JSON.stringify(legacy));
		await fsp.chmod(configPath, 0o444);
		const [listed] = await local.listPrompts({ forceRefresh: true });
		const oldDir = path.dirname(configPath);
		const movedDir = path.dirname(configUri('moved').fsPath);
		await fsp.rename(oldDir, movedDir);
		await writeTextFile(configPath, JSON.stringify(legacy));
		await writeTextFile(path.join(oldDir, 'prompt.md'), 'Replacement');
		await fsp.chmod(configPath, 0o444);

		assert.equal((await remote.getPromptByUuid(listed.promptUuid))?.id, 'moved');
		const target = { id: 'old-title', promptUuid: listed.promptUuid, archived: false };
		assert.deepEqual(await local.getPromptHoverPreview(target), { state: 'missing' });
		assert.deepEqual(await local.getPromptHoverPreview({ ...target, id: 'moved' }), { state: 'ready', content: '# Prompt\n' });
		assert.deepEqual(await readJson(configPath), legacy);
		assert.deepEqual(await readJson(path.join(movedDir, 'config.json')), legacy);
	});

/** Запоздалый backfill старой конфигурации не создаёт каталог по прежнему slug. */
test('delayed config backfill never recreates a moved config', async t => {
	const { local, configUri } = await createSharedStorageFixture(t);
	const oldConfig = configUri('old-title').fsPath;
	const oldDir = path.dirname(oldConfig);
	await writeTextFile(oldConfig, JSON.stringify({ id: 'legacy', title: 'legacy' }));
	const entered = createStorageGate(), resume = createStorageGate();
	const open = fs.promises.open;
	t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof open>) => {
		if (args[0] === oldConfig && args[1] === 'r+') { entered.resolve(); await resume.promise; }
		return open(...args);
	});
	const pending = local.getPrompt('old-title');
	await entered.promise;
	await fsp.rename(oldDir, path.dirname(configUri('renamed').fsPath));
	resume.resolve();
	assert.equal(await pending, null);
	assert.equal(fs.existsSync(oldDir), false);
});

/** Истечение владения перехватывается внутри Promise сохранения до его первой записи. */
test('a compromised filesystem lock rejects save without an uncaught exception', async t => {
	const { local } = await createSharedStorageFixture(t);
	const source = (await local.getPrompt('old-title'))!;
	const lost = new Error('lock owner changed');
	const locks = require('proper-lockfile');
	t.mock.method(locks, 'lock', async (_key: string, options: { onCompromised: (error: Error) => void }) => {
		queueMicrotask(() => options.onCompromised(lost));
		return () => assert.fail('must not release the new owner lock');
	});
	await assert.rejects(local.savePrompt({ ...source, status: 'completed' }), lost);
	assert.equal((await local.getPrompt(source.id))?.status, 'draft');
});

/** Старое чтение не воскрешает папку после удаления и создания папки с номером. */
test('config watcher discards an old read after another instance renames the prompt', async t => {
	const { local, remote, configUri } = await createSharedStorageFixture(t);
	const entered = createStorageGate();
	const release = createStorageGate();
	t.after(() => release.resolve());
	const readConfig = (local as any).readConfig.bind(local);
	let delayed = false;
	(local as any).readConfig = async (...args: any[]) => {
		const config = await readConfig(...args);
		if (args[0] === 'old-title' && !delayed) {
			delayed = true; entered.resolve(); await release.promise;
		}
		return config;
	};
	const pendingRead = (local as any).handleWatchedPromptConfigChange(configUri('old-title'), 'changed');
	await entered.promise;
	const prompt = (await remote.getPrompt('old-title'))!;
	await remote.savePrompt({ ...prompt, id: '169-title', taskNumber: '169' }, { previousId: prompt.id, skipHistory: true });
	await (local as any).handleWatchedPromptConfigChange(configUri('old-title'), 'deleted');
	await (local as any).handleWatchedPromptConfigChange(configUri('169-title'), 'created');
	release.resolve();
	await pendingRead;
	assert.deepEqual((await local.listPrompts()).map(p => [p.id, p.taskNumber]), [['169-title', '169']]);
	assert.equal((await local.getPromptByUuid(prompt.promptUuid))?.id, '169-title');
});

/** Фоновый обход не заменяет результат сохранения снимком, собранным до переименования. */
test('background list scan cannot overwrite a newer prompt rename', async t => {
	const { local } = await createSharedStorageFixture(t, ['a-old', 'z-blocker']);
	const entered = createStorageGate();
	const release = createStorageGate();
	t.after(() => release.resolve());
	const readConfig = (local as any).readConfig.bind(local);
	(local as any).readConfig = async (...args: any[]) => {
		const config = await readConfig(...args);
		if (args[0] === 'z-blocker') { entered.resolve(); await release.promise; }
		return config;
	};
	const scan = (local as any)._runBackgroundRefresh();
	await entered.promise;
	const prompt = (await local.getPrompt('a-old'))!;
	await local.savePrompt({ ...prompt, id: '169-title', taskNumber: '169' }, { previousId: prompt.id, skipHistory: true });
	release.resolve();
	await scan;
	assert.deepEqual((await local.listPrompts()).map(p => p.id).sort(), ['169-title', 'z-blocker']);
	assert.equal((await local.getPromptByUuid(prompt.promptUuid))?.id, '169-title');
});

/** Старый кеш другого окна не должен мешать открытию существующего промпта по UUID. */
test('getPromptByUuid recovers a renamed directory before watcher delivery', async t => {
	const { local, remote } = await createSharedStorageFixture(t);
	const prompt = (await remote.getPrompt('old-title'))!;
	await remote.savePrompt({ ...prompt, id: '169-title', taskNumber: '169' }, { previousId: prompt.id, skipHistory: true });
	const found = await local.getPromptByUuid(prompt.promptUuid);
	assert.equal(found?.id, '169-title');
	assert.equal(found?.taskNumber, '169');
	assert.deepEqual((await local.listPrompts()).map(p => p.id), ['169-title']);
});

/** Окно подавления скрывает только собственные байты, а не запись другого экземпляра. */
test('config watcher accepts another instance write immediately after a local save', async t => {
	const { local, remote, configUri } = await createSharedStorageFixture(t);
	const prompt = (await local.getPrompt('old-title'))!;
	await local.savePrompt({ ...prompt, title: 'Local title' }, { skipHistory: true });
	assert.equal(await (local as any).shouldIgnoreWatchedPromptConfigChange(configUri(prompt.id)), true);
	const remotePrompt = (await remote.getPrompt(prompt.id))!;
	await remote.savePrompt({ ...remotePrompt, taskNumber: '169' }, { skipHistory: true });
	assert.equal(await (local as any).shouldIgnoreWatchedPromptConfigChange(configUri(prompt.id)), false);
	await (local as any).handleWatchedPromptConfigChange(configUri(prompt.id), 'changed');
	assert.equal((await local.listPrompts())[0].taskNumber, '169');
});

/** Несколько обновлений оставляют целый JSON с последним состоянием списка. */
test('overlapping list cache writes persist the newest complete snapshot', async t => {
	const { local, root } = await createSharedStorageFixture(t);
	const original = (await local.listPrompts())[0];
	await Promise.all([
		(local as any).writeListCache([{ ...original, taskNumber: 'old' }]),
		(local as any).writeListCache([{ ...original, taskNumber: '169' }]),
	]);
	const stored = JSON.parse(await fsp.readFile(path.join(root, '.vscode', 'prompt-manager', 'prompt-list.json'), 'utf-8'));
	assert.equal(stored[0].taskNumber, '169');
});

/** Кнопка обновления убирает старое имя и удалённые папки даже без файловых событий. */
test('forced list refresh replaces stale memory and disk cache with actual prompt directories', async t => {
	const { root, local, remote } = await createSharedStorageFixture(t, ['old-title', 'deleted-prompt']);
	const stale = await local.listPrompts();
	const prompt = (await remote.getPrompt('old-title'))!;
	await remote.savePrompt({ ...prompt, id: '169-title', taskNumber: '169' }, { previousId: prompt.id, skipHistory: true });
	await fsp.rm(path.join(root, '.vscode', 'prompt-manager', 'deleted-prompt'), { recursive: true });
	await seedPrompt(root, 'new-prompt', []);
	// Намеренно оставляем устаревшим и файл кеша, а не только снимок первого экземпляра.
	await (remote as any).listCacheWriteQueue;
	await (local as any).writeListCacheFile(stale);
	assert.deepEqual((await local.listPrompts()).map(p => p.id).sort(), ['deleted-prompt', 'old-title']);

	const actual = await local.listPrompts({ forceRefresh: true });
	assert.deepEqual(actual.map(p => p.id).sort(), ['169-title', 'new-prompt']);
	assert.equal(actual.find(p => p.promptUuid === prompt.promptUuid)?.taskNumber, '169');
	const savedCache = JSON.parse(await fsp.readFile(path.join(root, '.vscode', 'prompt-manager', 'prompt-list.json'), 'utf-8'));
	assert.deepEqual(savedCache.map((p: { id: string }) => p.id).sort(), ['169-title', 'new-prompt']);
	assert.equal((await local.getPromptByUuid(prompt.promptUuid))?.id, '169-title');
});

/** Обычный запрос, пришедший после ручного обновления, также получает восстановленный список. */
test('forced list refresh shares its scan with overlapping cached and manual requests', async t => {
	const { local, remote } = await createSharedStorageFixture(t);
	const prompt = (await remote.getPrompt('old-title'))!;
	await remote.savePrompt({ ...prompt, id: '169-title', taskNumber: '169' }, { previousId: prompt.id, skipHistory: true });
	const entered = createStorageGate();
	const release = createStorageGate();
	const readConfigs = (local as any).readPromptConfigsFromDirectory.bind(local);
	let scans = 0;
	(local as any).readPromptConfigsFromDirectory = async (...args: any[]) => {
		scans++; entered.resolve(); await release.promise;
		return readConfigs(...args);
	};
	const first = local.listPrompts({ forceRefresh: true });
	await entered.promise;
	const cached = local.listPrompts();
	const second = local.listPrompts({ forceRefresh: true });
	release.resolve();
	const results = await Promise.all([first, cached, second]);
	assert.equal(scans, 1);
	for (const result of results) { assert.deepEqual(result.map(p => p.id), ['169-title']); }
});

/** Принудительный проход отменяет ещё не завершившееся чтение удалённой папки. */
test('forced list refresh prevents a delayed watcher from restoring a phantom row', async t => {
	const { local, remote, configUri } = await createSharedStorageFixture(t);
	const entered = createStorageGate();
	const release = createStorageGate();
	const readConfig = (local as any).readConfig.bind(local);
	let delay = true;
	(local as any).readConfig = async (...args: any[]) => {
		const result = await readConfig(...args);
		if (delay) { delay = false; entered.resolve(); await release.promise; }
		return result;
	};
	const watcher = (local as any).handleWatchedPromptConfigChange(configUri('old-title'), 'changed');
	await entered.promise;
	const prompt = (await remote.getPrompt('old-title'))!;
	await remote.savePrompt({ ...prompt, id: '169-title', taskNumber: '169' }, { previousId: prompt.id, skipHistory: true });
	await local.listPrompts({ forceRefresh: true });
	release.resolve();
	await watcher;
	assert.deepEqual((await local.listPrompts()).map(p => p.id), ['169-title']);
});

/** Событие второго окна во время прохода требует перечитать изменившийся снимок. */
test('forced list refresh retries when a prompt changes during the disk scan', async t => {
	const { local, remote, configUri } = await createSharedStorageFixture(t);
	const entered = createStorageGate();
	const release = createStorageGate();
	const readConfigs = (local as any).readPromptConfigsFromDirectory.bind(local);
	let scans = 0;
	(local as any).readPromptConfigsFromDirectory = async (...args: any[]) => {
		const result = await readConfigs(...args);
		if (++scans === 1) { entered.resolve(); await release.promise; }
		return result;
	};
	const refresh = local.listPrompts({ forceRefresh: true });
	await entered.promise;
	const prompt = (await remote.getPrompt('old-title'))!;
	await remote.savePrompt({ ...prompt, taskNumber: '169' }, { skipHistory: true });
	const event = (local as any).handleWatchedPromptConfigChange(configUri(prompt.id), 'changed');
	release.resolve();
	const [actual] = await Promise.all([refresh, event]);
	assert.equal(scans, 2);
	assert.equal(actual[0].taskNumber, '169');
	assert.equal((await local.listPrompts())[0].taskNumber, '169');
});

/** Ошибка доступа не стирает кеш и не мешает следующему ручному обновлению. */
test('forced list refresh preserves cache after a directory read error and can retry', async t => {
	const { local, root } = await createSharedStorageFixture(t);
	const readConfigs = (local as any).readPromptConfigsFromDirectory.bind(local);
	const entered = createStorageGate();
	const release = createStorageGate();
	(local as any).readPromptConfigsFromDirectory = async (...args: any[]) => {
		entered.resolve(); await release.promise;
		// Читаем заведомо недопустимый путь реальным методом, чтобы проверить его обработку ошибки.
		return readConfigs(path.join(root, '.vscode', 'prompt-manager', 'old-title', 'config.json'), args[1], args[2]);
	};
	const failure = assert.rejects(local.listPrompts({ forceRefresh: true }), { code: 'ENOTDIR' });
	await entered.promise;
	const ordinaryRead = local.listPrompts();
	release.resolve();
	await failure;
	assert.deepEqual((await ordinaryRead).map(p => p.id), ['old-title']);
	assert.deepEqual((await local.listPrompts()).map(p => p.id), ['old-title']);
	(local as any).readPromptConfigsFromDirectory = readConfigs;
	assert.deepEqual((await local.listPrompts({ forceRefresh: true })).map(p => p.id), ['old-title']);
});

/** Перемещение в архив без watcher-события убирает строку из активных и сохраняет её в архиве. */
test('forced list refresh reconciles active prompts with archive moves from another instance', async t => {
	const { local, remote } = await createSharedStorageFixture(t);
	await remote.archivePrompt('old-title');
	const all = await local.listPrompts({ forceRefresh: true, includeArchived: true });
	assert.deepEqual(all.map(p => [p.id, p.archived]), [['old-title', true]]);
	assert.deepEqual(await local.listPrompts(), []);
});


/** Deleting a prompt signals linked notes once, only after the folder is truly removed. */
test('deletePrompt fires a confirmed deletion event containing prompt UUID', async () => {
	const { StorageService } = await importStorageService();
	const root = createTempWorkspace();
	try {
		const promptId = 'delete-note-link';
		const folder = await seedPrompt(root, promptId, []);
		const service = new (StorageService as any)(root);
		const deleted: Array<{ id: string; promptUuid?: string }> = [];
		service.onDidDeletePrompt((info: { id: string; promptUuid?: string }) => deleted.push(info));
		await service.deletePrompt(promptId);
		assert.equal(fs.existsSync(folder), false);
		assert.deepEqual(deleted, [{ id: promptId, promptUuid: 'uuid-' + promptId }]);
		await service.deletePrompt(promptId);
		assert.equal(deleted.length, 1);
		service.dispose();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
