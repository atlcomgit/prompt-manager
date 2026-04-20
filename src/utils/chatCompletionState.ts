export const COMPLETED_CHAT_RESPONSE_STATE = 1;
export const COMPLETED_CHAT_MODEL_STATE = 3;
export const FALLBACK_COMPLETION_QUIET_PERIOD_MS = 8000;

export interface ChatCompletionSnapshot {
	sessionId?: string;
	lastRequestStarted: number;
	lastRequestEnded: number;
	lastResponseState?: number;
	requestModelState?: number;
	hasRequestResult?: boolean;
	hasPendingEdits?: boolean;
}

export interface StableChatCompletionCandidate extends ChatCompletionSnapshot {
	observedAtMs: number;
}

function hasLegacyCompletedResponseState(snapshot: ChatCompletionSnapshot): boolean {
	// Older VS Code/Copilot builds exposed terminal completion only through lastResponseState.
	if (snapshot.hasRequestResult === false) {
		return false;
	}
	if (snapshot.requestModelState !== undefined) {
		return false;
	}
	const responseState = Number(snapshot.lastResponseState ?? -1);
	return responseState === COMPLETED_CHAT_RESPONSE_STATE
		|| responseState === COMPLETED_CHAT_MODEL_STATE;
}

function hasTerminalChatRequest(snapshot: ChatCompletionSnapshot): boolean {
	if (snapshot.hasRequestResult === true) {
		return true;
	}
	if (Number(snapshot.requestModelState ?? -1) === COMPLETED_CHAT_MODEL_STATE) {
		return true;
	}
	return hasLegacyCompletedResponseState(snapshot);
}

export function isCompletedChatResponse(snapshot: ChatCompletionSnapshot): boolean {
	return snapshot.lastRequestEnded > snapshot.lastRequestStarted
		&& !snapshot.hasPendingEdits
		&& hasTerminalChatRequest(snapshot);
}

export function observeStableChatCompletion(
	previousCandidate: StableChatCompletionCandidate | null,
	snapshot: ChatCompletionSnapshot,
	observedAtMs: number,
	stableForMs: number,
	fallbackStableForMs: number = FALLBACK_COMPLETION_QUIET_PERIOD_MS,
): { completed: boolean; candidate: StableChatCompletionCandidate | null } {
	if (!isCompletedChatResponse(snapshot)) {
		return { completed: false, candidate: null };
	}

	const isSameCandidate = previousCandidate
		&& (previousCandidate.sessionId || '') === (snapshot.sessionId || '')
		&& previousCandidate.lastRequestStarted === snapshot.lastRequestStarted
		&& previousCandidate.lastRequestEnded === snapshot.lastRequestEnded
		&& Number(previousCandidate.lastResponseState ?? -1) === Number(snapshot.lastResponseState ?? -1)
		&& Number(previousCandidate.requestModelState ?? -1) === Number(snapshot.requestModelState ?? -1)
		&& Boolean(previousCandidate.hasRequestResult) === Boolean(snapshot.hasRequestResult)
		&& Boolean(previousCandidate.hasPendingEdits) === Boolean(snapshot.hasPendingEdits);

	if (!isSameCandidate) {
		return {
			completed: false,
			candidate: {
				...snapshot,
				observedAtMs,
			},
		};
	}

	const stableForCurrentCandidate = observedAtMs - previousCandidate.observedAtMs;
	const hasExplicitCompletedState = hasTerminalChatRequest(snapshot);
	const requiredStableForMs = hasExplicitCompletedState ? stableForMs : fallbackStableForMs;

	return {
		completed: stableForCurrentCandidate >= requiredStableForMs,
		candidate: previousCandidate,
	};
}