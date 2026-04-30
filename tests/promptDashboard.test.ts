import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildPromptDashboardAnalysisFingerprint,
	buildPromptDashboardBranchActions,
	buildPromptDashboardScopeKey,
	createPromptDashboardWidgetSnapshot,
	getPromptDashboardStatusProgress,
	PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS,
	resolvePromptDashboardCacheState,
	resolvePromptDashboardMode,
	splitPromptDashboardActivityByDay,
} from '../src/utils/promptDashboard.js';
import type { PromptDashboardPromptActivityItem, PromptDashboardScope } from '../src/types/promptDashboard.js';

test('resolvePromptDashboardMode switches to full only when the right side can fit widgets', () => {
	assert.equal(resolvePromptDashboardMode(1119, 840), 'compact');
	assert.equal(resolvePromptDashboardMode(1120, 840), 'full');
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
