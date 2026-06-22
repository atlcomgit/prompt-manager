import type {
	EditorPromptExpandedSections,
	EditorPromptManualSectionOverrideMode,
	EditorPromptManualSectionOverrides,
	EditorPromptSectionKey,
	EditorPromptTab,
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

/** Runtime snapshot of the prompt editor Process tab scroll container. */
export interface PromptProcessBodyScrollSnapshot {
	promptId?: string | null;
	promptUuid?: string | null;
	activeTab: EditorPromptTab;
	top: number;
	left: number;
	capturedAt: number;
	manualScrollVersion: number;
}

/** Input used to decide whether a Process tab scroll snapshot is still safe to apply. */
export interface ResolvePromptProcessBodyScrollRestoreInput {
	snapshot?: PromptProcessBodyScrollSnapshot | null;
	currentPromptId?: string | null;
	currentPromptUuid?: string | null;
	activeTab: EditorPromptTab;
	scrollHeight: number;
	clientHeight: number;
	scrollWidth?: number;
	clientWidth?: number;
	currentTop: number;
	currentLeft: number;
	manualScrollVersion: number;
	placeholderVisible?: boolean;
	now: number;
	maxSnapshotAgeMs: number;
}

export type PromptProcessBodyScrollRestoreReason =
	| 'restore'
	| 'missing-snapshot'
	| 'stale-snapshot'
	| 'inactive-tab'
	| 'placeholder-visible'
	| 'identity-mismatch'
	| 'manual-scroll'
	| 'already-current';

/** Decision returned before mutating the Process tab scroll container. */
export interface PromptProcessBodyScrollRestoreDecision {
	shouldRestore: boolean;
	top: number;
	left: number;
	reason: PromptProcessBodyScrollRestoreReason;
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

interface ShouldPersistAutoExpandedReportSectionInput {
	expandedReport: boolean;
	effectiveReport: boolean;
	hasReportContent: boolean;
	manualReportOverride?: EditorPromptManualSectionOverrideMode | null;
}

interface ShouldAutoExpandPromptBranchListInput {
	branchesResolved: boolean;
	hasBranchMismatch: boolean;
	branchesExpandedManual: boolean;
	autoExpanded: boolean;
}

interface ShouldDeferReportAutosaveInput {
	reportEditorFocused: boolean;
	reportDraftActive: boolean;
}

interface ShouldPreserveLocalReportOnSaveInput extends ShouldDeferReportAutosaveInput {
	reason?: 'open' | 'save' | 'sync' | 'ai-enrichment' | 'external-config';
	currentLocalReport: string;
	incomingSavedReport: string;
	saveClearedDirty?: boolean;
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
	completionShownOnce?: boolean;
}

export type PromptChatLaunchRenameState = 'idle' | 'active' | 'completed';
export type PromptChatLaunchStepState = 'done' | 'active' | 'pending';
export type PromptChatLaunchPhase = 'prepare' | 'autoload' | 'opening' | 'binding' | 'renaming' | 'ready';

export const PROMPT_CHAT_LAUNCH_PHASE_ORDER: PromptChatLaunchPhase[] = [
	'prepare',
	'autoload',
	'opening',
	'binding',
	'renaming',
	'ready',
];

/** Defer prompt-wide save side effects while the inline report editor owns local typing state. */
export function shouldDeferReportAutosave(input: ShouldDeferReportAutosaveInput): boolean {
	return input.reportEditorFocused || input.reportDraftActive;
}

/** Keep the local report when a save response cannot yet be trusted as the active editor state. */
export function shouldPreserveLocalReportOnSave(input: ShouldPreserveLocalReportOnSaveInput): boolean {
	if (input.reason !== 'save') {
		return false;
	}

	if (input.currentLocalReport !== input.incomingSavedReport) {
		return true;
	}

	if (input.saveClearedDirty === true && !input.reportDraftActive) {
		return false;
	}

	return shouldDeferReportAutosave({
		reportEditorFocused: input.reportEditorFocused,
		reportDraftActive: input.reportDraftActive,
	});
}

const PROMPT_EXTERNAL_CHAT_LAUNCH_PHASE_ORDER: PromptChatLaunchPhase[] = [
	'prepare',
	'autoload',
	'opening',
	'ready',
];

interface IsPromptChatLaunchCompleteInput {
	hasChatEntry: boolean;
	chatRequestStarted: boolean;
	chatRenameState: PromptChatLaunchRenameState;
	requiresChatBinding?: boolean;
}

interface ResolvePromptChatLaunchPhaseInput extends IsPromptChatLaunchCompleteInput {
	chatLaunchCompletionHold: boolean;
}

interface ResolvePromptChatLaunchStepStatesInput extends IsPromptChatLaunchCompleteInput { }

export type PromptGlobalContextSource = 'empty' | 'manual' | 'remote';
export type PromptChatContextAutoLoadRuntimeState = 'idle' | 'active' | 'completed' | 'fallback';
export type PromptChatContextAutoLoadTone = 'done' | 'active' | 'pending';

interface ResolvePromptChatContextAutoLoadDisplayInput {
	enabled: boolean;
	canLoadRemote: boolean;
	source: PromptGlobalContextSource;
	runtimeState: PromptChatContextAutoLoadRuntimeState;
}

export interface PromptChatContextAutoLoadDisplay {
	kind: 'disabled-setting' | 'disabled-no-url' | 'disabled-manual' | 'enabled' | 'active' | 'completed' | 'fallback';
	badgeTone: PromptChatContextAutoLoadTone;
	stepState: PromptChatLaunchStepState;
}

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

/** Normalize prompt identity fragments before comparing runtime scroll snapshots. */
function normalizePromptScrollIdentityPart(value?: string | null): string {
	return typeof value === 'string' ? value.trim() : '';
}

/** Clamp a scroll coordinate to the currently available scroll range. */
function clampPromptProcessScrollOffset(value: number, maxValue: number): number {
	const normalizedValue = Number.isFinite(value) ? Math.round(value) : 0;
	const normalizedMaxValue = Number.isFinite(maxValue) ? Math.max(0, Math.round(maxValue)) : 0;
	return Math.max(0, Math.min(normalizedValue, normalizedMaxValue));
}

/** Decide whether the saved Process tab scroll position can be safely restored now. */
export function resolvePromptProcessBodyScrollRestore(
	input: ResolvePromptProcessBodyScrollRestoreInput,
): PromptProcessBodyScrollRestoreDecision {
	const snapshot = input.snapshot;
	if (!snapshot) {
		return { shouldRestore: false, top: 0, left: 0, reason: 'missing-snapshot' };
	}

	if (input.now - snapshot.capturedAt > input.maxSnapshotAgeMs) {
		return { shouldRestore: false, top: snapshot.top, left: snapshot.left, reason: 'stale-snapshot' };
	}

	if (input.activeTab !== 'process' || snapshot.activeTab !== 'process') {
		return { shouldRestore: false, top: snapshot.top, left: snapshot.left, reason: 'inactive-tab' };
	}

	if (input.placeholderVisible === true) {
		return { shouldRestore: false, top: snapshot.top, left: snapshot.left, reason: 'placeholder-visible' };
	}

	const snapshotPromptId = normalizePromptScrollIdentityPart(snapshot.promptId);
	const snapshotPromptUuid = normalizePromptScrollIdentityPart(snapshot.promptUuid);
	const currentPromptId = normalizePromptScrollIdentityPart(input.currentPromptId);
	const currentPromptUuid = normalizePromptScrollIdentityPart(input.currentPromptUuid);
	const promptIdMatches = Boolean(snapshotPromptId && currentPromptId && snapshotPromptId === currentPromptId);
	const promptUuidMatches = Boolean(snapshotPromptUuid && currentPromptUuid && snapshotPromptUuid === currentPromptUuid);
	if (!promptIdMatches && !promptUuidMatches) {
		return { shouldRestore: false, top: snapshot.top, left: snapshot.left, reason: 'identity-mismatch' };
	}

	if (snapshot.manualScrollVersion !== input.manualScrollVersion) {
		return { shouldRestore: false, top: snapshot.top, left: snapshot.left, reason: 'manual-scroll' };
	}

	const maxTop = Math.max(0, input.scrollHeight - input.clientHeight);
	const maxLeft = Math.max(0, (input.scrollWidth || 0) - (input.clientWidth || 0));
	const top = clampPromptProcessScrollOffset(snapshot.top, maxTop);
	const left = clampPromptProcessScrollOffset(snapshot.left, maxLeft);
	const topAlreadyCurrent = Math.abs(Math.round(input.currentTop) - top) <= 1;
	const leftAlreadyCurrent = Math.abs(Math.round(input.currentLeft) - left) <= 1;
	if (topAlreadyCurrent && leftAlreadyCurrent) {
		return { shouldRestore: false, top, left, reason: 'already-current' };
	}

	return { shouldRestore: true, top, left, reason: 'restore' };
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

		if (key === 'report' && !input.hasReportContent && normalized.expandedSections.report) {
			nextExpandedSections.report = true;
			continue;
		}

		nextExpandedSections[key] = resolvePromptEditorAutoSectionExpandedState(key, input);
	}

	return nextExpandedSections;
}

/**
 * Latch the auto-opened Report section into persisted expanded state once real content exists.
 * This prevents transient empty report values from collapsing the whole section mid-edit.
 */
export function shouldPersistAutoExpandedReportSection(
	input: ShouldPersistAutoExpandedReportSectionInput,
): boolean {
	if (!input.hasReportContent) {
		return false;
	}

	if (input.manualReportOverride === 'manual') {
		return false;
	}

	return input.effectiveReport && !input.expandedReport;
}

/** Decide whether branch mismatch may auto-open the per-project branches list. */
export function shouldAutoExpandPromptBranchList(input: ShouldAutoExpandPromptBranchListInput): boolean {
	return input.branchesResolved
		&& input.hasBranchMismatch
		&& !input.branchesExpandedManual
		&& !input.autoExpanded;
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
	if (input.status !== 'in-progress') {
		return false;
	}

	if (input.completionShownOnce === true && !input.chatLaunchCompletionHold) {
		return false;
	}

	return true;
}

/**
 * Treat launch as complete once a chat entry exists and no live rename step is still running.
 *
 * A persisted or restored bound chat entry already proves that open/bind finished successfully,
 * even if transient runtime flags were lost during sync or prompt reopen.
 */
export function isPromptChatLaunchComplete(
	input: IsPromptChatLaunchCompleteInput,
): boolean {
	const chatOpened = input.requiresChatBinding === false
		? input.hasChatEntry || input.chatRequestStarted
		: input.hasChatEntry;
	return chatOpened && input.chatRenameState !== 'active';
}

/** Resolve the top-level launch phase from the earliest incomplete milestone. */
export function resolvePromptChatLaunchPhase(
	input: ResolvePromptChatLaunchPhaseInput,
): PromptChatLaunchPhase {
	if (input.chatLaunchCompletionHold || isPromptChatLaunchComplete(input)) {
		return 'ready';
	}

	if (!input.chatRequestStarted && !input.hasChatEntry) {
		return 'opening';
	}

	if (input.requiresChatBinding === false) {
		return 'ready';
	}

	if (!input.hasChatEntry) {
		return 'binding';
	}

	return 'renaming';
}

/** Advance visual launch progress by a single phase while keeping backward jumps immediate. */
export function resolveNextPromptChatLaunchPhase(
	current: PromptChatLaunchPhase,
	target: PromptChatLaunchPhase,
	input?: { requiresChatBinding?: boolean },
): PromptChatLaunchPhase {
	const phaseOrder = input?.requiresChatBinding === false
		? PROMPT_EXTERNAL_CHAT_LAUNCH_PHASE_ORDER
		: PROMPT_CHAT_LAUNCH_PHASE_ORDER;
	const currentIndex = phaseOrder.indexOf(current);
	const targetIndex = phaseOrder.indexOf(target);
	if (currentIndex < 0 || targetIndex < 0) {
		return target;
	}

	if (targetIndex <= currentIndex) {
		return target;
	}

	return phaseOrder[currentIndex + 1] || target;
}

/** Keep inactive launch UI parked on the first row until the tracked launch is actually visible. */
export function resolvePromptChatLaunchInactivePhase(
	target: PromptChatLaunchPhase,
): PromptChatLaunchPhase {
	return target === 'ready' ? 'ready' : 'prepare';
}

/** Resolve launch step badges for an already chosen visual phase. */
export function resolvePromptChatLaunchStepStatesFromPhase(
	phase: PromptChatLaunchPhase,
): Record<'prepare' | 'open' | 'bind' | 'rename', PromptChatLaunchStepState> {
	if (phase === 'prepare') {
		return {
			prepare: 'active',
			open: 'pending',
			bind: 'pending',
			rename: 'pending',
		};
	}

	if (phase === 'autoload') {
		return {
			prepare: 'done',
			open: 'pending',
			bind: 'pending',
			rename: 'pending',
		};
	}

	if (phase === 'opening') {
		return {
			prepare: 'done',
			open: 'active',
			bind: 'pending',
			rename: 'pending',
		};
	}

	if (phase === 'binding') {
		return {
			prepare: 'done',
			open: 'done',
			bind: 'active',
			rename: 'pending',
		};
	}

	if (phase === 'renaming') {
		return {
			prepare: 'done',
			open: 'done',
			bind: 'done',
			rename: 'active',
		};
	}

	return {
		prepare: 'done',
		open: 'done',
		bind: 'done',
		rename: 'done',
	};
}

/** Resolve step states so restored chat entries still mark already-finished milestones as done. */
export function resolvePromptChatLaunchStepStates(
	input: ResolvePromptChatLaunchStepStatesInput,
): Record<'prepare' | 'open' | 'bind' | 'rename', PromptChatLaunchStepState> {
	return resolvePromptChatLaunchStepStatesFromPhase(resolvePromptChatLaunchPhase({
		hasChatEntry: input.hasChatEntry,
		chatRequestStarted: input.chatRequestStarted,
		chatRenameState: input.chatRenameState,
		chatLaunchCompletionHold: false,
		requiresChatBinding: input.requiresChatBinding,
	}));
}

/** Resolve the UI state for the shared-context auto-load notice in the chat launch block. */
export function resolvePromptChatContextAutoLoadDisplay(
	input: ResolvePromptChatContextAutoLoadDisplayInput,
): PromptChatContextAutoLoadDisplay {
	if (!input.enabled) {
		return {
			kind: 'disabled-setting',
			badgeTone: 'pending',
			stepState: 'done',
		};
	}

	if (!input.canLoadRemote) {
		return {
			kind: 'disabled-no-url',
			badgeTone: 'pending',
			stepState: 'done',
		};
	}

	if (input.runtimeState === 'active') {
		return {
			kind: 'active',
			badgeTone: 'active',
			stepState: 'active',
		};
	}

	if (input.runtimeState === 'completed') {
		return {
			kind: 'completed',
			badgeTone: 'done',
			stepState: 'done',
		};
	}

	if (input.runtimeState === 'fallback') {
		return {
			kind: 'fallback',
			badgeTone: 'pending',
			stepState: 'done',
		};
	}

	if (input.source === 'remote') {
		return {
			kind: 'enabled',
			badgeTone: 'done',
			stepState: 'pending',
		};
	}

	if (input.source === 'manual') {
		return {
			kind: 'disabled-manual',
			badgeTone: 'pending',
			stepState: 'done',
		};
	}

	return {
		kind: 'enabled',
		badgeTone: 'done',
		stepState: 'pending',
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

/** Reset launch-cycle state only when prompt identity truly changes, not when missing ids arrive later. */
export function shouldResetPromptChatLaunchTracking(
	previousPrompt?: Pick<Prompt, 'id' | 'promptUuid'> | null,
	nextPrompt?: Pick<Prompt, 'id' | 'promptUuid'> | null,
): boolean {
	const previousPromptUuid = (previousPrompt?.promptUuid || '').trim();
	const nextPromptUuid = (nextPrompt?.promptUuid || '').trim();
	if (previousPromptUuid && nextPromptUuid) {
		return previousPromptUuid !== nextPromptUuid;
	}

	const previousPromptId = (previousPrompt?.id || '').trim();
	const nextPromptId = (nextPrompt?.id || '').trim();
	if (previousPromptId && nextPromptId) {
		return previousPromptId !== nextPromptId;
	}

	return previousPromptId !== nextPromptId || previousPromptUuid !== nextPromptUuid;
}
