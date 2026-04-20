import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
	ActionBar,
	resolveChatEntryState,
	resolveStartChatDisabledReason,
	resolveStartChatDisabledState,
} from '../src/webview/editor/components/ActionBar.js';
import { withLocale } from './testLocale.js';

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

test('ActionBar disables Go to chat and shows spinner while an existing chat is opening', () => {
	const markup = renderActionBarMarkup({
		status: 'in-progress',
		hasChatSession: true,
		isOpeningChat: true,
	});

	assert.match(markup, /Go to chat/);
	assert.match(markup, /disabled=""/);
	assert.match(markup, /aria-busy="true"/);
	assert.match(markup, /animation:pm-spin 0\.8s linear infinite/);
});

test('ActionBar hides Start Chat until prompt is persisted', () => {
	const state = resolveChatEntryState({
		status: 'draft',
		hasChatSession: false,
		isChatPanelOpen: false,
		isPersistedPrompt: false,
		isStartingChat: false,
	});

	assert.equal(state.shouldShowStartChat, false);
	const markup = renderActionBarMarkup({
		status: 'draft',
		isPersistedPrompt: false,
		hasContent: true,
	});
	assert.doesNotMatch(markup, /Start Chat/);
});

test('resolveChatEntryState keeps Start Chat visible only while in-progress launch is still pending', () => {
	const launchingState = resolveChatEntryState({
		status: 'in-progress',
		hasChatSession: false,
		isChatPanelOpen: false,
		isPersistedPrompt: true,
		isStartingChat: true,
	});

	assert.equal(launchingState.shouldShowStartChat, true);

	const settledState = resolveChatEntryState({
		status: 'in-progress',
		hasChatSession: false,
		isChatPanelOpen: false,
		isPersistedPrompt: true,
		isStartingChat: false,
	});

	assert.equal(settledState.shouldShowStartChat, false);
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

test('resolveStartChatDisabledReason returns the active lock reason', () => {
	assert.equal(resolveStartChatDisabledReason({
		hasContent: true,
		isStartingChat: true,
		isGeneratingTitle: false,
		isGeneratingDescription: false,
	}), 'actions.startChatDisabledLaunching');

	assert.equal(resolveStartChatDisabledReason({
		hasContent: false,
		isStartingChat: false,
		isGeneratingTitle: false,
		isGeneratingDescription: false,
	}), 'actions.startChatDisabledEmpty');

	assert.equal(resolveStartChatDisabledReason({
		hasContent: true,
		isStartingChat: false,
		isGeneratingTitle: true,
		isGeneratingDescription: true,
	}), 'actions.startChatDisabledGeneratingMetadata');
});

test('ActionBar shows start chat lock reason above actions', () => {
	const markup = renderActionBarMarkup({
		hasContent: false,
	});

	assert.match(markup, /role="status"/);
	assert.match(markup, /ⓘ/);
	assert.match(markup, /Start chat is unavailable until prompt text is filled in\./);
	assert.match(markup, /title="Start chat is unavailable until prompt text is filled in\."/);
	assert.match(markup, /display:flex;flex-direction:column;gap:10px/);
});

test('ActionBar shows start chat lock reason on non-process tabs too', () => {
	const markup = renderActionBarMarkup({
		activeTab: 'main',
		hasContent: false,
	});

	assert.match(markup, /role="status"/);
	assert.match(markup, /Start chat is unavailable until prompt text is filled in\./);
});

test('ActionBar hides Start Chat after launch loader finishes for in-progress prompt', () => {
	const markup = renderActionBarMarkup({
		status: 'in-progress',
		hasChatSession: false,
		isChatPanelOpen: false,
		isStartingChat: false,
	});

	assert.doesNotMatch(markup, /Start Chat/);
	assert.doesNotMatch(markup, /Go to chat/);
	assert.doesNotMatch(markup, /role="status"/);
});

test('ActionBar keeps launch spinner without notice while chat start is still pending', () => {
	const markup = renderActionBarMarkup({
		status: 'in-progress',
		hasChatSession: false,
		isChatPanelOpen: false,
		isStartingChat: true,
	});

	assert.match(markup, /Start chat/i);
	assert.match(markup, /aria-busy="true"/);
	assert.doesNotMatch(markup, /role="status"/);
	assert.match(markup, /animation:pm-spin 0\.8s linear infinite/);
});