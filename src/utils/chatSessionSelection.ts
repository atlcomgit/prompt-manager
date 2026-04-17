/** Choose the safest bound chat session to open from the currently validated session ids. */
export function resolveBoundChatSessionToOpen(
	requestedSessionId: string | undefined,
	availableSessionIds: string[],
): string {
	const normalizedRequestedSessionId = String(requestedSessionId || '').trim();
	const normalizedAvailableSessionIds = availableSessionIds
		.map(sessionId => String(sessionId || '').trim())
		.filter(Boolean);

	if (normalizedRequestedSessionId && normalizedAvailableSessionIds.includes(normalizedRequestedSessionId)) {
		return normalizedRequestedSessionId;
	}

	return normalizedAvailableSessionIds[0] || '';
}