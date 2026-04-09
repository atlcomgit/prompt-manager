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
	service.listLocalBranches = async () => new Map([
		[currentBranch, {
			name: currentBranch,
			current: true,
			upstream: currentBranch === 'feature/task-42' ? 'origin/feature/task-42' : '',
			ahead: 0,
			behind: 0,
			stale: false,
			sha: 'abc1234',
			author: 'Test User',
			committedAt: '2026-04-06T00:00:00.000Z',
			subject: 'Test commit',
		}],
	]);
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
	service.listLocalBranches = async () => new Map([
		[currentBranch, {
			name: currentBranch,
			current: true,
			upstream: currentBranch === 'main' ? 'origin/main' : '',
			ahead: 0,
			behind: 0,
			stale: false,
			sha: 'abc1234',
			author: 'Test User',
			committedAt: '2026-04-06T00:00:00.000Z',
			subject: 'Test commit',
		}],
	]);
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

test('GitService syncProjects pulls only branches that are behind their upstream', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const calls: string[][] = [];

	service.getCurrentBranch = async () => 'feature/task-42';
	service.listLocalBranches = async () => new Map([
		['feature/task-42', {
			name: 'feature/task-42',
			current: true,
			upstream: 'origin/feature/task-42',
			ahead: 0,
			behind: 2,
			stale: false,
			sha: 'abc1234',
			author: 'Test User',
			committedAt: '2026-04-06T00:00:00.000Z',
			subject: 'Test commit',
		}],
	]);
	service.runGitFileMutation = async (_projectPath: string, args: string[]) => {
		calls.push(args);
	};

	const result = await service.syncProjects(
		new Map([['api', '/tmp/api']]),
		['api'],
	);

	assert.equal(result.success, true);
	assert.deepEqual(result.changedProjects, ['api']);
	assert.deepEqual(result.skippedProjects, []);
	assert.deepEqual(calls, [
		['pull', '--ff-only'],
	]);
});

test('GitService syncProjects skips branches without upstream changes', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const calls: string[][] = [];

	service.getCurrentBranch = async () => 'feature/task-42';
	service.listLocalBranches = async () => new Map([
		['feature/task-42', {
			name: 'feature/task-42',
			current: true,
			upstream: 'origin/feature/task-42',
			ahead: 0,
			behind: 0,
			stale: false,
			sha: 'abc1234',
			author: 'Test User',
			committedAt: '2026-04-06T00:00:00.000Z',
			subject: 'Test commit',
		}],
	]);
	service.runGitFileMutation = async (_projectPath: string, args: string[]) => {
		calls.push(args);
	};

	const result = await service.syncProjects(
		new Map([['api', '/tmp/api']]),
		['api'],
	);

	assert.equal(result.success, true);
	assert.deepEqual(result.changedProjects, []);
	assert.deepEqual(result.skippedProjects, ['api']);
	assert.deepEqual(calls, []);
});

test('GitService syncProjects skips stale upstream branches', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const calls: string[][] = [];

	service.getCurrentBranch = async () => 'feature/task-42';
	service.listLocalBranches = async () => new Map([
		['feature/task-42', {
			name: 'feature/task-42',
			current: true,
			upstream: 'origin/feature/task-42',
			ahead: 0,
			behind: 3,
			stale: true,
			sha: 'abc1234',
			author: 'Test User',
			committedAt: '2026-04-06T00:00:00.000Z',
			subject: 'Test commit',
		}],
	]);
	service.runGitFileMutation = async (_projectPath: string, args: string[]) => {
		calls.push(args);
	};

	const result = await service.syncProjects(
		new Map([['api', '/tmp/api']]),
		['api'],
	);

	assert.equal(result.success, true);
	assert.deepEqual(result.changedProjects, []);
	assert.deepEqual(result.skippedProjects, ['api']);
	assert.deepEqual(calls, []);
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

test('GitService getChangeGroups ignores files from default codemap excluded paths', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;

	service.runGitFileCommandOptional = async (_projectPath: string, args: string[]) => {
		if (args[0] === 'status') {
			return '?? node_modules/skip.js\n?? src/keep.ts';
		}
		if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
			return 'node_modules/conflict.ts\nsrc/conflict.ts';
		}
		if (args[0] === 'diff' && args[1] === '--cached') {
			return 'M\tnode_modules/staged.ts\nM\tsrc/staged.ts';
		}
		if (args[0] === 'diff' && args[1] !== '--cached') {
			return 'M\tnode_modules/work.ts\nM\tsrc/work.ts';
		}
		return '';
	};
	service.enrichOverlayChangeFile = async (_projectPath: string, item: any) => item;

	const groups = await service.getChangeGroups('api', '/tmp/api');

	assert.deepEqual(groups.merge.map((item: any) => item.path), ['src/conflict.ts']);
	assert.deepEqual(groups.staged.map((item: any) => item.path), ['src/staged.ts']);
	assert.deepEqual(groups.workingTree.map((item: any) => item.path), ['src/work.ts']);
	assert.deepEqual(groups.untracked.map((item: any) => item.path), ['src/keep.ts']);
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

test('GitService resolveReviewRequestTitlePrefix prefers configured setting', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;

	service.getReviewRequestTitlePrefixSetting = () => 'MR';
	service.runGitFileCommandOptional = async () => 'Git User';

	const titlePrefix = await service.resolveReviewRequestTitlePrefix('/tmp/api');

	assert.equal(titlePrefix, 'MR');
});

test('GitService resolveReviewRequestTitlePrefix falls back to git user name when setting is empty', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;

	service.getReviewRequestTitlePrefixSetting = () => '';
	service.runGitFileCommandOptional = async (_projectPath: string, args: string[]) => {
		if (args[0] === 'config' && args[1] === 'user.name') {
			return 'Git User';
		}

		return '';
	};

	const titlePrefix = await service.resolveReviewRequestTitlePrefix('/tmp/api');

	assert.equal(titlePrefix, 'Git User');
});

test('GitService getProjectReviewState includes resolved title prefix in review state', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;

	service.resolveReviewRequestTitlePrefix = async () => 'MR';
	service.resolveReviewRemoteContext = async () => ({ remote: null, unsupportedReason: 'missing-remote' });

	const reviewState = await service.getProjectReviewState('/tmp/api', 'feature/task-42');

	assert.equal(reviewState.titlePrefix, 'MR');
	assert.equal(reviewState.unsupportedReason, 'missing-remote');
});

test('GitService resolveGitLabProjectId extracts numeric id from moved-project redirect output', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;

	service.runJsonCliCommand = async () => {
		const error = new Error('glab: Non GET methods are not allowed for moved projects (HTTP 405)');
		(error as Error & { stderr?: string }).stderr = 'Location: https://gitlab.example.com/api/v4/projects/654';
		throw error;
	};

	const projectId = await service.resolveGitLabProjectId('/tmp/api', {
		provider: 'gitlab',
		host: 'gitlab.example.com',
		remoteName: 'origin',
		remoteUrl: 'https://gitlab.example.com/acme/api.git',
		repositoryPath: 'acme/api',
		owner: 'acme',
		name: 'api',
		supported: true,
		cliCommand: 'glab',
		cliAvailable: true,
		actionLabel: 'Merge request',
	});

	assert.equal(projectId, '654');
});

test('GitService createGitLabReviewRequest uses resolved project id, Draft title and remove_source_branch flag', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	let capturedArgs: string[] | null = null;

	service.resolveGitLabProjectId = async () => '321';
	service.runJsonCliCommand = async (_command: string, _projectPath: string, args: string[]) => {
		capturedArgs = args;
		return {};
	};

	await service.createGitLabReviewRequest(
		'/tmp/api',
		{
			provider: 'gitlab',
			host: 'gitlab.example.com',
			remoteName: 'origin',
			remoteUrl: 'https://gitlab.example.com/acme/api.git',
			repositoryPath: 'acme/api',
			owner: 'acme',
			name: 'api',
			supported: true,
			cliCommand: 'glab',
			cliAvailable: true,
			actionLabel: 'Merge request',
		},
		'feature/task-42',
		'main',
		'Add moved-project handling',
		'Body',
		true,
		false,
	);

	assert.deepEqual(capturedArgs, [
		'api',
		'-X',
		'POST',
		'projects/321/merge_requests',
		'-F',
		'source_branch=feature/task-42',
		'-F',
		'target_branch=main',
		'-F',
		'title=Draft: Add moved-project handling',
		'-F',
		'description=Body',
		'-F',
		'remove_source_branch=false',
	]);
});

test('GitService createReviewRequests enables draft PRs by default for GitHub', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const remote = {
		provider: 'github',
		host: 'github.com',
		remoteName: 'origin',
		remoteUrl: 'https://github.com/acme/api.git',
		repositoryPath: 'acme/api',
		owner: 'acme',
		name: 'api',
		supported: true,
		cliCommand: 'gh',
		cliAvailable: true,
		actionLabel: 'Pull request',
	};
	let capturedCall: unknown[] | null = null;

	service.getReviewRemote = async () => remote;
	service.isCliAuthenticated = async () => true;
	service.getExistingReviewRequest = async () => null;
	service.createGitHubReviewRequest = async (...args: unknown[]) => {
		capturedCall = args;
	};

	const result = await service.createReviewRequests(
		new Map([['api', '/tmp/api']]),
		{
			id: 'prompt-61',
			taskNumber: '61',
			title: 'MR automation',
			description: '',
			branch: 'feature/task-42',
		} as any,
		[
			{
				project: 'api',
				targetBranch: 'main',
				title: '61 MR automation',
			},
		],
	);

	assert.equal(result.success, true);
	assert.deepEqual(result.changedProjects, ['api']);
	assert.ok(capturedCall);
	assert.equal(capturedCall?.[0], '/tmp/api');
	assert.equal(capturedCall?.[2], 'feature/task-42');
	assert.equal(capturedCall?.[3], 'main');
	assert.equal(capturedCall?.[4], '61 MR automation');
	assert.equal(capturedCall?.[5], 'Task: 61\nPrompt: MR automation\nBranch: feature/task-42');
	assert.equal(capturedCall?.[6], true);
});