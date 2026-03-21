export type PromptHookPhase = 'beforeChat' | 'afterChat' | 'chatError' | 'afterChatCompleted';

const START_TOKENS = [
	'before',
	'start',
	'session-start',
	'agent-start',
	'chat-start',
	'prompt-submitted',
];

const COMPLETION_TOKENS = [
	'after',
	'finish',
	'finished',
	'complete',
	'completed',
	'success',
	'session-end',
	'agent-stop',
	'chat-completed',
	'telegram',
];

const ERROR_TOKENS = [
	'error',
	'failed',
	'failure',
	'stopped',
	'cancelled',
	'canceled',
];

function normalizeHookId(hookId: string): string {
	return hookId
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function hasHookToken(normalizedHookId: string, token: string): boolean {
	return normalizedHookId === token
		|| normalizedHookId.startsWith(`${token}-`)
		|| normalizedHookId.endsWith(`-${token}`)
		|| normalizedHookId.includes(`-${token}-`);
}

function matchesAnyToken(normalizedHookId: string, tokens: string[]): boolean {
	return tokens.some(token => hasHookToken(normalizedHookId, token));
}

export function resolvePromptHookPhases(hookId: string): PromptHookPhase[] {
	const normalizedHookId = normalizeHookId(hookId);
	if (!normalizedHookId) {
		return [];
	}

	if (matchesAnyToken(normalizedHookId, ERROR_TOKENS)) {
		return ['chatError'];
	}

	const phases = new Set<PromptHookPhase>();
	if (matchesAnyToken(normalizedHookId, START_TOKENS)) {
		phases.add('beforeChat');
	}
	if (matchesAnyToken(normalizedHookId, COMPLETION_TOKENS)) {
		phases.add('afterChatCompleted');
	}

	if (phases.size === 0) {
		return ['beforeChat', 'afterChat', 'chatError', 'afterChatCompleted'];
	}

	return Array.from(phases);
}

export function shouldRunPromptHookInPhase(hookId: string, phase: PromptHookPhase): boolean {
	return resolvePromptHookPhases(hookId).includes(phase);
}

export function filterPromptHookIdsForPhase(hookIds: string[], phase: PromptHookPhase): string[] {
	return hookIds.filter(hookId => shouldRunPromptHookInPhase(hookId, phase));
}