import { limitPercent } from './limitDisplay.js';

/** Самый высокий уровень предупреждения среди действующих квот. */
export type QuotaHighlightLevel = 'none' | 'warning' | 'critical';

/** Определяет цвет по израсходованной доле независимо от отображения процента. Тест: quotaHighlight.test.ts. */
export function resolveQuotaHighlight(
    windows: readonly { remainingPercent?: number | null; usedPercent?: number | null; resetsAt?: number | null }[],
    now = Date.now(),
): QuotaHighlightLevel {
    let level: QuotaHighlightLevel = 'none';
    for (const window of windows) {
        if (window.resetsAt && window.resetsAt * 1000 <= now) continue;
        const percent = limitPercent(window, 'used');
        if (percent === null) continue;
        if (percent >= 90) return 'critical';
        if (percent >= 60) level = 'warning';
    }
    return level;
}
