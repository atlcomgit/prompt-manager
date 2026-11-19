import type * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import type { ClaudeAccountService } from './claudeAccountService.js';

/** API VS Code, загружаемый лениво: модульные тесты могут создавать сервис без Extension Host. */
type VscodeApi = typeof vscode;

/**
 * Текст скрипта-сборщика для команды statusLine Claude Code. Скрипт читает из stdin данные statusLine
 * и атомарно сохраняет в `<CLAUDE_CONFIG_DIR>/prompt-manager-rate-limits.json` только проценты и время сброса лимитов.
 */
const COLLECTOR_SCRIPT = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const os = require('node:os');",
    "const path = require('node:path');",
    "const crypto = require('node:crypto');",
    'const outputDir = process.env.CLAUDE_CONFIG_DIR',
    '    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)',
    "    : path.join(os.homedir(), '.claude');",
    "const target = path.join(outputDir, 'prompt-manager-rate-limits.json');",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    '    input += chunk;',
    '    if (input.length > 1024 * 1024) process.exit(0);',
    '});',
    "process.stdin.on('end', () => {",
    '    try {',
    '        const obj = JSON.parse(input);',
    '        const limits = obj && obj.rate_limits;',
    "        if (!limits || typeof limits !== 'object') return;",
    '        const values = {};',
    "        for (const name of ['five_hour', 'seven_day']) {",
    '            const item = limits[name];',
    "            if (!item || typeof item !== 'object') continue;",
    "            const used = typeof item.used_percentage === 'number' ? item.used_percentage : NaN;",
    '            if (!Number.isFinite(used) || used < 0 || used > 100) continue;',
    '            const reset = Number(item.resets_at);',
    '            values[name] = {',
    '                used_percentage: used,',
    '                resets_at: Number.isFinite(reset) && reset > 0 ? reset : null,',
    '            };',
    '        }',
    '        if (!Object.keys(values).length) return;',
    '        fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });',
    "        const temp = path.join(outputDir, '.prompt-manager-rate-limits-' + crypto.randomUUID() + '.tmp');",
    '        try {',
    '            const record = JSON.stringify({ fetchedAtMs: Date.now(), rate_limits: values });',
    "            fs.writeFileSync(temp, record, { mode: 0o600, flag: 'wx' });",
    '            fs.renameSync(temp, target);',
    '        } finally {',
    '            try { fs.unlinkSync(temp); } catch {}',
    '        }',
    '    } catch {',
    '        // Ошибка записи не должна менять вывод Claude Code или прерывать ответ.',
    '    }',
    '});',
    '// Вывода в stdout нет: скрипт только сохраняет лимиты и не формирует строку состояния Claude.',
].join('\n') + '\n';
/** Имя файла настроек Claude Code в каталоге профиля. */
const CONFIG_FILE = 'settings.json';
/** Имя файла сборщика в globalStorage расширения. */
const COLLECTOR_NAME = 'prompt-manager-statusline.cjs';
/** Признак записи statusLine, созданной Prompt Manager: команда содержит имя файла сборщика. */
const MANAGED_MARKER = 'prompt-manager-statusline.cjs';
/** Раздел и ключ настройки, разрешающей установку сборщика. */
const SETTING_SECTION = 'promptManager';
const SETTING_KEY = 'claude.statusLineCollector';
/** Команда, которая выключает сборщик и снимает его записи из настроек Claude Code. */
const REMOVE_COMMAND = 'promptManager.claude.removeStatusLineCollector';

/** Возвращает API VS Code или `null`, если модуль `vscode` недоступен, например в модульных тестах. */
function getVscodeApi(): VscodeApi | null {
    try {
        if (typeof require !== 'function') return null;
        return require('vscode') as VscodeApi;
    } catch {
        return null;
    }
}

/** Проверяет, что значение `statusLine` — запись сборщика Prompt Manager, а не собственная команда пользователя. */
function isManagedStatusLine(value: unknown): boolean {
    return !!value && typeof value === 'object'
        && String((value as { command?: unknown }).command || '').includes(MANAGED_MARKER);
}

/** Разбирает текст settings.json; бросает исключение, если это не JSON-объект. */
function parseSettingsObject(text: string | null): Record<string, unknown> {
    const settings = text ? JSON.parse(text) : {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not a JSON object');
    return settings;
}

/** Читает settings.json; для отсутствующего файла или каталога профиля возвращает `null`. */
async function readSettingsText(file: string): Promise<string | null> {
    try {
        return await fs.readFile(file, 'utf8');
    } catch (error: any) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
        throw error;
    }
}

/**
 * Атомарно заменяет settings.json текстом `text`, если файл не изменился с момента чтения (`previous`).
 * Существующий файл сохраняет прежний режим доступа, новый создаётся с правами 0600.
 * Для символической ссылки заменяется файл, на который она указывает, а сама ссылка сохраняется.
 * Возвращает `false`, если файл изменил другой процесс; в этом случае запись не выполняется.
 */
async function replaceSettingsFile(file: string, previous: string | null, text: string): Promise<boolean> {
    const current = await fs.readFile(file, 'utf8').catch(() => null);
    if (current !== previous) return false;
    const target = previous === null ? file : await fs.realpath(file);
    const mode = previous === null ? 0o600 : (await fs.stat(target)).mode & 0o777;
    const temporary = target + '.pm-' + process.pid + '-' + crypto.randomUUID() + '.tmp';
    try {
        await fs.writeFile(temporary, text, { mode, flag: 'wx' });
        // Режим при создании урезается umask, поэтому прежние права восстанавливаются явно.
        await fs.chmod(temporary, mode);
        await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    return true;
}

/**
 * Подключает официальный хук statusLine Claude Code для сохранения лимитов, не читая учётные данные
 * и не заменяя собственный statusLine пользователя.
 * Установка управляется настройкой `promptManager.claude.statusLineCollector`: при её выключении, в том числе
 * командой `promptManager.claude.removeStatusLineCollector`, из settings.json всех профилей снимается только
 * запись сборщика Prompt Manager. Без API VS Code (модульные тесты) сборщик считается включённым,
 * а команда и подписка на настройки не регистрируются.
 */
export class ClaudeStatusLineService implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    /** Каталоги профилей, уже проверенные или настроенные в текущем включённом состоянии. */
    private readonly configured = new Set<string>();
    private running: Promise<void> | null = null;
    private refreshQueued = false;
    private disposed = false;
    private collectorPath: string;
    private readonly defaultDir = path.join(os.homedir(), '.claude');
    private readonly vscodeApi = getVscodeApi();
    /** Очередь операций с settings.json: установка и снятие сборщика не выполняются одновременно. */
    private fileQueue: Promise<unknown> = Promise.resolve();

    /**
     * Подписывается на изменения профилей Claude и настройки сборщика, регистрирует команду снятия сборщика.
     * Подписки и команда освобождаются в `dispose`.
     */
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly accounts: ClaudeAccountService,
        private readonly log: (message: string) => void,
    ) {
        this.collectorPath = path.join(context.globalStorageUri.fsPath, COLLECTOR_NAME);
        this.disposables.push(accounts.onDidChange(() => { void this.ensureConfigured(); }));
        const api = this.vscodeApi;
        const configurationSubscription = api?.workspace.onDidChangeConfiguration?.(event => {
            if (!event.affectsConfiguration(SETTING_SECTION + '.' + SETTING_KEY)) return;
            // При повторном включении профили настраиваются заново, при выключении записи снимаются.
            this.configured.clear();
            void this.ensureConfigured();
        });
        if (configurationSubscription) this.disposables.push(configurationSubscription);
        const command = api?.commands?.registerCommand?.(REMOVE_COMMAND, () => this.removeCollectorByCommand());
        if (command) this.disposables.push(command);
    }

    /** Проверяет настройку `promptManager.claude.statusLineCollector`; по умолчанию сборщик включён. */
    isEnabled(): boolean {
        try {
            const configuration = this.vscodeApi?.workspace.getConfiguration(SETTING_SECTION);
            return configuration?.get<boolean>(SETTING_KEY, true) !== false;
        } catch {
            return true;
        }
    }

    /**
     * Приводит settings.json профилей в соответствие с настройкой: устанавливает сборщик или снимает его записи.
     * Повторный вызов во время выполнения ставит ещё один проход в очередь; ошибки записываются в журнал.
     */
    async ensureConfigured(): Promise<void> {
        if (this.disposed) return;
        if (this.running) { this.refreshQueued = true; return this.running; }
        this.running = this.exclusive(() => this.configure()).catch(error => {
            this.log('[Claude limits] StatusLine registration failed: '
                + (error instanceof Error ? error.message : String(error)));
        }).finally(() => {
            this.running = null;
            if (this.refreshQueued) {
                this.refreshQueued = false;
                void this.ensureConfigured();
            }
        });
        return this.running;
    }

    /** Выполняет операции с файлами настроек последовательно и возвращает результат задачи. */
    private exclusive<T>(task: () => Promise<T>): Promise<T> {
        const run = this.fileQueue.then(task);
        this.fileQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    /**
     * Один проход настройки. При выключенной настройке снимает записи сборщика и не создаёт файл сборщика;
     * при включённой обновляет скрипт в globalStorage и добавляет statusLine в профили с выполненным входом.
     */
    private async configure(): Promise<void> {
        if (this.disposed) return;
        if (!this.isEnabled()) {
            this.configured.clear();
            await this.removeCollectors();
            return;
        }
        await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true, mode: 0o700 });
        const existing = await fs.readFile(this.collectorPath, 'utf8').catch(() => null);
        if (existing !== COLLECTOR_SCRIPT) {
            const temporary = this.collectorPath + '.tmp-' + process.pid;
            try {
                await fs.writeFile(temporary, COLLECTOR_SCRIPT, { mode: 0o600 });
                await fs.rename(temporary, this.collectorPath);
            } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
        }
        for (const profile of this.accounts.getProfileDirectories()) {
            if (this.disposed || !this.isEnabled() || this.configured.has(profile.directory)) continue;
            const success = await this.configureOne(profile.directory);
            if (success) this.configured.add(profile.directory);
        }
    }

    /** Формирует команду запуска сборщика с экранированием пути для оболочки. */
    private command(): string {
        const escaped = this.collectorPath.replace(/'/g, "'\\''");
        return "node '" + escaped + "'";
    }

    /** Возвращает обезличенное название профиля для журнала. */
    private describe(directory: string): string {
        return directory === this.defaultDir ? 'default profile' : 'additional profile';
    }

    /**
     * Добавляет statusLine сборщика в settings.json профиля, если там нет собственного statusLine.
     * Перед первой правкой сохраняет копию `settings.json.bak-prompt-manager-statusline`.
     * Возвращает `true`, если профиль больше не требует проверки, и `false`, если файл нельзя безопасно изменить
     * или его параллельно изменил другой процесс.
     */
    private async configureOne(directory: string): Promise<boolean> {
        const file = path.join(directory, CONFIG_FILE);
        const previous = await readSettingsText(file);
        let settings: Record<string, unknown>;
        try {
            settings = parseSettingsObject(previous);
        } catch {
            this.log('[Claude limits] Existing settings.json cannot be safely updated; skipping '
                + this.describe(directory));
            return false;
        }
        if (settings.statusLine !== undefined) {
            if (isManagedStatusLine(settings.statusLine)) return true;
            this.log('[Claude limits] Preserving the existing custom Claude statusLine; '
                + 'automatic collector not installed.');
            return true;
        }
        const nextSettings = {
            ...settings,
            statusLine: { type: 'command', command: this.command() },
        };
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        if (previous !== null) {
            const backup = file + '.bak-prompt-manager-statusline';
            try {
                await fs.writeFile(backup, previous, { mode: 0o600, flag: 'wx' });
            } catch (error: any) {
                if (error?.code !== 'EEXIST') throw error;
            }
        }
        // Другой процесс мог изменить файл во время проверки: тогда профиль будет проверен при следующем проходе.
        if (!(await replaceSettingsFile(file, previous, JSON.stringify(nextSettings, null, 2) + '\n'))) return false;
        this.log('[Claude limits] Enabled native statusLine capture for ' + this.describe(directory));
        return true;
    }

    /** Возвращает без повторов каталоги основного и всех дополнительных профилей, включая профили без входа. */
    private allDirectories(): string[] {
        const directories = [this.defaultDir, ...this.accounts.getProfileDirectories(true).map(p => p.directory)];
        return [...new Set(directories.map(directory => path.resolve(directory)))];
    }

    /**
     * Снимает запись сборщика из settings.json основного и всех дополнительных профилей.
     * Возвращает число профилей, в которых запись осталась из-за ошибки или параллельного изменения файла.
     */
    private async removeCollectors(): Promise<number> {
        let remaining = 0;
        for (const directory of this.allDirectories()) {
            try {
                if (!(await this.removeOne(directory))) remaining++;
            } catch (error) {
                remaining++;
                this.log('[Claude limits] StatusLine collector removal failed for ' + this.describe(directory) + ': '
                    + (error instanceof Error ? error.message : String(error)));
            }
        }
        return remaining;
    }

    /**
     * Удаляет из settings.json профиля только ключ `statusLine`, команда которого содержит маркер сборщика.
     * Чужой statusLine и остальные ключи не меняются. Возвращает `true`, если записи сборщика в файле нет,
     * и `false`, если её не удалось снять.
     */
    private async removeOne(directory: string): Promise<boolean> {
        const file = path.join(directory, CONFIG_FILE);
        const previous = await readSettingsText(file);
        if (previous === null || !previous.includes(MANAGED_MARKER)) return true;
        let settings: Record<string, unknown>;
        try {
            settings = parseSettingsObject(previous);
        } catch {
            this.log('[Claude limits] Existing settings.json cannot be safely updated; collector kept in '
                + this.describe(directory));
            return false;
        }
        if (!isManagedStatusLine(settings.statusLine)) return true;
        const { statusLine: _removed, ...rest } = settings;
        if (!(await replaceSettingsFile(file, previous, JSON.stringify(rest, null, 2) + '\n'))) {
            this.log('[Claude limits] settings.json changed during collector removal; '
                + this.describe(directory) + ' kept');
            return false;
        }
        this.log('[Claude limits] Removed the Prompt Manager statusLine collector from ' + this.describe(directory));
        return true;
    }

    /**
     * Обработчик команды `promptManager.claude.removeStatusLineCollector`: выключает сборщик в глобальных настройках,
     * снимает его записи из settings.json всех профилей Claude и сообщает результат.
     */
    private async removeCollectorByCommand(): Promise<void> {
        const api = this.vscodeApi;
        if (!api) return;
        try {
            await api.workspace.getConfiguration(SETTING_SECTION)
                .update(SETTING_KEY, false, api.ConfigurationTarget.Global);
            this.configured.clear();
            const remaining = await this.exclusive(() => this.removeCollectors());
            if (remaining) {
                void api.window.showWarningMessage('Сборщик statusLine Claude Code отключён, но его запись осталась '
                    + 'в settings.json профилей Claude: ' + remaining + '. '
                    + 'Файл изменён другим процессом или повреждён; подробности — в журнале Prompt Manager.');
            } else if (this.isEnabled()) {
                void api.window.showWarningMessage('Сборщик statusLine Claude Code удалён, но настройка '
                    + SETTING_SECTION + '.' + SETTING_KEY + ' включена в рабочей области и вернёт его.');
            } else {
                void api.window.showInformationMessage(
                    'Сборщик statusLine Claude Code отключён и удалён из настроек всех профилей Claude.');
            }
        } catch (error) {
            void api.window.showErrorMessage('Не удалось удалить сборщик statusLine Claude Code: '
                + (error instanceof Error ? error.message : String(error)));
        }
    }

    /** Останавливает дальнейшие проходы настройки и освобождает подписки и команду. */
    dispose(): void {
        this.disposed = true;
        for (const d of this.disposables) d.dispose();
    }
}
