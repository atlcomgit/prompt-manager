import type {
	EditorPromptExpandedSections,
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
	hasReportContent: boolean;
}

interface TogglePromptEditorSectionExpansionInput {
	key: EditorPromptSectionKey;
	effectiveExpandedSections: EditorPromptExpandedSections;
	expandedSections?: EditorPromptExpandedSections | null;
	manualSectionOverrides?: EditorPromptManualSectionOverrides | null;
}

interface ShouldPreservePromptIdAfterChatStartInput {
	stableId?: string | null;
	chatSessionIds?: readonly string[] | null;
	hasRuntimeChatStartLock?: boolean;
}

interface ShouldShowPromptChatLaunchBlockInput {
	status: PromptStatus;
	hasChatEntry: boolean;
	chatLaunchCompletionHold: boolean;
}

function resolvePromptEditorAutoSectionExpandedState(
	key: 'notes' | 'plan' | 'report',
	input: ResolvePromptEditorExpandedSectionsInput,
): boolean {
	const defaults = createDefaultEditorPromptExpandedSections();

	if (key === 'notes') {
		return defaults.notes || input.hasNotesContent;
	}

	if (key === 'plan') {
		return input.hasPlanContent;
	}

	return input.hasReportContent;
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
		if (normalized.manualSectionOverrides[key] === true) {
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

	return {
		expandedSections: {
			...normalized.expandedSections,
			[input.key]: nextExpanded,
		},
		manualSectionOverrides: isPromptEditorAutoManagedSection(input.key)
			? {
				...normalized.manualSectionOverrides,
				[input.key]: true,
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
	return input.status === 'in-progress' && (!input.hasChatEntry || input.chatLaunchCompletionHold);
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