import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CopilotUsageData } from '../src/services/copilotUsageService.js';
import { buildCopilotCreditsSnapshot } from '../src/utils/copilotCredits.js';
import { CopilotCreditsProgress } from '../src/webview/copilotUsage/CopilotCreditsProgress.js';

const now = Date.parse('2026-11-19T06:00:00.000Z');
const sample: CopilotUsageData = {
    used: 0,
    limit: 300,
    periodStart: '2026-11-01T00:00:00.000Z',
    periodEnd: '2026-11-30T00:00:00.000Z',
    lastUpdated: '2026-11-19T05:45:00.000Z',
    avgPerDay: 0,
    authenticated: true,
    planType: 'pro',
    source: 'api',
    snapshots: [],
};

test('Copilot credits use service totals, calculate percent used and the next period boundary', () => {
    const credits = buildCopilotCreditsSnapshot(sample, now);
    assert.ok(credits);
    assert.equal(credits.usedPercent, 0);
    assert.equal(credits.used, 0);
    assert.equal(credits.limit, 300);
    assert.equal(credits.estimated, false);
    assert.equal(credits.stale, false);
    assert.equal(credits.expired, false);
    assert.equal(new Date(credits.resetAt!).getDate(), 1);
    assert.equal(new Date(credits.resetAt!).getMonth(), 11);
    assert.equal(new Date(credits.resetAt!).getHours(), 0);

    const filled = buildCopilotCreditsSnapshot({ ...sample, used: 123, limit: 200 }, now);
    assert.equal(filled?.usedPercent, 62);
    assert.equal(buildCopilotCreditsSnapshot({ ...sample, used: 250, limit: 200 }, now)?.usedPercent, 125);
});

test('Copilot credits distinguish unavailable, estimated, stale and expired usage', () => {
    assert.equal(buildCopilotCreditsSnapshot(null, now), null);
    assert.equal(buildCopilotCreditsSnapshot({ ...sample, authenticated: false }, now), null);
    assert.equal(buildCopilotCreditsSnapshot({ ...sample, limit: 0 }, now), null);
    assert.equal(buildCopilotCreditsSnapshot({ ...sample, used: Number.NaN }, now), null);
    const local = buildCopilotCreditsSnapshot({
        ...sample, used: 35, source: 'inferred', lastUpdated: '2026-11-18T01:00:00.000Z',
    }, now);
    assert.equal(local?.estimated, true);
    assert.equal(local?.stale, true);
    assert.equal(buildCopilotCreditsSnapshot({ ...sample, periodStart: '2026-09-01T00:00:00.000Z' }, now)?.expired, true);
});

test('Copilot credits UI shows an accessible used-credit bar and does not invent quota when unavailable', () => {
    const credits = buildCopilotCreditsSnapshot(sample, now);
    assert.ok(credits);
    const markup = renderToStaticMarkup(<CopilotCreditsProgress credits={credits} switching={false} />);
    assert.match(markup, /Кредиты/);
    assert.match(markup, /0%/);
    assert.match(markup, /использовано/);
    assert.match(markup, /role="progressbar"/);
    assert.match(markup, /aria-valuenow="0"/);
    assert.match(markup, /300 кредитов/);
    assert.match(markup, /Ориентир возобновления/);

    const inferred = buildCopilotCreditsSnapshot({ ...sample, used: 50, limit: 100, source: 'local' }, now);
    const inferredMarkup = renderToStaticMarkup(<CopilotCreditsProgress credits={inferred} switching={false} />);
    assert.match(inferredMarkup, /50%/);
    assert.match(inferredMarkup, /расчётные данные/);

    const switching = renderToStaticMarkup(<CopilotCreditsProgress credits={credits} switching={true} />);
    assert.match(switching, /Переключаем аккаунт/);
    assert.doesNotMatch(switching, /role="progressbar"/);

    const noData = renderToStaticMarkup(<CopilotCreditsProgress credits={null} switching={false} />);
    assert.match(noData, /Данные о кредитах пока недоступны/);
    assert.doesNotMatch(noData, /role="progressbar"/);

    const expired = buildCopilotCreditsSnapshot({ ...sample, periodStart: '2026-09-01T00:00:00.000Z' }, now);
    const expiredMarkup = renderToStaticMarkup(<CopilotCreditsProgress credits={expired} switching={false} />);
    assert.match(expiredMarkup, /Период завершился/);
    assert.doesNotMatch(expiredMarkup, /role="progressbar"/);
});
