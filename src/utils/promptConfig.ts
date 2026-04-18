import type { PromptConfig } from '../types/prompt.js';
import { createDefaultPrompt } from '../types/prompt.js';

export interface NormalizedStoredPromptConfigResult {
	config: PromptConfig;
	shouldBackfillPromptUuid: boolean;
}

function normalizeTrackedBranchesByProject(value: unknown): Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}

	const result: Record<string, string> = {};
	for (const [project, branch] of Object.entries(value as Record<string, unknown>)) {
		const normalizedProject = project.trim();
		const normalizedBranch = typeof branch === 'string' ? branch.trim() : '';
		if (!normalizedProject || !normalizedBranch) {
			continue;
		}
		result[normalizedProject] = normalizedBranch;
	}

	return result;
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
		trackedBranchesByProject: normalizeTrackedBranchesByProject(parsed.trackedBranchesByProject),
		timeSpentOnTask: typeof parsed.timeSpentOnTask === 'number' ? parsed.timeSpentOnTask : 0,
		timeSpentUntracked: typeof parsed.timeSpentUntracked === 'number' ? parsed.timeSpentUntracked : 0,
		customGroupIds: Array.isArray(parsed.customGroupIds)
			? Array.from(new Set(
				parsed.customGroupIds
					.filter((value): value is string => typeof value === 'string')
					.map(value => value.trim())
					.filter(value => value.length > 0),
			))
			: [],
	};

	return {
		config,
		shouldBackfillPromptUuid: promptUuid !== rawPromptUuid,
	};
}
