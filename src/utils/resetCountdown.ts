/** Форматирует оставшееся время до сброса лимита в днях/часах и при необходимости минутах. */
export function formatTimeUntilReset(
    value: number | string | null | undefined,
    now: number = Date.now(),
): string | null {
    if (value === null || value === undefined || value === '') return null;
    // Codex / Claude: Unix seconds; Copilot: ISO 8601.
    const target = typeof value === 'number' ? value * 1000 : Date.parse(value);
    if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(now)) return null;
    const delta = target - now;
    if (delta <= 0) return 'сброс уже наступил';
    const wholeMinutes = Math.floor(delta / 60_000);
    if (wholeMinutes < 1) return 'менее 1 мин';
    const days = Math.floor(wholeMinutes / 1440);
    const hours = Math.floor((wholeMinutes % 1440) / 60);
    const minutes = wholeMinutes % 60;
    if (days >= 1) return days + ' д ' + hours + ' ч';
    if (hours >= 1) return hours + ' ч ' + minutes + ' мин';
    return minutes + ' мин';
}
