import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type TestStorage = Pick<Storage, 'clear' | 'getItem' | 'key' | 'removeItem' | 'setItem'> & { length: number };
type TestWindow = Window & {
	__LOCALE__?: string;
	__WEBVIEW_BOOT_ID__?: string;
	__PROMPT_DASHBOARD_COLLAPSED_SECTIONS__?: Record<string, unknown>;
	__PROMPT_DASHBOARD_SECTION_ORDER__?: string[];
	innerWidth?: number;
	localStorage: TestStorage;
};

function createStorage(): TestStorage {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key: string) => values.get(key) ?? null,
		key: (index: number) => Array.from(values.keys())[index] ?? null,
		removeItem: (key: string) => {
			values.delete(key);
		},
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
}

/** Provide the minimal webview globals needed to import and render EditorApp. */
async function withEditorAppEnvironment<T>(callback: (EditorApp: React.FC) => T | Promise<T>): Promise<T> {
	const globalScope = globalThis as typeof globalThis & { window?: TestWindow };
	const previousWindow = globalScope.window;
	const activeWindow = previousWindow || {} as TestWindow;
	const previousAcquire = (globalThis as Record<string, unknown>).acquireVsCodeApi;
	const previousLocale = activeWindow.__LOCALE__;
	const previousBootId = activeWindow.__WEBVIEW_BOOT_ID__;
	const previousPromptDashboardCollapsedSections = activeWindow.__PROMPT_DASHBOARD_COLLAPSED_SECTIONS__;
	const previousPromptDashboardSectionOrder = activeWindow.__PROMPT_DASHBOARD_SECTION_ORDER__;
	const previousInnerWidth = activeWindow.innerWidth;
	const previousLocalStorage = activeWindow.localStorage;

	if (previousWindow === undefined) {
		Object.defineProperty(globalScope, 'window', {
			value: activeWindow,
			configurable: true,
			writable: true,
		});
	}

	activeWindow.__LOCALE__ = 'en';
	activeWindow.__WEBVIEW_BOOT_ID__ = 'test-boot-id';
	activeWindow.__PROMPT_DASHBOARD_COLLAPSED_SECTIONS__ = undefined;
	activeWindow.__PROMPT_DASHBOARD_SECTION_ORDER__ = undefined;
	activeWindow.innerWidth = 1280;
	activeWindow.localStorage = createStorage();
	(globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
		postMessage: (_msg: unknown) => undefined,
		getState: () => ({}),
		setState: (_state: unknown) => undefined,
	});

	try {
		const { EditorApp } = await import('../src/webview/editor/EditorApp.js');
		return await callback(EditorApp);
	} finally {
		if (previousLocale === undefined) {
			delete activeWindow.__LOCALE__;
		} else {
			activeWindow.__LOCALE__ = previousLocale;
		}

		if (previousBootId === undefined) {
			delete activeWindow.__WEBVIEW_BOOT_ID__;
		} else {
			activeWindow.__WEBVIEW_BOOT_ID__ = previousBootId;
		}

		if (previousPromptDashboardCollapsedSections === undefined) {
			delete activeWindow.__PROMPT_DASHBOARD_COLLAPSED_SECTIONS__;
		} else {
			activeWindow.__PROMPT_DASHBOARD_COLLAPSED_SECTIONS__ = previousPromptDashboardCollapsedSections;
		}

		if (previousPromptDashboardSectionOrder === undefined) {
			delete activeWindow.__PROMPT_DASHBOARD_SECTION_ORDER__;
		} else {
			activeWindow.__PROMPT_DASHBOARD_SECTION_ORDER__ = previousPromptDashboardSectionOrder;
		}

		if (previousInnerWidth === undefined) {
			Reflect.deleteProperty(activeWindow as unknown as Record<string, unknown>, 'innerWidth');
		} else {
			activeWindow.innerWidth = previousInnerWidth;
		}

		if (previousLocalStorage === undefined) {
			Reflect.deleteProperty(activeWindow as unknown as Record<string, unknown>, 'localStorage');
		} else {
			activeWindow.localStorage = previousLocalStorage;
		}

		if (previousWindow === undefined) {
			Reflect.deleteProperty(globalScope as Record<string, unknown>, 'window');
		}

		if (previousAcquire === undefined) {
			Reflect.deleteProperty(globalThis as Record<string, unknown>, 'acquireVsCodeApi');
		} else {
			(globalThis as Record<string, unknown>).acquireVsCodeApi = previousAcquire;
		}
	}
}

test('EditorApp renders the initial prompt page without throwing', async () => {
	await withEditorAppEnvironment((EditorApp) => {
		const markup = renderToStaticMarkup(React.createElement(EditorApp));

		assert.ok(markup.length > 0);
		assert.match(markup, /data-pm-editor-loading-overlay="true"/);
		assert.match(markup, /Prompt details|Prompt content|Description/i);
	});
});

test('resolveInitialPromptDashboardCollapsedSections prefers boot state over retained webview state', async () => {
	await withEditorAppEnvironment(async () => {
		const { resolveInitialPromptDashboardCollapsedSections } = await import('../src/webview/editor/EditorApp.js');

		assert.deepEqual(
			resolveInitialPromptDashboardCollapsedSections(
				{ activity: true, aiAnalysis: true },
				{ status: true },
			),
			{ activity: true, aiAnalysis: true },
		);

		assert.deepEqual(
			resolveInitialPromptDashboardCollapsedSections(
				undefined,
				{ status: true, reviewRequests: true },
			),
			{ status: true, reviewRequests: true },
		);
	});
});

test('resolveInitialPromptDashboardSectionOrder prefers boot state over retained webview state', async () => {
	await withEditorAppEnvironment(async () => {
		const { resolveInitialPromptDashboardSectionOrder } = await import('../src/webview/editor/EditorApp.js');

		assert.deepEqual(
			resolveInitialPromptDashboardSectionOrder(
				['aiAnalysis', 'status', 'activity'],
				['projectBranches', 'status', 'activity'],
			),
			[
				['aiAnalysis', 'activity', 'projectBranches', 'parallelBranches', 'dockerContainers'],
				['status', 'reviewRequests', 'projectCommits', 'todos'],
			],
		);

		assert.deepEqual(
			resolveInitialPromptDashboardSectionOrder(
				undefined,
				['projectBranches', 'status', 'activity'],
			),
			[
				['projectBranches', 'activity', 'parallelBranches', 'dockerContainers', 'aiAnalysis'],
				['status', 'reviewRequests', 'projectCommits', 'todos'],
			],
		);
	});
});

test('buildPromptModelOptions sorts prompt AI models alphabetically', async () => {
	await withEditorAppEnvironment(async () => {
		const { buildPromptModelOptions } = await import('../src/webview/editor/EditorApp.js');
		const options = buildPromptModelOptions(
			[
				{ id: 'copilot/gpt-5.5', name: 'GPT-5.5' },
				{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
				{ id: 'gpt-4.1', name: 'GPT-4.1' },
			],
			'gpt-4.1',
		);

		assert.deepEqual(
			options.map(option => option.name),
			['Claude Sonnet 4', 'GPT-4.1', 'GPT-5.5'],
		);
	});
});

test('buildPromptModelOptions does not re-add hidden selected models after catalog load', async () => {
	await withEditorAppEnvironment(async () => {
		const { buildPromptModelOptions } = await import('../src/webview/editor/EditorApp.js');
		const options = buildPromptModelOptions(
			[
				{ id: 'copilot/gpt-5.5', name: 'GPT-5.5' },
				{ id: 'customendpoint/tokenator/claude-fable-5', name: 'Tokenator - Claude Fable 5' },
			],
			'copilot/gemini-3.5-flash',
		);

		assert.deepEqual(
			options.map(option => option.id),
			['copilot/gpt-5.5', 'customendpoint/tokenator/claude-fable-5'],
		);
	});
});

test('buildPromptModelOptions keeps saved Copilot model while catalog is still empty', async () => {
	await withEditorAppEnvironment(async () => {
		const { buildPromptModelOptions } = await import('../src/webview/editor/EditorApp.js');
		const options = buildPromptModelOptions([], 'copilot/claude-sonnet-4.6');

		assert.deepEqual(options, [
			{ id: 'copilot/claude-sonnet-4.6', name: 'copilot/claude-sonnet-4.6' },
		]);
	});
});

test('buildPromptModelOptions keeps saved external provider model while catalog is still empty', async () => {
	await withEditorAppEnvironment(async () => {
		const { buildPromptModelOptions } = await import('../src/webview/editor/EditorApp.js');
		const options = buildPromptModelOptions([], 'customendpoint/tokenator/claude-fable-5');

		assert.deepEqual(options, [
			{ id: 'customendpoint/tokenator/claude-fable-5', name: 'customendpoint/tokenator/claude-fable-5' },
		]);
	});
});

test('buildPromptModelOptions does not add the keep-current sentinel as a catalog entry', async () => {
	await withEditorAppEnvironment(async () => {
		const { buildPromptModelOptions } = await import('../src/webview/editor/EditorApp.js');
		const options = buildPromptModelOptions([], 'keep-current-model');

		assert.deepEqual(options, []);
	});
});

test('resolvePromptDashboardExpandRequest requests a full refresh when the first visible section reopens without a snapshot', async () => {
	await withEditorAppEnvironment(async () => {
		const { resolvePromptDashboardExpandRequest } = await import('../src/webview/editor/EditorApp.js');

		assert.deepEqual(resolvePromptDashboardExpandRequest({
			previousCollapsedSections: {
				status: true,
				activity: true,
				projectBranches: true,
				reviewRequests: true,
				parallelBranches: true,
				projectCommits: true,
				aiAnalysis: true,
			},
			nextCollapsedSections: {
				status: true,
				projectBranches: true,
				reviewRequests: true,
				parallelBranches: true,
				projectCommits: true,
				aiAnalysis: true,
			},
			section: 'activity',
			mode: 'full',
			snapshot: null,
		}), { type: 'refresh' });
	});
});

test('resolvePromptDashboardExpandRequest keeps the first reopened project section widget-scoped without a snapshot', async () => {
	await withEditorAppEnvironment(async () => {
		const { resolvePromptDashboardExpandRequest } = await import('../src/webview/editor/EditorApp.js');

		assert.deepEqual(resolvePromptDashboardExpandRequest({
			previousCollapsedSections: {
				status: true,
				activity: true,
				projectBranches: true,
				reviewRequests: true,
				parallelBranches: true,
				projectCommits: true,
				aiAnalysis: true,
			},
			nextCollapsedSections: {
				status: true,
				activity: true,
				reviewRequests: true,
				parallelBranches: true,
				projectCommits: true,
				aiAnalysis: true,
			},
			section: 'projectBranches',
			mode: 'full',
			snapshot: null,
		}), { type: 'widget', widget: 'projects' });
	});
});

test('mergePromptDashboardWidgetSnapshot bootstraps the first projects widget payload into a dashboard snapshot', async () => {
	await withEditorAppEnvironment(async () => {
		const { mergePromptDashboardWidgetSnapshot } = await import('../src/webview/editor/EditorApp.js');
		const { createPromptDashboardWidgetSnapshot } = await import('../src/utils/promptDashboard.js');
		const prompt = {
			id: 'task-1',
			promptUuid: 'uuid-1',
			status: 'draft',
			progress: 0,
			timeSpentWriting: 0,
			timeSpentImplementing: 0,
			timeSpentOnTask: 0,
			timeSpentUntracked: 0,
			updatedAt: '2026-05-30T10:00:00.000Z',
		} as any;
		const widget = createPromptDashboardWidgetSnapshot('projects', {
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
				parallelBranches: [],
				conflictFiles: [],
				incomingFiles: [],
				incomingAuthors: [],
				uncommittedFiles: [],
			}],
		}, { status: 'fresh', source: 'refresh' });

		const snapshot = mergePromptDashboardWidgetSnapshot({
			previousSnapshot: null,
			widget,
			prompt,
			promptId: 'task-1',
			promptUuid: 'uuid-1',
		});

		assert.equal(snapshot?.projects.data.projects[0]?.project, 'api');
		assert.equal(snapshot?.status.kind, 'status');
		assert.equal(snapshot?.activity.kind, 'activity');
		assert.equal(snapshot?.docker.kind, 'docker');
		assert.equal(snapshot?.aiAnalysis.kind, 'aiAnalysis');
	});
});

test('resolvePromptDashboardExpandRequest refreshes the stale projects widget when reopening it from fully collapsed state', async () => {
	await withEditorAppEnvironment(async () => {
		const { resolvePromptDashboardExpandRequest } = await import('../src/webview/editor/EditorApp.js');
		const { createPromptDashboardWidgetSnapshot, PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS } = await import('../src/utils/promptDashboard.js');

		const snapshot = {
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
				projects: [],
			}, { status: 'stale', source: 'cache' }),
			aiAnalysis: createPromptDashboardWidgetSnapshot('aiAnalysis', null, { status: 'fresh', source: 'refresh' }),
		} as any;

		assert.deepEqual(resolvePromptDashboardExpandRequest({
			previousCollapsedSections: {
				status: true,
				activity: true,
				projectBranches: true,
				reviewRequests: true,
				parallelBranches: true,
				projectCommits: true,
				aiAnalysis: true,
			},
			nextCollapsedSections: {
				status: true,
				activity: true,
				reviewRequests: true,
				parallelBranches: true,
				projectCommits: true,
				aiAnalysis: true,
			},
			section: 'projectBranches',
			mode: 'full',
			snapshot,
		}), { type: 'widget', widget: 'projects' });
	});
});

test('resolvePromptDashboardExpandRequest refreshes an empty projects widget even when its cache still looks fresh', async () => {
	await withEditorAppEnvironment(async () => {
		const { resolvePromptDashboardExpandRequest } = await import('../src/webview/editor/EditorApp.js');
		const { createPromptDashboardWidgetSnapshot, PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS } = await import('../src/utils/promptDashboard.js');

		const snapshot = {
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
				projects: [],
			}, { status: 'fresh', source: 'cache' }),
			aiAnalysis: createPromptDashboardWidgetSnapshot('aiAnalysis', null, { status: 'fresh', source: 'refresh' }),
		} as any;

		assert.deepEqual(resolvePromptDashboardExpandRequest({
			previousCollapsedSections: {
				status: true,
				activity: true,
				projectBranches: true,
				reviewRequests: true,
				parallelBranches: true,
				projectCommits: true,
				aiAnalysis: true,
			},
			nextCollapsedSections: {
				status: true,
				activity: true,
				reviewRequests: true,
				parallelBranches: true,
				projectCommits: true,
				aiAnalysis: true,
			},
			section: 'projectBranches',
			mode: 'full',
			snapshot,
		}), { type: 'widget', widget: 'projects' });
	});
});

test('canRequestImplementingTimeRecalc blocks closed prompts and active recalculation', async () => {
	await withEditorAppEnvironment(async () => {
		const { canRequestImplementingTimeRecalc } = await import('../src/webview/editor/EditorApp.js');

		assert.equal(canRequestImplementingTimeRecalc({
			promptId: 'prompt-a',
			status: 'in-progress',
			chatSessionIds: ['session-a'],
			isRecalculating: false,
		}), true);

		assert.equal(canRequestImplementingTimeRecalc({
			promptId: 'prompt-a',
			status: 'closed',
			chatSessionIds: ['session-a'],
			isRecalculating: false,
		}), false);

		assert.equal(canRequestImplementingTimeRecalc({
			promptId: 'prompt-a',
			status: 'in-progress',
			chatSessionIds: ['session-a'],
			isRecalculating: true,
		}), false);
	});
});

test('shouldPruneGitOverlayTrackedRequest clears a stale commit loader when the snapshot is already clean', async () => {
	await withEditorAppEnvironment(async () => {
		const { shouldPruneGitOverlayTrackedRequest } = await import('../src/webview/editor/EditorApp.js');

		assert.equal(shouldPruneGitOverlayTrackedRequest({
			request: {
				kind: 'commit',
				projects: ['api'],
				createdAt: 100,
			},
			snapshot: {
				projects: [
					{
						project: 'api',
						changeGroups: {
							merge: [],
							staged: [],
							workingTree: [],
							untracked: [],
						},
					},
				],
			} as any,
			now: 200,
			staleAfterMs: 10_000,
		}), true);
	});
});

test('shouldPruneGitOverlayTrackedRequest keeps a recent commit loader while the snapshot still has changes', async () => {
	await withEditorAppEnvironment(async () => {
		const { shouldPruneGitOverlayTrackedRequest } = await import('../src/webview/editor/EditorApp.js');

		assert.equal(shouldPruneGitOverlayTrackedRequest({
			request: {
				kind: 'commit',
				projects: ['api'],
				createdAt: 100,
			},
			snapshot: {
				projects: [
					{
						project: 'api',
						changeGroups: {
							merge: [],
							staged: [{ path: 'src/api.ts' }],
							workingTree: [],
							untracked: [],
						},
					},
				],
			} as any,
			now: 105,
			staleAfterMs: 10_000,
		}), false);
	});
});

test('shouldPruneGitOverlayTrackedRequest clears an old commit loader even if the snapshot still looks dirty', async () => {
	await withEditorAppEnvironment(async () => {
		const { shouldPruneGitOverlayTrackedRequest } = await import('../src/webview/editor/EditorApp.js');

		assert.equal(shouldPruneGitOverlayTrackedRequest({
			request: {
				kind: 'commit',
				projects: ['api'],
				createdAt: 100,
			},
			snapshot: {
				projects: [
					{
						project: 'api',
						changeGroups: {
							merge: [],
							staged: [{ path: 'src/api.ts' }],
							workingTree: [],
							untracked: [],
						},
					},
				],
			} as any,
			now: 20_500,
			staleAfterMs: 10_000,
		}), true);
	});
});

test('TimerDisplay hides implementing recalc action when recalculation is not allowed', async () => {
	await withEditorAppEnvironment(async () => {
		const { TimerDisplay } = await import('../src/webview/editor/components/TimerDisplay.js');

		const hiddenMarkup = renderToStaticMarkup(React.createElement(TimerDisplay, {
			timeWriting: 0,
			timeImplementing: 0,
			timeOnTask: 0,
			timeUntracked: 0,
			onUntrackedChange: () => undefined,
			hasChatSessions: true,
			canRecalcImplementingTime: false,
			isRecalculating: false,
			onRecalcImplementingTime: () => undefined,
		}));

		const visibleMarkup = renderToStaticMarkup(React.createElement(TimerDisplay, {
			timeWriting: 0,
			timeImplementing: 0,
			timeOnTask: 0,
			timeUntracked: 0,
			onUntrackedChange: () => undefined,
			hasChatSessions: true,
			canRecalcImplementingTime: true,
			isRecalculating: false,
			onRecalcImplementingTime: () => undefined,
		}));

		assert.equal(hiddenMarkup.includes('<button'), false);
		assert.equal(visibleMarkup.includes('<button'), true);
	});
});

test('shouldDeferReportAutosave only blocks prompt autosave while the report editor owns local typing', async () => {
	await withEditorAppEnvironment(async () => {
		const { shouldDeferReportAutosave } = await import('../src/webview/editor/EditorApp.js');

		assert.equal(shouldDeferReportAutosave({ reportEditorFocused: false, reportDraftActive: false }), false);
		assert.equal(shouldDeferReportAutosave({ reportEditorFocused: true, reportDraftActive: false }), true);
		assert.equal(shouldDeferReportAutosave({ reportEditorFocused: false, reportDraftActive: true }), true);
	});
});

test('shouldPreserveLocalReportOnSave keeps equal saved report only while the inline editor still owns the draft', async () => {
	await withEditorAppEnvironment(async () => {
		const { shouldPreserveLocalReportOnSave } = await import('../src/webview/editor/EditorApp.js');

		assert.equal(shouldPreserveLocalReportOnSave({
			reason: 'save',
			currentLocalReport: 'same',
			incomingSavedReport: 'same',
			reportEditorFocused: false,
			reportDraftActive: false,
		}), false);

		assert.equal(shouldPreserveLocalReportOnSave({
			reason: 'save',
			currentLocalReport: 'same',
			incomingSavedReport: 'same',
			reportEditorFocused: true,
			reportDraftActive: false,
		}), true);

		assert.equal(shouldPreserveLocalReportOnSave({
			reason: 'save',
			currentLocalReport: 'newer',
			incomingSavedReport: 'older',
			reportEditorFocused: false,
			reportDraftActive: false,
		}), true);
	});
});
