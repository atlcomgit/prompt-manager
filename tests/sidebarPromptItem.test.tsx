import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PromptConfig } from '../src/types/prompt.js';
import { PromptItem } from '../src/webview/sidebar/components/PromptItem.js';
import { withLocale } from './testLocale.js';

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

test('PromptItem renders the shared compact status label for non-progress states', () => {
	const markup = renderPromptItemMarkup({
		viewMode: 'compact',
		prompt: makePrompt({
			status: 'report',
			progress: undefined,
		}),
	});

	assert.match(markup, />Report</);
	assert.match(markup, /var\(--vscode-textLink-foreground\)/);
});

test('PromptItem renders selected compact progress with inverse track and outline', () => {
	const markup = renderPromptItemMarkup({
		viewMode: 'compact',
		isSelected: true,
		prompt: makePrompt({ progress: 42 }),
	});

	assert.match(markup, /title="42%"/);
	assert.match(markup, /background:var\(--vscode-sideBar-background, var\(--vscode-editor-background\)\)/);
	assert.match(markup, /border:1px solid var\(--vscode-panel-border\)/);
	assert.match(markup, /border-color:color-mix\(in srgb, var\(--vscode-list-activeSelectionBackground\) 76%, var\(--vscode-list-activeSelectionForeground\)\)/);
	assert.match(markup, /color:var\(--vscode-sideBar-foreground, var\(--vscode-foreground\)\)/);
	assert.match(markup, /color:var\(--vscode-list-activeSelectionForeground\)/);
	assert.match(markup, /clip-path:inset\(0 58% 0 0\)/);
});

test('PromptItem renders selected detailed progress with inverse track and outline', () => {
	const markup = renderPromptItemMarkup({
		isSelected: true,
		prompt: makePrompt({ progress: 42 }),
	});

	assert.match(markup, /title="42%"/);
	assert.match(markup, /background:var\(--vscode-sideBar-background, var\(--vscode-editor-background\)\)/);
	assert.match(markup, /border-color:color-mix\(in srgb, var\(--vscode-list-activeSelectionBackground\) 76%, var\(--vscode-list-activeSelectionForeground\)\)/);
	assert.match(markup, /color:var\(--vscode-sideBar-foreground, var\(--vscode-foreground\)\)/);
	assert.match(markup, /color:var\(--vscode-list-activeSelectionForeground\)/);
	assert.match(markup, /clip-path:inset\(0 58% 0 0\)/);
});

test('PromptItem uses a more saturated green fill for 100% progress', () => {
	const markup = renderPromptItemMarkup({
		prompt: makePrompt({ progress: 100 }),
	});

	assert.match(markup, /var\(--vscode-charts-green, var\(--vscode-terminal-ansiGreen, var\(--vscode-testing-iconPassed, #2e7d32\)\)\)/);
	assert.match(markup, /color:var\(--vscode-button-foreground, #ffffff\)/);
	assert.match(markup, /clip-path:inset\(0 0% 0 0\)/);
});
