export const DEFAULT_COPILOT_MODEL_FAMILY = 'gpt-5-mini';

/**
 * Sentinel value for the prompt `AI Models` field meaning "do not change the model already
 * selected in the chat". When a prompt stores this value, starting a chat must skip applying
 * any model so VS Code keeps whatever model is currently active in the chat.
 */
export const KEEP_CURRENT_CHAT_MODEL = 'keep-current-model';

/** Return true when the value is the "do not change the chat model" sentinel. */
export function isKeepCurrentChatModel(value: string | undefined | null): boolean {
	return String(value || '').trim() === KEEP_CURRENT_CHAT_MODEL;
}

const EXPLICIT_COPILOT_MODEL_PATTERN = /(gpt-[\w.-]+|o[1-9][\w.-]*|claude-[\w.-]+|gemini-[\w.-]+|grok-[\w.-]+)/i;

/** Return true when a saved picker value belongs to the GitHub Copilot Chat provider. */
export function isCopilotModelIdentifier(value: string | undefined | null): boolean {
	const normalized = String(value || '').trim().toLowerCase();
	if (!normalized) {
		return false;
	}

	if (normalized.includes('/')) {
		return normalized.split('/').filter(Boolean)[0] === 'copilot';
	}

	return EXPLICIT_COPILOT_MODEL_PATTERN.test(normalized);
}

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

	if (!isCopilotModelIdentifier(normalized)) {
		return '';
	}

	const explicitMatch = normalized.match(EXPLICIT_COPILOT_MODEL_PATTERN);
	if (explicitMatch?.[1]) {
		return explicitMatch[1].toLowerCase();
	}

	return '';
}
