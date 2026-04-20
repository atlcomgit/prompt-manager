import { PROMPT_STATUS_ORDER, type PromptStatus } from '../../types/prompt';

export type PromptStatusTranslate = (key: string) => string;

export interface PromptStatusOption {
	value: PromptStatus;
	label: string;
	icon: string;
	color: string;
}

/** Shared status icons used across prompt-manager webviews. */
export const PROMPT_STATUS_ICONS: Record<PromptStatus, string> = {
	'draft': '📝',
	'in-progress': '🚀',
	'stopped': '▣',
	'cancelled': '❌',
	'completed': '✅',
	'report': '🧾',
	'review': '🔎',
	'closed': '🔒',
};

/** Shared status colors aligned with the prompt list contract. */
export const PROMPT_STATUS_COLORS: Record<PromptStatus, string> = {
	'draft': 'var(--vscode-descriptionForeground)',
	'in-progress': 'var(--vscode-editorInfo-foreground, #3794ff)',
	'stopped': 'var(--vscode-editorWarning-foreground, #cca700)',
	'cancelled': 'var(--vscode-errorForeground, #f44747)',
	'completed': 'var(--vscode-testing-iconPassed, #73c991)',
	'report': 'var(--vscode-textLink-foreground)',
	'review': 'var(--vscode-editorWarning-foreground, #cca700)',
	'closed': 'var(--vscode-disabledForeground)',
};

/** Maps a prompt status to the shared translation key. */
export function getPromptStatusTranslationKey(status: PromptStatus): string {
	switch (status) {
		case 'draft':
			return 'status.draft';
		case 'in-progress':
			return 'status.inProgress';
		case 'stopped':
			return 'status.stopped';
		case 'cancelled':
			return 'status.cancelled';
		case 'completed':
			return 'status.completed';
		case 'report':
			return 'status.report';
		case 'review':
			return 'status.review';
		case 'closed':
			return 'status.closed';
	}
}

/** Resolves the localized prompt status label. */
export function getPromptStatusLabel(status: PromptStatus, t: PromptStatusTranslate): string {
	return t(getPromptStatusTranslationKey(status));
}

/** Resolves the shared color used to present a prompt status. */
export function getPromptStatusColor(status: PromptStatus): string {
	return PROMPT_STATUS_COLORS[status];
}

/** Builds localized status options for selector-style controls. */
export function buildPromptStatusOptions(t: PromptStatusTranslate): PromptStatusOption[] {
	return PROMPT_STATUS_ORDER.map(status => ({
		value: status,
		label: getPromptStatusLabel(status, t),
		icon: PROMPT_STATUS_ICONS[status],
		color: PROMPT_STATUS_COLORS[status],
	}));
}