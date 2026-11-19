import * as vscode from 'vscode';
import {
    normalizeLimitDisplayMode, type LimitDisplayMode,
} from '../utils/limitDisplay.js';

/**
 * Единая пользовательская настройка со scope: application.
 * Глобальна для проектов/окон VS Code Tunnel и синхронизируется через Settings Sync.
 */
export class AccountsLimitDisplayService implements vscode.Disposable {
    static readonly setting = 'promptManager.accounts.limitDisplayMode';

    private readonly changed = new vscode.EventEmitter<LimitDisplayMode>();
    readonly onDidChange = this.changed.event;
    private readonly subscription: vscode.Disposable;

    constructor() {
        this.subscription = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(AccountsLimitDisplayService.setting)) {
                this.changed.fire(this.getMode());
            }
        });
    }

    getMode(): LimitDisplayMode {
        return normalizeLimitDisplayMode(
            vscode.workspace.getConfiguration('promptManager').get<unknown>('accounts.limitDisplayMode', 'used'),
        );
    }

    async setMode(value: LimitDisplayMode): Promise<void> {
        if (value !== 'used' && value !== 'remaining') {
            throw new Error('Неверный режим отображения лимитов.');
        }
        if (this.getMode() === value) return;
        await vscode.workspace.getConfiguration('promptManager')
            .update('accounts.limitDisplayMode', value, vscode.ConfigurationTarget.Global);
        // Config change propagates to other Extension Hosts via onDidChangeConfiguration.
        // Apply immediately in the current window even when the host does not emit the event synchronously.
        this.changed.fire(this.getMode());
    }

    dispose(): void {
        this.subscription.dispose();
        this.changed.dispose();
    }
}
