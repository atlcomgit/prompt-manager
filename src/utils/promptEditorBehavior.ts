import type {
	EditorPromptExpandedSections,
	EditorPromptManualSectionOverrideMode,
	EditorPromptManualSectionOverrides,
	EditorPromptSectionKey,
	EditorPromptViewState,
	Prompt,
	PromptStatus,
} from '../types/prompt.js';
import {
	createDefaultEditorPromptExpandedSections,
	isPromptEditorAutoManagedSection,
	normalizeEditorPromptViewState,
} from '../types/prompt.js';

interface ResolvePromptOpenEditorViewStateOptions {
	forceMainTab?: boolean;
}

interface ResolvePromptEditorExpandedSectionsInput {
	expandedSections?: EditorPromptExpandedSections | null;
	manualSectionOverrides?: EditorPromptManualSectionOverrides | null;
	hasNotesContent: boolean;
	hasPlanContent: boolean;
	shouldExpandPlanSection?: boolean;
	hasReportContent: boolean;
}

interface TogglePromptEditorSectionExpansionInput {
	key: EditorPromptSectionKey;
	effectiveExpandedSections: EditorPromptExpandedSections;
	expandedSections?: EditorPromptExpandedSections | null;
	manualSectionOverrides?: EditorPromptManualSectionOverrides | null;
	hasNotesContent?: boolean;
	hasPlanContent?: boolean;
	hasReportContent?: boolean;
}

interface ShouldPreservePromptIdAfterChatStartInput {
	stableId?: string | null;
	chatSessionIds?: readonly string[] | null;
	hasRuntimeChatStartLock?: boolean;
}

interface ShouldShowPromptChatLaunchBlockInput {
	status: PromptStatus;
	hasChatEntry: boolean;
	chatRequestStarted: boolean;
	chatLaunchCompletionHold: boolean;
	chatRenameState: PromptChatLaunchRenameState;
}

export type PromptChatLaunchRenameState = 'idle' | 'active' | 'completed';
export type PromptChatLaunchStepState = 'done' | 'active' | 'pending';
export type PromptChatLaunchPhase = 'opening' | 'binding' | 'renaming' | 'ready';

interface IsPromptChatLaunchCompleteInput {
	hasChatEntry: boolean;
	chatRequestStarted: boolean;
	chatRenameState: PromptChatLaunchRenameState;
}

interface ResolvePromptChatLaunchPhaseInput extends IsPromptChatLaunchCompleteInput {
	chatLaunchCompletionHold: boolean;
}

interface ResolvePromptChatLaunchStepStatesInput extends IsPromptChatLaunchCompleteInput { }

/** Input for resolving the empty-state placeholder shown in the Plan section. */
interface ResolvePromptPlanPlaceholderStateInput {
	chatMode?: Prompt['chatMode'] | null;
	status?: PromptStatus | null;
	planExists: boolean;
	hasPlanContent: boolean;
}

/** Placeholder variants available for the Plan section when no plan content exists yet. */
export type PromptPlanPlaceholderState = 'plan-mode' | 'empty' | 'missing' | null;

function resolvePromptEditorAutoSectionExpandedState(
	key: 'notes' | 'plan' | 'report',
	input: ResolvePromptEditorExpandedSectionsInput,
): boolean {
	const defaults = createDefaultEditorPromptExpandedSections();

	if (key === 'notes') {
		return defaults.notes || input.hasNotesContent;
	}

	if (key === 'plan') {
		return input.hasPlanContent || input.shouldExpandPlanSection === true;
	}

	return input.hasReportContent;
}

function resolvePromptEditorSectionHasContent(
	key: 'notes' | 'plan' | 'report',
	input: Pick<ResolvePromptEditorExpandedSectionsInput, 'hasNotesContent' | 'hasPlanContent' | 'hasReportContent'>,
): boolean {
	if (key === 'notes') {
		return input.hasNotesContent;
	}

	if (key === 'plan') {
		return input.hasPlanContent;
	}

	return input.hasReportContent;
}

function shouldApplyPromptEditorAutoSectionState(
	key: 'notes' | 'plan' | 'report',
	overrideMode: EditorPromptManualSectionOverrideMode | undefined,
	input: ResolvePromptEditorExpandedSectionsInput,
): boolean {
	if (overrideMode === 'manual') {
		return false;
	}

	if (overrideMode === 'until-content') {
		return resolvePromptEditorSectionHasContent(key, input);
	}

	return true;
}

function resolvePromptEditorNextManualSectionOverride(
	key: EditorPromptSectionKey,
	input: Pick<TogglePromptEditorSectionExpansionInput, 'hasNotesContent' | 'hasPlanContent' | 'hasReportContent'>,
): EditorPromptManualSectionOverrideMode | undefined {
	if (!isPromptEditorAutoManagedSection(key)) {
		return undefined;
	}

	if ((key === 'plan' || key === 'report') && !resolvePromptEditorSectionHasContent(key, {
		hasNotesContent: input.hasNotesContent === true,
		hasPlanContent: input.hasPlanContent === true,
		hasReportContent: input.hasReportContent === true,
	})) {
		return 'until-content';
	}

	return 'manual';
}

/** Normalize view state for prompt open and optionally force the main tab. */
export function resolvePromptOpenEditorViewState(
	state?: EditorPromptViewState | null,
	options?: ResolvePromptOpenEditorViewStateOptions,
): EditorPromptViewState {
	const normalized = normalizeEditorPromptViewState(state);
	if (options?.forceMainTab !== true || normalized.activeTab === 'main') {
		return normalized;
	}

	return {
		...normalized,
		activeTab: 'main',
	};
}

/** Resolve effective section expansion from defaults, content state, and manual overrides. */
export function resolvePromptEditorExpandedSections(
	input: ResolvePromptEditorExpandedSectionsInput,
): EditorPromptExpandedSections {
	const normalized = normalizeEditorPromptViewState({
		expandedSections: input.expandedSections,
		manualSectionOverrides: input.manualSectionOverrides || undefined,
	});
	const nextExpandedSections = {
		...normalized.expandedSections,
	};

	for (const key of ['notes', 'plan', 'report'] as const) {
		if (!shouldApplyPromptEditorAutoSectionState(key, normalized.manualSectionOverrides[key], input)) {
			continue;
		}

		nextExpandedSections[key] = resolvePromptEditorAutoSectionExpandedState(key, input);
	}

	return nextExpandedSections;
}

/** Toggle a section and mark auto-managed sections as manually controlled. */
export function togglePromptEditorSectionExpansion(
	input: TogglePromptEditorSectionExpansionInput,
): Pick<EditorPromptViewState, 'expandedSections' | 'manualSectionOverrides'> {
	const normalized = normalizeEditorPromptViewState({
		expandedSections: input.expandedSections,
		manualSectionOverrides: input.manualSectionOverrides || undefined,
	});
	const nextExpanded = !input.effectiveExpandedSections[input.key];
	const nextManualOverride = resolvePromptEditorNextManualSectionOverride(input.key, {
		hasNotesContent: input.hasNotesContent,
		hasPlanContent: input.hasPlanContent,
		hasReportContent: input.hasReportContent,
	});

	return {
		expandedSections: {
			...normalized.expandedSections,
			[input.key]: nextExpanded,
		},
		manualSectionOverrides: nextManualOverride
			? {
				...normalized.manualSectionOverrides,
				[input.key]: nextManualOverride,
			}
			: normalized.manualSectionOverrides,
	};
}

/** Keep the current prompt id stable once chat start already owns the folder path. */
export function shouldPreservePromptIdAfterChatStart(
	input: ShouldPreservePromptIdAfterChatStartInput,
): boolean {
	const stableId = (input.stableId || '').trim();
	if (!stableId) {
		return false;
	}

	return (input.chatSessionIds?.length || 0) > 0 || input.hasRuntimeChatStartLock === true;
}

/** Show launch progress only while chat entry is still missing or hold is active. */
export function shouldShowPromptChatLaunchBlock(
	input: ShouldShowPromptChatLaunchBlockInput,
): boolean {
	return input.status === 'in-progress'
		&& (!isPromptChatLaunchComplete(input) || input.chatLaunchCompletionHold);
}

/** Treat launch as complete only after request start, bind, and rename all finished. */
export function isPromptChatLaunchComplete(
	input: IsPromptChatLaunchCompleteInput,
): boolean {
	return input.chatRequestStarted
		&& input.hasChatEntry
		&& input.chatRenameState === 'completed';
}

/** Resolve the top-level launch phase from the earliest incomplete milestone. */
export function resolvePromptChatLaunchPhase(
	input: ResolvePromptChatLaunchPhaseInput,
): PromptChatLaunchPhase {
	if (input.chatLaunchCompletionHold || isPromptChatLaunchComplete(input)) {
		return 'ready';
	}

	if (!input.chatRequestStarted) {
		return 'opening';
	}

	if (!input.hasChatEntry) {
		return 'binding';
	}

	return 'renaming';
}

/** Resolve step states so later milestones cannot complete before earlier ones. */
export function resolvePromptChatLaunchStepStates(
	input: ResolvePromptChatLaunchStepStatesInput,
): Record<'prepare' | 'open' | 'bind' | 'rename', PromptChatLaunchStepState> {
	return {
		prepare: 'done',
		open: input.chatRequestStarted ? 'done' : 'active',
		bind: !input.chatRequestStarted
			? 'pending'
			: input.hasChatEntry
				? 'done'
				: 'active',
		rename: !input.chatRequestStarted || !input.hasChatEntry
			? 'pending'
			: input.chatRenameState === 'completed'
				? 'done'
				: 'active',
	};
}

/** Resolve which placeholder the Plan section should display before plan content appears. */
export function resolvePromptPlanPlaceholderState(
	input: ResolvePromptPlanPlaceholderStateInput,
): PromptPlanPlaceholderState {
	if (input.hasPlanContent) {
		return null;
	}

	// Show the PLAN badge only when the prompt is actively in progress
	if (input.chatMode === 'plan' && input.status === 'in-progress') {
		return 'plan-mode';
	}

	return input.planExists ? 'empty' : 'missing';
}

/** Build a stable key for prompt-scoped launch tracking across prompt switches. */
export function resolvePromptChatLaunchTrackingKey(
	prompt?: Pick<Prompt, 'id' | 'promptUuid'> | null,
): string {
	const promptUuid = (prompt?.promptUuid || '').trim();
	if (promptUuid) {
		return `uuid:${promptUuid}`;
	}

	const promptId = (prompt?.id || '').trim() || '__new__';
	return `id:${promptId}`;
}