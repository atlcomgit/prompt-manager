/**
 * Страница «Аккаунты»: профили Codex и Claude Code, их лимиты и прежний выбор аккаунта GitHub Copilot.
 * Webview получает только метаданные и проценты лимитов, никогда — токены OAuth.
 */
import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import { appendPromptManagerLog } from '../utils/promptManagerOutput.js';
import type { CopilotUsageService } from '../services/copilotUsageService.js';
import type { CodexAccountService } from '../services/codexAccountService.js';
import { CodexRateLimitService } from '../services/codexRateLimitService.js';
import type { ClaudeAccountService } from '../services/claudeAccountService.js';
import { ClaudeUsageService } from '../services/claudeUsageService.js';
import { resolveAccountProviderAvailability } from '../utils/accountProviders.js';
import { buildCopilotCreditsSnapshot } from '../utils/copilotCredits.js';
import type { AccountsLimitDisplayService } from '../services/accountsLimitDisplayService.js';
import type { CopilotUsageData } from '../services/copilotUsageService.js';

/** Одна вкладка «Аккаунты» на окно: обработка действий webview и периодическая отправка данных; tests/accountsPanelManager.test.ts. */
export class CopilotUsagePanelManager implements vscode.Disposable {
    private panel: vscode.WebviewPanel | null = null;
    private readonly disposables: vscode.Disposable[] = [];
    private refreshTimer: ReturnType<typeof setInterval> | null = null;
    private refreshing = false;
    private queuedRefresh: boolean | undefined;
    private waitingForProviders?: Promise<boolean>;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly usageService: CopilotUsageService,
        private readonly codexAccounts: CodexAccountService,
        private readonly codexLimits: CodexRateLimitService,
        private readonly claudeAccounts: ClaudeAccountService,
        private readonly claudeUsage: ClaudeUsageService,
        private readonly onCopilotAccountChanged?: (accountLabel: string) => Promise<void> | void,
        private readonly limitDisplay?: AccountsLimitDisplayService,
        whenProvidersReady?: () => Promise<boolean>,
        private readonly isCopilotStarting?: () => boolean,
    ) {
        // Обе команды сразу открывают интерфейс, в том числе до появления статус-бара.
        this.disposables.push(
            vscode.commands.registerCommand('promptManager.accounts', () => this.show()),
            vscode.commands.registerCommand('promptManager.copilotUsageDetails', () => this.show()),
        );
        this.waitingForProviders = whenProvidersReady?.();
        void this.waitingForProviders?.then(ready => {
            if (!ready) return;
            this.waitingForProviders = undefined;
            void this.pushData(false);
        });
        this.disposables.push(this.codexAccounts.onDidChange(() => {
            this.codexLimits.invalidate();
            void this.pushData(false);
        }));
        this.disposables.push(this.usageService.onDidChangeAccountSwitchState(() => void this.pushData(false)));
        this.disposables.push(this.usageService.onDidChangeUsage(() => {
            // A panel refresh already delivers the usage result that it just read.
            if (!this.refreshing) void this.pushData(false);
        }));
        this.disposables.push(this.claudeAccounts.onDidChange(() => {
            this.claudeUsage.invalidate();
            void this.pushData(false);
        }));
        this.disposables.push(vscode.extensions.onDidChange(() => void this.pushData(false)));
        if (this.limitDisplay) {
            this.disposables.push(this.limitDisplay.onDidChange(mode => {
                // Each window updates its own page without new API/CLI calls.
                void this.panel?.webview.postMessage({ type: 'accounts.displayMode', mode });
            }));
        }
    }

    /** Открывает вкладку или показывает уже открытую и обновляет её данные. */
    async show(): Promise<void> {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            void this.pushData(false);
            return;
        }
        const panel = vscode.window.createWebviewPanel('promptManager.copilotUsage', 'Аккаунты', vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [this.extensionUri],
        });
        panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar-icon.svg');
        panel.webview.html = getWebviewHtml(
            panel.webview, this.extensionUri, 'dist/webview/copilotUsage.js', 'Аккаунты', vscode.env.language,
        );
        this.panel = panel;
        this.disposables.push(panel.onDidDispose(() => {
            this.stopRefresh();
            if (this.panel === panel) this.panel = null;
        }));
        this.disposables.push(panel.webview.onDidReceiveMessage(async (message: any) => {
            if (this.panel !== panel || !message || typeof message.type !== 'string') return;
            try {
                // Единственный стартовый снимок придёт после активации. Ручное действие дожидается провайдеров.
                if (this.waitingForProviders) {
                    if (message.type === 'accounts.ready') return;
                    if (!await this.waitingForProviders || this.panel !== panel) return;
                }
                if ((message.type === 'copilot.switch' || message.type === 'copilot.auth') && this.isCopilotStarting?.()) {
                    throw new Error('GitHub Copilot ещё запускается. Повторите действие после активации.');
                }
                switch (message.type) {
                    case 'accounts.ready':
                        await this.pushData(false);
                        break;
                    case 'accounts.setDisplayMode': {
                        if (message.mode !== 'used' && message.mode !== 'remaining') {
                            throw new Error('Неизвестный режим отображения лимитов.');
                        }
                        if (!this.limitDisplay) throw new Error('Настройка отображения недоступна.');
                        await this.limitDisplay.setMode(message.mode);
                        await panel.webview.postMessage({
                            type: 'accounts.displayMode', mode: this.limitDisplay.getMode(),
                        });
                        break;
                    }
                    case 'accounts.refresh':
                        this.codexLimits.invalidate();
                        this.claudeUsage.invalidate();
                        if (vscode.extensions.getExtension('anthropic.claude-code')) {
                            await this.claudeAccounts.refreshAccounts();
                            const state = this.claudeAccounts.getView();
                            const active = this.claudeAccounts.getProfileDirectories().find(p => p.id === state.activeId);
                            if (active) {
                                // Ручное обновление тоже соблюдает общую блокировку окон и минимальный интервал в одну минуту.
                                await this.claudeUsage.refreshActive(active.id, active.directory, true)
                                    .catch(() => undefined);
                            }
                        }
                        await this.pushData(true);
                        break;
                    case 'codex.add':
                        await this.codexAccounts.addAccount();
                        await this.pushData(false);
                        break;
                    case 'codex.switch': {
                        const requested = this.codexAccounts.getView().profiles.find(p => p.id === message.id);
                        if (!requested) throw new Error('Аккаунт Codex не найден.');
                        const confirmation = await vscode.window.showWarningMessage(
                            'Выбрать Codex-аккаунт «' + requested.label + '»? Открытые сессии Codex продолжат работать с прежней авторизацией до перезапуска.',
                            { modal: true }, 'Выбрать аккаунт',
                        );
                        // Отмена тоже отвечает webview: иначе кнопки «Выбрать» остаются заблокированными.
                        if (confirmation !== 'Выбрать аккаунт') {
                            await this.pushData(false);
                            break;
                        }
                        const result = await this.codexAccounts.switchAccount(requested.id);
                        this.codexLimits.invalidate();
                        await panel.webview.postMessage({ type: 'accounts.result', message: result.message, warning: !result.applied });
                        await this.pushData(true);
                        break;
                    }
                    case 'codex.rename': {
                        const item = this.codexAccounts.getView().profiles.find(p => p.id === message.id);
                        if (!item) break;
                        const label = await vscode.window.showInputBox({ title: 'Название аккаунта Codex', value: item.label });
                        if (label !== undefined) await this.codexAccounts.renameAccount(item.id, label);
                        break;
                    }
                    case 'codex.remove': {
                        const item = this.codexAccounts.getView().profiles.find(p => p.id === message.id);
                        if (!item) break;
                        const accepted = await vscode.window.showWarningMessage(
                            'Удалить сохранённый профиль «' + item.label + '»? Аккаунт ChatGPT не удаляется.',
                            { modal: true }, 'Удалить профиль',
                        );
                        if (accepted === 'Удалить профиль') await this.codexAccounts.removeAccount(item.id);
                        break;
                    }
                    case 'codex.restartExtensions': {
                        const accepted = await vscode.window.showWarningMessage(
                            'Перезапустить Extension Host? Это прервёт работу всех расширений в этом VS Code, включая других агентов.',
                            { modal: true }, 'Перезапустить расширения',
                        );
                        if (accepted === 'Перезапустить расширения') {
                            const commands = await vscode.commands.getCommands(true);
                            const restart = commands.includes('workbench.action.restartExtensionHost')
                                ? 'workbench.action.restartExtensionHost'
                                : commands.includes('workbench.extensions.action.restartExtensionHost')
                                    ? 'workbench.extensions.action.restartExtensionHost' : null;
                            if (!restart) throw new Error('Команда перезапуска Extension Host не найдена. Используйте «Reload Window».');
                            await vscode.commands.executeCommand(restart);
                        }
                        break;
                    }
                    case 'codex.reloadWindow': {
                        const accepted = await vscode.window.showWarningMessage(
                            'Перезагрузить окно VS Code для применения аккаунта Codex? Несохранённая работа и активные агенты могут быть прерваны.',
                            { modal: true }, 'Reload Window',
                        );
                        if (accepted === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
                        break;
                    }
                    case 'claude.add':
                        if (!vscode.extensions.getExtension('anthropic.claude-code')) break;
                        await this.claudeAccounts.addAccount();
                        await this.pushData(false);
                        break;
                    case 'claude.switch': {
                        if (!vscode.extensions.getExtension('anthropic.claude-code')) break;
                        const selected = this.claudeAccounts.getView().profiles.find(p => p.id === message.id);
                        if (!selected) throw new Error('Профиль Claude не найден.');
                        const confirmation = await vscode.window.showWarningMessage(
                            'Выбрать аккаунт Claude «' + selected.label
                                + '»? Новые сеансы получат выбранную конфигурацию, но открытые сеансы не переключатся. '
                                + 'Изменение пользовательской настройки влияет на другие окна VS Code.',
                            { modal: true }, 'Выбрать аккаунт',
                        );
                        // Отмена тоже отвечает webview: иначе кнопки «Выбрать» остаются заблокированными.
                        if (confirmation !== 'Выбрать аккаунт') {
                            await this.pushData(false);
                            break;
                        }
                        const result = await this.claudeAccounts.switchAccount(selected.id);
                        this.claudeUsage.invalidate();
                        await panel.webview.postMessage({ type: 'accounts.result', message: result.message, warning: !result.applied });
                        await this.pushData(true);
                        break;
                    }
                    case 'claude.rename': {
                        const profile = this.claudeAccounts.getView().profiles.find(p => p.id === message.id);
                        if (!profile) break;
                        const label = await vscode.window.showInputBox({ title: 'Название аккаунта Claude Code', value: profile.label });
                        if (label !== undefined) await this.claudeAccounts.renameAccount(profile.id, label);
                        break;
                    }
                    case 'claude.remove': {
                        const profile = this.claudeAccounts.getView().profiles.find(p => p.id === message.id);
                        if (!profile) break;
                        const answer = await vscode.window.showWarningMessage(
                            'Удалить профиль Claude «' + profile.label
                                + '» вместе с его отдельными данными авторизации и настройками? Это необратимо.',
                            { modal: true }, 'Удалить профиль',
                        );
                        if (answer === 'Удалить профиль') await this.claudeAccounts.removeAccount(profile.id);
                        break;
                    }
                    case 'claude.open':
                        await vscode.commands.executeCommand('claude-vscode.sidebar.open');
                        break;
                    case 'claude.reloadWindow': {
                        const answer = await vscode.window.showWarningMessage(
                            'Перезагрузить окно VS Code для применения профиля Claude? Это прервёт активные задания и расширения.',
                            { modal: true }, 'Reload Window',
                        );
                        if (answer === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
                        break;
                    }
                    case 'copilot.switch': {
                        const result = await this.usageService.switchCopilotChatAccountInteractively();
                        if (!result.changed) {
                            if (!result.cancelled) await panel.webview.postMessage({ type: 'accounts.result', message: result.message });
                            break;
                        }
                        const completion = await this.usageService.completeAccountSwitch(result.accountLabel || '');
                        if (this.onCopilotAccountChanged) await this.onCopilotAccountChanged(completion.accountLabel);
                        await panel.webview.postMessage({ type: 'accounts.result', message: completion.message });
                        await this.pushData(false);
                        break;
                    }
                    case 'copilot.auth':
                        await this.usageService.authenticate();
                        await this.pushData(false);
                        break;
                }
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                appendPromptManagerLog('[Accounts] action failed: ' + detail);
                await panel.webview.postMessage({ type: 'accounts.result', message: detail, warning: true });
                await this.pushData(false);
            }
        }));
        this.refreshTimer = setInterval(() => { if (this.panel === panel) void this.pushData(false); }, 60_000);
        void this.pushData(false);
    }

    /** Read the shared Copilot snapshot before delivering the panel data. */
    private async readCopilotCredits(force: boolean): Promise<CopilotUsageData | null> {
        const cached = this.usageService.getCachedData();
        try {
            return await this.usageService.fetchUsage(force);
        } catch (error) {
            appendPromptManagerLog('[Accounts] Copilot credits refresh failed: '
                + (error instanceof Error ? error.message : String(error)));
            return cached;
        }
    }

    /**
     * Собирает и отправляет данные страницы (accounts.data); повторный вызов во время сборки ставится в очередь.
     * force — принудительное обновление лимитов; при ошибке webview получает accounts.error.
     */
    private async pushData(force: boolean): Promise<void> {
        const panel = this.panel;
        if (!panel || this.waitingForProviders) return;
        if (this.refreshing) {
            this.queuedRefresh = force || this.queuedRefresh === true;
            return;
        }
        this.refreshing = true;
        try {
            const installed = resolveAccountProviderAvailability(id => vscode.extensions.getExtension(id));
            // Авторизация читается до представления: активный профиль Codex определяется по файлу на диске.
            const auth = installed.codex ? await this.codexAccounts.getActiveAuth() : null;
            const codex = installed.codex ? this.codexAccounts.getView() : null;
            const claude = installed.claude ? this.claudeAccounts.getView() : null;
            // Waiting for a still-starting Copilot must not hold the other account sections.
            const copilotStarting = installed.copilot && this.isCopilotStarting?.() === true;
            const readCopilot = installed.copilot && !copilotStarting;
            const [copilot, copilotUsage] = await Promise.all([
                readCopilot ? this.usageService.getAccountBindingSummary().catch(() => null) : Promise.resolve(null),
                readCopilot && !this.usageService.getAccountSwitchState().isSwitching
                    ? this.readCopilotCredits(force) : Promise.resolve(null),
            ]);
            if (claude && !force) {
                const active = this.claudeAccounts.getProfileDirectories().find(p => p.id === claude.activeId);
                if (active) {
                    // Открытие страницы не ждёт процесс CLI: статус-бар и страница читают общий кэш.
                    void this.claudeUsage.refreshActive(active.id, active.directory)
                        .then(result => {
                            if (result?.reason === 'updated' && this.panel === panel) void this.pushData(false);
                        })
                        .catch(() => undefined);
                }
            }
            const [limits, claudeLimits] = await Promise.all([
                // Any session can refresh usage under the shared provider lock.
                codex ? this.codexLimits.get(codex.activeId, auth, force)
                    : Promise.resolve(null),
                claude ? Promise.all(this.claudeAccounts.getProfileDirectories().map(async profile => ({
                    id: profile.id,
                    limits: await this.claudeUsage.read(profile.id, profile.directory, force),
                }))) : Promise.resolve([]),
            ]);
            if (this.panel !== panel) return;
            await panel.webview.postMessage({
                type: 'accounts.data',
                data: {
                    installed,
                    limitDisplayMode: this.limitDisplay?.getMode() || 'used',
                    codex: codex ? { ...codex,
                        otherSwitcherInstalled: Boolean(vscode.extensions.getExtension('goosenest.codex-profiles')),
                        limits,
                    } : null,
                    claude: claude ? { ...claude, limitsByProfile: Object.fromEntries(claudeLimits.map(x => [x.id, x.limits])) } : null,
                    copilot: installed.copilot ? {
                        active: copilot?.copilotPreferredGitHubLabel || null,
                        session: copilot?.activeGithubSessionAccountLabel || null,
                        accounts: copilot?.availableGitHubAccounts || [],
                        issue: copilotStarting ? 'GitHub Copilot ещё запускается.' : copilot?.githubSessionIssue || null,
                        switching: this.usageService.getAccountSwitchState().isSwitching,
                        credits: buildCopilotCreditsSnapshot(copilotUsage),
                    } : null,
                },
            });
        } catch (error) {
            appendPromptManagerLog('[Accounts] refresh failed: ' + (error instanceof Error ? error.message : String(error)));
            if (this.panel === panel) {
                await panel.webview.postMessage({
                    type: 'accounts.error',
                    message: 'Не удалось получить сведения об аккаунтах. Повторите загрузку.',
                });
            }
        } finally {
            this.refreshing = false;
            if (this.queuedRefresh !== undefined) {
                const queuedForce = this.queuedRefresh;
                this.queuedRefresh = undefined;
                void this.pushData(queuedForce);
            }
        }
    }

    /** Останавливает периодическое обновление открытой вкладки. */
    private stopRefresh(): void {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = null;
    }

    /** Закрывает вкладку и освобождает подписки. */
    dispose(): void {
        this.stopRefresh();
        this.panel?.dispose();
        this.panel = null;
        for (const x of this.disposables) x.dispose();
        this.disposables.length = 0;
    }
}
