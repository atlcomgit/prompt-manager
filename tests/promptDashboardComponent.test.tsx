import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
	PromptDashboard,
	buildDockerSparklineVisibleSamples,
	buildDockerTableRows,
	buildWidgetGridColumns,
	isPromptDashboardBranchActionBusy,
	normalizePromptDashboardDockerWidgetState,
	reorderPromptDashboardSections,
	resolveBranchDraftRefreshProjects,
	resolvePromptDashboardColumnDropIndicator,
	resolvePromptDashboardPointerDropIndicator,
	resolvePromptDashboardSectionDropCommitIndicator,
	reconcileBranchDrafts,
	resolveFilteredDockerProjects,
	resolvePromptDashboardDockerLiveMetricsVisible,
	resolveBranchWidgetProjects,
	resolveExpandedDetailsHydrationRequest,
	resolveVisibleLineStatsParts,
	resolveVisibleParallelBranches,
} from '../src/webview/editor/components/PromptDashboard.js';
import type {
	PromptDashboardProjectSummary,
	PromptDashboardPromptActivityItem,
	PromptDashboardSectionKey,
	PromptDashboardSectionOrder,
	PromptDashboardSnapshot,
} from '../src/types/promptDashboard.js';
import type { DockerContainerSummary } from '../src/types/docker.js';
import { buildPromptDashboardDockerComposeBusyAction, buildPromptDashboardDockerContainerBusyAction, buildPromptDashboardDockerWorkspaceBusyAction } from '../src/utils/promptDashboard.js';
import { buildPromptDashboardTodosData } from '../src/utils/promptDashboardTodos.js';

type TestWindow = Window & { __LOCALE__?: string };

/** Provides minimal webview globals required by shared i18n hooks. */
function withDashboardEnvironment<T>(callback: () => T, options?: { localStorage?: Storage }): T {
	const globalScope = globalThis as typeof globalThis & { window?: TestWindow };
	const previousWindow = globalScope.window;
	const activeWindow = previousWindow || {} as TestWindow;
	const previousLocale = activeWindow.__LOCALE__;
	const previousLocalStorage = Object.getOwnPropertyDescriptor(activeWindow, 'localStorage');

	if (previousWindow === undefined) {
		Object.defineProperty(globalScope, 'window', {
			value: activeWindow,
			configurable: true,
			writable: true,
		});
	}

	activeWindow.__LOCALE__ = 'ru';
	if (options?.localStorage) {
		Object.defineProperty(activeWindow, 'localStorage', {
			value: options.localStorage,
			configurable: true,
		});
	}

	try {
		return callback();
	} finally {
		if (options?.localStorage) {
			if (previousLocalStorage) {
				Object.defineProperty(activeWindow, 'localStorage', previousLocalStorage);
			} else {
				Reflect.deleteProperty(activeWindow as unknown as Record<string, unknown>, 'localStorage');
			}
		}

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

/** Creates a small Storage implementation for SSR dashboard tests. */
function createStorageMock(initial: Record<string, string> = {}): Storage {
	const values = new Map(Object.entries(initial));
	return {
		get length() { return values.size; },
		clear: () => values.clear(),
		getItem: (key: string) => values.get(key) ?? null,
		key: (index: number) => Array.from(values.keys())[index] ?? null,
		removeItem: (key: string) => { values.delete(key); },
		setItem: (key: string, value: string) => { values.set(key, value); },
	};
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
		pullError: '',
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

/** Builds a Docker container fixture for dashboard widget render assertions. */
function createDockerContainer(overrides: Partial<DockerContainerSummary> = {}): DockerContainerSummary {
	return {
		id: 'container-abc123456789',
		shortId: 'container-ab',
		name: 'api-service-1',
		project: 'api',
		service: 'api-service',
		image: 'example/api:latest',
		imageId: 'sha256:image',
		command: 'node server.js',
		createdAt: '2026-04-29T09:00:00.000Z',
		startedAt: '2026-04-29T09:05:00.000Z',
		uptimeMs: 300000,
		status: 'running',
		statusTone: 'ok',
		statusText: 'Up 5 minutes',
		composeWorkingDir: '/workspace/api',
		composeFilePaths: ['/workspace/api/docker-compose.yml'],
		ports: [],
		mounts: [],
		labels: {},
		stats: {
			readAt: '2026-04-29T10:00:00.000Z',
			cpuPercent: 12.5,
			memoryUsageBytes: 104857600,
			memoryLimitBytes: 1073741824,
			memoryPercent: 9.8,
			networkRxBytes: 1000,
			networkTxBytes: 2000,
			networkRxRateBytesPerSecond: 100,
			networkTxRateBytesPerSecond: 200,
		},
		samples: [],
		...overrides,
	};
}

/** Builds a minimal dashboard snapshot with configurable project cache state. */
function createSnapshot(
	projects: PromptDashboardProjectSummary[],
	projectsCacheStatus: PromptDashboardSnapshot['projects']['cache']['status'] = 'fresh',
	branchProjects?: PromptDashboardProjectSummary[],
	loadedSections?: PromptDashboardSectionKey[],
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
			data: { projects, ...(branchProjects ? { branchProjects } : {}), ...(loadedSections ? { loadedSections } : {}) },
		},
		docker: {
			kind: 'docker',
			cache: { status: 'fresh', source: 'cache', updatedAt: '2026-04-29T10:00:00.000Z' },
			data: {
				enabled: true,
				available: true,
				generatedAt: '2026-04-29T10:00:00.000Z',
				defaultViewMode: 'tree',
				composeFilePatterns: [],
				projects: [],
				totalContainers: 0,
				runningContainers: 0,
				stoppedContainers: 0,
				warningContainers: 0,
				errorContainers: 0,
			},
		},
		aiAnalysis: {
			kind: 'aiAnalysis',
			cache: { status: 'fresh', source: 'cache', updatedAt: '2026-04-29T10:00:00.000Z' },
			data: { status: 'completed', model: 'copilot:gpt-5', content: '## Summary\n- Ready', updatedAt: '2026-04-29T10:00:00.000Z' },
		},
	};
}

/** Builds one activity-row fixture for the dashboard widget tests. */
function createActivityItem(
	index: number,
	overrides: Partial<PromptDashboardPromptActivityItem> = {},
): PromptDashboardPromptActivityItem {
	return {
		id: `prompt-${index}`,
		promptUuid: `uuid-${index}`,
		taskNumber: `${100 + index}`,
		title: `Активный промпт ${index}`,
		status: 'in-progress',
		day: 'today',
		totalMs: (index + 1) * 600_000,
		updatedAt: '2026-04-29T10:00:00.000Z',
		progress: 10 * index,
		...overrides,
	};
}

/** Renders the dashboard component into static markup for regression checks. */
function renderDashboard(
	snapshot: PromptDashboardSnapshot | null,
	options?: {
		busyAction?: string | null;
		dockerBusyAction?: string | null;
		collapsedSections?: Record<string, boolean>;
		sectionOrder?: PromptDashboardSectionOrder;
		localStorage?: Storage;
	},
): string {
	return withDashboardEnvironment(() => renderToStaticMarkup(React.createElement(PromptDashboard, {
		snapshot,
		busyAction: options?.busyAction ?? null,
		dockerBusyAction: options?.dockerBusyAction ?? null,
		collapsedSections: options?.collapsedSections,
		sectionOrder: options?.sectionOrder,
		mode: 'full',
		onRefresh: () => { },
		onRefreshWidget: () => { },
		onToggleSectionCollapse: () => { },
		onReorderSections: () => { },
		onHydrateProjectsDetails: () => { },
		onOpenGitFlow: () => { },
		onOpenPrompt: () => { },
		onSwitchBranch: () => { },
		onSwitchBranches: () => { },
		onOpenDiff: () => { },
		onOpenFilePatch: () => { },
		onOpenTodoMarker: () => { },
		onDockerAction: () => { },
		onDockerWorkspaceAction: () => { },
		onDockerComposeAction: () => { },
		onOpenDockerComposeFile: () => { },
		onOpenDockerLogs: () => { },
		onOpenDockerTerminal: () => { },
		showGitFlowAction: true,
	})), { localStorage: options?.localStorage });
}

test('normalizePromptDashboardDockerWidgetState keeps valid view mode and unique expanded containers', () => {
	assert.deepEqual(normalizePromptDashboardDockerWidgetState({
		viewMode: 'table',
		statusFilter: 'stopped',
		search: 'worker',
		sortBy: 'memory',
		expandedContainerIds: ['container-a', '', 'container-a', 42],
	}), {
		viewMode: 'table',
		statusFilter: 'stopped',
		search: 'worker',
		sortBy: 'memory',
		expandedContainerIds: ['container-a'],
	});
	assert.deepEqual(normalizePromptDashboardDockerWidgetState({
		viewMode: 'invalid',
		statusFilter: 'invalid',
		search: null,
		sortBy: 'invalid',
		expandedContainerIds: null,
	}), {
		statusFilter: 'all',
		search: '',
		sortBy: 'status',
		expandedContainerIds: [],
	});
});

test('resolveFilteredDockerProjects excludes active lifecycle states from the stopped filter', () => {
	const restartingContainer = createDockerContainer({
		id: 'container-restarting',
		name: 'worker-service-1',
		service: 'worker-service',
		status: 'restarting',
		statusTone: 'warning',
	});
	const stoppedContainer = createDockerContainer({
		id: 'container-stopped',
		name: 'db-service-1',
		service: 'db-service',
		status: 'stopped',
		statusTone: 'neutral',
		startedAt: undefined,
		uptimeMs: 0,
	});
	const composeFile = { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' };
	const projects = resolveFilteredDockerProjects({
		enabled: true,
		available: true,
		generatedAt: '2026-04-29T10:00:00.000Z',
		defaultViewMode: 'tree',
		composeFilePatterns: [],
		projects: [{
			project: 'api',
			projectPath: '/workspace/api',
			composeFiles: [composeFile],
			composeFileGroups: [{
				composeFile,
				containers: [restartingContainer],
				serviceNames: [],
				status: 'running',
				statusTone: 'ok',
				statusText: 'Запущено 1/1',
				runningCount: 1,
				stoppedCount: 0,
				warningCount: 1,
				errorCount: 0,
			}],
			containers: [restartingContainer, stoppedContainer],
			runningCount: 1,
			stoppedCount: 1,
			warningCount: 1,
			errorCount: 0,
		}],
		totalContainers: 2,
		runningContainers: 1,
		stoppedContainers: 1,
		warningContainers: 1,
		errorContainers: 0,
	}, 'stopped', '', 'name');

	assert.equal(projects[0].containers.length, 1);
	assert.equal(projects[0].containers[0].id, 'container-stopped');
	assert.equal(projects[0].composeFileGroups.length, 0);
	assert.equal(projects[0].composeFiles.length, 0);
});

test('resolveFilteredDockerProjects search hides inactive declared-service leftovers from filtered compose groups', () => {
	const runningContainer = createDockerContainer({
		id: 'container-running-live',
		name: 'api-live-1',
		service: 'api-service',
	});
	const stoppedContainer = createDockerContainer({
		id: 'container-stopped-hidden',
		name: 'worker-hidden-1',
		service: 'worker-service',
		status: 'stopped',
		statusTone: 'neutral',
		statusText: 'Exited 2 minutes ago',
		startedAt: undefined,
		uptimeMs: 0,
		stats: undefined,
		samples: [],
	});
	const composeFile = { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' };
	const filteredProjects = resolveFilteredDockerProjects({
		enabled: true,
		available: true,
		generatedAt: '2026-04-29T10:00:00.000Z',
		defaultViewMode: 'table',
		composeFilePatterns: [],
		projects: [{
			project: 'api',
			projectPath: '/workspace/api',
			composeFiles: [composeFile],
			composeFileGroups: [{
				composeFile,
				containers: [runningContainer, stoppedContainer],
				serviceNames: ['api-service', 'worker-service', 'db'],
				runningCount: 1,
				stoppedCount: 1,
				warningCount: 0,
				errorCount: 0,
			}],
			containers: [runningContainer, stoppedContainer],
			runningCount: 1,
			stoppedCount: 1,
			warningCount: 0,
			errorCount: 0,
		}],
		totalContainers: 2,
		runningContainers: 1,
		stoppedContainers: 1,
		warningContainers: 0,
		errorContainers: 0,
	}, 'all', 'api-live-1', 'status');

	assert.equal(filteredProjects[0].composeFileGroups[0].containers.length, 1);
	assert.equal(filteredProjects[0].composeFileGroups[0].containers[0].id, 'container-running-live');
	assert.deepEqual(filteredProjects[0].composeFileGroups[0].serviceNames, []);
	assert.deepEqual(buildDockerTableRows(filteredProjects).map(row => row.kind === 'container' ? row.container.id : row.kind), ['container-running-live']);
});

test('resolveFilteredDockerProjects search keeps stopped containers even when host compose groups omit them', () => {
	const runningContainer = createDockerContainer({
		id: 'container-running-visible',
		name: 'api-live-1',
		service: 'api-service',
	});
	const stoppedContainer = createDockerContainer({
		id: 'container-stopped-searchable',
		name: 'worker-stopped-1',
		service: 'worker-service',
		status: 'stopped',
		statusTone: 'neutral',
		statusText: 'Exited 3 minutes ago',
		startedAt: undefined,
		uptimeMs: 0,
		stats: undefined,
		samples: [],
	});
	const composeFile = { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' };
	const filteredProjects = resolveFilteredDockerProjects({
		enabled: true,
		available: true,
		generatedAt: '2026-04-29T10:00:00.000Z',
		defaultViewMode: 'table',
		composeFilePatterns: [],
		projects: [{
			project: 'api',
			projectPath: '/workspace/api',
			composeFiles: [composeFile],
			composeFileGroups: [{
				composeFile,
				containers: [runningContainer],
				serviceNames: ['api-service', 'worker-service'],
				runningCount: 1,
				stoppedCount: 0,
				warningCount: 0,
				errorCount: 0,
			}],
			containers: [runningContainer, stoppedContainer],
			runningCount: 1,
			stoppedCount: 1,
			warningCount: 0,
			errorCount: 0,
		}],
		totalContainers: 2,
		runningContainers: 1,
		stoppedContainers: 1,
		warningContainers: 0,
		errorContainers: 0,
	}, 'all', 'worker-stopped-1', 'status');

	assert.equal(filteredProjects[0].containers.length, 1);
	assert.equal(filteredProjects[0].containers[0].id, 'container-stopped-searchable');
	assert.equal(filteredProjects[0].composeFileGroups.length, 1);
	assert.equal(filteredProjects[0].composeFileGroups[0].containers[0].id, 'container-stopped-searchable');
	assert.deepEqual(buildDockerTableRows(filteredProjects).map(row => row.kind === 'container' ? row.container.id : row.kind), ['container-stopped-searchable']);
});

test('PromptDashboard restores persisted Docker search controls and shows a clear-search button', () => {
	const runningContainer = createDockerContainer({
		id: 'container-running-alpha',
		name: 'alpha-live-1',
		service: 'alpha-service',
	});
	const stoppedContainer = createDockerContainer({
		id: 'container-stopped-worker',
		name: 'worker-match-1',
		service: 'worker-service',
		status: 'stopped',
		statusTone: 'neutral',
		statusText: 'Exited 1 minute ago',
		startedAt: undefined,
		uptimeMs: 0,
		stats: undefined,
		samples: [],
	});
	const composeFile = { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' };
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [composeFile],
		composeFileGroups: [{
			composeFile,
			containers: [runningContainer, stoppedContainer],
			serviceNames: ['alpha-service', 'worker-service'],
			runningCount: 1,
			stoppedCount: 1,
			warningCount: 0,
			errorCount: 0,
		}],
		containers: [runningContainer, stoppedContainer],
		runningCount: 1,
		stoppedCount: 1,
		warningCount: 0,
		errorCount: 0,
	}];
	snapshot.docker.data.totalContainers = 2;
	snapshot.docker.data.runningContainers = 1;
	snapshot.docker.data.stoppedContainers = 1;

	const markup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({
				viewMode: 'table',
				statusFilter: 'stopped',
				search: 'worker-match-1',
				sortBy: 'name',
				expandedContainerIds: [],
			}),
		}),
	});

	assert.match(markup, /value="worker-match-1"/);
	assert.match(markup, /aria-label="Сбросить поиск"/);
	assert.match(markup, /<option value="stopped" selected="">Остановлены<\/option>/);
	assert.match(markup, /<option value="name" selected="">Имя<\/option>/);
	assert.match(markup, /worker-match-1/);
	assert.doesNotMatch(markup, /alpha-live-1/);
});

test('buildDockerTableRows keeps the sorted row order supplied by visible Docker groups', () => {
	const baseStats = createDockerContainer().stats!;
	const highCpuContainer = createDockerContainer({
		id: 'container-high',
		name: 'zzz-service-1',
		service: 'zzz-service',
		stats: { ...baseStats, cpuPercent: 92.4 },
	});
	const lowCpuContainer = createDockerContainer({
		id: 'container-low',
		name: 'aaa-service-1',
		service: 'aaa-service',
		stats: { ...baseStats, cpuPercent: 4.1 },
	});
	const composeFile = { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' };
	const rows = buildDockerTableRows([{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [composeFile],
		composeFileGroups: [{
			composeFile,
			containers: [highCpuContainer, lowCpuContainer],
			serviceNames: [],
			status: 'running',
			statusTone: 'ok',
			statusText: 'Запущено 2/2',
			runningCount: 2,
			stoppedCount: 0,
			warningCount: 0,
			errorCount: 0,
		}],
		containers: [highCpuContainer, lowCpuContainer],
		runningCount: 2,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}]);

	assert.equal(rows.length, 2);
	assert.match(rows[0].label, /zzz-service-1/);
	assert.match(rows[1].label, /aaa-service-1/);
});

/** Verifies that dense Docker table rows expose one compact menu trigger per row. */
test('PromptDashboard restores Docker table view and renders row action menus', () => {
	const container = createDockerContainer();
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' }],
		composeFileGroups: [{
			composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
			containers: [container],
			runningCount: 1,
			stoppedCount: 0,
			warningCount: 0,
			errorCount: 0,
		}],
		containers: [container],
		runningCount: 1,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}];
	snapshot.docker.data.totalContainers = 1;
	snapshot.docker.data.runningContainers = 1;

	const markup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({
				viewMode: 'table',
				expandedContainerIds: [container.id],
			}),
		}),
	});

	assert.match(markup, /Проект\/Compose\/Контейнер/);
	assert.match(markup, /grid-template-columns:minmax\(0, 1fr\) 32px 46px 46px 28px/);
	assert.match(markup, /data-docker-action-menu="true" data-docker-action-count="5"/);
	assert.match(markup, /\.pm-docker-action-menu-item:hover:not\(:disabled\)/);
	assert.match(markup, /\.pm-docker-action-menu-item:active:not\(:disabled\)/);
	assert.match(markup, /\.pm-docker-action-menu-item:focus-visible:not\(:disabled\)/);
	assert.match(markup, /api-service[\s\S]*aria-label="Действия контейнера api-service-1"[\s\S]*>⋮<\/button>/);
	assert.equal((markup.match(/>⋮<\/button>/g) || []).length, 1);
	assert.doesNotMatch(markup, /aria-label="Действия">⋮<\/span>/);
	assert.match(markup, /api-service[\s\S]*aria-label="Up 5 minutes"/);
	assert.match(markup, /<span[^>]*style="[^"]*width:18px;height:18px[^"]*border-radius:4px[^"]*"[^>]*aria-label="Up 5 minutes"/);
	assert.doesNotMatch(markup, /role="menu"/);
	assert.doesNotMatch(markup, /Открыть терминал в контейнере/);
	assert.doesNotMatch(markup, /Удалить остановленный контейнер/);
	assert.doesNotMatch(markup, /width:132px/);
	assert.match(markup, /12\.5%/);
	assert.match(markup, /Порты/);
	assert.doesNotMatch(markup, /aria-label="Открыть compose-файл docker-compose\.yml"/);
	assert.doesNotMatch(markup, />Логи</);
	assert.doesNotMatch(markup, />Терминал</);
	assert.doesNotMatch(markup, />Рестарт</);

	const busyMarkup = renderDashboard(snapshot, {
		busyAction: buildPromptDashboardDockerContainerBusyAction({ containerId: container.id, action: 'restart' }),
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'table', expandedContainerIds: [] }),
		}),
	});
	assert.match(busyMarkup, /aria-label="Действия контейнера api-service-1"[\s\S]*aria-busy="true"[\s\S]*pm-spin/);

	const multiBusyMarkup = renderDashboard(snapshot, {
		dockerBusyAction: [
			buildPromptDashboardDockerContainerBusyAction({ containerId: container.id, action: 'restart' }),
			buildPromptDashboardDockerWorkspaceBusyAction({ action: 'stopAll' }),
		].join('\n'),
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'table', expandedContainerIds: [] }),
		}),
	});
	assert.match(multiBusyMarkup, /aria-label="Действия контейнера api-service-1"[\s\S]*aria-busy="true"[\s\S]*pm-spin/);
	assert.match(multiBusyMarkup, /aria-label="Остановить все контейнеры рабочей области" disabled=""[\s\S]*pm-spin/);
});

test('PromptDashboard renders Docker summary restart action for running containers and restore action otherwise', () => {
	const snapshot = createSnapshot([]);
	snapshot.docker.data.totalContainers = 4;
	snapshot.docker.data.runningContainers = 3;
	snapshot.docker.data.stoppedContainers = 1;
	snapshot.docker.data.restorableContainersCount = 2;

	const enabledMarkup = renderDashboard(snapshot, {
		busyAction: buildPromptDashboardDockerWorkspaceBusyAction({ action: 'restartAll' }),
	});
	assert.match(enabledMarkup, /aria-label="Перезапустить все запущенные контейнеры рабочей области" disabled=""[\s\S]*pm-spin/);
	assert.match(enabledMarkup, /aria-label="Остановить все контейнеры рабочей области"/);

	const disabledSnapshot = createSnapshot([]);
	disabledSnapshot.docker.data.totalContainers = 1;
	disabledSnapshot.docker.data.runningContainers = 0;
	disabledSnapshot.docker.data.stoppedContainers = 1;
	disabledSnapshot.docker.data.restorableContainersCount = 2;
	const disabledMarkup = renderDashboard(disabledSnapshot);
	assert.match(disabledMarkup, /aria-label="Запустить предыдущие контейнеры \(2\)"/);
	assert.doesNotMatch(disabledMarkup, /aria-label="Перезапустить все запущенные контейнеры рабочей области"/);

	const unavailableSnapshot = createSnapshot([]);
	unavailableSnapshot.docker.data.totalContainers = 1;
	unavailableSnapshot.docker.data.runningContainers = 0;
	unavailableSnapshot.docker.data.stoppedContainers = 1;
	unavailableSnapshot.docker.data.restorableContainersCount = 0;
	const unavailableMarkup = renderDashboard(unavailableSnapshot);
	assert.match(unavailableMarkup, /aria-label="Запустить предыдущие контейнеры"[^>]*disabled=""/);
	assert.match(disabledMarkup, /aria-label="Остановить все контейнеры рабочей области"[^>]*disabled=""/);
});

test('PromptDashboard renders ToDo markers as a filterable tree with line links', () => {
	const snapshot = createSnapshot([]);
	snapshot.todos = {
		kind: 'todos',
		cache: { status: 'fresh', source: 'refresh', updatedAt: '2026-04-29T10:00:00.000Z' },
		data: buildPromptDashboardTodosData({
			markers: [{
				id: 'api:src%2Fapp.ts:12:4:todo',
				project: 'api',
				filePath: 'src/app.ts',
				fileType: 'ts',
				marker: 'todo',
				token: 'todo',
				line: 12,
				column: 4,
				preview: '// todo: wire widget',
			}],
			scannedFileCount: 20,
			skippedFileCount: 1,
			maxResults: 500,
			truncated: false,
		}),
	};

	const markup = renderDashboard(snapshot);

	assert.match(markup, /ToDo/);
	assert.match(markup, /\.ts 1/);
	assert.match(markup, /api/);
	assert.match(markup, />src<\/span>/);
	assert.match(markup, />app\.ts<\/span>/);
	assert.match(markup, /todo/);
	assert.match(markup, /12/);
	assert.match(markup, /wire widget/);
});

test('PromptDashboard groups ToDo files by full folder path', () => {
	const snapshot = createSnapshot([]);
	snapshot.todos = {
		kind: 'todos',
		cache: { status: 'fresh', source: 'refresh', updatedAt: '2026-04-29T10:00:00.000Z' },
		data: buildPromptDashboardTodosData({
			markers: [
				{
					id: 'api:app%2Fdomains%2Fexample.php:10:4:todo',
					project: 'api',
					filePath: 'app/domains/example.php',
					fileType: 'php',
					marker: 'todo',
					token: 'todo',
					line: 10,
					column: 4,
					preview: '// todo: domain marker',
				},
				{
					id: 'api:app%2Fservices%2Fservice.php:4:8:todo',
					project: 'api',
					filePath: 'app/services/service.php',
					fileType: 'php',
					marker: 'todo',
					token: 'todo',
					line: 4,
					column: 8,
					preview: '// todo: service marker',
				},
			],
			scannedFileCount: 20,
			skippedFileCount: 1,
			maxResults: 500,
			truncated: false,
		}),
	};

	const markup = renderDashboard(snapshot);

	assert.match(markup, />app\/domains<\/span>/);
	assert.match(markup, />app\/services<\/span>/);
	assert.match(markup, />example\.php<\/span>/);
	assert.match(markup, />service\.php<\/span>/);
	assert.doesNotMatch(markup, />app<\/span>/);
	assert.doesNotMatch(markup, />domains<\/span>/);
});

test('PromptDashboard renders Docker Compose project orchestration icon buttons', () => {
	const container = createDockerContainer();
	const workerContainer = createDockerContainer({
		id: 'container-worker987654321',
		shortId: 'container-wo',
		name: 'worker-service-1',
		service: 'worker-service',
		composeFilePaths: ['/workspace/api/compose.worker.yml'],
	});
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [
			{
				project: 'api',
				projectPath: '/workspace/api',
				filePath: '/workspace/api/docker-compose.yml',
				relativePath: 'docker-compose.yml',
			},
			{
				project: 'api',
				projectPath: '/workspace/api',
				filePath: '/workspace/api/compose.worker.yml',
				relativePath: 'compose.worker.yml',
			},
		],
		composeFileGroups: [
			{
				composeFile: {
					project: 'api',
					projectPath: '/workspace/api',
					filePath: '/workspace/api/docker-compose.yml',
					relativePath: 'docker-compose.yml',
				},
				containers: [container],
				runningCount: 1,
				stoppedCount: 0,
				warningCount: 0,
				errorCount: 0,
			},
			{
				composeFile: {
					project: 'api',
					projectPath: '/workspace/api',
					filePath: '/workspace/api/compose.worker.yml',
					relativePath: 'compose.worker.yml',
				},
				containers: [workerContainer],
				runningCount: 1,
				stoppedCount: 0,
				warningCount: 0,
				errorCount: 0,
			},
		],
		containers: [container, workerContainer],
		runningCount: 2,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}];
	snapshot.docker.data.totalContainers = 2;
	snapshot.docker.data.runningContainers = 2;

	const markup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({
				expandedContainerIds: [
					'project:/workspace/api',
					'compose:/workspace/api:/workspace/api/docker-compose.yml',
					'compose:/workspace/api:/workspace/api/compose.worker.yml',
				],
			}),
		}),
	});

	assert.match(markup, /api[\s\S]*docker-compose\.yml[\s\S]*api-service/);
	assert.match(markup, /api-service[\s\S]*compose\.worker\.yml[\s\S]*worker-service/);
	assert.match(markup, /aria-label="Открыть compose-файл docker-compose.yml"/);
	assert.match(markup, /aria-label="Открыть compose-файл compose.worker.yml"/);
	assert.match(markup, /aria-label="Перезапустить compose-файл docker-compose.yml"/);
	assert.match(markup, /aria-label="Остановить compose-файл docker-compose.yml"/);
	assert.doesNotMatch(markup, /aria-label="Запустить compose-файл docker-compose.yml"/);
	assert.match(markup, /<button[^>]*style="[^"]*background:transparent[^"]*"[^>]*aria-label="Открыть логи контейнера"/);
	assert.doesNotMatch(markup, />up</);
	assert.doesNotMatch(markup, />down</);
});

test('PromptDashboard renders Docker tree project and compose disclosures', () => {
	const container = createDockerContainer();
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' }],
		composeFileGroups: [{
			composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
			containers: [container],
			runningCount: 1,
			stoppedCount: 0,
			warningCount: 0,
			errorCount: 0,
		}],
		containers: [container],
		runningCount: 1,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}];
	snapshot.docker.data.totalContainers = 1;
	snapshot.docker.data.runningContainers = 1;

	const collapsedMarkup = renderDashboard(snapshot);
	assert.match(collapsedMarkup, /aria-label="Раскрыть Docker-проект"/);
	assert.doesNotMatch(collapsedMarkup, /docker-compose\.yml/);

	const fileExpandedStorage = createStorageMock({
		'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({
			expandedContainerIds: [
				'project:/workspace/api',
				'compose:/workspace/api:/workspace/api/docker-compose.yml',
			],
		}),
	});
	const expandedMarkup = renderDashboard(snapshot, { localStorage: fileExpandedStorage });
	assert.match(expandedMarkup, /aria-label="Свернуть Docker-проект"/);
	assert.match(expandedMarkup, /aria-label="Свернуть compose-файл"/);
	assert.match(expandedMarkup, /docker-compose\.yml[\s\S]*api-service/);
	assert.match(expandedMarkup, /grid-template-columns:auto 18px minmax\(0, 1fr\) auto;align-items:start/);
	assert.match(expandedMarkup, /api-service-1[\s\S]*aria-label="Up 5 minutes"/);
	assert.doesNotMatch(expandedMarkup, /api-service-1[\s\S]*>запущен<\/span>/);
	assert.match(expandedMarkup, /└─[\s\S]*docker-compose\.yml/);
	assert.doesNotMatch(expandedMarkup, /СЕТЬ/);

	const detailsExpandedMarkup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({
				expandedContainerIds: [
					'project:/workspace/api',
					'compose:/workspace/api:/workspace/api/docker-compose.yml',
					container.id,
				],
			}),
		}),
	});
	assert.match(detailsExpandedMarkup, /СЕТЬ[\s\S]*>ID</);
});

test('PromptDashboard hides stopped container resource metrics and shows start action', () => {
	const container = createDockerContainer({
		status: 'stopped',
		statusTone: 'neutral',
		statusText: 'Exited 2 minutes ago',
		startedAt: undefined,
		finishedAt: '2026-04-29T09:55:00.000Z',
		uptimeMs: 0,
		stats: undefined,
		samples: [],
	});
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' }],
		composeFileGroups: [{
			composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
			containers: [container],
			serviceNames: ['api-service'],
			status: 'stopped',
			statusTone: 'neutral',
			statusText: 'Остановлен',
			runningCount: 0,
			stoppedCount: 1,
			warningCount: 0,
			errorCount: 0,
		}],
		containers: [container],
		runningCount: 0,
		stoppedCount: 1,
		warningCount: 0,
		errorCount: 0,
	}];
	snapshot.docker.data.totalContainers = 1;
	snapshot.docker.data.stoppedContainers = 1;

	const expandedTreeMarkup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({
				expandedContainerIds: [
					'project:/workspace/api',
					'compose:/workspace/api:/workspace/api/docker-compose.yml',
					container.id,
				],
			}),
		}),
	});
	assert.doesNotMatch(expandedTreeMarkup, />СЕТЬ<\/span>/);
	assert.doesNotMatch(expandedTreeMarkup, />CPU<\/span>/);
	assert.match(expandedTreeMarkup, /api-service-1[\s\S]*aria-label="Exited 2 minutes ago"/);
	assert.match(expandedTreeMarkup, /<span[^>]*style="[^"]*width:18px;height:18px[^"]*border-radius:4px[^"]*"[^>]*aria-label="Exited 2 minutes ago"/);
	assert.doesNotMatch(expandedTreeMarkup, /api-service-1[\s\S]*>остановлен<\/span>/);
	assert.match(expandedTreeMarkup, /aria-label="Запустить контейнер"/);
	assert.doesNotMatch(expandedTreeMarkup, /aria-label="Перезапустить контейнер"/);

	const cardsMarkup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'cards', expandedContainerIds: [container.id] }),
		}),
	});
	assert.doesNotMatch(cardsMarkup, />СЕТЬ<\/span>/);
	assert.doesNotMatch(cardsMarkup, />CPU<\/span>/);
	assert.doesNotMatch(cardsMarkup, />RAM<\/span>/);

	const tableMarkup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'table', expandedContainerIds: [] }),
		}),
	});
	assert.match(tableMarkup, /api-service[\s\S]*aria-label="Exited 2 minutes ago"[\s\S]*>—<\/span>[\s\S]*>—<\/span>/);
});

test('PromptDashboard formats running Docker RAM values in MiB instead of percent', () => {
	const baseStats = createDockerContainer().stats!;
	const container = createDockerContainer({
		stats: {
			...baseStats,
			memoryUsageBytes: 4.4 * 1024 * 1024,
			memoryPercent: 9.8,
		},
	});
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' }],
		composeFileGroups: [{
			composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
			containers: [container],
			runningCount: 1,
			stoppedCount: 0,
			warningCount: 0,
			errorCount: 0,
		}],
		containers: [container],
		runningCount: 1,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}];
	snapshot.docker.data.totalContainers = 1;
	snapshot.docker.data.runningContainers = 1;

	const cardsMarkup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'cards', expandedContainerIds: [container.id] }),
		}),
	});
	assert.match(cardsMarkup, />CPU<\/span>[\s\S]*>12\.5%<\/span>/);
	assert.match(cardsMarkup, />RAM<\/span>[\s\S]*>4\.4 МБ<\/span>/);
	assert.doesNotMatch(cardsMarkup, />9\.8%<\/span>/);

	const tableMarkup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'table', expandedContainerIds: [] }),
		}),
	});
	assert.match(tableMarkup, /api-service[\s\S]*>4\.4 МБ<\/span>/);
});

test('PromptDashboard formats Docker RAM above 1000 MiB as GiB with two decimals', () => {
	const baseStats = createDockerContainer().stats!;
	const container = createDockerContainer({
		stats: {
			...baseStats,
			memoryUsageBytes: 1123 * 1024 * 1024,
			memoryPercent: 55.4,
		},
	});
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' }],
		composeFileGroups: [{
			composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
			containers: [container],
			runningCount: 1,
			stoppedCount: 0,
			warningCount: 0,
			errorCount: 0,
		}],
		containers: [container],
		runningCount: 1,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}];
	snapshot.docker.data.totalContainers = 1;
	snapshot.docker.data.runningContainers = 1;

	const cardsMarkup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'cards', expandedContainerIds: [container.id] }),
		}),
	});
	assert.match(cardsMarkup, />RAM<\/span>[\s\S]*>1\.12 ГБ<\/span>/);
	assert.doesNotMatch(cardsMarkup, />1123 МБ<\/span>/);

	const tableMarkup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'table', expandedContainerIds: [] }),
		}),
	});
	assert.match(tableMarkup, /api-service[\s\S]*>1\.12 ГБ<\/span>/);
});

test('PromptDashboard renders a lightweight five-minute Docker trend chart with network history', () => {
	const samples = Array.from({ length: 90 }, (_, index) => ({
		readAt: new Date(Date.parse('2026-04-29T10:00:00.000Z') - ((89 - index) * 3000)).toISOString(),
		cpuPercent: 0.2 + ((index % 9) * 0.15),
		memoryPercent: 6 + (index % 4),
		memoryUsageBytes: (900 + (index * 3)) * 1024 * 1024,
		networkRxRateBytesPerSecond: 6000 + (index * 40),
		networkTxRateBytesPerSecond: 4000 + (index * 25),
	}));
	const container = createDockerContainer({ samples });
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' }],
		composeFileGroups: [{
			composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
			containers: [container],
			runningCount: 1,
			stoppedCount: 0,
			warningCount: 0,
			errorCount: 0,
		}],
		containers: [container],
		runningCount: 1,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}];
	snapshot.docker.data.totalContainers = 1;
	snapshot.docker.data.runningContainers = 1;

	const markup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'cards', expandedContainerIds: [container.id] }),
		}),
	});
	assert.match(markup, /preserveAspectRatio="none"/);
	assert.match(markup, />5 мин<\/text>/);
	assert.match(markup, /stroke="var\(--vscode-charts-blue, var\(--vscode-textLink-foreground\)\)"/);
	assert.match(markup, /stroke="var\(--vscode-charts-green\)"/);
	assert.match(markup, /stroke="#f97316"/);
	assert.doesNotMatch(markup, /Недостаточно замеров/);
});

test('PromptDashboard splits Docker trend lines across long refresh gaps after hidden periods', () => {
	const baseTimeMs = Date.parse('2026-04-29T10:00:00.000Z');
	const samples = [
		{ readAt: new Date(baseTimeMs).toISOString(), cpuPercent: 20, memoryPercent: 25, memoryUsageBytes: 256 * 1024 * 1024, networkRxRateBytesPerSecond: 1024, networkTxRateBytesPerSecond: 1024 },
		{ readAt: new Date(baseTimeMs + 1000).toISOString(), cpuPercent: 21, memoryPercent: 25, memoryUsageBytes: 258 * 1024 * 1024, networkRxRateBytesPerSecond: 1024, networkTxRateBytesPerSecond: 1024 },
		{ readAt: new Date(baseTimeMs + 60000).toISOString(), cpuPercent: 19, memoryPercent: 24, memoryUsageBytes: 260 * 1024 * 1024, networkRxRateBytesPerSecond: 1024, networkTxRateBytesPerSecond: 1024 },
		{ readAt: new Date(baseTimeMs + 290000).toISOString(), cpuPercent: 31, memoryPercent: 28, memoryUsageBytes: 280 * 1024 * 1024, networkRxRateBytesPerSecond: 1024, networkTxRateBytesPerSecond: 1024 },
		{ readAt: new Date(baseTimeMs + 300000).toISOString(), cpuPercent: 33, memoryPercent: 29, memoryUsageBytes: 282 * 1024 * 1024, networkRxRateBytesPerSecond: 1024, networkTxRateBytesPerSecond: 1024 },
	];
	const container = createDockerContainer({
		samples,
		stats: {
			readAt: new Date(baseTimeMs + 300000).toISOString(),
			cpuPercent: 33,
			memoryPercent: 29,
			memoryUsageBytes: 282 * 1024 * 1024,
			memoryLimitBytes: 1024 * 1024 * 1024,
			networkRxBytes: 4096,
			networkTxBytes: 4096,
			networkRxRateBytesPerSecond: 1024,
			networkTxRateBytesPerSecond: 1024,
		},
	});
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [],
		composeFileGroups: [],
		containers: [container],
		runningCount: 1,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}];
	snapshot.docker.data.totalContainers = 1;
	snapshot.docker.data.runningContainers = 1;

	const markup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'cards', expandedContainerIds: [container.id] }),
		}),
	});
	assert.equal((markup.match(/stroke="#f97316"/g) || []).length, 2);
	assert.doesNotMatch(markup, /points="0,.*74,.*148,/);
});

test('buildDockerSparklineVisibleSamples keeps historical buckets stable when a new sample arrives', () => {
	const baseTimeMs = Date.parse('2026-04-29T10:00:00.000Z');
	const samples = Array.from({ length: 90 }, (_, index) => ({
		readAt: new Date(baseTimeMs + (index * 3000)).toISOString(),
		cpuPercent: 10 + (index % 6),
		memoryPercent: 20,
		memoryUsageBytes: (200 + index) * 1024 * 1024,
		networkRxRateBytesPerSecond: 2000 + (index * 15),
		networkTxRateBytesPerSecond: 1000 + (index * 10),
	}));
	const before = buildDockerSparklineVisibleSamples(samples);
	const after = buildDockerSparklineVisibleSamples([
		...samples,
		{
			readAt: new Date(baseTimeMs + (90 * 3000)).toISOString(),
			cpuPercent: 14,
			memoryPercent: 20,
			memoryUsageBytes: 290 * 1024 * 1024,
			networkRxRateBytesPerSecond: 3400,
			networkTxRateBytesPerSecond: 2200,
		},
	]);
	assert.deepEqual(after.slice(0, before.length), before);
});

/** Verifies that live metrics run only for resource surfaces that are actually expanded. */
test('resolvePromptDashboardDockerLiveMetricsVisible follows actual Docker resource-block visibility', () => {
	const container = createDockerContainer();
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' }],
		composeFileGroups: [{
			composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
			containers: [container],
			runningCount: 1,
			stoppedCount: 0,
			warningCount: 0,
			errorCount: 0,
		}],
		containers: [container],
		runningCount: 1,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}];
	snapshot.docker.data.totalContainers = 1;
	snapshot.docker.data.runningContainers = 1;

	assert.equal(resolvePromptDashboardDockerLiveMetricsVisible({
		data: snapshot.docker.data,
		viewMode: 'table',
		statusFilter: 'all',
		search: '',
		sortBy: 'status',
		expanded: {},
		collapsedSections: {},
		mode: 'full',
	}), true);

	assert.equal(resolvePromptDashboardDockerLiveMetricsVisible({
		data: snapshot.docker.data,
		viewMode: 'list',
		statusFilter: 'all',
		search: '',
		sortBy: 'status',
		expanded: {},
		collapsedSections: {},
		mode: 'full',
	}), false);

	assert.equal(resolvePromptDashboardDockerLiveMetricsVisible({
		data: snapshot.docker.data,
		viewMode: 'list',
		statusFilter: 'all',
		search: '',
		sortBy: 'status',
		expanded: { [`docker:${container.id}`]: true },
		collapsedSections: {},
		mode: 'full',
	}), true);

	assert.equal(resolvePromptDashboardDockerLiveMetricsVisible({
		data: snapshot.docker.data,
		viewMode: 'cards',
		statusFilter: 'all',
		search: '',
		sortBy: 'status',
		expanded: {},
		collapsedSections: {},
		mode: 'full',
	}), false);

	assert.equal(resolvePromptDashboardDockerLiveMetricsVisible({
		data: snapshot.docker.data,
		viewMode: 'cards',
		statusFilter: 'all',
		search: '',
		sortBy: 'status',
		expanded: { [`docker:${container.id}`]: true },
		collapsedSections: {},
		mode: 'full',
	}), true);

	assert.equal(resolvePromptDashboardDockerLiveMetricsVisible({
		data: snapshot.docker.data,
		viewMode: 'cards',
		statusFilter: 'all',
		search: '',
		sortBy: 'status',
		expanded: { 'docker:compose:/workspace/api:/workspace/api/docker-compose.yml': true },
		collapsedSections: {},
		mode: 'full',
	}), true);

	assert.equal(resolvePromptDashboardDockerLiveMetricsVisible({
		data: snapshot.docker.data,
		viewMode: 'tree',
		statusFilter: 'all',
		search: '',
		sortBy: 'status',
		expanded: {},
		collapsedSections: {},
		mode: 'full',
	}), false);

	assert.equal(resolvePromptDashboardDockerLiveMetricsVisible({
		data: snapshot.docker.data,
		viewMode: 'tree',
		statusFilter: 'all',
		search: '',
		sortBy: 'status',
		expanded: {
			'docker:project:/workspace/api': true,
			'docker:compose:/workspace/api:/workspace/api/docker-compose.yml': true,
			[`docker:${container.id}`]: true,
		},
		collapsedSections: {},
		mode: 'full',
	}), true);

	assert.equal(resolvePromptDashboardDockerLiveMetricsVisible({
		data: snapshot.docker.data,
		viewMode: 'cards',
		statusFilter: 'all',
		search: '',
		sortBy: 'status',
		expanded: {},
		collapsedSections: { dockerContainers: true } as any,
		mode: 'full',
	}), false);
});

/** Verifies collapsed card and table-menu behavior for services without created containers. */
test('PromptDashboard keeps empty Docker compose projects visible and disables inactive compose actions', () => {
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' }],
		composeFileGroups: [{
			composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
			containers: [],
			serviceNames: ['api-service', 'db'],
			status: 'stopped',
			statusTone: 'neutral',
			statusText: 'Остановлен',
			runningCount: 0,
			stoppedCount: 0,
			warningCount: 0,
			errorCount: 0,
		}],
		containers: [],
		runningCount: 0,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}];

	const markup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({
				expandedContainerIds: [
					'project:/workspace/api',
					'compose:/workspace/api:/workspace/api/docker-compose.yml',
				],
			}),
		}),
	});

	assert.match(markup, /api[\s\S]*docker-compose\.yml[\s\S]*api-service[\s\S]*db/);
	assert.match(markup, /aria-label="Запустить compose-файл docker-compose.yml"/);
	assert.match(markup, /aria-label="Открыть compose-файл docker-compose.yml"/);
	assert.doesNotMatch(markup, /Контейнеров нет/);
	assert.match(markup, /aria-label="Остановить compose-файл docker-compose\.yml" disabled=""/);
	assert.doesNotMatch(markup, /aria-label="Перезапустить compose-файл docker-compose\.yml"/);
	assert.doesNotMatch(markup, /aria-label="Запустить compose-файл docker-compose\.yml" disabled=""/);

	const cardsMarkup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'cards' }),
		}),
	});
	assert.match(cardsMarkup, /aria-label="Раскрыть карточку compose-файла docker-compose.yml"[^>]*aria-expanded="false"/);
	assert.match(cardsMarkup, /aria-label="Раскрыть карточку сервиса api-service"[^>]*aria-expanded="false"/);
	assert.match(cardsMarkup, /api-service[\s\S]*остановлен/);
	assert.doesNotMatch(cardsMarkup, /api\/docker-compose\.yml<\/span>/);
	assert.doesNotMatch(cardsMarkup, /aria-label="Запустить compose-файл docker-compose.yml"/);
	assert.doesNotMatch(cardsMarkup, /Контейнеров нет/);

	const tableMarkup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'table' }),
		}),
	});
	assert.match(tableMarkup, /Проект\/Compose\/Контейнер/);
	assert.match(tableMarkup, /api\/docker-compose\.yml\/api-service[\s\S]*aria-label="Контейнер не создан или остановлен"[\s\S]*>—<\/span>[\s\S]*>—<\/span>/);
	assert.match(tableMarkup, /data-docker-action-menu="true" data-docker-action-count="3"/);
	assert.match(tableMarkup, /aria-label="Действия сервиса api-service"/);
	assert.doesNotMatch(tableMarkup, /role="menu"/);
});

test('PromptDashboard tree service rows keep the disclosure column width and outlined stopped status', () => {
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' }],
		composeFileGroups: [{
			composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
			containers: [],
			serviceNames: ['db', 'redis'],
			status: 'stopped',
			statusTone: 'neutral',
			statusText: 'Остановлен',
			runningCount: 0,
			stoppedCount: 0,
			warningCount: 0,
			errorCount: 0,
		}],
		containers: [],
		runningCount: 0,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}];

	const markup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({
				expandedContainerIds: [
					'project:/workspace/api',
					'compose:/workspace/api:/workspace/api/docker-compose.yml',
				],
			}),
		}),
	});

	assert.match(markup, /db[\s\S]*aria-label="Контейнер не создан или остановлен"/);
	assert.doesNotMatch(markup, /db[\s\S]*>остановлен<\/span>/);
	assert.match(markup, /grid-template-columns:auto 18px minmax\(0, 1fr\) auto;align-items:start/);
	assert.match(markup, /<span[^>]*style="[^"]*width:18px;height:18px[^"]*border-radius:4px[^"]*"[^>]*aria-label="Контейнер не создан или остановлен"/);
});

/** Verifies that every Docker card restores its compact or expanded persisted state. */
test('PromptDashboard card view reveals secondary Docker content only after persisted expansion', () => {
	const apiContainer = createDockerContainer({
		name: '',
		service: 'api',
		composeFilePaths: ['/workspace/api/docker-compose.yml'],
	});
	const workerContainer = createDockerContainer({
		id: 'container-worker123456789',
		shortId: 'container-wo',
		name: 'api-container-2',
		service: 'api',
		composeFilePaths: ['/workspace/api/compose.worker.yml'],
	});
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [
			{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
			{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/compose.worker.yml', relativePath: 'compose.worker.yml' },
		],
		composeFileGroups: [
			{
				composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
				containers: [apiContainer],
				serviceNames: ['api', 'worker-declared'],
				runningCount: 1,
				stoppedCount: 0,
				warningCount: 0,
				errorCount: 0,
			},
			{
				composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/compose.worker.yml', relativePath: 'compose.worker.yml' },
				containers: [workerContainer],
				runningCount: 1,
				stoppedCount: 0,
				warningCount: 0,
				errorCount: 0,
			},
		],
		containers: [apiContainer, workerContainer],
		runningCount: 2,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}];
	snapshot.docker.data.totalContainers = 2;
	snapshot.docker.data.runningContainers = 2;

	const markup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'cards' }),
		}),
	});

	assert.match(markup, /aria-label="Раскрыть карточку compose-файла docker-compose.yml"[^>]*aria-expanded="false"/);
	assert.match(markup, /aria-label="Раскрыть карточку сервиса worker-declared"[^>]*aria-expanded="false"/);
	assert.match(markup, /api[\s\S]*запущен/);
	assert.match(markup, /api-container-2[\s\S]*запущен/);
	assert.doesNotMatch(markup, /docker-compose\.yml · example\/api:latest<\/span>/);
	assert.doesNotMatch(markup, /api\/docker-compose\.yml<\/span>/);
	assert.doesNotMatch(markup, /aria-label="Открыть логи контейнера"/);
	assert.doesNotMatch(markup, />CPU<\/span>/);
	assert.doesNotMatch(markup, />RAM<\/span>/);
	assert.doesNotMatch(markup, /Контейнеров нет/);

	const expandedMarkup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({
				viewMode: 'cards',
				expandedContainerIds: [
					'compose:/workspace/api:/workspace/api/docker-compose.yml',
					apiContainer.id,
					'declared:/workspace/api/docker-compose.yml:worker-declared',
				],
			}),
		}),
	});
	assert.match(expandedMarkup, /aria-label="Свернуть карточку compose-файла docker-compose.yml"[^>]*aria-expanded="true"/);
	assert.match(expandedMarkup, /aria-label="Свернуть карточку сервиса worker-declared"[^>]*aria-expanded="true"/);
	assert.match(expandedMarkup, /aria-label="Скрыть детали контейнера"/);
	assert.match(expandedMarkup, /api · 1\/1/);
	assert.match(expandedMarkup, /docker-compose\.yml · example\/api:latest/);
	assert.match(expandedMarkup, /api\/docker-compose\.yml/);
	assert.match(expandedMarkup, /aria-label="Открыть compose-файл docker-compose.yml"/);
	assert.match(expandedMarkup, /aria-label="Открыть логи контейнера"/);
	assert.match(expandedMarkup, />CPU<\/span>[\s\S]*>12\.5%<\/span>/);
	assert.match(expandedMarkup, />RAM<\/span>[\s\S]*>100 МБ<\/span>/);
});

test('PromptDashboard shows loader and inline error for a hidden Docker compose action', () => {
	const snapshot = createSnapshot([]);
	snapshot.docker.data.composeActionError = {
		projectPath: '/workspace/api',
		composeFilePath: '/workspace/api/docker-compose.yml',
		action: 'up',
		message: 'service api failed to start',
		createdAt: '2026-04-29T10:05:00.000Z',
	};
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' }],
		composeFileGroups: [{
			composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
			containers: [],
			runningCount: 0,
			stoppedCount: 0,
			warningCount: 0,
			errorCount: 0,
		}],
		containers: [],
		runningCount: 0,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}];

	const markup = renderDashboard(snapshot, {
		busyAction: buildPromptDashboardDockerComposeBusyAction({
			projectPath: '/workspace/api',
			composeFilePath: '/workspace/api/docker-compose.yml',
			action: 'up',
		}),
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({
				expandedContainerIds: [
					'project:/workspace/api',
					'compose:/workspace/api:/workspace/api/docker-compose.yml',
				],
			}),
		}),
	});

	assert.match(markup, /aria-label="Запустить compose-файл docker-compose\.yml" disabled=""[\s\S]*pm-spin/);
	assert.match(markup, /Ошибка docker compose up[\s\S]*service api failed to start/);
});

/** Verifies that empty Compose rows retain their compact action-menu entry in the flat table. */
test('PromptDashboard flattens Docker table rows while keeping empty compose files visible', () => {
	const container = createDockerContainer({ project: 'web', composeWorkingDir: '/workspace/web', composeFilePaths: ['/workspace/web/docker-compose.yml'] });
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [
		{
			project: 'api',
			projectPath: '/workspace/api',
			composeFiles: [{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' }],
			composeFileGroups: [{ composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' }, containers: [], runningCount: 0, stoppedCount: 0, warningCount: 0, errorCount: 0 }],
			containers: [],
			runningCount: 0,
			stoppedCount: 0,
			warningCount: 0,
			errorCount: 0,
		},
		{
			project: 'web',
			projectPath: '/workspace/web',
			composeFiles: [{ project: 'web', projectPath: '/workspace/web', filePath: '/workspace/web/docker-compose.yml', relativePath: 'docker-compose.yml' }],
			composeFileGroups: [{ composeFile: { project: 'web', projectPath: '/workspace/web', filePath: '/workspace/web/docker-compose.yml', relativePath: 'docker-compose.yml' }, containers: [container], runningCount: 1, stoppedCount: 0, warningCount: 0, errorCount: 0 }],
			containers: [container],
			runningCount: 1,
			stoppedCount: 0,
			warningCount: 0,
			errorCount: 0,
		},
	];
	snapshot.docker.data.totalContainers = 1;
	snapshot.docker.data.runningContainers = 1;

	const markup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'table', expandedContainerIds: [] }),
		}),
	});

	assert.match(markup, /Проект\/Compose\/Контейнер/);
	assert.match(markup, /grid-template-columns:minmax\(0, 1fr\) 32px 46px 46px 28px/);
	assert.match(markup, /api\/docker-compose\.yml[\s\S]*api-service/);
	assert.match(markup, /data-docker-action-menu="true" data-docker-action-count="3"/);
	assert.match(markup, /aria-label="Действия compose-файла docker-compose.yml"/);
	assert.doesNotMatch(markup, /role="menu"/);
	assert.doesNotMatch(markup, /Проект\/Compose<\/span>[\s\S]*<span>Сервис<\/span>/);
});

test('PromptDashboard table view moves Docker disclosure into the first column and renders expanded runtime charts', () => {
	const runningContainer = createDockerContainer({
		name: 'api-service-1-with-a-very-long-container-name-for-ellipsis-check',
		samples: [
			{
				readAt: '2026-04-29T09:56:00.000Z',
				cpuPercent: 8,
				memoryPercent: 8.4,
				memoryUsageBytes: 88 * 1024 * 1024,
				networkRxRateBytesPerSecond: 120,
				networkTxRateBytesPerSecond: 80,
			},
			{
				readAt: '2026-04-29T10:00:00.000Z',
				cpuPercent: 12.5,
				memoryPercent: 9.8,
				memoryUsageBytes: 100 * 1024 * 1024,
				networkRxRateBytesPerSecond: 100,
				networkTxRateBytesPerSecond: 200,
			},
		],
	});
	const stoppedContainer = createDockerContainer({
		id: 'container-stopped123456',
		shortId: 'container-st',
		name: 'worker-service-1',
		service: 'worker-service',
		status: 'stopped',
		statusTone: 'neutral',
		statusText: 'Exited (0) 2 minutes ago',
		finishedAt: '2026-04-29T09:58:00.000Z',
		uptimeMs: 0,
		stats: undefined,
		samples: [],
	});
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' }],
		composeFileGroups: [{
			composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
			containers: [runningContainer, stoppedContainer],
			runningCount: 1,
			stoppedCount: 1,
			warningCount: 0,
			errorCount: 0,
		}],
		containers: [runningContainer, stoppedContainer],
		runningCount: 1,
		stoppedCount: 1,
		warningCount: 0,
		errorCount: 0,
	}];
	snapshot.docker.data.totalContainers = 2;
	snapshot.docker.data.runningContainers = 1;
	snapshot.docker.data.stoppedContainers = 1;

	const markup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'table', expandedContainerIds: [runningContainer.id] }),
		}),
	});

	assert.match(markup, /aria-label="Скрыть детали контейнера api-service-1-with-a-very-long-container-name-for-ellipsis-check"[^>]*aria-expanded="true"[^>]*>▾<\/button>/);
	assert.match(markup, /<button[^>]*aria-label="Скрыть детали контейнера api-service-1-with-a-very-long-container-name-for-ellipsis-check"[^>]*aria-expanded="true"[^>]*>[\s\S]*api-service-1-with-a-very-long-container-name-for-ellipsis-check[\s\S]*<\/button>/);
	assert.doesNotMatch(markup, /api-service-1-with-a-very-long-container-name-for-ellipsis-check<\/span><span style="[^"]*font-size:11px[^"]*">api\/docker-compose\.yml\/api-service-1-with-a-very-long-container-name-for-ellipsis-check<\/span>/);
	assert.doesNotMatch(markup, /M3\.5 3\.25h3\.25l1 1\.35h4\.75v8\.15h-9z/);
	assert.match(markup, /<span style="[^"]*overflow:hidden[^"]*text-overflow:ellipsis[^"]*white-space:nowrap[^"]*font-weight:700[^"]*color:var\(--vscode-foreground\)[^"]*">api-service-1-with-a-very-long-container-name-for-ellipsis-check<\/span>/);
	assert.match(markup, /<span style="[^"]*font-weight:700[^"]*color:var\(--vscode-descriptionForeground\)[^"]*">worker-service-1<\/span>/);
	assert.match(markup, /Контейнер:<\/span> api\/docker-compose\.yml\/api-service-1-with-a-very-long-container-name-for-ellipsis-check/);
	assert.match(markup, /СЕТЬ[\s\S]*5 мин/);
});

/** Verifies grouped list rows reveal three independent compact resource charts on expansion. */
test('PromptDashboard list view keeps containers grouped under their compose file', () => {
	const apiContainer = createDockerContainer({
		composeFilePaths: ['/workspace/api/docker-compose.yml'],
		samples: [
			{
				readAt: '2026-04-29T09:56:00.000Z',
				cpuPercent: 8,
				memoryPercent: 8.4,
				memoryUsageBytes: 88 * 1024 * 1024,
				networkRxRateBytesPerSecond: 120,
				networkTxRateBytesPerSecond: 80,
			},
			{
				readAt: '2026-04-29T10:00:00.000Z',
				cpuPercent: 12.5,
				memoryPercent: 9.8,
				memoryUsageBytes: 100 * 1024 * 1024,
				networkRxRateBytesPerSecond: 100,
				networkTxRateBytesPerSecond: 200,
			},
		],
	});
	const workerContainer = createDockerContainer({
		id: 'container-worker123456789',
		shortId: 'container-wo',
		name: 'worker-service-1',
		service: 'worker-service',
		composeFilePaths: ['/workspace/api/compose.worker.yml'],
	});
	const snapshot = createSnapshot([]);
	snapshot.docker.data.projects = [{
		project: 'api',
		projectPath: '/workspace/api',
		composeFiles: [
			{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
			{ project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/compose.worker.yml', relativePath: 'compose.worker.yml' },
		],
		composeFileGroups: [
			{
				composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/docker-compose.yml', relativePath: 'docker-compose.yml' },
				containers: [apiContainer],
				runningCount: 1,
				stoppedCount: 0,
				warningCount: 0,
				errorCount: 0,
			},
			{
				composeFile: { project: 'api', projectPath: '/workspace/api', filePath: '/workspace/api/compose.worker.yml', relativePath: 'compose.worker.yml' },
				containers: [workerContainer],
				runningCount: 1,
				stoppedCount: 0,
				warningCount: 0,
				errorCount: 0,
			},
		],
		containers: [apiContainer, workerContainer],
		runningCount: 2,
		stoppedCount: 0,
		warningCount: 0,
		errorCount: 0,
	}];
	snapshot.docker.data.totalContainers = 2;
	snapshot.docker.data.runningContainers = 2;

	const markup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'list', expandedContainerIds: [] }),
		}),
	});

	assert.match(markup, /docker-compose\.yml[\s\S]*api-service-1[\s\S]*compose\.worker\.yml[\s\S]*worker-service-1/);
	assert.match(markup, /grid-template-columns:minmax\(0, 1fr\) auto/);
	assert.doesNotMatch(markup, /data-docker-resource-layout="compact"/);
	assert.doesNotMatch(markup, /data-docker-metric-chart=/);
	assert.doesNotMatch(markup, />CPU<\/span>/);
	assert.doesNotMatch(markup, />RAM<\/span>/);
	assert.doesNotMatch(markup, />СЕТЬ<\/span>/);
	assert.doesNotMatch(markup, /docker-compose\.yml[\s\S]*compose\.worker\.yml[\s\S]*api-service-1/);

	const expandedMarkup = renderDashboard(snapshot, {
		localStorage: createStorageMock({
			'pm.promptDashboard.dockerWidgetState.v1': JSON.stringify({ viewMode: 'list', expandedContainerIds: [apiContainer.id] }),
		}),
	});
	assert.match(expandedMarkup, /data-docker-resource-layout="compact"/);
	assert.match(expandedMarkup, /data-docker-metric-chart="cpu"/);
	assert.match(expandedMarkup, /data-docker-metric-chart="memory"/);
	assert.match(expandedMarkup, /data-docker-metric-chart="network"/);
	assert.equal((expandedMarkup.match(/data-docker-metric-chart="/g) || []).length, 3);
});

test('PromptDashboard keeps Docker startup placeholder out of unavailable state', () => {
	const snapshot = createSnapshot([]);
	snapshot.docker.cache = { status: 'idle', source: 'cache', updatedAt: '2026-04-29T10:00:00.000Z' };
	snapshot.docker.data.available = true;

	const markup = renderDashboard(snapshot);

	assert.doesNotMatch(markup, /Docker Engine API недоступен/);
	assert.match(markup, /Compose-файлы рабочей области не найдены/);
});

test('isPromptDashboardBranchActionBusy ignores unrelated widget refreshes', () => {
	assert.equal(isPromptDashboardBranchActionBusy('refresh-section:activity'), false);
	assert.equal(isPromptDashboardBranchActionBusy('refresh-section:dockerContainers'), false);
	assert.equal(isPromptDashboardBranchActionBusy('docker:restart:container-abc123456789'), false);
	assert.equal(isPromptDashboardBranchActionBusy('switch-all'), true);
	assert.equal(isPromptDashboardBranchActionBusy('switch-project:api'), true);
	assert.equal(isPromptDashboardBranchActionBusy('pull-project:api'), true);
});

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

test('PromptDashboard renders a horizontal parallel branch graph with remote lanes', () => {
	const markup = renderDashboard(createSnapshot([createProject({
		parallelBranches: [
			{
				name: 'feature/alice',
				ref: 'origin/feature/alice',
				kind: 'remote',
				baseBranch: 'main',
				ahead: 7,
				behind: 3,
				lastCommit: {
					sha: 'abc123456789',
					shortSha: 'abc1234',
					subject: 'Alice branch update',
					author: 'Alice',
					committedAt: '2026-04-29T10:00:00.000Z',
					refNames: ['origin/feature/alice'],
				},
				affectedFiles: [{ status: 'M', path: 'src/alice.ts', additions: 1, deletions: 0, isBinary: false }],
				potentialConflicts: [],
			},
			{
				name: 'feature/bob',
				ref: 'feature/bob',
				kind: 'local',
				baseBranch: 'main',
				ahead: 2,
				behind: 0,
				lastCommit: {
					sha: 'def123456789',
					shortSha: 'def1234',
					subject: 'Bob branch update',
					author: 'Bob',
					committedAt: '2026-04-29T10:00:00.000Z',
					refNames: ['feature/bob'],
				},
				affectedFiles: [{ status: 'M', path: 'src/bob.ts', additions: 1, deletions: 0, isBinary: false }],
				potentialConflicts: [],
			},
		],
	})]));

	assert.match(markup, /data-pm-parallel-graph="api"/);
	assert.match(markup, /data-pm-parallel-graph-row="feature\/alice"/);
	assert.match(markup, /data-pm-parallel-graph-kind="remote"/);
	assert.match(markup, /База[\s\S]*main/);
	assert.match(markup, /красное слева, свои коммиты справа/);
	assert.match(markup, /remote • база main/);
	assert.match(markup, /local • база main/);

	const aliceAheadMatch = markup.match(/data-pm-parallel-graph-row="feature\/alice"[\s\S]*?data-pm-parallel-graph-ahead-width="(\d+)"/);
	const bobAheadMatch = markup.match(/data-pm-parallel-graph-row="feature\/bob"[\s\S]*?data-pm-parallel-graph-ahead-width="(\d+)"/);
	const aliceBehindMatch = markup.match(/data-pm-parallel-graph-row="feature\/alice"[\s\S]*?data-pm-parallel-graph-behind-width="(\d+)"/);
	const bobBehindMatch = markup.match(/data-pm-parallel-graph-row="feature\/bob"[\s\S]*?data-pm-parallel-graph-behind-width="(\d+)"/);

	assert.ok(aliceAheadMatch);
	assert.ok(bobAheadMatch);
	assert.ok(aliceBehindMatch);
	assert.ok(bobBehindMatch);
	assert.ok(Number(aliceAheadMatch[1]) > Number(bobAheadMatch[1]));
	assert.ok(Number(aliceBehindMatch[1]) > Number(bobBehindMatch[1]));
});

test('PromptDashboard keeps the branch lane color stable after conflict hydration', () => {
	const markup = renderDashboard(createSnapshot([createProject({
		parallelBranches: [{
			name: 'feature/conflict',
			ref: 'origin/feature/conflict',
			kind: 'remote',
			baseBranch: 'main',
			ahead: 5,
			behind: 2,
			lastCommit: {
				sha: 'abc123456789',
				shortSha: 'abc1234',
				subject: 'Conflict branch update',
				author: 'Alice',
				committedAt: '2026-04-29T10:00:00.000Z',
				refNames: ['origin/feature/conflict'],
			},
			affectedFiles: [{ status: 'M', path: 'src/conflict.ts', additions: 1, deletions: 0, isBinary: false }],
			potentialConflicts: [{ path: 'src/conflict.ts', reason: 'changed in current and parallel branch' }],
			detailsHydrated: true,
		}],
	})]));

	const laneMarkup = markup.match(/<svg[^>]*data-pm-parallel-graph-row="feature\/conflict"[\s\S]*?<\/svg>/)?.[0] || '';

	assert.ok(laneMarkup);
	assert.match(laneMarkup, /fill="var\(--vscode-charts-orange, #d19a66\)"/);
	assert.doesNotMatch(laneMarkup, /fill="var\(--vscode-charts-yellow, #d7ba7d\)"/);
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

test('PromptDashboard renders sections in the shared custom order', () => {
	const markup = renderDashboard(createSnapshot([createProject()]), {
		sectionOrder: [
			['aiAnalysis', 'activity', 'reviewRequests', 'projectCommits'],
			['status', 'projectBranches', 'parallelBranches'],
		],
	});

	const aiIndex = markup.indexOf('AI review');
	const activityIndex = markup.indexOf('Активные промпты');
	const statusIndex = markup.indexOf('Статус промпта');
	const projectBranchesIndex = markup.indexOf('Ветки проектов');

	assert.notEqual(aiIndex, -1);
	assert.notEqual(activityIndex, -1);
	assert.notEqual(statusIndex, -1);
	assert.notEqual(projectBranchesIndex, -1);
	assert.ok(aiIndex < activityIndex);
	assert.ok(activityIndex < statusIndex);
	assert.ok(statusIndex < projectBranchesIndex);
	assert.match(markup, /aria-label="Перетащить виджет: AI review"/);
	assert.match(markup, /data-pm-dashboard-section="aiAnalysis"/);
	assert.match(markup, /data-pm-dashboard-section="projectBranches"/);
});

test('reorderPromptDashboardSections moves a dragged section around the target and normalizes missing sections', () => {
	assert.deepEqual(
		reorderPromptDashboardSections(
			[
				['status', 'projectBranches'],
				['activity'],
			],
			'status',
			'projectBranches',
			'after',
		),
		[
			['projectBranches', 'status', 'parallelBranches', 'dockerContainers', 'aiAnalysis'],
			['activity', 'reviewRequests', 'projectCommits', 'todos'],
		],
	);

	assert.deepEqual(
		reorderPromptDashboardSections(
			[
				['status', 'projectBranches', 'parallelBranches', 'aiAnalysis'],
				['activity', 'reviewRequests', 'projectCommits'],
			],
			'projectCommits',
			'activity',
			'before',
		),
		[
			['status', 'projectBranches', 'parallelBranches', 'aiAnalysis', 'dockerContainers'],
			['projectCommits', 'activity', 'reviewRequests', 'todos'],
		],
	);
});

test('resolvePromptDashboardColumnDropIndicator keeps a valid drop target in column gaps and below the last card', () => {
	const sectionBounds = [
		{ section: 'status' as const, top: 0, bottom: 100 },
		{ section: 'activity' as const, top: 112, bottom: 212 },
		{ section: 'reviewRequests' as const, top: 224, bottom: 324 },
	];

	assert.deepEqual(
		resolvePromptDashboardColumnDropIndicator('status', 106, sectionBounds),
		{ section: 'activity', placement: 'before' },
	);

	assert.deepEqual(
		resolvePromptDashboardColumnDropIndicator('status', 380, sectionBounds),
		{ section: 'reviewRequests', placement: 'after' },
	);

	assert.equal(
		resolvePromptDashboardColumnDropIndicator('status', 40, [{ section: 'status', top: 0, bottom: 100 }]),
		null,
	);
});

test('resolvePromptDashboardSectionDropCommitIndicator reuses the pending slot when drop lands on the dragged card', () => {
	assert.deepEqual(
		resolvePromptDashboardSectionDropCommitIndicator(
			'status',
			null,
			{ section: 'reviewRequests', placement: 'after' },
		),
		{ section: 'reviewRequests', placement: 'after' },
	);

	assert.deepEqual(
		resolvePromptDashboardSectionDropCommitIndicator(
			'status',
			{ section: 'activity', placement: 'before' },
			{ section: 'reviewRequests', placement: 'after' },
		),
		{ section: 'activity', placement: 'before' },
	);

	assert.equal(
		resolvePromptDashboardSectionDropCommitIndicator(
			'status',
			null,
			{ section: 'status', placement: 'after' },
		),
		null,
	);
});

test('resolvePromptDashboardPointerDropIndicator selects the nearest column and slot without native drop events', () => {
	const columns = [
		{
			left: 0,
			right: 180,
			sections: [
				{ section: 'status' as const, top: 0, bottom: 100 },
				{ section: 'projectBranches' as const, top: 112, bottom: 212 },
			],
		},
		{
			left: 200,
			right: 380,
			sections: [
				{ section: 'activity' as const, top: 0, bottom: 100 },
				{ section: 'reviewRequests' as const, top: 112, bottom: 212 },
			],
		},
	];

	assert.deepEqual(
		resolvePromptDashboardPointerDropIndicator('status', 240, 150, columns),
		{ section: 'reviewRequests', placement: 'before' },
	);

	assert.deepEqual(
		resolvePromptDashboardPointerDropIndicator('status', 188, 260, columns),
		{ section: 'projectBranches', placement: 'after' },
	);

	assert.equal(
		resolvePromptDashboardPointerDropIndicator('status', 50, 40, [{ left: 0, right: 180, sections: [{ section: 'status', top: 0, bottom: 100 }] }]),
		null,
	);
});

test('PromptDashboard scopes a shared projects refresh spinner only to the clicked section header', () => {
	const markup = renderDashboard(createSnapshot([createProject()], 'loading'), {
		busyAction: 'refresh-section:projectBranches',
	});

	assert.match(
		markup,
		/Ветки проектов[\s\S]*?aria-label="Обновить виджет: Ветки проектов"[^>]*disabled=""/,
	);
	assert.match(
		markup,
		/MR\/PR[\s\S]*?<span style="font-size:11px;font-weight:600;color:var\(--vscode-descriptionForeground\);white-space:nowrap">1<\/span>[\s\S]*?aria-label="Обновить виджет: MR\/PR"/,
	);
	assert.doesNotMatch(
		markup,
		/MR\/PR[\s\S]*?aria-label="Обновить виджет: MR\/PR"[^>]*disabled=""/,
	);
});

test('PromptDashboard keeps disabled branch action buttons bordered and height-stable', () => {
	const markup = renderDashboard(createSnapshot([createProject()]), {
		busyAction: 'switch-all',
	});

	assert.match(markup, /min-height:28px/);
	assert.match(markup, /border-color:color-mix\(in srgb, var\(--vscode-panel-border\) 78%, var\(--vscode-descriptionForeground\)\)/);
});

test('PromptDashboard hides collapsed section body and its widget refresh button', () => {
	const snapshot = createSnapshot([createProject()]);
	snapshot.activity.data.today = [createActivityItem(1)];

	const markup = renderDashboard(snapshot, {
		collapsedSections: { activity: true },
	});

	assert.match(markup, /aria-label="Развернуть виджет: Активные промпты"/);
	assert.doesNotMatch(markup, /aria-label="Обновить виджет: Активные промпты"/);
	assert.doesNotMatch(markup, /Активный промпт 1/);
	assert.match(markup, /Активные промпты/);
});

test('PromptDashboard keeps the collapse toggle as the rightmost header action', () => {
	const markup = renderDashboard(createSnapshot([createProject()]));

	assert.match(
		markup,
		/Активные промпты[\s\S]*?aria-label="Обновить виджет: Активные промпты"[\s\S]*?aria-label="Свернуть виджет: Активные промпты"/,
	);
});

test('PromptDashboard renders section headers as interactive collapse toggles', () => {
	const markup = renderDashboard(createSnapshot([createProject()]), {
		collapsedSections: { activity: true },
	});

	assert.match(markup, /role="button"[^>]*aria-expanded="false"[^>]*>[\s\S]*?Активные промпты/);
});

test('PromptDashboard renders every today activity row without trimming the widget', () => {
	const snapshot = createSnapshot([createProject()]);

	// Fill the today group beyond the previous four-row UI cap.
	snapshot.activity.data.today = [1, 2, 3, 4, 5].map(index => createActivityItem(index));

	const markup = renderDashboard(snapshot);

	assert.match(
		markup,
		/Сегодня[\s\S]*Активный промпт 1[\s\S]*Активный промпт 2[\s\S]*Активный промпт 3[\s\S]*Активный промпт 4[\s\S]*Активный промпт 5/,
	);
});

test('PromptDashboard renders every previous-day activity row without trimming the widget', () => {
	const snapshot = createSnapshot([createProject()]);

	// Keep the custom previous-day label and verify the fifth row stays visible.
	snapshot.activity.data.yesterdayLabel = '12 мая';
	snapshot.activity.data.yesterday = [1, 2, 3, 4, 5].map(index => createActivityItem(index, {
		id: `previous-${index}`,
		promptUuid: `previous-uuid-${index}`,
		title: `Вчерашний промпт ${index}`,
		day: 'yesterday',
	}));

	const markup = renderDashboard(snapshot);

	assert.match(
		markup,
		/12 мая[\s\S]*Вчерашний промпт 1[\s\S]*Вчерашний промпт 2[\s\S]*Вчерашний промпт 3[\s\S]*Вчерашний промпт 4[\s\S]*Вчерашний промпт 5/,
	);
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

test('PromptDashboard hides unloaded shared Git section data until that section refresh completes', () => {
	const markup = renderDashboard(createSnapshot([
		createProject({
			review: {
				remote: null,
				request: {
					id: '31',
					number: '31',
					title: 'Should stay hidden until review refresh',
					url: 'https://example.test/pr/31',
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
		}),
	], 'fresh', undefined, ['parallelBranches']));

	assert.doesNotMatch(markup, /Should stay hidden until review refresh/);
	assert.match(markup, /Нет активных MR\/PR/);
	assert.match(markup, /feature\/parallel/);
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

test('resolveBranchDraftRefreshProjects keeps workspace-wide drafts available during refreshes', () => {
	const selectedProjects = [createProject({ project: 'api' })];
	const branchScopeProjects = [
		createProject({ project: 'api' }),
		createProject({ project: 'web', repositoryPath: '/workspace/web', currentBranch: 'main' }),
	];

	const nextDrafts = reconcileBranchDrafts(
		resolveBranchDraftRefreshProjects(selectedProjects, branchScopeProjects),
		{ web: 'develop' },
	);

	assert.deepEqual(nextDrafts, { web: 'develop' });
	assert.deepEqual(
		resolveBranchDraftRefreshProjects(selectedProjects, branchScopeProjects).map(project => project.project),
		['api', 'web'],
	);
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
	const markup = renderDashboard(createSnapshot([createProject()], 'loading'), { busyAction: 'refresh-section:projectBranches' });

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

test('PromptDashboard shows pull errors under the matching project row', () => {
	const markup = renderDashboard(createSnapshot([
		createProject({
			pullError: 'origin недоступен, получение отменено.',
		}),
	]));

	assert.match(markup, /Ошибка получения опережающих файлов/);
	assert.match(markup, /origin недоступен, получение отменено/);
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
