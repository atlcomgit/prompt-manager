import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ActionBar, resolveChatEntryState, resolveStartChatDisabledState } from '../src/webview/editor/components/ActionBar.js';

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

function renderActionBarMarkup(overrides: Partial<React.ComponentProps<typeof ActionBar>> = {}): string {
	return withLocale('en', () => renderToStaticMarkup(React.createElement(ActionBar, {
		onSave: () => { },
		onShowHistory: () => { },
		onStartChat: () => { },
		onOpenChat: () => { },
		onOpenGitFlow: () => { },
		onMarkCompleted: () => { },
		onMarkStopped: () => { },
		showStatusActions: false,
		showGitFlowAction: true,
		hasChatSession: false,
		isChatPanelOpen: false,
		isSaving: false,
		isStartingChat: false,
		hasContent: true,
		isPersistedPrompt: true,
		status: 'draft',
		...overrides,
	})));
}

test('ActionBar keeps save label unchanged while saving and shows spinner', () => {
	const markup = renderActionBarMarkup({
		isSaving: true,
	});

	assert.match(markup, /aria-busy="true"/);
	assert.match(markup, /<span>Save<\/span>/);
	assert.doesNotMatch(markup, /💾/);
	assert.doesNotMatch(markup, /Saving\.\.\./);
	assert.match(markup, /animation:pm-spin 0\.8s linear infinite/);
});

test('ActionBar renders plain save label when idle', () => {
	const markup = renderActionBarMarkup({
		isSaving: false,
	});

	assert.match(markup, /💾/);
	assert.match(markup, /<span>Save<\/span>/);
	assert.match(markup, /aria-busy="false"/);
});

test('ActionBar shows Go to chat once the chat panel is already open', () => {
	const markup = renderActionBarMarkup({
		status: 'in-progress',
		hasChatSession: false,
		isChatPanelOpen: true,
	});

	assert.match(markup, /Go to chat/);
	assert.doesNotMatch(markup, /Start Chat/);
});

test('ActionBar hides Start Chat until prompt is persisted', () => {
	const state = resolveChatEntryState({
		status: 'draft',
		hasChatSession: false,
		isChatPanelOpen: false,
		isPersistedPrompt: false,
	});

	assert.equal(state.shouldShowStartChat, false);
	const markup = renderActionBarMarkup({
		status: 'draft',
		isPersistedPrompt: false,
		hasContent: true,
	});
	assert.doesNotMatch(markup, /Start Chat/);
});

test('resolveStartChatDisabledState blocks chat start while prompt metadata is generating', () => {
	assert.equal(resolveStartChatDisabledState({
		hasContent: true,
		isStartingChat: false,
		isGeneratingTitle: true,
		isGeneratingDescription: false,
	}), true);

	assert.equal(resolveStartChatDisabledState({
		hasContent: true,
		isStartingChat: false,
		isGeneratingTitle: false,
		isGeneratingDescription: true,
	}), true);

	assert.equal(resolveStartChatDisabledState({
		hasContent: true,
		isStartingChat: false,
		isGeneratingTitle: false,
		isGeneratingDescription: false,
	}), false);
});