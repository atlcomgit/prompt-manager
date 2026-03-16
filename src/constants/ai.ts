export const DEFAULT_COPILOT_MODEL_FAMILY = 'gpt-5-mini';

const EXPLICIT_COPILOT_MODEL_PATTERN = /(gpt-[\w.-]+|o[1-9][\w.-]*|claude-[\w.-]+|gemini-[\w.-]+|grok-[\w.-]+)/i;

export function isZeroCostCopilotModelPickerCategory(category: {
	label?: string;
	order?: number | null;
} | undefined | null): boolean {
	const label = String(category?.label || '').trim().toLowerCase();
	const order = typeof category?.order === 'number' && Number.isFinite(category.order)
		? category.order
		: undefined;

	if (label.includes('premium') || label.includes('премиум')) {
		return false;
	}

	if (
		label.includes('standard')
		|| label.includes('стандарт')
		|| label.includes('included')
		|| label.includes('включ')
		|| label.includes('free')
		|| label.includes('бесплат')
	) {
		return true;
	}

	if (order !== undefined) {
		return order <= 0;
	}

	return false;
}

export function normalizeCopilotModelFamily(value: string | undefined | null): string {
	const normalized = String(value || '').trim();
	if (!normalized) {
		return DEFAULT_COPILOT_MODEL_FAMILY;
	}

	const explicitMatch = normalized.match(EXPLICIT_COPILOT_MODEL_PATTERN);
	if (explicitMatch?.[1]) {
		return explicitMatch[1].toLowerCase();
	}

	const tail = normalized.includes('/')
		? normalized.split('/').filter(Boolean).pop() || ''
		: normalized;
	const compact = tail.trim().toLowerCase();
	return compact || DEFAULT_COPILOT_MODEL_FAMILY;
}

export function normalizeOptionalCopilotModelFamily(value: string | undefined | null): string {
	const normalized = String(value || '').trim();
	if (!normalized) {
		return '';
	}

	const explicitMatch = normalized.match(EXPLICIT_COPILOT_MODEL_PATTERN);
	if (explicitMatch?.[1]) {
		return explicitMatch[1].toLowerCase();
	}

	return '';
}
