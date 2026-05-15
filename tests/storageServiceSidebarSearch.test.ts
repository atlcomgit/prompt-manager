import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const originalLoad = (Module as any)._load;

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
	return fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-sidebar-search-'));
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	await fsp.writeFile(filePath, content, 'utf-8');
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fsp.readFile(filePath, 'utf-8')) as Record<string, unknown>;
}

async function seedPrompt(workspaceRoot: string, promptId: string, httpExamples: string): Promise<string> {
	const promptDir = path.join(workspaceRoot, '.vscode', 'prompt-manager', promptId);
	await writeTextFile(path.join(promptDir, 'config.json'), JSON.stringify({
		id: promptId,
		promptUuid: `uuid-${promptId}`,
		title: promptId,
		description: '',
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
		contextFiles: [],
		httpExamples,
		chatSessionIds: [],
		timeSpentWriting: 0,
		timeSpentImplementing: 0,
		timeSpentOnTask: 0,
		timeSpentUntracked: 0,
		notes: '',
		customGroupIds: [],
		createdAt: '2026-05-15T00:00:00.000Z',
		updatedAt: '2026-05-15T00:00:00.000Z',
	}, null, 2));
	await writeTextFile(path.join(promptDir, 'prompt.md'), '# Prompt\n');
	await writeTextFile(path.join(promptDir, 'report.txt'), 'Report needle content');
	await writeTextFile(path.join(promptDir, 'plan.md'), 'Plan checkpoint token');
	return promptDir;
}

test('listPrompts builds sidebarSearchText from plan, report and http example file contents', async () => {
	const { StorageService } = await importStorageService();
	const workspaceRoot = createTempWorkspace();

	try {
		await writeTextFile(path.join(workspaceRoot, 'examples', 'demo.http'), 'GET /health\nX-Test: demo');
		await seedPrompt(workspaceRoot, 'prompt-a', 'examples/demo.http');

		const service = new (StorageService as any)(workspaceRoot);
		const prompts = await service.listPrompts();
		const prompt = prompts[0];

		assert.ok(prompt, 'prompt should be returned');
		assert.equal(prompt.sidebarSearchText.includes('plan checkpoint token'), true);
		assert.equal(prompt.sidebarSearchText.includes('report needle content'), true);
		assert.equal(prompt.sidebarSearchText.includes('get /health'), true);
		assert.equal(prompt.sidebarSearchText.includes('x-test: demo'), true);
	} finally {
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});

test('savePrompt keeps runtime sidebar search data out of persisted config.json', async () => {
	const { StorageService } = await importStorageService();
	const workspaceRoot = createTempWorkspace();

	try {
		await writeTextFile(path.join(workspaceRoot, 'examples', 'demo.http'), 'POST /save');
		const promptDir = await seedPrompt(workspaceRoot, 'prompt-a', 'examples/demo.http');
		const service = new (StorageService as any)(workspaceRoot);
		const prompt = await service.getPrompt('prompt-a');

		assert.ok(prompt, 'prompt should load before save');
		prompt.title = 'Updated title';
		prompt.progress = 77;
		prompt.sidebarSearchText = 'runtime only';

		const saved = await service.savePrompt(prompt);

		assert.equal(saved.sidebarSearchText.includes('post /save'), true);
		const storedConfig = await readJson(path.join(promptDir, 'config.json'));
		assert.equal('sidebarSearchText' in storedConfig, false);
		assert.equal('progress' in storedConfig, false);
		assert.equal(storedConfig.title, 'Updated title');
	} finally {
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});