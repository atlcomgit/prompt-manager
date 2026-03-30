import type { PromptConfig } from '../types/prompt.js';

export interface SidebarSelectionState {
	selectedId: string | null;
	selectedPromptUuid: string | null;
}

export interface SidebarDeletionState extends SidebarSelectionState {
	showOptimisticNewPrompt: boolean;
	optimisticBaselineIds: string[] | null;
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
		optimisticBaselineIds: shouldClearOptimisticNewPrompt ? null : state.optimisticBaselineIds,
		selectedId: shouldClearSelection ? null : state.selectedId,
		selectedPromptUuid: shouldClearSelection ? null : state.selectedPromptUuid,
	};
}

export function reconcileSidebarSelection(
	prompts: PromptConfig[],
	selection: SidebarSelectionState,
): SidebarSelectionState {
	const selectedId = (selection.selectedId || '').trim() || null;
	const selectedPromptUuid = (selection.selectedPromptUuid || '').trim() || null;

	if (selectedId === '__new__') {
		return {
			selectedId,
			selectedPromptUuid,
		};
	}

	if (selectedPromptUuid) {
		const matchingPrompt = prompts.find(prompt => (prompt.promptUuid || '').trim() === selectedPromptUuid);
		if (matchingPrompt) {
			return {
				selectedId: matchingPrompt.id,
				selectedPromptUuid: (matchingPrompt.promptUuid || '').trim() || null,
			};
		}

		return {
			selectedId: null,
			selectedPromptUuid: null,
		};
	}

	if (selectedId) {
		const matchingPrompt = prompts.find(prompt => prompt.id === selectedId);
		if (matchingPrompt) {
			return {
				selectedId: matchingPrompt.id,
				selectedPromptUuid: (matchingPrompt.promptUuid || '').trim() || null,
			};
		}

		return {
			selectedId: null,
			selectedPromptUuid: null,
		};
	}

	return {
		selectedId: null,
		selectedPromptUuid: null,
	};
}