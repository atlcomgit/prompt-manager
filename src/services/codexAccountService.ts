import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { promises as fs, existsSync } from 'fs';

/** Сохранённый профиль Codex: метаданные без токенов; сама авторизация хранится в SecretStorage. */
export interface CodexAccountProfile {
    id: string;
    label: string;
    identity: string;
    createdAt: string;
}
/** Состояние профилей в общем для всех окон VS Code `globalState`. */
interface AccountStorage {
    profiles: CodexAccountProfile[];
    /** Последний выбранный профиль; используется, только пока identity файла auth.json ещё не прочитан. */
    activeId: string | null;
    pendingRestart: boolean;
    pendingHostPid?: number;
}
/** Представление профилей для страницы «Аккаунты» и строки состояния. */
export interface CodexAccountView extends AccountStorage {
    adding: boolean;
    issue: string | null;
}
/** Результат переключения: `applied` — уже применено открытыми процессами Codex без перезапуска. */
export interface CodexSwitchResult {
    switched: boolean;
    applied: boolean;
    message: string;
}
/**
 * Итог возврата обновлённой авторизации в основной auth.json:
 * `written` — файл заменён; `unchanged` — содержимое не менялось; `disk-changed` — файл на диске уже
 * изменён другим процессом; `other-account` — данные другого аккаунта; `invalid` — повреждённый JSON.
 */
export type CodexAuthReturnResult = 'written' | 'unchanged' | 'disk-changed' | 'other-account' | 'invalid';
const STATE_KEY = 'promptManager.codexAccounts.v1';
const SECRET_PREFIX = 'promptManager.codexAccount.';
/** Новое пустое состояние; отдельный массив профилей для каждого вызова исключает общий изменяемый массив. */
function emptyState(): AccountStorage {
    return { profiles: [], activeId: null, pendingRestart: false };
}
/** Число опросов файла входа с интервалом 2 с (около 8 минут) до отказа по времени. */
const LOGIN_MAX_ATTEMPTS = 240;
const LOGIN_POLL_INTERVAL_MS = 2000;

/**
 * Определяет аккаунт по содержимому auth.json: account_id, затем e-mail из ID-токена, затем хэш файла.
 * Возвращает также подпись профиля (e-mail или «ChatGPT»). Бросает ошибку для неверного JSON
 * и для файла без данных авторизации. Тест: tests/codexAccounts.test.ts.
 */
export function identityOf(raw: string): { identity: string; label: string } {
    const auth = JSON.parse(raw) as Record<string, any>;
    const tokens = auth.tokens || {};
    let claims: Record<string, any> = {};
    try {
        const idToken = String(tokens.id_token || '');
        claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    } catch { /* Старые форматы входа Codex могут не содержать ID-токен. */ }
    const email = [claims.email, claims['https://api.openai.com/profile']?.email, auth.email]
        .find(v => typeof v === 'string' && v.includes('@')) as string | undefined;
    const accountId = tokens.account_id || auth.account_id || claims.sub;
    if (!tokens.access_token && !auth.OPENAI_API_KEY && !tokens.id_token) {
        throw new Error('Профиль Codex не содержит данных авторизации.');
    }
    const identity = String(accountId || email || crypto.createHash('sha256').update(raw).digest('hex'));
    return { identity, label: email || 'ChatGPT' };
}

/** Каталог настроек Codex: `CODEX_HOME` или `~/.codex`, как у самого Codex CLI. */
export function resolveCodexHome(): string {
    return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Ключ SecretStorage, под которым хранится auth.json профиля. */
function makeSecretKey(id: string): string { return SECRET_PREFIX + id; }

/**
 * Атомарно заменяет файл авторизации: пишет временный файл с правами 0600 в той же папке и переименовывает.
 * Если передано `precondition`, оно проверяется непосредственно перед заменой; при `false` файл
 * не заменяется и функция возвращает `false`. Временный файл удаляется в любом случае.
 */
async function atomicAuthWrite(
    destination: string,
    contents: string,
    precondition?: () => Promise<boolean>,
): Promise<boolean> {
    const dir = path.dirname(destination);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, '.auth.prompt-manager-' + crypto.randomUUID() + '.tmp');
    try {
        await fs.writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
        await fs.chmod(temp, 0o600);
        // Сравнение выполняется после подготовки файла, чтобы между проверкой и заменой не было записи на диск.
        if (precondition && !(await precondition())) return false;
        await fs.rename(temp, destination);
        return true;
    } finally {
        await fs.unlink(temp).catch(() => undefined);
    }
}

/** Читает файл как UTF-8; для отсутствующего файла возвращает `null`, прочие ошибки пробрасывает. */
async function readOptionalFile(file: string): Promise<string | null> {
    try { return await fs.readFile(file, 'utf8'); }
    catch (error: any) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

/**
 * Возвращает в основной auth.json авторизацию, обновлённую временным процессом Codex (например,
 * после обновления токенов при запросе лимитов). Запись выполняется, только если это тот же аккаунт
 * и файл на диске всё ещё совпадает с исходным текстом `original`: иначе файл уже обновил сам Codex
 * или выбран другой аккаунт, и новые данные не должны его затирать. Тест: tests/codexRateLimit.test.ts.
 */
export async function returnRefreshedCodexAuth(
    authPath: string,
    original: string,
    refreshed: string,
): Promise<CodexAuthReturnResult> {
    if (refreshed === original) return 'unchanged';
    let sameAccount: boolean;
    try { sameAccount = identityOf(refreshed).identity === identityOf(original).identity; }
    catch { return 'invalid'; }
    if (!sameAccount) return 'other-account';
    const written = await atomicAuthWrite(authPath, refreshed,
        async () => (await readOptionalFile(authPath)) === original);
    return written ? 'written' : 'disk-changed';
}

/** Находит исполняемый файл Codex из расширения `openai.chatgpt`, иначе полагается на `codex` из PATH. */
export function findCodexExecutable(): string {
    const folder = vscode.extensions.getExtension('openai.chatgpt')?.extensionPath;
    if (folder) {
        const platform = process.platform === 'win32'
            ? (process.arch === 'arm64' ? 'windows-arm64' : 'windows-x86_64')
            : process.platform === 'darwin'
                ? (process.arch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64')
                : (process.arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64');
        const exe = path.join(folder, 'bin', platform, process.platform === 'win32' ? 'codex.exe' : 'codex');
        if (existsSync(exe)) return exe;
    }
    return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

/**
 * Управляет профилями Codex: сохраняет авторизации в SecretStorage, переключает общий auth.json,
 * подключает новые аккаунты через `codex login`. Метаданные профилей общие для всех окон VS Code,
 * поэтому перед каждым изменением и при построении представления они перечитываются из `globalState`,
 * а активный профиль определяется по identity файла auth.json на диске.
 * Тесты: tests/codexAccounts.test.ts, tests/codexRateLimit.test.ts.
 */
export class CodexAccountService implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private state: AccountStorage = emptyState();
    private adding = false;
    private issue: string | null = null;
    private pendingLoginDir: string | null = null;
    private pendingLoginTerminal: vscode.Terminal | null = null;
    private pendingLoginTimer: ReturnType<typeof setInterval> | null = null;
    /** Подписка на закрытие терминала входа; освобождается при завершении входа. */
    private pendingLoginCloseListener: vscode.Disposable | null = null;
    /** Терминал входа закрыт: следующий опрос последний. */
    private loginTerminalClosed = false;
    /** Закрытие произошло во время опроса: после него нужен ещё один, финальный опрос. */
    private loginFinalPollQueued = false;
    private loginAttempts = 0;
    private loginPolling = false;
    /**
     * Identity из последнего чтения auth.json: `undefined` — файл ещё не читался,
     * `null` — файла нет или он без данных авторизации.
     */
    private diskIdentity: string | null | undefined = undefined;
    /** Фоновая регистрация аккаунта, найденного в auth.json, чтобы не запускать её параллельно. */
    private diskSync: Promise<void> | null = null;
    private readonly home: string;
    private readonly authPath: string;
    private operation: Promise<unknown> = Promise.resolve();

    /** Читает сохранённые профили; файловых операций и записи в хранилища не выполняет. */
    constructor(private readonly context: vscode.ExtensionContext) {
        this.home = resolveCodexHome();
        this.authPath = path.join(this.home, 'auth.json');
        this.reload();
    }

    /**
     * Перечитывает профили из общего `globalState`: другое окно VS Code могло добавить, удалить,
     * переименовать профиль или переключить аккаунт. Если сохранённых данных нет, оставляет текущие.
     */
    private reload(): void {
        const saved = this.context.globalState.get<AccountStorage>(STATE_KEY);
        if (!saved || !Array.isArray(saved.profiles)) return;
        this.state = {
            profiles: saved.profiles.map(profile => ({ ...profile })),
            activeId: saved.activeId || null,
            pendingRestart: Boolean(saved.pendingRestart),
            pendingHostPid: saved.pendingHostPid,
        };
    }

    /** Сохраняет текущее состояние в `globalState` и уведомляет подписчиков. */
    private async commit(): Promise<void> {
        await this.context.globalState.update(STATE_KEY, this.state);
        this.changed.fire();
    }

    /**
     * Применяет изменение к свежей копии общего состояния и сохраняет её. Изменение синхронное,
     * поэтому между перечитыванием и записью нет ожиданий, в которые могла бы вклиниться запись этого окна.
     * Если `change` бросает ошибку, состояние не сохраняется.
     */
    private async update<T>(change: (state: AccountStorage) => T): Promise<T> {
        this.reload();
        const result = change(this.state);
        await this.commit();
        return result;
    }

    /** Выполняет задачу после предыдущих операций с общим auth.json этого окна. */
    private serialize<T>(task: () => Promise<T>): Promise<T> {
        const run = this.operation.then(task);
        this.operation = run.then(() => undefined, () => undefined);
        return run;
    }

    /** Id профиля, соответствующего auth.json на диске; до первого чтения диска — сохранённый `activeId`. */
    private resolveActiveId(): string | null {
        if (this.diskIdentity === undefined) return this.state.activeId;
        if (this.diskIdentity === null) return null;
        return this.state.profiles.find(p => p.identity === this.diskIdentity)?.id ?? null;
    }

    /** Возвращает актуальные профили из общего состояния и активный профиль по последнему чтению auth.json. */
    getView(): CodexAccountView {
        this.reload();
        return {
            ...this.state,
            activeId: this.resolveActiveId(),
            profiles: [...this.state.profiles],
            adding: this.adding,
            issue: this.issue,
        };
    }

    /** Каталог CODEX_HOME, с которым работают Codex и этот сервис. */
    getCodexHome(): string { return this.home; }

    /** Читает основной auth.json и запоминает его identity для `getView`; `null`, если файла нет. */
    private async readDiskAuth(): Promise<string | null> {
        const raw = await readOptionalFile(this.authPath);
        if (raw === null) {
            this.diskIdentity = null;
            return null;
        }
        try { this.diskIdentity = identityOf(raw).identity; }
        catch { this.diskIdentity = null; }
        return raw;
    }

    /**
     * Снимает признак ожидания перезапуска, если расширения VS Code уже перезапущены (другой pid процесса),
     * и регистрирует аккаунт из auth.json. Повторный вызов безопасен: можно вызывать после установки
     * расширения Codex.
     */
    async initialize(): Promise<void> {
        this.reload();
        if (this.state.pendingRestart && this.state.pendingHostPid !== undefined
            && this.state.pendingHostPid !== process.pid) {
            await this.update(state => {
                state.pendingRestart = false;
                state.pendingHostPid = undefined;
            });
        }
        await this.syncDiskAccount();
    }

    /**
     * Сохраняет авторизацию под профилем с тем же identity (или создаёт профиль) и возвращает профиль.
     * Секрет записывается до сохранения метаданных; если другое окно за это время создало профиль
     * того же аккаунта, используется его профиль, а лишний секрет удаляется.
     */
    private async saveProfileAuth(raw: string, makeActive: boolean): Promise<CodexAccountProfile> {
        const info = identityOf(raw);
        this.reload();
        const candidate = this.state.profiles.find(p => p.identity === info.identity)
            ?? {
                id: crypto.randomUUID(), label: info.label, identity: info.identity,
                createdAt: new Date().toISOString(),
            };
        // Сохранённый профиль никогда не перезаписывается авторизацией другого аккаунта.
        await this.context.secrets.store(makeSecretKey(candidate.id), raw);
        const saved = await this.update(state => {
            const existing = state.profiles.find(p => p.identity === info.identity);
            if (!existing) state.profiles.push(candidate);
            const profile = existing ?? candidate;
            if (makeActive) state.activeId = profile.id;
            return profile;
        });
        if (saved.id !== candidate.id) {
            await this.context.secrets.store(makeSecretKey(saved.id), raw);
            await this.context.secrets.delete(makeSecretKey(candidate.id));
        }
        return saved;
    }

    /** Регистрирует аккаунт из auth.json на диске как активный профиль и обновляет его секрет. */
    async syncDiskAccount(): Promise<void> {
        await this.serialize(async () => {
            const raw = await this.readDiskAuth();
            if (!raw) return;
            await this.saveProfileAuth(raw, true);
        });
    }

    /**
     * Возвращает текущий auth.json с диска: Codex мог обновить токены после последнего сохранения.
     * Если в файле аккаунт без профиля (например, вход выполнен через CLI), в фоне регистрирует его.
     */
    async getActiveAuth(): Promise<string | null> {
        const raw = await this.readDiskAuth();
        const identity = this.diskIdentity;
        if (raw && identity && !this.diskSync) {
            this.reload();
            if (!this.state.profiles.some(p => p.identity === identity)) {
                this.diskSync = this.syncDiskAccount()
                    .catch(() => undefined)
                    .finally(() => { this.diskSync = null; });
            }
        }
        return raw;
    }

    /**
     * Возвращает в auth.json авторизацию, которую обновил временный процесс Codex, и сохраняет её
     * в секрет профиля того же аккаунта. Подробные условия записи — `returnRefreshedCodexAuth`.
     * Подписчиков не уведомляет: состав профилей и активный аккаунт не меняются.
     */
    async storeRefreshedAuth(original: string, refreshed: string): Promise<CodexAuthReturnResult> {
        return this.serialize(async () => {
            const result = await returnRefreshedCodexAuth(this.authPath, original, refreshed);
            if (result !== 'written') return result;
            const identity = identityOf(refreshed).identity;
            this.diskIdentity = identity;
            this.reload();
            const profile = this.state.profiles.find(p => p.identity === identity);
            if (profile) await this.context.secrets.store(makeSecretKey(profile.id), refreshed);
            return result;
        });
    }

    /**
     * Запускает `codex login --device-auth` в отдельном терминале с временным CODEX_HOME и опрашивает
     * появившийся auth.json. Закрытие терминала вызывает финальную проверку и завершение входа.
     */
    async addAccount(): Promise<void> {
        if (this.adding) { throw new Error('Вход в Codex уже выполняется.'); }
        const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-manager-codex-login-'));
        await fs.chmod(folder, 0o700);
        this.pendingLoginDir = folder;
        this.adding = true;
        this.issue = null;
        this.loginAttempts = 0;
        this.loginTerminalClosed = false;
        this.loginFinalPollQueued = false;
        this.changed.fire();
        const terminal = vscode.window.createTerminal({
            name: 'Codex — подключение аккаунта',
            cwd: os.homedir(),
            env: { CODEX_HOME: folder },
            isTransient: true,
        });
        this.pendingLoginTerminal = terminal;
        this.pendingLoginCloseListener = vscode.window.onDidCloseTerminal(closed => {
            if (closed !== terminal || this.pendingLoginDir !== folder) return;
            this.loginTerminalClosed = true;
            if (this.loginPolling) this.loginFinalPollQueued = true;
            else this.pollLogin(folder);
        });
        terminal.show(true);
        const binary = findCodexExecutable().replace(/'/g, "'\\''");
        terminal.sendText("'" + binary + "' login --device-auth");
        this.pendingLoginTimer = setInterval(() => {
            if (!this.loginPolling) this.pollLogin(folder);
        }, LOGIN_POLL_INTERVAL_MS);
    }

    /**
     * Один опрос auth.json входа. При успехе сохраняет профиль и завершает вход. Если терминал закрыт
     * до начала опроса, опрос последний: при отсутствии файла вход завершается с понятной причиной.
     */
    private pollLogin(folder: string): void {
        if (this.pendingLoginDir !== folder) return;
        this.loginPolling = true;
        // Состояние терминала фиксируется до чтения файла: Codex записывает auth.json до своего завершения.
        const final = this.loginTerminalClosed;
        this.loginAttempts += 1;
        void (async () => {
            try {
                const auth = await fs.readFile(path.join(folder, 'auth.json'), 'utf8');
                await this.saveProfileAuth(auth, false);
                this.issue = null;
                await this.finishLogin();
                void vscode.window.showInformationMessage(
                    'Codex: аккаунт сохранён. Выберите его на странице «Аккаунты», чтобы переключиться.');
            } catch (error: any) {
                if (this.pendingLoginDir !== folder) return;
                const missing = error?.code === 'ENOENT';
                if (final) {
                    this.issue = missing
                        ? 'Терминал входа закрыт до завершения авторизации. Повторите подключение.'
                        : (error instanceof Error ? error.message : String(error));
                    await this.finishLogin();
                } else if (!missing && this.loginAttempts > 3) {
                    this.issue = error instanceof Error ? error.message : String(error);
                    await this.finishLogin();
                } else if (this.loginAttempts >= LOGIN_MAX_ATTEMPTS) {
                    this.issue = 'Время авторизации истекло. Повторите подключение.';
                    await this.finishLogin();
                }
            }
        })().finally(() => {
            this.loginPolling = false;
            if (this.loginFinalPollQueued && this.pendingLoginDir === folder) {
                this.loginFinalPollQueued = false;
                this.pollLogin(folder);
            }
        });
    }

    /** Останавливает опрос, освобождает подписку и терминал входа, удаляет временный каталог с токенами. */
    private async finishLogin(): Promise<void> {
        if (this.pendingLoginTimer) clearInterval(this.pendingLoginTimer);
        this.pendingLoginTimer = null;
        // Подписка освобождается до закрытия терминала, чтобы собственное закрытие не запускало опрос.
        this.pendingLoginCloseListener?.dispose();
        this.pendingLoginCloseListener = null;
        const folder = this.pendingLoginDir;
        this.pendingLoginDir = null;
        this.adding = false;
        this.loginFinalPollQueued = false;
        this.pendingLoginTerminal?.dispose();
        this.pendingLoginTerminal = null;
        if (folder) await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
        this.changed.fire();
    }

    /**
     * Записывает авторизацию выбранного профиля в общий auth.json. Перед заменой сохраняет текущую
     * авторизацию с диска в профиль того же аккаунта. Отказывает, если в auth.json аккаунт без профиля,
     * чтобы не потерять чужой вход. Открытые процессы Codex применяют аккаунт только после перезапуска.
     */
    async switchAccount(id: string): Promise<CodexSwitchResult> {
        // Все записи в общий CODEX_HOME выполняются последовательно.
        return this.serialize(async () => {
            this.reload();
            const profile = this.state.profiles.find(p => p.id === id);
            if (!profile) throw new Error('Аккаунт Codex не найден.');
            const oldAuth = await this.readDiskAuth();
            // Выбранность проверяется по файлу на диске: другое окно могло уже переключить аккаунт.
            const currentIdentity = oldAuth ? identityOf(oldAuth).identity : null;
            if (currentIdentity === profile.identity && !this.state.pendingRestart) {
                return { switched: false, applied: true, message: 'Аккаунт уже выбран.' };
            }
            if (oldAuth && currentIdentity) {
                const current = this.state.profiles.find(p => p.identity === currentIdentity);
                if (!current) {
                    throw new Error('Данные Codex были изменены другим расширением. '
                        + 'Обновите страницу и проверьте активный аккаунт.');
                }
                await this.context.secrets.store(makeSecretKey(current.id), oldAuth);
            }
            const nextAuth = await this.context.secrets.get(makeSecretKey(id));
            if (!nextAuth) throw new Error('Данные авторизации выбранного аккаунта отсутствуют.');
            if (identityOf(nextAuth).identity !== profile.identity) {
                throw new Error('Профиль не соответствует сохранённой авторизации.');
            }
            try {
                await atomicAuthWrite(this.authPath, nextAuth);
                this.diskIdentity = profile.identity;
                await this.update(state => {
                    state.activeId = id;
                    state.pendingRestart = true;
                    state.pendingHostPid = process.pid;
                });
            } catch (error) {
                this.diskIdentity = currentIdentity;
                if (oldAuth) await atomicAuthWrite(this.authPath, oldAuth);
                throw error;
            }

            // Без перезапуска допускается только публичная команда точечного перезапуска Codex.
            const commands = await vscode.commands.getCommands(true);
            if (commands.includes('chatgpt.restartAppServer')) {
                try {
                    await vscode.commands.executeCommand('chatgpt.restartAppServer');
                    await this.update(state => {
                        state.pendingRestart = false;
                        state.pendingHostPid = undefined;
                    });
                    return { switched: true, applied: true, message: 'Codex перезапущен, аккаунт переключён.' };
                } catch { /* Остаётся ожидание перезапуска; другие расширения не затрагиваются. */ }
            }
            return {
                switched: true, applied: false,
                message: 'Профиль выбран, но открытые процессы Codex ещё используют прежнюю авторизацию. '
                    + 'Для применения требуется перезапуск расширений или окна VS Code.',
            };
        });
    }

    /** Переименовывает профиль в общем состоянии; название обрезается до 80 символов. */
    async renameAccount(id: string, label: string): Promise<void> {
        const value = label.trim().slice(0, 80);
        if (!value) throw new Error('Название не может быть пустым.');
        await this.update(state => {
            const profile = state.profiles.find(p => p.id === id);
            if (!profile) throw new Error('Аккаунт не найден.');
            profile.label = value;
        });
    }

    /** Удаляет неактивный профиль и его секрет; активный (по auth.json) удалить нельзя. */
    async removeAccount(id: string): Promise<void> {
        // Активный профиль определяется по свежему чтению auth.json: другое окно могло переключить аккаунт.
        await this.readDiskAuth();
        const view = this.getView();
        if (id === view.activeId) throw new Error('Сначала переключитесь на другой аккаунт.');
        if (!view.profiles.some(p => p.id === id)) throw new Error('Аккаунт не найден.');
        await this.context.secrets.delete(makeSecretKey(id));
        await this.update(state => {
            state.profiles = state.profiles.filter(p => p.id !== id);
        });
    }

    /** Останавливает незавершённый вход и удаляет его временный каталог при выгрузке расширения. */
    dispose(): void {
        if (this.pendingLoginTimer) clearInterval(this.pendingLoginTimer);
        this.pendingLoginTimer = null;
        this.pendingLoginCloseListener?.dispose();
        this.pendingLoginCloseListener = null;
        // Секреты не должны оставаться в брошенных временных каталогах после остановки расширения.
        const directory = this.pendingLoginDir;
        this.pendingLoginDir = null;
        this.pendingLoginTerminal?.dispose();
        this.pendingLoginTerminal = null;
        if (directory) void fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
        this.changed.dispose();
    }
}
