import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

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
		extensions: {
			getExtension: () => null,
		},
		Uri: {
			file: (fsPath: string) => ({ fsPath }),
		},
		commands: {
			executeCommand: async () => undefined,
		},
	};
}

async function importGitService() {
	(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return createVsCodeMock();
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		return await import('../src/services/gitService.js');
	} finally {
		(Module as any)._load = originalLoad;
	}
}

test('GitService applyBranchTargetsByProject pulls source branch and existing expected branch', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const calls: string[][] = [];
	let currentBranch = 'feature/old';

	service.getCurrentBranch = async () => currentBranch;
	service.branchExistsLocally = async (_projectPath: string, branchName: string) => branchName === 'main' || branchName === 'feature/task-42';
	service.findRemoteBranchRef = async () => '';
	service.getAllowedBaseBranches = () => new Set(['main', 'develop']);
	service.runGitFileCommandOptional = async (_projectPath: string, args: string[]) => {
		if (args[0] === 'config' && args[1] === 'branch.main.merge') {
			return 'refs/heads/main';
		}

		if (args[0] === 'config' && args[1] === 'branch.feature/task-42.merge') {
			return 'refs/heads/feature/task-42';
		}

		return '';
	};
	service.runGitFileMutation = async (_projectPath: string, args: string[]) => {
		if (args[0] === 'checkout') {
			currentBranch = args[1] || currentBranch;
		}
		calls.push(args);
	};

	const result = await service.applyBranchTargetsByProject(
		new Map([['api', '/tmp/api']]),
		['api'],
		'feature/task-42',
		{ api: 'main' },
		{ api: 'feature/task-42' },
		['main', 'develop'],
	);

	assert.equal(result.success, true);
	assert.deepEqual(calls, [
		['checkout', 'main'],
		['pull', '--ff-only'],
		['checkout', 'feature/task-42'],
		['pull', '--ff-only'],
	]);
});