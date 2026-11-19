import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseClaudeUsageCache, ClaudeUsageService } from '../src/services/claudeUsageService.js';
import { resolveAccountProviderAvailability } from '../src/utils/accountProviders.js';

test('Claude limits parse both windows and never treat stale data as live', () => {
    const now = Date.now();
    const payload = {
        oauthAccount: { accountUuid: 'test-account' },
        cachedUsageUtilization: {
            accountUuid: 'test-account',
            fetchedAtMs: now - 1000,
            utilization: {
                five_hour: { utilization: 24.5, resets_at: new Date(now + 4 * 3600_000).toISOString() },
                seven_day: { utilization: 80, resets_at: new Date(now + 7 * 86400_000).toISOString() },
            },
        },
    };
    const data = parseClaudeUsageCache(payload, now);
    assert.equal(data.stale, false);
    assert.deepEqual(data.windows.map(x => [x.label, x.remainingPercent]), [['5ч', 75.5], ['7д', 20]]);
    assert.equal(parseClaudeUsageCache({ ...payload, oauthAccount: { accountUuid: 'other' } }, now).windows.length, 0);
    const older = { ...payload, cachedUsageUtilization: {
        ...payload.cachedUsageUtilization, fetchedAtMs: now - 2 * 3600_000,
    } };
    assert.equal(parseClaudeUsageCache(older, now).stale, true);
    assert.equal(parseClaudeUsageCache(null, now).windows.length, 0);
    assert.equal(parseClaudeUsageCache({ cachedUsageUtilization: {
        ...payload.cachedUsageUtilization, utilization: { five_hour: { utilization: 130 } },
    } }, now).windows.length, 0);
});

test('Claude usage service reads an isolated profile without making network requests', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pm-claude-usage-test-'));
    try {
        const now = Date.now();
        await writeFile(path.join(root, '.claude.json'), JSON.stringify({
            oauthAccount: { accountUuid: 'isolation' },
            cachedUsageUtilization: { accountUuid: 'isolation', fetchedAtMs: now, utilization: {
                five_hour: { utilization: 60, resets_at: new Date(now + 3600_000).toISOString() },
            } },
        }));
        const usage = new ClaudeUsageService();
        const data = await usage.read('isolated', root);
        assert.equal(data.windows[0].remainingPercent, 40);
        assert.equal(data.source, 'native-cache');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('provider detection hides absent blocks and supports both Copilot extension IDs', () => {
    assert.deepEqual(resolveAccountProviderAvailability(() => undefined),
        { codex: false, claude: false, copilot: false });
    assert.deepEqual(resolveAccountProviderAvailability(id =>
        ['anthropic.claude-code', 'github.copilot-chat'].includes(id) ? {} : undefined),
        { codex: false, claude: true, copilot: true });
    assert.deepEqual(resolveAccountProviderAvailability(id =>
        ['openai.chatgpt', 'github.copilot'].includes(id) ? {} : undefined),
        { codex: true, claude: false, copilot: true });
});

test('Claude account switch changes only CLAUDE_CONFIG_DIR and retains all other environment variables', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pm-claude-accounts-test-'));
    const extFolder = path.join(root, 'anthropic-extension');
    const bin = path.join(extFolder, 'resources', 'native-binary');
    await mkdir(bin, { recursive: true });
    const cli = path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (process.platform === 'win32') return; // Synthetic executable targets the Linux host.
    await writeFile(cli, '#!/bin/sh\nprintf \'{"loggedIn":true,"email":"account@example.test","planTier":"Pro"}\\n\'\n', { mode: 0o755 });
    const originalLoad = (Module as any)._load;
    let environment: Array<{ name?: string; value?: string }> = [{ name: 'SOME_EXISTING_VAR', value: 'preserve-me' }];
    const mocked = {
        EventEmitter: class<T> {
            private listeners: Array<(value: T) => void> = [];
            event = (fn: (value: T) => void) => { this.listeners.push(fn); return { dispose() { } }; };
            fire(v: T): void { this.listeners.forEach(fn => fn(v)); }
            dispose(): void { this.listeners = []; }
        },
        ConfigurationTarget: { Global: 1 },
        workspace: { getConfiguration: (_name: string) => ({
            get: (k: string) => k === 'environmentVariables' ? environment : undefined,
            inspect: (k: string) => k === 'environmentVariables' ? { globalValue: environment } : {},
            update: async (_key: string, value: typeof environment) => { environment = value; },
        }) },
        extensions: { getExtension: (id: string) => id === 'anthropic.claude-code' ? { extensionPath: extFolder } : undefined },
    };
    (Module as any)._load = function(request: string, parent: any, isMain: boolean) {
        if (request === 'vscode') return mocked;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const { ClaudeAccountService, buildClaudeEnvironmentVariables } = await import('../src/services/claudeAccountService.js');
        assert.deepEqual(buildClaudeEnvironmentVariables(environment, '/tmp/claude-alt'), [
            { name: 'SOME_EXISTING_VAR', value: 'preserve-me' },
            { name: 'CLAUDE_CONFIG_DIR', value: '/tmp/claude-alt' },
        ]);
        assert.deepEqual(buildClaudeEnvironmentVariables(
            [{ name: 'SOME_EXISTING_VAR', value: 'preserve-me' }, { name: 'CLAUDE_CONFIG_DIR', value: '/tmp/other' }],
            null,
        ), [{ name: 'SOME_EXISTING_VAR', value: 'preserve-me' }]);
        const profileDir = path.join(root, 'another');
        await mkdir(profileDir);
        const stored = new Map<string, unknown>();
        stored.set('promptManager.claudeProfiles.v1', {
            profiles: [{ id: 'alternate', label: 'Другой', email: null, plan: null,
                loggedIn: true, directory: profileDir }],
            pendingRestart: false,
        });
        const context: any = {
            globalStorageUri: { fsPath: root },
            globalState: { get: (key: string) => stored.get(key), update: async (key: string, val: unknown) => { stored.set(key, val); } },
        };
        const svc = new ClaudeAccountService(context);
        await svc.initialize();
        assert.equal(svc.getView().activeId, 'default');
        assert.equal(svc.getView().profiles.length, 2);
        const result = await svc.switchAccount('alternate');
        assert.equal(result.applied, false);
        assert.equal(svc.getView().pendingRestart, true);
        assert.equal(svc.getView().activeId, 'alternate');
        assert.deepEqual(environment, [
            { name: 'SOME_EXISTING_VAR', value: 'preserve-me' },
            { name: 'CLAUDE_CONFIG_DIR', value: profileDir },
        ]);
        svc.dispose();
    } finally {
        (Module as any)._load = originalLoad;
        await rm(root, { recursive: true, force: true });
    }
});
