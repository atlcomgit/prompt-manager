import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildPromptDashboardAnalysisFingerprint,
	buildPromptDashboardBranchActions,
	buildPromptDashboardScopeKey,
	createPromptDashboardWidgetSnapshot,
	getPromptDashboardStatusProgress,
	preservePromptDashboardProjectsLoadingSnapshot,
	PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS,
	resolvePromptDashboardCacheState,
	resolvePromptDashboardMode,
	shouldAcceptPromptDashboardAnalysisMessage,
	shouldClearPromptDashboardBusyActionFromWidget,
	shouldRequestPromptDashboardSnapshot,
	splitPromptDashboardActivityByDay,
} from '../src/utils/promptDashboard.js';
import type { PromptDashboardProjectSummary, PromptDashboardProjectsData, PromptDashboardPromptActivityItem, PromptDashboardScope } from '../src/types/promptDashboard.js';

test('resolvePromptDashboardMode switches to full only when the right side can fit widgets', () => {
	assert.equal(resolvePromptDashboardMode(1119, 840), 'compact');
	assert.equal(resolvePromptDashboardMode(1120, 840), 'full');
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
		promptBranch: 'feature/task-1',
		trackedBranch: 'main',
		trackedBranchesByProject: { web: 'develop', api: 'main' },
		model: 'copilot/gpt-5',
	};
	const same: PromptDashboardScope = {
		...base,
		projectNames: ['api', 'web'],
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

test('getPromptDashboardStatusProgress clamps in-progress agent progress and falls back by status', () => {
	assert.equal(getPromptDashboardStatusProgress('in-progress', 144), 100);
	assert.equal(getPromptDashboardStatusProgress('in-progress', -10), 0);
	assert.equal(getPromptDashboardStatusProgress('closed'), 100);
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
		busyAction: 'refresh',
		widgetKind: 'projects',
		cacheStatus: 'fresh',
	}), false);
	assert.equal(shouldClearPromptDashboardBusyActionFromWidget({
		busyAction: 'preset:prompt',
		widgetKind: 'status',
		cacheStatus: 'fresh',
	}), false);
});

test('preservePromptDashboardProjectsLoadingSnapshot keeps previous rows during loading refresh', () => {
	const createProject = (project: string): PromptDashboardProjectSummary => ({
		project,
		repositoryPath: `/workspace/${project}`,
		available: true,
		error: '',
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
