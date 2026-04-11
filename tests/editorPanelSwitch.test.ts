import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePromptEditorPanelSwitchStrategy } from '../src/utils/editorPanelSwitch.js';

test('resolvePromptEditorPanelSwitchStrategy reuses a live singleton panel for another prompt', () => {
	assert.equal(resolvePromptEditorPanelSwitchStrategy({
		hasReusableSingletonPanel: true,
		currentPromptId: 'prompt-a',
		nextPromptId: 'prompt-b',
	}), 'reuse');
});

test('resolvePromptEditorPanelSwitchStrategy keeps the current panel when prompt id is unchanged', () => {
	assert.equal(resolvePromptEditorPanelSwitchStrategy({
		hasReusableSingletonPanel: true,
		currentPromptId: 'prompt-a',
		nextPromptId: 'prompt-a',
	}), 'noop');
});

test('resolvePromptEditorPanelSwitchStrategy creates a panel when no reusable singleton exists', () => {
	assert.equal(resolvePromptEditorPanelSwitchStrategy({
		hasReusableSingletonPanel: false,
		currentPromptId: 'prompt-a',
		nextPromptId: 'prompt-b',
	}), 'create');
});