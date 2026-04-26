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

test('createDefaultEditorPromptExpandedSections opens the main authoring blocks by default', () => {
	assert.deepEqual(createDefaultEditorPromptExpandedSections(), {
		basic: true,
		workspace: true,
		prompt: true,
		globalPrompt: false,
		report: false,
		notes: false,
		memory: false,
		plan: false,
		tech: false,
		integrations: false,
		agent: true,
		files: false,
		time: true,
		groups: false,
	});
});

test('createDefaultEditorPromptViewState returns main tab by default', () => {
	assert.deepEqual(createDefaultEditorPromptViewState(), {
		activeTab: 'main',
		expandedSections: createDefaultEditorPromptExpandedSections(),
		manualSectionOverrides: {},
		descriptionExpanded: false,
		branchesExpanded: false,
		branchesExpandedManual: false,
		contentHeights: {},
		sectionHeights: {},
	});
});

test('normalizeEditorPromptViewState accepts only supported tabs', () => {
	assert.deepEqual(normalizeEditorPromptViewState({
		activeTab: 'process',
		expandedSections: { basic: false, plan: true },
		manualSectionOverrides: { report: 'manual', notes: false as never },
		descriptionExpanded: true,
		branchesExpanded: true,
		branchesExpandedManual: true,
		contentHeights: {
			promptContent: 420,
			report: '640' as never,
			globalContext: -1,
		},
		sectionHeights: {
			basic: 160,
			prompt: '520' as never,
			report: 0,
		},
	}), {
		activeTab: 'process',
		expandedSections: {
			...createDefaultEditorPromptExpandedSections(),
			basic: false,
			plan: true,
		},
		manualSectionOverrides: { report: 'manual' },
		descriptionExpanded: true,
		branchesExpanded: true,
		branchesExpandedManual: true,
		contentHeights: {
			promptContent: 420,
			report: 640,
		},
		sectionHeights: {
			basic: 160,
			prompt: 520,
		},
	});
	assert.deepEqual(
		normalizeEditorPromptViewState({ activeTab: 'unknown' as 'main' }),
		{
			activeTab: 'main',
			expandedSections: createDefaultEditorPromptExpandedSections(),
			manualSectionOverrides: {},
			descriptionExpanded: false,
			branchesExpanded: false,
			branchesExpandedManual: false,
			contentHeights: {},
			sectionHeights: {},
		},
	);
	assert.deepEqual(normalizeEditorPromptViewState(null), {
		activeTab: 'main',
		expandedSections: createDefaultEditorPromptExpandedSections(),
		manualSectionOverrides: {},
		descriptionExpanded: false,
		branchesExpanded: false,
		branchesExpandedManual: false,
		contentHeights: {},
		sectionHeights: {},
	});
});

test('normalizeEditorPromptViewState keeps legacy manual overrides and accepts until-content only for plan and report', () => {
	assert.deepEqual(normalizeEditorPromptViewState({
		manualSectionOverrides: {
			report: true,
			plan: 'until-content',
			notes: 'until-content',
		} as any,
	}), {
		activeTab: 'main',
		expandedSections: createDefaultEditorPromptExpandedSections(),
		manualSectionOverrides: {
			report: 'manual',
			plan: 'until-content',
		},
		descriptionExpanded: false,
		branchesExpanded: false,
		branchesExpandedManual: false,
		contentHeights: {},
		sectionHeights: {},
	});
});

test('editor prompt view state keys use promptUuid and promptId composite primary key', () => {
	assert.deepEqual(getEditorPromptViewStateStorageKeys({
		promptUuid: ' uuid-1 ',
		promptId: 'prompt-a',
		fallbackKey: 'panel:singleton',
	}), [
		'promptUuid:uuid-1|promptId:prompt-a',
		'promptId:prompt-a',
		'panel:singleton',
	]);
	assert.equal(resolveEditorPromptViewStateStorageKey({
		promptUuid: 'uuid-1',
		promptId: 'prompt-a',
		fallbackKey: 'panel:singleton',
	}), 'promptUuid:uuid-1|promptId:prompt-a');
});

test('moveEditorPromptViewStateEntries migrates transient panel state to composite prompt key', () => {
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
		'promptUuid:uuid-1|promptId:prompt-a': {
			activeTab: 'process',
			expandedSections: createDefaultEditorPromptExpandedSections(),
			manualSectionOverrides: {},
			descriptionExpanded: false,
			branchesExpanded: false,
			branchesExpandedManual: false,
			contentHeights: {},
			sectionHeights: {},
		},
	});
});

test('moveEditorPromptViewStateEntries keeps stable target state and removes duplicate promptId keys', () => {
	const next = moveEditorPromptViewStateEntries(
		{
			'promptUuid:uuid-1': { activeTab: 'process' },
			'promptId:prompt-a': { activeTab: 'main' },
			'promptUuid:uuid-1|promptId:prompt-a': { activeTab: 'process' },
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
		'promptUuid:uuid-1|promptId:prompt-a': {
			activeTab: 'process',
			expandedSections: createDefaultEditorPromptExpandedSections(),
			manualSectionOverrides: {},
			descriptionExpanded: false,
			branchesExpanded: false,
			branchesExpandedManual: false,
			contentHeights: {},
			sectionHeights: {},
		},
	});
});

test('moveEditorPromptViewStateEntries prefers legacy promptUuid state over promptId duplicate', () => {
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
		'promptUuid:uuid-1|promptId:prompt-a': {
			activeTab: 'process',
			expandedSections: createDefaultEditorPromptExpandedSections(),
			manualSectionOverrides: {},
			descriptionExpanded: false,
			branchesExpanded: false,
			branchesExpandedManual: false,
			contentHeights: {},
			sectionHeights: {},
		},
	});
});