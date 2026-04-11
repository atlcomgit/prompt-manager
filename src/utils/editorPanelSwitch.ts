export type PromptEditorPanelSwitchStrategy = 'noop' | 'reuse' | 'create';

export function resolvePromptEditorPanelSwitchStrategy(input: {
	hasReusableSingletonPanel: boolean;
	currentPromptId?: string | null;
	nextPromptId?: string | null;
}): PromptEditorPanelSwitchStrategy {
	if (!input.hasReusableSingletonPanel) {
		return 'create';
	}

	const currentPromptId = (input.currentPromptId || '').trim();
	const nextPromptId = (input.nextPromptId || '').trim();
	if (currentPromptId && nextPromptId && currentPromptId === nextPromptId) {
		return 'noop';
	}

	return 'reuse';
}