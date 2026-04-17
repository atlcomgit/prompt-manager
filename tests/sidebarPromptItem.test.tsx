import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PromptConfig } from '../src/types/prompt.js';
import { PromptItem } from '../src/webview/sidebar/components/PromptItem.js';

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

function makePrompt(overrides: Partial<PromptConfig> = {}): PromptConfig {
	const now = '2026-04-17T12:00:00.000Z';
	return {
		id: 'prompt-1',
		promptUuid: 'uuid-1',
		title: 'Prompt title',
		description: 'Prompt description',
		status: 'in-progress',
		favorite: false,
		projects: [],
		languages: [],
		frameworks: [],
		skills: [],
		mcpTools: [],
		hooks: [],
		taskNumber: '75',
		branch: '',
		trackedBranch: '',
		trackedBranchesByProject: {},
		model: '',
		chatMode: 'agent',
		contextFiles: [],
		httpExamples: '',
		chatSessionIds: [],
		timeSpentWriting: 0,
		timeSpentImplementing: 0,
		timeSpentOnTask: 0,
		timeSpentUntracked: 0,
		notes: '',
		progress: 42,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function renderPromptItemMarkup(
	overrides: Partial<React.ComponentProps<typeof PromptItem>> = {},
): string {
	return withLocale('en', () => renderToStaticMarkup(React.createElement(PromptItem, {
		prompt: makePrompt(),
		viewMode: 'detailed',
		isSelected: false,
		isBusy: false,
		onOpen: () => { },
		onDelete: () => { },
		onDuplicate: () => { },
		onToggleFavorite: () => { },
		onExport: () => { },
		onUpdateStatus: () => { },
		...overrides,
	})));
}

test('PromptItem renders loader instead of status label and progress while busy in detailed mode', () => {
	const markup = renderPromptItemMarkup({
		isBusy: true,
		prompt: makePrompt({ progress: 42 }),
	});

	assert.match(markup, /aria-label="Saving or generating fields\.\.\."/);
	assert.doesNotMatch(markup, />In Progress</);
	assert.doesNotMatch(markup, />42%</);
	assert.match(markup, /animateTransform/);
});

test('PromptItem renders loader instead of compact progress while busy in compact mode', () => {
	const markup = renderPromptItemMarkup({
		viewMode: 'compact',
		isBusy: true,
		prompt: makePrompt({ progress: 42 }),
	});

	assert.match(markup, /aria-label="Saving or generating fields\.\.\."/);
	assert.doesNotMatch(markup, />42%</);
	assert.match(markup, /animateTransform/);
});
