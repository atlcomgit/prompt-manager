/**
 * Отображение кредитов GitHub Copilot на странице «Аккаунты».
 * Использует существующий CopilotUsageService; новых API-запросов не делает.
 */
import type { CopilotUsageData } from '../services/copilotUsageService.js';

/** Данные полосы кредитов Copilot для webview; проверки — tests/copilotCredits.test.tsx. */
export interface CopilotCreditsSnapshot {
	/** Использовано и доступно кредитов за текущий период, процент использования без отрицательных значений. */
	used: number;
	limit: number;
	usedPercent: number;
	/** Расчётное начало следующего месячного периода (ISO) и время последнего обновления данных. */
	resetAt: string | null;
	updatedAt: string | null;
	planType: string;
	source: CopilotUsageData['source'];
	/** Данные получены не из GitHub API, а локальным расчётом. */
	estimated: boolean;
	/** Данные старше 6 часов либо без времени обновления. */
	stale: boolean;
	/** Расчётный период уже закончился: прежнее использование не показывается как текущее. */
	expired: boolean;
}

/**
 * Строит снимок полосы кредитов; null — нет авторизации или корректного лимита, полоса не рисуется.
 * CopilotUsageService отдаёт конец периода как начало последнего дня месяца,
 * поэтому для отображения следующего периода вычисляем его начало по periodStart.
 * Это расчётный срок, а не время сброса, подтверждённое GitHub API.
 */
export function buildCopilotCreditsSnapshot(
	data: CopilotUsageData | null,
	now: number = Date.now(),
): CopilotCreditsSnapshot | null {
	if (!data?.authenticated || !Number.isFinite(data.limit) || data.limit <= 0
		|| !Number.isFinite(data.used) || data.used < 0) {
		return null;
	}
	const start = new Date(data.periodStart);
	let resetAt: string | null = null;
	if (Number.isFinite(start.getTime())) {
		const next = new Date(start.getFullYear(), start.getMonth() + 1, 1);
		if (Number.isFinite(next.getTime())) resetAt = next.toISOString();
	}
	const updated = new Date(data.lastUpdated);
	const updatedAt = Number.isFinite(updated.getTime()) ? updated.toISOString() : null;
	const usedPercent = Math.round((data.used / data.limit) * 100);
	return {
		used: data.used,
		limit: data.limit,
		usedPercent: Math.max(0, usedPercent),
		resetAt,
		updatedAt,
		planType: data.planType || 'unknown',
		source: data.source,
		estimated: data.source !== 'api',
		stale: updatedAt === null || now - updated.getTime() > 6 * 60 * 60 * 1000,
		expired: resetAt !== null && new Date(resetAt).getTime() <= now,
	};
}
