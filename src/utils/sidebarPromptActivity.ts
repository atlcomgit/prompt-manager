import type { PromptConfig } from '../types/prompt.js';

export interface SidebarPromptActivityTarget {
	id?: string | null;
	promptUuid?: string | null;
}

/** Resolve stable transient activity keys for prompt id and promptUuid. */
export function resolveSidebarPromptActivityKeys(target: SidebarPromptActivityTarget): string[] {
	const keys: string[] = [];
	const normalizedPromptUuid = (target.promptUuid || '').trim();
	const normalizedPromptId = (target.id || '').trim();

	if (normalizedPromptUuid) {
		keys.push(`uuid:${normalizedPromptUuid}`);
	}

	if (normalizedPromptId) {
		keys.push(`id:${normalizedPromptId}`);
	}

	return Array.from(new Set(keys));
}

/** Add or remove prompt activity keys while preserving rename-safe uuid matches. */
export function updateSidebarPromptActivityKeys(
	currentKeys: string[],
	target: SidebarPromptActivityTarget,
	isActive: boolean,
): string[] {
	const nextKeys = resolveSidebarPromptActivityKeys(target);
	if (nextKeys.length === 0) {
		return currentKeys;
	}

	if (isActive) {
		return Array.from(new Set([...currentKeys, ...nextKeys]));
	}

	const nextKeySet = new Set(nextKeys);
	return currentKeys.filter(key => !nextKeySet.has(key));
}

/** Check whether prompt has an active transient busy state in sidebar. */
export function isSidebarPromptActivityActive(
	prompt: Pick<PromptConfig, 'id' | 'promptUuid'>,
	activityKeys: string[],
): boolean {
	const promptKeys = resolveSidebarPromptActivityKeys(prompt);
	if (promptKeys.length === 0 || activityKeys.length === 0) {
		return false;
	}

	const activityKeySet = new Set(activityKeys);
	return promptKeys.some(key => activityKeySet.has(key));
}
