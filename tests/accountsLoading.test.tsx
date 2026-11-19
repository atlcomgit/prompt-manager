import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountsLoading } from '../src/webview/copilotUsage/AccountsLoading.js';

test('Accounts loading is centered, animated, accessible, and respects reduced motion', () => {
    const html = renderToStaticMarkup(<AccountsLoading />);
    assert.match(html, /class="pm-accounts-loading"/);
    assert.match(html, /role="status"/);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /inset: 0/);
    assert.match(html, /align-items: center/);
    assert.match(html, /justify-content: center/);
    assert.match(html, /@keyframes pm-accounts-spin/);
    assert.match(html, /animation: pm-accounts-spin/);
    assert.match(html, /prefers-reduced-motion: reduce/);
    assert.match(html, /class="pm-accounts-loading-spinner"/);
    assert.match(html, /Загружаем аккаунты/);
});

test('Accounts loading failure shows a retry action instead of an endless spinner', () => {
    const html = renderToStaticMarkup(<AccountsLoading error="Нет подключения" onRetry={() => undefined} />);
    assert.match(html, /aria-busy="false"/);
    assert.match(html, /Не удалось загрузить аккаунты/);
    assert.match(html, /Нет подключения/);
    assert.match(html, /Повторить/);
    assert.doesNotMatch(html, /class="pm-accounts-loading-spinner"/);
});
