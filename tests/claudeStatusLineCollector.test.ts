import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, stat, lstat, symlink, access } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Значение настройки `promptManager.claude.statusLineCollector`; `undefined` — значение по умолчанию. */
let collectorEnabled: boolean | undefined;
/** Вызовы `update` настройки: ключ, значение и область. */
const settingUpdates: Array<[string, unknown, unknown]> = [];
/** Подписчики `workspace.onDidChangeConfiguration`. */
const configurationListeners = new Set<(event: { affectsConfiguration(section: string): boolean }) => void>();
/** Зарегистрированные команды. */
const commands = new Map<string, () => Promise<void>>();
/** Сообщения VS Code: уровень и текст. */
const messages: Array<[string, string]> = [];

/** Меняет настройку сборщика и оповещает подписчиков, как VS Code при изменении `settings.json`. */
function setCollectorEnabled(value: boolean): void {
    collectorEnabled = value;
    const event = { affectsConfiguration: (section: string) => section === 'promptManager.claude.statusLineCollector' };
    for (const listener of [...configurationListeners]) listener(event);
}

/** Подмена модуля `vscode` для настроек, команд и сообщений сервиса statusLine. */
const vscodeMock = {
    ConfigurationTarget: { Global: 1 },
    workspace: {
        getConfiguration: (section: string) => ({
            get: <T>(key: string, fallback: T) => section === 'promptManager' && key === 'claude.statusLineCollector'
                && collectorEnabled !== undefined ? collectorEnabled : fallback,
            update: async (key: string, value: boolean, target: unknown) => {
                settingUpdates.push([section + '.' + key, value, target]);
                setCollectorEnabled(value);
            },
        }),
        onDidChangeConfiguration: (fn: (event: { affectsConfiguration(section: string): boolean }) => void) => {
            configurationListeners.add(fn);
            return { dispose: () => { configurationListeners.delete(fn); } };
        },
    },
    commands: {
        registerCommand: (id: string, fn: () => Promise<void>) => {
            commands.set(id, fn);
            return { dispose: () => { commands.delete(id); } };
        },
    },
    window: {
        showInformationMessage: async (text: string) => { messages.push(['info', text]); },
        showWarningMessage: async (text: string) => { messages.push(['warning', text]); },
        showErrorMessage: async (text: string) => { messages.push(['error', text]); },
    },
};

/** Профиль Claude в тесте: каталог и признак выполненного входа. */
interface TestProfile { id: string; directory: string; loggedIn: boolean }

/**
 * Создаёт временный домашний каталог и загружает `ClaudeStatusLineService` с подменой `vscode`.
 * Основной профиль `~/.claude` находится во временном каталоге, настоящий `~/.claude` не используется.
 */
async function setup() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pm-claude-collector-'));
    const home = path.join(root, 'home');
    await mkdir(path.join(home, '.claude'), { recursive: true });
    process.env.HOME = home;
    collectorEnabled = undefined;
    settingUpdates.length = 0;
    messages.length = 0;
    const originalLoad = (Module as any)._load;
    (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
        if (request === 'vscode') return vscodeMock;
        return originalLoad.call(this, request, parent, isMain);
    };
    const { ClaudeStatusLineService } = await import('../src/services/claudeStatusLineService.js');
    const storage = path.join(root, 'extension-store');
    const logs: string[] = [];
    /** Создаёт сервис для профилей; отключённые от входа профили возвращаются только с `includeSignedOut`. */
    const context = { globalStorageUri: { fsPath: storage } } as any;
    const create = (profiles: TestProfile[]) => new ClaudeStatusLineService(context, {
        onDidChange: () => ({ dispose() { /* Профили в тесте не меняются. */ } }),
        getProfileDirectories: (includeSignedOut = false) => profiles
            .filter(p => includeSignedOut || p.loggedIn).map(({ id, directory }) => ({ id, directory })),
    } as any, message => logs.push(message));
    return {
        root, home, storage, logs, create,
        restore: () => { (Module as any)._load = originalLoad; },
    };
}

/** Дожидается завершения всех поставленных в очередь проходов настройки сервиса. */
async function settle(service: any): Promise<void> {
    while (service.running) await service.running;
    await service.fileQueue;
}

/** Читает settings.json профиля как объект. */
async function readSettings(directory: string): Promise<Record<string, any>> {
    return JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'));
}

test('disabled statusLine collector setting never installs the collector', async () => {
    const env = await setup();
    const profile = path.join(env.root, 'profile');
    await mkdir(profile);
    await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ model: 'test-model' }));
    collectorEnabled = false;
    const service = env.create([{ id: 'work', directory: profile, loggedIn: true }]);
    try {
        await service.ensureConfigured();
        await settle(service);
        assert.deepEqual(await readSettings(profile), { model: 'test-model' });
        await assert.rejects(access(path.join(env.storage, 'prompt-manager-statusline.cjs')));
        await assert.rejects(access(path.join(profile, 'settings.json.bak-prompt-manager-statusline')));
    } finally {
        service.dispose();
        env.restore();
        await rm(env.root, { recursive: true, force: true });
    }
});

test('collector removal deletes only Prompt Manager statusLine entries and keeps a custom one', async () => {
    if (process.platform === 'win32') return; // Права доступа и символические ссылки проверяются в POSIX.
    const env = await setup();
    const defaultDir = path.join(env.home, '.claude');
    const custom = path.join(env.root, 'custom');
    const signedOut = path.join(env.root, 'signed-out');
    const linked = path.join(env.root, 'linked');
    const dotfiles = path.join(env.root, 'dotfiles');
    for (const dir of [custom, signedOut, linked, dotfiles]) await mkdir(dir);
    await writeFile(path.join(defaultDir, 'settings.json'), JSON.stringify({ model: 'main', hooks: { Stop: [] } }));
    const customConfig = { statusLine: { type: 'command', command: '/usr/local/bin/my-statusline' }, theme: 'dark' };
    await writeFile(path.join(custom, 'settings.json'), JSON.stringify(customConfig));
    const managed = { type: 'command', command: "node '/old/storage/prompt-manager-statusline.cjs'" };
    await writeFile(path.join(signedOut, 'settings.json'), JSON.stringify({ statusLine: managed, effort: 'high' }));
    await chmod(path.join(signedOut, 'settings.json'), 0o640);
    await writeFile(path.join(dotfiles, 'claude-settings.json'), JSON.stringify({ statusLine: managed, model: 'x' }));
    await symlink(path.join(dotfiles, 'claude-settings.json'), path.join(linked, 'settings.json'));
    const service = env.create([
        { id: 'default', directory: defaultDir, loggedIn: true },
        { id: 'custom', directory: custom, loggedIn: true },
        { id: 'signed-out', directory: signedOut, loggedIn: false },
        { id: 'linked', directory: linked, loggedIn: false },
    ]);
    try {
        await service.ensureConfigured();
        await settle(service);
        assert.match((await readSettings(defaultDir)).statusLine.command, /prompt-manager-statusline\.cjs/);

        const command = commands.get('promptManager.claude.removeStatusLineCollector');
        assert.ok(command, 'Команда снятия сборщика должна регистрироваться сервисом.');
        await command();
        await settle(service);
        assert.deepEqual(settingUpdates, [['promptManager.claude.statusLineCollector', false, 1]]);
        assert.deepEqual(messages.map(([level]) => level), ['info']);
        assert.deepEqual(await readSettings(defaultDir), { model: 'main', hooks: { Stop: [] } });
        assert.deepEqual(await readSettings(custom), customConfig);
        assert.deepEqual(await readSettings(signedOut), { effort: 'high' });
        assert.equal((await stat(path.join(signedOut, 'settings.json'))).mode & 0o777, 0o640);
        assert.equal((await lstat(path.join(linked, 'settings.json'))).isSymbolicLink(), true);
        const linkedTarget = JSON.parse(await readFile(path.join(dotfiles, 'claude-settings.json'), 'utf8'));
        assert.deepEqual(linkedTarget, { model: 'x' });

        // При возврате настройки сборщик снова устанавливается, хотя профиль уже настраивался раньше.
        setCollectorEnabled(true);
        await settle(service);
        assert.match((await readSettings(defaultDir)).statusLine.command, /prompt-manager-statusline\.cjs/);
        // Выключение настройки без команды тоже снимает запись.
        setCollectorEnabled(false);
        await settle(service);
        assert.deepEqual(await readSettings(defaultDir), { model: 'main', hooks: { Stop: [] } });
        assert.deepEqual(await readSettings(custom), customConfig);
    } finally {
        service.dispose();
        env.restore();
        await rm(env.root, { recursive: true, force: true });
    }
    assert.equal(commands.size, 0, 'Команда освобождается вместе с сервисом.');
    assert.equal(configurationListeners.size, 0);
});
