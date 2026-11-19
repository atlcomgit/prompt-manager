import type { PromptConfig } from '../types/prompt.js';

export interface SidebarSelectionState {
	selectedId: string | null;
	selectedPromptUuid: string | null;
}

export interface SidebarDeletionState extends SidebarSelectionState {
	showOptimisticNewPrompt: boolean;
}

export function reconcileSidebarDeletionState(
	state: SidebarDeletionState,
	deletedId: string | null | undefined,
): SidebarDeletionState {
	const normalizedDeletedId = (deletedId || '').trim() || null;
	if (!normalizedDeletedId) {
		return state;
	}

	const shouldClearSelection = state.selectedId === normalizedDeletedId;
	const shouldClearOptimisticNewPrompt = normalizedDeletedId === '__new__';

	return {
		showOptimisticNewPrompt: shouldClearOptimisticNewPrompt ? false : state.showOptimisticNewPrompt,
		selectedId: shouldClearSelection ? null : state.selectedId,
		selectedPromptUuid: shouldClearSelection ? null : state.selectedPromptUuid,
	};
}

export function reconcileSidebarPromptSavingSelection(
	selection: SidebarSelectionState,
	savingPrompt: { id: string | null | undefined; promptUuid: string | null | undefined },
): SidebarSelectionState {
	const selectedId = (selection.selectedId || '').trim() || null;
	const selectedPromptUuid = (selection.selectedPromptUuid || '').trim() || null;
	const savingId = (savingPrompt.id || '').trim() || null;
	const savingPromptUuid = (savingPrompt.promptUuid || '').trim() || null;

	// Capture the stable UUID for the optimistic "__new__" row as soon as host saving begins.
	if (selectedId === '__new__' && savingId === '__new__' && savingPromptUuid) {
		return {
			selectedId,
			selectedPromptUuid: savingPromptUuid,
		};
	}

	return {
		selectedId,
		selectedPromptUuid,
	};
}

export function reconcileSidebarSelection(
	prompts: PromptConfig[],
	selection: SidebarSelectionState,
): SidebarSelectionState {
	const selectedId = (selection.selectedId || '').trim() || null;
	const selectedPromptUuid = (selection.selectedPromptUuid || '').trim() || null;

	// Сохраняем точную папку; после переименования выбираем только однозначный UUID.
	const candidates = selectedPromptUuid
		? prompts.filter(prompt => (prompt.promptUuid || '').trim() === selectedPromptUuid)
		: prompts;
	const matchingPrompt = candidates.find(prompt => prompt.id === selectedId)
		?? (selectedPromptUuid && candidates.length === 1 ? candidates[0] : undefined);
	if (matchingPrompt) {
		return {
			selectedId: matchingPrompt.id,
			selectedPromptUuid: (matchingPrompt.promptUuid || '').trim() || null,
		};
	}

	return selectedId === '__new__' ? { selectedId, selectedPromptUuid } : { selectedId: null, selectedPromptUuid: null };
}
