import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuickCommandsWidget } from '../src/webview/editor/components/QuickCommandsWidget.js';
import { normalizeDashboardQuickCommandsWidgetState } from '../src/types/promptDashboardPreferences.js';

/** Показывает категории, управление строкой и индикатор только у вставляемой команды. */
test('Quick commands render categories, the Current agent and progress for the pending phrase', () => {
	const markup = renderToStaticMarkup(<QuickCommandsWidget
		items={[{ text: '/alek-review', category: 'Ревью' }, { text: 'есть еще уточнения или вопросы?' }]}
		target="current" pendingText="/alek-review"
		onTargetChange={() => undefined} onItemsChange={() => undefined} onInsert={() => undefined} onCopy={() => undefined}
	/>);
	assert.match(markup, /\/alek-review/);
	assert.match(markup, /есть еще уточнения или вопросы/);
	assert.match(markup, /aria-label="Целевой чат агента"/);
	assert.match(markup, /Claude Code/);
	assert.match(markup, /<option value="current" selected="">Текущий<\/option>/);
	assert.match(markup, /OpenAI Codex/);
	assert.match(markup, /OpenCode CLI/);
	assert.match(markup, /без отправки/);
	assert.match(markup, /Добавить быструю команду/);
	assert.match(markup, /Удалить команду/);
	assert.match(markup, /Копировать команду/);
	assert.match(markup, /aria-label="Ревью"/);
	assert.match(markup, /aria-label="Без категории"/);
	assert.equal([...markup.matchAll(/aria-busy="true"/g)].length, 1);
	assert.match(markup, /aria-busy="true"><span>\/alek-review<\/span>/);
});

/** Поддерживает прежние строки и читает упорядоченные записи с категориями. */
test('Global quick-command list keeps legacy phrases, categories and explicit empty lists', () => {
	const fallback = normalizeDashboardQuickCommandsWidgetState(undefined);
	assert.deepEqual(fallback.items, [{ text: '/alek-review' }, { text: 'есть еще уточнения или вопросы?' }]);
	assert.deepEqual(normalizeDashboardQuickCommandsWidgetState({
		items: [
			{ text: '/status', category: ' Git ' }, '/alek-review', '/alek-review', '  проверить изменения ',
			{ text: '' }, { category: 'Лишняя' }, 'x'.repeat(3001),
		],
		target: 'current',
	}), {
		items: [{ text: '/status', category: 'Git' }, { text: '/alek-review' }, { text: 'проверить изменения' }],
		target: 'current',
	});
	assert.deepEqual(normalizeDashboardQuickCommandsWidgetState({ items: [] }).items, []);
	assert.deepEqual(normalizeDashboardQuickCommandsWidgetState({ items: [], target: 'opencode-cli' }), {
		items: [], target: 'opencode-cli',
	});
	assert.equal(normalizeDashboardQuickCommandsWidgetState({ target: 'kilo' }).target, undefined);
});
