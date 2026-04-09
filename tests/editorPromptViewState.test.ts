import test from 'node:test';
import assert from 'node:assert/strict';

import {
	createDefaultEditorPromptExpandedSections,
	createDefaultEditorPromptViewState,
	getEditorPromptViewStateStorageKeys,
	moveEditorPromptViewStateEntries,
	normalizeEditorPromptViewState,
	resolveEditorPromptViewStateStorageKey,
} from '../src/types/prompt.js';

test('createDefaultEditorPromptViewState returns main tab by default', () => {
	assert.deepEqual(createDefaultEditorPromptViewState(), {
		activeTab: 'main',
		expandedSections: createDefaultEditorPromptExpandedSections(),
		descriptionExpanded: false,
	});
});

test('normalizeEditorPromptViewState accepts only supported tabs', () => {
	assert.deepEqual(normalizeEditorPromptViewState({
		activeTab: 'process',
		expandedSections: { basic: false, plan: true },
		descriptionExpanded: true,
	}), {
		activeTab: 'process',
		expandedSections: {
			...createDefaultEditorPromptExpandedSections(),
			basic: false,
			plan: true,
		},
		descriptionExpanded: true,
	});
	assert.deepEqual(
		normalizeEditorPromptViewState({ activeTab: 'unknown' as 'main' }),
		{
			activeTab: 'main',
			expandedSections: createDefaultEditorPromptExpandedSections(),
			descriptionExpanded: false,
		},
	);
	assert.deepEqual(normalizeEditorPromptViewState(null), {
		activeTab: 'main',
		expandedSections: createDefaultEditorPromptExpandedSections(),
		descriptionExpanded: false,
	});
});

test('editor prompt view state keys prefer promptUuid and keep fallbacks deduplicated', () => {
	assert.deepEqual(getEditorPromptViewStateStorageKeys({
		promptUuid: ' uuid-1 ',
		promptId: 'prompt-a',
		fallbackKey: 'panel:singleton',
	}), [
		'promptUuid:uuid-1',
		'promptId:prompt-a',
		'panel:singleton',
	]);
	assert.equal(resolveEditorPromptViewStateStorageKey({
		promptUuid: 'uuid-1',
		promptId: 'prompt-a',
		fallbackKey: 'panel:singleton',
	}), 'promptUuid:uuid-1');
});

test('moveEditorPromptViewStateEntries migrates transient panel state to promptUuid key', () => {
	const next = moveEditorPromptViewStateEntries(
		{
			'panel:__prompt_editor_singleton__': { activeTab: 'process' },
		},
		[
			{ fallbackKey: 'panel:__prompt_editor_singleton__' },
		],
		{
			promptUuid: 'uuid-1',
			promptId: 'prompt-a',
			fallbackKey: 'panel:__prompt_editor_singleton__',
		},
	);

	assert.deepEqual(next, {
		'promptUuid:uuid-1': {
			activeTab: 'process',
			expandedSections: createDefaultEditorPromptExpandedSections(),
			descriptionExpanded: false,
		},
	});
});

test('moveEditorPromptViewStateEntries keeps stable target state and removes duplicate promptId keys', () => {
	const next = moveEditorPromptViewStateEntries(
		{
			'promptUuid:uuid-1': { activeTab: 'process' },
			'promptId:prompt-a': { activeTab: 'main' },
		},
		[
			{ promptId: 'prompt-a' },
		],
		{
			promptUuid: 'uuid-1',
			promptId: 'prompt-a',
		},
	);

	assert.deepEqual(next, {
		'promptUuid:uuid-1': {
			activeTab: 'process',
			expandedSections: createDefaultEditorPromptExpandedSections(),
			descriptionExpanded: false,
		},
	});
});