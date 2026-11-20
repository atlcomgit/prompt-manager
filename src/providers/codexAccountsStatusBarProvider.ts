import * as vscode from 'vscode';
import type { CodexAccountService } from '../services/codexAccountService.js';
import type { AccountsLimitDisplayService } from '../services/accountsLimitDisplayService.js';
import { limitDisplayVerb, limitPercent } from '../utils/limitDisplay.js';
import { resolveQuotaHighlight, type QuotaHighlightLevel } from '../utils/quotaHighlight.js';
import {
    CODEX_LIMITS_REFRESH_MS, type CodexRateLimitService, type CodexLimitStatus,
} from '../services/codexRateLimitService.js';

/**
 * Элемент строки состояния с лимитами активного аккаунта Codex. Открывает страницу «Аккаунты».
 * Опрос начинается после создания провайдера в фоновой фазе запуска. Тест: tests/codexAccounts.test.ts.
 */
export class CodexAccountsStatusBarProvider implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly subscriptions: vscode.Disposable[] = [];
    private timer: ReturnType<typeof setInterval>;
    private inProgress = false;
    private refreshQueued = false;
    private last: CodexLimitStatus | null = null;

    /** Создаёт элемент, подписывается на изменения аккаунтов, расширений и фокуса окна и запускает обновление. */
    constructor(
        private readonly accounts: CodexAccountService,
        private readonly rateLimits: CodexRateLimitService,
        private readonly display?: AccountsLimitDisplayService,
    ) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
        this.item.name = 'Prompt Manager: Codex Accounts';
        this.item.command = 'promptManager.accounts';
        this.item.text = '$(loading~spin) Codex...';
        this.item.tooltip = 'Загружаем лимиты Codex. Нажмите для управления аккаунтами.';
        this.item.show();
        this.subscriptions.push(this.accounts.onDidChange(() => {
            this.rateLimits.invalidate();
            void this.refresh();
        }));
        this.subscriptions.push(vscode.extensions.onDidChange(() => void this.refresh()));
        if (this.display) {
            // Rendering a different percentage never triggers another rate-limit request.
            this.subscriptions.push(this.display.onDidChange(() => this.render()));
        }
        // При получении фокуса окно опрашивает Codex, только если данные старше интервала обновления.
        const focusSubscription = vscode.window.onDidChangeWindowState?.(state => {
            if (state.focused) void this.refresh();
        });
        if (focusSubscription) this.subscriptions.push(focusSubscription);
        this.timer = setInterval(() => void this.refresh(), CODEX_LIMITS_REFRESH_MS);
        void this.refresh();
    }

    /** Показывает лимиты активного аккаунта или скрывает элемент, если расширение Codex не установлено. */
    private render(): void {
        if (!vscode.extensions.getExtension('openai.chatgpt')) {
            this.item.backgroundColor = undefined;
            this.item.color = undefined;
            this.item.hide();
            return;
        }
        const state = this.accounts.getView();
        const current = state.profiles.find(p => p.id === state.activeId);
        if (!current) {
            this.item.backgroundColor = undefined;
            this.item.color = undefined;
            this.item.text = '$(account) Codex: не подключён';
            this.item.tooltip = 'Откройте «Аккаунты», чтобы добавить ChatGPT.';
            this.item.show();
            return;
        }
        const stale = Boolean(this.last?.stale && this.last.windows.length);
        const mode = this.display?.getMode() || 'used';
        this.setQuotaHighlight(resolveQuotaHighlight(this.last?.windows || []));
        // Знак «≈» отмечает последние известные, а не свежие проценты.
        const fragments = (this.last?.windows || [])
            .map(w => w.label + ': ' + (stale ? '≈' : '') + Math.round(limitPercent(w, mode) ?? 0) + '%');
        const warning = state.pendingRestart || stale ? ' $(warning)' : '';
        this.item.text = '$(account) Codex ' + (fragments.join(' · ') || 'лимиты —') + warning;
        const receivedAt = this.last?.windows.length ? new Date(this.last.updatedAt).toLocaleString('ru-RU') : '';
        const lines = [
            'Codex: ' + current.label,
            ...(this.last?.windows || []).map(w =>
                w.label + ': ' + (stale ? 'последние известные ' : '') + Math.round(limitPercent(w, mode) ?? 0)
                + '% ' + limitDisplayVerb(mode)
                + (w.resetsAt ? ' · сброс ' + new Date(w.resetsAt * 1000).toLocaleString('ru-RU') : '')),
            receivedAt ? 'Данные получены: ' + receivedAt : '',
            stale ? 'Значения могли устареть. Следующая проверка перечитает общий кеш.' : '',
            this.last?.error || '',
            state.pendingRestart ? 'Переключение сохранено, но требуется перезапуск Codex.' : '',
            'Нажмите, чтобы открыть страницу «Аккаунты».',
        ].filter(Boolean);
        this.item.tooltip = lines.join('\n');
        this.item.show();
    }

    /** Применяет пару фон и текст из текущей темы VS Code. */
    private setQuotaHighlight(level: QuotaHighlightLevel): void {
        this.item.backgroundColor = level === 'critical'
            ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : level === 'warning' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        this.item.color = level === 'critical'
            ? new vscode.ThemeColor('statusBarItem.errorForeground')
            : level === 'warning' ? new vscode.ThemeColor('statusBarItem.warningForeground') : undefined;
    }

    /**
     * Обновляет лимиты и перерисовывает элемент. Опрос Codex разрешён по таймеру независимо от фокуса и ручному
     * обновлению (`force`); фоновые окна читают общий кэш. Повторный вызов во время обновления
     * выполняется после него один раз.
     */
    async refresh(force = false): Promise<void> {
        if (this.inProgress) { this.refreshQueued = true; return; }
        this.inProgress = true;
        try {
            if (!vscode.extensions.getExtension('openai.chatgpt')) {
                this.last = null;
            } else {
                // Авторизация читается до представления: по ней определяется активный профиль.
                const auth = await this.accounts.getActiveAuth();
                const state = this.accounts.getView();
                this.last = await this.rateLimits.get(state.activeId, auth, force, true);
            }
        } catch (error) {
            this.last = { windows: [], planType: null, updatedAt: new Date().toISOString(),
                error: error instanceof Error ? error.message : String(error) };
        } finally {
            this.inProgress = false;
            this.render();
            if (this.refreshQueued) { this.refreshQueued = false; void this.refresh(); }
        }
    }

    /** Останавливает обновление и освобождает элемент строки состояния и подписки. */
    dispose(): void {
        clearInterval(this.timer);
        this.item.dispose();
        for (const x of this.subscriptions) x.dispose();
    }
}
