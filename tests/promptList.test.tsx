import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PromptConfig, PromptCustomGroup } from '../src/types/prompt.js';
import { PromptList } from '../src/webview/sidebar/components/PromptList.js';
import { withLocale } from './testLocale.js';

function makePrompt(overrides: Partial<PromptConfig> = {}): PromptConfig {
	const now = '2026-04-18T12:00:00.000Z';
	return {
		id: 'prompt-1',
		promptUuid: 'uuid-1',
		title: 'Prompt title',
		description: 'Prompt description',
		status: 'draft',
		favorite: false,
		projects: [],
		languages: [],
		frameworks: [],
		skills: [],
		mcpTools: [],
		hooks: [],
		taskNumber: '78',
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
		customGroupIds: ['group-1'],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makeCustomGroup(overrides: Partial<PromptCustomGroup> = {}): PromptCustomGroup {
	const now = '2026-04-18T12:00:00.000Z';
	return {
		id: 'group-1',
		name: 'Blue Group',
		color: '#1f3a5f',
		order: 0,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function renderPromptListMarkup(color: string): string {
	return withLocale('en', () => renderToStaticMarkup(React.createElement(PromptList, {
		groups: { 'group-1': [makePrompt()] },
		groupBy: 'custom',
		viewMode: 'detailed',
		collapsedGroups: {},
		selectedId: null,
		customGroups: [makeCustomGroup({ color })],
		onToggleGroup: () => { },
		onOpen: () => { },
		onDelete: () => { },
		onDuplicate: () => { },
		onToggleFavorite: () => { },
		onExport: () => { },
		onUpdateStatus: () => { },
	})));
}

test('PromptList renders dark custom-group headers with white readable text', () => {
	const markup = renderPromptListMarkup('#1f3a5f');

	assert.match(
		markup,
		/<button(?=[^>]*background:#1f3a5f)(?=[^>]*color:#ffffff)/,
	);
});

test('PromptList renders light custom-group headers with black readable text', () => {
	const markup = renderPromptListMarkup('#bfe6ff');

	assert.match(
		markup,
		/<button(?=[^>]*background:#bfe6ff)(?=[^>]*color:#000000)/,
	);
});