import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeStatusLineService } from '../src/services/claudeStatusLineService.js';
import { ClaudeUsageService, parseClaudeStatusLineSample, isClaudeWindowExpired } from '../src/services/claudeUsageService.js';

test('official Claude statusLine capture preserves settings and writes quota-only data', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pm-claude-statusline-'));
    const profile = path.join(root, 'profile');
    const storage = path.join(root, 'extension-store');
    await mkdir(profile);
    await writeFile(path.join(profile, 'settings.json'), JSON.stringify({
        model: 'test-model', hooks: { Stop: [{ command: 'other-hook' }] },
    }));
    const accounts = {
        onDidChange: () => ({ dispose() {} }),
        getProfileDirectories: () => [{ id: 'test', directory: profile }],
    };
    const service = new ClaudeStatusLineService({
        globalStorageUri: { fsPath: storage },
    } as any, accounts as any, () => undefined);
    try {
        await service.ensureConfigured();
        const config = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8'));
        assert.equal(config.model, 'test-model');
        assert.ok(config.hooks?.Stop?.length);
        assert.equal(config.statusLine.type, 'command');
        const scriptFile = path.join(storage, 'prompt-manager-statusline.cjs');
        assert.ok((await readFile(scriptFile, 'utf8')).includes('rate_limits'));
        const payload = JSON.stringify({
            session_id: 'session-must-not-be-saved', message: 'private-chat-text',
            rate_limits: {
                five_hour: { used_percentage: 26, resets_at: Math.ceil(Date.now() / 1000) + 3600 },
                seven_day: { used_percentage: 41, resets_at: Math.ceil(Date.now() / 1000) + 86400 },
            },
        });
        const child = spawnSync(process.execPath, [scriptFile], {
            env: { ...process.env, CLAUDE_CONFIG_DIR: profile },
            input: payload, encoding: 'utf8', timeout: 5000,
        });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stdout, '');
        const result = JSON.parse(await readFile(path.join(profile, 'prompt-manager-rate-limits.json'), 'utf8'));
        assert.equal(result.rate_limits.five_hour.used_percentage, 26);
        assert.equal(result.rate_limits.seven_day.used_percentage, 41);
        assert.equal('message' in result, false);
        assert.equal('session_id' in result, false);
        const usage = await new ClaudeUsageService().read('test', profile, true);
        assert.equal(usage.source, 'statusline');
        assert.equal(usage.stale, false);
        assert.deepEqual(usage.windows.map(w => w.remainingPercent), [74, 59]);
    } finally {
        service.dispose();
        await rm(root, { recursive: true, force: true });
    }
});

test('existing Claude statusLine is never replaced by Prompt Manager', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pm-statusline-custom-'));
    const profile = path.join(root, 'profile');
    await mkdir(profile);
    const config = { statusLine: { type: 'command', command: '/usr/local/bin/my-claude-statusline' } };
    await writeFile(path.join(profile, 'settings.json'), JSON.stringify(config));
    const service = new ClaudeStatusLineService({
        globalStorageUri: { fsPath: path.join(root, 'state') },
    } as any, {
        onDidChange: () => ({ dispose() {} }),
        getProfileDirectories: () => [{ id: 'test', directory: profile }],
    } as any, () => undefined);
    try {
        await service.ensureConfigured();
        assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8')), config);
    } finally {
        service.dispose();
        await rm(root, { recursive: true, force: true });
    }
});

test('expired Claude window is not a usable current percentage', () => {
    const now = Date.now();
    const sample = {
        fetchedAtMs: now - 40 * 60_000,
        rate_limits: {
            five_hour: { used_percentage: 18, resets_at: Math.floor(now / 1000) - 60 },
            seven_day: { used_percentage: 3, resets_at: Math.floor(now / 1000) + 3 * 86400 },
        },
    };
    const parsed = parseClaudeStatusLineSample(sample, now);
    assert.equal(parsed.source, 'statusline');
    assert.equal(parsed.stale, true);
    assert.equal(isClaudeWindowExpired(parsed.windows[0], now), true);
    assert.equal(isClaudeWindowExpired(parsed.windows[1], now), false);
    assert.equal(parseClaudeStatusLineSample({
        fetchedAtMs: now,
        rate_limits: { five_hour: { used_percentage: null }, seven_day: { used_percentage: '12' } },
    }, now).windows.length, 0);
});
