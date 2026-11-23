import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DragHandleIcon } from '../../shared/DragHandleIcon.js';
import { sectionDragStyles } from '../../shared/sectionDragStyles.js';
import { subscribeDragPointerEvents } from '../../shared/dragPointer';

/** Описывает место вставки относительно существующего раздела формы. */
export interface EditorSectionDropTarget {
	sectionKey: string;
	placement: 'before' | 'after';
}

/** Сохраняет скрытые разделы и меняет только положение переносимого ключа. */
export function reorderEditorSections(
	order: readonly string[], source: string, target: EditorSectionDropTarget,
): string[] {
	if (source === target.sectionKey || !order.includes(source) || !order.includes(target.sectionKey)) {
		return [...order];
	}
	const result = order.filter(key => key !== source);
	const index = result.indexOf(target.sectionKey) + (target.placement === 'after' ? 1 : 0);
	result.splice(index, 0, source);
	return result;
}

/** Выбирает видимый раздел по середине его высоты, включая промежутки и конец списка. */
export function resolveEditorSectionDropTarget(
	clientY: number,
	bounds: readonly { sectionKey: string; top: number; bottom: number }[],
	source: string,
): EditorSectionDropTarget | null {
	const candidates = bounds.filter(item => item.sectionKey !== source
		&& Number.isFinite(item.top) && Number.isFinite(item.bottom)).sort((left, right) => left.top - right.top);
	const next = candidates.find(item => clientY <= (item.top + item.bottom) / 2);
	if (next) {
		return { sectionKey: next.sectionKey, placement: 'before' };
	}
	const last = candidates[candidates.length - 1];
	return last ? { sectionKey: last.sectionKey, placement: 'after' } : null;
}

/** Находит реальный контейнер прокрутки, в том числе общую прокрутку вертикальной компоновки. */
export function findEditorSectionsScrollContainer(element: HTMLElement): HTMLElement {
	const view = element.ownerDocument.defaultView;
	let parent: HTMLElement | null = element;
	while (parent) {
		if (view && /(auto|scroll|overlay)/.test(view.getComputedStyle(parent).overflowY)
			&& parent.scrollHeight > parent.clientHeight) {
			return parent;
		}
		parent = parent.parentElement;
	}
	return (element.ownerDocument.scrollingElement ?? element.ownerDocument.documentElement) as HTMLElement;
}

/** Передаёт ручкам управление без перестройки дерева разделов и полей ввода. */
interface EditorSectionDragContextValue {
	disabled: boolean;
	dragged: string | null;
	start(event: React.PointerEvent<HTMLButtonElement>, key: string): void;
	keyboard(event: React.KeyboardEvent<HTMLButtonElement>, key: string): void;
}

/** Контекст доступен только разделам текущей вкладки. */
const EditorSectionDragContext = createContext<EditorSectionDragContextValue | null>(null);

/** В SSR нет DOM для восстановления фокуса; браузер восстанавливает его до отрисовки кадра. */
const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Отдельная ручка переноса не вызывает сворачивание раздела по нажатию на заголовок.
 * itemLabel меняет слово в подписи, например «заметку» для списка быстрых заметок.
 */
export function EditorSectionDragHandle({ sectionKey, title, itemLabel = 'раздел' }: {
	sectionKey: string;
	title: string;
	itemLabel?: string;
}): React.ReactElement | null {
	const context = useContext(EditorSectionDragContext);
	const [focused, setFocused] = useState(false);
	if (!context) {
		return null;
	}
	return (
		<button type="button" disabled={context.disabled}
			title={`Перетащить ${itemLabel}: ${title}. Стрелки — переместить; Home/End — в начало/конец.`}
			aria-label={`Перетащить ${itemLabel}: ${title}`} aria-keyshortcuts="ArrowUp ArrowDown Home End Escape"
			data-pm-editor-section-handle={sectionKey}
			onPointerDown={event => context.start(event, sectionKey)}
			onKeyDown={event => context.keyboard(event, sectionKey)}
			onClick={event => event.stopPropagation()}
			onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
			style={{
				...sectionDragStyles.handle,
				...(context.dragged === sectionKey ? sectionDragStyles.handleDragging : null),
				boxShadow: focused ? 'inset 0 0 0 1px var(--vscode-focusBorder)' : 'none',
				...(context.disabled ? { cursor: 'default', opacity: 0.5 } : null),
			}}
		>
			<DragHandleIcon />
		</button>
	);
}

/** Принимает разделы со стабильными ключами и общий порядок, включая временно скрытые разделы. */
interface SortableEditorSectionsProps {
	children: React.ReactNode;
	order: readonly string[];
	disabled?: boolean;
	scopeKey: string;
	onReorder(order: string[]): void;
	onDragStateChange?(dragging: boolean): void;
	/** Промежуток между элементами в пикселях; по умолчанию 12, как между разделами формы. */
	gap?: number;
}

/** Переставляет реальные узлы без CSS order; проверки — sortableEditorSections.test.tsx. */
export function SortableEditorSections(props: SortableEditorSectionsProps): React.ReactElement {
	// Стабильные ссылки позволяют закончить жест актуальным обработчиком после очередного render.
	const propsRef = useRef(props);
	propsRef.current = props;
	const rootRef = useRef<HTMLDivElement>(null);
	const cleanupRef = useRef<(() => void) | null>(null);
	const focusRef = useRef<HTMLButtonElement | null>(null);
	const [dragged, setDragged] = useState<string | null>(null);
	const [indicator, setIndicator] = useState<EditorSectionDropTarget | null>(null);

	// Новые ключи из children добавляются в конец; отсутствующие ключи остаются в сохранённом порядке.
	const sections = React.Children.toArray(props.children).filter(React.isValidElement) as React.ReactElement<{
		'data-pm-editor-section'?: string;
	}>[];
	const sectionsByKey = new Map(sections.map(section => [section.props['data-pm-editor-section'] ?? String(section.key), section]));
	const fullOrder = [...new Set([...props.order, ...sectionsByKey.keys()])];
	const visibleKeys = fullOrder.filter(key => sectionsByKey.has(key));
	const orderRef = useRef(fullOrder);
	orderRef.current = fullOrder;
	const visibleKeysRef = useRef(visibleKeys);
	visibleKeysRef.current = visibleKeys;

	// Отмена на смене промпта, вкладки, блокировки и при размонтировании освобождает все подписки.
	useEffect(() => {
		cleanupRef.current?.();
		return () => cleanupRef.current?.();
	}, [props.scopeKey, props.disabled]);

	// Перемещение DOM-узла не должно оставлять клавиатуру вне ручки, которой выполнили перенос.
	useClientLayoutEffect(() => {
		if (focusRef.current?.isConnected && focusRef.current.ownerDocument.hasFocus()) {
			focusRef.current.focus({ preventScroll: true });
		}
		focusRef.current = null;
	});

	/** Отправляет только фактическое изменение порядка и запоминает фокус ручки. */
	const commit = (source: string, target: EditorSectionDropTarget, handle: HTMLButtonElement) => {
		const next = reorderEditorSections(orderRef.current, source, target);
		if (next.some((key, index) => key !== orderRef.current[index])) {
			focusRef.current = handle;
			propsRef.current.onReorder(next);
		}
	};

	/** Обеспечивает тот же перенос с клавиатуры с учётом только доступных на вкладке разделов. */
	const keyboard = (event: React.KeyboardEvent<HTMLButtonElement>, key: string) => {
		if (event.key === 'Escape') {
			// Escape перехватывается только для отмены идущего переноса; иначе он закрывает окно или слой вокруг списка.
			if (cleanupRef.current) {
				event.preventDefault();
				event.stopPropagation();
				cleanupRef.current();
			}
			return;
		}
		if (props.disabled || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		cleanupRef.current?.();
		const keys = visibleKeysRef.current;
		const index = keys.indexOf(key);
		const toStart = event.key === 'ArrowUp' || event.key === 'Home';
		const targetIndex = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : index + (toStart ? -1 : 1);
		if (index >= 0 && targetIndex >= 0 && targetIndex < keys.length) {
			commit(key, { sectionKey: keys[targetIndex], placement: toStart ? 'before' : 'after' }, event.currentTarget);
		}
	};

	/** Ведёт один pointer-жест с порогом, индикатором вставки, отменой и автопрокруткой. */
	const start = (event: React.PointerEvent<HTMLButtonElement>, source: string) => {
		const root = rootRef.current;
		const view = root?.ownerDocument.defaultView;
		if (props.disabled || event.button !== 0 || !event.isPrimary || !root || !view) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		cleanupRef.current?.();
		const handle = event.currentTarget;
		handle.focus({ preventScroll: true });
		const pointer = { pointerId: event.pointerId, pointerType: event.pointerType };
		const origin = { x: event.clientX, y: event.clientY };
		let position = origin;
		let started = false;
		let finished = false;
		let animation = 0;
		let currentTarget: EditorSectionDropTarget | null = null;
		let stopTracking: () => void = () => {};

		/** Пересчитывает геометрию после движения указателя или прокрутки страницы. */
		const updateTarget = () => {
			const rect = root.getBoundingClientRect();
			currentTarget = position.x < rect.left || position.x > rect.right ? null : resolveEditorSectionDropTarget(
				position.y,
				Array.from(root.children).filter((element): element is HTMLElement => element instanceof view.HTMLElement)
					.map(element => ({ sectionKey: element.dataset.pmSortableSection ?? '',
						top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom })),
				source,
			);
			setIndicator(previous => previous?.sectionKey === currentTarget?.sectionKey
				&& previous?.placement === currentTarget?.placement ? previous : currentTarget);
		};

		/** Прокручивает найденный overflow-контейнер у края его видимой области, не создавая таймеров вне жеста. */
		const scroll = () => {
			if (!started || finished) {
				return;
			}
			const container = findEditorSectionsScrollContainer(root);
			const bounds = container.getBoundingClientRect();
			const pageScroll = container === root.ownerDocument.scrollingElement;
			const top = pageScroll ? 0 : Math.max(0, bounds.top);
			const bottom = pageScroll ? view.innerHeight : Math.min(view.innerHeight, bounds.bottom);
			const edge = Math.min(48, (bottom - top) / 3);
			const step = position.y < top + edge ? -12 : position.y > bottom - edge ? 12 : 0;
			if (step && position.x >= bounds.left && position.x <= bounds.right) {
				container.scrollTop += step;
				updateTarget();
			}
			animation = view.requestAnimationFrame(scroll);
		};

		/** Снимает все обработчики до releasePointerCapture, чтобы отмена не сработала повторно. */
		const cleanup = () => {
			if (finished) {
				return;
			}
			finished = true;
			stopTracking();
			view.cancelAnimationFrame(animation);
			view.removeEventListener('keydown', escape);
			view.removeEventListener('blur', cleanup);
			handle.removeEventListener('lostpointercapture', cleanup);
			cleanupRef.current = null;
			try {
				if (handle.hasPointerCapture(pointer.pointerId)) {
					handle.releasePointerCapture(pointer.pointerId);
				}
			} catch { /* Подписки окна работают и при отсутствии поддержки pointer capture. */ }
			setDragged(null);
			setIndicator(null);
			if (started) {
				propsRef.current.onDragStateChange?.(false);
			}
		};
		/** Отменяет перенос без сохранения порядка. */
		const escape = (keyEvent: KeyboardEvent) => {
			if (keyEvent.key === 'Escape') {
				keyEvent.preventDefault();
				cleanup();
			}
		};
		stopTracking = subscribeDragPointerEvents(view, pointer, {
			move: moveEvent => {
				if (pointer.pointerType === 'mouse' && (moveEvent.buttons & 1) === 0) {
					cleanup();
					return;
				}
				moveEvent.preventDefault();
				position = { x: moveEvent.clientX, y: moveEvent.clientY };
				if (!started && Math.hypot(position.x - origin.x, position.y - origin.y) < 5) {
					return;
				}
				if (!started) {
					started = true;
					setDragged(source);
					propsRef.current.onDragStateChange?.(true);
					animation = view.requestAnimationFrame(scroll);
				}
				updateTarget();
			},
			finish: finishEvent => {
				finishEvent.preventDefault();
				position = { x: finishEvent.clientX, y: finishEvent.clientY };
				if (started) {
					updateTarget();
					if (currentTarget) {
						commit(source, currentTarget, handle);
					}
				}
				cleanup();
			},
			cancel: cleanup,
		});
		cleanupRef.current = cleanup;
		view.addEventListener('keydown', escape);
		view.addEventListener('blur', cleanup);
		handle.addEventListener('lostpointercapture', cleanup);
		try {
			handle.setPointerCapture(pointer.pointerId);
		} catch { /* В webview завершение жеста также отслеживается подписками окна. */ }
	};

	return (
		<EditorSectionDragContext.Provider value={{ disabled: Boolean(props.disabled), dragged, start, keyboard }}>
			<div ref={rootRef} data-pm-sortable-editor-sections="true" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: props.gap ?? 12 }}>
				{visibleKeys.map(key => (
					<div key={key} data-pm-sortable-section={key} style={{
						...sectionDragStyles.wrapper,
						...(dragged === key ? sectionDragStyles.dragging : null),
					}}>
						{indicator?.sectionKey === key && indicator.placement === 'before'
							&& <div data-pm-section-drop-indicator="before" style={sectionDragStyles.indicator} aria-hidden="true" />}
						{sectionsByKey.get(key)}
						{indicator?.sectionKey === key && indicator.placement === 'after'
							&& <div data-pm-section-drop-indicator="after" style={sectionDragStyles.indicator} aria-hidden="true" />}
					</div>
				))}
			</div>
		</EditorSectionDragContext.Provider>
	);
}
