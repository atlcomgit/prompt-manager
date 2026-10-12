import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Prompt } from '../src/types/prompt.js';
import { translate } from '../src/i18n/translations.js';

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

/** Проверяет первоначальную форму, новый вариант Claude и сохранение Copilot по умолчанию. */
test('EditorApp renders the initial prompt page without throwing', async () => {
	await withEditorAppEnvironment((EditorApp) => {
		const markup = renderToStaticMarkup(React.createElement(EditorApp));

		assert.ok(markup.length > 0);
		assert.match(markup, /data-pm-editor-loading-overlay="true"/);
		assert.match(markup, /Prompt details|Prompt content|Description/i);
		assert.match(markup, /<option value="copilot" selected="">Copilot Chat<\/option>/);
		assert.match(markup, /<option value="kilo">Kilo Code<\/option>/);
		assert.match(markup, /<option value="codex">OpenAI Codex<\/option>/);
		assert.match(markup, /<option value="claude">Claude Code<\/option>/);
	});
});

/** Проверяет разметку Claude на изолированном промпте без запуска эффектов React или настоящего чата. */
test('EditorApp renders Claude with mode selection and independent Xdotool controls but no Copilot model', async context => {
	await withEditorAppEnvironment(EditorApp => {
		// Подменяем только фабрику начального состояния; node:test восстанавливает ее после проверки.
		const promptModule = require('../src/types/prompt.js') as typeof import('../src/types/prompt.js');
		const prompt = {
			...promptModule.createDefaultPrompt(),
			chatTarget: 'claude' as const,
			chatMode: 'plan' as const,
			model: 'copilot/model-must-stay-hidden',
		};
		context.mock.method(promptModule, 'createDefaultPrompt', () => prompt);

		for (const autoStartChatWithXdotool of [false, true]) {
			prompt.autoStartChatWithXdotool = autoStartChatWithXdotool;
			prompt.autoStartChat = !autoStartChatWithXdotool;
			const markup = renderToStaticMarkup(React.createElement(EditorApp));

			assert.match(markup, /<option value="claude" selected="">Claude Code<\/option>/);
			assert.match(markup, /title="Agent"/);
			assert.match(markup, /title="Plan"/);
			assert.match(markup, /title="Чат: Claude Code"/);
			assert.match(markup, /title="Режим: Plan"/);
			assert.ok(markup.includes(`title="Xdotool: ${autoStartChatWithXdotool ? 'включен' : 'выключен'}"`));
			assert.doesNotMatch(markup, /copilot\/model-must-stay-hidden|Autostart Copilot Chat/);
			const checkbox = markup.match(/<input[^>]*type="checkbox"[^>]*\/>Autostart chat via Xdotool/);
			assert.ok(checkbox, 'Claude must use the external Xdotool checkbox');
			assert.equal(checkbox[0].includes('checked=""'), autoStartChatWithXdotool);
		}
	});
});

/** Проверяет локализованные состояния Claude и таймер без доступа к реальным сессиям или отправки запросов. */
test('EditorApp shows pending and bound Claude sessions without counting Copilot history', async context => {
	await withEditorAppEnvironment(EditorApp => {
		// Каждый SSR-проход получает текущую тестовую привязку; фабрика восстанавливается после теста.
		const promptModule = require('../src/types/prompt.js') as typeof import('../src/types/prompt.js');
		const prompt: Prompt = {
			...promptModule.createDefaultPrompt('prompt-claude'),
			chatTarget: 'claude',
			chatSessionIds: ['old-copilot-session'],
			status: 'in-progress',
		};
		context.mock.method(promptModule, 'createDefaultPrompt', () => prompt);

		for (const locale of ['en', 'ru'] as const) {
			window.__LOCALE__ = locale;
			prompt.claudeChat = undefined;
			const unboundMarkup = renderToStaticMarkup(React.createElement(EditorApp));
			assert.ok(unboundMarkup.includes(translate(locale, 'editor.claudeChatNotBound')));
			assert.ok(!unboundMarkup.includes(translate(locale, 'timer.recalcTitle')));

			prompt.claudeChat = {
				sessions: [],
				pendingLaunch: { marker: 'launch-marker', projectPaths: ['/testing-project'], startedAt: 100 },
			};
			const pendingMarkup = renderToStaticMarkup(React.createElement(EditorApp));
			assert.ok(pendingMarkup.includes(translate(locale, 'editor.claudeChatPending')));
			assert.ok(!pendingMarkup.includes(translate(locale, 'editor.chatLaunchDescriptionReady')));
			assert.ok(!pendingMarkup.includes(translate(locale, 'timer.recalcTitle')));

			prompt.claudeChat = {
				sessions: [
					{ sessionId: 'claude-a', projectPath: '/testing-project', accountedMs: 1000 },
					{ sessionId: 'claude-b', projectPath: '/testing-project', accountedMs: 2000 },
				],
			};
			const boundMarkup = renderToStaticMarkup(React.createElement(EditorApp));
			assert.ok(boundMarkup.includes(`${translate(locale, 'editor.claudeChatBoundCount')}: 2`));
			assert.ok(!boundMarkup.includes(translate(locale, 'editor.claudeChatPending')));
			assert.ok(boundMarkup.includes(translate(locale, 'timer.recalcTitle')));
		}
	});
});

/** Проверяет общий источник идентификаторов для открытия, запуска и учета времени. */
test('resolvePromptChatSessionIds isolates Claude IDs from retained Copilot history', async () => {
	await withEditorAppEnvironment(async () => {
		const { resolvePromptChatSessionIds } = await import('../src/webview/editor/EditorApp.js');
		const chatSessionIds = ['copilot-history'];
		const claudeChat = {
			sessions: [{ sessionId: 'claude-session', projectPath: '/testing-project', accountedMs: 0 }],
		};

		assert.deepEqual(resolvePromptChatSessionIds({ chatTarget: 'claude', chatSessionIds }), []);
		assert.deepEqual(resolvePromptChatSessionIds({ chatTarget: 'claude', chatSessionIds, claudeChat }), ['claude-session']);
		assert.deepEqual(resolvePromptChatSessionIds({ chatTarget: 'copilot', chatSessionIds, claudeChat }), chatSessionIds);
		assert.deepEqual(resolvePromptChatSessionIds({ chatSessionIds, claudeChat }), chatSessionIds);
		assert.deepEqual(resolvePromptChatSessionIds({ chatTarget: 'copilot', claudeChat }), []);
	});
});

/** Проверяет, что старая история Copilot не блокирует запуск Claude, а новая цель не меняет guards остальных чатов. */
test('canStartPromptChat checks only sessions of the selected target and permits draft rebinding', async () => {
	await withEditorAppEnvironment(async () => {
		const { canStartPromptChat } = await import('../src/webview/editor/EditorApp.js');
		const { createDefaultPrompt } = await import('../src/types/prompt.js');
		const prompt: Prompt = {
			...createDefaultPrompt('prompt-claude'),
			chatTarget: 'claude',
			chatSessionIds: ['copilot-history'],
			content: 'Prompt text',
			status: 'in-progress',
		};

		assert.equal(canStartPromptChat(prompt), true);
		assert.equal(canStartPromptChat({ ...prompt, chatTarget: 'copilot' }), false);
		assert.equal(canStartPromptChat({ ...prompt, content: '' }), false);
		assert.equal(canStartPromptChat({ ...prompt, promptUuid: '' }), false);
		prompt.claudeChat = {
			sessions: [{ sessionId: 'claude-session', projectPath: '/testing-project', accountedMs: 0 }],
		};
		assert.equal(canStartPromptChat(prompt), false);
		assert.equal(canStartPromptChat({ ...prompt, status: 'draft' }), true);
	});
});

/** Проверяет частичные ответы хоста: обновляется Claude, но ни текст, ни история Copilot не заменяются его IDs. */
test('mergePromptChatBindings applies or preserves Claude state without overwriting unsaved text', async () => {
	await withEditorAppEnvironment(async () => {
		const { mergePromptChatBindings } = await import('../src/webview/editor/EditorApp.js');
		const { createDefaultPrompt } = await import('../src/types/prompt.js');
		const current: Prompt = {
			...createDefaultPrompt('prompt-claude'),
			chatTarget: 'claude',
			chatSessionIds: ['copilot-history'],
			content: 'Unsaved prompt text',
			report: 'Unsaved report text',
			claudeChat: {
				sessions: [],
				pendingLaunch: { marker: 'launch-marker', projectPaths: ['/testing-project'], startedAt: 100 },
			},
		};
		const boundChat = {
			sessions: [{ sessionId: 'claude-session', projectPath: '/testing-project', accountedMs: 0 }],
		};
		const merged = mergePromptChatBindings(current, {
			claudeChat: boundChat,
			content: 'Stale saved text',
			report: 'Stale saved report',
		});

		assert.deepEqual(merged.claudeChat, boundChat);
		assert.equal(merged.claudeChat?.pendingLaunch, undefined);
		assert.deepEqual(merged.chatSessionIds, ['copilot-history']);
		assert.equal(merged.content, current.content);
		assert.equal(merged.report, current.report);
		assert.deepEqual(mergePromptChatBindings(merged, {}).claudeChat, boundChat);
		assert.equal(mergePromptChatBindings(merged, { claudeChat: undefined }).claudeChat, undefined);
		assert.ok(current.claudeChat?.pendingLaunch, 'Merging must not mutate the current prompt');
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

/** Проверяет, что для Claude нужны его собственные сессии, а закрытая задача остается замороженной. */
test('canRequestImplementingTimeRecalc uses Claude sessions instead of Copilot history', async () => {
	await withEditorAppEnvironment(async () => {
		const { canRequestImplementingTimeRecalc } = await import('../src/webview/editor/EditorApp.js');
		const input = {
			promptId: 'prompt-claude',
			status: 'in-progress' as const,
			chatTarget: 'claude' as const,
			chatSessionIds: ['old-copilot-session'],
		};
		const boundInput = {
			...input,
			chatSessionIds: [],
			claudeChat: {
				sessions: [{ sessionId: 'claude-session', projectPath: '/testing-project', accountedMs: 0 }],
			},
		};

		assert.equal(canRequestImplementingTimeRecalc(input), false);
		assert.equal(canRequestImplementingTimeRecalc(boundInput), true);
		assert.equal(canRequestImplementingTimeRecalc({ ...boundInput, status: 'closed' }), false);
		assert.equal(canRequestImplementingTimeRecalc({ ...boundInput, isRecalculating: true }), false);
		assert.equal(canRequestImplementingTimeRecalc({ ...boundInput, promptId: '' }), false);
		assert.equal(canRequestImplementingTimeRecalc({ ...boundInput, chatTarget: 'copilot' }), false);
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

/** Проверяет latest generation после snapshot cleanup и защиту textarea от stale response. */
test('shouldApplyGitOverlayCommitMessagesResponse keeps latest generation independent from tracked snapshot state', async () => {
	await withEditorAppEnvironment(async () => {
		const { shouldApplyGitOverlayCommitMessagesResponse } = await import('../src/webview/editor/EditorApp.js');

		assert.equal(shouldApplyGitOverlayCommitMessagesResponse('request-current', true), true);
		assert.equal(shouldApplyGitOverlayCommitMessagesResponse('request-current', false, 'request-current'), true);
		assert.equal(shouldApplyGitOverlayCommitMessagesResponse('request-stale', false), false);
		assert.equal(shouldApplyGitOverlayCommitMessagesResponse('request-stale', false, 'request-current'), false);
		assert.equal(shouldApplyGitOverlayCommitMessagesResponse(undefined, false), true);
		assert.equal(shouldApplyGitOverlayCommitMessagesResponse('', false), true);
	});
});

/** Проверяет acknowledgment только для сообщений, реально оставшихся в Git Flow state. */
test('resolveGitOverlayCommitMessageCleanupTokens excludes fields changed before React acknowledgment', async () => {
	await withEditorAppEnvironment(async () => {
		const {
			mergeGitOverlayPendingScmCleanupItems,
			resolveGitOverlayCommitMessageCleanupTokens,
		} = await import('../src/webview/editor/EditorApp.js');
		const apiItems = [{ project: 'api', message: 'feat: generated', cleanupToken: 'cleanup-api' }];
		const pendingItems = mergeGitOverlayPendingScmCleanupItems(
			mergeGitOverlayPendingScmCleanupItems([], apiItems),
			[{ project: 'web', message: 'fix: generated', cleanupToken: 'cleanup-web' }],
		);
		assert.deepEqual(mergeGitOverlayPendingScmCleanupItems(pendingItems, []), pendingItems);
		const cleanupTokens = resolveGitOverlayCommitMessageCleanupTokens(pendingItems, {
			api: 'feat: generated',
			web: 'fix: edited by user',
		});

		assert.deepEqual(cleanupTokens, ['cleanup-api']);
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
