export const DEFAULT_HISTORY_ANALYSIS_LIMIT = 500;
export const MIN_HISTORY_ANALYSIS_LIMIT = 1;

export const normalizeHistoryAnalysisLimit = (
	requestedLimit: number | undefined,
	configuredLimit = DEFAULT_HISTORY_ANALYSIS_LIMIT,
): number => {
	const candidate = requestedLimit ?? configuredLimit;

	if (!Number.isFinite(candidate)) {
		return DEFAULT_HISTORY_ANALYSIS_LIMIT;
	}

	return Math.max(MIN_HISTORY_ANALYSIS_LIMIT, Math.floor(candidate));
};