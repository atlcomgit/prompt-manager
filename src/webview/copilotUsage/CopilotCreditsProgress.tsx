import React from 'react';
import type { CopilotCreditsSnapshot } from '../../utils/copilotCredits.js';
import { formatTimeUntilReset } from '../../utils/resetCountdown.js';

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
 * Полоса премиум-кредитов GitHub Copilot: заполнение — использованные кредиты (как в штатной строке «Credits»),
 * а не остаток. Во время переключения аккаунта прежние проценты скрываются. Проверка — tests/copilotCredits.test.tsx.
 */
export function CopilotCreditsProgress({ credits, switching, now = Date.now() }: {
    credits: CopilotCreditsSnapshot | null;
    switching: boolean;
    now?: number;
}): React.ReactElement {
    const resetDate = credits ? formatResetDate(credits.resetAt) : null;
    const expired = credits?.resetAt ? Date.parse(credits.resetAt) <= now : !!credits?.expired;
    const countdown = credits?.resetAt ? formatTimeUntilReset(credits.resetAt, now) : null;
    const available = !switching && !!credits && !expired;
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
                            {credits.usedPercent}%
                        </strong>
                        <span style={muted}>использовано</span>
                    </div>
                    <div
                        role="progressbar"
                        aria-label="Использование кредитов GitHub Copilot"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.min(100, credits.usedPercent)}
                        aria-valuetext={credits.usedPercent + '% использовано'}
                        style={{
                            background: 'var(--vscode-panel-border)',
                            height: 7, borderRadius: 6, marginTop: 10, overflow: 'hidden',
                        }}
                    >
                        <div style={{
                            height: '100%',
                            width: Math.min(100, credits.usedPercent) + '%',
                            background: 'var(--vscode-progressBar-background)',
                            minWidth: credits.usedPercent === 0 ? 2 : undefined,
                        }} />
                    </div>
                    <div style={{ ...muted, marginTop: 8 }}>
                        {credits.used} из {credits.limit} кредитов
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
