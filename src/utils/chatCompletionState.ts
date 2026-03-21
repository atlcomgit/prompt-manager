export const COMPLETED_CHAT_RESPONSE_STATE = 1;
export const FALLBACK_COMPLETION_QUIET_PERIOD_MS = 8000;

export interface ChatCompletionSnapshot {
	sessionId?: string;
	lastRequestStarted: number;
	lastRequestEnded: number;
	lastResponseState?: number;
	hasPendingEdits?: boolean;
}

export interface StableChatCompletionCandidate extends ChatCompletionSnapshot {
	observedAtMs: number;
}

export function isCompletedChatResponse(snapshot: ChatCompletionSnapshot): boolean {
	return snapshot.lastRequestEnded > snapshot.lastRequestStarted
		&& !snapshot.hasPendingEdits;
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
	const hasExplicitCompletedState = Number(snapshot.lastResponseState ?? -1) === COMPLETED_CHAT_RESPONSE_STATE;
	const requiredStableForMs = hasExplicitCompletedState ? stableForMs : fallbackStableForMs;

	return {
		completed: stableForCurrentCandidate >= requiredStableForMs,
		candidate: previousCandidate,
	};
}