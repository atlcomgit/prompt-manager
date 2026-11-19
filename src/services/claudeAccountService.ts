import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { promises as fs, existsSync } from 'fs';
import { spawn } from 'child_process';

/** Профиль Claude Code: отдельный каталог конфигурации `CLAUDE_CONFIG_DIR` и сведения о его авторизации. */
export interface ClaudeProfile {
    id: string;
    label: string;
    email: string | null;
    plan: string | null;
    directory: string;
    loggedIn: boolean;
}
/**
 * Состояние профилей в `globalState`, общее для всех окон VS Code.
 * `pendingRestart` и `pendingPid` отмечают переключение профиля, ожидающее перезапуска Extension Host.
 */
interface ClaudeSavedState {
    profiles: ClaudeProfile[];
    pendingRestart: boolean;
    pendingPid?: number;
}
/**
 * Сведения о профилях для интерфейса без путей к каталогам. `externalConfigDir` означает, что Claude Code
 * использует `CLAUDE_CONFIG_DIR`, не принадлежащий ни одному профилю Prompt Manager.
 */
export interface ClaudeProfileView {
    profiles: Array<Omit<ClaudeProfile, 'directory'>>;
    activeId: string | null;
    adding: boolean;
    pendingRestart: boolean;
    externalConfigDir: boolean;
    issue: string | null;
}
/** Результат `claude auth status --json`: только признак входа, почта и тариф. */
interface ClaudeAuthStatus {
    loggedIn: boolean;
    email?: string;
    planTier?: string;
    subscriptionType?: string;
}
/** Ключ состояния профилей в `globalState`. */
const STATE_KEY = 'promptManager.claudeProfiles.v1';
/** Переменная окружения Claude Code с каталогом конфигурации профиля. */
const CONFIG_VAR = 'CLAUDE_CONFIG_DIR';
/**
 * Формирует значение `claudeCode.environmentVariables`: сохраняет все чужие переменные и изменяет только
 * `CLAUDE_CONFIG_DIR`. При `directory === null` переменная удаляется, и Claude Code использует `~/.claude`.
 */
export function buildClaudeEnvironmentVariables(
    existing: ReadonlyArray<{ name?: string; value?: string }>,
    directory: string | null,
): Array<{ name?: string; value?: string }> {
    const unchanged = existing.filter(item => item?.name !== CONFIG_VAR);
    return directory === null ? unchanged : [...unchanged, { name: CONFIG_VAR, value: directory }];
}

/** Предельное время проверки авторизации через Claude CLI, мс. */
const AUTH_TIMEOUT_MS = 15000;
/** Интервал проверки завершения входа в терминале, мс. */
const LOGIN_POLL_MS = 2500;
/** Предельное время ожидания входа в терминале, мс. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * Возвращает путь к Claude CLI из установленного расширения Claude Code, а если его нет — имя `claude`
 * для поиска в PATH.
 * Наличие файла проверяется при каждом вызове, поэтому результат учитывает установку расширения после активации.
 */
export function findClaudeExecutable(): string {
    const extensionRoot = vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath;
    if (extensionRoot) {
        const nativeBinary = path.join(extensionRoot, 'resources', 'native-binary',
            process.platform === 'win32' ? 'claude.exe' : 'claude');
        if (existsSync(nativeBinary)) return nativeBinary;
    }
    return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

/** Экранирует аргумент для командной оболочки терминала: cmd в Windows и POSIX-оболочки в остальных системах. */
function shellQuote(value: string): string {
    if (process.platform === 'win32') return '"' + value.replace(/"/g, '""') + '"';
    return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Проверяет авторизацию профиля официальной командой `claude auth status --json`.
 * Файлы учётных данных не читаются, stderr не сохраняется; ключи API из окружения удаляются, чтобы проверялся
 * именно указанный каталог. Отклоняется при ошибке запуска, превышении 15 секунд или некорректном ответе.
 */
async function claudeAuthStatus(directory: string): Promise<ClaudeAuthStatus> {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        // Авторизация должна определяться проверяемым профилем, а не ключом API из окружения оболочки.
        for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
            delete env[name];
        }
        // С явным ~/.claude Claude хранит .claude.json в другом месте, поэтому для основного профиля
        // переменная снимается.
        if (directory === path.join(os.homedir(), '.claude')) delete env.CLAUDE_CONFIG_DIR;
        else env.CLAUDE_CONFIG_DIR = directory;
        const child = spawn(findClaudeExecutable(), ['auth', 'status', '--json'], {
            cwd: os.homedir(),
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let output = '';
        let finished = false;
        const timer = setTimeout(() => {
            child.kill();
            finish(new Error('Истекло время проверки авторизации Claude.'));
        }, AUTH_TIMEOUT_MS);
        /** Завершает проверку один раз: снимает таймер и передаёт результат или ошибку. */
        function finish(error?: Error, value?: ClaudeAuthStatus): void {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value || { loggedIn: false });
        }
        child.stdout.on('data', chunk => {
            output += String(chunk);
            if (output.length > 48_000) {
                child.kill();
                finish(new Error('Неожиданный размер ответа Claude CLI.'));
            }
        });
        // stderr может содержать личные сведения аккаунта и не сохраняется.
        child.stderr.resume();
        child.once('error', error => finish(error));
        child.once('close', () => {
            try {
                const parsed = JSON.parse(output);
                finish(undefined, {
                    loggedIn: parsed.loggedIn === true,
                    email: typeof parsed.email === 'string' ? parsed.email : undefined,
                    planTier: typeof parsed.planTier === 'string' ? parsed.planTier : undefined,
                    subscriptionType: typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : undefined,
                });
            } catch {
                finish(new Error('Claude CLI не вернул корректный статус авторизации.'));
            }
        });
    });
}

/**
 * Управляет профилями Claude Code: добавлением через официальный вход в отдельном каталоге конфигурации,
 * переключением `claudeCode.environmentVariables`, переименованием и удалением.
 * Список профилей хранится в `globalState` и меняется из нескольких окон VS Code, поэтому каждое чтение и изменение
 * начинается с актуального значения `globalState`, а не с копии, полученной при создании сервиса.
 */
export class ClaudeAccountService implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    /** Событие изменения профилей, выбора, ошибки или состояния входа. */
    readonly onDidChange = this.emitter.event;
    /** Последнее прочитанное состояние; перед использованием обновляется из `globalState`. */
    private state: ClaudeSavedState;
    private readonly profilesRoot: string;
    private readonly defaultDir = path.join(os.homedir(), '.claude');
    private issue: string | null = null;
    private adding = false;
    private loginTimer: ReturnType<typeof setInterval> | null = null;
    private loginTerminal: vscode.Terminal | null = null;
    /** Каталог незавершённого входа; `null`, когда вход не ожидается или уже завершается. */
    private loginDirectory: string | null = null;
    private loginPolling = false;
    /** Подписка на закрытие терминала входа. */
    private loginCloseSubscription: vscode.Disposable | null = null;
    private mutation: Promise<unknown> = Promise.resolve();
    private disposed = false;

    /** Сохраняет контекст расширения; профили читаются из `globalState` при каждом обращении. */
    constructor(private readonly context: vscode.ExtensionContext) {
        this.profilesRoot = path.join(context.globalStorageUri.fsPath, 'claude-profiles');
        this.state = this.loadState();
    }

    /**
     * Читает состояние профилей из `globalState` и возвращает независимую копию.
     * Другое окно VS Code могло изменить список после создания сервиса.
     */
    private loadState(): ClaudeSavedState {
        const saved = this.context.globalState.get<ClaudeSavedState>(STATE_KEY);
        return saved && Array.isArray(saved.profiles)
            ? {
                profiles: saved.profiles.filter(p => p && typeof p.id === 'string').map(p => ({ ...p })),
                pendingRestart: !!saved.pendingRestart,
                pendingPid: saved.pendingPid,
            }
            : { profiles: [], pendingRestart: false };
    }

    /** Заменяет локальное состояние актуальным значением из `globalState` и возвращает его. */
    private reload(): ClaudeSavedState {
        this.state = this.loadState();
        return this.state;
    }

    /**
     * Применяет изменение к актуальному состоянию из `globalState` и сохраняет результат.
     * Чтение и изменение выполняются синхронно, поэтому профили, добавленные или удалённые другим окном,
     * не теряются и не восстанавливаются.
     */
    private async modify<T>(change: (state: ClaudeSavedState) => T): Promise<T> {
        const result = change(this.reload());
        await this.save();
        return result;
    }

    /** Возвращает настройки расширения Claude Code. */
    private config(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('claudeCode');
    }
    /** Определяет каталог конфигурации, который использует Claude Code: из его настроек, окружения или `~/.claude`. */
    private selectedDirectory(): string {
        const entries = this.config().get<Array<{ name?: string; value?: string }>>('environmentVariables') || [];
        const value = entries.find(e => e?.name === CONFIG_VAR)?.value;
        const selected = value || process.env.CLAUDE_CONFIG_DIR;
        return selected ? path.resolve(selected.replace(/^~(?=\/|$)/, os.homedir())) : this.defaultDir;
    }
    /** Возвращает идентификатор профиля, выбранного в Claude Code, по текущему состоянию `this.state`. */
    private getActiveId(): string | null {
        const chosen = this.selectedDirectory();
        return this.state.profiles.find(p => path.resolve(p.directory) === chosen)?.id || null;
    }

    /** Возвращает сведения о профилях для интерфейса по актуальному состоянию `globalState`. */
    getView(): ClaudeProfileView {
        this.reload();
        const activeId = this.getActiveId();
        return {
            profiles: this.state.profiles.map(({ directory: _directory, ...entry }) => ({ ...entry })),
            activeId,
            pendingRestart: this.state.pendingRestart,
            adding: this.adding,
            issue: this.issue,
            externalConfigDir: activeId === null && this.selectedDirectory() !== this.defaultDir,
        };
    }

    /**
     * Возвращает каталоги профилей по актуальному состоянию `globalState`: по умолчанию только с выполненным входом,
     * с `includeSignedOut` — все профили.
     */
    getProfileDirectories(includeSignedOut = false): Array<{ id: string; directory: string }> {
        return this.reload().profiles.filter(p => includeSignedOut || p.loggedIn)
            .map(({ id, directory }) => ({ id, directory }));
    }

    /** Записывает `this.state` в `globalState` и оповещает подписчиков. */
    private async save(): Promise<void> {
        await this.context.globalState.update(STATE_KEY, this.state);
        this.emitter.fire();
    }

    /**
     * Готовит состояние при активации: сбрасывает отметку о перезапуске, оставленную другим процессом,
     * добавляет основной профиль `~/.claude` и обновляет сведения об авторизации всех профилей.
     */
    async initialize(): Promise<void> {
        await this.modify(state => {
            if (state.pendingRestart && state.pendingPid !== undefined && state.pendingPid !== process.pid) {
                state.pendingRestart = false;
                state.pendingPid = undefined;
            }
            const profile = state.profiles.find(p => p.id === 'default');
            if (!profile) {
                state.profiles.unshift({
                    id: 'default', label: 'Основной Claude', email: null,
                    plan: null, directory: this.defaultDir, loggedIn: false,
                });
            } else {
                profile.directory = this.defaultDir;
            }
        });
        await this.refreshAccounts();
    }

    /**
     * Проверяет авторизацию каждого профиля через Claude CLI и сохраняет почту, тариф и признак входа.
     * Результаты применяются к перечитанному после проверок списку: профили, добавленные другим окном за это время,
     * сохраняются, а удалённые не восстанавливаются. Ошибка проверки записывается в `issue`.
     */
    async refreshAccounts(): Promise<void> {
        if (this.disposed) return;
        this.issue = null;
        const checked = new Map<string, { directory: string; info: ClaudeAuthStatus }>();
        for (const profile of this.reload().profiles) {
            try {
                const info = await claudeAuthStatus(profile.directory);
                checked.set(profile.id, { directory: profile.directory, info });
            } catch (error) {
                this.issue = error instanceof Error ? error.message : String(error);
            }
        }
        if (this.disposed) return;
        await this.modify(state => {
            for (const profile of state.profiles) {
                const result = checked.get(profile.id);
                if (!result || result.directory !== profile.directory) continue;
                const info = result.info;
                profile.loggedIn = info.loggedIn;
                profile.email = info.email || profile.email;
                profile.plan = info.planTier || info.subscriptionType || profile.plan;
                if (profile.loggedIn && profile.id === 'default' && profile.label === 'Основной Claude' && info.email) {
                    profile.label = info.email;
                }
            }
        });
    }

    /**
     * Начинает добавление аккаунта: создаёт отдельный каталог конфигурации с правами 0700 и открывает терминал
     * с официальной командой `claude auth login`. Завершение входа проверяется каждые 2,5 секунды до 10 минут.
     * При закрытии терминала выполняется последняя проверка: при выполненном входе профиль сохраняется,
     * иначе вход завершается с ошибкой в `issue`, а каталог удаляется.
     */
    async addAccount(): Promise<void> {
        if (this.adding) throw new Error('Авторизация Claude уже выполняется.');
        await fs.mkdir(this.profilesRoot, { recursive: true, mode: 0o700 });
        const id = crypto.randomUUID();
        const directory = path.join(this.profilesRoot, id);
        await fs.mkdir(directory, { mode: 0o700 });
        this.issue = null;
        this.adding = true;
        this.loginDirectory = directory;
        this.emitter.fire();
        const terminal = vscode.window.createTerminal({
            name: 'Claude Code — подключение аккаунта',
            cwd: os.homedir(),
            env: {
                CLAUDE_CONFIG_DIR: directory,
                ANTHROPIC_API_KEY: null,
                ANTHROPIC_AUTH_TOKEN: null,
                CLAUDE_CODE_OAUTH_TOKEN: null,
            },
            isTransient: true,
        });
        this.loginTerminal = terminal;
        this.loginCloseSubscription = vscode.window.onDidCloseTerminal(closed => {
            if (closed === terminal) void this.handleLoginTerminalClosed(id, directory);
        });
        terminal.show(true);
        terminal.sendText(shellQuote(findClaudeExecutable()) + ' auth login');
        const started = Date.now();
        this.loginTimer = setInterval(() => {
            if (this.loginPolling || this.disposed) return;
            this.loginPolling = true;
            void (async () => {
                if (this.loginDirectory !== directory) return;
                if (Date.now() - started > LOGIN_TIMEOUT_MS) {
                    if (!this.claimLogin(directory)) return;
                    this.issue = 'Авторизация Claude не завершилась за 10 минут.';
                    await this.finishLogin(false, directory);
                    return;
                }
                let info: ClaudeAuthStatus;
                try {
                    info = await claudeAuthStatus(directory);
                } catch {
                    // Во время входа проверка может завершиться ошибкой; следующая попытка повторит её.
                    return;
                }
                if (!info.loggedIn || !this.claimLogin(directory)) return;
                await this.acceptLogin(id, directory, info);
            })().finally(() => { this.loginPolling = false; });
        }, LOGIN_POLL_MS);
    }

    /**
     * Обрабатывает закрытие терминала входа: останавливает опрос и один раз проверяет авторизацию.
     * При выполненном входе сохраняет профиль, иначе завершает вход с понятной ошибкой и удаляет каталог.
     */
    private async handleLoginTerminalClosed(id: string, directory: string): Promise<void> {
        if (this.disposed || this.loginDirectory !== directory) return;
        if (this.loginTimer) clearInterval(this.loginTimer);
        this.loginTimer = null;
        const info = await claudeAuthStatus(directory).catch(() => null);
        // Опрос, начатый до закрытия терминала, мог уже сохранить профиль.
        if (!this.claimLogin(directory)) return;
        if (info?.loggedIn) {
            await this.acceptLogin(id, directory, info);
            return;
        }
        this.issue = 'Терминал входа закрыт до завершения авторизации Claude. Аккаунт не добавлен.';
        await this.finishLogin(false, directory);
    }

    /**
     * Синхронно забирает незавершённый вход для каталога `directory`, чтобы опрос, таймаут и закрытие терминала
     * не завершили его дважды. Возвращает `false`, если вход уже завершается или сервис освобождён.
     */
    private claimLogin(directory: string): boolean {
        if (this.disposed || this.loginDirectory !== directory) return false;
        this.loginDirectory = null;
        return true;
    }

    /**
     * Сохраняет профиль после успешного входа, сообщает о добавлении аккаунта и завершает ожидание.
     * Если профиль не удалось сохранить, вход завершается с ошибкой в `issue`. Исключений не бросает.
     */
    private async acceptLogin(id: string, directory: string, info: ClaudeAuthStatus): Promise<void> {
        try {
            await this.modify(state => {
                if (state.profiles.some(p => p.id === id)) return;
                state.profiles.push({
                    id,
                    directory,
                    label: info.email || 'Claude ' + String(state.profiles.length),
                    email: info.email || null,
                    plan: info.planTier || info.subscriptionType || null,
                    loggedIn: true,
                });
            });
        } catch (error) {
            this.issue = 'Не удалось сохранить профиль Claude: '
                + (error instanceof Error ? error.message : String(error));
            await this.finishLogin(false, directory);
            return;
        }
        void vscode.window.showInformationMessage(
            'Claude Code: аккаунт добавлен. Для переключения выберите его на странице «Аккаунты».');
        await this.finishLogin(true, directory);
    }

    /**
     * Завершает ожидание входа: останавливает опрос, снимает подписку и закрывает терминал.
     * При неудаче удаляет каталог входа, если ни одно окно не сохранило в нём профиль.
     */
    private async finishLogin(success: boolean, directory: string): Promise<void> {
        if (this.loginTimer) clearInterval(this.loginTimer);
        this.loginTimer = null;
        this.loginCloseSubscription?.dispose();
        this.loginCloseSubscription = null;
        this.adding = false;
        this.loginDirectory = null;
        this.loginTerminal?.dispose();
        this.loginTerminal = null;
        if (!success && !this.loadState().profiles.some(p => p.directory === directory)) {
            await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }
        this.emitter.fire();
    }

    /**
     * Выбирает профиль для новых сеансов Claude Code, меняя только `CLAUDE_CONFIG_DIR`
     * в глобальной настройке `claudeCode.environmentVariables`. Переключения в одном окне выполняются по очереди.
     * Отклоняется, если профиль не авторизован, настройка переопределена в рабочей области, задан другой способ
     * авторизации или `CLAUDE_CONFIG_DIR` пришёл из окружения процесса. Если Claude Code не принял значение,
     * прежняя настройка восстанавливается. После переключения сохраняет отметку о необходимом перезапуске.
     */
    async switchAccount(id: string): Promise<{ applied: boolean; message: string }> {
        const run = this.mutation.then(async () => {
            const profile = this.reload().profiles.find(p => p.id === id);
            if (!profile) throw new Error('Профиль Claude не найден.');
            const auth = await claudeAuthStatus(profile.directory);
            if (!auth.loggedIn) throw new Error('Аккаунт Claude требует повторной авторизации.');
            if (this.getActiveId() === id && !this.state.pendingRestart) {
                return { applied: true, message: 'Этот аккаунт Claude уже выбран.' };
            }
            const config = this.config();
            const inspect = config.inspect<Array<{ name?: string; value?: string }>>('environmentVariables');
            if (inspect?.workspaceValue !== undefined || inspect?.workspaceFolderValue !== undefined) {
                throw new Error('В рабочей области определён claudeCode.environmentVariables. '
                    + 'Уберите конфликтующую настройку перед переключением.');
            }
            const before = inspect?.globalValue;
            const otherAuth = (before || []).find(e =>
                ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(e?.name || ''));
            if (otherAuth) {
                throw new Error('Настройка ' + otherAuth.name + ' переопределяет авторизацию Claude. '
                    + 'Отключите её перед переключением профиля ChatGPT/Claude.');
            }
            if (profile.id === 'default' && process.env.CLAUDE_CONFIG_DIR) {
                throw new Error('CLAUDE_CONFIG_DIR задан в окружении VS Code. '
                    + 'Для безопасного возврата к основному профилю сначала уберите его из окружения процесса.');
            }
            const next = buildClaudeEnvironmentVariables(
                before || [], profile.id === 'default' ? null : profile.directory);
            await config.update('environmentVariables', next.length ? next : undefined,
                vscode.ConfigurationTarget.Global);
            if (this.getActiveId() !== id) {
                // Неподтверждённое значение откатывается, чтобы Claude Code не остался с неизвестным профилем.
                await Promise.resolve(config.update('environmentVariables', before, vscode.ConfigurationTarget.Global))
                    .catch(() => undefined);
                throw new Error('Claude Code не принял новый профиль. Настройка восстановлена.');
            }
            await this.modify(state => {
                state.pendingRestart = true;
                state.pendingPid = process.pid;
            });
            return {
                applied: false,
                message: 'Для новых сеансов Claude выбран «' + profile.label
                    + '». Уже открытые сеансы сохраняют прежнюю авторизацию. '
                    + 'Для полного применения может потребоваться Reload Window.',
            };
        });
        this.mutation = run.then(() => undefined, () => undefined);
        return run;
    }

    /** Переименовывает профиль; название обрезается до 80 символов и не может быть пустым. */
    async renameAccount(id: string, label: string): Promise<void> {
        const text = label.trim().slice(0, 80);
        if (!text) throw new Error('Название не может быть пустым.');
        await this.modify(state => {
            const profile = state.profiles.find(p => p.id === id);
            if (!profile) throw new Error('Аккаунт Claude не найден.');
            profile.label = text;
        });
    }

    /**
     * Удаляет дополнительный профиль и его каталог конфигурации с авторизацией.
     * Основной, выбранный и внешний профили не удаляются. Удаление сохраняется в `globalState` поверх актуального
     * списка, поэтому профиль исчезает во всех окнах.
     */
    async removeAccount(id: string): Promise<void> {
        if (id === 'default') throw new Error('Основной профиль Claude нельзя удалить.');
        const profile = this.reload().profiles.find(p => p.id === id);
        if (this.getActiveId() === id) throw new Error('Сначала выберите другой профиль Claude.');
        if (!profile) throw new Error('Профиль Claude не найден.');
        // Удаляются только каталоги, созданные расширением, и никогда внешний путь.
        const expected = path.join(this.profilesRoot, id);
        if (profile.directory !== expected || !/^[0-9a-f-]{36}$/i.test(id)) {
            throw new Error('Нельзя удалить внешний каталог Claude.');
        }
        await fs.rm(expected, { recursive: true, force: true });
        await this.modify(state => {
            state.profiles = state.profiles.filter(p => p.id !== id);
        });
    }

    /**
     * Останавливает ожидание входа, закрывает терминал и освобождает событие.
     * Каталог незавершённого входа удаляется, чтобы после перезагрузки не оставалась неучтённая авторизация.
     */
    dispose(): void {
        this.disposed = true;
        if (this.loginTimer) clearInterval(this.loginTimer);
        this.loginTimer = null;
        this.loginCloseSubscription?.dispose();
        this.loginCloseSubscription = null;
        const directory = this.loginDirectory;
        this.loginDirectory = null;
        this.loginTerminal?.dispose();
        this.loginTerminal = null;
        // Незавершённый вход не должен оставлять неучтённый каталог OAuth после перезагрузки расширения.
        if (directory && !this.loadState().profiles.some(profile => profile.directory === directory)) {
            void fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }
        this.emitter.dispose();
    }
}
