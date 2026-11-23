import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import React, { useState } from 'react';
import type { Root } from 'react-dom/client';
import type { QuickNoteView } from '../src/types/quickNotes.js';
import { createState, widgetDefaults } from './quickNotesWidgetFixture.js';

/** Монтирует виджет в отдельном документе и принимает изменения настроек, как панель редактора. */
async function mountWidget(t: TestContext, notes: QuickNoteView[] = []) {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	GlobalRegistrator.register();
	let root: Root | undefined;
	t.after(async () => {
		try {
			root?.unmount();
		} finally {
			await GlobalRegistrator.unregister();
		}
	});
	// React DOM определяет поддержку событий ввода при загрузке, после появления документа.
	const { flushSync } = await import('react-dom');
	const { createRoot } = await import('react-dom/client');
	const { QuickNotesWidget } = await import('../src/webview/editor/components/quickNotes/QuickNotesWidget.js');
	const state = createState(notes);
	/** Отражает выбранную область в свойствах виджета после щелчка. */
	function Widget(): React.ReactElement {
		const [preferences, setPreferences] = useState(widgetDefaults.preferences);
		return <QuickNotesWidget {...widgetDefaults} state={state} preferences={preferences}
			onPreferencesChange={patch => setPreferences(previous => ({ ...previous, ...patch }))} />;
	}
	const container = document.body.appendChild(document.createElement('div'));
	root = createRoot(container);
	flushSync(() => root!.render(<Widget />));
	return { container, flushSync };
}

/** Щелчок по области сохраняет обычный черновик и каретку после отложенного blur в webviewHtml. */
test('QuickNotesWidget keeps the typed draft focused after a pointer switches its scope', async t => {
	const { container, flushSync } = await mountWidget(t);
	const input = container.querySelector('textarea')!;
	flushSync(() => input.focus());
	const draft = 'До и после';
	// Нативный ввод меняет значение до события input, после чего React сохраняет его в черновике.
	flushSync(() => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, draft);
		input.dispatchEvent(new Event('input', { bubbles: true }));
	});
	input.setSelectionRange(3, 3);
	const scope = container.querySelector<HTMLButtonElement>('.pm-qn-add-colors .pm-qn-scope-toggle')!;
	assert.equal(scope.textContent, 'Проект');
	flushSync(() => {
		// По умолчанию мышь переводит фокус на кнопку, если pointerdown не был отменён.
		if (scope.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))) {
			scope.focus();
		}
		scope.click();
	});
	// Общий обработчик webview снимает фокус с нажатой кнопки на следующем кадре.
	await new Promise<void>(resolve => requestAnimationFrame(() => {
		flushSync(() => scope.blur());
		resolve();
	}));

	assert.ok(container.querySelector('.pm-qn-add.is-expanded'), 'черновик должен остаться раскрытым');
	assert.equal(scope.textContent, 'Глобальная');
	assert.ok(document.activeElement === input, 'фокус должен остаться в поле ввода');
	assert.equal(input.value, draft);
	assert.equal(input.selectionStart, 3);
	assert.equal(input.selectionEnd, 3);
});

/** Внутри предпросмотра фокус остаётся доступен, выход из webview закрывает карточку. */
test('QuickNotePreview dismisses on window blur and stays open for focus inside the card', async t => {
	const { container, flushSync } = await mountWidget(t, [{
		id: 'one', title: 'Заметка', description: '', scope: 'workspace', color: '', done: false, order: 0,
		items: [], files: [], createdAt: '', updatedAt: '',
	}]);
	const row = container.querySelector<HTMLElement>('.pm-qn-row')!;
	// В DOM без раскладки у строки нулевая высота. Предпросмотр открывается у видимого якоря.
	t.mock.method(row, 'getBoundingClientRect', () => new DOMRect(16, 60, 200, 30));
	flushSync(() => row.click());
	const card = document.querySelector<HTMLElement>('.pm-qn-preview')!;
	assert.ok(document.activeElement === card, 'открытый предпросмотр должен получить фокус');
	const close = card.querySelector('button')!;
	flushSync(() => close.focus());
	assert.ok(document.activeElement === close, 'фокус должен перейти на кнопку закрытия');
	assert.ok(card.isConnected);
	flushSync(() => window.dispatchEvent(new Event('blur')));
	assert.ok(!document.querySelector('.pm-qn-preview'), 'предпросмотр должен закрыться при выходе из webview');
});

/** У браузера pointerdown переводит фокус до click. Сохраняем выделение до этого перевода. */
test('widget editors return the original selection, respect new focus and can restore a remounted field', async t => {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	GlobalRegistrator.register();
	const { createRoot } = await import('react-dom/client');
	const { flushSync } = await import('react-dom');
	const { rememberWidgetDialogOpener, restoreWidgetDialogFocus, useWidgetDialogFocusHistory } =
		await import('../src/webview/editor/components/quickNotes/quickNotesFocus.js');
	function Page() { useWidgetDialogFocusHistory(); return <><textarea name="previous" defaultValue="workspace" /><button>Редактировать</button><input name="other" /></>; }
	const container = document.body.appendChild(document.createElement('div'));
	const root = createRoot(container);
	flushSync(() => root.render(<Page />));
	t.after(async () => { root.unmount(); await GlobalRegistrator.unregister(); });
	const trigger = container.querySelector('button')!;
	const original = container.querySelector('textarea')!;
	const other = container.querySelector('input')!;
	const capture = () => {
		original.focus();
		original.setSelectionRange(3, 7, 'backward');
		trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		trigger.focus();
		rememberWidgetDialogOpener(trigger);
	};
	capture();
	original.setSelectionRange(0, 0);
	assert.equal(restoreWidgetDialogFocus(trigger), true);
	assert.equal(document.activeElement, original);
	assert.deepEqual([original.selectionStart, original.selectionEnd, original.selectionDirection], [3, 7, 'backward']);
	capture();
	other.focus();
	assert.equal(restoreWidgetDialogFocus(trigger), false);
	assert.equal(document.activeElement, other);
	const dialog = document.body.appendChild(document.createElement('div'));
	dialog.setAttribute('aria-modal', 'true');
	dialog.tabIndex = -1;
	dialog.focus();
	assert.equal(restoreWidgetDialogFocus(trigger), false);
	assert.equal(document.activeElement, dialog);
	dialog.remove();
	const replacement = original.cloneNode(true) as HTMLTextAreaElement;
	original.replaceWith(replacement);
	assert.equal(restoreWidgetDialogFocus(trigger), true);
	assert.equal(document.activeElement, replacement);
	assert.deepEqual([replacement.selectionStart, replacement.selectionEnd, replacement.selectionDirection], [3, 7, 'backward']);
	replacement.replaceWith(original);
});

test('dialog updates recover a removed local control and leave the keyboard in another VS Code pane', async t => {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	GlobalRegistrator.register();
	const { createRoot } = await import('react-dom/client');
	const { flushSync } = await import('react-dom');
	const { focusInActiveWebview, restoreWidgetDialogFocus, useQuickNotesFocusFallback } =
		await import('../src/webview/editor/components/quickNotes/quickNotesFocus.js');
	const container = document.body.appendChild(document.createElement('div'));
	const opener = document.body.appendChild(document.createElement('button'));
	const root = createRoot(container);
	t.after(async () => { root.unmount(); await GlobalRegistrator.unregister(); });
	function Dialog({ showButton }: { showButton: boolean }) {
		const panel = React.useRef<HTMLDivElement>(null);
		useQuickNotesFocusFallback(panel);
		return <div ref={panel} tabIndex={-1}><input />{showButton && <button>Сохранить</button>}</div>;
	}
	const render = (showButton: boolean) => flushSync(() => root.render(<Dialog showButton={showButton} />));
	render(true);
	const field = container.querySelector('input')!;
	field.focus();
	container.querySelector('button')!.focus();
	render(false);
	assert.equal(document.activeElement, field);

	// Chromium may expose body as activeElement after an adjacent iframe takes focus.
	const fieldFocus = t.mock.method(field, 'focus');
	const panelFocus = t.mock.method(container.firstElementChild as HTMLElement, 'focus');
	const hasFocus = t.mock.method(document, 'hasFocus', () => false);
	field.blur();
	window.dispatchEvent(new Event('blur'));
	render(true);
	render(false);
	focusInActiveWebview(field);
	assert.equal(restoreWidgetDialogFocus(opener), false);
	hasFocus.mock.restore();
	render(true);
	assert.equal(panelFocus.mock.callCount(), 0);
	assert.equal(fieldFocus.mock.callCount(), 0);
});
