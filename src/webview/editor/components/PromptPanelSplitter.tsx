import React, { useEffect, useRef } from 'react';
import { subscribeDragPointerEvents, type DragPointerIdentity } from '../../shared/dragPointer';
import { useT } from '../../shared/i18n';
import {
	PROMPT_EDITOR_PANELS_GAP_PX,
	clampPromptEditorFormWidth,
	resolvePromptEditorFormWidthBounds,
	type PromptEditorFormWidthBounds,
} from '../../../utils/promptDashboard.js';

/** Смещение указателя, после которого нажатие становится перетаскиванием, а не щелчком. */
const PROMPT_PANEL_SPLITTER_DRAG_THRESHOLD_PX = 3;
/** Шаги клавиатуры в долях суммарной ширины панелей: обычный и с Shift. */
const PROMPT_PANEL_SPLITTER_KEY_STEP = 0.02;
const PROMPT_PANEL_SPLITTER_KEY_LARGE_STEP = 0.1;
/** Атрибут и CSS-переменная предпросмотра перекрывают inline-ширину React, не изменяя её. */
const PROMPT_PANEL_PREVIEW_ATTRIBUTE = 'data-pm-panel-preview';
const PROMPT_PANEL_PREVIEW_PROPERTY = '--pm-panel-preview-width';
/** Клавиши, изменяющие ширину; их отпускание завершает серию. */
const PROMPT_PANEL_SPLITTER_WIDTH_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

/**
 * Минимальная часть элемента формы для предпросмотра; позволяет тестировать жесты без DOM.
 * React-стили flex/width не трогаются, поэтому снятие предпросмотра не может затереть новую ширину React.
 */
export interface PromptPanelSplitterPreviewTarget {
	style: { setProperty(name: string, value: string): void; removeProperty(name: string): string };
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
}

/** Показывает ширину формы поверх inline-стиля React до сохранения. */
export function applyPromptPanelSplitterPreview(form: PromptPanelSplitterPreviewTarget, width: number): void {
	form.style.setProperty(PROMPT_PANEL_PREVIEW_PROPERTY, `${width}px`);
	form.setAttribute(PROMPT_PANEL_PREVIEW_ATTRIBUTE, 'true');
}

/** Снимает предпросмотр: форма снова получает ширину из текущего состояния React. */
export function clearPromptPanelSplitterPreview(form: PromptPanelSplitterPreviewTarget): void {
	form.removeAttribute(PROMPT_PANEL_PREVIEW_ATTRIBUTE);
	form.style.removeProperty(PROMPT_PANEL_PREVIEW_PROPERTY);
}

/** Окно, в котором отслеживается жест; resize окна во время жеста отменяет его. */
export type PromptPanelSplitterView = EventTarget & {
	innerWidth: number;
	requestAnimationFrame(callback: FrameRequestCallback): number;
	cancelAnimationFrame(handle: number): void;
};

/** Ручка разделителя с необязательной поддержкой pointer capture. */
export type PromptPanelSplitterHandle = EventTarget & {
	setPointerCapture?(pointerId: number): void;
	releasePointerCapture?(pointerId: number): void;
	hasPointerCapture?(pointerId: number): boolean;
};

/** Параметры одного pointer-жеста; тесты: promptPanelSplitter.test.tsx. */
export interface PromptPanelSplitterDragOptions {
	view: PromptPanelSplitterView;
	handle: PromptPanelSplitterHandle;
	form: PromptPanelSplitterPreviewTarget;
	pointer: DragPointerIdentity;
	originX: number;
	/**
	 * Фактическая ширина формы в момент превышения порога: между нажатием и порогом React может применить
	 * сохранённую серию клавиш или внешнее изменение настройки.
	 */
	startWidth(): number;
	/** Вызывается после порога перемещения, до первого предпросмотра. */
	onStart(): void;
	/** Обновляет доступные значения разделителя при каждом кадре предпросмотра. */
	onPreview?(width: number, bounds: PromptEditorFormWidthBounds): void;
	/** Получает итоговую ширину только для завершённого жеста, изменившего ширину. */
	onCommit(width: number, bounds: PromptEditorFormWidthBounds): void;
	/** Щелчок или жест, вернувшийся к исходной ширине: повтор отклонённой записи текущего значения. */
	onRetry(): void;
	/** Вызывается после onCommit, onRetry или отмены, если жест начался. */
	onEnd(): void;
	/** Вызывается при любом завершении, включая щелчок без перемещения. */
	onFinish?(): void;
}

/**
 * Ведёт перетаскивание разделителя: предпросмотр ширины применяется к DOM раз в кадр, без React-состояния.
 * Escape, blur, resize окна, потеря захвата и pointercancel снимают предпросмотр без сохранения.
 * Возвращает функцию отмены для размонтирования и нового жеста.
 */
export function startPromptPanelSplitterDrag(options: PromptPanelSplitterDragOptions): () => void {
	const { view, handle, form, pointer, originX } = options;
	let startWidth = 0;
	let width = 0;
	let bounds: PromptEditorFormWidthBounds | null = null;
	let started = false;
	let finished = false;
	let frame = 0;

	/** Применяет последнюю рассчитанную ширину в ближайшем кадре. */
	const applyPreview = () => {
		frame = 0;
		applyPromptPanelSplitterPreview(form, width);
		if (bounds) {
			options.onPreview?.(width, bounds);
		}
	};

	/** Пересчитывает ширину по координате; узкое окно отменяет жест. */
	const updateWidth = (clientX: number): boolean => {
		bounds = resolvePromptEditorFormWidthBounds(view.innerWidth);
		if (!bounds) {
			return false;
		}
		width = clampPromptEditorFormWidth(bounds, startWidth + clientX - originX);
		return true;
	};

	/** Снимает подписки один раз; сохраняет только начавшийся жест, изменивший ширину. */
	const cleanup = (commit: boolean) => {
		if (finished) {
			return;
		}
		finished = true;
		stopTracking();
		view.removeEventListener('keydown', escape, true);
		view.removeEventListener('blur', cancel);
		view.removeEventListener('resize', cancel);
		handle.removeEventListener('lostpointercapture', cancel);
		if (frame) {
			view.cancelAnimationFrame(frame);
			frame = 0;
		}
		try {
			if (handle.hasPointerCapture?.(pointer.pointerId)) {
				handle.releasePointerCapture?.(pointer.pointerId);
			}
		} catch { /* Подписки окна завершают жест и без поддержки pointer capture. */ }
		if (started) {
			clearPromptPanelSplitterPreview(form);
			// Сначала регистрируется локальное намерение, затем onEnd применяет отложенные внешние настройки.
			if (commit && bounds && width !== startWidth) {
				options.onCommit(width, bounds);
			} else if (commit) {
				options.onRetry();
			}
			options.onEnd();
		} else if (commit) {
			options.onRetry();
		}
		options.onFinish?.();
	};
	/** Отмена без сохранения. */
	const cancel = () => cleanup(false);
	/** Escape отменяет жест и не передаётся другим обработчикам страницы. */
	const escape = (event: Event) => {
		if ((event as KeyboardEvent).key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			cancel();
		}
	};

	const stopTracking = subscribeDragPointerEvents(view, pointer, {
		move: event => {
			// Отпущенная вне окна кнопка мыши не присылает pointerup: такой жест отменяется.
			if (pointer.pointerType === 'mouse' && (event.buttons & 1) === 0) {
				cancel();
				return;
			}
			event.preventDefault();
			if (!started && Math.abs(event.clientX - originX) < PROMPT_PANEL_SPLITTER_DRAG_THRESHOLD_PX) {
				return;
			}
			if (!started) {
				startWidth = options.startWidth();
				width = startWidth;
			}
			const previousWidth = width;
			if (!updateWidth(event.clientX)) {
				cancel();
				return;
			}
			if (!started) {
				started = true;
				options.onStart();
			}
			if (width !== previousWidth && !frame) {
				frame = view.requestAnimationFrame(applyPreview);
			}
		},
		finish: event => {
			event.preventDefault();
			if (started && !updateWidth(event.clientX)) {
				cancel();
				return;
			}
			cleanup(true);
		},
		cancel,
	});
	view.addEventListener('keydown', escape, true);
	view.addEventListener('blur', cancel);
	view.addEventListener('resize', cancel);
	handle.addEventListener('lostpointercapture', cancel);
	try {
		handle.setPointerCapture?.(pointer.pointerId);
	} catch { /* В webview завершение жеста также отслеживается подписками окна. */ }
	return cancel;
}

/** Возвращает ширину формы для клавиши разделителя или null для клавиш, которые разделитель не обрабатывает. */
export function resolvePromptPanelSplitterKeyWidth(
	bounds: PromptEditorFormWidthBounds,
	currentWidth: number,
	key: string,
	shiftKey: boolean,
): number | null {
	const step = Math.max(1, Math.round(bounds.available
		* (shiftKey ? PROMPT_PANEL_SPLITTER_KEY_LARGE_STEP : PROMPT_PANEL_SPLITTER_KEY_STEP)));
	switch (key) {
		case 'ArrowLeft':
			return clampPromptEditorFormWidth(bounds, currentWidth - step);
		case 'ArrowRight':
			return clampPromptEditorFormWidth(bounds, currentWidth + step);
		case 'Home':
			return bounds.min;
		case 'End':
			return bounds.max;
		default:
			return null;
	}
}

/** Обработчики серии нажатий клавиш; тесты: promptPanelSplitter.test.tsx. */
export interface PromptPanelSplitterKeyboardOptions {
	form(): PromptPanelSplitterPreviewTarget | null;
	/** Начало серии, до первого предпросмотра. */
	onStart(): void;
	onPreview?(width: number, bounds: PromptEditorFormWidthBounds): void;
	/** Итог серии, изменившей ширину. */
	onCommit(width: number, bounds: PromptEditorFormWidthBounds): void;
	/** Ширина не изменилась (край диапазона или серия с возвратом): только повтор отклонённой записи. */
	onRetry(): void;
	/** Enter: автоматическая ширина. */
	onReset(): void;
	/** Завершение или отмена начавшейся серии. */
	onEnd(): void;
}

/** Состояние нажатия, переданное контроллеру клавиатуры. */
export interface PromptPanelSplitterKeyInput {
	key: string;
	shiftKey: boolean;
	repeat: boolean;
	/** Текущая ширина формы из состояния React. */
	formWidth: number;
	bounds: PromptEditorFormWidthBounds;
	/** Pointer-жест уже управляет шириной: клавиши не создают вложенную серию. */
	pointerActive: boolean;
}

/** Контроллер серии клавиш: предпросмотр на keydown, одно сохранение на keyup или blur. */
export interface PromptPanelSplitterKeyboard {
	/** Возвращает true, если нажатие обработано и действие браузера по умолчанию нужно отменить. */
	keyDown(input: PromptPanelSplitterKeyInput): boolean;
	/** Отпускание клавиши ширины завершает серию с сохранением. */
	keyUp(key: string): void;
	/** Завершает серию с сохранением (потеря фокуса ручкой). */
	commit(): void;
	/** Отменяет серию без сохранения (смена ширины окна, размонтирование). */
	cancel(): void;
}

/** Создаёт контроллер серии нажатий; серия хранится в замыкании и не зависит от перерисовок React. */
export function createPromptPanelSplitterKeyboard(options: PromptPanelSplitterKeyboardOptions): PromptPanelSplitterKeyboard {
	let series: { startWidth: number; width: number; bounds: PromptEditorFormWidthBounds } | null = null;

	/** Снимает предпросмотр и при необходимости сохраняет изменённую ширину. */
	const finish = (commit: boolean) => {
		const current = series;
		if (!current) {
			return;
		}
		series = null;
		const form = options.form();
		if (form) {
			clearPromptPanelSplitterPreview(form);
		}
		if (commit && current.width !== current.startWidth) {
			options.onCommit(current.width, current.bounds);
		} else if (commit) {
			options.onRetry();
		}
		options.onEnd();
	};

	return {
		keyDown(input) {
			if (input.pointerActive) {
				return false;
			}
			if (input.key === 'Enter') {
				finish(false);
				options.onReset();
				return true;
			}
			if (input.key === 'Escape') {
				const active = series !== null;
				finish(false);
				return active;
			}
			const width = resolvePromptPanelSplitterKeyWidth(input.bounds, series?.width ?? input.formWidth,
				input.key, input.shiftKey);
			const form = options.form();
			if (width === null || !form) {
				return false;
			}
			if (!series) {
				if (width === input.formWidth) {
					// На краю ширина не меняется; повтор нужен только для отклонённой записи того же значения.
					if (!input.repeat) {
						options.onRetry();
					}
					return true;
				}
				series = { startWidth: input.formWidth, width, bounds: input.bounds };
				options.onStart();
			} else {
				series.width = width;
			}
			applyPromptPanelSplitterPreview(form, width);
			options.onPreview?.(width, input.bounds);
			return true;
		},
		keyUp(key) {
			if (PROMPT_PANEL_SPLITTER_WIDTH_KEYS.includes(key)) {
				finish(true);
			}
		},
		commit: () => finish(true),
		cancel: () => finish(false),
	};
}

/** Обработчики состояния жеста в EditorApp: синхронная фиксация, состояние React и буферизация настроек. */
export interface PromptPanelResizeStateHandlers {
	flushSync(update: () => void): void;
	setResizing(active: boolean): void;
	setSettingsBuffered(active: boolean): void;
}

/**
 * Применяет начало или окончание жеста. Начало фиксируется синхронно: pointermove имеет непрерывный приоритет,
 * и без синхронной фиксации ResizeObserver сетки успел бы сообщить профиль колонок по первому кадру предпросмотра.
 * Окончание применяется обычным обновлением. Тесты: promptPanelSplitter.test.tsx.
 */
export function applyPromptPanelResizeState(active: boolean, handlers: PromptPanelResizeStateHandlers): void {
	if (active) {
		handlers.flushSync(() => handlers.setResizing(true));
	} else {
		handlers.setResizing(false);
	}
	handlers.setSettingsBuffered(active);
}

/** Значения ARIA в процентах ширины формы от суммы ширин обеих панелей. */
export function resolvePromptPanelSplitterAria(
	bounds: PromptEditorFormWidthBounds,
	formWidth: number,
): { now: number; min: number; max: number } {
	const percent = (value: number) => Math.round(value / bounds.available * 100);
	return { now: percent(clampPromptEditorFormWidth(bounds, formWidth)), min: percent(bounds.min), max: percent(bounds.max) };
}

/** Свойства разделителя; расчёт ширины и сохранение доли выполняет EditorApp. */
export interface PromptPanelSplitterProps {
	/** Ширина страницы, по которой рассчитана текущая компоновка. */
	pageWidth: number;
	/** Фактическая ширина формы из resolvePromptEditorLayout. */
	formWidth: number;
	/** Автоматический режим отображается в доступном описании значения. */
	automatic: boolean;
	/** Элемент формы для предпросмотра ширины без перерисовки редактора. */
	formRef: React.RefObject<HTMLElement>;
	/** Сообщает начало и конец жеста или серии нажатий клавиш. */
	onResizeStateChange(active: boolean): void;
	/** Сохраняет выбранную ширину формы. */
	onCommit(formWidth: number, bounds: PromptEditorFormWidthBounds): void;
	/** Повторяет отклонённую запись текущего значения, если она есть. */
	onRetry(): void;
	/** Возвращает автоматическую ширину. */
	onReset(): void;
}

/** Вертикальный разделитель формы и виджетов: мышь, перо, касание и клавиатура. */
export function PromptPanelSplitter(props: PromptPanelSplitterProps): React.ReactElement {
	const t = useT();
	const handleRef = useRef<HTMLDivElement>(null);
	const dragCancelRef = useRef<(() => void) | null>(null);
	const propsRef = useRef(props);
	propsRef.current = props;
	const bounds = resolvePromptEditorFormWidthBounds(props.pageWidth);
	// При 632 px форма и виджеты уже имеют минимальные ширины: менять нечего.
	const disabled = !bounds || bounds.max - bounds.min < 1;
	const aria = bounds ? resolvePromptPanelSplitterAria(bounds, props.formWidth) : null;

	/** Текст значения для экранного диктора. */
	const formatValueText = (now: number, automatic: boolean) => {
		const value = t('editor.panelSplitterValue').replace('{form}', String(now)).replace('{widgets}', String(100 - now));
		return automatic ? `${value}, ${t('editor.panelSplitterAuto')}` : value;
	};

	/** Обновляет ARIA напрямую, пока EditorApp не перерисовывается во время предпросмотра. */
	const previewAria = (width: number, previewBounds: PromptEditorFormWidthBounds) => {
		const handle = handleRef.current;
		if (handle) {
			const now = resolvePromptPanelSplitterAria(previewBounds, width).now;
			handle.setAttribute('aria-valuenow', String(now));
			handle.setAttribute('aria-valuetext', formatValueText(now, false));
		}
	};

	/**
	 * Отмечает активный жест для оформления и сообщает EditorApp о начале или окончании.
	 * В конце возвращает ARIA текущих props: React не обновит атрибут, если значение props не изменилось.
	 */
	const setActive = (active: boolean) => {
		const handle = handleRef.current;
		handle?.setAttribute('data-pm-panel-splitter-active', active ? 'true' : 'false');
		const current = propsRef.current;
		const currentBounds = resolvePromptEditorFormWidthBounds(current.pageWidth);
		if (!active && handle && currentBounds) {
			const now = resolvePromptPanelSplitterAria(currentBounds, current.formWidth).now;
			handle.setAttribute('aria-valuenow', String(now));
			handle.setAttribute('aria-valuetext', formatValueText(now, current.automatic));
		}
		current.onResizeStateChange(active);
	};

	// Контроллер создаётся один раз и читает актуальные props через ref.
	const keyboardRef = useRef<PromptPanelSplitterKeyboard | null>(null);
	if (!keyboardRef.current) {
		keyboardRef.current = createPromptPanelSplitterKeyboard({
			form: () => propsRef.current.formRef.current,
			onStart: () => setActive(true),
			onPreview: previewAria,
			onCommit: (width, commitBounds) => propsRef.current.onCommit(width, commitBounds),
			onRetry: () => propsRef.current.onRetry(),
			onReset: () => propsRef.current.onReset(),
			onEnd: () => setActive(false),
		});
	}
	const keyboard = keyboardRef.current;

	// Изменение ширины окна меняет границы: незавершённая серия клавиш отменяется без сохранения.
	useEffect(() => {
		keyboard.cancel();
	}, [keyboard, props.pageWidth]);

	// Размонтирование (переход в вертикальную компоновку) отменяет жест и серию без сохранения.
	useEffect(() => () => {
		dragCancelRef.current?.();
		keyboard.cancel();
	}, [keyboard]);

	/** Начинает pointer-жест основной кнопкой мыши, пером или касанием. */
	const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		const form = props.formRef.current;
		const handle = event.currentTarget;
		const view = handle.ownerDocument.defaultView;
		if (disabled || event.button !== 0 || !event.isPrimary || !form || !view) {
			return;
		}
		event.preventDefault();
		handle.focus({ preventScroll: true });
		keyboard.commit();
		dragCancelRef.current?.();
		const root = handle.ownerDocument.documentElement;
		const originalCursor = root.style.cursor;
		const cancel = startPromptPanelSplitterDrag({
			view,
			handle,
			form,
			pointer: { pointerId: event.pointerId, pointerType: event.pointerType },
			originX: event.clientX,
			startWidth: () => propsRef.current.formWidth,
			onStart: () => {
				// Курсор и запрет выделения сохраняются, даже если указатель ушёл с узкой ручки.
				root.style.cursor = 'col-resize';
				root.classList.add('pm-panel-splitter-resizing');
				setActive(true);
			},
			onPreview: previewAria,
			onCommit: (width, commitBounds) => propsRef.current.onCommit(width, commitBounds),
			onRetry: () => propsRef.current.onRetry(),
			onEnd: () => {
				root.style.cursor = originalCursor;
				root.classList.remove('pm-panel-splitter-resizing');
				setActive(false);
			},
			onFinish: () => {
				if (dragCancelRef.current === cancel) {
					dragCancelRef.current = null;
				}
			},
		});
		dragCancelRef.current = cancel;
	};

	/** Стрелки, Home и End показывают предпросмотр; Enter сбрасывает ширину; Escape отменяет серию. */
	const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (disabled || !bounds) {
			return;
		}
		const handled = keyboard.keyDown({
			key: event.key, shiftKey: event.shiftKey, repeat: event.repeat,
			formWidth: props.formWidth, bounds, pointerActive: dragCancelRef.current !== null,
		});
		if (handled) {
			event.preventDefault();
			if (event.key === 'Escape') {
				event.stopPropagation();
			}
		}
	};

	/** Двойной щелчок возвращает автоматическую ширину. */
	const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
		if (disabled) {
			return;
		}
		event.preventDefault();
		dragCancelRef.current?.();
		keyboard.cancel();
		propsRef.current.onReset();
	};

	return (
		<div
			ref={handleRef}
			className="pm-panel-splitter"
			role="separator"
			aria-orientation="vertical"
			aria-label={t('editor.panelSplitterLabel')}
			aria-valuenow={aria?.now}
			aria-valuemin={aria?.min}
			aria-valuemax={aria?.max}
			aria-valuetext={aria ? formatValueText(aria.now, props.automatic) : undefined}
			aria-disabled={disabled ? 'true' : undefined}
			aria-keyshortcuts="ArrowLeft ArrowRight Home End Enter Escape"
			title={t('editor.panelSplitterHint')}
			tabIndex={disabled ? -1 : 0}
			data-pm-panel-splitter="true"
			data-pm-panel-splitter-mode={props.automatic ? 'auto' : 'manual'}
			data-pm-panel-splitter-active="false"
			onPointerDown={handlePointerDown}
			onKeyDown={handleKeyDown}
			onKeyUp={event => keyboard.keyUp(event.key)}
			onBlur={() => keyboard.commit()}
			onDoubleClick={handleDoubleClick}
			style={splitterStyle}
		>
			<style>{PROMPT_PANEL_SPLITTER_STYLES}</style>
		</div>
	);
}

/** Разделитель занимает промежуток между панелями целиком; ширина входит в расчёт компоновки и порогов. */
const splitterStyle: React.CSSProperties = {
	position: 'relative',
	flex: `0 0 ${PROMPT_EDITOR_PANELS_GAP_PX}px`,
	width: `${PROMPT_EDITOR_PANELS_GAP_PX}px`,
	alignSelf: 'stretch',
	cursor: 'col-resize',
	touchAction: 'none',
	userSelect: 'none',
	outline: 'none',
	zIndex: 1,
};

/**
 * В покое линия 1 px едва заметна (цвет текста темы с малой непрозрачностью); при наведении, фокусе
 * и перетаскивании она становится 2 px цвета темы VS Code. Отступы до панелей задаёт ширина промежутка.
 * Предпросмотр перекрывает inline flex/width формы через !important и исчезает вместе с атрибутом.
 */
const PROMPT_PANEL_SPLITTER_STYLES = `
  [${PROMPT_PANEL_PREVIEW_ATTRIBUTE}="true"] {
    flex: 0 0 var(${PROMPT_PANEL_PREVIEW_PROPERTY}) !important;
    width: var(${PROMPT_PANEL_PREVIEW_PROPERTY}) !important;
  }
  .pm-panel-splitter::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    transform: translateX(-50%);
    background: color-mix(in srgb, var(--vscode-foreground, #cccccc) 14%, transparent);
    transition: background-color 0.12s ease 0.08s;
  }
  .pm-panel-splitter:not([aria-disabled="true"]):hover::before,
  .pm-panel-splitter[data-pm-panel-splitter-active="true"]::before {
    width: 2px;
    background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder, #3794ff));
  }
  .pm-panel-splitter:focus-visible::before {
    width: 2px;
    background: var(--vscode-focusBorder, #3794ff);
  }
  .pm-panel-splitter[aria-disabled="true"] { cursor: default !important; }
  .pm-panel-splitter-resizing, .pm-panel-splitter-resizing * { user-select: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .pm-panel-splitter::before { transition: none; }
  }
`;
