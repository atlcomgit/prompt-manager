import type { PromptConfig } from '../types/prompt.js';

export interface SidebarSelectionState {
	selectedId: string | null;
	selectedPromptUuid: string | null;
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