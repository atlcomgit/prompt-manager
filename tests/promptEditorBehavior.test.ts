import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultEditorPromptExpandedSections } from '../src/types/prompt.js';
import {
	PROMPT_CHAT_LAUNCH_PHASE_ORDER,
	isPromptChatLaunchComplete,
	resolveNextPromptChatLaunchPhase,
	resolvePromptChatContextAutoLoadDisplay,
	resolvePromptChatLaunchPhase,
	resolvePromptChatLaunchStepStatesFromPhase,
	resolvePromptChatLaunchStepStates,
	resolvePromptEditorExpandedSections,
	resolvePromptPlanPlaceholderState,
	resolvePromptChatLaunchTrackingKey,
	resolvePromptOpenEditorViewState,
	shouldPreservePromptIdAfterChatStart,
	shouldShowPromptChatLaunchBlock,
	togglePromptEditorSectionExpansion,
} from '../src/utils/promptEditorBehavior.js';

test('resolvePromptOpenEditorViewState can force the main tab without losing other editor state', () => {
	assert.deepEqual(resolvePromptOpenEditorViewState({
		activeTab: 'process',
		expandedSections: {
			...createDefaultEditorPromptExpandedSections(),
			plan: true,
		},
		manualSectionOverrides: {
			report: 'manual',
		},
		descriptionExpanded: true,
	}, {
		forceMainTab: true,
	}), {
		activeTab: 'main',
		expandedSections: {
			...createDefaultEditorPromptExpandedSections(),
			plan: true,
		},
		manualSectionOverrides: {
			report: 'manual',
		},
		descriptionExpanded: true,
	});
});

test('resolvePromptEditorExpandedSections applies auto-open rules until notes, plan, and report are changed manually', () => {
	const defaults = createDefaultEditorPromptExpandedSections();

	assert.deepEqual(resolvePromptEditorExpandedSections({
		expandedSections: defaults,
		manualSectionOverrides: {},
		hasNotesContent: true,
		hasPlanContent: false,
		shouldExpandPlanSection: false,
		hasReportContent: false,
	}), {
		...defaults,
		notes: true,
	});

	assert.deepEqual(resolvePromptEditorExpandedSections({
		expandedSections: defaults,
		manualSectionOverrides: {},
		hasNotesContent: false,
		hasPlanContent: false,
		shouldExpandPlanSection: false,
		hasReportContent: false,
	}), defaults);

	assert.deepEqual(resolvePromptEditorExpandedSections({
		expandedSections: defaults,
		manualSectionOverrides: {},
		hasNotesContent: false,
		hasPlanContent: true,
		shouldExpandPlanSection: false,
		hasReportContent: true,
	}), {
		...defaults,
		plan: true,
		report: true,
	});

	assert.deepEqual(resolvePromptEditorExpandedSections({
		expandedSections: {
			...defaults,
			notes: false,
			report: false,
		},
		manualSectionOverrides: {
			notes: 'manual',
			report: 'manual',
		},
		hasNotesContent: true,
		hasPlanContent: false,
		shouldExpandPlanSection: false,
		hasReportContent: true,
	}), {
		...defaults,
		notes: false,
		report: false,
	});
});

test('togglePromptEditorSectionExpansion uses effective section state and marks auto-managed sections as manual', () => {
	const defaults = createDefaultEditorPromptExpandedSections();
	const effectiveExpandedSections = resolvePromptEditorExpandedSections({
		expandedSections: defaults,
		manualSectionOverrides: {},
		hasNotesContent: false,
		hasPlanContent: true,
		shouldExpandPlanSection: false,
		hasReportContent: true,
	});

	assert.deepEqual(togglePromptEditorSectionExpansion({
		key: 'report',
		effectiveExpandedSections,
		expandedSections: defaults,
		manualSectionOverrides: {},
		hasNotesContent: false,
		hasPlanContent: false,
		hasReportContent: true,
	}), {
		expandedSections: {
			...defaults,
			report: false,
		},
		manualSectionOverrides: {
			report: 'manual',
		},
	});

	assert.deepEqual(togglePromptEditorSectionExpansion({
		key: 'plan',
		effectiveExpandedSections: resolvePromptEditorExpandedSections({
			expandedSections: defaults,
			manualSectionOverrides: {},
			hasNotesContent: false,
			hasPlanContent: false,
			shouldExpandPlanSection: false,
			hasReportContent: false,
		}),
		expandedSections: defaults,
		manualSectionOverrides: {},
		hasNotesContent: false,
		hasPlanContent: false,
		hasReportContent: false,
	}), {
		expandedSections: {
			...defaults,
			plan: true,
		},
		manualSectionOverrides: {
			plan: 'until-content',
		},
	});
});

test('resolvePromptEditorExpandedSections reopens plan and report once content appears after an empty manual override', () => {
	const defaults = createDefaultEditorPromptExpandedSections();

	assert.deepEqual(resolvePromptEditorExpandedSections({
		expandedSections: {
			...defaults,
			plan: false,
			report: false,
		},
		manualSectionOverrides: {
			plan: 'until-content',
			report: 'until-content',
		},
		hasNotesContent: false,
		hasPlanContent: true,
		shouldExpandPlanSection: false,
		hasReportContent: true,
	}), {
		...defaults,
		plan: true,
		report: true,
	});
});

test('resolvePromptEditorExpandedSections keeps manual collapse when plan and report already had content', () => {
	const defaults = createDefaultEditorPromptExpandedSections();

	assert.deepEqual(resolvePromptEditorExpandedSections({
		expandedSections: {
			...defaults,
			plan: false,
			report: false,
		},
		manualSectionOverrides: {
			plan: 'manual',
			report: 'manual',
		},
		hasNotesContent: false,
		hasPlanContent: true,
		shouldExpandPlanSection: false,
		hasReportContent: true,
	}), {
		...defaults,
		plan: false,
		report: false,
	});
});

test('resolvePromptEditorExpandedSections auto-opens Plan when plan-mode placeholder should be shown', () => {
	const defaults = createDefaultEditorPromptExpandedSections();

	assert.deepEqual(resolvePromptEditorExpandedSections({
		expandedSections: defaults,
		manualSectionOverrides: {},
		hasNotesContent: false,
		hasPlanContent: false,
		shouldExpandPlanSection: true,
		hasReportContent: false,
	}), {
		...defaults,
		plan: true,
	});

	assert.deepEqual(resolvePromptEditorExpandedSections({
		expandedSections: {
			...defaults,
			plan: false,
		},
		manualSectionOverrides: {
			plan: 'until-content',
		},
		hasNotesContent: false,
		hasPlanContent: false,
		shouldExpandPlanSection: true,
		hasReportContent: false,
	}), {
		...defaults,
		plan: false,
	});
});

test('resolvePromptPlanPlaceholderState returns plan-mode for empty plan section in Plan chat mode when status is in-progress', () => {
	assert.equal(resolvePromptPlanPlaceholderState({
		chatMode: 'plan',
		status: 'in-progress',
		planExists: false,
		hasPlanContent: false,
	}), 'plan-mode');

	assert.equal(resolvePromptPlanPlaceholderState({
		chatMode: 'plan',
		status: 'in-progress',
		planExists: true,
		hasPlanContent: false,
	}), 'plan-mode');
});

test('resolvePromptPlanPlaceholderState does not return plan-mode when status is not in-progress', () => {
	assert.equal(resolvePromptPlanPlaceholderState({
		chatMode: 'plan',
		status: 'completed',
		planExists: false,
		hasPlanContent: false,
	}), 'missing');

	assert.equal(resolvePromptPlanPlaceholderState({
		chatMode: 'plan',
		status: 'draft',
		planExists: true,
		hasPlanContent: false,
	}), 'empty');

	assert.equal(resolvePromptPlanPlaceholderState({
		chatMode: 'plan',
		planExists: false,
		hasPlanContent: false,
	}), 'missing');
});

test('resolvePromptPlanPlaceholderState keeps existing empty and missing states outside Plan chat mode', () => {
	assert.equal(resolvePromptPlanPlaceholderState({
		chatMode: 'agent',
		planExists: true,
		hasPlanContent: false,
	}), 'empty');

	assert.equal(resolvePromptPlanPlaceholderState({
		chatMode: 'agent',
		planExists: false,
		hasPlanContent: false,
	}), 'missing');
});

test('resolvePromptPlanPlaceholderState returns null once plan content exists', () => {
	assert.equal(resolvePromptPlanPlaceholderState({
		chatMode: 'plan',
		status: 'in-progress',
		planExists: true,
		hasPlanContent: true,
	}), null);
});

test('shouldPreservePromptIdAfterChatStart freezes prompt id after runtime chat lock or bound sessions', () => {
	assert.equal(shouldPreservePromptIdAfterChatStart({
		stableId: 'prompt-folder',
		chatSessionIds: ['session-1'],
		hasRuntimeChatStartLock: false,
	}), true);

	assert.equal(shouldPreservePromptIdAfterChatStart({
		stableId: 'prompt-folder',
		chatSessionIds: [],
		hasRuntimeChatStartLock: true,
	}), true);

	assert.equal(shouldPreservePromptIdAfterChatStart({
		stableId: 'prompt-folder',
		chatSessionIds: [],
		hasRuntimeChatStartLock: false,
	}), false);

	assert.equal(shouldPreservePromptIdAfterChatStart({
		stableId: '',
		chatSessionIds: ['session-1'],
		hasRuntimeChatStartLock: true,
	}), false);
});

test('shouldShowPromptChatLaunchBlock only keeps the launch block while launch is unfinished', () => {
	assert.equal(shouldShowPromptChatLaunchBlock({
		status: 'in-progress',
		hasChatEntry: false,
		chatRequestStarted: false,
		chatLaunchCompletionHold: false,
		chatRenameState: 'idle',
	}), true);

	assert.equal(shouldShowPromptChatLaunchBlock({
		status: 'in-progress',
		hasChatEntry: true,
		chatRequestStarted: true,
		chatLaunchCompletionHold: true,
		chatRenameState: 'completed',
	}), true);

	assert.equal(shouldShowPromptChatLaunchBlock({
		status: 'in-progress',
		hasChatEntry: true,
		chatRequestStarted: true,
		chatLaunchCompletionHold: false,
		chatRenameState: 'active',
	}), true);

	assert.equal(shouldShowPromptChatLaunchBlock({
		status: 'in-progress',
		hasChatEntry: true,
		chatRequestStarted: true,
		chatLaunchCompletionHold: false,
		chatRenameState: 'completed',
	}), false);

	assert.equal(shouldShowPromptChatLaunchBlock({
		status: 'in-progress',
		hasChatEntry: true,
		chatRequestStarted: false,
		chatLaunchCompletionHold: false,
		chatRenameState: 'idle',
	}), false);

	assert.equal(shouldShowPromptChatLaunchBlock({
		status: 'in-progress',
		hasChatEntry: false,
		chatRequestStarted: true,
		chatLaunchCompletionHold: false,
		chatRenameState: 'idle',
		completionShownOnce: true,
	}), false);

	assert.equal(shouldShowPromptChatLaunchBlock({
		status: 'draft',
		hasChatEntry: false,
		chatRequestStarted: false,
		chatLaunchCompletionHold: false,
		chatRenameState: 'idle',
	}), false);
});

test('isPromptChatLaunchComplete treats an already bound chat as complete when rename is idle', () => {
	assert.equal(isPromptChatLaunchComplete({
		hasChatEntry: false,
		chatRequestStarted: false,
		chatRenameState: 'idle',
	}), false);

	assert.equal(isPromptChatLaunchComplete({
		hasChatEntry: true,
		chatRequestStarted: false,
		chatRenameState: 'idle',
	}), true);

	assert.equal(isPromptChatLaunchComplete({
		hasChatEntry: true,
		chatRequestStarted: true,
		chatRenameState: 'active',
	}), false);

	assert.equal(isPromptChatLaunchComplete({
		hasChatEntry: true,
		chatRequestStarted: true,
		chatRenameState: 'completed',
	}), true);
});

test('resolvePromptChatLaunchPhase follows the earliest incomplete milestone', () => {
	assert.equal(resolvePromptChatLaunchPhase({
		hasChatEntry: false,
		chatRequestStarted: false,
		chatRenameState: 'idle',
		chatLaunchCompletionHold: false,
	}), 'opening');

	assert.equal(resolvePromptChatLaunchPhase({
		hasChatEntry: false,
		chatRequestStarted: true,
		chatRenameState: 'idle',
		chatLaunchCompletionHold: false,
	}), 'binding');

	assert.equal(resolvePromptChatLaunchPhase({
		hasChatEntry: true,
		chatRequestStarted: true,
		chatRenameState: 'active',
		chatLaunchCompletionHold: false,
	}), 'renaming');

	assert.equal(resolvePromptChatLaunchPhase({
		hasChatEntry: true,
		chatRequestStarted: false,
		chatRenameState: 'idle',
		chatLaunchCompletionHold: false,
	}), 'ready');

	assert.equal(resolvePromptChatLaunchPhase({
		hasChatEntry: true,
		chatRequestStarted: true,
		chatRenameState: 'completed',
		chatLaunchCompletionHold: true,
	}), 'ready');
});

test('resolvePromptChatLaunchStepStates keeps later steps pending until earlier milestones finish', () => {
	assert.deepEqual(resolvePromptChatLaunchStepStates({
		hasChatEntry: false,
		chatRequestStarted: false,
		chatRenameState: 'idle',
	}), {
		prepare: 'done',
		open: 'active',
		bind: 'pending',
		rename: 'pending',
	});

	assert.deepEqual(resolvePromptChatLaunchStepStates({
		hasChatEntry: false,
		chatRequestStarted: true,
		chatRenameState: 'idle',
	}), {
		prepare: 'done',
		open: 'done',
		bind: 'active',
		rename: 'pending',
	});

	assert.deepEqual(resolvePromptChatLaunchStepStates({
		hasChatEntry: true,
		chatRequestStarted: false,
		chatRenameState: 'idle',
	}), {
		prepare: 'done',
		open: 'done',
		bind: 'done',
		rename: 'done',
	});

	assert.deepEqual(resolvePromptChatLaunchStepStates({
		hasChatEntry: true,
		chatRequestStarted: true,
		chatRenameState: 'completed',
	}), {
		prepare: 'done',
		open: 'done',
		bind: 'done',
		rename: 'done',
	});
});

test('resolveNextPromptChatLaunchPhase advances forward one visual step at a time', () => {
	assert.deepEqual(PROMPT_CHAT_LAUNCH_PHASE_ORDER, ['opening', 'binding', 'renaming', 'ready']);
	assert.equal(resolveNextPromptChatLaunchPhase('opening', 'binding'), 'binding');
	assert.equal(resolveNextPromptChatLaunchPhase('opening', 'ready'), 'binding');
	assert.equal(resolveNextPromptChatLaunchPhase('binding', 'ready'), 'renaming');
	assert.equal(resolveNextPromptChatLaunchPhase('renaming', 'ready'), 'ready');
	assert.equal(resolveNextPromptChatLaunchPhase('ready', 'opening'), 'opening');
});

test('resolvePromptChatLaunchStepStatesFromPhase mirrors the visible launch phase', () => {
	assert.deepEqual(resolvePromptChatLaunchStepStatesFromPhase('opening'), {
		prepare: 'done',
		open: 'active',
		bind: 'pending',
		rename: 'pending',
	});

	assert.deepEqual(resolvePromptChatLaunchStepStatesFromPhase('binding'), {
		prepare: 'done',
		open: 'done',
		bind: 'active',
		rename: 'pending',
	});

	assert.deepEqual(resolvePromptChatLaunchStepStatesFromPhase('renaming'), {
		prepare: 'done',
		open: 'done',
		bind: 'done',
		rename: 'active',
	});

	assert.deepEqual(resolvePromptChatLaunchStepStatesFromPhase('ready'), {
		prepare: 'done',
		open: 'done',
		bind: 'done',
		rename: 'done',
	});
});

test('resolvePromptChatContextAutoLoadDisplay reflects launch-time and source states', () => {
	assert.deepEqual(resolvePromptChatContextAutoLoadDisplay({
		enabled: false,
		canLoadRemote: true,
		source: 'remote',
		runtimeState: 'idle',
	}), {
		kind: 'disabled-setting',
		badgeTone: 'pending',
		stepState: 'done',
	});

	assert.deepEqual(resolvePromptChatContextAutoLoadDisplay({
		enabled: true,
		canLoadRemote: false,
		source: 'remote',
		runtimeState: 'idle',
	}), {
		kind: 'disabled-no-url',
		badgeTone: 'pending',
		stepState: 'done',
	});

	assert.deepEqual(resolvePromptChatContextAutoLoadDisplay({
		enabled: true,
		canLoadRemote: true,
		source: 'remote',
		runtimeState: 'idle',
	}), {
		kind: 'enabled',
		badgeTone: 'done',
		stepState: 'pending',
	});

	assert.deepEqual(resolvePromptChatContextAutoLoadDisplay({
		enabled: true,
		canLoadRemote: true,
		source: 'manual',
		runtimeState: 'idle',
	}), {
		kind: 'disabled-manual',
		badgeTone: 'pending',
		stepState: 'done',
	});

	assert.deepEqual(resolvePromptChatContextAutoLoadDisplay({
		enabled: true,
		canLoadRemote: true,
		source: 'empty',
		runtimeState: 'idle',
	}), {
		kind: 'enabled',
		badgeTone: 'done',
		stepState: 'pending',
	});

	assert.deepEqual(resolvePromptChatContextAutoLoadDisplay({
		enabled: true,
		canLoadRemote: true,
		source: 'remote',
		runtimeState: 'active',
	}), {
		kind: 'active',
		badgeTone: 'active',
		stepState: 'active',
	});

	assert.deepEqual(resolvePromptChatContextAutoLoadDisplay({
		enabled: true,
		canLoadRemote: true,
		source: 'remote',
		runtimeState: 'completed',
	}), {
		kind: 'completed',
		badgeTone: 'done',
		stepState: 'done',
	});

	assert.deepEqual(resolvePromptChatContextAutoLoadDisplay({
		enabled: true,
		canLoadRemote: true,
		source: 'remote',
		runtimeState: 'fallback',
	}), {
		kind: 'fallback',
		badgeTone: 'pending',
		stepState: 'done',
	});
});

test('resolvePromptChatLaunchTrackingKey prefers promptUuid and falls back to prompt id', () => {
	assert.equal(resolvePromptChatLaunchTrackingKey({
		id: 'prompt-id',
		promptUuid: 'uuid-1',
	}), 'uuid:uuid-1');

	assert.equal(resolvePromptChatLaunchTrackingKey({
		id: 'prompt-id',
		promptUuid: '',
	}), 'id:prompt-id');

	assert.equal(resolvePromptChatLaunchTrackingKey({
		id: '',
		promptUuid: '',
	}), 'id:__new__');
});