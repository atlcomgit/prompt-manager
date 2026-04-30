import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PromptDashboard } from '../src/webview/editor/components/PromptDashboard.js';
import type { PromptDashboardProjectSummary, PromptDashboardSnapshot } from '../src/types/promptDashboard.js';

type TestWindow = Window & { __LOCALE__?: string };

/** Provides minimal webview globals required by shared i18n hooks. */
function withDashboardEnvironment<T>(callback: () => T): T {
	const globalScope = globalThis as typeof globalThis & { window?: TestWindow };
	const previousWindow = globalScope.window;
	const activeWindow = previousWindow || {} as TestWindow;
	const previousLocale = activeWindow.__LOCALE__;

	if (previousWindow === undefined) {
		Object.defineProperty(globalScope, 'window', {
			value: activeWindow,
			configurable: true,
			writable: true,
		});
	}

	activeWindow.__LOCALE__ = 'ru';

	try {
		return callback();
	} finally {
		if (previousLocale === undefined) {
			delete activeWindow.__LOCALE__;
		} else {
			activeWindow.__LOCALE__ = previousLocale;
		}

		if (previousWindow === undefined) {
			Reflect.deleteProperty(globalScope as Record<string, unknown>, 'window');
		}
	}
}

/** Builds a stable dashboard project fixture for UI render assertions. */
function createProject(overrides: Partial<PromptDashboardProjectSummary> = {}): PromptDashboardProjectSummary {
	return {
		project: 'api',
		repositoryPath: '/workspace/api',
		available: true,
		error: '',
		currentBranch: 'main',
		promptBranch: 'feature/task-107',
		trackedBranch: 'develop',
		dirty: true,
		hasConflicts: true,
		ahead: 2,
		behind: 1,
		branches: [
			{ name: 'main', current: true, exists: true, kind: 'current', upstream: 'origin/main', ahead: 2, behind: 1, lastCommit: null, canSwitch: true, canDelete: false, stale: false },
			{ name: 'feature/task-107', current: false, exists: true, kind: 'prompt', upstream: 'origin/feature/task-107', ahead: 5, behind: 0, lastCommit: null, canSwitch: true, canDelete: false, stale: false },
			{ name: 'develop', current: false, exists: true, kind: 'tracked', upstream: 'origin/develop', ahead: 0, behind: 3, lastCommit: null, canSwitch: true, canDelete: false, stale: false },
		],
		branchActions: [
			{ kind: 'prompt', branch: 'feature/task-107', available: true },
			{ kind: 'tracked', branch: 'develop', available: true },
		],
		recentCommits: [],
		review: {
			remote: null,
			request: {
				id: '17',
				number: '17',
				title: 'Review dashboard polish',
				url: 'https://example.test/pr/17',
				state: 'open',
				createdAt: '2026-04-26T09:00:00.000Z',
				updatedAt: '2026-04-29T09:00:00.000Z',
				sourceBranch: 'feature/task-107',
				targetBranch: 'develop',
				isDraft: false,
				comments: [],
			},
			error: '',
			setupAction: null,
			titlePrefix: '',
			unsupportedReason: null,
		},
		pipeline: {
			provider: 'github',
			branch: 'main',
			state: 'success',
			updatedAt: '2026-04-29T10:00:00.000Z',
			url: 'https://example.test/run/42',
			checks: [
				{ id: 'build', name: 'build', state: 'success', conclusion: 'success', startedAt: '2026-04-29T09:55:00.000Z', completedAt: '2026-04-29T10:00:00.000Z', detailsUrl: 'https://example.test/job/build', workflow: 'build' },
				{ id: 'test', name: 'test', state: 'running', conclusion: 'running', startedAt: '2026-04-29T09:57:00.000Z', completedAt: '', detailsUrl: 'https://example.test/job/test', workflow: 'test' },
			],
			error: '',
		},
		parallelBranches: [{
			name: 'feature/parallel',
			baseBranch: 'feature/task-107',
			ahead: 4,
			behind: 1,
			lastCommit: null,
			affectedFiles: [
				{ status: 'M', path: 'src/webview/editor/App.tsx' },
			],
			potentialConflicts: [
				{ path: 'src/webview/editor/App.tsx', reason: 'changed in current and parallel branch' },
			],
		}],
		conflictFiles: ['src/webview/editor/App.tsx'],
		...overrides,
	};
}

/** Builds a minimal dashboard snapshot with configurable project cache state. */
function createSnapshot(projects: PromptDashboardProjectSummary[], projectsCacheStatus: PromptDashboardSnapshot['projects']['cache']['status'] = 'fresh'): PromptDashboardSnapshot {
	return {
		promptId: 'task-107',
		promptUuid: 'uuid-107',
		generatedAt: '2026-04-29T10:00:00.000Z',
		scopeKey: 'task-107::dashboard',
		activity: {
			kind: 'activity',
			cache: { status: 'fresh', source: 'cache', updatedAt: '2026-04-29T10:00:00.000Z' },
			data: { thresholdMs: 300000, today: [], yesterday: [] },
		},
		status: {
			kind: 'status',
			cache: { status: 'fresh', source: 'cache', updatedAt: '2026-04-29T10:00:00.000Z' },
			data: { status: 'in-progress', progress: 68, totalTimeMs: 2_400_000, updatedAt: '2026-04-29T10:00:00.000Z' },
		},
		projects: {
			kind: 'projects',
			cache: { status: projectsCacheStatus, source: 'refresh', updatedAt: '2026-04-29T10:00:00.000Z' },
			data: { projects },
		},
		aiAnalysis: {
			kind: 'aiAnalysis',
			cache: { status: 'fresh', source: 'cache', updatedAt: '2026-04-29T10:00:00.000Z' },
			data: { status: 'completed', model: 'copilot:gpt-5', content: '## Summary\n- Ready', updatedAt: '2026-04-29T10:00:00.000Z' },
		},
	};
}

/** Renders the dashboard component into static markup for regression checks. */
function renderDashboard(snapshot: PromptDashboardSnapshot | null): string {
	return withDashboardEnvironment(() => renderToStaticMarkup(React.createElement(PromptDashboard, {
		snapshot,
		busyAction: null,
		mode: 'full',
		onRefresh: () => { },
		onOpenPrompt: () => { },
		onSwitchBranch: () => { },
		onSwitchBranches: () => { },
		onOpenDiff: () => { },
		onOpenFilePatch: () => { },
	})));
}

test('PromptDashboard prefers prompt branch by default and renders the redesigned file tree', () => {
	const markup = renderDashboard(createSnapshot([createProject()]));

	assert.doesNotMatch(markup, /Branch Divergence/);
	assert.doesNotMatch(markup, /Pipelines/);
	assert.doesNotMatch(markup, /Pipeline Health/);
	assert.doesNotMatch(markup, /MR\/PR Age/);
	assert.doesNotMatch(markup, /Conflict Hotspots/);
	assert.match(markup, /MR\/PR/);
	assert.match(markup, /folder/);
	assert.match(markup, /open diff/);
	assert.match(markup, /folder: src\/webview\/editor/);
	assert.match(markup, /value="feature\/task-107" selected=""/);
	assert.match(markup, /src\/webview\/editor/);
	assert.match(markup, /App\.tsx/);
});

test('PromptDashboard shows loading labels for project-based widgets while data refreshes', () => {
	const markup = renderDashboard(createSnapshot([], 'loading'));

	assert.match(markup, /обновляем/);
	assert.match(markup, /Git-данные загружаются/);
	assert.match(markup, /MR\/PR-данные загружаются/);
	assert.match(markup, /Данные по веткам загружаются/);
	assert.doesNotMatch(markup, /Pipeline-статусы загружаются/);
	assert.doesNotMatch(markup, /Собираем health pipeline/);
	assert.doesNotMatch(markup, /Ищем конфликтующие файлы/);
});