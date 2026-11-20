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
 * Команды открывают панель до готовности провайдеров. После готовности веб-панель получает снимок
 * лимитов, сохраняет ручное обновление в очереди и снимает блокировку кнопок при отмене переключения.
 */
test('Accounts page opens before providers are ready, then loads limits and answers cancelled switches', async () => {
    const posted: Array<{ type: string; message?: string; data?: { copilot?: { issue?: string } } }> = [];
    let receive: ((message: unknown) => Promise<void>) | null = null;
    const commands = new Map<string, () => Promise<void>>();
    let extensionsChanged: (() => void) | undefined;
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
    const installed = new Set(['openai.chatgpt', 'anthropic.claude-code', 'github.copilot-chat']);
    const vscodeMock = {
        ViewColumn: { One: 1 },
        commands: {
            registerCommand: (id: string, run: () => Promise<void>) => {
                commands.set(id, run);
                return { dispose: () => commands.delete(id) };
            },
        },
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
            onDidChange: (listener: () => void) => { extensionsChanged = listener; return listeners; },
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
        let usageChanged: (() => void) | undefined;
        let copilotReads = 0;
        let copilotStarting = false;
        const usageService = {
            onDidChangeAccountSwitchState: event,
            onDidChangeUsage: (listener: () => void) => { usageChanged = listener; return listeners; },
            getAccountSwitchState: () => ({ isSwitching: false }),
            getAccountBindingSummary: async () => null,
            getCachedData: () => null,
            fetchUsage: async () => {
                if (++copilotReads === 1) usageChanged?.();
                return null;
            },
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
        const quotaRequests: boolean[] = [];
        const codexLimits = {
            invalidate() {},
            get: async (_id: string, _auth: unknown, force: boolean) => { quotaRequests.push(force); return null; },
        };
        const claudeAccounts = {
            onDidChange: event,
            getView: () => ({ profiles: [{ id: 'default', label: 'Main' }, { id: 'p2', label: 'Second' }],
                activeId: 'default', pendingRestart: false, adding: false, issue: null }),
            getProfileDirectories: () => [],
            switchAccount: async () => { switched++; return { applied: true, message: '' }; },
        };
        const claudeUsage = { invalidate() {}, read: async () => null, refreshActive: async () => null };
        let release!: (ready: boolean) => void;
        const providersReady = new Promise<boolean>(resolve => { release = resolve; });
        manager = new CopilotUsagePanelManager(
            { fsPath: '/extension' } as any, usageService as any, codexAccounts as any, codexLimits as any,
            claudeAccounts as any, claudeUsage as any, undefined, undefined, () => providersReady, () => copilotStarting,
        );
        // Команды доступны до статус-бара. Повторное открытие, ready и событие установки не опрашивают CLI.
        await commands.get('promptManager.accounts')!();
        await commands.get('promptManager.copilotUsageDetails')!();
        await receive!({ type: 'accounts.ready' });
        extensionsChanged!();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(quotaRequests.length, 0);
        assert.equal(posted.length, 0);
        release(true);
        await waitFor(() => posted.some(message => message.type === 'accounts.data'));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(quotaRequests, [false]);
        assert.equal(copilotReads, 1);
        // Ручное обновление во время опроса панели сохраняет force, даже если следом пришло автообновление.
        installed.delete('anthropic.claude-code');
        copilotStarting = true;
        extensionsChanged!();
        await receive!({ type: 'accounts.refresh' });
        extensionsChanged!();
        await waitFor(() => quotaRequests.includes(true));
        await waitFor(() => posted.some(message => message.data?.copilot?.issue?.includes('ещё запускается')));
        assert.equal(copilotReads, 1);
        await receive!({ type: 'copilot.auth' });
        assert.ok(posted.some(message => message.type === 'accounts.result' && message.message?.includes('ещё запускается')));
        copilotStarting = false;
        extensionsChanged!();
        await waitFor(() => copilotReads > 1);
        installed.add('anthropic.claude-code');
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
