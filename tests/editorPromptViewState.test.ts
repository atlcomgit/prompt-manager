import test from 'node:test';
import assert from 'node:assert/strict';

import {
	createDefaultEditorPromptExpandedSections,
	createDefaultEditorPromptViewState,
	getEditorPromptViewStateStorageKeys,
	getEditorPromptPlanViewModeKeys,
	moveEditorPromptPlanViewModeEntries,
	moveEditorPromptViewStateEntries,
	normalizeEditorPromptViewState,
	resolveEditorPromptViewStateStorageKey,
} from '../src/types/prompt.js';

test('createDefaultEditorPromptExpandedSections opens the main authoring blocks by default', () => {
	assert.deepEqual(createDefaultEditorPromptExpandedSections(), {
		basic: true,
		status: true,
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

test('createDefaultEditorPromptViewState uses compact plan mode for new prompts', () => {
	assert.deepEqual(createDefaultEditorPromptViewState(), {
		activeTab: 'main',
		planViewMode: 'compact',
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
		planViewMode: 'compact',
		expandedSections: { basic: false, status: true, plan: true },
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
		planViewMode: 'compact',
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
			planViewMode: 'full',
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
		planViewMode: 'compact',
		expandedSections: createDefaultEditorPromptExpandedSections(),
		manualSectionOverrides: {},
		descriptionExpanded: false,
		branchesExpanded: false,
		branchesExpandedManual: false,
		contentHeights: {},
		sectionHeights: {},
	});
});

test('normalizeEditorPromptViewState uses compact defaults, preserves explicit modes, and upgrades legacy views', () => {
	assert.equal(normalizeEditorPromptViewState(null).planViewMode, 'compact');
	assert.equal(normalizeEditorPromptViewState(undefined).planViewMode, 'compact');
	assert.equal(normalizeEditorPromptViewState({ activeTab: 'process' }).planViewMode, 'full');
	assert.equal(normalizeEditorPromptViewState({ planViewMode: 'full' }).planViewMode, 'full');
	assert.equal(normalizeEditorPromptViewState({ planViewMode: 'compact' }).planViewMode, 'compact');
	assert.equal(normalizeEditorPromptViewState({ planViewMode: 'invalid' as any }).planViewMode, 'full');
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
		planViewMode: 'full',
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

/** Режим плана использует UUID+ID промпта и никогда не хранится по общему ключу панели. */
test('getEditorPromptPlanViewModeKeys uses prompt UUID with ID and ignores the panel fallback', () => {
	assert.deepEqual(getEditorPromptPlanViewModeKeys({
		promptUuid: ' uuid-a ', promptId: 'prompt-a', fallbackKey: 'panel:singleton',
	}), ['promptUuid:uuid-a|promptId:prompt-a', 'promptId:prompt-a']);
	assert.deepEqual(getEditorPromptPlanViewModeKeys({ promptId: 'prompt-b' }), ['promptId:prompt-b']);
	assert.deepEqual(getEditorPromptPlanViewModeKeys({ promptUuid: 'uuid-new' }), ['promptUuid:uuid-new']);
	assert.deepEqual(getEditorPromptPlanViewModeKeys({ fallbackKey: 'panel:singleton' }), []);
});

/** Переименование переносит выбор, папка с тем же UUID сохраняет свой, некорректные значения отбрасываются. */
test('moveEditorPromptPlanViewModeEntries carries the choice on rename and keeps same-UUID folders separate', () => {
	const next = moveEditorPromptPlanViewModeEntries({
		'promptUuid:uuid-a|promptId:prompt-a': 'compact',
		'promptUuid:uuid-a|promptId:prompt-a-1': 'full',
		'promptId:legacy': 'broken',
	}, [
		{ promptUuid: 'uuid-a', promptId: 'prompt-a', fallbackKey: 'panel:singleton' },
	], { promptUuid: 'uuid-a', promptId: 'renamed-a', fallbackKey: 'panel:singleton' });

	assert.deepEqual(next, {
		'promptUuid:uuid-a|promptId:renamed-a': 'compact',
		'promptUuid:uuid-a|promptId:prompt-a-1': 'full',
	});
	// Без сохранённого выбора перенос ничего не создаёт.
	assert.deepEqual(moveEditorPromptPlanViewModeEntries({}, [{ promptId: 'a' }], { promptId: 'b' }), {});
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
			planViewMode: 'full',
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
			planViewMode: 'full',
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
			planViewMode: 'full',
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
/** Старое измерение basic включало StatusSelect; новый блок не должен удерживать прежнюю высоту. */
test('legacy view state invalidates only the basic section height after separating status', () => {
	const result = normalizeEditorPromptViewState({
		expandedSections: { basic: true }, sectionHeights: { basic: 200, report: 300 },
	});
	assert.equal(result.sectionHeights.basic, undefined);
	assert.equal(result.sectionHeights.report, 300);
	assert.equal(result.expandedSections.status, true);
});
