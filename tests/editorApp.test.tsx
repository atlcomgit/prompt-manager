import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type TestStorage = Pick<Storage, 'clear' | 'getItem' | 'key' | 'removeItem' | 'setItem'> & { length: number };
type TestWindow = Window & {
	__LOCALE__?: string;
	__WEBVIEW_BOOT_ID__?: string;
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

test('buildPromptModelOptions sorts prompt AI models alphabetically', async () => {
	await withEditorAppEnvironment(async () => {
		const { buildPromptModelOptions } = await import('../src/webview/editor/EditorApp.js');
		const options = buildPromptModelOptions(
			[
				{ id: 'copilot/gpt-5.5', name: 'GPT-5.5' },
				{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
				{ id: 'gpt-4.1', name: 'GPT-4.1' },
			],
			'o3',
		);

		assert.deepEqual(
			options.map(option => option.name),
			['Claude Sonnet 4', 'GPT-4.1', 'GPT-5.5', 'o3'],
		);
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