import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const originalLoad = (Module as any)._load;

/** Ждёт условие коротким опросом с ограниченным таймаутом вместо фиксированной паузы. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('Условие не выполнено за отведённое время.');
        await new Promise(resolve => setImmediate(resolve));
    }
}

/**
 * Отмена в окне подтверждения переключения (Codex и Claude) отвечает webview свежими данными,
 * иначе кнопки «Выбрать» оставались заблокированными до таймера страницы. Проверяет CopilotUsagePanelManager.
 */
test('Accounts page answers a cancelled account switch so the pick buttons unlock', async () => {
    const posted: Array<{ type: string }> = [];
    let receive: ((message: unknown) => Promise<void>) | null = null;
    const listeners = { dispose() {} };
    const panel = {
        webview: {
            html: '',
            cspSource: 'vscode-resource:',
            asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => 'vscode-resource:' + uri.fsPath }),
            postMessage: async (message: { type: string }) => { posted.push(message); return true; },
            onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return listeners; },
        },
        onDidDispose: () => listeners,
        reveal() {},
        dispose() {},
        iconPath: undefined as unknown,
    };
    const installed = new Set(['openai.chatgpt', 'anthropic.claude-code']);
    const vscodeMock = {
        ViewColumn: { One: 1 },
        Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
        env: { language: 'ru' },
        window: {
            state: { focused: true },
            createWebviewPanel: () => panel,
            // Пользователь нажимает «Отмена» в модальном подтверждении.
            showWarningMessage: async () => undefined,
            createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
        },
        workspace: { getConfiguration: () => ({ get: <T>(_key: string, fallback: T) => fallback }) },
        extensions: {
            getExtension: (id: string) => installed.has(id) ? { id } : undefined,
            onDidChange: () => listeners,
        },
    };
    (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
        if (request === 'vscode') return vscodeMock;
        return originalLoad.call(this, request, parent, isMain);
    };
    let manager: { show(): Promise<void>; dispose(): void } | null = null;
    try {
        const { CopilotUsagePanelManager } = await import('../src/providers/copilotUsagePanelManager.js');
        let switched = 0;
        const event = () => listeners;
        const usageService = {
            onDidChangeAccountSwitchState: event,
            onDidChangeUsage: event,
            getAccountSwitchState: () => ({ isSwitching: false }),
        };
        const codexAccounts = {
            onDidChange: event,
            getView: () => ({
                profiles: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
                activeId: 'b', pendingRestart: false, adding: false, issue: null,
            }),
            getActiveAuth: async () => null,
            switchAccount: async () => { switched++; return { switched: true, applied: true, message: '' }; },
        };
        const codexLimits = { invalidate() {}, get: async () => null };
        const claudeAccounts = {
            onDidChange: event,
            getView: () => ({ profiles: [{ id: 'default', label: 'Main' }, { id: 'p2', label: 'Second' }],
                activeId: 'default', pendingRestart: false, adding: false, issue: null }),
            getProfileDirectories: () => [],
            switchAccount: async () => { switched++; return { applied: true, message: '' }; },
        };
        const claudeUsage = { invalidate() {}, read: async () => null, refreshActive: async () => null };
        manager = new CopilotUsagePanelManager(
            { fsPath: '/extension' } as any, usageService as any, codexAccounts as any, codexLimits as any,
            claudeAccounts as any, claudeUsage as any,
        );
        await manager.show();
        await waitFor(() => posted.some(message => message.type === 'accounts.data'));
        for (const [type, id] of [['codex.switch', 'a'], ['claude.switch', 'p2']]) {
            posted.length = 0;
            await receive!({ type, id });
            await waitFor(() => posted.some(message => message.type === 'accounts.data'));
        }
        assert.equal(switched, 0);
    } finally {
        manager?.dispose();
        (Module as any)._load = originalLoad;
    }
});
