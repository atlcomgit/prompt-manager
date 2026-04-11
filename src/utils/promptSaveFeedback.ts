export function shouldApplyPromptAiEnrichmentState(
	promptId: string | null | undefined,
	promptUuid: string | null | undefined,
	currentPromptId?: string | null,
	currentPromptUuid?: string | null,
	activeSaveId?: string | null,
): boolean {
	const normalizedPromptUuid = (promptUuid || '').trim();
	const normalizedCurrentPromptUuid = (currentPromptUuid || '').trim();
	if (normalizedPromptUuid && normalizedCurrentPromptUuid && normalizedPromptUuid === normalizedCurrentPromptUuid) {
		return true;
	}

	const normalizedPromptId = (promptId || '').trim();
	if (!normalizedPromptId) {
		return false;
	}

	const normalizedCurrentPromptId = (currentPromptId || '').trim();
	const normalizedActiveSaveId = (activeSaveId || '').trim();

	return normalizedPromptId === normalizedCurrentPromptId
		|| normalizedPromptId === normalizedActiveSaveId;
}

export function shouldApplyPromptSaveResult(
	promptId: string | null | undefined,
	promptUuid: string | null | undefined,
	previousPromptId?: string | null,
	currentPromptId?: string | null,
	currentPromptUuid?: string | null,
	activeSaveId?: string | null,
): boolean {
	const normalizedPromptUuid = (promptUuid || '').trim();
	const normalizedCurrentPromptUuid = (currentPromptUuid || '').trim();
	if (normalizedPromptUuid && normalizedCurrentPromptUuid && normalizedPromptUuid === normalizedCurrentPromptUuid) {
		return true;
	}

	const normalizedPromptId = (promptId || '').trim();
	const normalizedPreviousPromptId = (previousPromptId || '').trim();
	const normalizedCurrentPromptId = (currentPromptId || '').trim();
	const normalizedActiveSaveId = (activeSaveId || '').trim();

	return Boolean(
		(normalizedPromptId && normalizedPromptId === normalizedCurrentPromptId)
		|| (normalizedPreviousPromptId && normalizedPreviousPromptId === normalizedCurrentPromptId)
		|| (normalizedActiveSaveId && normalizedPromptId === normalizedActiveSaveId)
		|| (normalizedActiveSaveId && normalizedPreviousPromptId === normalizedActiveSaveId),
	);
}

export function shouldApplySavedPromptToPanel(
	savedPromptId: string | null | undefined,
	savedPromptUuid: string | null | undefined,
	livePromptId?: string | null,
	livePromptUuid?: string | null,
	previousPromptId?: string | null,
): boolean {
	const normalizedSavedPromptUuid = (savedPromptUuid || '').trim();
	const normalizedLivePromptUuid = (livePromptUuid || '').trim();
	if (normalizedSavedPromptUuid && normalizedLivePromptUuid && normalizedSavedPromptUuid === normalizedLivePromptUuid) {
		return true;
	}

	const normalizedLivePromptId = (livePromptId || '').trim();
	if (!normalizedLivePromptId) {
		return true;
	}

	const normalizedSavedPromptId = (savedPromptId || '').trim();
	const normalizedPreviousPromptId = (previousPromptId || '').trim();

	return normalizedLivePromptId === normalizedSavedPromptId
		|| Boolean(normalizedPreviousPromptId && normalizedLivePromptId === normalizedPreviousPromptId);
}

export function shouldNotifyReservedArchiveRename(
	requestedIdBase: string | null | undefined,
	savedId: string | null | undefined,
	previousId?: string | null,
): boolean {
	const normalizedRequestedIdBase = (requestedIdBase || '').trim();
	if (normalizedRequestedIdBase !== 'archive') {
		return false;
	}

	const normalizedSavedId = (savedId || '').trim();
	const normalizedPreviousId = (previousId || '').trim();
	return Boolean(normalizedSavedId) && normalizedSavedId !== normalizedPreviousId;
}

export function buildReservedArchiveRenameNotice(savedId: string, locale: 'en' | 'ru'): string {
	const normalizedSavedId = savedId.trim();
	if (locale === 'ru') {
		return `Имя папки "archive" зарезервировано для архивации в Трекере. Промпт сохранён как "${normalizedSavedId}".`;
	}

	return `The folder name "archive" is reserved for Tracker archiving. The prompt was saved as "${normalizedSavedId}".`;
}