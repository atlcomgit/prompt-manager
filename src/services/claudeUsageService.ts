import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { ClaudeSharedUsageCoordinator, type ClaudeSharedRefreshResult } from './claudeUsageShared.js';
import { runClaudeCliUsage } from './claudeUsageCli.js';

/** Одно окно лимита Claude: использованная и оставшаяся доля в процентах и время сброса в секундах эпохи. */
export interface ClaudeLimitWindow {
    label: string;
    key: string;
    usedPercent: number;
    remainingPercent: number;
    resetsAt: number | null;
}
/**
 * Сведения о лимитах профиля Claude из одного источника: собственного кэша Claude Code, сборщика statusLine
 * или общего кэша проверок CLI `/usage`. `stale` означает, что значения могли устареть.
 */
export interface ClaudeLimitStatus {
    windows: ClaudeLimitWindow[];
    updatedAt: string | null;
    stale: boolean;
    error?: string;
    source: 'native-cache' | 'statusline' | 'claude-cli' | 'unavailable';
}

/** Возраст сведений, после которого лимиты считаются устаревшими, мс. */
const MAX_CACHE_AGE_MS = 15 * 60_000;
/** Известные окна лимитов Claude и их подписи; первые два есть и в данных statusLine. */
const WINDOW_LABELS: Array<[string, string]> = [
    ['five_hour', '5ч'],
    ['seven_day', '7д'],
    ['seven_day_opus', 'Opus · 7д'],
    ['seven_day_sonnet', 'Sonnet · 7д'],
    ['seven_day_overage_included', 'Дополнительный · 7д'],
];

/**
 * Разбирает кэш лимитов, который Claude Code сам записывает в `.claude.json`.
 * Не обращается к закрытым HTTP-методам и не читает OAuth-токены. Кэш другого аккаунта, некорректные даты
 * и проценты вне диапазона 0–100 отбрасываются; при отсутствии данных возвращается источник `unavailable`.
 */
export function parseClaudeUsageCache(value: unknown, now = Date.now()): ClaudeLimitStatus {
    const unavailable = (error: string): ClaudeLimitStatus =>
        ({ windows: [], updatedAt: null, stale: true, source: 'unavailable', error });
    if (!value || typeof value !== 'object') {
        return unavailable('Claude Code ещё не записал сведения о лимитах. Откройте /usage.');
    }
    const root = value as Record<string, any>;
    const cache = root.cachedUsageUtilization;
    if (!cache || typeof cache !== 'object') return unavailable('Данных нет. Откройте /usage в Claude Code.');
    const account = root.oauthAccount;
    if (account && typeof account === 'object' && typeof cache.accountUuid === 'string'
        && typeof account.accountUuid === 'string' && cache.accountUuid !== account.accountUuid) {
        return unavailable('Кэш принадлежит другому аккаунту Claude.');
    }
    const fetchedAtMs = Number(cache.fetchedAtMs);
    if (!Number.isFinite(fetchedAtMs) || fetchedAtMs < 0 || fetchedAtMs > now + 60_000) {
        return unavailable('Не удалось определить дату обновления лимитов.');
    }
    const limits = cache.utilization;
    const windows: ClaudeLimitWindow[] = [];
    for (const [key, label] of WINDOW_LABELS) {
        const record = limits?.[key];
        if (!record || typeof record !== 'object') continue;
        const pct = typeof record.utilization === 'number' ? record.utilization : NaN;
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) continue;
        const resetsAtValue = record.resets_at;
        const parsed = typeof resetsAtValue === 'number' ? resetsAtValue * 1000
            : typeof resetsAtValue === 'string' ? Date.parse(resetsAtValue) : NaN;
        const resetsAt = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : null;
        windows.push({ key, label, usedPercent: pct, remainingPercent: Math.max(0, 100 - pct), resetsAt });
    }
    if (!windows.length) return unavailable('В кэше нет данных о лимитах. Откройте /usage.');
    return {
        windows,
        updatedAt: new Date(fetchedAtMs).toISOString(),
        stale: now - fetchedAtMs >= MAX_CACHE_AGE_MS ||
            windows.every(w => w.resetsAt !== null && w.resetsAt <= now / 1000),
        source: 'native-cache',
    };
}

/**
 * Разбирает файл сборщика statusLine с полями `rate_limits` из документированных данных Claude Code.
 * Учитываются только окна 5ч и 7д; без корректных данных возвращается источник `unavailable`.
 */
export function parseClaudeStatusLineSample(value: unknown, now = Date.now()): ClaudeLimitStatus {
    const fallback: ClaudeLimitStatus = { windows: [], updatedAt: null, stale: true, source: 'unavailable' };
    if (!value || typeof value !== 'object') return fallback;
    const sample = value as Record<string, any>;
    const fetchedAtMs = Number(sample.fetchedAtMs);
    if (!Number.isFinite(fetchedAtMs) || fetchedAtMs <= 0 || fetchedAtMs > now + 60_000) return fallback;
    const windows: ClaudeLimitWindow[] = [];
    for (const [key, label] of WINDOW_LABELS.slice(0, 2)) {
        const raw = sample.rate_limits?.[key];
        if (!raw || typeof raw !== 'object') continue;
        const used = typeof raw.used_percentage === 'number' ? raw.used_percentage : NaN;
        if (!Number.isFinite(used) || used < 0 || used > 100) continue;
        const reset = Number(raw.resets_at);
        windows.push({
            key, label, usedPercent: used, remainingPercent: 100 - used,
            resetsAt: Number.isFinite(reset) && reset > 0 ? reset : null,
        });
    }
    return windows.length ? {
        windows, updatedAt: new Date(fetchedAtMs).toISOString(),
        stale: now - fetchedAtMs > MAX_CACHE_AGE_MS
            || windows.every(w => w.resetsAt !== null && w.resetsAt * 1000 <= now),
        source: 'statusline',
    } : fallback;
}

/** Проверяет, что окно уже сброшено и его процент нельзя показывать как текущий остаток. */
export function isClaudeWindowExpired(window: ClaudeLimitWindow, now = Date.now()): boolean {
    return window.resetsAt !== null && window.resetsAt * 1000 <= now;
}

/**
 * Путь к исполняемому файлу Claude CLI или функция, вычисляющая его перед каждым запуском.
 * Функция позволяет использовать Claude Code, установленный после активации расширения.
 */
export type ClaudeExecutableSource = string | (() => string);

/**
 * Собирает лимиты профилей Claude из всех локальных источников и при наличии каталога globalStorage
 * обновляет общий для всех окон VS Code кэш через Claude CLI `/usage`.
 */
export class ClaudeUsageService {
    private readonly cached = new Map<string, { at: number; data: ClaudeLimitStatus }>();
    private readonly shared: ClaudeSharedUsageCoordinator | null;

    /**
     * Без `globalStorageRoot` или `claudeExecutable` сервис только читает локальные источники и не запускает CLI.
     * Проверки `/usage` выполняются в постоянном каталоге `<globalStorageRoot>/claude-usage-cwd`, поэтому Claude
     * не создаёт новый каталог в `projects` при каждом запуске.
     */
    constructor(globalStorageRoot?: string, claudeExecutable?: ClaudeExecutableSource) {
        this.shared = globalStorageRoot && claudeExecutable
            ? new ClaudeSharedUsageCoordinator(path.join(globalStorageRoot, 'claude-usage-cache-v1'),
                async directory => runClaudeCliUsage(
                    typeof claudeExecutable === 'function' ? claudeExecutable() : claudeExecutable,
                    directory,
                    path.join(globalStorageRoot, 'claude-usage-cwd'),
                ))
            : null;
    }

    /**
     * Обновляет общий кэш лимитов профиля через Claude CLI. Межпроцессная блокировка гарантирует,
     * что из всех открытых окон CLI запускает только одно; остальные получают `locked` или `cooldown`.
     * Возвращает `null`, если запуск CLI не настроен. После успешного обновления сбрасывает локальный кэш профиля.
     */
    async refreshActive(
        profileId: string, directory: string, force = false,
    ): Promise<ClaudeSharedRefreshResult | null> {
        if (!this.shared) return null;
        const outcome = await this.shared.refresh(profileId, directory, force);
        if (outcome.reason === 'updated') this.invalidate(profileId);
        return outcome;
    }

    /** Сбрасывает локальный кэш чтения для профиля `id` или для всех профилей. */
    invalidate(id?: string): void {
        if (id) this.cached.delete(id);
        else this.cached.clear();
    }

    /**
     * Возвращает самые свежие лимиты профиля из кэша Claude Code, сборщика statusLine и общего кэша CLI.
     * Результат кэшируется на 20 секунд; `force` читает источники заново. CLI при этом не запускается.
     */
    async read(profileId: string, directory: string, force = false): Promise<ClaudeLimitStatus> {
        const fromCache = this.cached.get(profileId);
        if (!force && fromCache && Date.now() - fromCache.at < 20_000) return fromCache.data;
        const sourcePath = directory === path.join(os.homedir(), '.claude')
            ? path.join(os.homedir(), '.claude.json')
            : path.join(directory, '.claude.json');
        const [nativeResult, collectorResult, sharedResult] = await Promise.allSettled([
            fs.readFile(sourcePath, 'utf8'),
            fs.readFile(path.join(directory, 'prompt-manager-rate-limits.json'), 'utf8'),
            this.shared ? this.shared.read(profileId, directory) : Promise.resolve(null),
        ]);
        /** Разбирает JSON, возвращая `null` для повреждённого файла. */
        const safeParse = (text: string): unknown => {
            try { return JSON.parse(text); } catch { return null; }
        };
        const native = nativeResult.status === 'fulfilled'
            ? parseClaudeUsageCache(safeParse(nativeResult.value)) : null;
        const collector = collectorResult.status === 'fulfilled'
            ? parseClaudeStatusLineSample(safeParse(collectorResult.value)) : null;
        const shared = sharedResult.status === 'fulfilled' ? sharedResult.value : null;
        // Выбираются сведения с самой поздней датой: старый statusLine не перекрывает свежую проверку CLI /usage.
        const candidates = [shared, native, collector]
            .filter((item): item is ClaudeLimitStatus => !!item?.windows.length)
            .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
        const data: ClaudeLimitStatus = candidates[0] || {
            windows: [], updatedAt: null, stale: true, source: 'unavailable',
            error: 'Нет статистики Claude. Обновление через CLI /usage будет выполнено автоматически.',
        };
        this.cached.set(profileId, { at: Date.now(), data });
        return data;
    }
}
