import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import type { ClaudeLimitStatus, ClaudeLimitWindow } from './claudeUsageService.js';

/** Номера месяцев по трёхбуквенным английским сокращениям из вывода Claude CLI `/usage`. */
const MONTHS: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Раскладывает момент времени на настенные год, месяц, день, час и минуту в указанном часовом поясе IANA.
 * Неизвестный пояс приводит к исключению `RangeError` из `Intl.DateTimeFormat`.
 */
function zoneParts(epoch: number, zone: string): number[] {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const parts: Record<string, number> = {};
    for (const p of formatter.formatToParts(new Date(epoch))) {
        if (['year', 'month', 'day', 'hour', 'minute'].includes(p.type)) {
            parts[p.type] = Number(p.value);
        }
    }
    return [parts.year, parts.month, parts.day, parts.hour, parts.minute];
}

/**
 * Переводит настенное время в часовом поясе `zone` в миллисекунды эпохи.
 * Несколько итераций учитывают смещение пояса; для несуществующего из-за перевода часов времени возвращает `null`.
 */
function inZone(year: number, month: number, day: number, hour: number, minute: number, zone: string): number | null {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    let guess = wall;
    for (let i = 0; i < 4; i++) {
        const parts = zoneParts(guess, zone);
        const displayedWall = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);
        guess += wall - displayedWall;
    }
    const parts = zoneParts(guess, zone);
    return [year, month, day, hour, minute].every((n, i) => n === parts[i]) ? guess : null;
}

/**
 * Разбирает время сброса лимита вида `Nov 19, 2:50pm (Asia/Novosibirsk)`.
 * Claude CLI не выводит год, поэтому выбирается ближайший кандидат от 30 секунд в прошлом до 10 суток вперёд.
 * Возвращает миллисекунды эпохи или `null`, если строка или часовой пояс не распознаны.
 */
export function parseClaudeCliReset(text: string, now = Date.now()): number | null {
    const m = /^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)$/i.exec(text.trim());
    if (!m) return null;
    const month = MONTHS[m[1].toLowerCase()];
    const day = Number(m[2]);
    const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
    const minute = Number(m[4] || '0');
    if (!month || day < 1 || day > 31 || minute > 59) return null;
    try {
        const year = zoneParts(now, m[6])[0];
        const candidates = [year - 1, year, year + 1]
            .map(y => inZone(y, month, day, hour, minute, m[6]))
            .filter((v): v is number => v !== null).sort((a, b) => a - b);
        return candidates.find(v => v >= now - 30_000 && v <= now + 10 * 86400_000) ?? null;
    } catch {
        return null;
    }
}

/** Строка лимита: «Current session» или «Current week (область)», процент и необязательное время сброса. */
const QUOTA_LINE = new RegExp('^(Current session|Current week\\s*\\(([^)]+)\\)):\\s*(\\d+(?:\\.\\d+)?)%\\s+used'
    + '(?:\\s*[·•-]\\s*resets\\s+(.+))?$', 'i');

/**
 * Извлекает из текста отчёта `/usage` только строки с процентами лимитов и временем их сброса.
 * Остальной отчёт может содержать личные сведения и не сохраняется.
 * Бросает исключение, если не найдено ни пятичасовое, ни недельное окно.
 */
export function parseClaudeCliUsageText(text: string, now = Date.now()): ClaudeLimitStatus {
    const windows: ClaudeLimitWindow[] = [];
    for (const line of text.split(/\r?\n/)) {
        const m = QUOTA_LINE.exec(line.trim());
        if (!m) continue;
        const used = Number(m[3]);
        if (!Number.isFinite(used) || used < 0 || used > 100) continue;
        const scope = (m[2] || '').trim();
        let key = 'five_hour', label = '5ч';
        if (!/^Current session$/i.test(m[1])) {
            if (/^all models$/i.test(scope)) {
                key = 'seven_day';
                label = '7д';
            } else {
                const safe = scope.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
                if (!safe) continue;
                key = 'seven_day_model_' + safe;
                label = scope.slice(0, 48) + ' · 7д';
            }
        }
        const reset = m[4] ? parseClaudeCliReset(m[4], now) : null;
        windows.push({
            key, label, usedPercent: used, remainingPercent: 100 - used,
            resetsAt: reset === null ? null : Math.floor(reset / 1000),
        });
    }
    if (!windows.some(w => w.key === 'five_hour' || w.key === 'seven_day')) {
        throw new Error('Claude CLI did not return usable quota windows.');
    }
    return { windows, updatedAt: new Date(now).toISOString(), stale: false, source: 'claude-cli' };
}

/** Префикс временных рабочих каталогов, которые создавались для каждой проверки `/usage`. */
const LEGACY_WORKDIR_PREFIX = 'pm-claude-usage-';
/** Каталоги конфигурации Claude, в которых уже выполнена очистка оставшихся проектов в текущем процессе. */
const cleanedConfigDirectories = new Set<string>();

/**
 * Вычисляет имя каталога проекта в `<CLAUDE_CONFIG_DIR>/projects`, которое Claude Code создаёт для рабочего каталога:
 * каждый символ пути, кроме латинских букв и цифр, заменяется на `-`.
 * Например, `/tmp/pm-claude-usage-7X283U` даёт `-tmp-pm-claude-usage-7X283U`.
 */
export function claudeProjectKey(workingDirectory: string): string {
    return workingDirectory.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Удаляет из `<configDirectory>/projects` пустые каталоги проектов, оставшиеся от прежних проверок `/usage`
 * во временных каталогах `<tmpRoot>/pm-claude-usage-XXXXXX`.
 * Удаляется только каталог, имя которого точно совпадает с ключом такого пути и внутри которого нет ничего,
 * кроме пустого подкаталога `memory`. Символические ссылки не обходятся и не удаляются.
 * Ошибки чтения и удаления не прерывают проверку лимитов. Возвращает число удалённых каталогов.
 */
export async function cleanupClaudeUsageProjectLeftovers(
    configDirectory: string, tmpRoot = os.tmpdir(),
): Promise<number> {
    const projects = path.join(configDirectory, 'projects');
    try {
        const root = await fs.lstat(projects);
        if (!root.isDirectory() || root.isSymbolicLink()) return 0;
    } catch {
        return 0;
    }
    // Claude может записать путь как указан или после разрешения ссылок, поэтому проверяются оба варианта.
    // Ключ состоит только из букв, цифр и `-`, поэтому экранирование для регулярного выражения не требуется.
    const roots = new Set([tmpRoot, await fs.realpath(tmpRoot).catch(() => tmpRoot)]);
    const patterns = [...roots].map(base =>
        new RegExp('^' + claudeProjectKey(path.join(base, LEGACY_WORKDIR_PREFIX)) + '[A-Za-z0-9]{6}$'));
    let removed = 0;
    for (const name of await fs.readdir(projects).catch(() => [] as string[])) {
        if (!patterns.some(pattern => pattern.test(name))) continue;
        const entry = path.join(projects, name);
        const memory = path.join(entry, 'memory');
        try {
            const entryStat = await fs.lstat(entry);
            if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) continue;
            const children = await fs.readdir(entry);
            if (children.length !== 1 || children[0] !== 'memory') continue;
            const memoryStat = await fs.lstat(memory);
            if (!memoryStat.isDirectory() || memoryStat.isSymbolicLink()) continue;
            if ((await fs.readdir(memory)).length) continue;
            // rmdir не удаляет непустой каталог, если Claude успел что-то записать после проверки.
            await fs.rmdir(memory);
            await fs.rmdir(entry);
            removed++;
        } catch {
            // Каталог изменился или недоступен: он остаётся без изменений.
        }
    }
    return removed;
}

/**
 * Подготавливает постоянный рабочий каталог проверки `/usage` с правами 0700.
 * Отказывает, если по этому пути находится не каталог или символическая ссылка.
 */
async function preparePersistentWorkingDirectory(workingDirectory: string): Promise<void> {
    await fs.mkdir(workingDirectory, { recursive: true, mode: 0o700 });
    const st = await fs.lstat(workingDirectory);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe Claude usage working directory');
    if ((st.mode & 0o777) !== 0o700) await fs.chmod(workingDirectory, 0o700);
}

/**
 * Запускает официальный Claude CLI командой `claude -p /usage` для профиля `directory` и возвращает лимиты.
 * Проверено на Claude Code 2.1.327: ноль ходов модели и нулевая стоимость; иной ответ отклоняется.
 * Ключи API из окружения удаляются, чтобы использовалась авторизация именно этого профиля; stderr не читается.
 * С `workingDirectory` CLI запускается в этом постоянном каталоге, и Claude не создаёт новый каталог проекта
 * при каждой проверке; один раз за процесс удаляются пустые каталоги проектов от прежних временных запусков.
 * Без `workingDirectory` используется временный каталог, который удаляется после проверки.
 */
export async function runClaudeCliUsage(
    executable: string, directory: string, workingDirectory?: string,
): Promise<ClaudeLimitStatus> {
    let workingDir: string;
    if (workingDirectory) {
        await preparePersistentWorkingDirectory(workingDirectory);
        workingDir = workingDirectory;
        const configKey = path.resolve(directory);
        if (!cleanedConfigDirectories.has(configKey)) {
            cleanedConfigDirectories.add(configKey);
            await cleanupClaudeUsageProjectLeftovers(configKey).catch(() => 0);
        }
    } else {
        workingDir = await fs.mkdtemp(path.join(os.tmpdir(), LEGACY_WORKDIR_PREFIX));
        await fs.chmod(workingDir, 0o700);
    }
    try {
        const env = { ...process.env };
        for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
            delete env[key];
        }
        // Для основного профиля CLAUDE_CONFIG_DIR не задаётся: с явным ~/.claude Claude ищет .claude.json
        // в другом месте.
        if (path.resolve(directory) === path.join(os.homedir(), '.claude')) delete env.CLAUDE_CONFIG_DIR;
        else env.CLAUDE_CONFIG_DIR = directory;
        env.LANG = 'C';
        env.LC_ALL = 'C';
        return await new Promise<ClaudeLimitStatus>((resolve, reject) => {
            const args = ['-p', '/usage', '--output-format', 'json', '--no-session-persistence',
                '--max-turns', '1', '--tools', ''];
            const child = spawn(executable, args, {
                cwd: workingDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let finished = false;
            /** Завершает ожидание один раз: снимает таймер и передаёт результат или ошибку. */
            const finish = (error?: Error, value?: ClaudeLimitStatus) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                if (error) reject(error);
                else if (value) resolve(value);
            };
            const timer = setTimeout(() => {
                child.kill();
                finish(new Error('Claude CLI usage timeout'));
            }, 40_000);
            child.stdout.on('data', (chunk: Buffer) => {
                stdout += chunk.toString('utf8');
                if (stdout.length > 160_000) {
                    child.kill();
                    finish(new Error('Claude CLI usage output too large'));
                }
            });
            // stderr не журналируется: он может содержать личные сведения аккаунта.
            child.stderr.resume();
            child.once('error', () => finish(new Error('Claude CLI usage could not start')));
            child.once('close', (code: number | null) => {
                if (finished) return;
                if (code !== 0) return finish(new Error('Claude CLI usage failed'));
                try {
                    const result = JSON.parse(stdout);
                    // Принимается только локальная команда без обращения к модели и без стоимости.
                    if (result.type !== 'result' || result.is_error
                        || result.num_turns !== 0 || result.total_cost_usd !== 0
                        || typeof result.result !== 'string') {
                        throw new Error('Unexpected CLI operation');
                    }
                    finish(undefined, parseClaudeCliUsageText(result.result));
                } catch {
                    finish(new Error('Claude CLI usage response format changed'));
                }
            });
        });
    } finally {
        if (!workingDirectory) await fs.rm(workingDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
