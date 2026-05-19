import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
	PromptDashboard,
	buildWidgetGridColumns,
	reconcileBranchDrafts,
	resolveBranchWidgetProjects,
	resolveExpandedDetailsHydrationRequest,
	resolveVisibleLineStatsParts,
	resolveVisibleParallelBranches,
} from '../src/webview/editor/components/PromptDashboard.js';
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
		hasPromptBranchMismatch: false,
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
		branchSwitchError: '',
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
				{ status: 'M', path: 'src/webview/editor/App.tsx', additions: 7, deletions: 2, isBinary: false },
			],
			potentialConflicts: [
				{ path: 'src/webview/editor/App.tsx', reason: 'changed in current and parallel branch' },
			],
		}],
		conflictFiles: ['src/webview/editor/App.tsx'],
		incomingFiles: [],
		uncommittedFiles: [],
		...overrides,
	};
}

/** Builds a minimal dashboard snapshot with configurable project cache state. */
function createSnapshot(
	projects: PromptDashboardProjectSummary[],
	projectsCacheStatus: PromptDashboardSnapshot['projects']['cache']['status'] = 'fresh',
	branchProjects?: PromptDashboardProjectSummary[],
): PromptDashboardSnapshot {
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
			data: { projects, ...(branchProjects ? { branchProjects } : {}) },
		},
		aiAnalysis: {
			kind: 'aiAnalysis',
			cache: { status: 'fresh', source: 'cache', updatedAt: '2026-04-29T10:00:00.000Z' },
			data: { status: 'completed', model: 'copilot:gpt-5', content: '## Summary\n- Ready', updatedAt: '2026-04-29T10:00:00.000Z' },
		},
	};
}

/** Renders the dashboard component into static markup for regression checks. */
function renderDashboard(snapshot: PromptDashboardSnapshot | null, options?: { busyAction?: string | null }): string {
	return withDashboardEnvironment(() => renderToStaticMarkup(React.createElement(PromptDashboard, {
		snapshot,
		busyAction: options?.busyAction ?? null,
		mode: 'full',
		onRefresh: () => { },
		onRefreshWidget: () => { },
		onHydrateProjectsDetails: () => { },
		onOpenGitFlow: () => { },
		onOpenPrompt: () => { },
		onSwitchBranch: () => { },
		onSwitchBranches: () => { },
		onOpenDiff: () => { },
		onOpenFilePatch: () => { },
		showGitFlowAction: true,
	})));
}

test('PromptDashboard selects current branch first and renders the redesigned file tree', () => {
	const markup = renderDashboard(createSnapshot([createProject()]));

	assert.match(markup, /display:grid;grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,360px\),1fr\)\);gap:12px;align-items:start/);
	assert.match(markup, /display:flex;flex-direction:column;gap:12px;min-width:0;align-self:start/);
	assert.doesNotMatch(markup, /Branch Divergence/);
	assert.doesNotMatch(markup, /Pipelines/);
	assert.doesNotMatch(markup, /Pipeline Health/);
	assert.doesNotMatch(markup, /MR\/PR Age/);
	assert.doesNotMatch(markup, /Conflict Hotspots/);
	assert.match(markup, /MR\/PR/);
	assert.match(markup, /\(—\)/);
	assert.match(markup, /└─/);
	assert.match(markup, /🗁/);
	assert.match(markup, /🗋/);
	assert.doesNotMatch(markup, /добавлено/);
	assert.doesNotMatch(markup, /строки:/);
	assert.doesNotMatch(markup, /conflict|opening|workspace root|diff/);
	assert.match(markup, /value="main" selected=""/);
	assert.doesNotMatch(markup, /value="feature\/task-107" selected=""/);
	assert.match(markup, /api/);
	assert.match(markup, /src\/webview\/editor/);
	assert.match(markup, /App\.tsx/);
	assert.match(markup, /Что происходит/);
});

test('buildWidgetGridColumns keeps dashboard widgets in stable alternating columns', () => {
	const columns = buildWidgetGridColumns(['status', 'activity', 'branches', 'commits', 'parallel', 'analysis', 'reviews']);

	assert.deepEqual(columns, [
		['status', 'branches', 'parallel', 'reviews'],
		['activity', 'commits', 'analysis'],
	]);
});

test('PromptDashboard renders the parallel branch author after the branch name', () => {
	const markup = renderDashboard(createSnapshot([createProject({
		parallelBranches: [{
			name: 'feature/parallel',
			baseBranch: 'feature/task-107',
			ahead: 4,
			behind: 1,
			lastCommit: {
				sha: 'abc123456789',
				shortSha: 'abc1234',
				subject: 'Parallel branch update',
				author: 'Jane Doe',
				committedAt: '2026-04-29T10:00:00.000Z',
				refNames: [],
			},
			affectedFiles: [{ status: 'M', path: 'src/app.ts', additions: 1, deletions: 0, isBinary: false }],
			potentialConflicts: [],
		}],
	})]));

	assert.match(markup, /feature\/parallel[\s\S]*Jane Doe/);
});

test('PromptDashboard shows lightweight commit file counts before details hydration', () => {
	const markup = renderDashboard(createSnapshot([createProject({
		recentCommits: [{
			sha: 'abc123456789',
			shortSha: 'abc1234',
			subject: 'Initial commit',
			author: 'Jane Doe',
			committedAt: '2026-04-29T10:00:00.000Z',
			refNames: [],
			changedFiles: [],
			changedFileCount: 12,
			changedFilesHydrated: false,
		}],
	})]));

	assert.match(markup, /abc1234[\s\S]*?>12</);
	assert.doesNotMatch(markup, /abc1234[\s\S]*?>\.\.\.</);
});

test('PromptDashboard renders widget refresh buttons in every section header', () => {
	const markup = renderDashboard(createSnapshot([createProject()]));

	assert.match(markup, /aria-label="Обновить виджет: Статус промпта"/);
	assert.match(markup, /aria-label="Обновить виджет: Активные промпты"/);
	assert.match(markup, /aria-label="Обновить виджет: Ветки проектов"/);
	assert.match(markup, /aria-label="Обновить виджет: Коммиты проектов"/);
	assert.match(markup, /aria-label="Обновить виджет: Параллельные ветки"/);
	assert.match(markup, /aria-label="Обновить виджет: AI review"/);
	assert.match(markup, /aria-label="Обновить виджет: MR\/PR"/);
});

test('PromptDashboard renders commit author beside sha and keeps the subject on a separate line', () => {
	const markup = renderDashboard(createSnapshot([createProject({
		recentCommits: [{
			sha: 'abc123456789',
			shortSha: 'abc1234',
			subject: 'Initial commit message that should stay fully visible in the dashboard row',
			author: 'Jane Doe',
			committedAt: '2026-04-29T10:00:00.000Z',
			refNames: [],
			changedFiles: [],
			changedFileCount: 3,
			changedFilesHydrated: false,
		}],
	})]));

	assert.match(markup, /abc1234[\s\S]*Jane Doe[\s\S]*Initial commit message that should stay fully visible in the dashboard row/);
	assert.match(markup, /display:flex;flex-direction:column;gap:3px;min-width:0/);
	assert.match(markup, /white-space:normal;line-height:1\.35/);
});

test('PromptDashboard shows lightweight parallel-branch file counts before details hydration', () => {
	const markup = renderDashboard(createSnapshot([createProject({
		parallelBranches: [{
			name: 'feature/parallel',
			baseBranch: 'feature/task-107',
			ahead: 4,
			behind: 1,
			lastCommit: null,
			affectedFiles: [],
			affectedFileCount: 73,
			potentialConflicts: [],
			detailsHydrated: false,
		}],
	})]));

	assert.match(markup, /feature\/parallel[\s\S]*?>73</);
	assert.doesNotMatch(markup, /feature\/parallel[\s\S]*?>\.\.\.</);
});

test('PromptDashboard hides MR\/PR rows that only report missing active review requests', () => {
	const markup = renderDashboard(createSnapshot([
		createProject({ project: 'api' }),
		createProject({
			project: 'hidden-review-row',
			repositoryPath: '/workspace/hidden-review-row',
			review: {
				remote: null,
				request: null,
				error: '',
				setupAction: null,
				titlePrefix: '',
				unsupportedReason: null,
			},
		}),
	], 'fresh', [createProject({ project: 'api' })]));

	assert.match(markup, /Review dashboard polish/);
	assert.doesNotMatch(markup, /Активный MR\/PR не найден/);
});

test('reconcileBranchDrafts drops drafts that already became the refreshed current branch', () => {
	const nextDrafts = reconcileBranchDrafts([
		createProject({ currentBranch: 'feature/task-107' }),
		createProject({ project: 'web', repositoryPath: '/workspace/web' }),
	], {
		api: 'feature/task-107',
		web: 'develop',
		ghost: 'main',
	});

	assert.deepEqual(nextDrafts, { web: 'develop' });
});

test('resolveBranchWidgetProjects switches between selected and workspace-wide branch rows', () => {
	const selectedProjects = [createProject({ project: 'api' })];
	const workspaceProjects = [
		createProject({ project: 'api' }),
		createProject({ project: 'web', repositoryPath: '/workspace/web' }),
	];

	assert.deepEqual(
		resolveBranchWidgetProjects(selectedProjects, workspaceProjects, false).map(project => project.project),
		['api'],
	);
	assert.deepEqual(
		resolveBranchWidgetProjects(selectedProjects, workspaceProjects, true).map(project => project.project),
		['api', 'web'],
	);
});

test('resolveVisibleLineStatsParts hides zero-valued +0 and -0 counters', () => {
	assert.deepEqual(
		resolveVisibleLineStatsParts({ added: 0, changed: 2, deleted: 0, kind: 'diff' }),
		['~2'],
	);
	assert.equal(
		resolveVisibleLineStatsParts({ added: 0, changed: 0, deleted: 0, kind: 'diff' }),
		null,
	);
});

test('resolveVisibleParallelBranches hides zero-file rows once lightweight or hydrated data confirms them', () => {
	const visible = resolveVisibleParallelBranches([
		{
			name: 'feature/empty',
			baseBranch: 'main',
			ahead: 1,
			behind: 0,
			lastCommit: null,
			affectedFiles: [],
			potentialConflicts: [],
			detailsHydrated: true,
		},
		{
			name: 'feature/loading',
			baseBranch: 'main',
			ahead: 1,
			behind: 0,
			lastCommit: null,
			affectedFiles: [],
			affectedFileCount: 0,
			potentialConflicts: [],
			detailsHydrated: false,
		},
		{
			name: 'feature/loading-unknown',
			baseBranch: 'main',
			ahead: 1,
			behind: 0,
			lastCommit: null,
			affectedFiles: [],
			potentialConflicts: [],
			detailsHydrated: false,
		},
		{
			name: 'feature/kept-visible',
			baseBranch: 'main',
			ahead: 0,
			behind: 0,
			lastCommit: null,
			affectedFiles: [],
			affectedFileCount: 0,
			potentialConflicts: [],
			detailsHydrated: true,
			detailsMissing: true,
		},
		{
			name: 'feature/real',
			baseBranch: 'main',
			ahead: 2,
			behind: 0,
			lastCommit: null,
			affectedFiles: [{ status: 'M', path: 'src/app.ts', additions: 2, deletions: 1, isBinary: false }],
			potentialConflicts: [],
			detailsHydrated: true,
		},
	]);

	assert.deepEqual(visible.map(branch => branch.name), ['feature/loading-unknown', 'feature/kept-visible', 'feature/real']);
});

test('resolveExpandedDetailsHydrationRequest keeps dirty file hydration on the dedicated route', () => {
	const request = resolveExpandedDetailsHydrationRequest('dirty:api', [createProject({
		uncommittedFiles: [{
			project: 'api',
			path: 'src/app.ts',
			status: 'M',
			group: 'working-tree',
			conflicted: false,
			staged: false,
			fileSizeBytes: 0,
			additions: null,
			deletions: null,
			isBinary: false,
		}],
	})]);

	assert.deepEqual(request, {
		projects: ['api'],
		reason: 'dirty-files',
	});
});

test('PromptDashboard hides header loading labels for project-based widgets while data refreshes', () => {
	const markup = renderDashboard(createSnapshot([], 'loading'));

	assert.doesNotMatch(markup, /обновляем/);
	assert.match(markup, /Git-данные загружаются/);
	assert.match(markup, /MR\/PR-данные загружаются/);
	assert.match(markup, /Данные по веткам загружаются/);
	assert.doesNotMatch(markup, /Pipeline-статусы загружаются/);
	assert.doesNotMatch(markup, /Собираем health pipeline/);
	assert.doesNotMatch(markup, /Ищем конфликтующие файлы/);
});

test('PromptDashboard keeps existing project rows visible while refreshed Git data is loading', () => {
	const markup = renderDashboard(createSnapshot([createProject()], 'loading'));

	assert.doesNotMatch(markup, /обновляем/);
	assert.match(markup, /api/);
	assert.doesNotMatch(markup, /Git-данные загружаются/);
	assert.doesNotMatch(markup, /MR\/PR-данные загружаются/);
	assert.doesNotMatch(markup, /Данные по веткам загружаются/);
});

test('PromptDashboard keeps only refresh-button spinners visible while widget refresh is running', () => {
	const markup = renderDashboard(createSnapshot([createProject()], 'loading'), { busyAction: 'refresh-widget:projects' });

	assert.doesNotMatch(markup, /обновляем/);
	assert.match(markup, /aria-label="Обновить виджет: Ветки проектов"/);
	assert.match(markup, /animation:pm-spin 0\.8s linear infinite/);
	assert.doesNotMatch(markup, /Git-данные загружаются/);
	assert.doesNotMatch(markup, /MR\/PR-данные загружаются/);
	assert.doesNotMatch(markup, /Данные по веткам загружаются/);
});

test('PromptDashboard renders the marketplace icon before the overview title and cache label', () => {
	const markup = renderDashboard(createSnapshot([createProject()]));

	assert.match(markup, /data-pm-dashboard-logo="true"/);
	assert.match(markup, /viewBox="0 0 256 256"/);
	assert.match(markup, /width:32px;height:32px/);
	assert.match(markup, /pm-dashboard-logo-bg/);
	assert.match(markup, /data-pm-dashboard-logo="true"[\s\S]*Обзор[\s\S]*Обновлено/);
});

test('PromptDashboard disables the prompt branch preset when the prompt Git branch is missing', () => {
	const markup = renderDashboard(createSnapshot([
		createProject({
			promptBranch: '',
			branchActions: [
				{ kind: 'tracked', branch: 'develop', available: true },
			],
			branches: [
				{ name: 'main', current: true, exists: true, kind: 'current', upstream: 'origin/main', ahead: 2, behind: 1, lastCommit: null, canSwitch: true, canDelete: false, stale: false },
				{ name: 'develop', current: false, exists: true, kind: 'tracked', upstream: 'origin/develop', ahead: 0, behind: 3, lastCommit: null, canSwitch: true, canDelete: false, stale: false },
			],
		}),
	]));

	assert.match(markup, /title="У промпта не задана ветка Git" disabled="">Ветка промпта<\/button>/);
	assert.match(markup, /Tracked-ветка/);
});

test('PromptDashboard renders the show-all button for branch rows and keeps selected projects by default', () => {
	const markup = renderDashboard(createSnapshot(
		[createProject({ project: 'api' })],
		'fresh',
		[
			createProject({ project: 'api' }),
			createProject({ project: 'web', repositoryPath: '/workspace/web' }),
		],
	));

	assert.match(markup, /Показать все/);
	assert.match(markup, /Git flow/);
	assert.match(markup, /api/);
	assert.doesNotMatch(markup, /title="Текущая ветка: main">web<\/div>/);
});

test('PromptDashboard applies middle ellipsis to long project names in branch rows', () => {
	const markup = renderDashboard(createSnapshot([
		createProject({
			project: 'prompt-manager-internal-tools',
			repositoryPath: '/workspace/prompt-manager-internal-tools',
		}),
	]));

	assert.match(markup, /prompt-ma\.\.\.al-tools/);
	assert.match(markup, /title="prompt-manager-internal-tools/);
	assert.match(markup, /Текущая ветка: main"/);
});

test('PromptDashboard shows the Get action for the current branch when incoming pull data exists', () => {
	const markup = renderDashboard(createSnapshot([
		createProject({
			currentBranch: 'main',
			behind: 3,
			incomingFiles: [
				{ status: 'A', path: 'src/incoming.ts', additions: 4, deletions: 0, isBinary: false },
			],
			branches: [
				{ name: 'main', current: true, exists: true, kind: 'current', upstream: 'origin/main', ahead: 0, behind: 3, lastCommit: null, canSwitch: true, canDelete: false, stale: false },
				{ name: 'develop', current: false, exists: true, kind: 'tracked', upstream: 'origin/develop', ahead: 0, behind: 0, lastCommit: null, canSwitch: true, canDelete: false, stale: false },
			],
			uncommittedFiles: [],
		}),
	]));

	assert.match(markup, />Получить<\/button>/);
	assert.doesNotMatch(markup, />Применить<\/button>/);
	assert.match(markup, /title="Получить входящие изменения для api"/);
});

test('PromptDashboard shows a green incoming-files disclosure for the current branch pull action', () => {
	const markup = renderDashboard(createSnapshot([
		createProject({
			currentBranch: 'main',
			behind: 2,
			incomingAuthors: ['Jane Doe', 'John Smith'],
			incomingFiles: [
				{ status: 'A', path: 'src/incoming.ts', additions: 4, deletions: 0, isBinary: false },
				{ status: 'M', path: 'src/updated.ts', additions: 8, deletions: 3, isBinary: false },
			],
			branches: [
				{ name: 'main', current: true, exists: true, kind: 'current', upstream: 'origin/main', ahead: 0, behind: 2, lastCommit: null, canSwitch: true, canDelete: false, stale: false },
			],
		}),
	]));

	assert.match(markup, /Опережающие файлы \(Jane Doe, John Smith\)/);
	assert.match(markup, /title="Показать список входящих файлов"/);
	assert.match(markup, />2<\/span>/);
	assert.match(markup, /var\(--vscode-charts-green\)/);
});

test('PromptDashboard shows branch-switch errors and a dirty-files disclosure under the project selector', () => {
	const markup = renderDashboard(createSnapshot([
		createProject({
			branchSwitchError: 'рабочее дерево не чистое, переключение отменено.',
			uncommittedFiles: [
				{
					project: 'api',
					path: 'src/app.ts',
					status: 'M',
					group: 'working-tree',
					conflicted: false,
					staged: false,
					fileSizeBytes: 0,
					additions: 3,
					deletions: 1,
					isBinary: false,
				},
				{
					project: 'api',
					path: 'src/new-file.ts',
					status: '??',
					group: 'untracked',
					conflicted: false,
					staged: false,
					fileSizeBytes: 0,
					additions: null,
					deletions: null,
					isBinary: false,
				},
			],
		}),
	]));

	assert.match(markup, /Ошибка переключения ветки/);
	assert.match(markup, /рабочее дерево не чистое, переключение отменено/);
	assert.match(markup, /Незакоммиченные файлы/);
	assert.match(markup, /title="Показать список незакоммиченных файлов"/);
	assert.match(markup, />2<\/span>/);
	assert.doesNotMatch(markup, /work/);
});

test('PromptDashboard highlights the branch select for prompt-branch mismatches', () => {
	const markup = renderDashboard(createSnapshot([
		createProject({
			hasPromptBranchMismatch: true,
		}),
	]));

	assert.match(markup, /aria-invalid="true"/);
	assert.match(markup, /--vscode-inputValidation-errorBorder/);
});

test('PromptDashboard keeps the branch select neutral when there is no prompt-branch mismatch', () => {
	const markup = renderDashboard(createSnapshot([
		createProject({
			currentBranch: 'feature/task-107',
			hasPromptBranchMismatch: false,
		}),
	]));

	assert.doesNotMatch(markup, /aria-invalid="true"/);
	assert.doesNotMatch(markup, /--vscode-inputValidation-errorBorder/);
});

test('PromptDashboard shows a quick preliminary summary while AI review is still running', () => {
	const snapshot = createSnapshot([createProject()]);
	snapshot.aiAnalysis = {
		kind: 'aiAnalysis',
		cache: { status: 'loading', source: 'refresh', updatedAt: '2026-04-29T10:00:00.000Z' },
		data: {
			status: 'running',
			model: 'copilot:gpt-5',
			updatedAt: '2026-04-29T10:00:05.000Z',
			content: '### Что происходит\n- Быстрый локальный вывод уже готов.\n### Что сделать дальше\n- Дождитесь финального AI review.',
		},
	};

	const markup = renderDashboard(snapshot);

	assert.match(markup, /предварительно/);
	assert.match(markup, /Показываем быстрый локальный вывод/);
	assert.match(markup, /Быстрый локальный вывод уже готов/);
	assert.doesNotMatch(markup, /AI проверяет ветки и изменения/);
});