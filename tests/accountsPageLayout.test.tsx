import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatTimeUntilReset } from '../src/utils/resetCountdown.js';
import { AccountsPageFrame } from '../src/webview/copilotUsage/AccountsPageFrame.js';
import { CopilotCreditsProgress } from '../src/webview/copilotUsage/CopilotCreditsProgress.js';
import type { CopilotCreditsSnapshot } from '../src/utils/copilotCredits.js';

const now = Date.parse('2026-11-19T05:00:00.000Z');
const hour = 60 * 60 * 1000;
const day = 24 * hour;

test('countdown formats Unix seconds and ISO timestamps in days, hours and minutes', () => {
    assert.equal(formatTimeUntilReset((now + 2 * day + 5 * hour + 31 * 60_000) / 1000, now), '2 д 5 ч');
    assert.equal(formatTimeUntilReset(new Date(now + 8 * hour + 11 * 60_000).toISOString(), now), '8 ч 11 мин');
    assert.equal(formatTimeUntilReset((now + 37 * 60_000) / 1000, now), '37 мин');
    assert.equal(formatTimeUntilReset((now + 30_000) / 1000, now), 'менее 1 мин');
    assert.equal(formatTimeUntilReset((now - 1) / 1000, now), 'сброс уже наступил');
    assert.equal(formatTimeUntilReset(new Date(now).toISOString(), now), 'сброс уже наступил');
    assert.equal(formatTimeUntilReset(null, now), null);
    assert.equal(formatTimeUntilReset(undefined, now), null);
    assert.equal(formatTimeUntilReset('invalid reset date', now), null);
    assert.equal(formatTimeUntilReset(Number.NaN, now), null);
});

test('Accounts page uses its own full-height vertical scroll even when Webview body is overflow hidden', () => {
    const markup = renderToStaticMarkup(
        <AccountsPageFrame><section>Codex</section><section>Claude</section><section>Copilot</section></AccountsPageFrame>,
    );
    assert.match(markup, /<main class="pm-accounts-scroll"/);
    assert.match(markup, /height:100vh/);
    assert.match(markup, /overflow-y:auto/);
    assert.match(markup, /overflow-x:hidden/);
    assert.match(markup, /overscroll-behavior-y:contain/);
    assert.match(markup, /Codex/);
    assert.match(markup, /Claude/);
    assert.match(markup, /Copilot/);
});

test('Copilot credits show relative reset time and do not show a negative countdown after reset', () => {
    const credits: CopilotCreditsSnapshot = {
        used: 32, limit: 100, usedPercent: 32, source: 'api', planType: 'pro',
        estimated: false, stale: false, expired: false,
        updatedAt: new Date(now).toISOString(),
        resetAt: new Date(now + 3 * day + 6 * hour).toISOString(),
    };
    const markup = renderToStaticMarkup(<CopilotCreditsProgress credits={credits} switching={false} now={now} />);
    assert.match(markup, /Ориентир возобновления/);
    assert.match(markup, /осталось 3 д 6 ч/);
    assert.match(markup, /role="progressbar"/);

    const expired = renderToStaticMarkup(
        <CopilotCreditsProgress credits={credits} switching={false} now={now + 4 * day} />,
    );
    assert.match(expired, /Предыдущий период завершился/);
    assert.doesNotMatch(expired, /осталось 3 д 6 ч/);
    assert.doesNotMatch(expired, /role="progressbar"/);
});
