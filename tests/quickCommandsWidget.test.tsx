import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuickCommandsWidget } from '../src/webview/editor/components/QuickCommandsWidget.js';
import { DASHBOARD_QUICK_COMMAND_LIMIT, normalizeDashboardQuickCommandsWidgetState, serializeDashboardQuickCommands } from '../src/types/promptDashboardPreferences.js';
import { expandQuickCommandText } from '../src/utils/quickCommandTemplate.js';
import type { WebviewToExtensionMessage } from '../src/types/messages.js';
import type { QuickCommandTemplateResult } from '../src/utils/quickCommandTemplate.js';

/** Разделяет шапку и список так же, как панель, чтобы проверять расположение действий. */
function renderQuickCommands(
	props: Pick<React.ComponentProps<typeof QuickCommandsWidget>, 'items' | 'collapsed' | 'pendingTitle'>,
): string {
	return renderToStaticMarkup(<QuickCommandsWidget {...props} target="current"
		renderShell={(actions, body) => <section><header>{actions}</header>{body}</section>}
		onToggleCollapse={() => undefined} onTargetChange={() => undefined} onItemsChange={() => undefined}
		onEdit={() => undefined} onInsert={() => undefined} onCopy={() => undefined} />);
}

/** Показывает категории, управление строкой и индикатор только у вставляемой команды. */
test('Quick commands render categories, the Current agent and progress for the pending phrase', () => {
	const markup = renderQuickCommands({
		items: [{ title: '/alek-review', text: 'Одинаковый шаблон', category: 'Ревью' },
			{ title: 'есть еще уточнения или вопросы?', text: 'Одинаковый шаблон' }],
		collapsed: false, pendingTitle: '/alek-review',
	});
	const [header, body] = markup.split('</header>');
	assert.match(header, /aria-label="Поиск быстрых команд" aria-expanded="false"/);
	assert.match(header, /aria-label="Добавить быструю команду"/);
	assert.match(header, /aria-label="Целевой чат агента"/);
	assert.doesNotMatch(body, /<select|type="search"|aria-label="Добавить быструю команду"/);
	assert.match(markup, /\/alek-review/);
	assert.match(markup, /есть еще уточнения или вопросы/);
	assert.doesNotMatch(markup, /Одинаковый шаблон/);
	assert.match(markup, /Claude Code/);
	assert.match(markup, /<option value="current" selected="">Текущий<\/option>/);
	assert.match(markup, /OpenAI Codex/);
	assert.match(markup, /OpenCode CLI/);
	assert.match(markup, /без отправки/);
	assert.match(markup, /Удалить команду/);
	assert.match(markup, /Копировать команду/);
	assert.match(markup, /aria-label="Ревью"/);
	assert.match(markup, /aria-label="Без категории"/);
	assert.equal([...markup.matchAll(/aria-busy="true"/g)].length, 1);
	assert.match(markup, /aria-busy="true"><span>\/alek-review<\/span>/);
});

/** В свёрнутой карточке доступны действия шапки и действует общий лимит команд. */
test('Collapsed Quick Commands keeps its actions and disables Add at the command limit', () => {
	const markup = renderQuickCommands({
		items: Array.from({ length: DASHBOARD_QUICK_COMMAND_LIMIT }, (_, index) => ({ title: `command-${index}`, text: `command-${index}` })),
		collapsed: true,
	});
	assert.match(markup, /aria-label="Поиск быстрых команд" aria-expanded="false"/);
	assert.match(markup, /aria-label="Добавить быструю команду"[^>]+disabled=""/);
	assert.match(markup, /aria-label="Целевой чат агента"/);
	assert.doesNotMatch(markup, /class="pm-quick-commands"|type="search"|command-0</);
});

/** Поддерживает прежние строки и читает упорядоченные записи с категориями. */
test('Global quick-command list keeps legacy phrases, categories and explicit empty lists', () => {
	const fallback = normalizeDashboardQuickCommandsWidgetState(undefined);
	assert.deepEqual(fallback.items, [{ title: '/alek-review', text: '/alek-review' }, { title: 'есть еще уточнения или вопросы?', text: 'есть еще уточнения или вопросы?' }]);
	assert.deepEqual(normalizeDashboardQuickCommandsWidgetState({
		items: [
			{ text: '/status', category: ' Git ' }, '/alek-review', '/alek-review', '  проверить изменения ',
			{ text: '' }, { category: 'Лишняя' }, 'x'.repeat(3001),
		],
		target: 'current',
	}), {
		items: [{ title: '/status', text: '/status', category: 'Git' }, { title: '/alek-review', text: '/alek-review' }, { title: 'проверить изменения', text: 'проверить изменения' }],
		target: 'current',
	});
	assert.deepEqual(normalizeDashboardQuickCommandsWidgetState({ items: [] }).items, []);
	assert.deepEqual(normalizeDashboardQuickCommandsWidgetState({ items: [], target: 'opencode-cli' }), {
		items: [], target: 'opencode-cli',
	});
	assert.equal(normalizeDashboardQuickCommandsWidgetState({ target: 'kilo' }).target, undefined);
});

/** Различает старую фразу, название без текста и явно очищенный текст в настройках. */
test('named commands round-trip empty and multiline bodies without losing legacy defaults', () => {
	const state = normalizeDashboardQuickCommandsWidgetState({
		items: ['Legacy', 'constructor', { title: 'Empty' }, { title: 'Named', text: '  line 1\nline 2  ', category: 'Git' }],
		texts: { constructor: '' },
	});
	assert.deepEqual(state.items.map(item => item.text), ['Legacy', '', '', '  line 1\nline 2  ']);
	const config = serializeDashboardQuickCommands(state);
	assert.deepEqual(config.items, ['Legacy', 'constructor', 'Empty', 'Named']);
	assert.deepEqual(config.texts, { constructor: '', Empty: '', Named: '  line 1\nline 2  ' });
	assert.deepEqual(normalizeDashboardQuickCommandsWidgetState(config), state);
});

/** Маркеры в подставленном значении, знаки замены JS и чужие шаблоны остаются буквальным текстом. */
test('quick command expansion resolves known tokens once and preserves whitespace and literal replacements', () => {
	const reads: string[] = [];
	const value = '$& {{taskNumber}}';
	assert.deepEqual(expandQuickCommandText('  {{promptTitle}}\n{{ promptTitle }} {{custom}} {{constructor}}  ', key => {
		reads.push(key);
		return value;
	}), { text: `  ${value}\n${value} {{custom}} {{constructor}}  ` });
	assert.deepEqual(reads, ['promptTitle']);
});

/** Не показывает ответ от прежнего текста, другого промпта или закрытого предпросмотра. */
test('command preview follows unsaved edits and the current prompt and ignores late replies', { timeout: 8000 }, async t => {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	GlobalRegistrator.register();
	const { createRoot } = await import('react-dom/client');
	const { flushSync } = await import('react-dom');
	const { QuickCommandModal } = await import('../src/webview/editor/components/QuickCommandModal.js');
	type Request = Extract<WebviewToExtensionMessage, { type: 'promptDashboardQuickCommandPreview' }>;
	const posted: Request[] = [];
	let nextRequest: ((message: Request) => void) | undefined;
	const api = { postMessage(message: Request) { posted.push(message); nextRequest?.(message); nextRequest = undefined; } };
	Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: () => api });
	const root = createRoot(document.body.appendChild(document.createElement('div')));
	t.after(async () => {
		try { root.unmount(); } finally {
			Reflect.deleteProperty(globalThis, 'acquireVsCodeApi');
			await GlobalRegistrator.unregister();
		}
	});
	const item = { title: 'Проверка', text: '  Задача\n' };
	const session = { original: item, opener: document.body.appendChild(document.createElement('button')) };
	const prompt = { id: 'first', promptUuid: 'uuid', taskNumber: '007', title: 'Первый' };
	const render = (source: typeof prompt) => root.render(<QuickCommandModal session={session} items={[item]} prompt={source}
		onClose={() => assert.fail('Предпросмотр закрыл редактор')} />);
	const requestAfter = (action: () => void) => new Promise<Request>(resolve => { nextRequest = resolve; flushSync(action); });
	const reply = (request: Request, result: QuickCommandTemplateResult) => flushSync(() => window.dispatchEvent(new MessageEvent('message', {
		data: { type: 'promptDashboardQuickCommandPreviewResult', requestId: request.requestId, result },
	})));
	flushSync(() => render(prompt));
	const toggle = document.querySelector<HTMLButtonElement>('.pm-quick-command-preview button')!;
	const reveal = t.mock.method(toggle.parentElement!, 'scrollIntoView', () => {});
	const status = () => document.querySelector('[aria-label="Предпросмотр команды"]');
	assert.equal(toggle.getAttribute('aria-expanded'), 'false');
	assert.equal(posted.length, 0);
	const first = await requestAfter(() => toggle.click());
	assert.equal(first.text, item.text);
	assert.equal(reveal.mock.callCount(), 1);
	document.querySelector<HTMLElement>('.pm-qn-modal-b')!.scrollTop = 20;
	reply(first, { text: item.text });
	assert.equal(reveal.mock.callCount(), 1, 'Запоздалый ответ должен сохранить ручную прокрутку');
	const field = document.querySelector('textarea')!;
	field.setSelectionRange(field.value.length, field.value.length);
	const edited = await requestAfter(() => document.querySelector<HTMLButtonElement>('button[title="{{taskNumber}}"]')!.click());
	assert.equal(edited.text, '  Задача\n{{taskNumber}}');
	reply(first, { text: 'Старый результат' });
	assert.equal(status()?.getAttribute('aria-busy'), 'true');
	reply(edited, { text: '  Задача\n007 <b>\n' });
	assert.equal(status()?.querySelector('pre')?.textContent, '  Задача\n007 <b>\n');
	assert.equal(status()?.querySelector('b'), null);
	assert.equal(field.value, edited.text);
	const invalidated = await requestAfter(() => window.dispatchEvent(new MessageEvent('message', {
		data: { type: 'promptDashboardQuickCommandPreviewInvalidated' },
	})));
	assert.notEqual(invalidated.requestId, edited.requestId);
	assert.equal(invalidated.text, edited.text);
	reply(invalidated, { text: 'Новый каталог' });
	assert.equal(status()?.querySelector('pre')?.textContent, 'Новый каталог');
	const switched = await requestAfter(() => render({ ...prompt, id: 'second', taskNumber: '' }));
	assert.equal(switched.promptId, 'second');
	assert.equal(status()?.querySelector('pre'), null);
	reply(edited, { text: 'Чужая задача' });
	reply(switched, { error: 'Нет значения для переменной {{taskNumber}} в текущем контексте.' });
	assert.match(status()?.textContent ?? '', /Нет значения.*taskNumber/);
	flushSync(() => toggle.click());
	reply(switched, { text: 'Запоздалый ответ' });
	assert.equal(status(), null);
	assert.equal(field.value, edited.text);
	assert.ok(posted.every(message => message.type === 'promptDashboardQuickCommandPreview'));
});
