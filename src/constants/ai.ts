export const DEFAULT_COPILOT_MODEL_FAMILY = 'gpt-5-mini';

export function normalizeCopilotModelFamily(value: string | undefined | null): string {
	const normalized = String(value || '').trim();
	return normalized || DEFAULT_COPILOT_MODEL_FAMILY;
}