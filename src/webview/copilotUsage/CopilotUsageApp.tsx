import React, { useEffect, useMemo, useState } from 'react';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';
import { CopilotCreditsProgress } from './CopilotCreditsProgress';
import { LimitDisplayToggle } from './LimitDisplayToggle';
import { limitPercent, limitDisplayVerb, resolveAccountsBackendMode, type LimitDisplayMode } from '../../utils/limitDisplay.js';
import { AccountsLoading } from './AccountsLoading';
import { AccountsPageFrame } from './AccountsPageFrame';
import { formatTimeUntilReset } from '../../utils/resetCountdown.js';
import type { CopilotCreditsSnapshot } from '../../utils/copilotCredits.js';

/** Установленные расширения: блоки страницы показываются только для них. */
type InstalledProviders = { codex: boolean; claude: boolean; copilot: boolean };
/** Сохранённый профиль Codex без данных авторизации. */
type Account = { id: string; label: string; identity: string; createdAt: string };
/** Окно лимита (5ч, 7д, модельное): процент использования и время сброса в секундах Unix. */
type LimitWindow = { label: string; usedPercent: number; remainingPercent: number; resetsAt: number | null; key?: string };
/** Лимиты активного аккаунта Codex и Claude Code; error — причина отсутствия данных. */
type CodexLimitStatus = { windows: LimitWindow[]; planType: string | null; updatedAt: string; error?: string; stale?: boolean };
type ClaudeLimitStatus = { windows: LimitWindow[]; updatedAt: string | null; stale: boolean; error?: string; source: string };
/** Данные страницы от расширения (сообщение accounts.data). */
type State = {
    installed: InstalledProviders;
    /** Absent while an older Extension Host is still running after a Tunnel Webview update. */
    limitDisplayMode?: LimitDisplayMode;
    codex: {
        profiles: Account[];
        activeId: string | null;
        pendingRestart: boolean;
        adding: boolean;
        issue: string | null;
        otherSwitcherInstalled: boolean;
        limits: CodexLimitStatus | null;
    } | null;
    claude: {
        profiles: Array<{ id: string; label: string; email: string | null; plan: string | null; loggedIn: boolean }>;
        activeId: string | null;
        pendingRestart: boolean;
        adding: boolean;
        issue: string | null;
        externalConfigDir: boolean;
        limitsByProfile: Record<string, ClaudeLimitStatus>;
    } | null;
    copilot: {
        active: string | null;
        session: string | null;
        accounts: Array<{ id: string; label: string }>;
        issue: string | null;
        switching: boolean;
        credits: CopilotCreditsSnapshot | null;
    } | null;
};

const vscode = getVsCodeApi();
/** Отправляет действие страницы расширению. */
const send = (type: string, extra: Record<string, unknown> = {}): void => vscode.postMessage({ type, ...extra });
/** Стили карточек, подписей и кнопок страницы в цветах темы VS Code. */
const card: React.CSSProperties = {
    padding: 16,
    border: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
    borderRadius: 8,
};
const muted: React.CSSProperties = { color: 'var(--vscode-descriptionForeground)', fontSize: 12 };
const button: React.CSSProperties = {
    fontFamily: 'inherit',
    fontSize: 12,
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    padding: '6px 10px',
    borderRadius: 5,
    border: '1px solid var(--vscode-button-border, var(--vscode-panel-border))',
    cursor: 'pointer',
};
const primaryButton: React.CSSProperties = {
    ...button,
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
};
const actions: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' };

/** Локальная дата и время для секунд Unix (лимиты) или строки ISO (время получения); пустая строка без значения. */
function timestamp(value: string | number | null | undefined): string {
    if (!value) return '';
    const ms = typeof value === 'number' ? value * 1000 : new Date(value).getTime();
    return Number.isFinite(ms) ? new Date(ms).toLocaleString('ru-RU') : '';
}
/** Когда придут свежие лимиты: Codex опрашивает только окно в фокусе, Claude — общая проверка /usage. */
const CODEX_STALE_HINT = 'Обновление придёт, когда это окно VS Code получит фокус, или по кнопке «Обновить».';
const CLAUDE_STALE_HINT = 'Обновление придёт со следующей проверкой /usage (раз в 5 минут) или после ответа Claude Code.';
/**
 * Окна лимитов с полосой остатка и обратным отсчётом до сброса. Устаревшие данные помечаются «≈»,
 * окно после времени сброса показывается без процентов до следующего обновления; staleHint — когда придут новые.
 */
function Limits({ windows, stale, staleHint, error, updatedAt, now, mode }: {
    windows: LimitWindow[]; stale?: boolean; staleHint: string; error?: string;
    updatedAt?: string | null; now: number; mode: LimitDisplayMode;
}): React.ReactElement {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {stale && <div style={{ ...muted, color: 'var(--vscode-editorWarning-foreground)' }}>
                Последние известные данные: после сброса лимита прежние проценты недействительны. {staleHint}
            </div>}
            {!windows.length ? (
                <div style={muted}>{error || 'Данные лимитов пока не получены.'}</div>
            ) : windows.map((w, index) => {
                const expired = w.resetsAt !== null && w.resetsAt * 1000 <= now;
                const countdown = formatTimeUntilReset(w.resetsAt, now);
                const percent = Math.round(limitPercent(w, mode) ?? 0);
                return <div key={w.key || index} style={{ opacity: stale ? 0.65 : 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 5 }}>
                        <span>{w.label}{expired ? ' · окно уже сброшено' : stale ? ' · последние известные' : ''}</span>
                        <b>{expired ? '— · ожидаем обновления'
                            : (stale ? '≈' : '') + percent + '% ' + limitDisplayVerb(mode)}</b>
                    </div>
                    {!expired && <div style={{ height: 6, borderRadius: 5, background: 'var(--vscode-panel-border)', overflow: 'hidden' }}>
                        <div style={{ width: percent + '%', height: '100%', background: 'var(--vscode-progressBar-background)' }}/>
                    </div>}
                    {!!w.resetsAt && <div style={{ ...muted, marginTop: 4 }}>
                        Сброс: {timestamp(w.resetsAt)}
                        {!expired && countdown ? ' · до сброса ' + countdown : ''}
                    </div>}
                </div>;
            })}
            {updatedAt && <div style={muted}>Получено: {timestamp(updatedAt)}</div>}
        </div>
    );
}

/** Страница «Аккаунты»: профили Codex и Claude Code, их лимиты и выбор аккаунта GitHub Copilot с полосой кредитов. */
export const CopilotUsageApp: React.FC = () => {
    const [data, setData] = useState<State | null>(null);
    const [loadingError, setLoadingError] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const [notice, setNotice] = useState<{ message: string; warning: boolean } | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const codexActive = useMemo(() => data?.codex?.profiles.find(p => p.id === data.codex?.activeId), [data]);

    useEffect(() => send('accounts.ready'), []);
    // Один таймер на страницу: обратный отсчёт обновляется раз в минуту без запросов к расширению.
    useEffect(() => {
        const handle = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(handle);
    }, []);
    useMessageListener((message: any) => {
        if (message?.type === 'accounts.data') {
            setLoadingError(null);
            setData(message.data as State);
            setBusyId(null);
        }
        if (message?.type === 'accounts.error') {
            setLoadingError(String(message.message || 'Ошибка загрузки. Попробуйте снова.'));
            // После ошибки ответа на действие не будет: кнопки снова доступны.
            setBusyId(null);
        }
        if (message?.type === 'accounts.displayMode'
            && (message.mode === 'used' || message.mode === 'remaining')) {
            setData(previous => previous ? { ...previous, limitDisplayMode: message.mode } : previous);
        }
        if (message?.type === 'accounts.result') {
            setNotice({ message: String(message.message || ''), warning: Boolean(message.warning) });
            setBusyId(null);
        }
    });

    if (!data) return <AccountsLoading error={loadingError} onRetry={() => {
        setLoadingError(null);
        send('accounts.refresh');
    }} />;

    const { codex, claude, copilot, installed } = data;
    const { mode, supported: supportsLimitDisplay } = resolveAccountsBackendMode(data.limitDisplayMode);
    const pick = (provider: string, id: string): void => {
        if (busyId) return;
        setNotice(null);
        setBusyId(provider + ':' + id);
        send(provider + '.switch', { id });
    };
    return (
        <AccountsPageFrame>
            <header style={{ display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div>
                    <h1 style={{ fontSize: 21, margin: 0 }}>Аккаунты</h1>
                    <div style={{ ...muted, marginTop: 4 }}>Показываются только установленные расширения</div>
                </div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                    <LimitDisplayToggle mode={mode} disabled={!supportsLimitDisplay}
                        onChange={next => send('accounts.setDisplayMode', { mode: next })}/>
                    <button style={button} onClick={() => { setNotice(null); send('accounts.refresh'); }}>↻ Обновить</button>
                </div>
            </header>
            {!supportsLimitDisplay && (
                <div role="alert" style={{ ...card, color: 'var(--vscode-editorWarning-foreground)' }}>
                    <b>Работает предыдущая версия Extension Host.</b>{' '}
                    Статус-бар пока показывает остаток, поэтому переключатель заблокирован.
                    После завершения задач агентов выполните в этом окне VS Code команду
                    «Developer: Reload Window» — обычное обновление страницы браузера
                    не перезапускает расширения на сервере.
                </div>
            )}
            {!!notice?.message && (
                <div role="status" style={{ ...card, color: notice.warning ? 'var(--vscode-editorWarning-foreground)' : 'var(--vscode-foreground)' }}>
                    {notice.message}
                </div>
            )}

            {installed.codex && codex && (
                <section style={card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                        <div>
                            <h2 style={{ fontSize: 17, margin: '0 0 4px' }}>Codex</h2>
                            <div style={muted}>Активный: <b>{codexActive?.label || 'не выбран'}</b></div>
                        </div>
                        <button style={primaryButton} disabled={codex.adding} onClick={() => send('codex.add')}>
                            {codex.adding ? 'Выполняется вход…' : '+ Добавить'}
                        </button>
                    </div>
                    {codex.otherSwitcherInstalled && <p style={muted}>Установлен Codex Profiles. Не используйте одновременно два переключателя авторизации.</p>}
                    {codex.issue && <p style={{ ...muted, color: 'var(--vscode-editorWarning-foreground)' }}>{codex.issue}</p>}
                    {codex.profiles.length === 0 ? (
                        <p style={muted}>Профилей нет. Добавьте ChatGPT-аккаунт.</p>
                    ) : codex.profiles.map(profile => {
                        const selected = codex.activeId === profile.id;
                        return <div key={profile.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 0', borderTop: '1px solid var(--vscode-panel-border)', flexWrap: 'wrap' }}>
                            <div>
                                <div><span style={{ marginRight: 8 }}>{selected ? '●' : '○'}</span><b>{profile.label}</b></div>
                                {selected && <div style={muted}>{codex.pendingRestart ? 'Выбран · ожидает применения' : 'Активен'}</div>}
                            </div>
                            <div style={actions}>
                                {!selected && <button style={primaryButton} disabled={!!busyId} onClick={() => pick('codex', profile.id)}>Выбрать</button>}
                                <button style={button} onClick={() => send('codex.rename', { id: profile.id })}>Переименовать</button>
                                {!selected && <button style={button} onClick={() => send('codex.remove', { id: profile.id })}>Удалить</button>}
                            </div>
                        </div>;
                    })}
                    {codexActive && <div style={{ borderTop: '1px solid var(--vscode-panel-border)', marginTop: 12, paddingTop: 12 }}>
                        <h3 style={{ margin: '0 0 10px', fontSize: 13 }}>Лимиты выбранного аккаунта</h3>
                        <Limits windows={codex.limits?.windows || []} stale={codex.limits?.stale} staleHint={CODEX_STALE_HINT}
                            error={codex.limits?.error} updatedAt={codex.limits?.updatedAt} now={now} mode={mode}/>
                    </div>}
                    {codex.pendingRestart && <div style={{ marginTop: 12, padding: 12, border: '1px solid var(--vscode-editorWarning-foreground)', borderRadius: 6 }}>
                        <b>Открытые сеансы Codex ещё могут использовать прежнюю авторизацию.</b>
                        <p style={muted}>Адресный перезапуск недоступен. Для применения можно вручную перезапустить Extension Host; другие расширения будут затронуты.</p>
                        <div style={actions}>
                            <button style={button} onClick={() => send('codex.restartExtensions')}>Перезапустить расширения</button>
                            <button style={button} onClick={() => send('codex.reloadWindow')}>Reload Window</button>
                        </div>
                    </div>}
                </section>
            )}

            {installed.claude && claude && (
                <section style={card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                        <div>
                            <h2 style={{ fontSize: 17, margin: '0 0 4px' }}>Claude Code</h2>
                            <div style={muted}>Раздельная авторизация через CLAUDE_CONFIG_DIR</div>
                        </div>
                        <button style={primaryButton} disabled={claude.adding} onClick={() => send('claude.add')}>
                            {claude.adding ? 'Авторизация…' : '+ Добавить'}
                        </button>
                    </div>
                    {claude.externalConfigDir && <p style={{ color: 'var(--vscode-editorWarning-foreground)', fontSize: 12 }}>
                        Обнаружен внешний CLAUDE_CONFIG_DIR. Неизвестный профиль не изменяется.
                    </p>}
                    {claude.issue && <p style={{ color: 'var(--vscode-editorWarning-foreground)', fontSize: 12 }}>{claude.issue}</p>}
                    {claude.profiles.map(profile => {
                        const selected = claude.activeId === profile.id;
                        const limits = claude.limitsByProfile[profile.id];
                        return (
                            <div key={profile.id} style={{ borderTop: '1px solid var(--vscode-panel-border)', padding: '13px 0' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                    <div>
                                        <div><span style={{ marginRight: 8 }}>{selected ? '●' : '○'}</span><b>{profile.label}</b></div>
                                        <div style={{ ...muted, marginTop: 4 }}>
                                            {profile.plan || 'План неизвестен'} · {profile.loggedIn ? 'Авторизован' : 'Не авторизован'}
                                            {selected && (claude.pendingRestart ? ' · ожидает применения' : ' · выбран')}
                                        </div>
                                    </div>
                                    <div style={actions}>
                                        {!selected && <button style={primaryButton} disabled={!!busyId || !profile.loggedIn} onClick={() => pick('claude', profile.id)}>Выбрать</button>}
                                        <button style={button} onClick={() => send('claude.rename', { id: profile.id })}>Переименовать</button>
                                        {profile.id !== 'default' && !selected && <button style={button} onClick={() => send('claude.remove', { id: profile.id })}>Удалить</button>}
                                    </div>
                                </div>
                                {profile.loggedIn && <div style={{ margin: '11px 0 0 22px' }}>
                                    <Limits windows={limits?.windows || []} stale={limits?.stale} staleHint={CLAUDE_STALE_HINT}
                                        updatedAt={limits?.updatedAt} error={limits?.error} now={now} mode={mode}/>
                                </div>}
                            </div>
                        );
                    })}
                    <div style={{ ...muted, marginTop: 6 }}>
                        Лимиты берутся из официальной команды Claude CLI /usage (раз в 5 минут, одна проверка на все окна);
                        запасные источники — локальный кэш Claude Code и statusLine после ответов.
                        При истечении окна устаревшие цифры скрываются. Существующие сеансы сохраняют прежний аккаунт.
                    </div>
                    <div style={{ ...actions, marginTop: 12 }}>
                        <button style={button} onClick={() => send('claude.open')}>Открыть Claude Code</button>
                        {claude.pendingRestart && <button style={button} onClick={() => send('claude.reloadWindow')}>
                            Reload Window (если требуется)
                        </button>}
                    </div>
                </section>
            )}

            {installed.copilot && copilot && (
                <section style={card}>
                    <h2 style={{ fontSize: 17, margin: '0 0 10px' }}>GitHub Copilot</h2>
                    <div>Текущий аккаунт: <b>{copilot.active || 'не определён'}</b></div>
                    <div style={{ ...muted, marginTop: 5 }}>Сессия Prompt Manager: {copilot.session || 'не определена'}</div>
                    {!!copilot.issue && <p style={{ color: 'var(--vscode-editorWarning-foreground)', fontSize: 12 }}>{copilot.issue}</p>}
                    <CopilotCreditsProgress credits={copilot.credits} switching={copilot.switching} now={now} mode={mode} />
                    <div style={{ ...actions, marginTop: 13 }}>
                        <button style={primaryButton} disabled={copilot.switching} onClick={() => send('copilot.switch')}>
                            {copilot.switching ? 'Переключение…' : 'Сменить аккаунт Copilot'}
                        </button>
                        {!copilot.session && <button style={button} onClick={() => send('copilot.auth')}>Авторизоваться</button>}
                    </div>
                </section>
            )}

            {!installed.codex && !installed.claude && !installed.copilot && (
                <section style={card}>Расширения Codex, Claude Code и GitHub Copilot в текущем окружении VS Code не обнаружены.</section>
            )}
        </AccountsPageFrame>
    );
};
