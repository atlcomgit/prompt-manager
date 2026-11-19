import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Module from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    limitPercent, normalizeLimitDisplayMode, resolveAccountsBackendMode, limitDisplayShortLabel,
    limitDisplayVerb, copilotCreditsForMode,
} from '../src/utils/limitDisplay.js';
import { LimitDisplayToggle } from '../src/webview/copilotUsage/LimitDisplayToggle.js';
import { CopilotCreditsProgress } from '../src/webview/copilotUsage/CopilotCreditsProgress.js';

test('used is default, and Codex/Claude values convert from remaining percentage', () => {
    assert.equal(normalizeLimitDisplayMode(undefined), 'used');
    assert.equal(normalizeLimitDisplayMode('invalid'), 'used');
    assert.equal(normalizeLimitDisplayMode('remaining'), 'remaining');
    assert.equal(limitPercent({ usedPercent: 18, remainingPercent: 82 }, 'used'), 18);
    assert.equal(limitPercent({ usedPercent: 18, remainingPercent: 82 }, 'remaining'), 82);
    assert.equal(limitPercent({ remainingPercent: 97 }, 'used'), 3);
    assert.equal(limitPercent({ usedPercent: 3 }, 'remaining'), 97);
    assert.equal(limitPercent({ remainingPercent: 0 }, 'used'), 100);
    assert.equal(limitPercent({ remainingPercent: 100 }, 'used'), 0);
    assert.equal(limitPercent({ remainingPercent: NaN }, 'used'), null);
    assert.equal(limitDisplayVerb('used'), 'использовано');
    assert.equal(limitDisplayVerb('remaining'), 'осталось');
});

test('new Webview does not claim Used mode while old Extension Host still reports remaining', () => {
    assert.deepEqual(resolveAccountsBackendMode(undefined), { mode: 'remaining', supported: false });
    assert.deepEqual(resolveAccountsBackendMode(null), { mode: 'remaining', supported: false });
    assert.deepEqual(resolveAccountsBackendMode('used'), { mode: 'used', supported: true });
    assert.deepEqual(resolveAccountsBackendMode('remaining'), { mode: 'remaining', supported: true });
    assert.equal(limitDisplayShortLabel('used'), 'исп.');
    assert.equal(limitDisplayShortLabel('remaining'), 'ост.');
    const fallback = resolveAccountsBackendMode(undefined);
    const html = renderToStaticMarkup(
        <LimitDisplayToggle mode={fallback.mode} disabled={!fallback.supported} onChange={() => undefined}/>);
    assert.equal((html.match(/disabled=""/g) || []).length, 2);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /перезагрузите окно VS Code/);
});

test('Copilot credits use the same global mode for both progress and numeric credits', () => {
    const credits = { used: 75, limit: 300, usedPercent: 25 };
    assert.deepEqual(copilotCreditsForMode(credits, 'used'),
        { percent: 25, count: 75, label: 'использовано' });
    assert.deepEqual(copilotCreditsForMode(credits, 'remaining'),
        { percent: 75, count: 225, label: 'осталось' });
    const overage = { used: 125, limit: 100, usedPercent: 125 };
    assert.equal(copilotCreditsForMode(overage, 'remaining').percent, 0);
    assert.equal(copilotCreditsForMode(overage, 'remaining').count, 0);
});

test('Accounts page toggle renders accessible selected mode', () => {
    const result = renderToStaticMarkup(<LimitDisplayToggle mode="used" onChange={() => undefined}/>);
    assert.match(result, /aria-label="Как показывать лимиты"/);
    assert.match(result, /Использовано/);
    assert.match(result, /Осталось/);
    assert.match(result, /aria-pressed="true"/);
    const remaining = renderToStaticMarkup(<LimitDisplayToggle mode="remaining" onChange={() => undefined}/>);
    assert.match(remaining, /aria-pressed="true"/);
});

test('Copilot progress bar and description follow the globally selected quota mode', () => {
    const now = Date.now();
    const credits: any = {
        used: 75, limit: 300, usedPercent: 25, source: 'api', planType: 'pro',
        estimated: false, stale: false, expired: false, updatedAt: new Date(now).toISOString(),
        resetAt: new Date(now + 2 * 86400000).toISOString(),
    };
    const used = renderToStaticMarkup(<CopilotCreditsProgress credits={credits} switching={false} mode="used" now={now}/>);
    assert.match(used, /25%/);
    assert.match(used, /75 из 300 кредитов использовано/);
    assert.match(used, /aria-valuenow="25"/);
    const remaining = renderToStaticMarkup(<CopilotCreditsProgress credits={credits} switching={false} mode="remaining" now={now}/>);
    assert.match(remaining, /75%/);
    assert.match(remaining, /225 из 300 кредитов осталось/);
    assert.match(remaining, /aria-valuenow="75"/);
    assert.match(remaining, /Остаток кредитов GitHub Copilot/);
});

test('limit preference persists as an application-scope VS Code setting and notifies all windows', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
    const setting = manifest.contributes.configuration.properties['promptManager.accounts.limitDisplayMode'];
    assert.equal(setting.default, 'used');
    assert.equal(setting.scope, 'application');
    assert.deepEqual(setting.enum, ['used', 'remaining']);
    const originalLoad = (Module as any)._load;
    let mode = 'used';
    const listeners: Array<(event: { affectsConfiguration: (key: string) => boolean }) => void> = [];
    const vscodeMock = {
        EventEmitter: class<T> {
            private handlers: Array<(value: T) => void> = [];
            event = (fn: (value: T) => void) => {
                this.handlers.push(fn);
                return { dispose() {} };
            };
            fire(value: T): void { this.handlers.forEach(fn => fn(value)); }
            dispose(): void { this.handlers = []; }
        },
        ConfigurationTarget: { Global: 1 },
        workspace: {
            onDidChangeConfiguration: (listener: (event: any) => void) => {
                listeners.push(listener);
                return { dispose() {} };
            },
            getConfiguration: (_section: string) => ({
                get: (_key: string, fallback: string) => mode || fallback,
                update: async (_key: string, value: string, target: number) => {
                    assert.equal(target, 1);
                    mode = value;
                    for (const listener of listeners) {
                        listener({ affectsConfiguration: (key: string) => key === 'promptManager.accounts.limitDisplayMode' });
                    }
                },
            }),
        },
    };
    (Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
        if (request === 'vscode') return vscodeMock;
        return originalLoad.call(this, request, parent, isMain);
    };
    let one: any, two: any;
    try {
        const { AccountsLimitDisplayService } = await import('../src/services/accountsLimitDisplayService.js');
        one = new AccountsLimitDisplayService();
        two = new AccountsLimitDisplayService();
        const seen: string[] = [];
        two.onDidChange((value: string) => seen.push(value));
        assert.equal(one.getMode(), 'used');
        assert.equal(two.getMode(), 'used');
        await one.setMode('remaining');
        assert.equal(one.getMode(), 'remaining');
        assert.equal(two.getMode(), 'remaining');
        assert.ok(seen.includes('remaining'));
        await assert.rejects(one.setMode('unexpected'), /Неверный/);
    } finally {
        one?.dispose();
        two?.dispose();
        (Module as any)._load = originalLoad;
    }
});
