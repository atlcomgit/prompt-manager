import test from 'node:test';
import assert from 'node:assert/strict';

import type { Prompt } from '../src/types/prompt.js';

type ModuleLoaderWithLoad = typeof import('node:module') & {
	_load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const moduleLoader = require('node:module') as ModuleLoaderWithLoad;
const originalModuleLoad = moduleLoader._load;
moduleLoader._load = (request, parent, isMain) => {
	if (request === 'vscode') {
		class Disposable {
			constructor(private readonly disposeCallback: () => void = () => undefined) { }

			dispose(): void {
				this.disposeCallback();
			}
		}
		return {
			Disposable,
			window: {
				createOutputChannel: () => ({
					appendLine: () => undefined,
					show: () => undefined,
					dispose: () => undefined,
				}),
			},
			workspace: {
				getConfiguration: () => ({ get: () => [] }),
			},
		};
	}
	return originalModuleLoad(request, parent, isMain);
};
const { PromptDashboardService } = require('../src/services/promptDashboardService.js') as typeof import('../src/services/promptDashboardService.js');
moduleLoader._load = originalModuleLoad;

function createPrompt(overrides: Partial<Prompt> = {}): Prompt {
	return {
		id: 'task-107',
		promptUuid: 'uuid-107',
		title: 'Prompt dashboard',
		description: '',
		content: 'Review workspace branches',
		report: '',
		status: 'in-progress',
		favorite: false,
		archived: false,
		projects: ['api', 'web'],
		languages: [],
		frameworks: [],
		skills: [],
		mcpTools: [],
		hooks: [],
		contextFiles: [],
		httpExamples: '',
		taskNumber: '107',
		branch: 'feature/task-107',
		trackedBranch: 'main',
		trackedBranchesByProject: { api: 'main', web: 'main' },
		model: 'copilot:gpt-5',
		chatMode: 'agent',
		chatSessionIds: [],
		chatRequestAutoCompleteAfter: undefined,
		notes: '',
		customGroupIds: [],
		progress: 55,
		timeSpentWriting: 0,
		timeSpentImplementing: 0,
		timeSpentOnTask: 0,
		timeSpentUntracked: 0,
		createdAt: '2026-04-29T10:00:00.000Z',
		updatedAt: '2026-04-29T10:05:00.000Z',
		...overrides,
	};
}

function createSnapshotProject(project: string, overrides: Record<string, unknown> = {}) {
	return {
		project,
		repositoryPath: `/${project}`,
		available: true,
		error: '',
		currentBranch: 'feature/task-107',
		promptBranch: 'feature/task-107',
		trackedBranch: 'main',
		dirty: false,
		hasConflicts: false,
		ahead: 0,
		behind: 0,
		branches: [],
		recentCommits: [],
		review: { request: null, unsupportedReason: null, error: '', remote: null },
		changeGroups: { merge: [], staged: [], workingTree: [], untracked: [] },
		...overrides,
	};
}

test('PromptDashboardService falls back to all workspace projects for invalid prompt scope', async () => {
	const requestedProjectSets: string[][] = [];
	const workspaceFolders = new Map([
		['api', '/workspace/api'],
		['web', '/workspace/web'],
		['worker', '/workspace/worker'],
		['docs', '/workspace/docs'],
	]);
	const service = new PromptDashboardService(
		{
			listPrompts: async () => [],
			getDailyTime: async () => ({}),
			getDailyTimeTotalInRange: () => 0,
			readAgentProgress: async () => undefined,
		} as any,
		{
			getWorkspaceFolders: () => Array.from(workspaceFolders.keys()),
			getWorkspaceFolderPaths: () => workspaceFolders,
		} as any,
		{
			getGitOverlaySnapshot: async (_paths: Map<string, string>, projectNames: string[]) => {
				requestedProjectSets.push(projectNames);
				return {
					trackedBranches: ['main'],
					projects: projectNames.map(project => createSnapshotProject(project)),
				};
			},
			getGitOverlayProjectPipelineStatus: async () => null,
			getGitOverlayParallelBranchSummaries: async () => [],
			getCommitChangedFiles: async () => [],
		} as any,
		{
			analyzePromptDashboardReview: async () => 'ok',
		} as any,
	);

	const snapshot = await service.refreshPrompt(createPrompt({
		projects: ['missing-a', 'missing-b'],
		trackedBranchesByProject: { 'missing-a': 'main' },
	}));

	assert.deepEqual(requestedProjectSets[0], ['api', 'web', 'worker', 'docs']);
	assert.deepEqual(snapshot.projects.data.projects.map(project => project.project), ['api', 'web', 'worker', 'docs']);
	service.dispose();
});

test('PromptDashboardService reuses AI review results across prompt switches with the same fingerprint', async () => {
	let analysisCalls = 0;
	const workspaceFolders = new Map([
		['api', '/workspace/api'],
		['web', '/workspace/web'],
	]);
	const service = new PromptDashboardService(
		{
			listPrompts: async () => [],
			getDailyTime: async () => ({}),
			getDailyTimeTotalInRange: () => 0,
			readAgentProgress: async () => undefined,
		} as any,
		{
			getWorkspaceFolders: () => Array.from(workspaceFolders.keys()),
			getWorkspaceFolderPaths: () => workspaceFolders,
		} as any,
		{
			getGitOverlaySnapshot: async (_paths: Map<string, string>, projectNames: string[]) => ({
				trackedBranches: ['main'],
				projects: projectNames.map(project => createSnapshotProject(project)),
			}),
			getGitOverlayProjectPipelineStatus: async () => null,
			getGitOverlayParallelBranchSummaries: async () => [],
			getCommitChangedFiles: async () => [],
		} as any,
		{
			analyzePromptDashboardReview: async () => {
				analysisCalls += 1;
				return 'cached analysis';
			},
		} as any,
	);

	await service.refreshPrompt(createPrompt({ id: 'task-a', promptUuid: 'uuid-a' }));
	await service.refreshPrompt(createPrompt({ id: 'task-b', promptUuid: 'uuid-b' }));

	assert.equal(analysisCalls, 1);
	service.dispose();
});

test('PromptDashboardService reuses shared projects and AI review in the initial snapshot after a prompt switch', async () => {
	let analysisCalls = 0;
	const workspaceFolders = new Map([
		['api', '/workspace/api'],
		['web', '/workspace/web'],
	]);
	const service = new PromptDashboardService(
		{
			listPrompts: async () => [],
			getDailyTime: async () => ({}),
			getDailyTimeTotalInRange: () => 0,
			readAgentProgress: async () => undefined,
		} as any,
		{
			getWorkspaceFolders: () => Array.from(workspaceFolders.keys()),
			getWorkspaceFolderPaths: () => workspaceFolders,
		} as any,
		{
			getGitOverlaySnapshot: async (_paths: Map<string, string>, projectNames: string[]) => ({
				trackedBranches: ['main'],
				projects: projectNames.map(project => createSnapshotProject(project)),
			}),
			getGitOverlayProjectPipelineStatus: async () => null,
			getGitOverlayParallelBranchSummaries: async () => [],
			getCommitChangedFiles: async () => [],
		} as any,
		{
			analyzePromptDashboardReview: async () => {
				analysisCalls += 1;
				return 'cached analysis';
			},
		} as any,
	);

	await service.refreshPrompt(createPrompt({ id: 'task-a', promptUuid: 'uuid-a' }));
	const nextSnapshot = service.getSnapshot(createPrompt({ id: 'task-b', promptUuid: 'uuid-b' }));

	assert.equal(analysisCalls, 1);
	assert.equal(nextSnapshot.projects.data.projects.length, 2);
	assert.equal(nextSnapshot.aiAnalysis.data?.status, 'completed');
	assert.equal(nextSnapshot.aiAnalysis.data?.content, 'cached analysis');
	service.dispose();
});

test('PromptDashboardService resolves pipeline status against the current project branch', async () => {
	const pipelineBranches: string[] = [];
	const workspaceFolders = new Map([
		['api', '/workspace/api'],
	]);
	const service = new PromptDashboardService(
		{
			listPrompts: async () => [],
			getDailyTime: async () => ({}),
			getDailyTimeTotalInRange: () => 0,
			readAgentProgress: async () => undefined,
		} as any,
		{
			getWorkspaceFolders: () => Array.from(workspaceFolders.keys()),
			getWorkspaceFolderPaths: () => workspaceFolders,
		} as any,
		{
			getGitOverlaySnapshot: async (_paths: Map<string, string>, projectNames: string[]) => ({
				trackedBranches: ['main'],
				projects: projectNames.map(project => createSnapshotProject(project, {
					currentBranch: 'feature/current-project-branch',
					promptBranch: 'feature/task-107',
				})),
			}),
			getGitOverlayProjectPipelineStatus: async (_paths: Map<string, string>, _project: string, branch: string) => {
				pipelineBranches.push(branch);
				return null;
			},
			getGitOverlayParallelBranchSummaries: async () => [],
			getCommitChangedFiles: async () => [],
		} as any,
		{
			analyzePromptDashboardReview: async () => 'ok',
		} as any,
	);

	await service.refreshPrompt(createPrompt({ projects: ['api'], branch: 'feature/prompt-branch' }));

	assert.deepEqual(pipelineBranches, ['feature/current-project-branch']);
	service.dispose();
});

test('PromptDashboardService uses applyBranchTargetsByProject when switching a project to the prompt branch', async () => {
	const applyCalls: Array<{
		projects: string[];
		promptBranch: string;
		sourceBranchesByProject: Record<string, string>;
		targetBranchesByProject: Record<string, string>;
	}> = [];
	const switchCalls: Array<{ projects: string[]; branch: string }> = [];
	const workspaceFolders = new Map([
		['api', '/workspace/api'],
		['web', '/workspace/web'],
	]);
	const service = new PromptDashboardService(
		{
			listPrompts: async () => [],
			getDailyTime: async () => ({}),
			getDailyTimeTotalInRange: () => 0,
			readAgentProgress: async () => undefined,
		} as any,
		{
			getWorkspaceFolders: () => Array.from(workspaceFolders.keys()),
			getWorkspaceFolderPaths: () => workspaceFolders,
		} as any,
		{
			applyBranchTargetsByProject: async (_paths: Map<string, string>, projects: string[], promptBranch: string, sourceBranchesByProject: Record<string, string>, targetBranchesByProject: Record<string, string>) => {
				applyCalls.push({ projects, promptBranch, sourceBranchesByProject, targetBranchesByProject });
				return { success: true, errors: [] };
			},
			switchBranch: async (_paths: Map<string, string>, projects: string[], branch: string) => {
				switchCalls.push({ projects, branch });
				return { success: true, errors: [] };
			},
		} as any,
		{
			analyzePromptDashboardReview: async () => 'ok',
		} as any,
	);

	await service.switchProjectBranches(createPrompt(), {
		api: 'feature/task-107',
		web: 'main',
	});

	assert.deepEqual(applyCalls, [{
		projects: ['api'],
		promptBranch: 'feature/task-107',
		sourceBranchesByProject: { api: 'main' },
		targetBranchesByProject: { api: 'feature/task-107' },
	}]);
	assert.deepEqual(switchCalls, [{ projects: ['web'], branch: 'main' }]);
	service.dispose();
});

test('PromptDashboardService falls back from yesterday to the latest previous active day', async () => {
	const RealDate = Date;
	(globalThis as typeof globalThis & { Date: DateConstructor }).Date = class extends RealDate {
		constructor(value?: string | number | Date) {
			if (arguments.length === 0) {
				super('2026-04-30T12:00:00.000Z');
				return;
			}
			super(value as string | number | Date);
		}

		static now(): number {
			return new RealDate('2026-04-30T12:00:00.000Z').getTime();
		}
	} as unknown as DateConstructor;

	try {
		const service = new PromptDashboardService(
			{
				listPrompts: async () => [
					createPrompt({ id: 'alpha', title: 'Alpha', taskNumber: '1', updatedAt: '2026-04-29T10:00:00.000Z' }),
					createPrompt({ id: 'beta', title: 'Beta', taskNumber: '2', updatedAt: '2026-04-27T10:00:00.000Z' }),
				],
				getDailyTime: async (promptId: string) => promptId === 'beta'
					? {
						'2026-04-27': { writing: 0, implementing: 360_000, onTask: 0, untracked: 0 },
					}
					: {
						'2026-04-30': { writing: 60_000, implementing: 0, onTask: 0, untracked: 0 },
					},
				getDailyTimeTotalInRange: (dailyData: Record<string, { writing?: number; implementing?: number; onTask?: number; untracked?: number }>, dateFrom: string, dateTo: string) => {
					let total = 0;
					for (const [date, entry] of Object.entries(dailyData)) {
						if (date >= dateFrom && date <= dateTo) {
							total += (entry.writing || 0) + (entry.implementing || 0) + (entry.onTask || 0) + (entry.untracked || 0);
						}
					}
					return total;
				},
				readAgentProgress: async () => undefined,
			} as any,
			{} as any,
			{} as any,
			{} as any,
		);

		const activity = await (service as any).loadActivityData();

		assert.equal(activity.yesterdayLabel, '27.04');
		assert.deepEqual(activity.yesterday.map((item: { id: string }) => item.id), ['beta']);
		service.dispose();
	} finally {
		(globalThis as typeof globalThis & { Date: DateConstructor }).Date = RealDate;
	}
});

test('PromptDashboardService force refresh reruns after stale in-flight project loading', async () => {
	let snapshotCallCount = 0;
	let resolveFirstSnapshot: (value: { trackedBranches: string[]; projects: Array<Record<string, unknown>> }) => void = () => {
		throw new Error('First dashboard snapshot resolver was not initialized.');
	};
	const firstSnapshotPromise = new Promise<{ trackedBranches: string[]; projects: Array<Record<string, unknown>> }>((resolve) => {
		resolveFirstSnapshot = resolve;
	});
	const workspaceFolders = new Map([
		['api', '/workspace/api'],
	]);
	const service = new PromptDashboardService(
		{
			listPrompts: async () => [],
			getDailyTime: async () => ({}),
			getDailyTimeTotalInRange: () => 0,
			readAgentProgress: async () => undefined,
		} as any,
		{
			getWorkspaceFolders: () => Array.from(workspaceFolders.keys()),
			getWorkspaceFolderPaths: () => workspaceFolders,
		} as any,
		{
			getGitOverlaySnapshot: async (_paths: Map<string, string>, projectNames: string[]) => {
				snapshotCallCount += 1;
				if (snapshotCallCount === 1) {
					return firstSnapshotPromise as Promise<{ trackedBranches: string[]; projects: Array<Record<string, unknown>> }>;
				}
				return {
					trackedBranches: ['main'],
					projects: projectNames.map(project => createSnapshotProject(project, { currentBranch: 'main' })),
				};
			},
			getGitOverlayProjectPipelineStatus: async () => null,
			getGitOverlayParallelBranchSummaries: async () => [],
			getCommitChangedFiles: async () => [],
		} as any,
		{
			analyzePromptDashboardReview: async () => 'ok',
		} as any,
	);

	const initialRefreshPromise = service.refreshPrompt(createPrompt({ projects: ['api'] }));
	const refreshPromise = service.refreshPrompt(createPrompt({ projects: ['api'] }));
	await Promise.resolve();
	resolveFirstSnapshot({
		trackedBranches: ['main'],
		projects: [createSnapshotProject('api', { currentBranch: 'feature/task-107' })],
	});

	await initialRefreshPromise;
	const refreshedSnapshot = await refreshPromise;

	assert.equal(snapshotCallCount, 2);
	assert.equal(refreshedSnapshot.projects.data.projects[0]?.currentBranch, 'main');
	service.dispose();
});

test('PromptDashboardService pauses stale project enrichment when prompt switching starts', async () => {
	let resolveSnapshot: (value: { trackedBranches: string[]; projects: Array<Record<string, unknown>> }) => void = () => {
		throw new Error('Dashboard snapshot resolver was not initialized.');
	};
	const deferredSnapshot = new Promise<{ trackedBranches: string[]; projects: Array<Record<string, unknown>> }>((resolve) => {
		resolveSnapshot = resolve;
	});
	let pipelineCalls = 0;
	let parallelBranchCalls = 0;
	let changedFilesCalls = 0;
	const workspaceFolders = new Map([
		['api', '/workspace/api'],
		['web', '/workspace/web'],
	]);
	const service = new PromptDashboardService(
		{
			listPrompts: async () => [],
			getDailyTime: async () => ({}),
			getDailyTimeTotalInRange: () => 0,
			readAgentProgress: async () => undefined,
		} as any,
		{
			getWorkspaceFolders: () => Array.from(workspaceFolders.keys()),
			getWorkspaceFolderPaths: () => workspaceFolders,
		} as any,
		{
			getGitOverlaySnapshot: async (_paths: Map<string, string>, projectNames: string[]) => {
				await deferredSnapshot;
				return {
					trackedBranches: ['main'],
					projects: projectNames.map(project => createSnapshotProject(project, {
						recentCommits: [{
							sha: `${project}-sha`,
							shortSha: `${project}-sha`.slice(0, 7),
							subject: `${project} commit`,
							body: '',
							authorName: 'Test',
							authorEmail: 'test@example.com',
							committedAt: '2026-04-29T10:00:00.000Z',
							parents: [],
							refNames: [],
						}]
					})),
				};
			},
			getGitOverlayProjectPipelineStatus: async () => {
				pipelineCalls += 1;
				return null;
			},
			getGitOverlayParallelBranchSummaries: async () => {
				parallelBranchCalls += 1;
				return [];
			},
			getCommitChangedFiles: async () => {
				changedFilesCalls += 1;
				return [];
			},
		} as any,
		{
			analyzePromptDashboardReview: async () => 'ok',
		} as any,
	);

	const refreshPromise = service.refreshPrompt(createPrompt({ projects: ['api', 'web'] }));
	await Promise.resolve();
	service.pauseActiveScope('prompt-switch', { nextPromptId: 'task-108', requestVersion: 8 });
	resolveSnapshot({
		trackedBranches: ['main'],
		projects: [createSnapshotProject('api'), createSnapshotProject('web')],
	});

	const refreshedSnapshot = await refreshPromise;

	assert.equal(pipelineCalls, 0);
	assert.equal(parallelBranchCalls, 0);
	assert.equal(changedFilesCalls, 0);
	assert.deepEqual(refreshedSnapshot.projects.data.projects, []);
	service.dispose();
});

test('PromptDashboardService defers automatic dashboard refresh after getSnapshot', async () => {
	const realSetTimeout = global.setTimeout;
	const realClearTimeout = global.clearTimeout;
	const queuedTimers: Array<() => void> = [];
	(global as typeof globalThis & {
		setTimeout: typeof setTimeout;
		clearTimeout: typeof clearTimeout;
	}).setTimeout = (((callback: (...args: any[]) => void) => {
		queuedTimers.push(() => callback());
		return { unref() { return undefined; } } as unknown as NodeJS.Timeout;
	}) as unknown as typeof setTimeout);
	(global as typeof globalThis & {
		setTimeout: typeof setTimeout;
		clearTimeout: typeof clearTimeout;
	}).clearTimeout = (((_timer: NodeJS.Timeout) => undefined) as unknown as typeof clearTimeout);

	try {
		let snapshotCalls = 0;
		const workspaceFolders = new Map([
			['api', '/workspace/api'],
		]);
		const service = new PromptDashboardService(
			{
				listPrompts: async () => [],
				getDailyTime: async () => ({}),
				getDailyTimeTotalInRange: () => 0,
				readAgentProgress: async () => undefined,
			} as any,
			{
				getWorkspaceFolders: () => Array.from(workspaceFolders.keys()),
				getWorkspaceFolderPaths: () => workspaceFolders,
			} as any,
			{
				getGitOverlaySnapshot: async (_paths: Map<string, string>, projectNames: string[]) => {
					snapshotCalls += 1;
					return {
						trackedBranches: ['main'],
						projects: projectNames.map(project => createSnapshotProject(project)),
					};
				},
				getGitOverlayProjectPipelineStatus: async () => null,
				getGitOverlayParallelBranchSummaries: async () => [],
				getCommitChangedFiles: async () => [],
			} as any,
			{
				analyzePromptDashboardReview: async () => 'ok',
			} as any,
		);

		service.getSnapshot(createPrompt({ projects: ['api'] }));

		assert.equal(snapshotCalls, 0);
		assert.equal(queuedTimers.length, 1);

		queuedTimers[0]();
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(snapshotCalls, 1);
		service.dispose();
	} finally {
		(global as typeof globalThis & { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }).setTimeout = realSetTimeout;
		(global as typeof globalThis & { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }).clearTimeout = realClearTimeout;
	}
});