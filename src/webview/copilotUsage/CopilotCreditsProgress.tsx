import React from 'react';
import type { CopilotCreditsSnapshot } from '../../utils/copilotCredits.js';
import { formatTimeUntilReset } from '../../utils/resetCountdown.js';
import { copilotCreditsForMode, type LimitDisplayMode } from '../../utils/limitDisplay.js';

/** Приглушённый текст подписей полосы. */
const muted: React.CSSProperties = {
    color: 'var(--vscode-descriptionForeground)',
    fontSize: 12,
};

/** Дата расчётного начала следующего периода «19 нояб., 10:00»; null для пустого или некорректного значения. */
function formatResetDate(value: string | null): string | null {
    if (!value) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Полоса премиум-кредитов Copilot: проценты и заполнение зависят от глобальной настройки;
 * по умолчанию — использовано. Во время переключения аккаунта старые проценты скрываются.
 */
export function CopilotCreditsProgress({ credits, switching, now = Date.now(), mode = 'used' }: {
    credits: CopilotCreditsSnapshot | null;
    switching: boolean;
    now?: number;
    mode?: LimitDisplayMode;
}): React.ReactElement {
    const resetDate = credits ? formatResetDate(credits.resetAt) : null;
    const expired = credits?.resetAt ? Date.parse(credits.resetAt) <= now : !!credits?.expired;
    const countdown = credits?.resetAt ? formatTimeUntilReset(credits.resetAt, now) : null;
    const available = !switching && !!credits && !expired;
    const displayed = credits ? copilotCreditsForMode(credits, mode) : null;
    return (
        <div style={{ borderTop: '1px solid var(--vscode-panel-border)', marginTop: 16, paddingTop: 14 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <strong style={{ fontSize: 13 }}>Кредиты</strong>
                {resetDate && <span style={muted}>
                    {expired ? 'Предыдущий период завершился: ' : 'Ориентир возобновления: '}
                    {resetDate}
                    {!expired && countdown ? ' · осталось ' + countdown : ''}
                </span>}
            </div>
            {switching ? (
                <div style={{ ...muted, marginTop: 12 }}>Переключаем аккаунт Copilot — ждём новые данные о кредитах.</div>
            ) : available && credits ? (
                <>
                    <div style={{ display: 'flex', gap: 5, alignItems: 'baseline', marginTop: 11 }}>
                        <strong style={{ fontSize: 22, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
                            {displayed?.percent}%
                        </strong>
                        <span style={muted}>{displayed?.label}</span>
                    </div>
                    <div
                        role="progressbar"
                        aria-label={mode === 'used' ? 'Использование кредитов GitHub Copilot' : 'Остаток кредитов GitHub Copilot'}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.min(100, displayed?.percent ?? 0)}
                        aria-valuetext={(displayed?.percent ?? 0) + '% ' + (displayed?.label ?? '')}
                        style={{
                            background: 'var(--vscode-panel-border)',
                            height: 7, borderRadius: 6, marginTop: 10, overflow: 'hidden',
                        }}
                    >
                        <div style={{
                            height: '100%',
                            width: Math.min(100, displayed?.percent ?? 0) + '%',
                            background: 'var(--vscode-progressBar-background)',
                            minWidth: displayed?.percent === 0 ? 2 : undefined,
                        }} />
                    </div>
                    <div style={{ ...muted, marginTop: 8 }}>
                        {displayed?.count} из {credits.limit} кредитов {displayed?.label}
                        {credits.estimated ? ' · расчётные данные' : ' · данные GitHub'}
                        {credits.stale ? ' · последнее обновление устарело' : ''}
                    </div>
                </>
            ) : (
                <div style={{ ...muted, marginTop: 12 }}>
                    {expired
                        ? 'Период завершился. Обновите статистику для получения лимитов нового периода.'
                        : 'Данные о кредитах пока недоступны. Нажмите «Обновить».'}
                </div>
            )}
        </div>
    );
}
