import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
	PromptPanelSplitter,
	applyPromptPanelResizeState,
	createPromptPanelSplitterKeyboard,
	resolvePromptPanelSplitterAria,
	resolvePromptPanelSplitterKeyWidth,
	startPromptPanelSplitterDrag,
	type PromptPanelSplitterDragOptions,
} from '../src/webview/editor/components/PromptPanelSplitter.js';
import { resolvePromptEditorFormWidthBounds } from '../src/utils/promptDashboard.js';

/** Отправляет событие с полями PointerEvent/KeyboardEvent; в Node нет DOM-конструкторов этих событий. */
function dispatch(target: EventTarget, type: string, properties: Record<string, unknown> = {}): Event {
	const event = Object.assign(new Event(type, { cancelable: true }), properties);
	target.dispatchEvent(event);
	return event;
}

/** Окно с управляемыми кадрами: предпросмотр применяется только при явном вызове flush. */
function createView(innerWidth = 1218) {
	const view = Object.assign(new EventTarget(), {
		innerWidth,
		frames: new Map<number, FrameRequestCallback>(),
		nextFrame: 1,
		requestAnimationFrame(callback: FrameRequestCallback): number {
			const id = view.nextFrame++;
			view.frames.set(id, callback);
			return id;
		},
		cancelAnimationFrame(id: number): void {
			view.frames.delete(id);
		},
		flush(): void {
			const callbacks = [...view.frames.values()];
			view.frames.clear();
			callbacks.forEach(callback => callback(0));
		},
	});
	return view;
}

/** Форма с журналом предпросмотра: inline-стили React не моделируются, потому что жест их не меняет. */
function createForm() {
	const properties = new Map<string, string>();
	const attributes = new Map<string, string>();
	return {
		properties,
		attributes,
		style: {
			setProperty: (name: string, value: string) => { properties.set(name, value); },
			removeProperty: (name: string) => { const value = properties.get(name) ?? ''; properties.delete(name); return value; },
		},
		setAttribute: (name: string, value: string) => { attributes.set(name, value); },
		removeAttribute: (name: string) => { attributes.delete(name); },
		/** Видимая ширина предпросмотра или null, если форма показывает ширину React. */
		preview(): string | null {
			return attributes.get('data-pm-panel-preview') === 'true' ? properties.get('--pm-panel-preview-width') ?? null : null;
		},
	};
}

/** Запускает жест от x = 600 при ширине формы 600 px и записывает вызовы обработчиков. */
function startDrag(overrides: Partial<PromptPanelSplitterDragOptions> = {}, pointerType = 'mouse') {
	const view = createView();
	const handle = Object.assign(new EventTarget(), {
		captured: new Set<number>(),
		setPointerCapture(id: number) { handle.captured.add(id); },
		releasePointerCapture(id: number) { handle.captured.delete(id); },
		hasPointerCapture(id: number) { return handle.captured.has(id); },
	});
	const form = createForm();
	const calls: string[] = [];
	const cancel = startPromptPanelSplitterDrag({
		view, handle, form,
		pointer: { pointerId: 1, pointerType },
		originX: 600,
		startWidth: () => 600,
		onStart: () => calls.push('start'),
		onPreview: width => calls.push(`preview:${width}`),
		onCommit: (width, bounds) => calls.push(`commit:${width}:${bounds.available}`),
		onRetry: () => calls.push('retry'),
		onEnd: () => calls.push('end'),
		onFinish: () => calls.push('finish'),
		...overrides,
	});
	const pointer = { pointerId: 1, pointerType, isPrimary: true };
	return {
		view, handle, form, calls, cancel,
		move: (clientX: number, buttons = 1) => dispatch(view, 'pointermove', { ...pointer, buttons, clientX }),
		up: (clientX: number) => dispatch(view, 'pointerup', { ...pointer, clientX }),
	};
}

/** Завершённый жест меняет ширину раз в кадр, сохраняет итог один раз и возвращает inline-стили React. */
test('startPromptPanelSplitterDrag previews once per frame and commits the final width once', () => {
	const drag = startDrag();
	assert.equal(drag.handle.hasPointerCapture(1), true);
	drag.move(602);
	assert.deepEqual(drag.calls, []);
	drag.move(650);
	drag.move(700);
	assert.deepEqual(drag.calls, ['start']);
	assert.equal(drag.view.frames.size, 1);
	assert.equal(drag.form.preview(), null);
	drag.view.flush();
	assert.equal(drag.form.preview(), '700px');
	assert.deepEqual(drag.calls, ['start', 'preview:700']);
	drag.up(720);
	assert.deepEqual(drag.calls, ['start', 'preview:700', 'commit:720:1200', 'end', 'finish']);
	// Предпросмотр снят полностью: ширину снова задаёт состояние React.
	assert.equal(drag.form.preview(), null);
	assert.equal(drag.form.properties.size + drag.form.attributes.size, 0);
	assert.equal(drag.handle.hasPointerCapture(1), false);
	assert.equal(drag.view.frames.size, 0);
	// После завершения поздние события и повторная отмена ничего не делают.
	drag.move(800);
	drag.up(800);
	drag.cancel();
	assert.equal(drag.calls.length, 5);
});

/** Ширина ограничена минимумами формы и виджетов независимо от положения указателя за пределами ручки. */
test('startPromptPanelSplitterDrag clamps the preview to both panel minimums', () => {
	const drag = startDrag();
	drag.move(-400);
	drag.view.flush();
	assert.equal(drag.form.preview(), '300px');
	drag.move(5000);
	drag.view.flush();
	assert.equal(drag.form.preview(), '880px');
	drag.up(5000);
	assert.deepEqual(drag.calls.slice(-3), ['commit:880:1200', 'end', 'finish']);
});

/** Щелчок и возврат к исходной ширине не сохраняют новую ширину, а только повторяют отклонённую запись. */
test('startPromptPanelSplitterDrag retries instead of committing a click or an unchanged width', () => {
	// Щелчок ничего не применяет к форме; повтор безопасен: без ошибки записи EditorApp ничего не отправит.
	const click = startDrag();
	click.move(601);
	click.up(601);
	assert.deepEqual(click.calls, ['retry', 'finish']);
	assert.equal(click.form.properties.size + click.form.attributes.size, 0);

	const back = startDrag();
	back.move(700);
	back.view.flush();
	back.up(600);
	assert.deepEqual(back.calls, ['start', 'preview:700', 'retry', 'end', 'finish']);
	assert.equal(back.form.preview(), null);
});

/** Начальная ширина читается при превышении порога: изменение React после нажатия не даёт скачка. */
test('startPromptPanelSplitterDrag reads the start width when the gesture starts', () => {
	let reactWidth = 600;
	const drag = startDrag({ startWidth: () => reactWidth });
	// Сохранённая серия клавиш или внешнее изменение применились между нажатием и порогом.
	reactWidth = 650;
	drag.move(602);
	drag.move(610);
	drag.view.flush();
	assert.equal(drag.form.preview(), '660px');
	reactWidth = 900;
	drag.move(620);
	drag.view.flush();
	assert.equal(drag.form.preview(), '670px');
	drag.up(620);
	assert.deepEqual(drag.calls.slice(-3), ['commit:670:1200', 'end', 'finish']);
});

/** Escape, blur, resize окна, отмена указателя, потеря захвата и отпущенная кнопка отменяют жест без записи. */
test('startPromptPanelSplitterDrag cancels without saving on every interruption', () => {
	const interruptions: [string, (drag: ReturnType<typeof startDrag>) => void][] = [
		['escape', drag => {
			const event = dispatch(drag.view, 'keydown', { key: 'Escape' });
			assert.equal(event.defaultPrevented, true);
		}],
		['blur', drag => dispatch(drag.view, 'blur')],
		['resize', drag => dispatch(drag.view, 'resize')],
		['pointercancel', drag => dispatch(drag.view, 'pointercancel', { pointerId: 1, pointerType: 'mouse', isPrimary: true })],
		['lostpointercapture', drag => dispatch(drag.handle, 'lostpointercapture')],
		['released-button', drag => drag.move(720, 0)],
		['stacked-window', drag => {
			drag.view.innerWidth = 600;
			drag.move(720);
		}],
		['unmount', drag => drag.cancel()],
	];
	for (const [name, interrupt] of interruptions) {
		const drag = startDrag();
		drag.move(700);
		drag.view.flush();
		drag.move(720);
		interrupt(drag);
		assert.deepEqual(drag.calls, ['start', 'preview:700', 'end', 'finish'], name);
		assert.equal(drag.form.preview(), null, name);
		assert.equal(drag.view.frames.size, 0, name);
		drag.up(750);
		assert.deepEqual(drag.calls, ['start', 'preview:700', 'end', 'finish'], name);
	}
});

/** Другие клавиши не отменяют жест, а Escape до начала перемещения просто снимает подписки. */
test('startPromptPanelSplitterDrag ignores unrelated keys and cancels silently before the threshold', () => {
	const drag = startDrag();
	dispatch(drag.view, 'keydown', { key: 'ArrowLeft' });
	drag.move(650);
	drag.up(650);
	assert.deepEqual(drag.calls, ['start', 'commit:650:1200', 'end', 'finish']);

	const early = startDrag();
	dispatch(early.view, 'keydown', { key: 'Escape' });
	early.move(700);
	early.up(700);
	assert.deepEqual(early.calls, ['finish']);
});

/** Перо и касание не требуют нажатой кнопки мыши в событиях движения. */
test('startPromptPanelSplitterDrag supports pen and touch pointers', () => {
	for (const pointerType of ['pen', 'touch']) {
		const drag = startDrag({}, pointerType);
		drag.move(500, 0);
		drag.up(500);
		assert.deepEqual(drag.calls, ['start', 'commit:500:1200', 'end', 'finish'], pointerType);
	}
});

/** Стрелки меняют ширину на 2% (Shift — 10%) суммарной ширины; Home/End выбирают края. */
test('resolvePromptPanelSplitterKeyWidth maps keys to clamped form widths', () => {
	const bounds = resolvePromptEditorFormWidthBounds(1218)!;
	assert.equal(resolvePromptPanelSplitterKeyWidth(bounds, 600, 'ArrowLeft', false), 576);
	assert.equal(resolvePromptPanelSplitterKeyWidth(bounds, 600, 'ArrowRight', false), 624);
	assert.equal(resolvePromptPanelSplitterKeyWidth(bounds, 600, 'ArrowRight', true), 720);
	assert.equal(resolvePromptPanelSplitterKeyWidth(bounds, 310, 'ArrowLeft', true), 300);
	assert.equal(resolvePromptPanelSplitterKeyWidth(bounds, 870, 'ArrowRight', false), 880);
	assert.equal(resolvePromptPanelSplitterKeyWidth(bounds, 600, 'Home', false), 300);
	assert.equal(resolvePromptPanelSplitterKeyWidth(bounds, 600, 'End', false), 880);
	for (const key of ['ArrowUp', 'Enter', 'Escape', 'a']) {
		assert.equal(resolvePromptPanelSplitterKeyWidth(bounds, 600, key, false), null);
	}
	// На пороге 638 px диапазон вырожден: клавиши не могут увести ширину за минимумы.
	const threshold = resolvePromptEditorFormWidthBounds(638)!;
	assert.equal(resolvePromptPanelSplitterKeyWidth(threshold, 300, 'ArrowRight', true), 300);
});

/** Создаёт контроллер клавиатуры с журналом вызовов и формой 600 px при странице 1218 px. */
function createKeyboard() {
	const form = createForm();
	const calls: string[] = [];
	const keyboard = createPromptPanelSplitterKeyboard({
		form: () => form,
		onStart: () => calls.push('start'),
		onPreview: width => calls.push(`preview:${width}`),
		onCommit: width => calls.push(`commit:${width}`),
		onRetry: () => calls.push('retry'),
		onReset: () => calls.push('reset'),
		onEnd: () => calls.push('end'),
	});
	const bounds = resolvePromptEditorFormWidthBounds(1218)!;
	/** Нажимает клавишу при текущей ширине React 600 px, если не указано иное. */
	const down = (key: string, extra: Partial<{ shiftKey: boolean; repeat: boolean; formWidth: number; pointerActive: boolean }> = {}) =>
		keyboard.keyDown({ key, shiftKey: false, repeat: false, formWidth: 600, bounds, pointerActive: false, ...extra });
	return { form, calls, keyboard, down };
}

/** Удерживаемая стрелка показывает предпросмотр на каждом повторе и сохраняет итог один раз при отпускании. */
test('createPromptPanelSplitterKeyboard commits one keyboard series on key release', () => {
	const kb = createKeyboard();
	assert.equal(kb.down('ArrowRight'), true);
	assert.equal(kb.down('ArrowRight', { repeat: true }), true);
	assert.equal(kb.down('ArrowRight', { repeat: true, shiftKey: true }), true);
	assert.equal(kb.form.preview(), '768px');
	kb.keyboard.keyUp('Shift');
	assert.deepEqual(kb.calls, ['start', 'preview:624', 'preview:648', 'preview:768']);
	kb.keyboard.keyUp('ArrowRight');
	assert.deepEqual(kb.calls.slice(-2), ['commit:768', 'end']);
	assert.equal(kb.form.preview(), null);
	kb.keyboard.keyUp('ArrowRight');
	kb.keyboard.commit();
	assert.equal(kb.calls.length, 6);
});

/** Серия, вернувшаяся к исходной ширине, не сохраняет новую ширину, а повторяет отклонённую запись. */
test('createPromptPanelSplitterKeyboard retries when a series returns to the start width', () => {
	const kb = createKeyboard();
	kb.down('ArrowRight');
	kb.down('ArrowLeft');
	kb.keyboard.keyUp('ArrowLeft');
	assert.deepEqual(kb.calls, ['start', 'preview:624', 'preview:600', 'retry', 'end']);
	assert.equal(kb.form.preview(), null);
});

/** Escape и отмена (resize окна, размонтирование) снимают предпросмотр без записи; blur сохраняет серию. */
test('createPromptPanelSplitterKeyboard cancels on Escape or cancel and commits on blur', () => {
	const escape = createKeyboard();
	escape.down('Home');
	assert.equal(escape.down('Escape'), true);
	escape.keyboard.keyUp('Home');
	assert.deepEqual(escape.calls, ['start', 'preview:300', 'end']);
	assert.equal(escape.form.preview(), null);
	// Escape без серии не перехватывается и остаётся доступным другим обработчикам.
	assert.equal(escape.down('Escape'), false);

	const cancelled = createKeyboard();
	cancelled.down('End');
	cancelled.keyboard.cancel();
	assert.deepEqual(cancelled.calls, ['start', 'preview:880', 'end']);

	const blurred = createKeyboard();
	blurred.down('ArrowLeft');
	blurred.keyboard.commit();
	assert.deepEqual(blurred.calls, ['start', 'preview:576', 'commit:576', 'end']);
});

/** Enter сбрасывает ширину, отменяя незавершённую серию без её сохранения. */
test('createPromptPanelSplitterKeyboard resets on Enter without saving an active series', () => {
	const kb = createKeyboard();
	assert.equal(kb.down('Enter'), true);
	kb.down('ArrowLeft');
	kb.down('Enter');
	kb.keyboard.keyUp('ArrowLeft');
	assert.deepEqual(kb.calls, ['reset', 'start', 'preview:576', 'end', 'reset']);
});

/** На краю диапазона ширина не меняется: только повтор отклонённой записи, без серии и автоповтора. */
test('createPromptPanelSplitterKeyboard only retries at the range edge', () => {
	const kb = createKeyboard();
	assert.equal(kb.down('End', { formWidth: 880 }), true);
	assert.equal(kb.down('ArrowRight', { formWidth: 880, repeat: true }), true);
	assert.equal(kb.down('Home', { formWidth: 300 }), true);
	kb.keyboard.keyUp('Home');
	assert.deepEqual(kb.calls, ['retry', 'retry']);
	assert.equal(kb.form.preview(), null);
});

/** Во время pointer-жеста и для посторонних клавиш контроллер ничего не делает. */
test('createPromptPanelSplitterKeyboard ignores keys during a pointer gesture and unrelated keys', () => {
	const kb = createKeyboard();
	assert.equal(kb.down('ArrowLeft', { pointerActive: true }), false);
	assert.equal(kb.down('Enter', { pointerActive: true }), false);
	assert.equal(kb.down('Tab'), false);
	assert.equal(kb.down('ArrowUp'), false);
	assert.deepEqual(kb.calls, []);
	const detached = createPromptPanelSplitterKeyboard({ form: () => null, onStart: () => assert.fail('start'),
		onCommit: () => assert.fail('commit'), onRetry: () => assert.fail('retry'), onReset: () => undefined,
		onEnd: () => assert.fail('end') });
	assert.equal(detached.keyDown({ key: 'End', shiftKey: false, repeat: false, formWidth: 600,
		bounds: resolvePromptEditorFormWidthBounds(1218)!, pointerActive: false }), false);
});

/** Начало жеста фиксируется синхронно до буферизации настроек, окончание — без синхронной фиксации. */
test('applyPromptPanelResizeState flushes only the start of a gesture', () => {
	const calls: string[] = [];
	const handlers = {
		flushSync: (update: () => void) => { calls.push('flush:start'); update(); calls.push('flush:end'); },
		setResizing: (active: boolean) => calls.push(`resizing:${active}`),
		setSettingsBuffered: (active: boolean) => calls.push(`buffered:${active}`),
	};
	applyPromptPanelResizeState(true, handlers);
	assert.deepEqual(calls, ['flush:start', 'resizing:true', 'flush:end', 'buffered:true']);
	calls.length = 0;
	applyPromptPanelResizeState(false, handlers);
	assert.deepEqual(calls, ['resizing:false', 'buffered:false']);
});

/** ARIA сообщает долю формы в процентах и допустимые пределы. */
test('resolvePromptPanelSplitterAria reports percentages of both panels', () => {
	const bounds = resolvePromptEditorFormWidthBounds(1218)!;
	assert.deepEqual(resolvePromptPanelSplitterAria(bounds, 600), { now: 50, min: 25, max: 73 });
	assert.deepEqual(resolvePromptPanelSplitterAria(bounds, 10), { now: 25, min: 25, max: 73 });
});

type TestWindow = Window & { __LOCALE__?: string };

/** Рендерит разделитель с русской локалью без DOM и внешних ресурсов. */
function renderSplitter(props: Partial<React.ComponentProps<typeof PromptPanelSplitter>> = {}): string {
	const globalScope = globalThis as typeof globalThis & { window?: TestWindow };
	const previousWindow = globalScope.window;
	Object.defineProperty(globalScope, 'window', { value: { __LOCALE__: 'ru' }, configurable: true, writable: true });
	try {
		return renderToStaticMarkup(React.createElement(PromptPanelSplitter, {
			pageWidth: 1218,
			formWidth: 600,
			automatic: false,
			formRef: React.createRef<HTMLElement>(),
			onResizeStateChange: () => undefined,
			onCommit: () => undefined,
			onRetry: () => undefined,
			onReset: () => undefined,
			...props,
		}));
	} finally {
		if (previousWindow === undefined) {
			Reflect.deleteProperty(globalScope as Record<string, unknown>, 'window');
		} else {
			globalScope.window = previousWindow;
		}
	}
}

/** Разметка доступна с клавиатуры и описывает текущее значение; на пороге разделитель отключён. */
test('PromptPanelSplitter renders an accessible vertical separator and disables a degenerate range', () => {
	// Проверяется только открывающий тег: встроенные стили содержат селекторы [aria-disabled].
	const openingTag = (props?: Parameters<typeof renderSplitter>[0]) => renderSplitter(props).match(/^<div[^>]*>/)?.[0] || '';
	const markup = openingTag({ automatic: true, formWidth: 840 });
	assert.match(markup, /role="separator"/);
	assert.match(markup, /aria-orientation="vertical"/);
	assert.match(markup, /aria-label="Ширина формы промпта и виджетов"/);
	assert.match(markup, /aria-valuenow="70"/);
	assert.match(markup, /aria-valuemin="25"/);
	assert.match(markup, /aria-valuemax="73"/);
	assert.match(markup, /aria-valuetext="Форма 70%, виджеты 30%, автоматическая ширина"/);
	assert.match(markup, /tabindex="0"/);
	assert.match(markup, /data-pm-panel-splitter-mode="auto"/);
	assert.doesNotMatch(markup, /aria-disabled/);
	assert.match(markup, /flex:0 0 18px;width:18px/);

	const manual = openingTag();
	assert.match(manual, /aria-valuetext="Форма 50%, виджеты 50%"/);
	assert.match(manual, /data-pm-panel-splitter-mode="manual"/);

	const threshold = openingTag({ pageWidth: 638, formWidth: 300 });
	assert.match(threshold, /aria-disabled="true"/);
	assert.match(threshold, /tabindex="-1"/);
});
