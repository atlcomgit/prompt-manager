import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const originalLoad = (Module as any)._load;
const ONE_MINUTE_MS = 60_000;

/** Create a minimal disposable object for VS Code watcher mocks. */
function createDisposable() {
	return { dispose() { } };
}

/** Convert Node filesystem stats to the VS Code FileType numeric shape used in tests. */
function toFileType(entry: fs.Stats | fs.Dirent): number {
	if (entry.isDirectory()) {
		return 2;
	}

	return 1;
}

/** Create the VS Code API subset needed by StorageService statistics tests. */
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
		FileType: {
			Directory: 2,
			File: 1,
		},
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
				readFile: async (uri: { fsPath: string }) => fsp.readFile(uri.fsPath),
				writeFile: async (uri: { fsPath: string }, data: Uint8Array) => {
					await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
					await fsp.writeFile(uri.fsPath, Buffer.from(data));
				},
				stat: async (uri: { fsPath: string }) => {
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
				rename: async (oldUri: { fsPath: string }, newUri: { fsPath: string }) => {
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

/** Import StorageService with a VS Code API mock installed for this test module. */
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

/** Create an isolated prompt storage workspace for statistics tests. */
function createTempWorkspace(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-statistics-'));
}

/** Write UTF-8 text after ensuring the parent directory exists. */
async function writeTextFile(filePath: string, content: string): Promise<void> {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	await fsp.writeFile(filePath, content, 'utf-8');
}

/** Seed one prompt with config, report and optional daily-time data. */
async function seedPrompt(
	workspaceRoot: string,
	promptId: string,
	input: {
		title: string;
		status: string;
		updatedAt: string;
		taskNumber: string;
		favorite?: boolean;
		dailyTime?: Record<string, { writing?: number; implementing?: number; onTask?: number; untracked?: number }>;
	},
): Promise<void> {
	const promptDir = path.join(workspaceRoot, '.vscode', 'prompt-manager', promptId);
	await writeTextFile(path.join(promptDir, 'config.json'), JSON.stringify({
		id: promptId,
		promptUuid: `uuid-${promptId}`,
		title: input.title,
		description: '',
		status: input.status,
		favorite: input.favorite === true,
		archived: false,
		projects: [],
		languages: [],
		frameworks: [],
		skills: [],
		mcpTools: [],
		hooks: [],
		taskNumber: input.taskNumber,
		branch: '',
		trackedBranch: '',
		trackedBranchesByProject: {},
		model: '',
		chatMode: 'agent',
		contextFiles: [],
		httpExamples: '',
		chatSessionIds: [],
		timeSpentWriting: 10 * ONE_MINUTE_MS,
		timeSpentImplementing: 10 * ONE_MINUTE_MS,
		timeSpentOnTask: 10 * ONE_MINUTE_MS,
		timeSpentUntracked: 10 * ONE_MINUTE_MS,
		notes: '',
		customGroupIds: [],
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: input.updatedAt,
	}, null, 2));
	await writeTextFile(path.join(promptDir, 'prompt.md'), '# Prompt\n');
	await writeTextFile(path.join(promptDir, 'report.txt'), '- **Что сделано**. Проверена статистика.');

	if (input.dailyTime) {
		await writeTextFile(path.join(promptDir, 'daily-time.json'), JSON.stringify(input.dailyTime, null, 2));
	}
}

/** Verify that period statistics use daily entries after the existing updatedAt filter. */
test('StorageService period statistics use daily time without cumulative config fallback', async () => {
	const { StorageService } = await importStorageService();
	const workspaceRoot = createTempWorkspace();

	try {
		await seedPrompt(workspaceRoot, 'prompt-a', {
			title: 'Inside period with daily time',
			status: 'completed',
			updatedAt: '2026-07-10T12:00:00.000Z',
			taskNumber: '161',
			favorite: true,
			dailyTime: {
				'2026-07-10': {
					writing: ONE_MINUTE_MS,
					implementing: 2 * ONE_MINUTE_MS,
					onTask: 3 * ONE_MINUTE_MS,
					untracked: 4 * ONE_MINUTE_MS,
				},
				'2026-08-01': { writing: 100 * ONE_MINUTE_MS },
			},
		});
		await seedPrompt(workspaceRoot, 'prompt-b', {
			title: 'Inside period without daily time',
			status: 'review',
			updatedAt: '2026-07-11T12:00:00.000Z',
			taskNumber: '162',
		});
		await seedPrompt(workspaceRoot, 'prompt-c', {
			title: 'Outside updatedAt primary filter',
			status: 'closed',
			updatedAt: '2026-08-01T12:00:00.000Z',
			taskNumber: '163',
			dailyTime: { '2026-07-10': { writing: 60 * ONE_MINUTE_MS } },
		});
		await seedPrompt(workspaceRoot, 'prompt-d', {
			title: 'Inside period below five minutes',
			status: 'draft',
			updatedAt: '2026-07-12T12:00:00.000Z',
			taskNumber: '164',
			dailyTime: { '2026-07-12': { writing: 4 * ONE_MINUTE_MS } },
		});

		const service = new (StorageService as any)(workspaceRoot);
		const stats = await service.getStatistics({ dateFrom: '2026-07-01', dateTo: '2026-07-31' });

		assert.equal(stats.totalPrompts, 2);
		assert.equal(stats.favoriteCount, 1);
		assert.equal(stats.byStatus.completed, 1);
		assert.equal(stats.byStatus.draft, 1);
		assert.equal(stats.byStatus.review, 0);
		assert.equal(stats.byStatus.closed, 0);
		assert.equal(stats.totalTimeWriting, 5 * ONE_MINUTE_MS);
		assert.equal(stats.totalTimeImplementing, 2 * ONE_MINUTE_MS);
		assert.equal(stats.totalTimeOnTask, 3 * ONE_MINUTE_MS);
		assert.equal(stats.totalTime, 14 * ONE_MINUTE_MS);
		assert.equal(stats.avgTimePerPrompt, 7 * ONE_MINUTE_MS);

		const rowA = stats.reportRows.find((row: { taskNumber: string }) => row.taskNumber === '161');
		assert.ok(rowA, 'period row should be returned');
		assert.equal(rowA.timeWriting, ONE_MINUTE_MS);
		assert.equal(rowA.timeImplementing, 2 * ONE_MINUTE_MS);
		assert.equal(rowA.timeOnTask, 3 * ONE_MINUTE_MS);
		assert.equal(rowA.totalTime, 10 * ONE_MINUTE_MS);
		assert.equal(stats.reportRows.some((row: { taskNumber: string }) => row.taskNumber === '162'), false);
		assert.equal(stats.reportRows.some((row: { taskNumber: string }) => row.taskNumber === '163'), false);

		let dailyTimeReads = 0;
		const originalGetDailyTime = service.getDailyTime.bind(service);
		service.getDailyTime = async (promptId: string) => {
			dailyTimeReads += 1;
			return originalGetDailyTime(promptId);
		};
		const minStats = await service.getStatistics({
			dateFrom: '2026-07-01',
			dateTo: '2026-07-31',
			minFiveMin: true,
		});

		assert.equal(dailyTimeReads, 3);
		assert.equal(minStats.totalPrompts, 1);
		assert.equal(minStats.reportRows.length, 1);
		assert.equal(minStats.reportRows[0].taskNumber, '161');
	} finally {
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});

/** Verify that daily time writes are serialized and publish an event only after durable persistence. */
test('StorageService serializes daily time updates and emits durable change events', async () => {
	const { StorageService } = await importStorageService();
	const workspaceRoot = createTempWorkspace();
	const promptId = 'prompt-activity';
	const promptDir = path.join(workspaceRoot, '.vscode', 'prompt-manager', promptId);

	try {
		await writeTextFile(path.join(promptDir, 'daily-time.json'), '{}');
		const service = new (StorageService as any)(workspaceRoot);
		const events: Array<Record<string, unknown>> = [];
		const durableReadPromises: Array<Promise<string>> = [];
		service.onDidPromptDailyTimeChange((event: Record<string, unknown>) => {
			events.push(event);
			durableReadPromises.push(fsp.readFile(path.join(promptDir, 'daily-time.json'), 'utf-8'));
		});
		const basePrompt = {
			id: promptId,
			promptUuid: 'uuid-activity',
			timeSpentWriting: 0,
			timeSpentImplementing: 0,
			timeSpentOnTask: 0,
			timeSpentUntracked: 0,
		};
		const firstPrompt = { ...basePrompt, timeSpentWriting: ONE_MINUTE_MS };
		const secondPrompt = { ...basePrompt, timeSpentWriting: 3 * ONE_MINUTE_MS };

		await Promise.all([
			service.enqueueDailyTimeUpdate(promptId, basePrompt, firstPrompt, false),
			service.enqueueDailyTimeUpdate(promptId, firstPrompt, secondPrompt, false),
		]);
		const durableReads = await Promise.all(durableReadPromises);
		const dailyData = JSON.parse(await fsp.readFile(path.join(promptDir, 'daily-time.json'), 'utf-8'));
		const today = new Date().toISOString().slice(0, 10);

		assert.equal(dailyData[today].writing, 3 * ONE_MINUTE_MS);
		assert.equal(events.length, 2);
		assert.deepEqual(events[1], {
			id: promptId,
			promptUuid: 'uuid-activity',
			archived: false,
		});
		assert.equal(durableReads.every(content => content.includes(today)), true);

		await service.enqueueDailyTimeUpdate(promptId, secondPrompt, secondPrompt, false);
		assert.equal(events.length, 2);
		service.dispose();
	} finally {
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});
