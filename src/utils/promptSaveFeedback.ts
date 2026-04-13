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
	const normalizedSavedPromptId = (savedPromptId || '').trim();
	const normalizedLivePromptId = (livePromptId || '').trim();
	const normalizedPreviousPromptId = (previousPromptId || '').trim();

	const uuidMatch = Boolean(normalizedSavedPromptUuid && normalizedLivePromptUuid && normalizedSavedPromptUuid === normalizedLivePromptUuid);

	/** Новый промпт (ещё нет id/директории) — совпадение определяется только по UUID */
	if (!normalizedLivePromptId) {
		if (uuidMatch) {
			return true;
		}
		/** UUID не совпали или отсутствуют — отклоняем для безопасности */
		return false;
	}

	const idMatch = normalizedLivePromptId === normalizedSavedPromptId
		|| Boolean(normalizedPreviousPromptId && normalizedLivePromptId === normalizedPreviousPromptId);

	/**
	 * Существующий промпт: если оба UUID доступны — требуем совпадение И uuid, И id/path.
	 * Это предотвращает применение результата при совпадении UUID, но расхождении папки.
	 */
	if (normalizedSavedPromptUuid && normalizedLivePromptUuid) {
		return uuidMatch && idMatch;
	}

	/** Нет UUID (легаси) — используем только сопоставление по id/path */
	return idMatch;
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