import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import Module from 'node:module';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const originalLoad = (Module as any)._load;
/** Минимальная подмена `vscode`: сервис аккаунтов создаёт EventEmitter, лимиты ищут расширение Codex. */
const vscodeMock = {
    EventEmitter: class { event = () => ({ dispose: () => undefined }); fire(): void {} dispose(): void {} },
    extensions: { getExtension: () => undefined },
};
(Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') return vscodeMock;
    return originalLoad.call(this, request, parent, isMain);
};

/** Тестовый auth.json без настоящих токенов. */
function fixtureAuth(accountId: string, token = 'synthetic-test-only'): string {
    return JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: token, refresh_token: token + '-refresh', account_id: accountId },
    });
}

/**
 * Создаёт фиктивный `codex app-server`: отвечает на initialize и запрос лимитов, отмечает каждый запуск
 * в `marker`, а при закрытии stdin записывает в свой CODEX_HOME auth.json с новыми токенами — как Codex,
 * обновивший токены во время запроса. При `fail` запрос лимитов завершается ошибкой.
 */
async function fakeAppServer(dir: string, marker: string, fail = false, gate?: string): Promise<string> {
    const file = path.join(dir, fail ? 'fake-codex-fail' : 'fake-codex');
    const script = [
        '#!' + process.execPath,
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        'fs.appendFileSync(' + JSON.stringify(marker) + ", 'x');",
        "const authFile = path.join(process.env.CODEX_HOME, 'auth.json');",
        "let buffer = '';",
        "const reply = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
        `const gate = ${JSON.stringify(gate ?? null)};`,
        "const untilReleased = async () => {",
        "  if (!gate || fs.existsSync(gate)) return;",
        "  const stop = new AbortController();",
        "  const changes = fs.promises.watch(path.dirname(gate), { signal: stop.signal });",
        "  let next = changes.next();",
        "  try { while (!fs.existsSync(gate)) { await next; next = changes.next(); } }",
        "  finally { stop.abort(); await next.catch(() => undefined); }",
        "};",
        "process.stdin.on('data', async chunk => {",
        '  buffer += chunk;',
        '  let split;',
        "  while ((split = buffer.indexOf('\\n')) >= 0) {",
        '    const message = JSON.parse(buffer.slice(0, split));',
        '    buffer = buffer.slice(split + 1);',
        "    if (message.method === 'initialize') reply({ id: message.id, result: {} });",
        "    if (message.method === 'account/rateLimits/read') { await untilReleased(); reply(" + (fail
            ? "{ id: message.id, error: { message: 'usage unavailable' } }"
            : '{ id: message.id, result: { rateLimits: { planType: "pro", '
                + 'primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 4102444800 }, '
                + 'secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 4102444800 } } } }') + '); }',
        '  }',
        '});',
        "process.stdin.on('end', () => {",
        "  const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));",
        "  auth.tokens.access_token = 'synthetic-rotated';",
        "  auth.tokens.refresh_token = 'synthetic-rotated-refresh';",
        '  fs.writeFileSync(authFile, JSON.stringify(auth));',
        '  process.exit(0);',
        '});',
    ].join('\n');
    await writeFile(file, script, { mode: 0o700 });
    await chmod(file, 0o700);
    return file;
}

/** Число запусков фиктивного app-server по файлу отметок. */
async function launches(marker: string): Promise<number> {
    return (await readFile(marker, 'utf8').catch(() => '')).length;
}

test('refreshed Codex auth returns to auth.json only for the same account and an unchanged file', async () => {
    const { returnRefreshedCodexAuth } = await import('../src/services/codexAccountService.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pm-codex-auth-return-'));
    const authFile = path.join(dir, 'auth.json');
    const original = fixtureAuth('account-a');
    const rotated = fixtureAuth('account-a', 'synthetic-rotated');
    try {
        await writeFile(authFile, original, { mode: 0o600 });
        assert.equal(await returnRefreshedCodexAuth(authFile, original, original), 'unchanged');
        assert.equal(await returnRefreshedCodexAuth(authFile, original, fixtureAuth('account-b')), 'other-account');
        assert.equal(await returnRefreshedCodexAuth(authFile, original, '{"tokens":'), 'invalid');
        assert.equal(await readFile(authFile, 'utf8'), original);

        assert.equal(await returnRefreshedCodexAuth(authFile, original, rotated), 'written');
        assert.equal(await readFile(authFile, 'utf8'), rotated);
        assert.equal((await stat(authFile)).mode & 0o777, 0o600);

        // Codex сам обновил файл после начала запроса: его данные не затираются.
        const byCodex = fixtureAuth('account-a', 'synthetic-by-codex');
        await writeFile(authFile, byCodex, { mode: 0o600 });
        assert.equal(await returnRefreshedCodexAuth(authFile, original, rotated), 'disk-changed');
        assert.equal(await readFile(authFile, 'utf8'), byCodex);
        assert.deepEqual(await readdir(dir), ['auth.json']);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('limits poll returns tokens rotated by app-server and shares the result with other windows', async () => {
    const { CodexRateLimitService } = await import('../src/services/codexRateLimitService.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'pm-codex-limits-shared-'));
    const codexHome = path.join(root, 'codex-home');
    const cacheDir = path.join(root, 'global-storage');
    const marker = path.join(root, 'launches.txt');
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
        const executable = await fakeAppServer(root, marker);
        const original = fixtureAuth('account-a');
        await mkdir(codexHome, { mode: 0o700 });
        await writeFile(path.join(codexHome, 'auth.json'), original, { mode: 0o600 });

        const focused = new CodexRateLimitService({ sharedCacheDir: cacheDir, executable: () => executable });
        const status = await focused.get('profile-a', original, false, true);
        assert.equal(status.error, undefined);
        assert.deepEqual(status.windows.map(w => [w.label, w.remainingPercent]), [['5ч', 75], ['7д', 40]]);
        assert.equal(await launches(marker), 1);
        const returned = JSON.parse(await readFile(path.join(codexHome, 'auth.json'), 'utf8'));
        assert.equal(returned.tokens.refresh_token, 'synthetic-rotated-refresh');

        const files = await readdir(cacheDir);
        assert.equal(files.length, 1);
        const shared = await readFile(path.join(cacheDir, files[0]), 'utf8');
        assert.doesNotMatch(files[0] + shared, /account-a|synthetic/);
        const migrated = new CodexRateLimitService({
            sharedCacheDir: path.join(root, 'new-quota-root'), legacyCacheDir: cacheDir,
            executable: () => { throw new Error('Legacy cache should already contain quotas'); },
        });
        assert.equal((await migrated.get('profile-a', original, false, false)).windows[0].usedPercent, 25);

        // Фоновое окно с другим id профиля и уже обновлёнными токенами читает общий кэш без запуска Codex.
        const rotated = await readFile(path.join(codexHome, 'auth.json'), 'utf8');
        const background = new CodexRateLimitService({ sharedCacheDir: cacheDir, executable: () => executable });
        const fromCache = await background.get('profile-other-window', rotated, false, false);
        assert.deepEqual(fromCache.windows.map(w => w.remainingPercent), [75, 40]);
        assert.equal(fromCache.stale, false);
        assert.equal((await background.get('profile-other-window', rotated, false, true)).windows.length, 2);
        assert.equal(await launches(marker), 1);

        const later = new CodexRateLimitService({
            sharedCacheDir: cacheDir, executable: () => executable, now: () => Date.now() + 10 * 60_000,
        });
        const old = await later.get('profile-a', rotated, false, false);
        assert.equal(old.stale, true);
        assert.deepEqual(old.windows.map(w => w.remainingPercent), [75, 40]);

        const unknown = await background.get('profile-b', fixtureAuth('account-b'), false, false);
        assert.deepEqual(unknown.windows, []);
        assert.equal(unknown.stale, true);
        assert.match(unknown.error || '', /получит фокус/);
        assert.equal(await launches(marker), 1);
    } finally {
        if (previousHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousHome;
        await rm(root, { recursive: true, force: true });
    }
});

test('rotated tokens are returned even when the limits request fails', async () => {
    const { CodexRateLimitService } = await import('../src/services/codexRateLimitService.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'pm-codex-limits-failure-'));
    const marker = path.join(root, 'launches.txt');
    const returned: Array<[string, string]> = [];
    try {
        const executable = await fakeAppServer(root, marker, true);
        const original = fixtureAuth('account-a');
        const service = new CodexRateLimitService({
            sharedCacheDir: path.join(root, 'global-storage'),
            executable: () => executable,
            storeRefreshedAuth: async (before, after) => { returned.push([before, after]); return 'written'; },
        });
        const status = await service.get('profile-a', original, true);
        assert.match(status.error || '', /usage unavailable/);
        assert.equal(returned.length, 1);
        assert.equal(returned[0][0], original);
        assert.equal(JSON.parse(returned[0][1]).tokens.access_token, 'synthetic-rotated');
        // Ошибка не попадает в общий кэш.
        assert.deepEqual(await readdir(path.join(root, 'global-storage')), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/** Другой Node-процесс пропускает обычный и ручной опрос, пока первый держит блокировку Codex. */
test('Codex quota refresh is shared between extension host processes with different legacy directories', async t => {
    const { CodexRateLimitService } = await import('../src/services/codexRateLimitService.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'pm-codex-quota-process-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cache = path.join(root, 'shared');
    const gate = path.join(root, 'release');
    const marker = path.join(root, 'launches');
    const auth = fixtureAuth('shared-account-a');
    const executable = await fakeAppServer(root, marker, false, gate);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = new CodexRateLimitService({
        sharedCacheDir: cache, legacyCacheDir: path.join(root, 'host-a'),
        executable: () => { entered(); return executable; },
        storeRefreshedAuth: async () => 'unchanged',
    });
    const worker = [
        "const Module=require('node:module'); const original=Module._load;",
        "Module._load=function(name,...args){return name==='vscode'?{}:original.call(this,name,...args);};",
        'const [modulePath, cache, legacy, auth, executable, force] = process.argv.slice(1);',
        'const {CodexRateLimitService}=require(modulePath);',
        'const service=new CodexRateLimitService({sharedCacheDir:cache,legacyCacheDir:legacy,executable:()=>executable,storeRefreshedAuth:async()=>"unchanged"});',
        'service.get("other-window-profile",auth,force==="true").then(result=>process.stdout.write(JSON.stringify(result)));',
    ].join('\n');
    const otherHost = async (authValue: string, force: boolean) => {
        const { stdout } = await promisify(execFile)(process.execPath, [
            '-e', worker, require.resolve('../src/services/codexRateLimitService.js'),
            cache, path.join(root, 'host-b'), authValue, executable, String(force),
        ], { timeout: 3_000 });
        return JSON.parse(stdout);
    };
    const pending = first.get('main-profile', auth);
    try {
        await Promise.race([started, pending.then(() => { throw new Error('Codex never entered refresh'); })]);
        assert.match((await otherHost(auth, false)).error, /другой сессии/);
        assert.match((await otherHost(fixtureAuth('different-account'), true)).error, /другой сессии/);
    } finally {
        await writeFile(gate, '');
        await pending;
    }
    const cached = await otherHost(auth, false);
    assert.equal(cached.windows[0].usedPercent, 25);
    assert.equal(await launches(marker), 1);
});

/** Брошенные временные CODEX_HOME удаляются при запуске: только старые, своего шаблона имени и не ссылки. */
test('startup cleanup removes only stale Codex temporary homes', async () => {
    const { cleanupStaleCodexTempHomes } = await import('../src/services/codexRateLimitService.js');
    const { symlink, utimes } = await import('node:fs/promises');
    const root = await mkdtemp(path.join(os.tmpdir(), 'pm-codex-cleanup-test-'));
    try {
        const old = new Date(Date.now() - 30 * 60_000);
        const make = async (name: string, aged: boolean) => {
            const directory = path.join(root, name);
            await mkdir(directory);
            await writeFile(path.join(directory, 'auth.json'), fixtureAuth('acct'));
            if (aged) await utimes(directory, old, old);
            return directory;
        };
        await make('prompt-manager-codex-limits-Ab12Cd', true);
        await make('prompt-manager-codex-login-Zx98Yw', true);
        await make('prompt-manager-codex-limits-Fresh1', false);
        await make('prompt-manager-codex-limits-toolong1', true);
        await make('other-codex-limits-Ab12Cd', true);
        const target = await make('linked-target', true);
        await symlink(target, path.join(root, 'prompt-manager-codex-limits-Link01'));
        assert.equal(await cleanupStaleCodexTempHomes(root), 2);
        assert.deepEqual((await readdir(root)).sort(), [
            'linked-target', 'other-codex-limits-Ab12Cd', 'prompt-manager-codex-limits-Fresh1',
            'prompt-manager-codex-limits-Link01', 'prompt-manager-codex-limits-toolong1',
        ]);
        assert.equal((await readdir(target)).length, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
