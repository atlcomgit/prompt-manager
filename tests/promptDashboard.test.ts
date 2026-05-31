import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildPromptDashboardFileDiffTitle,
	compactPromptDashboardMiddleLabel,
	buildPromptDashboardAnalysisFingerprint,
	buildPromptDashboardStatusDataFromPrompt,
	buildPromptDashboardBranchActions,
	buildPromptDashboardDockerComposeBusyAction,
	buildPromptDashboardScopeKey,
	createPromptDashboardWidgetSnapshot,
	fitPromptDashboardPathPartsToWidth,
	formatPromptDashboardCompactPathParts,
	getPromptDashboardStatusProgress,
	syncPromptDashboardStatusFromPrompt,
	preservePromptDashboardProjectsLoadingSnapshot,
	PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS,
	resolvePromptDashboardCacheState,
	resolvePromptDashboardExpandRefreshTarget,
	resolvePromptDashboardMode,
	shouldReleasePromptDashboardRequestId,
	shouldRetainPromptDashboardBusyActionOnNotice,
	shouldAcceptPromptDashboardAnalysisMessage,
	shouldAcceptPromptDashboardRequestMessage,
	shouldClearPromptDashboardBusyActionFromWidget,
	shouldRequestPromptDashboardSnapshot,
	splitPromptDashboardPathParts,
	splitPromptDashboardActivityByDay,
} from '../src/utils/promptDashboard.js';
import type { PromptDashboardProjectSummary, PromptDashboardProjectsData, PromptDashboardPromptActivityItem, PromptDashboardScope, PromptDashboardSnapshot } from '../src/types/promptDashboard.js';

function createEmptyDockerWidget() {
	return createPromptDashboardWidgetSnapshot('docker', {
		enabled: true,
		available: true,
		generatedAt: '2026-05-30T10:00:00.000Z',
		defaultViewMode: 'tree' as const,
		composeFilePatterns: [],
		projects: [],
		totalContainers: 0,
		runningContainers: 0,
		stoppedContainers: 0,
		warningContainers: 0,
		errorContainers: 0,
	});
}

test('resolvePromptDashboardMode switches to full only when the right side can fit widgets', () => {
	assert.equal(resolvePromptDashboardMode(1119, 840), 'compact');
	assert.equal(resolvePromptDashboardMode(1120, 840), 'full');
});

test('compactPromptDashboardMiddleLabel keeps the start and ending of a long project name', () => {
	assert.equal(
		compactPromptDashboardMiddleLabel('prompt-manager-internal-tools', 18),
		'prompt-m...l-tools',
	);
	assert.equal(
		compactPromptDashboardMiddleLabel('api', 18),
		'api',
	);
});

test('formatPromptDashboardCompactPathParts shortens long directory segments and keeps the file name', () => {
	assert.deepEqual(
		formatPromptDashboardCompactPathParts('app/Domain/Controllers/User.ts', 20),
		{
			fileName: 'User.ts',
			directoryPath: 'app/Doma../Controll...',
			displayPath: 'app/Doma../Controll.../User.ts',
		},
	);
	assert.deepEqual(
		formatPromptDashboardCompactPathParts('src/app.ts', 20),
		{
			fileName: 'app.ts',
			directoryPath: 'src',
			displayPath: 'src/app.ts',
		},
	);
});

test('splitPromptDashboardPathParts keeps the full path intact without UI compaction', () => {
	assert.deepEqual(
		splitPromptDashboardPathParts('app/Domain/Controllers/User.ts'),
		{
			fileName: 'User.ts',
			directoryPath: 'app/Domain/Controllers',
			displayPath: 'app/Domain/Controllers/User.ts',
		},
	);
});

test('fitPromptDashboardPathPartsToWidth keeps the full path when the measured width fits', () => {
	assert.deepEqual(
		fitPromptDashboardPathPartsToWidth('src/features/editor/App.tsx', {
			availableWidth: 64,
			measureText: value => value.length,
		}),
		{
			fileName: 'App.tsx',
			directoryPath: 'src/features/editor',
			displayPath: 'src/features/editor/App.tsx',
		},
	);
});

test('fitPromptDashboardPathPartsToWidth shortens the longest directory segment first', () => {
	assert.deepEqual(
		fitPromptDashboardPathPartsToWidth('src/VeryLongDirectoryName/lib/index.ts', {
			availableWidth: 20,
			measureText: value => value.length,
		}),
		{
			fileName: 'index.ts',
			directoryPath: 'src/VeryLongD.../lib',
			displayPath: 'src/VeryLongD.../lib/index.ts',
		},
	);
});

test('fitPromptDashboardPathPartsToWidth keeps shrinking additional long segments when one is not enough', () => {
	assert.deepEqual(
		fitPromptDashboardPathPartsToWidth('modules/AnotherVeryLongFolderName/SecondMassiveDirectory/File.ts', {
			availableWidth: 16,
			measureText: value => value.length,
		}),
		{
			fileName: 'File.ts',
			directoryPath: 'm.../An.../Se...',
			displayPath: 'm.../An.../Se.../File.ts',
		},
	);
});

test('fitPromptDashboardPathPartsToWidth can drop the directory prefix completely when there is no width budget', () => {
	assert.deepEqual(
		fitPromptDashboardPathPartsToWidth('src/features/editor/App.tsx', {
			availableWidth: 0,
			measureText: value => value.length,
		}),
		{
			fileName: 'App.tsx',
			directoryPath: '',
			displayPath: 'App.tsx',
		},
	);
});

test('buildPromptDashboardFileDiffTitle prefixes incoming diffs with a readable author title', () => {
	assert.equal(
		buildPromptDashboardFileDiffTitle({
			project: 'api',
			filePath: 'src/deep/path/app.ts',
			mode: 'branch',
			ref: 'origin/main',
			baseRef: 'HEAD',
			author: 'Jane Doe',
		}),
		'Опережающие файлы (Jane Doe) | app.ts | api',
	);
	assert.equal(
		buildPromptDashboardFileDiffTitle({
			project: 'api',
			filePath: 'src/app.ts',
			mode: 'commit',
			ref: '8a13410a35a3289f44d7c36a58842be2a00c1f',
		}),
		'app.ts | commit 8a13410a | api',
	);
});

test('shouldRequestPromptDashboardSnapshot reuses a matching snapshot after hidden or compact transitions', () => {
	assert.equal(shouldRequestPromptDashboardSnapshot({
		mode: 'compact',
		isLoaded: true,
		hasSnapshot: true,
		currentFingerprint: 'same',
		lastRequestedFingerprint: 'same',
	}), false);
	assert.equal(shouldRequestPromptDashboardSnapshot({
		mode: 'full',
		isLoaded: true,
		hasSnapshot: true,
		currentFingerprint: 'same',
		lastRequestedFingerprint: 'same',
	}), false);
	assert.equal(shouldRequestPromptDashboardSnapshot({
		mode: 'full',
		isLoaded: true,
		hasSnapshot: true,
		currentFingerprint: 'next',
		lastRequestedFingerprint: 'same',
	}), true);
	assert.equal(shouldRequestPromptDashboardSnapshot({
		mode: 'full',
		isLoaded: true,
		hasSnapshot: false,
		currentFingerprint: 'same',
		lastRequestedFingerprint: 'same',
	}), true);

	assert.equal(shouldRequestPromptDashboardSnapshot({
		mode: 'full',
		isLoaded: true,
		hasSnapshot: false,
		currentFingerprint: 'scope-a',
		lastRequestedFingerprint: '',
		hasPendingExplicitRequest: true,
	}), false);
});

test('resolvePromptDashboardExpandRefreshTarget refreshes only stale or placeholder widgets after expand', () => {
	const snapshot: PromptDashboardSnapshot = {
		promptId: 'task-1',
		promptUuid: 'uuid-1',
		generatedAt: '2026-05-30T10:00:00.000Z',
		scopeKey: 'task-1::dashboard',
		activity: createPromptDashboardWidgetSnapshot('activity', {
			thresholdMs: PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS,
			today: [],
			yesterday: [],
		}, { status: 'fresh', source: 'refresh' }),
		status: createPromptDashboardWidgetSnapshot('status', {
			status: 'draft',
			totalTimeMs: 0,
			updatedAt: '2026-05-30T10:00:00.000Z',
		}, { status: 'idle', source: 'placeholder' }),
		projects: createPromptDashboardWidgetSnapshot('projects', {
			projects: [],
			loadedSections: [],
		}, { status: 'stale', source: 'cache' }),
		docker: createEmptyDockerWidget(),
		aiAnalysis: createPromptDashboardWidgetSnapshot('aiAnalysis', null, { status: 'error', source: 'refresh' }),
	};

	assert.equal(resolvePromptDashboardExpandRefreshTarget({
		section: 'activity',
		snapshot,
	}), null);
	assert.deepEqual(resolvePromptDashboardExpandRefreshTarget({
		section: 'status',
		snapshot,
	}), { type: 'widget', widget: 'status' });
	assert.deepEqual(resolvePromptDashboardExpandRefreshTarget({
		section: 'projectBranches',
		snapshot,
	}), { type: 'widget', widget: 'projects' });
	assert.deepEqual(resolvePromptDashboardExpandRefreshTarget({
		section: 'aiAnalysis',
		snapshot,
	}), { type: 'widget', widget: 'aiAnalysis' });
	assert.deepEqual(resolvePromptDashboardExpandRefreshTarget({
		section: 'dockerContainers',
		snapshot,
	}), { type: 'widget', widget: 'docker' });
	assert.equal(resolvePromptDashboardExpandRefreshTarget({
		section: 'status',
		snapshot: null,
	}), null);
});

test('shouldRetainPromptDashboardBusyActionOnNotice keeps docker loaders until widget refresh', () => {
	assert.equal(shouldRetainPromptDashboardBusyActionOnNotice({
		busyAction: 'docker:start:abc123',
		retainPromptDashboardBusy: true,
	}), true);
	assert.equal(shouldRetainPromptDashboardBusyActionOnNotice({
		busyAction: 'refresh',
		retainPromptDashboardBusy: true,
	}), false);
	assert.equal(shouldRetainPromptDashboardBusyActionOnNotice({
		busyAction: 'docker:stop:abc123',
		retainPromptDashboardBusy: false,
	}), false);
});

test('shouldReleasePromptDashboardRequestId waits for the completed widget payload', () => {
	assert.equal(shouldReleasePromptDashboardRequestId({
		activeRequestId: 'req-1',
		messageRequestId: 'req-1',
		cacheStatus: 'loading',
	}), false);
	assert.equal(shouldReleasePromptDashboardRequestId({
		activeRequestId: 'req-1',
		messageRequestId: 'req-1',
		cacheStatus: 'fresh',
	}), true);
	assert.equal(shouldReleasePromptDashboardRequestId({
		activeRequestId: 'req-1',
		messageRequestId: 'req-1',
	}), true);
	assert.equal(shouldReleasePromptDashboardRequestId({
		activeRequestId: 'req-1',
		messageRequestId: 'req-2',
		cacheStatus: 'fresh',
	}), false);
});

test('resolvePromptDashboardExpandRefreshTarget refreshes a shared Git section that is still missing from loadedSections', () => {
	const snapshot: PromptDashboardSnapshot = {
		promptId: 'task-1',
		promptUuid: 'uuid-1',
		generatedAt: '2026-05-30T10:00:00.000Z',
		scopeKey: 'task-1::dashboard',
		activity: createPromptDashboardWidgetSnapshot('activity', {
			thresholdMs: PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS,
			today: [],
			yesterday: [],
		}, { status: 'fresh', source: 'refresh' }),
		status: createPromptDashboardWidgetSnapshot('status', {
			status: 'draft',
			totalTimeMs: 0,
			updatedAt: '2026-05-30T10:00:00.000Z',
		}, { status: 'fresh', source: 'refresh' }),
		projects: createPromptDashboardWidgetSnapshot('projects', {
			projects: [{
				project: 'api',
				repositoryPath: '/api',
				available: true,
				error: '',
				branchSwitchError: '',
				pullError: '',
				hasPromptBranchMismatch: false,
				currentBranch: 'feature/task-1',
				promptBranch: 'feature/task-1',
				trackedBranch: 'main',
				dirty: false,
				hasConflicts: false,
				ahead: 0,
				behind: 0,
				branches: [],
				branchActions: [],
				recentCommits: [],
				review: { remote: null, request: null, error: '', setupAction: null, unsupportedReason: null },
				pipeline: null,
				parallelBranches: [{
					name: 'feature/parallel',
					ref: 'origin/feature/parallel',
					kind: 'remote',
					baseBranch: 'main',
					ahead: 1,
					behind: 0,
					lastCommit: null,
					affectedFiles: [],
					potentialConflicts: [],
				}],
				conflictFiles: [],
				incomingFiles: [],
				incomingAuthors: [],
				uncommittedFiles: [],
			}],
			loadedSections: ['parallelBranches'],
		}, { status: 'fresh', source: 'refresh' }),
		docker: createEmptyDockerWidget(),
		aiAnalysis: createPromptDashboardWidgetSnapshot('aiAnalysis', null, { status: 'idle', source: 'placeholder' }),
	};

	assert.deepEqual(resolvePromptDashboardExpandRefreshTarget({
		section: 'projectBranches',
		snapshot,
	}), { type: 'widget', widget: 'projects' });
	assert.equal(resolvePromptDashboardExpandRefreshTarget({
		section: 'parallelBranches',
		snapshot,
	}), null);
});

test('shouldAcceptPromptDashboardRequestMessage keeps late payloads only for the current prompt without a newer request', () => {
	assert.equal(shouldAcceptPromptDashboardRequestMessage({
		activeRequestId: '',
		messageRequestId: 'request-old',
		currentPromptId: 'task-1',
		currentPromptUuid: 'uuid-1',
		messagePromptId: 'task-1',
		messagePromptUuid: 'uuid-1',
	}), true);

	assert.equal(shouldAcceptPromptDashboardRequestMessage({
		activeRequestId: 'request-new',
		messageRequestId: 'request-old',
		currentPromptId: 'task-1',
		currentPromptUuid: 'uuid-1',
		messagePromptId: 'task-1',
		messagePromptUuid: 'uuid-1',
	}), false);

	assert.equal(shouldAcceptPromptDashboardRequestMessage({
		activeRequestId: '',
		messageRequestId: 'request-old',
		currentPromptId: 'task-1',
		currentPromptUuid: 'uuid-1',
		messagePromptId: 'task-2',
		messagePromptUuid: 'uuid-2',
	}), false);
});

test('resolvePromptDashboardCacheState marks cached widgets fresh until ttl expires', () => {
	const cache = resolvePromptDashboardCacheState(1_000, 300_000, 2_000);
	assert.equal(cache.status, 'fresh');
	assert.equal(cache.source, 'cache');

	const stale = resolvePromptDashboardCacheState(1_000, 300_000, 400_001);
	assert.equal(stale.status, 'stale');
});

test('buildPromptDashboardScopeKey is stable for project and tracked branch order', () => {
	const base: PromptDashboardScope = {
		promptId: 'task-1',
		promptUuid: 'uuid-1',
		projectNames: ['web', 'api'],
		selectedProjectNames: ['web', 'api'],
		promptBranch: 'feature/task-1',
		trackedBranch: 'main',
		trackedBranchesByProject: { web: 'develop', api: 'main' },
		model: 'copilot/gpt-5',
	};
	const same: PromptDashboardScope = {
		...base,
		projectNames: ['api', 'web'],
		selectedProjectNames: ['api', 'web'],
		trackedBranchesByProject: { api: 'main', web: 'develop' },
	};

	assert.equal(buildPromptDashboardScopeKey(base), buildPromptDashboardScopeKey(same));
});

test('splitPromptDashboardActivityByDay sorts today and yesterday by spent time', () => {
	const items: PromptDashboardPromptActivityItem[] = [
		{ id: 'a', taskNumber: '', title: 'A', status: 'draft', day: 'today', totalMs: PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS, updatedAt: '2026-01-01T00:00:00.000Z' },
		{ id: 'b', taskNumber: '107', title: 'B', status: 'draft', day: 'today', totalMs: PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS * 2, updatedAt: '2026-01-01T00:00:00.000Z' },
		{ id: 'c', taskNumber: '', title: 'C', status: 'draft', day: 'yesterday', totalMs: PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS, updatedAt: '2026-01-01T00:00:00.000Z' },
	];

	const result = splitPromptDashboardActivityByDay(items);
	assert.deepEqual(result.today.map(item => item.id), ['b', 'a']);
	assert.deepEqual(result.yesterday.map(item => item.id), ['c']);
});

test('getPromptDashboardStatusProgress clamps in-progress agent progress and starts from zero without runtime progress', () => {
	assert.equal(getPromptDashboardStatusProgress('in-progress', 144), 100);
	assert.equal(getPromptDashboardStatusProgress('in-progress', -10), 0);
	assert.equal(getPromptDashboardStatusProgress('in-progress'), 0);
	assert.equal(getPromptDashboardStatusProgress('closed'), 100);
});

test('buildPromptDashboardStatusDataFromPrompt recalculates the status widget payload from prompt fields', () => {
	const data = buildPromptDashboardStatusDataFromPrompt({
		status: 'review',
		progress: 37,
		updatedAt: '2026-05-03T09:30:00.000Z',
		timeSpentWriting: 60_000,
		timeSpentImplementing: 120_000,
		timeSpentOnTask: 180_000,
		timeSpentUntracked: 30_000,
	});

	assert.equal(data.status, 'review');
	assert.equal(data.progress, 90);
	assert.equal(data.totalTimeMs, 390_000);
	assert.equal(data.updatedAt, '2026-05-03T09:30:00.000Z');
});

test('buildPromptDashboardBranchActions exposes tracked and prompt switch targets only when named', () => {
	const actions = buildPromptDashboardBranchActions({
		promptBranch: 'feature/task',
		trackedBranch: 'main',
		branches: [
			{ name: 'main', current: true, exists: true, kind: 'tracked', upstream: '', ahead: 0, behind: 0, lastCommit: null, canSwitch: true, canDelete: false, stale: false },
			{ name: 'feature/task', current: false, exists: true, kind: 'prompt', upstream: '', ahead: 0, behind: 0, lastCommit: null, canSwitch: true, canDelete: false, stale: false },
		],
	});

	assert.deepEqual(actions.map(action => [action.kind, action.branch, action.available]), [
		['tracked', 'main', true],
		['prompt', 'feature/task', true],
	]);
});

test('createPromptDashboardWidgetSnapshot keeps placeholder cache explicit', () => {
	const snapshot = createPromptDashboardWidgetSnapshot('projects', { projects: [] });
	assert.equal(snapshot.kind, 'projects');
	assert.equal(snapshot.cache.status, 'idle');
	assert.equal(snapshot.cache.source, 'placeholder');
});

test('shouldClearPromptDashboardBusyActionFromWidget waits for a finished projects refresh', () => {
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'switch-project:api',
		widgetKind: 'projects',
		cacheStatus: 'loading',
	}), false);
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'switch-project:api',
		widgetKind: 'projects',
		cacheStatus: 'fresh',
	}), true);
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'pull-project:api',
		widgetKind: 'projects',
		cacheStatus: 'fresh',
	}), true);
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'refresh',
		widgetKind: 'projects',
		cacheStatus: 'fresh',
	}), false);
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'preset:prompt',
		widgetKind: 'status',
		cacheStatus: 'fresh',
	}), false);
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'refresh-widget:projects',
		widgetKind: 'projects',
		cacheStatus: 'fresh',
	}), true);
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'refresh-section:projectBranches',
		widgetKind: 'projects',
		cacheStatus: 'fresh',
	}), true);
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'refresh-widget:status',
		widgetKind: 'status',
		cacheStatus: 'fresh',
	}), true);
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'refresh-section:status',
		widgetKind: 'status',
		cacheStatus: 'fresh',
	}), true);
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'refresh-widget:activity',
		widgetKind: 'projects',
		cacheStatus: 'fresh',
	}), false);
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'refresh-widget:activity',
		widgetKind: 'activity',
		cacheStatus: 'loading',
	}), false);
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'docker:restart:abc123',
		widgetKind: 'docker',
		cacheStatus: 'fresh',
	}), true);
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'docker:restart:abc123',
		widgetKind: 'docker',
		cacheStatus: 'loading',
	}), false);
});

test('buildPromptDashboardDockerComposeBusyAction creates stable encoded Docker keys', () => {
	assert.equal(
		buildPromptDashboardDockerComposeBusyAction({
			projectPath: '/workspace/api service',
			composeFilePath: '/workspace/api service/docker-compose.yml',
			action: 'up',
		}),
		'docker:compose:up:%2Fworkspace%2Fapi%20service:%2Fworkspace%2Fapi%20service%2Fdocker-compose.yml',
	);
});

test('preservePromptDashboardProjectsLoadingSnapshot keeps previous rows during loading refresh', () => {
	const createProject = (project: string): PromptDashboardProjectSummary => ({
		project,
		repositoryPath: `/workspace/${project}`,
		available: true,
		error: '',
		branchSwitchError: '',
		pullError: '',
		hasPromptBranchMismatch: false,
		currentBranch: 'main',
		promptBranch: 'feature/task-1',
		trackedBranch: 'main',
		dirty: false,
		hasConflicts: false,
		ahead: 0,
		behind: 0,
		branches: [],
		branchActions: [],
		recentCommits: [],
		review: { remote: null, request: null, error: '', setupAction: null, titlePrefix: '', unsupportedReason: null },
		pipeline: null,
		parallelBranches: [],
		conflictFiles: [],
		incomingFiles: [],
		uncommittedFiles: [],
	});
	const previousWidget = createPromptDashboardWidgetSnapshot('projects', {
		projects: [createProject('api')],
	} satisfies PromptDashboardProjectsData);
	const loadingWidget = createPromptDashboardWidgetSnapshot('projects', {
		projects: [],
	} satisfies PromptDashboardProjectsData, {
		status: 'loading',
		source: 'refresh',
	});
	const readyWidget = createPromptDashboardWidgetSnapshot('projects', {
		projects: [createProject('web')],
	} satisfies PromptDashboardProjectsData, {
		status: 'fresh',
		source: 'refresh',
	});

	assert.deepEqual(
		preservePromptDashboardProjectsLoadingSnapshot(previousWidget, loadingWidget).data.projects,
		previousWidget.data.projects,
	);
	assert.deepEqual(
		preservePromptDashboardProjectsLoadingSnapshot(previousWidget, readyWidget).data.projects,
		readyWidget.data.projects,
	);
});

test('syncPromptDashboardStatusFromPrompt updates only the matching snapshot status widget', () => {
	const snapshot: PromptDashboardSnapshot = {
		promptId: 'task-1',
		promptUuid: 'uuid-1',
		generatedAt: '2026-05-03T10:00:00.000Z',
		scopeKey: 'task-1::dashboard',
		activity: createPromptDashboardWidgetSnapshot('activity', { thresholdMs: PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS, today: [], yesterday: [] }),
		status: createPromptDashboardWidgetSnapshot('status', { status: 'draft', progress: 10, totalTimeMs: 60_000, updatedAt: '2026-05-03T10:00:00.000Z' }),
		projects: createPromptDashboardWidgetSnapshot('projects', { projects: [] }),
		docker: createEmptyDockerWidget(),
		aiAnalysis: createPromptDashboardWidgetSnapshot('aiAnalysis', null),
	};

	const unchanged = syncPromptDashboardStatusFromPrompt(snapshot, {
		id: 'other-task',
		promptUuid: 'uuid-2',
		status: 'completed',
		progress: 100,
		updatedAt: '2026-05-03T10:30:00.000Z',
		timeSpentWriting: 60_000,
		timeSpentImplementing: 60_000,
		timeSpentOnTask: 60_000,
		timeSpentUntracked: 0,
	});
	assert.equal(unchanged, snapshot);

	const next = syncPromptDashboardStatusFromPrompt(snapshot, {
		id: 'task-1',
		promptUuid: 'uuid-1',
		status: 'completed',
		progress: 100,
		updatedAt: '2026-05-03T10:30:00.000Z',
		timeSpentWriting: 60_000,
		timeSpentImplementing: 60_000,
		timeSpentOnTask: 300_000,
		timeSpentUntracked: 0,
	});

	assert.notEqual(next, snapshot);
	assert.equal(next?.status.data.status, 'completed');
	assert.equal(next?.status.data.progress, 70);
	assert.equal(next?.status.data.totalTimeMs, 420_000);
	assert.equal(next?.status.data.updatedAt, '2026-05-03T10:30:00.000Z');
});

test('syncPromptDashboardStatusFromPrompt keeps the loaded in-progress snapshot percent when prompt config has no progress', () => {
	const snapshot: PromptDashboardSnapshot = {
		promptId: 'task-144',
		promptUuid: 'uuid-144',
		generatedAt: '2026-05-03T16:05:00.000Z',
		scopeKey: 'task-144::dashboard',
		activity: createPromptDashboardWidgetSnapshot('activity', { thresholdMs: PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS, today: [], yesterday: [] }),
		status: createPromptDashboardWidgetSnapshot('status', { status: 'in-progress', progress: 100, totalTimeMs: 1_000, updatedAt: '2026-05-03T16:05:00.000Z' }),
		projects: createPromptDashboardWidgetSnapshot('projects', { projects: [] }),
		docker: createEmptyDockerWidget(),
		aiAnalysis: createPromptDashboardWidgetSnapshot('aiAnalysis', null),
	};

	const next = syncPromptDashboardStatusFromPrompt(snapshot, {
		id: 'task-144',
		promptUuid: 'uuid-144',
		status: 'in-progress',
		progress: undefined,
		updatedAt: '2026-05-03T16:06:57.168Z',
		timeSpentWriting: 1_648_389,
		timeSpentImplementing: 88_659,
		timeSpentOnTask: 4_926_656,
		timeSpentUntracked: 0,
	}, {
		preserveInProgressSnapshotProgress: true,
	});

	assert.notEqual(next, snapshot);
	assert.equal(next?.status.data.status, 'in-progress');
	assert.equal(next?.status.data.progress, 100);
	assert.equal(next?.status.data.totalTimeMs, 6_663_704);
	assert.equal(next?.status.data.updatedAt, '2026-05-03T16:06:57.168Z');
});

test('syncPromptDashboardStatusFromPrompt does not preserve draft progress when status switches to in-progress without runtime percent', () => {
	const snapshot: PromptDashboardSnapshot = {
		promptId: 'task-201',
		promptUuid: 'uuid-201',
		generatedAt: '2026-05-03T16:09:00.000Z',
		scopeKey: 'task-201::dashboard',
		activity: createPromptDashboardWidgetSnapshot('activity', { thresholdMs: PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS, today: [], yesterday: [] }),
		status: createPromptDashboardWidgetSnapshot('status', { status: 'draft', progress: 10, totalTimeMs: 1_000, updatedAt: '2026-05-03T16:09:00.000Z' }),
		projects: createPromptDashboardWidgetSnapshot('projects', { projects: [] }),
		docker: createEmptyDockerWidget(),
		aiAnalysis: createPromptDashboardWidgetSnapshot('aiAnalysis', null),
	};

	const next = syncPromptDashboardStatusFromPrompt(snapshot, {
		id: 'task-201',
		promptUuid: 'uuid-201',
		status: 'in-progress',
		progress: undefined,
		updatedAt: '2026-05-03T16:09:30.000Z',
		timeSpentWriting: 1_000,
		timeSpentImplementing: 2_000,
		timeSpentOnTask: 3_000,
		timeSpentUntracked: 0,
	}, {
		preserveInProgressSnapshotProgress: true,
	});

	assert.equal(next?.status.data.status, 'in-progress');
	assert.equal(next?.status.data.progress, 0);
	assert.equal(next?.status.data.totalTimeMs, 6_000);
	assert.equal(next?.status.data.updatedAt, '2026-05-03T16:09:30.000Z');
});

test('syncPromptDashboardStatusFromPrompt still uses an explicit prompt percent when the snapshot only has the default fallback', () => {
	const snapshot: PromptDashboardSnapshot = {
		promptId: 'task-200',
		promptUuid: 'uuid-200',
		generatedAt: '2026-05-03T16:10:00.000Z',
		scopeKey: 'task-200::dashboard',
		activity: createPromptDashboardWidgetSnapshot('activity', { thresholdMs: PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS, today: [], yesterday: [] }),
		status: createPromptDashboardWidgetSnapshot('status', { status: 'in-progress', progress: 0, totalTimeMs: 1_000, updatedAt: '2026-05-03T16:10:00.000Z' }),
		projects: createPromptDashboardWidgetSnapshot('projects', { projects: [] }),
		docker: createEmptyDockerWidget(),
		aiAnalysis: createPromptDashboardWidgetSnapshot('aiAnalysis', null),
	};

	const next = syncPromptDashboardStatusFromPrompt(snapshot, {
		id: 'task-200',
		promptUuid: 'uuid-200',
		status: 'in-progress',
		progress: 80,
		updatedAt: '2026-05-03T16:10:30.000Z',
		timeSpentWriting: 1_000,
		timeSpentImplementing: 2_000,
		timeSpentOnTask: 3_000,
		timeSpentUntracked: 0,
	}, {
		preserveInProgressSnapshotProgress: true,
	});

	assert.equal(next?.status.data.progress, 80);
	assert.equal(next?.status.data.totalTimeMs, 6_000);
	assert.equal(next?.status.data.updatedAt, '2026-05-03T16:10:30.000Z');
});

test('shouldAcceptPromptDashboardAnalysisMessage accepts same-fingerprint completion after a newer snapshot request', () => {
	assert.equal(shouldAcceptPromptDashboardAnalysisMessage({
		activeRequestId: 'request-new',
		messageRequestId: 'request-old',
		currentPromptId: 'task-1',
		currentPromptUuid: 'uuid-1',
		messagePromptId: 'task-1',
		messagePromptUuid: 'uuid-1',
		currentAnalysisFingerprint: 'fp-1',
		messageAnalysisFingerprint: 'fp-1',
		currentAnalysisStatus: 'running',
		messageAnalysisStatus: 'completed',
	}), true);

	assert.equal(shouldAcceptPromptDashboardAnalysisMessage({
		activeRequestId: 'request-new',
		messageRequestId: 'request-old',
		currentPromptId: 'task-1',
		currentPromptUuid: 'uuid-1',
		messagePromptId: 'task-1',
		messagePromptUuid: 'uuid-1',
		currentAnalysisFingerprint: 'fp-current',
		messageAnalysisFingerprint: 'fp-old',
		currentAnalysisStatus: 'running',
		messageAnalysisStatus: 'completed',
	}), false);

	assert.equal(shouldAcceptPromptDashboardAnalysisMessage({
		activeRequestId: 'request-new',
		messageRequestId: 'request-old',
		currentPromptId: 'task-1',
		currentPromptUuid: 'uuid-1',
		messagePromptId: 'task-1',
		messagePromptUuid: 'uuid-1',
		currentAnalysisFingerprint: 'fp-1',
		messageAnalysisFingerprint: 'fp-1',
		currentAnalysisStatus: 'completed',
		messageAnalysisStatus: 'running',
	}), false);
});

test('buildPromptDashboardAnalysisFingerprint changes when prompt inputs change', () => {
	const base = buildPromptDashboardAnalysisFingerprint({
		promptTitle: 'Dashboard',
		promptContent: 'Review branches',
		promptBranch: 'feature/task',
		projects: [],
	});
	const same = buildPromptDashboardAnalysisFingerprint({
		promptTitle: 'Dashboard',
		promptContent: 'Review branches',
		promptBranch: 'feature/task',
		projects: [],
	});
	const changed = buildPromptDashboardAnalysisFingerprint({
		promptTitle: 'Dashboard',
		promptContent: 'Review changed branches',
		promptBranch: 'feature/task',
		projects: [],
	});

	assert.equal(base, same);
	assert.notEqual(base, changed);
});
