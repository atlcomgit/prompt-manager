import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import {
    findCodexExecutable, identityOf, resolveCodexHome, returnRefreshedCodexAuth, type CodexAuthReturnResult,
} from './codexAccountService.js';
import { appendPromptManagerLog } from '../utils/promptManagerOutput.js';
import { tryLockQuotaRefresh, writeQuotaCacheFile } from './accountQuotaCache.js';

/** Одно окно лимита Codex (например, 5 часов или 7 дней) в процентах. */
export interface CodexLimitWindow {
    label: string;
    usedPercent: number;
    remainingPercent: number;
    windowDurationMins: number | null;
    /** Время сброса окна в секундах Unix. */
    resetsAt: number | null;
}
/** Лимиты активного аккаунта Codex для строки состояния и страницы «Аккаунты». */
export interface CodexLimitStatus {
    windows: CodexLimitWindow[];
    planType: string | null;
    /** Время получения данных от Codex (ISO), а не время чтения кэша. */
    updatedAt: string;
    error?: string;
    /** Данные получены давно или окно лимита уже сброшено: проценты — последние известные значения. */
    stale?: boolean;
}
/** Параметры сервиса лимитов; все необязательны и нужны для общего кэша, возврата авторизации и тестов. */
export interface CodexRateLimitOptions {
    /** The shared quota directory for the current OS user, when configured. */
    sharedCacheDir?: string;
    /** Keep the previous globalStorage directory as a read-only fallback. */
    legacyCacheDir?: string;
    /**
     * Возврат авторизации, обновлённой временным app-server. По умолчанию — проверенная запись
     * в auth.json текущего CODEX_HOME без обновления SecretStorage.
     */
    storeRefreshedAuth?: (original: string, refreshed: string) => Promise<CodexAuthReturnResult>;
    /** Путь к исполняемому файлу Codex; по умолчанию — из расширения `openai.chatgpt` или PATH. */
    executable?: () => string;
    /** Журнал без содержимого токенов. */
    log?: (message: string) => void;
    /** Источник текущего времени в миллисекундах. */
    now?: () => number;
}
/** Результат, полученный в этом окне или прочитанный из общего кэша. */
interface CachedLimits {
    key: string;
    status: CodexLimitStatus;
    /** Момент получения данных от Codex, мс; для ошибок — момент неудачной попытки. */
    checkedAt: number;
}
/** Запись общего кэша: только проценты, сроки сброса и тариф, без токенов и персональных данных. */
interface SharedLimitRecord {
    version: number;
    key: string;
    data: Pick<CodexLimitStatus, 'windows' | 'planType' | 'updatedAt'>;
}

/** Срок, в течение которого результат считается свежим и повторный запрос к Codex не выполняется. */
export const CODEX_LIMITS_REFRESH_MS = 60_000;
/** Возраст данных, после которого они показываются как устаревшие: окно в фокусе обновляет их каждую минуту. */
const CODEX_LIMITS_STALE_MS = 3 * CODEX_LIMITS_REFRESH_MS;
const REQUEST_TIMEOUT_MS = 15_000;
/** Ожидание штатного завершения app-server после закрытия stdin, затем после SIGTERM. */
const APP_SERVER_EXIT_WAIT_MS = 2000;
const APP_SERVER_KILL_WAIT_MS = 2000;
const SHARED_CACHE_VERSION = 1;
/** Временные CODEX_HOME запроса лимитов и входа: в них лежат копии auth.json с токенами. */
const CODEX_TEMP_HOME_NAME = /^prompt-manager-codex-(?:limits|login)-[A-Za-z0-9]{6}$/;
/** Возраст брошенного временного CODEX_HOME: запрос лимитов длится секунды, вход — не дольше 8 минут. */
const CODEX_TEMP_HOME_MAX_AGE_MS = 20 * 60_000;

/**
 * Удаляет временные CODEX_HOME, оставшиеся после аварийного завершения Extension Host посреди запроса лимитов
 * или входа: в них копии auth.json с токенами. Удаляются только каталоги текущего пользователя с точным
 * шаблоном имени и старше CODEX_TEMP_HOME_MAX_AGE_MS; символические ссылки пропускаются. Возвращает число
 * удалённых каталогов; ошибки отдельных каталогов не прерывают очистку. Тест: tests/codexRateLimit.test.ts.
 */
export async function cleanupStaleCodexTempHomes(
    root: string = os.tmpdir(),
    now: number = Date.now(),
): Promise<number> {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    let removed = 0;
    for (const name of await fs.readdir(root).catch(() => [] as string[])) {
        if (!CODEX_TEMP_HOME_NAME.test(name)) continue;
        const directory = path.join(root, name);
        try {
            const info = await fs.lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink() || (uid !== null && info.uid !== uid)
                || now - info.mtimeMs < CODEX_TEMP_HOME_MAX_AGE_MS) {
                continue;
            }
            await fs.rm(directory, { recursive: true, force: true });
            removed += 1;
        } catch {
            // Каталог мог удалить другой процесс; остальные проверяются дальше.
        }
    }
    return removed;
}

/** Подпись окна лимита по его длительности: «5ч», «7д», «30м» или «Лимит» для неизвестной длительности. */
export function formatLimitDuration(minutes: number | null): string {
    if (!minutes || !Number.isFinite(minutes)) return 'Лимит';
    if (minutes % 1440 === 0) return String(minutes / 1440) + 'д';
    if (minutes % 60 === 0) return String(minutes / 60) + 'ч';
    return String(minutes) + 'м';
}

/**
 * Преобразует ответ `account/rateLimits/read` в окна лимитов. Берёт общий `rateLimits`, а при его
 * отсутствии — первую запись `rateLimitsByLimitId` с основным или дополнительным окном.
 * Тест: tests/codexAccounts.test.ts.
 */
export function parseCodexLimitResponse(response: any): CodexLimitStatus {
    const data = response?.rateLimits || response || {};
    const rateLimits = (data?.primary || data?.secondary) ? data : null;
    const chosen = rateLimits || (() => {
        const entries = Object.values(response?.rateLimitsByLimitId || {});
        return entries.find((v: any) => v && (v.primary || v.secondary)) || {};
    })();
    const windows: CodexLimitWindow[] = [];
    for (const key of ['primary', 'secondary'] as const) {
        const value: any = (chosen as any)[key];
        if (!value || typeof value.usedPercent !== 'number') continue;
        const used = Math.min(100, Math.max(0, value.usedPercent));
        const mins = typeof value.windowDurationMins === 'number' ? value.windowDurationMins : null;
        windows.push({
            label: formatLimitDuration(mins),
            usedPercent: used,
            remainingPercent: Math.max(0, 100 - used),
            windowDurationMins: mins,
            resetsAt: typeof value.resetsAt === 'number' ? value.resetsAt : null,
        });
    }
    return {
        windows,
        planType: typeof (chosen as any).planType === 'string' ? (chosen as any).planType : null,
        updatedAt: new Date().toISOString(),
    };
}

/**
 * Ключ общего кэша лимитов: sha256 от identity аккаунта, чтобы окна с разными id профилей
 * использовали одну запись, а в имени файла не было e-mail или id аккаунта. `null` для неверной авторизации.
 */
export function codexLimitsCacheKey(auth: string): string | null {
    try {
        return crypto.createHash('sha256').update('pm-codex-limits-v1\0' + identityOf(auth).identity)
            .digest('hex').slice(0, 40);
    } catch {
        return null;
    }
}

/** Отмечает данные устаревшими, если они старше трёх интервалов обновления или окно лимита уже сброшено. */
export function withCodexLimitStaleness(status: CodexLimitStatus, now: number): CodexLimitStatus {
    const fetchedAt = Date.parse(status.updatedAt);
    const stale = !Number.isFinite(fetchedAt) || now - fetchedAt > CODEX_LIMITS_STALE_MS
        || status.windows.some(w => w.resetsAt !== null && w.resetsAt * 1000 <= now);
    return { ...status, stale };
}

/** Код ошибки для журнала без текста, который может содержать пути или данные авторизации. */
function errorCode(error: unknown): string {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string') return code;
    return error instanceof Error ? error.name : 'unknown';
}

/** Ждёт завершения `promise` не дольше `ms`; возвращает `true`, если оно завершилось вовремя. */
function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), ms);
        void promise.then(() => { clearTimeout(timer); resolve(true); });
    });
}

/**
 * Завершает app-server: закрывает stdin и ждёт штатного выхода, чтобы обновлённый auth.json был
 * дописан; при задержке отправляет SIGTERM, затем SIGKILL. Общее ожидание ограничено.
 */
async function stopAppServer(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.stdin.end();
    if (await settlesWithin(exited, APP_SERVER_EXIT_WAIT_MS)) return;
    child.kill('SIGTERM');
    if (await settlesWithin(exited, APP_SERVER_KILL_WAIT_MS)) return;
    child.kill('SIGKILL');
    await settlesWithin(exited, APP_SERVER_KILL_WAIT_MS);
}

/**
 * Запрашивает лимиты у временного `codex app-server` с копией авторизации во временном CODEX_HOME.
 * App-server может обновить токены (истёкший access token или срок `last_refresh`), израсходовав
 * прежний refresh token; поэтому после его завершения изменённый auth.json передаётся в `returnAuth`
 * даже при ошибке запроса. Временный каталог с токенами удаляется в любом случае.
 */
async function rpcRateLimits(
    auth: string,
    executable: string,
    returnAuth: (refreshed: string) => Promise<void>,
): Promise<CodexLimitStatus> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-manager-codex-limits-'));
    await fs.chmod(home, 0o700);
    const authFile = path.join(home, 'auth.json');
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
        await fs.writeFile(authFile, auth, { mode: 0o600 });
        child = spawn(executable, ['app-server'], {
            env: { ...process.env, CODEX_HOME: home },
            cwd: home,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const processRef = child;
        const callbacks = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();
        let partial = '';
        // Ответы JSON-RPC приходят построчно; строка без ожидающего запроса пропускается.
        processRef.stdout.on('data', (chunk: Buffer) => {
            partial += chunk.toString('utf8');
            if (partial.length > 2_000_000) { partial = ''; return; }
            let split: number;
            while ((split = partial.indexOf('\n')) >= 0) {
                const line = partial.slice(0, split);
                partial = partial.slice(split + 1);
                let message: any;
                try { message = JSON.parse(line); } catch { continue; }
                const pending = callbacks.get(message.id);
                if (!pending) continue;
                callbacks.delete(message.id);
                if (message.error) pending.reject(new Error(String(message.error.message || 'App Server error')));
                else pending.resolve(message.result);
            }
        });
        processRef.on('error', () => {
            for (const { reject } of callbacks.values()) reject(new Error('Не удалось запустить Codex App Server.'));
            callbacks.clear();
        });
        processRef.on('exit', () => {
            const error = new Error('Codex App Server завершился раньше ответа.');
            for (const { reject } of callbacks.values()) reject(error);
            callbacks.clear();
        });
        // stderr не читается: в нём могут быть сведения об аккаунте, которые не должны попасть в журнал.
        processRef.stderr.resume();
        processRef.stdin.on('error', () => {
            for (const { reject } of callbacks.values()) reject(new Error('Соединение с Codex App Server закрыто.'));
            callbacks.clear();
        });
        /** Отправляет запрос JSON-RPC и ждёт ответ с тем же id не дольше REQUEST_TIMEOUT_MS. */
        const request = (id: number, method: string, params: object): Promise<any> => {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    callbacks.delete(id);
                    reject(new Error('Codex не ответил на запрос лимитов.'));
                }, REQUEST_TIMEOUT_MS);
                callbacks.set(id, {
                    resolve: v => { clearTimeout(timeout); resolve(v); },
                    reject: e => { clearTimeout(timeout); reject(e); },
                });
                processRef.stdin.write(JSON.stringify({ id, method, params }) + '\n');
            });
        };
        await request(1, 'initialize', { clientInfo: { name: 'prompt-manager', version: '0.2.54' } });
        processRef.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
        const data = await request(2, 'account/rateLimits/read', {});
        return parseCodexLimitResponse(data);
    } finally {
        if (child) await stopAppServer(child);
        const refreshed = await fs.readFile(authFile, 'utf8').catch(() => null);
        if (refreshed !== null && refreshed !== auth) await returnAuth(refreshed).catch(() => undefined);
        await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
}

/**
 * Получает лимиты Codex и кэширует их в окне и (при заданном `sharedCacheDir`) в общем файле для всех
 * окон VS Code. Опрашивает Codex не чаще раза в минуту на аккаунт; без разрешения на опрос возвращает
 * последние известные данные. Тест: tests/codexRateLimit.test.ts.
 */
export class CodexRateLimitService {
    private last: CachedLimits | null = null;
    private readonly requests = new Map<string, Promise<CodexLimitStatus>>();
    /** Увеличивается при `invalidate`, чтобы результат начатого раньше запроса не попал в кэш окна. */
    private generation = 0;
    private readonly now: () => number;
    private readonly log: (message: string) => void;

    /** Без параметров работает только с кэшем в памяти и возвращает токены прямо в auth.json CODEX_HOME. */
    constructor(private readonly options: CodexRateLimitOptions = {}) {
        this.now = options.now ?? Date.now;
        this.log = options.log ?? appendPromptManagerLog;
    }

    /** Последний результат этого окна с актуальной отметкой устаревания. */
    getCached(): CodexLimitStatus | null {
        return this.last ? withCodexLimitStaleness(this.last.status, this.now()) : null;
    }

    /** Сбрасывает кэш окна (например, после переключения аккаунта); общий кэш по аккаунтам не трогает. */
    invalidate(): void {
        this.last = null;
        this.generation += 1;
    }

    /**
     * Возвращает лимиты аккаунта из `auth`. Без `force` использует свежий кэш окна или общий кэш;
     * если данных нет или они старше минуты, опрашивает Codex, только когда `allowPoll` истинно.
     * Иначе возвращает последние известные данные с отметкой `stale` или пустой результат с пояснением.
     * `force` (ручное обновление) опрашивает Codex в любом окне. Одновременные запросы объединяются.
     */
    async get(
        accountId: string | null, auth: string | null, force = false, allowPoll = true,
    ): Promise<CodexLimitStatus> {
        if (!accountId || !auth) {
            return {
                windows: [], planType: null, updatedAt: new Date(this.now()).toISOString(),
                error: 'Нет активной авторизации Codex.',
            };
        }
        const key = codexLimitsCacheKey(auth) ?? crypto.createHash('sha256').update('profile-' + accountId).digest('hex').slice(0, 40);
        const active = this.requests.get(key);
        if (active) return active;
        const generation = this.generation;
        const request = this.resolveLimits(key, auth, force, allowPoll).then(status => {
            if (generation === this.generation) {
                this.last = { key, status, checkedAt: Date.parse(status.updatedAt) };
            }
            return status;
        });
        this.requests.set(key, request);
        try {
            return await request;
        } finally {
            if (this.requests.get(key) === request) this.requests.delete(key);
        }
    }

    /** Check freshness around lock acquisition and return the latest snapshot if the refresh is busy. */
    private async resolveLimits(key: string, auth: string, force: boolean, allowPoll: boolean): Promise<CodexLimitStatus> {
        const own = this.last?.key === key ? this.last : null;
        let shared = await this.readShared(key);
        const best = () => {
            if (!own || (shared && (!own.status.windows.length || Date.parse(shared.updatedAt) >= own.checkedAt))) return shared;
            return own.status;
        };
        const fallback = (error: string) => {
            const status = best();
            return status ? withCodexLimitStaleness(status, this.now()) : {
                windows: [], planType: null, updatedAt: new Date(0).toISOString(), stale: true, error,
            };
        };
        const cached = best();
        /** Apply the snapshot TTL to automatic refresh. */
        const fresh = (status: CodexLimitStatus) => {
            const age = this.now() - Date.parse(status.updatedAt);
            return age >= 0 && age < CODEX_LIMITS_REFRESH_MS;
        };
        if (!force && cached && fresh(cached)) {
            return withCodexLimitStaleness(cached, this.now());
        }
        if (!force && !allowPoll) {
            return fallback('Лимиты обновятся, когда окно VS Code получит фокус.');
        }
        const directory = this.options.sharedCacheDir;
        let release: (() => Promise<void>) | null = null;
        try {
            if (directory) {
                release = await tryLockQuotaRefresh(directory, 'codex');
                const previousDate = shared?.updatedAt;
                shared = await this.readShared(key);
                if (!release) return fallback('Лимиты Codex обновляются в другой сессии.');
                if (shared && (shared.updatedAt !== previousDate
                    || (!force && fresh(shared)))) {
                    return withCodexLimitStaleness(shared, this.now());
                }
            }
            const executable = (this.options.executable ?? findCodexExecutable)();
            const data = await rpcRateLimits(auth, executable, refreshed => this.returnAuth(auth, refreshed));
            const result = { ...data, updatedAt: new Date(this.now()).toISOString(), stale: false };
            await this.writeShared(key, result);
            return result;
        } catch (error) {
            this.log('[Accounts] Codex quota refresh failed: ' + errorCode(error));
            return fallback(error instanceof Error ? error.message : 'Не удалось обновить лимиты Codex.');
        } finally {
            await release?.().catch(() => this.log('[Accounts] Codex quota lock release failed.'));
        }
    }

    /** Передаёт обновлённую авторизацию на сохранение; сбои только журналируются, без содержимого токенов. */
    private async returnAuth(original: string, refreshed: string): Promise<void> {
        const store = this.options.storeRefreshedAuth
            ?? ((before: string, after: string) =>
                returnRefreshedCodexAuth(path.join(resolveCodexHome(), 'auth.json'), before, after));
        try {
            const result = await store(original, refreshed);
            if (result !== 'written' && result !== 'unchanged') {
                this.log('[Accounts] Codex refreshed auth return failed: ' + result);
            }
        } catch (error) {
            this.log('[Accounts] Codex refreshed auth return failed: ' + errorCode(error));
        }
    }

    /** Путь записи общего кэша для ключа аккаунта или `null`, если общий кэш не настроен. */
    private sharedFile(key: string): string | null {
        return this.options.sharedCacheDir
            ? path.join(this.options.sharedCacheDir, 'codex-limits-' + key + '.json')
            : null;
    }

    /** Читает запись общего кэша; повреждённая или чужая запись считается отсутствующей. */
    private async readShared(key: string): Promise<CodexLimitStatus | null> {
        const file = this.sharedFile(key);
        const migrated = file ? await this.readSharedFile(file, key) : null;
        const legacy = this.options.legacyCacheDir;
        return migrated ?? (legacy
            ? await this.readSharedFile(path.join(legacy, 'codex-limits-' + key + '.json'), key)
            : null);
    }

    /** Validate the saved snapshot and its account key. */
    private async readSharedFile(file: string, key: string): Promise<CodexLimitStatus | null> {
        try {
            const record = JSON.parse(await fs.readFile(file, 'utf8')) as SharedLimitRecord;
            const data = record?.data;
            if (record?.version !== SHARED_CACHE_VERSION || record.key !== key || !data
                || !Array.isArray(data.windows) || !Number.isFinite(Date.parse(data.updatedAt))) return null;
            const windows = data.windows.filter(w => w && typeof w.label === 'string'
                && Number.isFinite(w.usedPercent) && Number.isFinite(w.remainingPercent));
            return {
                windows,
                planType: typeof data.planType === 'string' ? data.planType : null,
                updatedAt: data.updatedAt,
            };
        } catch {
            return null;
        }
    }

    /** Атомарно записывает успешный результат в общий кэш (права 0600); сбой записи только журналируется. */
    private async writeShared(key: string, status: CodexLimitStatus): Promise<void> {
        const file = this.sharedFile(key);
        if (!file) return;
        const record: SharedLimitRecord = {
            version: SHARED_CACHE_VERSION,
            key,
            data: { windows: status.windows, planType: status.planType, updatedAt: status.updatedAt },
        };
        try {
            await writeQuotaCacheFile(file, record);
        } catch (error) {
            this.log('[Accounts] Codex shared limits cache write failed: ' + errorCode(error));
        }
    }
}
