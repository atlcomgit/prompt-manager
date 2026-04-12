import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultEditorPromptExpandedSections } from '../src/types/prompt.js';
import {
	resolvePromptEditorExpandedSections,
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
		hasReportContent: false,
	}), defaults);

	assert.deepEqual(resolvePromptEditorExpandedSections({
		expandedSections: defaults,
		manualSectionOverrides: {},
		hasNotesContent: false,
		hasPlanContent: true,
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
		hasReportContent: true,
	}), {
		...defaults,
		plan: false,
		report: false,
	});
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
		chatLaunchCompletionHold: false,
	}), true);

	assert.equal(shouldShowPromptChatLaunchBlock({
		status: 'in-progress',
		hasChatEntry: true,
		chatLaunchCompletionHold: true,
	}), true);

	assert.equal(shouldShowPromptChatLaunchBlock({
		status: 'in-progress',
		hasChatEntry: true,
		chatLaunchCompletionHold: false,
	}), false);

	assert.equal(shouldShowPromptChatLaunchBlock({
		status: 'draft',
		hasChatEntry: false,
		chatLaunchCompletionHold: false,
	}), false);
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