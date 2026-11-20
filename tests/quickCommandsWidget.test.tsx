import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuickCommandsWidget } from '../src/webview/editor/components/QuickCommandsWidget.js';
import { normalizeDashboardQuickCommandsWidgetState } from '../src/types/promptDashboardPreferences.js';

test('Quick commands render compact editable phrases and an explicit provider selector', () => {
	const markup = renderToStaticMarkup(<QuickCommandsWidget
		items={['/alek-review', 'есть еще уточнения или вопросы?']}
		target="codex" onTargetChange={() => undefined} onItemsChange={() => undefined} onInsert={() => undefined}
	/>);
	assert.match(markup, /\/alek-review/);
	assert.match(markup, /есть еще уточнения или вопросы/);
	assert.match(markup, /aria-label="Целевой чат агента"/);
	assert.match(markup, /Claude Code/);
	assert.match(markup, /<option value="codex" selected="">OpenAI Codex<\/option>/);
	assert.match(markup, /OpenCode CLI/);
	assert.match(markup, /без отправки/);
	assert.match(markup, /Добавить быструю команду/);
	assert.match(markup, /Удалить команду/);
});

test('Global quick-command list starts with examples and accepts only bounded unique strings', () => {
	const fallback = normalizeDashboardQuickCommandsWidgetState(undefined);
	assert.deepEqual(fallback.items, ['/alek-review', 'есть еще уточнения или вопросы?']);
	assert.deepEqual(normalizeDashboardQuickCommandsWidgetState({
		items: ['/alek-review', '/alek-review', '  проверить изменения ', '', 'x'.repeat(3001)],
	}).items, ['/alek-review', 'проверить изменения']);
	assert.deepEqual(normalizeDashboardQuickCommandsWidgetState({ items: [] }).items, []);
	assert.deepEqual(normalizeDashboardQuickCommandsWidgetState({ items: [], target: 'opencode-cli' }), {
		items: [], target: 'opencode-cli',
	});
	assert.equal(normalizeDashboardQuickCommandsWidgetState({ target: 'kilo' }).target, undefined);
});
