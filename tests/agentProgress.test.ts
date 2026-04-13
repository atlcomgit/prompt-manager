import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

/* ── vscode mock ── */
const originalLoad = (Module as any)._load;

let fsMockFiles = new Map<string, string>();
let fsMockStatFail = new Set<string>();

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
		dispose(): void {
			this.listeners.length = 0;
		}
	}

	return {
		EventEmitter,
		Uri: {
			file: (value: string) => ({ fsPath: value, toString: () => value }),
			joinPath: (base: { fsPath?: string }, ...parts: string[]) => ({
				fsPath: [base.fsPath || '', ...parts].join('/'),
			}),
		},
		env: { language: 'en' },
		RelativePattern: class {
			constructor(public base: string, public pattern: string) { }
		},
		workspace: {
			fs: {
				readFile: async (uri: { fsPath: string }) => {
					const content = fsMockFiles.get(uri.fsPath);
					if (content === undefined) {
						throw new Error(`File not found: ${uri.fsPath}`);
					}
					return Buffer.from(content, 'utf-8');
				},
				stat: async (uri: { fsPath: string }) => {
					if (fsMockStatFail.has(uri.fsPath)) {
						throw new Error(`File not found: ${uri.fsPath}`);
					}
					return { type: 1, size: 0 };
				},
				writeFile: async (uri: { fsPath: string }, data: Uint8Array) => {
					fsMockFiles.set(uri.fsPath, Buffer.from(data).toString('utf-8'));
				},
			},
			createFileSystemWatcher: () => ({
				onDidCreate: () => ({ dispose() { } }),
				onDidChange: () => ({ dispose() { } }),
				onDidDelete: () => ({ dispose() { } }),
				dispose() { },
			}),
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

/* ── readAgentProgress tests ── */

test('readAgentProgress returns number when agent.json has valid progress', async () => {
	const { StorageService } = await importStorageService();

	fsMockFiles = new Map();
	fsMockStatFail = new Set();

	const service = new (StorageService as any)('/tmp/test-workspace');
	const promptDir = '/tmp/test-workspace/.vscode/prompt-manager/test-prompt';
	fsMockFiles.set(`${promptDir}/agent.json`, JSON.stringify({ progress: 42 }));

	/* Override getPromptDirectoryPath for test isolation */
	service.getPromptDirectoryPath = () => promptDir;

	const result = await service.readAgentProgress('test-prompt');
	assert.equal(result, 42);
});

test('readAgentProgress returns undefined when file is missing', async () => {
	const { StorageService } = await importStorageService();

	fsMockFiles = new Map();
	fsMockStatFail = new Set();

	const service = new (StorageService as any)('/tmp/test-workspace');
	const promptDir = '/tmp/test-workspace/.vscode/prompt-manager/test-prompt';
	service.getPromptDirectoryPath = () => promptDir;

	const result = await service.readAgentProgress('test-prompt');
	assert.equal(result, undefined);
});

test('readAgentProgress returns undefined when JSON is invalid', async () => {
	const { StorageService } = await importStorageService();

	fsMockFiles = new Map();
	fsMockStatFail = new Set();

	const service = new (StorageService as any)('/tmp/test-workspace');
	const promptDir = '/tmp/test-workspace/.vscode/prompt-manager/test-prompt';
	fsMockFiles.set(`${promptDir}/agent.json`, '{invalid json}');
	service.getPromptDirectoryPath = () => promptDir;

	const result = await service.readAgentProgress('test-prompt');
	assert.equal(result, undefined);
});

test('readAgentProgress clamps value to 0–100 range', async () => {
	const { StorageService } = await importStorageService();

	fsMockFiles = new Map();
	fsMockStatFail = new Set();

	const service = new (StorageService as any)('/tmp/test-workspace');
	const promptDir = '/tmp/test-workspace/.vscode/prompt-manager/test-prompt';
	service.getPromptDirectoryPath = () => promptDir;

	fsMockFiles.set(`${promptDir}/agent.json`, JSON.stringify({ progress: 150 }));
	assert.equal(await service.readAgentProgress('test-prompt'), 100);

	fsMockFiles.set(`${promptDir}/agent.json`, JSON.stringify({ progress: -10 }));
	assert.equal(await service.readAgentProgress('test-prompt'), 0);
});

test('readAgentProgress returns undefined when progress is not a number', async () => {
	const { StorageService } = await importStorageService();

	fsMockFiles = new Map();
	fsMockStatFail = new Set();

	const service = new (StorageService as any)('/tmp/test-workspace');
	const promptDir = '/tmp/test-workspace/.vscode/prompt-manager/test-prompt';
	service.getPromptDirectoryPath = () => promptDir;

	fsMockFiles.set(`${promptDir}/agent.json`, JSON.stringify({ progress: 'fifty' }));
	assert.equal(await service.readAgentProgress('test-prompt'), undefined);
});

/* ── createAgentFile tests ── */

test('createAgentFile creates file with progress 0 when file does not exist', async () => {
	const { StorageService } = await importStorageService();

	fsMockFiles = new Map();
	fsMockStatFail = new Set();

	const service = new (StorageService as any)('/tmp/test-workspace');
	const promptDir = '/tmp/test-workspace/.vscode/prompt-manager/test-prompt';
	const agentPath = `${promptDir}/agent.json`;
	service.getPromptDirectoryPath = () => promptDir;
	fsMockStatFail.add(agentPath);

	await service.createAgentFile('test-prompt');

	const written = fsMockFiles.get(agentPath);
	assert.ok(written, 'agent.json should be written');
	const parsed = JSON.parse(written);
	assert.equal(parsed.progress, 0);
});

test('createAgentFile does not overwrite existing file', async () => {
	const { StorageService } = await importStorageService();

	fsMockFiles = new Map();
	fsMockStatFail = new Set();

	const service = new (StorageService as any)('/tmp/test-workspace');
	const promptDir = '/tmp/test-workspace/.vscode/prompt-manager/test-prompt';
	const agentPath = `${promptDir}/agent.json`;
	service.getPromptDirectoryPath = () => promptDir;

	/* File already exists with progress 75 */
	const existing = JSON.stringify({ progress: 75 });
	fsMockFiles.set(agentPath, existing);

	await service.createAgentFile('test-prompt');

	const content = fsMockFiles.get(agentPath);
	assert.equal(content, existing, 'existing file should not be overwritten');
});
