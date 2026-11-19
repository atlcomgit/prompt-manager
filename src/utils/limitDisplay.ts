/** Общий режим представления квот Codex, Claude Code и GitHub Copilot. */
export type LimitDisplayMode = 'used' | 'remaining';

export function normalizeLimitDisplayMode(value: unknown): LimitDisplayMode {
    return value === 'remaining' ? 'remaining' : 'used';
}

/**
 * A new Webview can connect to an old Extension Host when its bundle was replaced
 * on disk but the existing host process was not restarted. Old hosts do not send
 * limitDisplayMode and still render remaining quotas in their status bars.
 * Never claim "Used" is selected in that case.
 */
export function resolveAccountsBackendMode(value: unknown): {
    mode: LimitDisplayMode;
    supported: boolean;
} {
    if (value === 'used' || value === 'remaining') return { mode: value, supported: true };
    return { mode: 'remaining', supported: false };
}

export function limitDisplayShortLabel(mode: LimitDisplayMode): string {
    return mode === 'used' ? 'исп.' : 'ост.';
}


/** Показанный процент всегда относится к выбранному режиму; квота ограничена диапазоном 0–100%. */
export function limitPercent(
    values: { remainingPercent?: number | null; usedPercent?: number | null },
    mode: LimitDisplayMode,
): number | null {
    const remaining = typeof values.remainingPercent === 'number' && Number.isFinite(values.remainingPercent)
        ? values.remainingPercent
        : typeof values.usedPercent === 'number' && Number.isFinite(values.usedPercent)
            ? 100 - values.usedPercent
            : null;
    if (remaining === null) return null;
    const safeRemaining = Math.min(100, Math.max(0, remaining));
    return mode === 'used' ? 100 - safeRemaining : safeRemaining;
}

export function limitDisplayVerb(mode: LimitDisplayMode): string {
    return mode === 'used' ? 'использовано' : 'осталось';
}

/** Copilot может выходить за месячный лимит: used может превышать 100, remaining не бывает отрицательным. */
export function copilotCreditsForMode(
    credits: { used: number; limit: number; usedPercent: number },
    mode: LimitDisplayMode,
): { percent: number; count: number; label: string } {
    if (mode === 'used') {
        return { percent: credits.usedPercent, count: credits.used, label: 'использовано' };
    }
    return {
        percent: Math.max(0, 100 - credits.usedPercent),
        count: Math.max(0, credits.limit - credits.used),
        label: 'осталось',
    };
}
