import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import Module from 'node:module';
import * as os from 'os';
import * as path from 'path';

const originalLoad = (Module as any)._load;

function createVsCodeMock() {
	return {
		Disposable: class Disposable {
			private readonly callback: (() => void) | undefined;

			constructor(callback?: () => void) {
				this.callback = callback;
			}

			dispose(): void {
				this.callback?.();
			}
		},
		Uri: {
			joinPath: (base: { fsPath: string }, ...paths: string[]) => ({
				fsPath: path.join(base.fsPath, ...paths),
			}),
		},
		workspace: {
			getConfiguration: () => ({
				get: <T>(_key: string, defaultValue?: T) => defaultValue,
			}),
		},
		window: {
			createOutputChannel: () => ({
				appendLine: (_message: string) => { },
				show: (_preserveFocus?: boolean) => { },
				dispose: () => { },
			}),
		},
	};
}

async function importMemoryDatabaseService() {
	(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return createVsCodeMock();
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		return await import('../src/services/memoryDatabaseService.js');
	} finally {
		(Module as any)._load = originalLoad;
	}
}

test('MemoryDatabaseService initialize does not create a root .gitignore file', async () => {
	const { MemoryDatabaseService } = await importMemoryDatabaseService();
	const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-memory-db-'));
	const gitignorePath = path.join(workspaceRoot, '.gitignore');
	const service = new MemoryDatabaseService({ fsPath: process.cwd() } as any);

	try {
		await service.initialize(workspaceRoot);
		service.close();

		assert.equal(fs.existsSync(gitignorePath), false);
	} finally {
		service.close();
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});

test('MemoryDatabaseService initialize leaves an existing root .gitignore unchanged', async () => {
	const { MemoryDatabaseService } = await importMemoryDatabaseService();
	const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-memory-db-'));
	const gitignorePath = path.join(workspaceRoot, '.gitignore');
	const originalGitignore = 'node_modules\ncoverage\n';
	const service = new MemoryDatabaseService({ fsPath: process.cwd() } as any);

	try {
		fs.writeFileSync(gitignorePath, originalGitignore, 'utf-8');

		await service.initialize(workspaceRoot);
		service.close();

		assert.equal(fs.readFileSync(gitignorePath, 'utf-8'), originalGitignore);
	} finally {
		service.close();
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});
