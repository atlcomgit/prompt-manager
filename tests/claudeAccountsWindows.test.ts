import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Временный корень теста: домашний каталог, globalStorage и фиктивное расширение Claude Code. */
let root = '';
/** Значение `claudeCode.environmentVariables`, общее для всех экземпляров сервиса, как в одном профиле VS Code. */
let environment: Array<{ name?: string; value?: string }> | undefined;
/** Подписчики `window.onDidCloseTerminal`. */
const closeListeners = new Set<(terminal: unknown) => void>();
/** Терминалы, созданные сервисом. */
const terminals: Array<{ options: any; sent: string[]; disposed: boolean }> = [];
/** Информационные сообщения VS Code. */
const messages: string[] = [];

/** Подмена событий VS Code с рабочей отпиской. */
class MockEventEmitter<T> {
    private listeners = new Set<(value: T) => void>();
    event = (fn: (value: T) => void) => {
        this.listeners.add(fn);
        return { dispose: () => { this.listeners.delete(fn); } };
    };
    fire(value: T): void { [...this.listeners].forEach(fn => fn(value)); }
    dispose(): void { this.listeners.clear(); }
}

/** Подмена модуля `vscode`: настройки Claude Code, расширение с фиктивным CLI и терминалы. */
const vscodeMock = {
    EventEmitter: MockEventEmitter,
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: (_name: string) => ({
        get: (key: string) => key === 'environmentVariables' ? environment : undefined,
        inspect: (key: string) => key === 'environmentVariables' ? { globalValue: environment } : {},
        update: async (_key: string, value: typeof environment) => { environment = value; },
    }) },
    extensions: {
        getExtension: (id: string) => id === 'anthropic.claude-code'
            ? { extensionPath: path.join(root, 'anthropic-extension') } : undefined,
    },
    window: {
        createTerminal: (options: any) => {
            const terminal = {
                options, sent: [] as string[], disposed: false,
                show() { /* Терминал в тесте не отображается. */ },
                sendText(text: string) { terminal.sent.push(text); },
                dispose() { terminal.disposed = true; },
            };
            terminals.push(terminal);
            return terminal;
        },
        onDidCloseTerminal: (fn: (terminal: unknown) => void) => {
            closeListeners.add(fn);
            return { dispose: () => { closeListeners.delete(fn); } };
        },
        showInformationMessage: async (message: string) => { messages.push(message); },
    },
};

/** Имитирует закрытие терминала пользователем. */
function closeTerminal(terminal: unknown): void {
    for (const fn of [...closeListeners]) fn(terminal);
}

/** Ожидает событие сервиса, после которого выполняется условие; срок 10 секунд защищает от зависания теста. */
function whenChanged(service: { onDidChange: (fn: () => void) => { dispose(): void } }, ready: () => boolean) {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            subscription.dispose();
            reject(new Error('Сервис не завершил операцию.'));
        }, 10_000);
        const subscription = service.onDidChange(() => {
            if (!ready()) return;
            clearTimeout(timer);
            subscription.dispose();
            resolve();
        });
    });
}

/**
 * Создаёт временное окружение с фиктивным Claude CLI и загружает `ClaudeAccountService` с подменой `vscode`.
 * CLI сообщает о входе для основного профиля и для каталога с файлом `.signed-in`.
 */
async function setup() {
    root = await mkdtemp(path.join(os.tmpdir(), 'pm-claude-windows-'));
    terminals.length = 0;
    messages.length = 0;
    const home = path.join(root, 'home');
    await mkdir(home);
    // Сервис не должен обращаться к настоящему ~/.claude.
    process.env.HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    const bin = path.join(root, 'anthropic-extension', 'resources', 'native-binary');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'claude'), [
        '#!/bin/sh',
        'if [ -z "$CLAUDE_CONFIG_DIR" ] || [ -f "$CLAUDE_CONFIG_DIR/.signed-in" ]; then',
        '  printf \'{"loggedIn":true,"email":"second@example.test","planTier":"Pro"}\\n\'',
        'else',
        '  printf \'{"loggedIn":false}\\n\'',
        'fi',
        '',
    ].join('\n'), { mode: 0o755 });
    const originalLoad = (Module as any)._load;
    (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
        if (request === 'vscode') return vscodeMock;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const { ClaudeAccountService } = await import('../src/services/claudeAccountService.js');
        const stored = new Map<string, unknown>();
        const context: any = {
            globalStorageUri: { fsPath: path.join(root, 'storage') },
            globalState: {
                get: (key: string) => stored.get(key),
                update: async (key: string, value: unknown) => { stored.set(key, JSON.parse(JSON.stringify(value))); },
            },
        };
        return { ClaudeAccountService, stored, context };
    } finally {
        (Module as any)._load = originalLoad;
    }
}

/** Возвращает идентификаторы профилей из общего `globalState`. */
function storedIds(stored: Map<string, unknown>): string[] {
    return ((stored.get('promptManager.claudeProfiles.v1') as any)?.profiles || []).map((p: any) => p.id);
}

test('Claude profile lists from two windows are merged through globalState and deletions stay deleted', async () => {
    if (process.platform === 'win32') return; // Фиктивный CLI — сценарий POSIX-оболочки.
    const { ClaudeAccountService, stored, context } = await setup();
    environment = [{ name: 'SOME_EXISTING_VAR', value: 'preserve-me' }];
    const removable = '11111111-2222-4333-8444-555555555555';
    const removableDir = path.join(root, 'storage', 'claude-profiles', removable);
    await mkdir(removableDir, { recursive: true });
    stored.set('promptManager.claudeProfiles.v1', {
        profiles: [{
            id: removable, label: 'Старый', email: null, plan: null, loggedIn: false, directory: removableDir,
        }],
        pendingRestart: false,
    });
    const windowA = new ClaudeAccountService(context);
    // Окно B открыто раньше, чем окно A добавит профиль.
    const windowB = new ClaudeAccountService(context);
    try {
        await windowA.initialize();
        await windowA.addAccount();
        const terminal = terminals.at(-1)!;
        const loginDir = terminal.options.env.CLAUDE_CONFIG_DIR as string;
        await writeFile(path.join(loginDir, '.signed-in'), '');
        const added = whenChanged(windowA, () => !windowA.getView().adding);
        closeTerminal(terminal);
        await added;
        const profile = windowA.getView().profiles.find(p => p.email === 'second@example.test' && p.id !== 'default');
        assert.ok(profile, 'Профиль после входа должен сохраниться при закрытии терминала.');
        assert.equal(messages.filter(m => /аккаунт добавлен/.test(m)).length, 1);
        await windowA.switchAccount(profile.id);
        assert.deepEqual(environment, [
            { name: 'SOME_EXISTING_VAR', value: 'preserve-me' },
            { name: 'CLAUDE_CONFIG_DIR', value: loginDir },
        ]);

        // Окно B видит выбранный профиль, а не «внешний CLAUDE_CONFIG_DIR».
        const viewB = windowB.getView();
        assert.equal(viewB.activeId, profile.id);
        assert.equal(viewB.externalConfigDir, false);
        assert.ok(windowB.getProfileDirectories().some(p => p.id === profile.id && p.directory === loginDir));
        // Обновление и переименование в окне B не затирают профиль окна A.
        await windowB.refreshAccounts();
        await windowB.renameAccount('default', 'Основной из окна B');
        assert.ok(storedIds(stored).includes(profile.id));
        assert.equal(windowA.getView().profiles.find(p => p.id === 'default')?.label, 'Основной из окна B');

        // Удаление в окне A не отменяется последующим сохранением в окне B.
        await windowA.removeAccount(removable);
        await windowB.refreshAccounts();
        assert.equal(storedIds(stored).includes(removable), false);
        assert.equal(windowB.getView().profiles.some(p => p.id === removable), false);
        await assert.rejects(access(removableDir));
    } finally {
        windowA.dispose();
        windowB.dispose();
        await rm(root, { recursive: true, force: true });
    }
});

test('closing the Claude login terminal without signing in ends the login and removes its directory', async () => {
    if (process.platform === 'win32') return; // Фиктивный CLI — сценарий POSIX-оболочки.
    const { ClaudeAccountService, stored, context } = await setup();
    environment = undefined;
    const service = new ClaudeAccountService(context);
    try {
        await service.initialize();
        const before = storedIds(stored);
        await service.addAccount();
        const terminal = terminals.at(-1)!;
        const loginDir = terminal.options.env.CLAUDE_CONFIG_DIR as string;
        assert.match(terminal.sent[0], /auth login$/);
        // Закрытие другого терминала не влияет на вход.
        closeTerminal({});
        assert.equal(service.getView().adding, true);
        const finished = whenChanged(service, () => !service.getView().adding);
        closeTerminal(terminal);
        await finished;
        const view = service.getView();
        assert.match(view.issue || '', /Терминал входа закрыт до завершения авторизации Claude/);
        assert.deepEqual(storedIds(stored), before);
        assert.equal(terminal.disposed, true);
        assert.equal(closeListeners.size, 0, 'Подписка на закрытие терминала должна освобождаться.');
        await assert.rejects(access(loginDir));
        assert.equal(messages.length, 0);
        // После завершения можно начать новый вход.
        await service.addAccount();
        assert.equal(service.getView().adding, true);
    } finally {
        service.dispose();
        await rm(root, { recursive: true, force: true });
    }
});
