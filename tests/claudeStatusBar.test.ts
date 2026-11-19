import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
const originalLoad = (Module as any)._load;

test('Claude status-bar marks old quota as approximate and never shows a reset five-hour value', async () => {
    let item: any;
    let installed = true;
    const listeners: Array<() => void> = [];
    const vscodeMock = {
        StatusBarAlignment: { Right: 2 },
        window: {
            createStatusBarItem: () => {
                item = { text: '', tooltip: '', show() { this.visible = true; }, hide() { this.visible = false; },
                    dispose() { this.visible = false; }, visible: false };
                return item;
            },
        },
        extensions: {
            getExtension: () => installed ? { id: 'anthropic.claude-code' } : undefined,
            onDidChange: (fn: () => void) => { listeners.push(fn); return { dispose() {} }; },
        },
    };
    (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
        if (request === 'vscode') return vscodeMock;
        return originalLoad.call(this, request, parent, isMain);
    };
    let provider: any;
    try {
        const { ClaudeAccountsStatusBarProvider } = await import('../src/providers/claudeAccountsStatusBarProvider.js');
        const now = Date.now();
        const accounts = {
            getView: () => ({ profiles: [{ id: 'default', label: 'Main', plan: 'Max', loggedIn: true }],
                activeId: 'default', pendingRestart: false }),
            getProfileDirectories: () => [{ id: 'default', directory: '/fake' }],
            onDidChange: (_fn: () => void) => ({ dispose() {} }),
        };
        const usage = {
            invalidate() {},
            read: async () => ({
                windows: [
                    { key: 'five_hour', label: '5ч', usedPercent: 18, remainingPercent: 82,
                        resetsAt: Math.floor(now / 1000) - 60 },
                    { key: 'seven_day', label: '7д', usedPercent: 3, remainingPercent: 97,
                        resetsAt: Math.floor(now / 1000) + 86400 },
                ],
                updatedAt: new Date(now - 60 * 60000).toISOString(),
                stale: true,
                source: 'native-cache',
            }),
        };
        let mode: 'used' | 'remaining' = 'used';
        const change: Array<() => void> = [];
        const preference = {
            getMode: () => mode,
            onDidChange: (cb: () => void) => {
                change.push(cb);
                return { dispose() {} };
            },
        };
        provider = new ClaudeAccountsStatusBarProvider(accounts as any, usage as any, preference as any);
        await provider.refresh();
        assert.match(item.text, /Claude исп\. 5ч: — · 7д: ≈3%/);
        assert.match(item.tooltip, /3% использовано/);
        mode = 'remaining';
        change.forEach(cb => cb());
        assert.match(item.text, /Claude ост\. 5ч: — · 7д: ≈97%/);
        assert.match(item.tooltip, /97% осталось/);
        assert.doesNotMatch(item.text, /82%/);
        assert.match(String(item.tooltip), /Значения устарели/);
        installed = false;
        for (const fn of listeners) fn();
        await provider.refresh();
        assert.equal(item.visible, false);
    } finally {
        provider?.dispose();
        (Module as any)._load = originalLoad;
    }
});
