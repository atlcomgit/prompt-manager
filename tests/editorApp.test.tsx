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