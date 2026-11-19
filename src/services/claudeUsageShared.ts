import * as crypto from 'crypto';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { ClaudeLimitStatus } from './claudeUsageService.js';

/** Интервал обычного обновления лимитов через CLI, мс. */
const REFRESH_MS = 5 * 60_000;
/** Минимальный интервал между принудительными обновлениями, мс. */
const FORCE_MIN_MS = 60_000;
/** Возраст блокировки, после которого она считается брошенной, мс. */
const LOCK_STALE_MS = 120_000;
/** Наибольшая пауза после повторяющихся ошибок CLI, мс. */
const MAX_BACKOFF_MS = 30 * 60_000;
/** Версия формата файла общего кэша. */
const VERSION = 1;

/** Функция, получающая лимиты профиля через Claude CLI. */
type Runner = (directory: string) => Promise<ClaudeLimitStatus>;
/**
 * Запись общего кэша для одного каталога учётных данных: время последней успешной проверки и попытки,
 * момент, раньше которого обычное обновление не выполняется, число ошибок подряд и последние лимиты.
 */
interface SharedRecord {
    version: number;
    key: string;
    checkedAt: number;
    lastAttemptAt: number;
    nextAllowedAt: number;
    failures: number;
    data: ClaudeLimitStatus | null;
}
/**
 * Итог попытки обновления: `updated` — CLI вернул лимиты, `locked` — CLI запускает другое окно,
 * `cooldown` — интервал ещё не прошёл, `error` — CLI завершился ошибкой.
 */
export type ClaudeSharedRefreshReason = 'updated' | 'locked' | 'cooldown' | 'error';
/** Результат попытки обновления: был ли запущен CLI, причина и последние известные лимиты. */
export interface ClaudeSharedRefreshResult {
    attempted: boolean;
    reason: ClaudeSharedRefreshReason;
    data: ClaudeLimitStatus | null;
}

/**
 * Вычисляет ключ файла кэша по каталогу учётных данных Claude без раскрытия пути в имени файла.
 * Идентификатор профиля не учитывается: в разных окнах VS Code он может отличаться для одного каталога,
 * а разные аккаунты Prompt Manager всегда используют разные каталоги `CLAUDE_CONFIG_DIR`.
 */
function accountKey(_id: string, directory: string): string {
    return crypto.createHash('sha256').update('pm-claude-usage-v1\0' + path.resolve(directory))
        .digest('hex').slice(0, 40);
}

/**
 * Общий дисковый кэш лимитов и одна блокировка для всех профилей Claude и всех Extension Host VS Code,
 * включая окна VS Code Tunnel. Окно, не получившее блокировку, пропускает обновление и не запускает второй CLI.
 */
export class ClaudeSharedUsageCoordinator {
    private readonly current = new Map<string, Promise<ClaudeSharedRefreshResult>>();
    private readonly lockDir: string;

    /** `now` подменяет текущее время в тестах интервалов и пауз. */
    constructor(
        private readonly cacheDir: string,
        private readonly runner: Runner,
        private readonly now: () => number = Date.now,
    ) {
        this.lockDir = path.join(cacheDir, 'usage.lock');
    }

    /** Возвращает путь к файлу кэша для ключа каталога учётных данных. */
    private cacheFile(key: string): string {
        return path.join(this.cacheDir, 'quota-' + key + '.json');
    }

    /** Создаёт каталог кэша с правами 0700 и отказывает, если по этому пути находится символическая ссылка. */
    private async ensureDir(): Promise<void> {
        await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
        const st = await fs.lstat(this.cacheDir);
        if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe Claude cache directory');
    }

    /** Читает запись кэша; отсутствующий, повреждённый файл или файл другой версии даёт `null`. */
    private async load(key: string): Promise<SharedRecord | null> {
        try {
            const json = JSON.parse(await fs.readFile(this.cacheFile(key), 'utf8'));
            if (json.version !== VERSION || json.key !== key ||
                !Number.isFinite(json.checkedAt) || !Number.isFinite(json.lastAttemptAt) ||
                !Number.isFinite(json.nextAllowedAt)) return null;
            if (json.data && (!Array.isArray(json.data.windows) || !json.data.updatedAt)) return null;
            return json;
        } catch {
            return null;
        }
    }

    /** Атомарно записывает запись кэша через временный файл с правами 0600. */
    private async save(record: SharedRecord): Promise<void> {
        const filename = this.cacheFile(record.key);
        const temp = filename + '.' + crypto.randomUUID() + '.tmp';
        try {
            await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
            await fs.rename(temp, filename);
        } finally {
            await fs.rm(temp, { force: true }).catch(() => undefined);
        }
    }

    /** Пересчитывает признак устаревания: старше 15 минут или все окна уже сброшены. */
    private normalized(data: ClaudeLimitStatus | null): ClaudeLimitStatus | null {
        if (!data) return null;
        const updated = data.updatedAt ? Date.parse(data.updatedAt) : NaN;
        const now = this.now();
        return {
            ...data,
            stale: !Number.isFinite(updated) || now - updated > 15 * 60_000
                || data.windows.every(w => w.resetsAt !== null && w.resetsAt * 1000 <= now),
        };
    }

    /** Возвращает лимиты из общего кэша без запуска CLI или `null`, если записи нет. */
    async read(profileId: string, directory: string): Promise<ClaudeLimitStatus | null> {
        return this.normalized((await this.load(accountKey(profileId, directory)))?.data ?? null);
    }

    /**
     * Пытается атомарно захватить общую блокировку созданием каталога. Брошенную блокировку старше 120 секунд
     * снимает только одно окно, захватившее отдельную блокировку восстановления. Возвращает `true` при захвате.
     */
    private async acquire(): Promise<boolean> {
        try {
            await fs.mkdir(this.lockDir, { mode: 0o700 });
            return true;
        } catch (error: any) {
            if (error?.code !== 'EEXIST') throw error;
        }
        // Восстановление тоже выполняется по одному: иначе два окна, увидевшие одну брошенную блокировку,
        // могли бы удалить заново созданную блокировку друг друга.
        const recovery = this.lockDir + '.recovery';
        try {
            await fs.mkdir(recovery, { mode: 0o700 });
        } catch (error: any) {
            if (error?.code !== 'EEXIST') throw error;
            // Аварийно завершённое восстановление не должно навсегда блокировать обновления.
            try {
                const st = await fs.lstat(recovery);
                if (Date.now() - st.mtimeMs > 10 * 60_000) {
                    await fs.rm(recovery, { force: true, recursive: true });
                }
            } catch { /* Восстановление могло завершить другое окно. */ }
            return false;
        }
        try {
            const st = await fs.lstat(this.lockDir).catch((error: any) => {
                if (error?.code === 'ENOENT') return null;
                throw error;
            });
            if (!st) return false;
            if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe Claude lock directory');
            // CLI ограничен 40 секундами, поэтому снимается только блокировка старше 120 секунд.
            if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
                await fs.rm(this.lockDir, { force: true, recursive: true });
                try {
                    await fs.mkdir(this.lockDir, { mode: 0o700 });
                    return true;
                } catch (error: any) {
                    if (error?.code !== 'EEXIST') throw error;
                }
            }
            return false;
        } finally {
            await fs.rm(recovery, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    /** Проверяет, разрешено ли обновление: принудительное — раз в минуту, обычное — после `nextAllowedAt`. */
    private allowed(record: SharedRecord | null, force: boolean, at: number): boolean {
        return force
            ? at >= (record?.lastAttemptAt ?? 0) + FORCE_MIN_MS
            : at >= (record?.nextAllowedAt ?? 0);
    }

    /**
     * Обновляет лимиты каталога учётных данных через CLI с учётом интервалов и общей блокировки.
     * Параллельные вызовы для одного каталога в этом процессе получают один и тот же результат.
     */
    async refresh(profileId: string, directory: string, force = false): Promise<ClaudeSharedRefreshResult> {
        const key = accountKey(profileId, directory);
        const inFlight = this.current.get(key);
        if (inFlight) return inFlight;
        const work = this.runOnce(key, directory, force);
        this.current.set(key, work);
        try { return await work; }
        finally { if (this.current.get(key) === work) this.current.delete(key); }
    }

    /**
     * Выполняет одну попытку обновления под общей блокировкой и повторно проверяет интервал после её захвата.
     * Успех сохраняется со следующей проверкой через 5 минут, ошибка — с паузой, растущей вдвое до 30 минут.
     */
    private async runOnce(key: string, directory: string, force: boolean): Promise<ClaudeSharedRefreshResult> {
        await this.ensureDir();
        let record = await this.load(key);
        if (!this.allowed(record, force, this.now())) {
            return { attempted: false, reason: 'cooldown', data: this.normalized(record?.data ?? null) };
        }
        if (!(await this.acquire())) {
            return { attempted: false, reason: 'locked', data: this.normalized(record?.data ?? null) };
        }
        try {
            record = await this.load(key);
            const started = this.now();
            if (!this.allowed(record, force, started)) {
                return { attempted: false, reason: 'cooldown', data: this.normalized(record?.data ?? null) };
            }
            try {
                const data = await this.runner(directory);
                if (!data.windows.some(w => w.key === 'five_hour' || w.key === 'seven_day')) {
                    throw new Error('No main Claude limit windows');
                }
                const next: SharedRecord = {
                    version: VERSION, key, lastAttemptAt: started, checkedAt: this.now(),
                    nextAllowedAt: this.now() + REFRESH_MS, failures: 0,
                    data: { ...data, source: 'claude-cli', stale: false },
                };
                await this.save(next);
                return { attempted: true, reason: 'updated', data: this.normalized(next.data) };
            } catch {
                // Ошибка CLI не должна приводить к параллельным повторам из всех открытых окон.
                const failures = Math.min(5, (record?.failures || 0) + 1);
                const next: SharedRecord = {
                    version: VERSION, key, lastAttemptAt: started,
                    checkedAt: record?.checkedAt || 0,
                    nextAllowedAt: this.now() + Math.min(MAX_BACKOFF_MS, REFRESH_MS * 2 ** (failures - 1)),
                    failures, data: record?.data || null,
                };
                await this.save(next);
                return { attempted: true, reason: 'error', data: this.normalized(next.data) };
            }
        } finally {
            await fs.rm(this.lockDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}
