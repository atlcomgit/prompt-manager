import type { Prompt, PromptConfig } from '../types/prompt.js';

export const PROMPT_CONFIG_SYNC_FIELDS = [
	'title',
	'description',
	'status',
	'favorite',
	'projects',
	'languages',
	'frameworks',
	'skills',
	'mcpTools',
	'hooks',
	'taskNumber',
	'branch',
	'trackedBranch',
	'trackedBranchesByProject',
	'model',
	'chatMode',
	'contextFiles',
	'httpExamples',
	'timeSpentUntracked',
	'notes',
] as const;

export type PromptConfigSyncField = typeof PROMPT_CONFIG_SYNC_FIELDS[number];

export type PromptConfigFieldChangedAt = Partial<Record<PromptConfigSyncField, number>>;

type PromptConfigComparable = Pick<Prompt, PromptConfigSyncField> | Pick<PromptConfig, PromptConfigSyncField>;

function cloneFieldValue(field: PromptConfigSyncField, value: unknown): unknown {
	if (Array.isArray(value)) {
		return [...value];
	}

	if (field === 'trackedBranchesByProject') {
		const normalizedValue = value && typeof value === 'object' ? value : {};
		return { ...normalizedValue };
	}

	return value;
}

function areFieldValuesEqual(left: unknown, right: unknown): boolean {
	if (Array.isArray(left) && Array.isArray(right)) {
		return JSON.stringify(left) === JSON.stringify(right);
	}

	if (left && right && typeof left === 'object' && typeof right === 'object') {
		return JSON.stringify(left) === JSON.stringify(right);
	}

	return left === right;
}

export function diffPromptConfigSyncFields(
	previous: PromptConfigComparable,
	next: PromptConfigComparable,
): PromptConfigSyncField[] {
	const changedFields: PromptConfigSyncField[] = [];

	for (const field of PROMPT_CONFIG_SYNC_FIELDS) {
		if (!areFieldValuesEqual(previous[field], next[field])) {
			changedFields.push(field);
		}
	}

	return changedFields;
}

export function applyPromptConfigSnapshotToPrompt(
	prompt: Prompt,
	config: Prompt | PromptConfig,
): Prompt {
	const nextPrompt = { ...prompt };
	const nextPromptRecord = nextPrompt as unknown as Record<string, unknown>;
	const configRecord = config as unknown as Record<string, unknown>;

	for (const field of PROMPT_CONFIG_SYNC_FIELDS) {
		nextPromptRecord[field] = cloneFieldValue(field, configRecord[field]);
	}

	nextPrompt.updatedAt = config.updatedAt;

	return nextPrompt;
}

export function normalizePromptExternalChangedAt(updatedAt?: string, fileMtimeMs?: number | null): number | null {
	const normalizedUpdatedAt = (updatedAt || '').trim();
	if (normalizedUpdatedAt) {
		const parsed = Date.parse(normalizedUpdatedAt);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	if (typeof fileMtimeMs === 'number' && Number.isFinite(fileMtimeMs) && fileMtimeMs > 0) {
		return fileMtimeMs;
	}

	return null;
}

export function mergePromptExternalConfig(
	currentPrompt: Prompt,
	externalPrompt: Prompt,
	localFieldChangedAt: PromptConfigFieldChangedAt,
	externalChangedAt: number | null,
): {
	mergedPrompt: Prompt;
	appliedExternalFields: PromptConfigSyncField[];
	preservedLocalFields: PromptConfigSyncField[];
	hasChanges: boolean;
} {
	const mergedPrompt = {
		...currentPrompt,
		updatedAt: externalPrompt.updatedAt,
	} satisfies Prompt;
	const mergedPromptRecord = mergedPrompt as unknown as Record<string, unknown>;
	const currentPromptRecord = currentPrompt as unknown as Record<string, unknown>;
	const externalPromptRecord = externalPrompt as unknown as Record<string, unknown>;
	const appliedExternalFields: PromptConfigSyncField[] = [];
	const preservedLocalFields: PromptConfigSyncField[] = [];

	for (const field of PROMPT_CONFIG_SYNC_FIELDS) {
		const localChangedAt = localFieldChangedAt[field];
		const shouldPreserveLocalValue = typeof localChangedAt === 'number'
			&& Number.isFinite(localChangedAt)
			&& (externalChangedAt === null || localChangedAt > externalChangedAt);

		if (shouldPreserveLocalValue) {
			preservedLocalFields.push(field);
			mergedPromptRecord[field] = cloneFieldValue(field, currentPromptRecord[field]);
			continue;
		}

		mergedPromptRecord[field] = cloneFieldValue(field, externalPromptRecord[field]);
		if (!areFieldValuesEqual(currentPromptRecord[field], externalPromptRecord[field])) {
			appliedExternalFields.push(field);
		}
	}

	return {
		mergedPrompt,
		appliedExternalFields,
		preservedLocalFields,
		hasChanges: diffPromptConfigSyncFields(currentPrompt, mergedPrompt).length > 0 || currentPrompt.updatedAt !== mergedPrompt.updatedAt,
	};
}