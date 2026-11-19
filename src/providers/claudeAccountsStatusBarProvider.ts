import * as vscode from 'vscode';
import type { ClaudeAccountService } from '../services/claudeAccountService.js';
import { ClaudeUsageService, isClaudeWindowExpired, type ClaudeLimitStatus } from '../services/claudeUsageService.js';

/**
 * Элемент строки состояния с выбранным профилем Claude Code и остатком лимитов 5ч / 7д.
 * Обновляется каждые 20 секунд, при смене профилей, расширений и фокуса окна; CLI `/usage` запускает
 * только окно в фокусе, остальные окна читают общий кэш.
 */
export class ClaudeAccountsStatusBarProvider implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly timer: ReturnType<typeof setInterval>;
    private running = false;
    private queued = false;
    private last: ClaudeLimitStatus | null = null;

    /** Создаёт элемент строки состояния, подписывается на изменения и запускает первое обновление. */
    constructor(
        private readonly accounts: ClaudeAccountService,
        private readonly usage: ClaudeUsageService,
    ) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 49);
        this.item.name = 'Prompt Manager: Claude Code';
        this.item.command = 'promptManager.accounts';
        this.disposables.push(accounts.onDidChange(() => {
            this.usage.invalidate();
            void this.refresh();
        }));
        this.disposables.push(vscode.extensions.onDidChange(() => void this.refresh()));
        // Фоновые окна, включая VS Code Tunnel, только читают общий кэш; проверку CLI может начать окно в фокусе.
        const focusSubscription = vscode.window.onDidChangeWindowState?.(state => {
            if (state.focused) void this.refresh();
        });
        if (focusSubscription) this.disposables.push(focusSubscription);
        this.timer = setInterval(() => void this.refresh(), 20_000);
        void this.refresh();
    }

    /**
     * Отрисовывает текст и подсказку. Скрывает элемент без расширения Claude Code; не показывает сброшенные окна,
     * а устаревшие значения отмечает знаком ≈ и предупреждением.
     */
    private render(): void {
        if (!vscode.extensions.getExtension('anthropic.claude-code')) {
            this.item.hide();
            return;
        }
        const view = this.accounts.getView();
        const profile = view.profiles.find(p => p.id === view.activeId);
        if (!profile || !profile.loggedIn) {
            this.item.text = '$(account) Claude: вход не выполнен';
            this.item.tooltip = view.externalConfigDir
                ? 'Claude использует внешнюю конфигурацию. Проверьте CLAUDE_CONFIG_DIR.'
                : 'Откройте «Аккаунты» для подключения Claude Code.';
        } else {
            const windows = (this.last?.windows || []).filter(w => !isClaudeWindowExpired(w));
            const summary = ['five_hour', 'seven_day'].map((key, index) => {
                const item = windows.find(w => w.key === key);
                const label = index === 0 ? '5ч' : '7д';
                return label + ': ' + (item
                    ? (this.last?.stale ? '≈' : '') + Math.round(item.remainingPercent) + '%'
                    : '—');
            });
            this.item.text = '$(account) Claude ' + (windows.length ? summary.join(' · ') : 'лимиты —')
                + ((view.pendingRestart || this.last?.stale) ? ' $(warning)' : '');
            this.item.tooltip = [
                'Claude Code: ' + profile.label,
                profile.plan ? 'Подписка: ' + profile.plan : '',
                ...windows.map(w => w.label + ': '
                    + (this.last?.stale ? 'последние известные ' : 'осталось ')
                    + Math.round(w.remainingPercent) + '%'
                    + (w.resetsAt ? ', сброс ' + new Date(w.resetsAt * 1000).toLocaleString('ru-RU') : '')),
                this.last?.updatedAt ? 'Данные: ' + new Date(this.last.updatedAt).toLocaleString('ru-RU') : '',
                this.last?.source === 'claude-cli' ? 'Источник: Claude CLI /usage (общий кэш)'
                    : this.last?.source === 'statusline' ? 'Источник: Claude Code statusLine'
                        : 'Источник: локальный кэш Claude',
                this.last?.stale
                    ? 'Значения устарели, ≈ означает последний известный процент. Окна после сброса скрываются. '
                        + 'Новые значения появятся после ответа Claude Code.'
                    : '',
                this.last?.error || '',
                view.pendingRestart ? 'Для открытых сеансов Claude требуется переподключение.' : '',
                'Нажмите, чтобы открыть «Аккаунты».',
            ].filter(Boolean).join('\n');
        }
        this.item.show();
    }

    /**
     * Обновляет лимиты активного профиля и перерисовывает элемент. Вызов во время обновления ставит ещё одно
     * в очередь; ошибки чтения приводят к отображению без лимитов.
     */
    async refresh(): Promise<void> {
        if (this.running) { this.queued = true; return; }
        this.running = true;
        try {
            if (vscode.extensions.getExtension('anthropic.claude-code')) {
                const state = this.accounts.getView();
                const profile = this.accounts.getProfileDirectories().find(x => x.id === state.activeId);
                const focused = vscode.window.state?.focused !== false;
                if (profile && focused && typeof this.usage.refreshActive === 'function') {
                    // Межпроцессная блокировка гарантирует один запуск CLI на все открытые проекты VS Code.
                    await this.usage.refreshActive(profile.id, profile.directory).catch(() => undefined);
                }
                this.last = profile ? await this.usage.read(profile.id, profile.directory, true) : null;
            } else {
                this.last = null;
            }
        } catch {
            this.last = null;
        } finally {
            this.running = false;
            this.render();
            if (this.queued) { this.queued = false; void this.refresh(); }
        }
    }

    /** Останавливает таймер, удаляет элемент строки состояния и освобождает подписки. */
    dispose(): void {
        clearInterval(this.timer);
        this.item.dispose();
        for (const disposable of this.disposables) disposable.dispose();
    }
}
