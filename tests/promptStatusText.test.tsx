import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PromptStatusText } from '../src/webview/shared/PromptStatusText.js';

function withLocale<T>(locale: string, callback: () => T): T {
	const previousWindow = globalThis.window;
	Object.defineProperty(globalThis, 'window', {
		value: { __LOCALE__: locale },
		configurable: true,
		writable: true,
	});

	try {
		return callback();
	} finally {
		if (previousWindow === undefined) {
			Reflect.deleteProperty(globalThis as Record<string, unknown>, 'window');
		} else {
			Object.defineProperty(globalThis, 'window', {
				value: previousWindow,
				configurable: true,
				writable: true,
			});
		}
	}
}

test('PromptStatusText renders the shared label and color for in-progress status', () => {
	const markup = withLocale('en', () => renderToStaticMarkup(React.createElement(PromptStatusText, {
		status: 'in-progress',
	})));

	assert.match(markup, />In Progress</);
	assert.match(markup, /var\(--vscode-editorInfo-foreground, #3794ff\)/);
});

test('PromptStatusText keeps custom title and style overrides for notes usage', () => {
	const markup = withLocale('en', () => renderToStaticMarkup(React.createElement(PromptStatusText, {
		status: 'review',
		title: 'Prompt status',
		style: { fontSize: '12px' },
	})));

	assert.match(markup, /title="Prompt status"/);
	assert.match(markup, /font-size:12px/);
	assert.match(markup, />Review</);
});

test('PromptStatusText badge variant renders border and tinted background for header emphasis', () => {
	const markup = withLocale('en', () => renderToStaticMarkup(React.createElement(PromptStatusText, {
		status: 'report',
		variant: 'badge',
	})));

	assert.match(markup, /border:1px solid var\(--vscode-panel-border\)/);
	assert.match(markup, /border-color:color-mix\(in srgb, var\(--vscode-textLink-foreground\) 46%, var\(--vscode-panel-border\)\)/);
	assert.match(markup, /background:color-mix\(in srgb, var\(--vscode-textLink-foreground\) 18%, var\(--vscode-sideBar-background\)\)/);
	assert.match(markup, />Report</);
});