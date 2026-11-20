import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveQuotaHighlight } from '../src/utils/quotaHighlight.js';

/** Один цвет при одном уровне расхода, включая данные только об остатке. */
test('Quota highlighting uses the highest active quota at 60% and 90% consumed', () => {
    const now = 1795110000000;
    const window = (usedPercent: number) => ({ usedPercent, resetsAt: (now + 3600_000) / 1000 });
    assert.equal(resolveQuotaHighlight([window(59)], now), 'none');
    assert.equal(resolveQuotaHighlight([window(60)], now), 'warning');
    assert.equal(resolveQuotaHighlight([window(89)], now), 'warning');
    assert.equal(resolveQuotaHighlight([window(90)], now), 'critical');
    assert.equal(resolveQuotaHighlight([{ remainingPercent: 41 }], now), 'none');
    assert.equal(resolveQuotaHighlight([{ remainingPercent: 40 }], now), 'warning');
    assert.equal(resolveQuotaHighlight([{ remainingPercent: 10 }], now), 'critical');
    assert.equal(resolveQuotaHighlight([window(39), window(90)], now), 'critical');
    assert.equal(resolveQuotaHighlight([{ ...window(99), resetsAt: (now - 1000) / 1000 }], now), 'none');
    assert.equal(resolveQuotaHighlight([], now), 'none');
});
