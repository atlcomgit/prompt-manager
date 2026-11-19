import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const originalLoad = (Module as any)._load;
/** Упрощённый `vscode.EventEmitter` для подписок сервиса и статус-бара. */
class EventEmitter<T> {
    private listeners: Array<(value: T) => void> = [];
    event = (cb: (value: T) => void) => {
        this.listeners.push(cb);
        return { dispose: () => { this.listeners = this.listeners.filter(x => x !== cb); } };
    };
    fire(v: T): void { this.listeners.forEach(fn => fn(v)); }
    dispose(): void { this.listeners = []; }
}
/** Поддельный терминал входа: запоминает параметры создания и освобождение. */
interface FakeTerminal { options: any; disposed: boolean; show(): void; sendText(text: string): void; dispose(): void }
/** Поддельный элемент строки состояния: видимость меняется через show/hide. */
interface FakeStatusItem {
    text: string; tooltip: string; visible: boolean; show(): void; hide(): void; dispose(): void;
}
const terminals: FakeTerminal[] = [];
const statusItems: FakeStatusItem[] = [];
const terminalClosed = new EventEmitter<FakeTerminal>();
const windowStateChanged = new EventEmitter<{ focused: boolean }>();
let codexInstalled = false;
const vscodeMock = {
    EventEmitter,
    StatusBarAlignment: { Left: 1, Right: 2 },
    extensions: {
        getExtension: (id: string) => (codexInstalled && id === 'openai.chatgpt'
            ? { extensionPath: path.join(os.tmpdir(), 'pm-missing-codex-extension') } : undefined),
        onDidChange: () => ({ dispose: () => undefined }),
    },
    commands: {
        getCommands: async () => [],
        executeCommand: async (_name: string) => { throw new Error('No automatic restart expected'); },
        registerCommand: () => ({ dispose: () => undefined }),
    },
    window: {
        state: { focused: true },
        onDidChangeWindowState: windowStateChanged.event,
        onDidCloseTerminal: terminalClosed.event,
        showInformationMessage: async () => undefined,
        createTerminal: (options: any): FakeTerminal => {
            const terminal: FakeTerminal = {
                options, disposed: false,
                show: () => undefined, sendText: () => undefined,
                dispose: () => { terminal.disposed = true; },
            };
            terminals.push(terminal);
            return terminal;
        },
        createStatusBarItem: (): FakeStatusItem => {
            const item: FakeStatusItem = {
                text: '', tooltip: '', visible: false,
                show: () => { item.visible = true; }, hide: () => { item.visible = false; }, dispose: () => undefined,
            };
            statusItems.push(item);
            return item;
        },
    },
};
(Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') return vscodeMock;
    return originalLoad.call(this, request, parent, isMain);
};

/** Тестовый auth.json без настоящих токенов; `token` позволяет получить ту же учётную запись с новыми токенами. */
function fixtureAuth(accountId: string, token = 'synthetic-test-only'): string {
    return JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, account_id: accountId } });
}

/** Общие для всех «окон» `globalState` и SecretStorage, как в одном профиле VS Code. */
function sharedContext() {
    const globalData = new Map<string, unknown>();
    const secretData = new Map<string, string>();
    const ctx = {
        globalState: {
            get: <T>(key: string) => globalData.get(key) as T | undefined,
            update: async (key: string, value: unknown) => { globalData.set(key, value); },
        },
        secrets: {
            get: async (key: string) => secretData.get(key),
            store: async (key: string, value: string) => { secretData.set(key, value); },
            delete: async (key: string) => { secretData.delete(key); },
        },
    };
    return { globalData, secretData, ctx };
}

/** Выполняет `body` с CODEX_HOME во временном каталоге и восстанавливает окружение. */
async function withCodexHome(body: (home: string) => Promise<void>): Promise<void> {
    const home = await mkdtemp(path.join(os.tmpdir(), 'pm-codex-home-test-'));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
        await body(home);
    } finally {
        if (previousHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
    }
}

/** Ждёт уведомления сервиса, после которого вход в Codex завершён. */
function waitForLoginEnd(service: {
    onDidChange: (cb: () => void) => { dispose(): void };
    getView(): { adding: boolean };
}): Promise<void> {
    return new Promise<void>(resolve => {
        const subscription = service.onDidChange(() => {
            if (service.getView().adding) return;
            subscription.dispose();
            resolve();
        });
    });
}

test('Codex window labels reflect the actual reset intervals', async () => {
    const { formatLimitDuration, parseCodexLimitResponse } = await import('../src/services/codexRateLimitService.js');
    assert.equal(formatLimitDuration(300), '5ч');
    assert.equal(formatLimitDuration(10080), '7д');
    const result = parseCodexLimitResponse({
        rateLimits: {
            planType: 'pro',
            primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1794900000 },
            secondary: { usedPercent: 83, windowDurationMins: 10080, resetsAt: 1795500000 },
        },
    });
    assert.deepEqual(result.windows.map(x => [x.label, x.remainingPercent]), [['5ч', 66], ['7д', 17]]);
    assert.equal(result.planType, 'pro');
    const empty = parseCodexLimitResponse({});
    assert.equal(empty.windows.length, 0);
});

test('switching Codex credentials preserves the previous account and reports a required restart', async () => {
    const { CodexAccountService } = await import('../src/services/codexAccountService.js');
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'pm-codex-profile-test-'));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tmp;
    const globalData = new Map<string, unknown>();
    const secretData = new Map<string, string>();
    const ctx = {
        globalState: {
            get: <T>(key: string) => globalData.get(key) as T | undefined,
            update: async (key: string, value: unknown) => { globalData.set(key, value); },
        },
        secrets: {
            get: async (key: string) => secretData.get(key),
            store: async (key: string, value: string) => { secretData.set(key, value); },
            delete: async (key: string) => { secretData.delete(key); },
        },
    };
    const a = fixtureAuth('account-a');
    const b = fixtureAuth('account-b');
    try {
        await writeFile(path.join(tmp, 'auth.json'), a, { mode: 0o600 });
        const service = new CodexAccountService(ctx as any);
        await service.initialize();
        const first = service.getView();
        assert.equal(first.profiles.length, 1);
        assert.equal(first.profiles[0].identity, 'account-a');
        const secondId = 'second';
        const save = globalData.get('promptManager.codexAccounts.v1') as any;
        save.profiles.push({ id: secondId, label: 'Второй', identity: 'account-b', createdAt: '2026-11-18T00:00:00.000Z' });
        // A new service instance simulates reloading persisted metadata.
        secretData.set('promptManager.codexAccount.' + secondId, b);
        service.dispose();
        const selected = new CodexAccountService(ctx as any);
        await selected.initialize();
        const outcome = await selected.switchAccount(secondId);
        assert.equal(outcome.switched, true);
        assert.equal(outcome.applied, false);
        assert.equal(selected.getView().pendingRestart, true);
        assert.equal(JSON.parse(await readFile(path.join(tmp, 'auth.json'), 'utf8')).tokens.account_id, 'account-b');
        assert.equal(secretData.get('promptManager.codexAccount.' + first.activeId!), a);
        selected.dispose();
    } finally {
        if (previousHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousHome;
        await rm(tmp, { recursive: true, force: true });
    }
});

test('a window opened earlier sees profiles and the active account changed by another window', async () => {
    const { CodexAccountService } = await import('../src/services/codexAccountService.js');
    await withCodexHome(async home => {
        const { globalData, secretData, ctx } = sharedContext();
        const authFile = path.join(home, 'auth.json');
        const a = fixtureAuth('account-a');
        const b = fixtureAuth('account-b');
        await writeFile(authFile, a, { mode: 0o600 });
        const windowA = new CodexAccountService(ctx as any);
        const windowB = new CodexAccountService(ctx as any);
        try {
            await windowA.initialize();
            await windowB.initialize();
            assert.equal(windowB.getView().profiles.length, 1);
            const first = windowA.getView().activeId!;
            // Окно A регистрирует второй аккаунт, затем возвращает первый и переключается на второй.
            await writeFile(authFile, b, { mode: 0o600 });
            await windowA.syncDiskAccount();
            const second = windowA.getView().activeId!;
            assert.notEqual(second, first);
            await windowA.switchAccount(first);
            await windowA.switchAccount(second);
            assert.equal(JSON.parse(await readFile(authFile, 'utf8')).tokens.account_id, 'account-b');

            assert.deepEqual(windowB.getView().profiles.map(p => p.id).sort(), [first, second].sort());
            await windowB.getActiveAuth();
            assert.equal(windowB.getView().activeId, second);

            // После перезапуска Codex другое средство вернуло в auth.json первый аккаунт, не меняя globalState.
            const key = 'promptManager.codexAccounts.v1';
            const restarted = globalData.get(key) as any;
            await ctx.globalState.update(key, { ...restarted, pendingRestart: false, pendingHostPid: undefined });
            await writeFile(authFile, a, { mode: 0o600 });
            await windowB.getActiveAuth();
            assert.equal(windowB.getView().activeId, first);
            const back = await windowB.switchAccount(second);
            assert.equal(back.switched, true);
            assert.equal(JSON.parse(await readFile(authFile, 'utf8')).tokens.account_id, 'account-b');
            assert.equal(secretData.get('promptManager.codexAccount.' + first), a);

            // Профиль, добавленный другим окном после чтения состояния, не теряется при сохранении.
            const saved = globalData.get(key) as any;
            await ctx.globalState.update(key, { ...saved, profiles: [...saved.profiles,
                { id: 'third', label: 'Третий', identity: 'account-c', createdAt: '2026-11-19T00:00:00.000Z' }] });
            await windowB.renameAccount(first, 'Рабочий');
            const stored = (globalData.get(key) as any).profiles as Array<{ id: string; label: string }>;
            assert.deepEqual(stored.map(p => p.id).sort(), [first, second, 'third'].sort());
            assert.equal(stored.find(p => p.id === first)?.label, 'Рабочий');
            await windowA.getActiveAuth();
            assert.equal(windowA.getView().activeId, second);
            await assert.rejects(windowA.removeAccount(second), /переключитесь/);
        } finally {
            windowA.dispose();
            windowB.dispose();
        }
    });
});

test('refreshed credentials are stored in the active profile secret only while auth.json is unchanged', async () => {
    const { CodexAccountService } = await import('../src/services/codexAccountService.js');
    await withCodexHome(async home => {
        const { secretData, ctx } = sharedContext();
        const authFile = path.join(home, 'auth.json');
        const a = fixtureAuth('account-a');
        const rotated = fixtureAuth('account-a', 'synthetic-rotated');
        await writeFile(authFile, a, { mode: 0o600 });
        const service = new CodexAccountService(ctx as any);
        try {
            await service.initialize();
            const id = service.getView().activeId!;
            assert.equal(await service.storeRefreshedAuth(a, rotated), 'written');
            assert.equal(await readFile(authFile, 'utf8'), rotated);
            assert.equal(secretData.get('promptManager.codexAccount.' + id), rotated);
            const late = fixtureAuth('account-a', 'synthetic-late');
            assert.equal(await service.storeRefreshedAuth(a, late), 'disk-changed');
            assert.equal(await readFile(authFile, 'utf8'), rotated);
            assert.equal(secretData.get('promptManager.codexAccount.' + id), rotated);
        } finally {
            service.dispose();
        }
    });
});

test('closing the login terminal finishes the pending Codex login with one final check', async () => {
    const { CodexAccountService } = await import('../src/services/codexAccountService.js');
    await withCodexHome(async () => {
        const { ctx } = sharedContext();
        const service = new CodexAccountService(ctx as any);
        try {
            await service.addAccount();
            assert.equal(service.getView().adding, true);
            await assert.rejects(service.addAccount(), /уже выполняется/);
            const abandoned = terminals[terminals.length - 1];
            const abandonedEnd = waitForLoginEnd(service);
            terminalClosed.fire(abandoned);
            await abandonedEnd;
            assert.equal(service.getView().adding, false);
            assert.match(service.getView().issue || '', /Терминал входа закрыт/);
            await assert.rejects(access(abandoned.options.env.CODEX_HOME));

            // Вход, завершённый перед закрытием терминала, сохраняется финальной проверкой.
            await service.addAccount();
            const completed = terminals[terminals.length - 1];
            const completedEnd = waitForLoginEnd(service);
            await writeFile(path.join(completed.options.env.CODEX_HOME, 'auth.json'), fixtureAuth('account-c'));
            terminalClosed.fire(completed);
            await completedEnd;
            const view = service.getView();
            assert.equal(view.adding, false);
            assert.equal(view.issue, null);
            assert.deepEqual(view.profiles.map(p => p.identity), ['account-c']);
            assert.equal(completed.disposed, true);
        } finally {
            service.dispose();
        }
    });
});

test('Codex status bar appears after the extension is installed and polls only from the focused window', async () => {
    const { CodexAccountsStatusBarProvider } = await import('../src/providers/codexAccountsStatusBarProvider.js');
    const changed = new EventEmitter<void>();
    const calls: unknown[][] = [];
    let stale = false;
    const accounts = {
        onDidChange: changed.event,
        getActiveAuth: async () => fixtureAuth('account-a'),
        getView: () => ({
            profiles: [{ id: 'p1', label: 'Рабочий', identity: 'account-a', createdAt: '2026-11-19T00:00:00.000Z' }],
            activeId: 'p1', pendingRestart: false, adding: false, issue: null,
        }),
    };
    const limits = {
        invalidate: () => undefined,
        get: async (...args: unknown[]) => {
            calls.push(args);
            return {
                windows: [{
                    label: '5ч', usedPercent: 20, remainingPercent: 80, windowDurationMins: 300, resetsAt: null,
                }],
                planType: null, updatedAt: '2026-11-19T05:00:00.000Z', stale,
            };
        },
    };
    codexInstalled = false;
    vscodeMock.window.state.focused = true;
    let mode: 'used' | 'remaining' = 'used';
    const modeChangeHandlers: Array<() => void> = [];
    const preference = {
        getMode: () => mode,
        onDidChange: (cb: () => void) => {
            modeChangeHandlers.push(cb);
            return { dispose() {} };
        },
    };
    const provider = new CodexAccountsStatusBarProvider(
        accounts as any, limits as any, async () => undefined, preference as any);
    const item = statusItems[statusItems.length - 1];
    try {
        assert.equal(item.visible, false);
        codexInstalled = true;
        await provider.refresh();
        assert.equal(item.visible, true);
        assert.match(item.text, /Codex исп\. 5ч: 20%/);
        assert.match(item.tooltip, /20% использовано/);
        const countBeforeToggle = calls.length;
        mode = 'remaining';
        modeChangeHandlers.forEach(cb => cb());
        assert.match(item.text, /Codex ост\. 5ч: 80%/);
        assert.match(item.tooltip, /80% осталось/);
        assert.equal(calls.length, countBeforeToggle, 'Changing display must not poll Codex');
        mode = 'used';
        modeChangeHandlers.forEach(cb => cb());
        assert.match(item.text, /5ч: 20%/);
        assert.deepEqual(calls[calls.length - 1].slice(2), [false, true]);

        vscodeMock.window.state.focused = false;
        stale = true;
        await provider.refresh();
        assert.deepEqual(calls[calls.length - 1].slice(2), [false, false]);
        assert.match(item.text, /5ч: ≈20%/);
        assert.match(item.tooltip, /могли устареть/);
        await provider.refresh(true);
        assert.deepEqual(calls[calls.length - 1].slice(2), [true, true]);
    } finally {
        provider.dispose();
        codexInstalled = false;
        vscodeMock.window.state.focused = true;
    }
});
