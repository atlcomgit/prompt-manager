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

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
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

test('GitService fetchProjects starts project mutations in parallel and keeps result order stable', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const apiDeferred = createDeferred<void>();
	const webDeferred = createDeferred<void>();
	const startedProjects: string[] = [];
	const debugEvents: Array<{ event: string; payload?: Record<string, unknown> }> = [];

	service.logDebug = (event: string, payload?: Record<string, unknown>) => {
		debugEvents.push({ event, payload });
	};

	service.runGitFileMutation = async (projectPath: string, args: string[]) => {
		assert.deepEqual(args, ['fetch', '--all', '--prune']);
		const project = projectPath.endsWith('/api') ? 'api' : 'web';
		startedProjects.push(project);
		if (project === 'api') {
			await apiDeferred.promise;
			return;
		}
		await webDeferred.promise;
	};

	const resultPromise = service.fetchProjects(
		new Map([
			['api', '/tmp/api'],
			['web', '/tmp/web'],
		]),
		['api', 'web'],
	);

	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(startedProjects, ['api', 'web']);

	webDeferred.resolve();
	apiDeferred.resolve();

	const result = await resultPromise;
	assert.equal(result.success, true);
	assert.deepEqual(result.changedProjects, ['api', 'web']);
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.skippedProjects, []);
	const fetchCompleted = debugEvents.find(item => item.event === 'fetchProjects.completed');
	assert.ok(fetchCompleted);
	assert.equal(fetchCompleted.payload?.projectCount, 2);
	assert.equal(fetchCompleted.payload?.changedProjectCount, 2);
	assert.equal(fetchCompleted.payload?.skippedProjectCount, 0);
	assert.equal(fetchCompleted.payload?.errorCount, 0);
	assert.equal(fetchCompleted.payload?.success, true);
	assert.equal(typeof fetchCompleted.payload?.durationMs, 'number');
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

test('GitService getChangeGroups skips diff enrichment when lightweight details are requested', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	let enrichCalls = 0;

	service.runGitFileCommandOptional = async (_projectPath: string, args: string[]) => {
		if (args[0] === 'status') {
			return '?? src/new-file.ts';
		}
		if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
			return 'src/conflict.ts';
		}
		if (args[0] === 'diff' && args[1] === '--cached') {
			return 'M\tsrc/staged.ts';
		}
		if (args[0] === 'diff' && args[1] !== '--cached') {
			return 'M\tsrc/work.ts';
		}
		return '';
	};
	service.enrichOverlayChangeFile = async (_projectPath: string, item: any) => {
		enrichCalls += 1;
		return {
			...item,
			fileSizeBytes: 999,
			additions: 10,
			deletions: 2,
			isBinary: true,
		};
	};

	const groups = await service.getChangeGroups('api', '/tmp/api', { includeDetails: false });

	assert.equal(enrichCalls, 0);
	assert.equal(groups.merge[0]?.fileSizeBytes, 0);
	assert.equal(groups.merge[0]?.additions, null);
	assert.equal(groups.staged[0]?.fileSizeBytes, 0);
	assert.equal(groups.workingTree[0]?.fileSizeBytes, 0);
	assert.equal(groups.untracked[0]?.fileSizeBytes, 0);
});

test('GitService getChangeGroups short-circuits extra diff commands for clean repositories', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const commands: string[][] = [];

	service.runGitFileCommandOptional = async (_projectPath: string, args: string[]) => {
		commands.push(args);
		if (args[0] === 'status') {
			return '';
		}

		throw new Error(`Unexpected git command: ${args.join(' ')}`);
	};

	const groups = await service.getChangeGroups('api', '/tmp/api', { includeDetails: false });

	assert.deepEqual(groups, {
		merge: [],
		staged: [],
		workingTree: [],
		untracked: [],
	});
	assert.deepEqual(commands, [['status', '--porcelain', '--untracked-files=all']]);
});

test('GitService buildProjectSnapshot summary mode skips change groups entirely for fast initial open', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	let getChangeGroupsCalls = 0;
	let listLocalBranchesCalls = 0;
	let listRemoteBranchNamesCalls = 0;
	let getProjectReviewStateCalls = 0;

	service.getCurrentBranch = async () => 'feature/task-42';
	service.getReviewRequestTitlePrefixSetting = () => 'MR';
	service.listLocalBranches = async () => {
		listLocalBranchesCalls += 1;
		return new Map([
			['feature/task-42', {
				name: 'feature/task-42',
				current: true,
				upstream: 'origin/feature/task-42',
				ahead: 0,
				behind: 0,
				stale: false,
				sha: '1234567890abcdef',
				author: 'Git User',
				committedAt: '2026-04-24T12:00:00.000Z',
				subject: 'Latest change',
			}],
		]);
	};
	service.listRemoteBranchNames = async () => {
		listRemoteBranchNamesCalls += 1;
		return new Set<string>(['main']);
	};
	service.getChangeGroups = async () => {
		getChangeGroupsCalls += 1;
		return {
			merge: [{ project: 'api', path: 'src/slow.ts', status: 'M', group: 'working-tree', conflicted: false, staged: false, fileSizeBytes: 1, additions: 1, deletions: 0, isBinary: false }],
			staged: [],
			workingTree: [],
			untracked: [],
		};
	};
	service.getProjectReviewState = async () => {
		getProjectReviewStateCalls += 1;
		return {
			remote: null,
			request: null,
			error: '',
			setupAction: null,
			titlePrefix: '',
			unsupportedReason: null,
		};
	};

	const snapshot = await service.buildProjectSnapshot('api', '/tmp/api', 'feature/task-42', ['main'], { detailLevel: 'summary' });

	assert.equal(getChangeGroupsCalls, 0);
	assert.equal(listLocalBranchesCalls, 0);
	assert.equal(listRemoteBranchNamesCalls, 0);
	assert.equal(getProjectReviewStateCalls, 0);
	assert.deepEqual(snapshot.changeGroups, {
		merge: [],
		staged: [],
		workingTree: [],
		untracked: [],
	});
	assert.equal(snapshot.dirty, false);
	assert.equal(snapshot.review.titlePrefix, 'MR');
	assert.equal(snapshot.review.remote, null);
});

test('GitService getGitOverlayOtherProjectsSnapshot skips selected and clean projects', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;

	service.buildOtherProjectSnapshot = async (project: string, projectPath: string, promptBranch: string) => {
		if (project === 'docs-dirty') {
			return {
				project,
				repositoryPath: projectPath,
				available: true,
				error: '',
				commitError: '',
				currentBranch: '',
				promptBranch,
				dirty: true,
				hasConflicts: false,
				upstream: '',
				ahead: 0,
				behind: 0,
				lastCommit: null,
				branches: [],
				cleanupBranches: [],
				changeGroups: {
					merge: [],
					staged: [],
					workingTree: [],
					untracked: [],
				},
				review: { remote: null, request: null, error: '', setupAction: null, titlePrefix: '', unsupportedReason: null },
				recentCommits: [],
				staleLocalBranches: [],
				graph: { nodes: [], edges: [] },
			};
		}

		return null;
	};

	const result = await service.getGitOverlayOtherProjectsSnapshot(
		new Map([
			['selected-clean', '/tmp/selected-clean'],
			['docs-dirty', '/tmp/docs-dirty'],
			['worker-clean', '/tmp/worker-clean'],
		]),
		['selected-clean', 'docs-dirty', 'worker-clean'],
		['selected-clean'],
		'feature/task-42',
	);

	assert.deepEqual(result.map((project: any) => project.project), ['docs-dirty']);
	assert.equal(result[0]?.repositoryPath, '/tmp/docs-dirty');
});

test('GitService buildOtherProjectSnapshot skips heavy change scan for clean peer repositories', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const commands: string[][] = [];

	service.runGitFileCommandOptional = async (_projectPath: string, args: string[]) => {
		commands.push(args);
		if (args[0] === 'status') {
			return '';
		}

		throw new Error(`Unexpected git command: ${args.join(' ')}`);
	};
	service.getChangeGroups = async () => {
		throw new Error('Heavy change scan should not run for a clean repository.');
	};

	const snapshot = await service.buildOtherProjectSnapshot('docs-clean', '/tmp/docs-clean', 'feature/task-42');

	assert.equal(snapshot, null);
	assert.deepEqual(commands, [['status', '--porcelain', '--untracked-files=normal']]);
});

test('GitService buildProjectSnapshot skips recent commits loading and derives lastCommit from local branch metadata', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;

	service.getCurrentBranch = async () => 'feature/task-42';
	service.listLocalBranches = async () => new Map([
		['feature/task-42', {
			name: 'feature/task-42',
			current: true,
			upstream: 'origin/feature/task-42',
			ahead: 1,
			behind: 0,
			stale: false,
			sha: '1234567890abcdef',
			author: 'Git User',
			committedAt: '2026-04-24T12:00:00.000Z',
			subject: 'Latest change',
		}],
	]);
	service.listRemoteBranchNames = async () => new Set<string>(['main']);
	service.getChangeGroups = async () => ({
		merge: [],
		staged: [],
		workingTree: [],
		untracked: [],
	});
	service.getProjectReviewState = async () => ({
		remote: null,
		request: null,
		error: '',
		setupAction: null,
		titlePrefix: '',
		unsupportedReason: null,
	});
	service.getRecentCommits = async () => {
		throw new Error('recent commits should not be loaded');
	};

	const snapshot = await service.buildProjectSnapshot('api', '/tmp/api', 'feature/task-42', ['main']);

	assert.equal(snapshot.lastCommit?.sha, '1234567890abcdef');
	assert.equal(snapshot.lastCommit?.shortSha, '1234567');
	assert.deepEqual(snapshot.recentCommits, []);
	assert.equal(snapshot.upstream, 'origin/feature/task-42');
	assert.equal(snapshot.ahead, 1);
});

test('GitService buildProjectSnapshot starts review resolution in parallel with full snapshot details', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const deferredReview = createDeferred<any>();
	let listLocalBranchesStarted = false;
	let listRemoteBranchNamesStarted = false;
	let getChangeGroupsStarted = false;

	service.getCurrentBranch = async () => 'feature/task-42';
	service.getProjectReviewState = async () => deferredReview.promise;
	service.listLocalBranches = async () => {
		listLocalBranchesStarted = true;
		return new Map([
			['feature/task-42', {
				name: 'feature/task-42',
				current: true,
				upstream: 'origin/feature/task-42',
				ahead: 0,
				behind: 0,
				stale: false,
				sha: '1234567890abcdef',
				author: 'Git User',
				committedAt: '2026-04-24T12:00:00.000Z',
				subject: 'Latest change',
			}],
		]);
	};
	service.listRemoteBranchNames = async () => {
		listRemoteBranchNamesStarted = true;
		return new Set<string>(['main']);
	};
	service.getChangeGroups = async () => {
		getChangeGroupsStarted = true;
		return {
			merge: [],
			staged: [],
			workingTree: [],
			untracked: [],
		};
	};

	const snapshotPromise = service.buildProjectSnapshot('api', '/tmp/api', 'feature/task-42', ['main']);
	await Promise.resolve();

	assert.equal(listLocalBranchesStarted, true);
	assert.equal(listRemoteBranchNamesStarted, true);
	assert.equal(getChangeGroupsStarted, true);

	deferredReview.resolve({
		remote: null,
		request: null,
		error: '',
		setupAction: null,
		titlePrefix: '',
		unsupportedReason: null,
	});

	const snapshot = await snapshotPromise;
	assert.equal(snapshot.available, true);
	assert.equal(snapshot.currentBranch, 'feature/task-42');
	assert.equal(snapshot.branches.some((branch: any) => branch.name === 'feature/task-42'), true);
});

test('GitService buildProjectSnapshot reuses prefetched review state when provided', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	let reviewCalls = 0;
	const prefetchedReviewState = {
		remote: null,
		request: null,
		error: '',
		setupAction: null,
		titlePrefix: 'PM',
		unsupportedReason: 'unsupported-provider',
	};

	service.getCurrentBranch = async () => 'feature/task-42';
	service.getProjectReviewState = async () => {
		reviewCalls += 1;
		return {
			remote: null,
			request: null,
			error: '',
			setupAction: null,
			titlePrefix: '',
			unsupportedReason: null,
		};
	};
	service.listLocalBranches = async () => new Map([
		['feature/task-42', {
			name: 'feature/task-42',
			current: true,
			upstream: 'origin/feature/task-42',
			ahead: 0,
			behind: 0,
			stale: false,
			sha: '1234567890abcdef',
			author: 'Git User',
			committedAt: '2026-04-24T12:00:00.000Z',
			subject: 'Latest change',
		}],
	]);
	service.listRemoteBranchNames = async () => new Set<string>(['main']);
	service.getChangeGroups = async () => ({
		merge: [],
		staged: [],
		workingTree: [],
		untracked: [],
	});

	const snapshot = await service.getGitOverlaySnapshot(
		new Map([['api', '/tmp/api']]),
		['api'],
		'feature/task-42',
		['main'],
		{
			detailLevel: 'full',
			prefetchedReviewStatesByProject: {
				api: prefetchedReviewState,
			},
		},
	);

	assert.equal(reviewCalls, 0);
	assert.equal(snapshot.projects[0]?.review.titlePrefix, 'PM');
	assert.equal(snapshot.projects[0]?.review.unsupportedReason, 'unsupported-provider');
});

test('GitService buildProjectSnapshot can defer review resolution during full hydration', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	let reviewCalls = 0;

	service.getReviewRequestTitlePrefixSetting = () => 'PM';
	service.getCurrentBranch = async () => 'feature/task-42';
	service.getProjectReviewState = async () => {
		reviewCalls += 1;
		return {
			remote: null,
			request: null,
			error: '',
			setupAction: null,
			titlePrefix: '',
			unsupportedReason: null,
		};
	};
	service.listLocalBranches = async () => new Map([
		['feature/task-42', {
			name: 'feature/task-42',
			current: true,
			upstream: 'origin/feature/task-42',
			ahead: 0,
			behind: 0,
			stale: false,
			sha: '1234567890abcdef',
			author: 'Git User',
			committedAt: '2026-04-24T12:00:00.000Z',
			subject: 'Latest change',
		}],
	]);
	service.listRemoteBranchNames = async () => new Set<string>(['main']);
	service.getChangeGroups = async () => ({
		merge: [],
		staged: [],
		workingTree: [],
		untracked: [],
	});

	const snapshot = await service.buildProjectSnapshot('api', '/tmp/api', 'feature/task-42', ['main'], {
		detailLevel: 'full',
		includeChangeDetails: false,
		includeReviewState: false,
	});

	assert.equal(reviewCalls, 0);
	assert.equal(snapshot.reviewHydrated, false);
	assert.equal(snapshot.review.titlePrefix, 'PM');
	assert.equal(snapshot.changeDetailsHydrated, false);
});

test('GitService buildProjectSnapshot can defer branch enumeration during full hydration', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	let listLocalBranchesCalls = 0;
	let listRemoteBranchNamesCalls = 0;

	service.getReviewRequestTitlePrefixSetting = () => 'PM';
	service.getCurrentBranch = async () => 'feature/task-42';
	service.getProjectReviewState = async () => ({
		remote: null,
		request: null,
		error: '',
		setupAction: null,
		titlePrefix: '',
		unsupportedReason: null,
	});
	service.listLocalBranches = async () => {
		listLocalBranchesCalls += 1;
		return new Map();
	};
	service.listRemoteBranchNames = async () => {
		listRemoteBranchNamesCalls += 1;
		return new Set<string>(['main']);
	};
	service.getChangeGroups = async () => ({
		merge: [],
		staged: [],
		workingTree: [],
		untracked: [],
	});

	const snapshot = await service.buildProjectSnapshot('api', '/tmp/api', 'feature/task-42', ['main'], {
		detailLevel: 'full',
		includeChangeDetails: false,
		includeBranchDetails: false,
		includeReviewState: false,
	});

	assert.equal(listLocalBranchesCalls, 0);
	assert.equal(listRemoteBranchNamesCalls, 0);
	assert.equal(snapshot.branchDetailsHydrated, false);
	assert.deepEqual(snapshot.branches, []);
	assert.equal(snapshot.upstream, '');
});

test('GitService getGitOverlayProjectBranchDetails resolves only branch metadata for the requested project', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	let changeGroupCalls = 0;
	let reviewCalls = 0;

	service.getCurrentBranch = async () => 'feature/task-42';
	service.getChangeGroups = async () => {
		changeGroupCalls += 1;
		return {
			merge: [],
			staged: [],
			workingTree: [],
			untracked: [],
		};
	};
	service.getProjectReviewState = async () => {
		reviewCalls += 1;
		return {
			remote: null,
			request: null,
			error: '',
			setupAction: null,
			titlePrefix: '',
			unsupportedReason: null,
		};
	};
	service.listLocalBranches = async () => new Map([
		['feature/task-42', {
			name: 'feature/task-42',
			current: true,
			upstream: 'origin/feature/task-42',
			ahead: 0,
			behind: 0,
			stale: false,
			sha: '1234567890abcdef',
			author: 'Git User',
			committedAt: '2026-04-24T12:00:00.000Z',
			subject: 'Latest change',
		}],
	]);
	service.listRemoteBranchNames = async () => new Set<string>(['main', 'feature/task-42']);

	const branchDetails = await service.getGitOverlayProjectBranchDetails(
		new Map([['api', '/tmp/api']]),
		'api',
		'feature/task-42',
		['main'],
	);

	assert.equal(changeGroupCalls, 0);
	assert.equal(reviewCalls, 0);
	assert.equal(branchDetails?.upstream, 'origin/feature/task-42');
	assert.equal(branchDetails?.branches.some((branch: any) => branch.name === 'feature/task-42'), true);
});

test('GitService getGitOverlayProjectBranchDetails reuses provided current branch and skips extra branch lookup', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	let getCurrentBranchCalls = 0;

	service.getCurrentBranch = async () => {
		getCurrentBranchCalls += 1;
		return 'feature/from-git';
	};
	service.listLocalBranches = async () => new Map([
		['feature/task-42', {
			name: 'feature/task-42',
			current: true,
			upstream: 'origin/feature/task-42',
			ahead: 0,
			behind: 0,
			stale: false,
			sha: '1234567890abcdef',
			author: 'Git User',
			committedAt: '2026-04-24T12:00:00.000Z',
			subject: 'Latest change',
		}],
	]);
	service.listRemoteBranchNames = async () => new Set<string>(['main', 'feature/task-42']);

	const branchDetails = await service.getGitOverlayProjectBranchDetails(
		new Map([['api', '/tmp/api']]),
		'api',
		'feature/task-42',
		['main'],
		'feature/task-42',
	);

	assert.equal(getCurrentBranchCalls, 0);
	assert.equal(branchDetails?.branches.some((branch: any) => branch.name === 'feature/task-42'), true);
	assert.equal(branchDetails?.upstream, 'origin/feature/task-42');
});

test('GitService getGitOverlayProjectReviewState resolves only review state for the requested project', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	let reviewCall: { projectPath: string; branchName: string } | null = null;

	service.getProjectReviewState = async (projectPath: string, branchName: string) => {
		reviewCall = { projectPath, branchName };
		return {
			remote: null,
			request: null,
			error: '',
			setupAction: null,
			titlePrefix: 'PM',
			unsupportedReason: null,
		};
	};

	const reviewState = await service.getGitOverlayProjectReviewState(
		new Map([['api', '/tmp/api']]),
		'api',
		'feature/task-42',
	);

	assert.deepEqual(reviewCall, { projectPath: '/tmp/api', branchName: 'feature/task-42' });
	assert.equal(reviewState?.titlePrefix, 'PM');
	assert.equal(reviewState?.remote, null);
});

test('GitService getProjectReviewState resolves title prefix in parallel with remote context', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const deferredTitlePrefix = createDeferred<string>();
	const deferredRemoteContext = createDeferred<{
		remote: null;
		unsupportedReason: 'missing-remote';
	}>();
	let titlePrefixStarted = false;
	let remoteContextStarted = false;

	service.resolveReviewRequestTitlePrefix = async () => {
		titlePrefixStarted = true;
		return deferredTitlePrefix.promise;
	};
	service.resolveReviewRemoteContext = async () => {
		remoteContextStarted = true;
		return deferredRemoteContext.promise;
	};

	const reviewStatePromise = service.getProjectReviewState('/tmp/api', 'feature/task-42');
	await Promise.resolve();

	assert.equal(titlePrefixStarted, true);
	assert.equal(remoteContextStarted, true);

	deferredTitlePrefix.resolve('PM');
	deferredRemoteContext.resolve({
		remote: null,
		unsupportedReason: 'missing-remote',
	});

	const reviewState = await reviewStatePromise;
	assert.equal(reviewState.titlePrefix, 'PM');
	assert.equal(reviewState.remote, null);
	assert.equal(reviewState.unsupportedReason, 'missing-remote');
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

test('GitService resolveReviewRemoteContext caches repeated unsupported remote lookups for the same branch', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	let getBranchRemoteCalls = 0;
	let remoteGetUrlCalls = 0;

	service.getBranchRemote = async () => {
		getBranchRemoteCalls += 1;
		return 'origin';
	};
	service.runGitFileCommandOptional = async (_projectPath: string, args: string[]) => {
		if (args[0] === 'remote' && args[1] === 'get-url') {
			remoteGetUrlCalls += 1;
			return 'https://git.skladno.com/acme/api.git';
		}

		throw new Error(`Unexpected git command: ${args.join(' ')}`);
	};

	const first = await service.resolveReviewRemoteContext('/tmp/api', 'feature/task-42');
	const second = await service.resolveReviewRemoteContext('/tmp/api', 'feature/task-42');

	assert.equal(getBranchRemoteCalls, 1);
	assert.equal(remoteGetUrlCalls, 1);
	assert.equal(first.unsupportedReason, 'unsupported-provider');
	assert.equal(second.unsupportedReason, 'unsupported-provider');
	assert.equal(first.remote?.host, 'git.skladno.com');
	assert.equal(second.remote?.host, 'git.skladno.com');
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

test('GitService resolveReviewRequestTitlePrefix caches git user fallback for repeated calls', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	let gitUserNameCalls = 0;

	service.getReviewRequestTitlePrefixSetting = () => '';
	service.getGitUserName = async () => {
		gitUserNameCalls += 1;
		return 'Git User';
	};

	const first = await service.resolveReviewRequestTitlePrefix('/tmp/api');
	const second = await service.resolveReviewRequestTitlePrefix('/tmp/api');

	assert.equal(first, 'Git User');
	assert.equal(second, 'Git User');
	assert.equal(gitUserNameCalls, 1);
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

test('GitService createReviewRequests starts review creation in parallel and preserves request order', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const apiDeferred = createDeferred<void>();
	const webDeferred = createDeferred<void>();
	const startedProjects: string[] = [];
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

	service.getReviewRemote = async () => remote;
	service.isCliAuthenticated = async () => true;
	service.getExistingReviewRequest = async () => null;
	service.createGitHubReviewRequest = async (projectPath: string) => {
		const project = projectPath.endsWith('/api') ? 'api' : 'web';
		startedProjects.push(project);
		if (project === 'api') {
			await apiDeferred.promise;
			return;
		}
		await webDeferred.promise;
	};

	const resultPromise = service.createReviewRequests(
		new Map([
			['api', '/tmp/api'],
			['web', '/tmp/web'],
		]),
		{
			id: 'prompt-62',
			taskNumber: '62',
			title: 'Parallel review requests',
			description: '',
			branch: 'feature/task-62',
		} as any,
		[
			{ project: 'api', targetBranch: 'main', title: '62 API review' },
			{ project: 'web', targetBranch: 'develop', title: '62 Web review' },
		],
	);

	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(startedProjects, ['api', 'web']);

	webDeferred.resolve();
	apiDeferred.resolve();

	const result = await resultPromise;
	assert.equal(result.success, true);
	assert.deepEqual(result.changedProjects, ['api', 'web']);
	assert.deepEqual(result.skippedProjects, []);
	assert.deepEqual(result.errors, []);
});

test('GitService commitStagedChanges starts commits in parallel and preserves message order', async () => {
	const { GitService } = await importGitService();
	const service = new GitService() as any;
	const apiDeferred = createDeferred<void>();
	const webDeferred = createDeferred<void>();
	const startedProjects: string[] = [];
	const commitCalls = new Map<string, string[]>();

	service.runGitFileCommandOptional = async (_projectPath: string, args: string[]) => {
		assert.deepEqual(args, ['diff', '--cached', '--name-only']);
		return 'file.txt';
	};
	service.runGitFileMutation = async (projectPath: string, args: string[]) => {
		const project = projectPath.endsWith('/api') ? 'api' : 'web';
		startedProjects.push(project);
		commitCalls.set(project, args);
		if (project === 'api') {
			await apiDeferred.promise;
			return;
		}
		await webDeferred.promise;
	};

	const resultPromise = service.commitStagedChanges(
		new Map([
			['api', '/tmp/api'],
			['web', '/tmp/web'],
		]),
		[
			{ project: 'api', message: 'API subject\n\nAPI body' },
			{ project: 'web', message: 'Web subject' },
		],
	);

	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(startedProjects, ['api', 'web']);

	webDeferred.resolve();
	apiDeferred.resolve();

	const result = await resultPromise;
	assert.equal(result.success, true);
	assert.deepEqual(result.changedProjects, ['api', 'web']);
	assert.deepEqual(result.skippedProjects, []);
	assert.deepEqual(result.errors, []);
	assert.deepEqual(commitCalls.get('api'), ['commit', '-m', 'API subject', '-m', 'API body']);
	assert.deepEqual(commitCalls.get('web'), ['commit', '-m', 'Web subject']);
});