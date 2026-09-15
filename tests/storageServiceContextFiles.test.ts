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

		service.findPromptIdByUuid = async () => {
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
