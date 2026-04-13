import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
	Toolbar,
	resolveToolbarUtilityButtonStyle,
} from '../src/webview/sidebar/components/Toolbar.js';

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

function renderToolbarMarkup(overrides: Partial<React.ComponentProps<typeof Toolbar>> = {}): string {
	return withLocale('en', () => renderToStaticMarkup(React.createElement(Toolbar, {
		onCreateNew: () => { },
		onImport: () => { },
		onToggleFilters: () => { },
		onToggleViewSettings: () => { },
		showFilters: false,
		showViewSettings: false,
		...overrides,
	})));
}

test('resolveToolbarUtilityButtonStyle keeps idle state light and active state dark', () => {
	assert.deepEqual(resolveToolbarUtilityButtonStyle(false), {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '4px 8px',
		border: 'none',
		borderRadius: '4px',
		cursor: 'pointer',
		fontSize: '14px',
		background: 'var(--vscode-badge-background)',
		color: 'var(--vscode-badge-foreground)',
	});

	assert.deepEqual(resolveToolbarUtilityButtonStyle(true), {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '4px 8px',
		border: 'none',
		borderRadius: '4px',
		cursor: 'pointer',
		fontSize: '14px',
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
	});
});

test('Toolbar renders active filter and view buttons with the darker utility palette', () => {
	const markup = renderToolbarMarkup({
		showFilters: true,
		showViewSettings: true,
	});

	assert.match(
		markup,
		/<button(?=[^>]*title="Filters")(?=[^>]*background:var\(--vscode-button-secondaryBackground\))(?=[^>]*color:var\(--vscode-button-secondaryForeground\))/,
	);
	assert.match(
		markup,
		/<button(?=[^>]*title="List view settings")(?=[^>]*background:var\(--vscode-button-secondaryBackground\))(?=[^>]*color:var\(--vscode-button-secondaryForeground\))/,
	);
	assert.match(
		markup,
		/<button(?=[^>]*title="Import prompt")(?=[^>]*background:var\(--vscode-badge-background\))(?=[^>]*color:var\(--vscode-badge-foreground\))/,
	);
});