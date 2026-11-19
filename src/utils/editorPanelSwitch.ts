export type PromptEditorPanelSwitchStrategy = 'noop' | 'reuse' | 'create';

export function resolvePromptEditorPanelSwitchStrategy(input: {
	hasReusableSingletonPanel: boolean;
	currentPromptId?: string | null;
	currentPromptUuid?: string | null;
	nextPromptId?: string | null;
	nextPromptUuid?: string | null;
}): PromptEditorPanelSwitchStrategy {
	if (!input.hasReusableSingletonPanel) {
		return 'create';
	}

	const currentPromptId = (input.currentPromptId || '').trim();
	const nextPromptId = (input.nextPromptId || '').trim();
	const matchesUuid = !input.nextPromptUuid || input.currentPromptUuid === input.nextPromptUuid;
	if (currentPromptId && currentPromptId === nextPromptId && matchesUuid) {
		return 'noop';
	}

	return 'reuse';
}