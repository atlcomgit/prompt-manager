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

test('GitService applyBranchTargetsByProject switches to existing prompt branch without source branch', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const calls: string[][] = [];
	let currentBranch = 'feature/old';

	service.getCurrentBranch = async () => currentBranch;
	service.branchExistsLocally = async () => false;
	service.findRemoteBranchRef = async (_projectPath: string, branchName: string) => branchName === 'feature/task-42'
		? 'origin/feature/task-42'
		: '';
	service.getAllowedBaseBranches = () => new Set(['main', 'develop']);
	service.runGitFileCommandOptional = async (_projectPath: string, args: string[]) => {
		if (args[0] === 'config' && args[1] === 'branch.feature/task-42.merge') {
			return 'refs/heads/feature/task-42';
		}

		return '';
	};
	service.runGitFileMutation = async (_projectPath: string, args: string[]) => {
		if (args[0] === 'checkout') {
			currentBranch = args[1] === '-b'
				? (args[2] || currentBranch)
				: (args[1] || currentBranch);
		}
		calls.push(args);
	};

	const result = await service.applyBranchTargetsByProject(
		new Map([['api', '/tmp/api']]),
		['api'],
		'feature/task-42',
		undefined,
		{ api: 'feature/task-42' },
		['main', 'develop'],
	);

	assert.equal(result.success, true);
	assert.deepEqual(calls, [
		['checkout', '-b', 'feature/task-42', '--track', 'origin/feature/task-42'],
		['pull', '--ff-only'],
	]);
});

test('GitService applyBranchTargetsByProject creates missing prompt branch from selected source branch', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const calls: string[][] = [];
	let currentBranch = 'feature/old';

	service.getCurrentBranch = async () => currentBranch;
	service.branchExistsLocally = async (_projectPath: string, branchName: string) => branchName === 'main';
	service.findRemoteBranchRef = async () => '';
	service.getAllowedBaseBranches = () => new Set(['main', 'develop']);
	service.runGitFileCommandOptional = async (_projectPath: string, args: string[]) => {
		if (args[0] === 'config' && args[1] === 'branch.main.merge') {
			return 'refs/heads/main';
		}

		return '';
	};
	service.runGitFileMutation = async (_projectPath: string, args: string[]) => {
		if (args[0] === 'checkout') {
			currentBranch = args[1] === '-b'
				? (args[2] || currentBranch)
				: (args[1] || currentBranch);
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
		['checkout', '-b', 'feature/task-42', 'main'],
	]);
});

test('GitService discardProjectChanges applies each git restore strategy once per unique file', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const calls: string[][] = [];

	service.runGitFileMutation = async (_projectPath: string, args: string[]) => {
		calls.push(args);
	};

	const result = await service.discardProjectChanges(
		new Map([['api', '/tmp/api']]),
		'api',
		[
			{
				project: 'api',
				path: 'src/staged.ts',
				status: 'M',
				previousPath: '',
				group: 'staged',
				conflicted: false,
				staged: true,
				isBinary: false,
				additions: 1,
				deletions: 0,
				fileSizeBytes: 100,
			},
			{
				project: 'api',
				path: 'src/staged.ts',
				status: 'M',
				previousPath: '',
				group: 'staged',
				conflicted: false,
				staged: true,
				isBinary: false,
				additions: 1,
				deletions: 0,
				fileSizeBytes: 100,
			},
			{
				project: 'api',
				path: 'src/working.ts',
				status: 'M',
				previousPath: '',
				group: 'working-tree',
				conflicted: false,
				staged: false,
				isBinary: false,
				additions: 2,
				deletions: 1,
				fileSizeBytes: 120,
			},
			{
				project: 'api',
				path: 'src/new-file.ts',
				status: 'A',
				previousPath: '',
				group: 'untracked',
				conflicted: false,
				staged: false,
				isBinary: false,
				additions: 0,
				deletions: 0,
				fileSizeBytes: 90,
			},
			{
				project: 'api',
				path: 'src/renamed.ts',
				status: 'R',
				previousPath: 'src/original.ts',
				group: 'merge',
				conflicted: false,
				staged: true,
				isBinary: false,
				additions: 0,
				deletions: 0,
				fileSizeBytes: 110,
			},
		],
	);

	assert.equal(result.success, true);
	assert.deepEqual(calls, [
		['restore', '--staged', '--source=HEAD', '--', 'src/staged.ts'],
		['restore', '--worktree', '--source=HEAD', '--', 'src/working.ts'],
		['clean', '-fd', '--', 'src/new-file.ts'],
		['restore', '--staged', '--worktree', '--source=HEAD', '--', 'src/renamed.ts', 'src/original.ts'],
	]);
});

test('GitService getProjectReviewState returns granular unsupported reasons for review setup', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;

	service.getBranchRemote = async () => '';
	let reviewState = await service.getProjectReviewState('/tmp/api', 'feature/task-42');
	assert.equal(reviewState.remote, null);
	assert.equal(reviewState.unsupportedReason, 'missing-remote');

	service.getBranchRemote = async () => 'origin';
	service.runGitFileCommandOptional = async () => 'not-a-supported-remote-url';
	reviewState = await service.getProjectReviewState('/tmp/api', 'feature/task-42');
	assert.equal(reviewState.remote, null);
	assert.equal(reviewState.unsupportedReason, 'unrecognized-remote');

	service.runGitFileCommandOptional = async () => 'https://bitbucket.example.com/acme/repo.git';
	reviewState = await service.getProjectReviewState('/tmp/api', 'feature/task-42');
	assert.equal(reviewState.remote?.supported, false);
	assert.equal(reviewState.unsupportedReason, 'unsupported-provider');
});