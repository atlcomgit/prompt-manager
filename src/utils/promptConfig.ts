import type { PromptConfig } from '../types/prompt.js';
import { createDefaultPrompt } from '../types/prompt.js';

export interface NormalizedStoredPromptConfigResult {
	config: PromptConfig;
	shouldBackfillPromptUuid: boolean;
}

export function normalizeStoredPromptConfig(
	id: string,
	parsed: Partial<PromptConfig>,
	createPromptUuid: () => string,
): NormalizedStoredPromptConfigResult {
	const defaults = createDefaultPrompt(id);
	const rawPromptUuid = typeof parsed.promptUuid === 'string' ? parsed.promptUuid : '';
	const normalizedPromptUuid = rawPromptUuid.trim();
	const promptUuid = normalizedPromptUuid || createPromptUuid();

	const config: PromptConfig = {
		...defaults,
		...parsed,
		id,
		promptUuid,
		timeSpentOnTask: typeof parsed.timeSpentOnTask === 'number' ? parsed.timeSpentOnTask : 0,
		timeSpentUntracked: typeof parsed.timeSpentUntracked === 'number' ? parsed.timeSpentUntracked : 0,
	};

	return {
		config,
		shouldBackfillPromptUuid: promptUuid !== rawPromptUuid,
	};
}
