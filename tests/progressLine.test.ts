import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProgressLine, resolveEditorProgressMode } from '../src/webview/editor/components/ProgressLine.js';

test('resolveEditorProgressMode prioritizes saving over all other editor busy states', () => {
	const mode = resolveEditorProgressMode({
		isSaving: true,
		isStartingChat: true,
		isImprovingPromptText: true,
		isGeneratingReport: true,
		isGeneratingTitle: true,
		isGeneratingDescription: true,
		isSuggestionLoading: true,
		isRecalculating: true,
		isLoadingGlobalContext: true,
	});

	assert.equal(mode, 'saving');
});

test('resolveEditorProgressMode returns ai for editor generation states', () => {
	const mode = resolveEditorProgressMode({
		isSaving: false,
		isStartingChat: false,
		isImprovingPromptText: false,
		isGeneratingReport: false,
		isGeneratingTitle: true,
		isGeneratingDescription: false,
		isSuggestionLoading: false,
		isRecalculating: false,
		isLoadingGlobalContext: false,
	});

	assert.equal(mode, 'ai');
});

test('resolveEditorProgressMode returns processing for non-save non-ai busy states', () => {
	const mode = resolveEditorProgressMode({
		isSaving: false,
		isStartingChat: false,
		isImprovingPromptText: false,
		isGeneratingReport: false,
		isGeneratingTitle: false,
		isGeneratingDescription: false,
		isSuggestionLoading: true,
		isRecalculating: false,
		isLoadingGlobalContext: false,
	});

	assert.equal(mode, 'processing');
});

test('ProgressLine keeps the track mounted while idle', () => {
	const markup = renderToStaticMarkup(React.createElement(ProgressLine, {
		mode: 'idle',
		modeAttributeName: 'data-pm-editor-progress',
		phaseAttributeName: 'data-pm-editor-progress-phase',
	}));

	assert.match(markup, /data-pm-editor-progress="idle"/);
});

test('ProgressLine renders editor busy mode on the track attribute', () => {
	const markup = renderToStaticMarkup(React.createElement(ProgressLine, {
		mode: 'ai',
		modeAttributeName: 'data-pm-editor-progress',
		phaseAttributeName: 'data-pm-editor-progress-phase',
	}));

	assert.match(markup, /data-pm-editor-progress="ai"/);
});