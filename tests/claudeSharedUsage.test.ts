import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, readdir, stat, lstat, symlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    parseClaudeCliUsageText, parseClaudeCliReset, runClaudeCliUsage,
    claudeProjectKey, cleanupClaudeUsageProjectLeftovers,
} from '../src/services/claudeUsageCli.js';
import { ClaudeSharedUsageCoordinator } from '../src/services/claudeUsageShared.js';
import type { ClaudeLimitStatus } from '../src/services/claudeUsageService.js';

const execFileAsync = promisify(execFile);
const now = Date.parse('2026-11-19T05:00:00.000Z');
const sample = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 55% used · resets Nov 19, 2:50pm (Asia/Novosibirsk)',
    'Current week (all models): 24% used · resets Nov 25, 9am (Asia/Novosibirsk)',
    'Current week (Fable): 10% used · resets Nov 25, 9am (Asia/Novosibirsk)',
    '',
    'Top tasks: /private, my real prompt, ~/project/secret/project-name',
].join('\n');

function quota(time = Date.now()): ClaudeLimitStatus {
    return { windows: [{
        key: 'five_hour', label: '5ч', usedPercent: 55, remainingPercent: 45,
        resetsAt: Math.floor((time + 2 * 3600_000) / 1000),
    }], updatedAt: new Date(time).toISOString(), stale: false, source: 'claude-cli' };
}

test('Claude /usage parser extracts only percentages and timezone-correct resets', () => {
    const parsed = parseClaudeCliUsageText(sample, now);
    assert.equal(parsed.source, 'claude-cli');
    assert.deepEqual(parsed.windows.map(x => [x.key, x.usedPercent, x.remainingPercent]), [
        ['five_hour', 55, 45], ['seven_day', 24, 76], ['seven_day_model_fable', 10, 90],
    ]);
    assert.equal(parsed.windows[0].resetsAt, Math.floor(Date.parse('2026-11-19T07:50:00.000Z') / 1000));
    assert.equal(parsed.windows[1].resetsAt, Math.floor(Date.parse('2026-11-25T02:00:00.000Z') / 1000));
    assert.equal(parsed.windows.some(w => JSON.stringify(w).includes('secret')), false);
    assert.equal(parseClaudeCliReset('Dec 31, 11:40pm (Asia/Novosibirsk)', Date.parse('2026-12-31T14:00:00Z')),
        Date.parse('2026-12-31T16:40:00Z'));
    assert.equal(parseClaudeCliReset('Jan 1, 12am (Asia/Novosibirsk)', Date.parse('2026-12-31T14:00:00Z')),
        Date.parse('2026-12-31T17:00:00Z'));
    assert.equal(parseClaudeCliReset('bad reset', now), null);
    assert.throws(() => parseClaudeCliUsageText('Current session: unavailable'));
});

test('CLI wrapper accepts a zero-turn local command and never preserves the private report', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'pm-cli-probe-'));
    try {
        const executable = path.join(temp, 'fake-claude');
        const output = {
            type: 'result', is_error: false, num_turns: 0, total_cost_usd: 0, result: sample,
        };
        await writeFile(executable, '#!/usr/bin/env node\n'
            + 'process.stdout.write(' + JSON.stringify(JSON.stringify(output)) + ');\n', { mode: 0o700 });
        await chmod(executable, 0o700);
        const result = await runClaudeCliUsage(executable, path.join(os.homedir(), '.claude'));
        assert.deepEqual(result.windows.map(w => w.key), ['five_hour', 'seven_day', 'seven_day_model_fable']);
        assert.doesNotMatch(JSON.stringify(result), /private|secret|prompt/i);
    } finally { await rm(temp, { recursive: true, force: true }); }
});

test('five concurrent extension hosts share one global lock and exactly one CLI invocation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pm-claude-shared-process-'));
    const modulePath = require.resolve('../src/services/claudeUsageShared.js');
    const runsPath = path.join(dir, 'runs.txt');
    try {
        const worker = [
            "const {ClaudeSharedUsageCoordinator}=require(process.argv[1]);",
            "const fs=require('node:fs/promises');",
            "const root=process.argv[2];",
            "const marker=process.argv[3];",
            "const c=new ClaudeSharedUsageCoordinator(root,async()=>{",
            "  await fs.appendFile(marker, 'x');",
            "  await new Promise(r=>setTimeout(r,450));",
            "  return {source:'claude-cli',stale:false,updatedAt:new Date().toISOString(),windows:[",
            "    {key:'five_hour',label:'5ч',usedPercent:25,remainingPercent:75,resetsAt:null}",
            "  ]};",
            "});",
            "c.refresh('default','/home/alek/.claude').then(v=>process.stdout.write(v.reason)).catch(e=>{console.error(e.message);process.exitCode=1});",
        ].join('\n');
        const outcomes = await Promise.all(Array.from({ length: 5 }, () =>
            execFileAsync(process.execPath, ['-e', worker, modulePath, dir, runsPath], { timeout: 15_000 })));
        const reasons = outcomes.map(x => x.stdout.trim());
        assert.equal(reasons.filter(x => x === 'updated').length, 1, reasons.join(','));
        assert.equal((await readFile(runsPath, 'utf8')).length, 1);
        const fromAnotherWindow = new ClaudeSharedUsageCoordinator(dir, async () => {
            throw new Error('Must not run CLI again inside five-minute interval');
        });
        const next = await fromAnotherWindow.refresh('default', '/home/alek/.claude');
        assert.equal(next.reason, 'cooldown');
        assert.equal((await fromAnotherWindow.read('default', '/home/alek/.claude'))?.windows[0].remainingPercent, 75);
        const fileNames = (await import('node:fs/promises')).readdir(dir);
        const list = await fileNames;
        assert.equal(list.some(name => name === 'usage.lock'), false);
        assert.equal(list.some(name => name.includes('/home/alek')), false);
        assert.equal(list.filter(name => name.startsWith('quota-')).length, 1);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('distinct account profiles have separate caches but still share one global CLI lock', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pm-claude-shared-profiles-'));
    let runs = 0;
    const runner = async () => {
        runs++;
        await new Promise(resolve => setTimeout(resolve, 100));
        return quota();
    };
    try {
        const a = new ClaudeSharedUsageCoordinator(dir, runner);
        const b = new ClaudeSharedUsageCoordinator(dir, runner);
        const [first, second] = await Promise.all([
            a.refresh('account-A', '/tmp/account-A'), b.refresh('account-B', '/tmp/account-B'),
        ]);
        assert.deepEqual([first.reason, second.reason].sort(), ['locked', 'updated']);
        assert.equal(runs, 1);
        const retry = await b.refresh(second.reason === 'locked' ? 'account-B' : 'account-A',
            second.reason === 'locked' ? '/tmp/account-B' : '/tmp/account-A');
        assert.equal(retry.reason, 'updated');
        assert.equal(runs, 2);
        assert.ok(await b.read('account-A', '/tmp/account-A'));
        assert.ok(await b.read('account-B', '/tmp/account-B'));
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('manual refresh has a global one-minute minimum; failure gets shared exponential backoff', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pm-claude-shared-backoff-'));
    let clock = Date.parse('2026-11-19T06:00:00Z');
    let runs = 0;
    const coordinator = new ClaudeSharedUsageCoordinator(dir, async () => {
        runs++;
        if (runs === 1) return quota(clock);
        throw new Error('network error');
    }, () => clock);
    try {
        assert.equal((await coordinator.refresh('a', '/tmp/a')).reason, 'updated');
        assert.equal((await coordinator.refresh('a', '/tmp/a', true)).reason, 'cooldown');
        clock += 61_000;
        assert.equal((await coordinator.refresh('a', '/tmp/a', true)).reason, 'error');
        assert.equal((await coordinator.refresh('a', '/tmp/a')).reason, 'cooldown');
        assert.equal(runs, 2);
        assert.equal((await coordinator.read('a', '/tmp/a'))?.windows[0].usedPercent, 55);
        // No unbounded retries during an upstream outage.
        clock += 2 * 60_000;
        assert.equal((await coordinator.refresh('a', '/tmp/a')).reason, 'cooldown');
        assert.equal(runs, 2);
    } finally { await rm(dir, { recursive: true, force: true }); }
});


test('multiple Prompt Manager services read the same global per-account cache', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pm-claude-usage-service-'));
    const config = path.join(root, 'profile-config');
    await mkdir(config);
    const cli = path.join(root, 'mock-claude');
    const printed = {
        type: 'result', is_error: false, num_turns: 0, total_cost_usd: 0,
        result: [
            'Current session: 12% used',
            'Current week (all models): 39% used',
        ].join('\n'),
    };
    await writeFile(cli, '#!/usr/bin/env node\nprocess.stdout.write('
        + JSON.stringify(JSON.stringify(printed)) + ');\n', { mode: 0o700 });
    await chmod(cli, 0o700);
    try {
        const { ClaudeUsageService } = await import('../src/services/claudeUsageService.js');
        const sharedRoot = path.join(root, 'shared-quota');
        const first = new ClaudeUsageService(path.join(root, 'host-a'), cli, sharedRoot);
        const second = new ClaudeUsageService(path.join(root, 'host-b'), cli, sharedRoot);
        assert.equal((await first.refreshActive('work', config))?.reason, 'updated');
        const status = await second.read('work', config, true);
        assert.equal(status.source, 'claude-cli');
        assert.deepEqual(status.windows.map(x => x.remainingPercent), [88, 61]);
        assert.equal((await second.refreshActive('work', config))?.reason, 'cooldown');
        // Another VS Code window may have a different local profile ID for the
        // same credential directory. It must still use the same cache.
        const sameAccountDifferentId = await second.read('personal', config, true);
        assert.equal(sameAccountDifferentId.source, 'claude-cli');
        assert.equal((await second.refreshActive('personal', config))?.reason, 'cooldown');
    } finally { await rm(root, { recursive: true, force: true }); }
});


test('five windows safely recover one stale global lock without duplicate CLI processes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pm-claude-stale-lock-'));
    let runs = 0;
    try {
        const lock = path.join(root, 'usage.lock');
        await mkdir(lock);
        const aged = new Date(Date.now() - 180_000);
        const { utimes } = await import('node:fs/promises');
        await utimes(lock, aged, aged);
        const participants = Array.from({ length: 5 }, () =>
            new ClaudeSharedUsageCoordinator(root, async () => {
                runs++;
                await new Promise(resolve => setTimeout(resolve, 120));
                return quota();
            }));
        const results = await Promise.all(participants.map(p => p.refresh('default', '/tmp/claude-default')));
        assert.equal(results.filter(x => x.reason === 'updated').length, 1);
        assert.equal(runs, 1);
        assert.equal((await participants[4].read('default', '/tmp/claude-default'))?.windows[0].remainingPercent, 45);
    } finally { await rm(root, { recursive: true, force: true }); }
});

/** Создаёт каталог проекта Claude с подкаталогом `memory` и необязательными файлами. */
async function makeProject(projects: string, name: string, files: Record<string, string> = {}): Promise<string> {
    const dir = path.join(projects, name);
    await mkdir(path.join(dir, 'memory'), { recursive: true });
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(dir, file), text);
    return dir;
}

test('Claude project key matches names left by temporary /usage working directories', () => {
    assert.equal(claudeProjectKey('/tmp/pm-claude-usage-7X283U'), '-tmp-pm-claude-usage-7X283U');
    assert.equal(claudeProjectKey('/home/user/.config/Code/x_y'), '-home-user--config-Code-x-y');
});

test('cleanup removes only empty leftover /usage projects and never follows symbolic links', async () => {
    if (process.platform === 'win32') return; // Символические ссылки на каталоги проверяются в POSIX.
    const root = await mkdtemp(path.join(os.tmpdir(), 'pm-claude-cleanup-'));
    try {
        const fakeTmp = path.join(root, 'tmp');
        await mkdir(fakeTmp);
        const prefix = claudeProjectKey(path.join(fakeTmp, 'pm-claude-usage-'));
        const projects = path.join(root, 'config', 'projects');
        await mkdir(projects, { recursive: true });
        await makeProject(projects, prefix + 'AbC123');
        await makeProject(projects, prefix + 'Keep01', { 'memory/note.md': 'note' });
        await makeProject(projects, prefix + 'Keep02', { 'session.jsonl': '{}' });
        await makeProject(projects, prefix + 'Keep007');
        await makeProject(projects, prefix + 'test-AbC123');
        await makeProject(projects, '-home-user-project');
        const outside = path.join(root, 'outside');
        await makeProject(outside, 'target');
        await symlink(path.join(outside, 'target'), path.join(projects, prefix + 'Link01'));
        await mkdir(path.join(projects, prefix + 'Link02'));
        await symlink(path.join(outside, 'target', 'memory'), path.join(projects, prefix + 'Link02', 'memory'));

        assert.equal(await cleanupClaudeUsageProjectLeftovers(path.join(root, 'config'), fakeTmp), 1);
        assert.deepEqual((await readdir(projects)).sort(), [
            '-home-user-project', prefix + 'Keep007', prefix + 'Keep01', prefix + 'Keep02',
            prefix + 'Link01', prefix + 'Link02', prefix + 'test-AbC123',
        ].sort());
        assert.equal((await lstat(path.join(projects, prefix + 'Link01'))).isSymbolicLink(), true);
        assert.deepEqual(await readdir(path.join(outside, 'target')), ['memory']);
        // Отсутствующий каталог projects не считается ошибкой.
        assert.equal(await cleanupClaudeUsageProjectLeftovers(path.join(root, 'missing'), fakeTmp), 0);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI /usage runs in a persistent working directory and the executable is resolved on every run', async () => {
    if (process.platform === 'win32') return; // Фиктивный CLI запускается через shebang.
    const root = await mkdtemp(path.join(os.tmpdir(), 'pm-claude-usage-cwd-'));
    try {
        const config = path.join(root, 'profile-config');
        const projects = path.join(config, 'projects');
        await mkdir(projects, { recursive: true });
        // Остаток прежнего запуска во временном каталоге системы, для которого Claude создал пустой проект.
        const leftover = claudeProjectKey(path.join(os.tmpdir(), 'pm-claude-usage-')) + 'Old123';
        await makeProject(projects, leftover);
        const cwdLog = path.join(root, 'cwd.log');
        const cli = path.join(root, 'mock-claude');
        const printed = {
            type: 'result', is_error: false, num_turns: 0, total_cost_usd: 0,
            result: 'Current session: 12% used\nCurrent week (all models): 39% used',
        };
        await writeFile(cli, '#!/usr/bin/env node\n'
            + 'require("node:fs").appendFileSync(' + JSON.stringify(cwdLog) + ', process.cwd() + "\\n");\n'
            + 'process.stdout.write(' + JSON.stringify(JSON.stringify(printed)) + ');\n', { mode: 0o700 });
        await chmod(cli, 0o700);

        let executable = path.join(root, 'not-installed-yet');
        let lookups = 0;
        const { ClaudeUsageService } = await import('../src/services/claudeUsageService.js');
        const usage = new ClaudeUsageService(path.join(root, 'storage'), () => {
            lookups++;
            return executable;
        });
        assert.equal(lookups, 0);
        // Claude Code установлен после создания сервиса: путь берётся при запуске, а не при активации.
        executable = cli;
        assert.equal((await usage.refreshActive('work', config))?.reason, 'updated');
        assert.equal(lookups, 1);

        const workingDir = path.join(root, 'storage', 'claude-usage-cwd');
        assert.equal((await stat(workingDir)).mode & 0o777, 0o700);
        const direct = await runClaudeCliUsage(cli, config, workingDir);
        assert.deepEqual(direct.windows.map(w => w.remainingPercent), [88, 61]);
        const runs = (await readFile(cwdLog, 'utf8')).trim().split('\n');
        assert.deepEqual(runs, [workingDir, workingDir]);
        assert.equal((await stat(workingDir)).isDirectory(), true);
        assert.deepEqual(await readdir(projects), []);
    } finally { await rm(root, { recursive: true, force: true }); }
});
