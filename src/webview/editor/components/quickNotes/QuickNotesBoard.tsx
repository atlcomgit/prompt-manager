/**
 * Доска быстрых заметок — содержимое отдельной страницы-вкладки: стикеры, фильтры, группировка по цвету и области, перенос.
 * Чистая логика отбора, групп и переноса — src/utils/quickNotes.ts; тесты разметки — tests/quickNotesComponents.test.tsx.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DashboardQuickNotesWidgetState } from '../../../../types/promptDashboardPreferences.js';
import {
	QUICK_NOTE_PALETTE_COLORS,
	type QuickNoteOperation,
	type QuickNoteScope,
	type QuickNotesBoardGroupBy,
	type QuickNotesState,
	type QuickNoteView,
} from '../../../../types/quickNotes.js';
import {
	collectQuickNoteColorKeys,
	formatQuickNoteShortDate,
	getQuickNoteChecklistProgress,
	getQuickNoteColorKey,
	groupQuickNotesForBoard,
	isQuickNoteScope,
	matchesQuickNoteFilter,
	prepareQuickNoteCreationInput,
	planQuickNoteBoardMove,
	QUICK_NOTE_NO_COLOR_KEY,
	resolveQuickNotesBoardColumnCount,
	resolveQuickNotesBoardNotes,
	type QuickNotesBoardDropTarget,
	type QuickNotesBoardGroup,
} from '../../../../utils/quickNotes.js';
import { getContextFileKind } from '../../../../utils/contextFiles.js';
import { subscribeDragPointerEvents } from '../../../shared/dragPointer';
import { QuickNoteIcon } from './QuickNoteIcon';
import { focusInActiveWebview, useQuickNotesFocusFallback } from './quickNotesFocus';
import { QUICK_NOTE_COLOR_LABELS, resolveQuickNoteColorCss, resolveQuickNoteColorLabel } from './quickNotesStyles';
import { resolveQuickNoteScopeLabel } from './QuickNotesWidget';

/** Порог движения указателя, после которого нажатие считается переносом стикера. */
const BOARD_DRAG_THRESHOLD_PX = 5;

/** В серверной отрисовке нет DOM для восстановления фокуса; браузер восстанавливает его до отрисовки кадра. */
const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Число колонок до первого измерения ширины (серверная отрисовка и первый кадр). */
const BOARD_DEFAULT_COLUMN_COUNT = 4;

/** Свойства доски. */
export interface QuickNotesBoardProps {
	state: QuickNotesState;
	preferences: DashboardQuickNotesWidgetState;
	newNoteIds: ReadonlySet<string>;
	/** Окно заметки открыто поверх доски: доска скрыта от чтения с экрана и не перехватывает фокус. */
	covered?: boolean;
	/** Причина последнего отказа операции; показывается до закрытия. */
	error?: string | null;
	onDismissError?(): void;
	onPreferencesChange(patch: Partial<DashboardQuickNotesWidgetState>): void;
	/** false — заметка не создана; обещание сообщает итог записи, при неудаче текст возвращается в пустое поле. */
	onCreate(input: { title: string; description: string; scope: QuickNoteScope; color: string; autoTitle?: boolean }): false | Promise<boolean>;
	onApply(operations: QuickNoteOperation[]): void;
	onToggleDone(note: QuickNoteView): void;
	onToggleItem(note: QuickNoteView, itemId: string): void;
	onSetColor(note: QuickNoteView, color: string): void;
	onOpen(note: QuickNoteView, navigationIds: string[]): void;
	/** Открывает quick-notes.json области с ошибкой чтения. */
	onOpenStorageFile?(scope: QuickNoteScope): void;
	onReload?(): void;
}

/** Состояние переноса: перетаскиваемая заметка и текущая цель вставки. */
interface BoardDragState {
	id: string;
	scope: QuickNoteScope;
	target: QuickNotesBoardDropTarget | null;
	x: number;
	y: number;
}

/** Делит ввод стикера: первая строка — название, остальное — описание. */
export function splitQuickNoteBoardInput(raw: string): { title: string; description: string; autoTitle?: boolean } {
	const [first = '', ...rest] = raw.split(/\r?\n/);
	return prepareQuickNoteCreationInput(first, rest.join('\n'));
}

/** При сетке порядок идёт по строкам; в группах стикеры идут вертикально. */
export function resolveQuickNoteDropPlacement(
	rect: { left: number; top: number; width: number; height: number },
	x: number, y: number, groupBy: QuickNotesBoardGroupBy,
): 'before' | 'after' {
	return (groupBy === 'none' ? x >= rect.left + rect.width / 2 : y >= rect.top + rect.height / 2)
		? 'after' : 'before';
}

/** Подпись группы доски. */
function resolveGroupLabel(groupBy: QuickNotesBoardGroupBy, key: string): string {
	if (groupBy === 'scope' && isQuickNoteScope(key)) {
		return key === 'global' ? 'Глобальные' : 'Проект';
	}
	return resolveQuickNoteColorLabel(key);
}

/** Доска заметок. */
export function QuickNotesBoard(props: QuickNotesBoardProps): React.ReactElement {
	const { state, preferences } = props;
	const [search, setSearch] = useState('');
	const [colors, setColors] = useState<string[]>([]);
	const [adding, setAdding] = useState<string | null>(null);
	const [addText, setAddText] = useState('');
	const [popoverId, setPopoverId] = useState<string | null>(null);
	const [drag, setDrag] = useState<BoardDragState | null>(null);
	const [columnCount, setColumnCount] = useState(BOARD_DEFAULT_COLUMN_COUNT);
	const rootRef = useRef<HTMLElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const addRef = useRef<HTMLTextAreaElement>(null);
	const addStickyRef = useRef<HTMLDivElement>(null);
	const suppressClickRef = useRef(false);
	const dragCleanupRef = useRef<(() => void) | null>(null);
	const focusNoteIdRef = useRef<string | null>(null);
	// Последнее состояние для завершения переноса: за время жеста заметки могли измениться в другом окне.
	const latestNotesRef = useRef(state.notes);
	latestNotesRef.current = state.notes;
	const groupBy = preferences.boardGroupBy;
	const workspaceAvailable = state.scopes.workspace.available;
	const availableScopes: QuickNoteScope[] = workspaceAvailable ? ['workspace', 'global'] : ['global'];
	const boardNotes = resolveQuickNotesBoardNotes(state.notes, {
		search, colors, scope: preferences.boardScope, showDone: preferences.boardShowDone,
	});
	const groups = groupQuickNotesForBoard(boardNotes, groupBy, state.notes, availableScopes);
	const openCount = state.notes.filter(note => !note.done).length;
	const doneCount = state.notes.length - openCount;
	const colorKeys = collectQuickNoteColorKeys(state.notes);
	const hasFilter = search.trim().length > 0 || colors.length > 0 || preferences.boardScope !== 'all';
	const navigationIds = boardNotes.map(note => note.id);

	// Клавиши страницы (N, /) работают сразу после открытия вкладки.
	useEffect(() => {
		focusInActiveWebview(rootRef.current);
	}, []);

	// После закрытия окна заметки, меню цвета или поля добавления фокус не теряется на body.
	useQuickNotesFocusFallback(rootRef, !props.covered);

	// Пересчёт колонок сетки по ширине области доски.
	useEffect(() => {
		const body = bodyRef.current;
		if (!body || typeof ResizeObserver === 'undefined') {
			return;
		}
		const update = () => setColumnCount(resolveQuickNotesBoardColumnCount(body.clientWidth - 40));
		update();
		const observer = new ResizeObserver(update);
		observer.observe(body);
		return () => observer.disconnect();
	}, []);

	// Незавершённый перенос снимается при закрытии доски.
	useEffect(() => () => dragCleanupRef.current?.(), []);

	// После переноса с клавиатуры фокус возвращается на тот же стикер в новом месте.
	useClientLayoutEffect(() => {
		const id = focusNoteIdRef.current;
		if (id) {
			focusNoteIdRef.current = null;
			focusInActiveWebview(rootRef.current?.querySelector<HTMLElement>(`[data-qn-sticky="${CSS.escape(id)}"]`));
		}
	});

	// Поле добавления получает фокус при открытии.
	useEffect(() => {
		if (adding !== null) {
			focusInActiveWebview(addRef.current);
		}
	}, [adding]);

	// После добавления поле остаётся для следующей заметки и закрывается, когда пользователь щёлкает или переходит
	// клавиатурой в другое место доски. Обработчик blur не подходит: страница снимает фокус с кнопки после щелчка,
	// и поле закрывалось бы от нажатия собственной кнопки области. Неотправленный текст сохраняется до следующего открытия.
	useEffect(() => {
		if (adding === null) {
			return;
		}
		const closeOutside = (event: Event) => {
			const container = addStickyRef.current;
			if (container && event.target instanceof Node && !container.contains(event.target)) {
				setAdding(null);
			}
		};
		document.addEventListener('pointerdown', closeOutside, true);
		document.addEventListener('focusin', closeOutside);
		return () => {
			document.removeEventListener('pointerdown', closeOutside, true);
			document.removeEventListener('focusin', closeOutside);
		};
	}, [adding]);

	/** Область и цвет новой заметки по фильтру и группе. */
	const resolveNewNoteTarget = (groupKey: string): { scope: QuickNoteScope; color: string } => {
		const fallbackScope: QuickNoteScope = workspaceAvailable ? preferences.newNoteScope : 'global';
		const scope = groupBy === 'scope' && isQuickNoteScope(groupKey)
			? groupKey
			: preferences.boardScope !== 'all' ? preferences.boardScope : fallbackScope;
		const color = groupBy === 'color' && groupKey !== QUICK_NOTE_NO_COLOR_KEY ? groupKey : '';
		return { scope, color };
	};

	/** Открывает поле новой заметки в группе; текст, не отправленный в прошлый раз, остаётся в поле. */
	const startAdding = (groupKey: string) => {
		setAdding(groupKey);
	};

	/** Добавляет заметку и оставляет поле для следующей. */
	const submitAdd = () => {
		if (adding === null) {
			return;
		}
		const raw = addText;
		const { title, description, autoTitle } = splitQuickNoteBoardInput(raw);
		if (!title) {
			return;
		}
		const target = resolveNewNoteTarget(adding);
		const saved = props.onCreate({ title, description, ...target, ...(autoTitle ? { autoTitle: true } : {}) });
		if (saved === false) {
			return;
		}
		// Добавленная заметка должна быть видна: поиск и цвета доски, которые её скрыли бы, сбрасываются.
		if (!matchesQuickNoteFilter({ title, description, items: [], ...target }, { search, colors })) {
			setSearch('');
			setColors([]);
		}
		setAddText('');
		addRef.current?.focus();
		// Несохранённый текст возвращается в поле, если там ещё не начата следующая заметка.
		void saved.then(ok => {
			if (!ok) {
				setAddText(current => current ? current : raw);
			}
		});
	};

	/**
	 * Перенос стикера с клавиатуры. В сетке порядок читается по рядам: Alt+←/→ — соседнее место,
	 * Alt+↑/↓ — ряд выше или ниже. В колонках группировки Alt+↑/↓ — внутри колонки, Alt+←/→ — в соседнюю колонку.
	 */
	const moveWithKeyboard = (note: QuickNoteView, key: string) => {
		const group = groups.find(entry => entry.notes.some(item => item.id === note.id));
		if (!group) {
			return;
		}
		let target: QuickNotesBoardDropTarget | null = null;
		const index = group.notes.findIndex(item => item.id === note.id);
		const last = group.notes.length - 1;
		// Шаг по списку: в сетке вертикальные стрелки переходят на ряд, то есть на число колонок.
		const step = groupBy === 'none' && (key === 'ArrowUp' || key === 'ArrowDown') ? columnCount : 1;
		const backward = groupBy === 'none' ? key === 'ArrowUp' || key === 'ArrowLeft' : key === 'ArrowUp';
		const forward = groupBy === 'none' ? key === 'ArrowDown' || key === 'ArrowRight' : key === 'ArrowDown';
		// Вверх и вниз в «Сетке» — только на место того же столбца: без ряда выше или ниже стикер не сдвигается
		// по диагонали в соседний столбец.
		if (backward && index - step >= 0) {
			target = { kind: 'note', noteId: group.notes[index - step].id, placement: 'before' };
		} else if (forward && index + step <= last) {
			target = { kind: 'note', noteId: group.notes[index + step].id, placement: 'after' };
		} else if ((key === 'ArrowLeft' || key === 'ArrowRight') && groupBy !== 'none') {
			const groupIndex = groups.indexOf(group) + (key === 'ArrowLeft' ? -1 : 1);
			if (groups[groupIndex]) {
				target = { kind: 'group', groupKey: groups[groupIndex].key };
			}
		}
		if (!target) {
			return;
		}
		const operations = planQuickNoteBoardMove({
			notes: state.notes, movingId: note.id, movingScope: note.scope, target, groupBy, at: new Date().toISOString(),
		});
		if (operations.length > 0) {
			focusNoteIdRef.current = note.id;
			props.onApply(operations);
		}
	};

	/** Определяет цель вставки под указателем: стикер с положением или колонка группы. */
	const resolvePointerTarget = (x: number, y: number, movingId: string): QuickNotesBoardDropTarget | null => {
		const element = document.elementFromPoint(x, y) as HTMLElement | null;
		const sticky = element?.closest<HTMLElement>('[data-qn-sticky]');
		const stickyId = sticky?.dataset.qnSticky;
		// Над самим переносимым стикером цели нет: отпускание на месте ничего не меняет.
		if (stickyId === movingId) {
			return null;
		}
		if (sticky && stickyId) {
			const rect = sticky.getBoundingClientRect();
			return { kind: 'note', noteId: stickyId, placement: resolveQuickNoteDropPlacement(rect, x, y, groupBy) };
		}
		const list = element?.closest<HTMLElement>('[data-qn-group]');
		if (list?.dataset.qnGroup && groupBy !== 'none') {
			return { kind: 'group', groupKey: list.dataset.qnGroup };
		}
		// Перетаскивание над промежутками сетки раньше теряло цель и не меняло позицию заметки.
		const body = bodyRef.current;
		if (groupBy === 'none' && body && element && body.contains(element)) {
			let nearest: { element: HTMLElement; distance: number } | null = null;
			for (const candidate of Array.from(body.querySelectorAll<HTMLElement>('[data-qn-sticky]'))) {
				if (candidate.dataset.qnSticky === movingId) continue;
				const rect = candidate.getBoundingClientRect();
				const dx = Math.max(rect.left - x, 0, x - rect.right);
				const dy = Math.max(rect.top - y, 0, y - rect.bottom);
				const distance = dx * dx + dy * dy;
				if (!nearest || distance < nearest.distance) nearest = { element: candidate, distance };
			}
			const candidate = nearest?.element;
			const candidateId = candidate?.dataset.qnSticky;
			if (candidate && candidateId) {
				return {
					kind: 'note', noteId: candidateId,
					placement: resolveQuickNoteDropPlacement(candidate.getBoundingClientRect(), x, y, groupBy),
				};
			}
		}
		return null;
	};

	/** Начинает отслеживание переноса стикера указателем с порогом движения. */
	const handleStickyPointerDown = (event: React.PointerEvent<HTMLElement>, note: QuickNoteView) => {
		if (event.button !== 0 || !event.isPrimary || (event.target as HTMLElement).closest('button, input, textarea, label')) {
			return;
		}
		// Предотвращаем native text selection и перетаскивание текста до появления drag threshold.
		event.preventDefault();
		event.currentTarget.focus({ preventScroll: true });
		dragCleanupRef.current?.();
		// Новое нажатие начинает жест с чистого листа, даже если прошлый перенос не завершился щелчком.
		suppressClickRef.current = false;
		const origin = { x: event.clientX, y: event.clientY };
		const pointer = { pointerId: event.pointerId, pointerType: event.pointerType };
		let started = false;
		let target: QuickNotesBoardDropTarget | null = null;
		/** Снимает подписки и состояние переноса. */
		const cleanup = () => {
			stop();
			window.removeEventListener('keydown', escape, true);
			dragCleanupRef.current = null;
			setDrag(null);
		};
		/** Escape отменяет перенос без изменений. */
		const escape = (keyEvent: KeyboardEvent) => {
			if (keyEvent.key === 'Escape') {
				keyEvent.preventDefault();
				keyEvent.stopPropagation();
				cleanup();
			}
		};
		const stop = subscribeDragPointerEvents(window, pointer, {
			move: moveEvent => {
				if (!started && Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < BOARD_DRAG_THRESHOLD_PX) {
					return;
				}
				moveEvent.preventDefault();
				started = true;
				suppressClickRef.current = true;
				target = resolvePointerTarget(moveEvent.clientX, moveEvent.clientY, note.id);
				// Прокрутка у края области доски, чтобы можно было перенести стикер за пределы видимой части.
				const body = bodyRef.current;
				if (body) {
					const rect = body.getBoundingClientRect();
					if (moveEvent.clientY < rect.top + 40) body.scrollTop -= 12;
					else if (moveEvent.clientY > rect.bottom - 40) body.scrollTop += 12;
					if (moveEvent.clientX < rect.left + 40) body.scrollLeft -= 12;
					else if (moveEvent.clientX > rect.right - 40) body.scrollLeft += 12;
				}
				setDrag({ id: note.id, scope: note.scope, target, x: moveEvent.clientX, y: moveEvent.clientY });
			},
			finish: () => {
				if (started && target) {
					const operations = planQuickNoteBoardMove({
						notes: latestNotesRef.current, movingId: note.id, movingScope: note.scope, target, groupBy, at: new Date().toISOString(),
					});
					if (operations.length > 0) {
						props.onApply(operations);
					}
				}
				// Щелчок после переноса приходит сразу за отпусканием; позже флаг снимается,
				// иначе при отпускании над другим элементом он проглотил бы следующий настоящий щелчок.
				if (started) {
					setTimeout(() => { suppressClickRef.current = false; }, 0);
				}
				cleanup();
			},
			cancel: cleanup,
		});
		window.addEventListener('keydown', escape, true);
		dragCleanupRef.current = cleanup;
	};

	/** Клавиши доски: Escape закрывает меню цвета, поле добавления и очищает поиск; N — новая заметка, / — поиск. */
	const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
		const target = event.target as HTMLElement;
		const typing = /^(INPUT|TEXTAREA)$/.test(target.tagName);
		if (event.key === 'Escape') {
			if (popoverId) {
				event.preventDefault();
				setPopoverId(null);
			} else if (adding !== null) {
				// Escape — отмена: в отличие от ухода фокуса, набранный текст не сохраняется.
				event.preventDefault();
				setAdding(null);
				setAddText('');
			} else if (target === searchRef.current && search) {
				event.preventDefault();
				setSearch('');
			}
			return;
		}
		if (typing || event.ctrlKey || event.metaKey || event.altKey) {
			return;
		}
		// Клавиши сверяются по физическому положению: в русской раскладке N — «т», а «/» — «.».
		if (event.code === 'KeyN' || event.key === 'n' || event.key === 'N') {
			event.preventDefault();
			startAdding(groupBy === 'none' ? 'all' : groupBy === 'scope'
				? (preferences.boardScope !== 'all' ? preferences.boardScope : availableScopes[0])
				: groups[0]?.key ?? QUICK_NOTE_NO_COLOR_KEY);
		} else if (event.code === 'Slash' || event.key === '/') {
			event.preventDefault();
			searchRef.current?.focus();
		}
	};

	/** Плитка или поле новой заметки. */
	const renderAddSticky = (groupKey: string) => {
		if (adding !== groupKey) {
			return groupBy === 'none' ? (
				<button key="add" type="button" className="pm-qn-sticky pm-qn-add-sticky" aria-label="Новая заметка" onClick={() => startAdding(groupKey)}>
					<QuickNoteIcon name="add" size={20} />
					<span>Новая заметка</span>
					<span className="pm-qn-muted">или клавиша N</span>
				</button>
			) : null;
		}
		const { scope } = resolveNewNoteTarget(groupKey);
		const scopeLocked = groupBy === 'scope' || preferences.boardScope !== 'all' || !workspaceAvailable;
		return (
			<div key="add" ref={addStickyRef} className="pm-qn-sticky pm-qn-add-sticky is-editing">
				<textarea
					ref={addRef}
					rows={3}
					value={addText}
					placeholder={'Новая заметка…\nВторая и следующие строки — описание'}
					aria-label="Новая заметка"
					onChange={event => setAddText(event.target.value)}
					onKeyDown={event => {
						if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							submitAdd();
						}
					}}
				/>
				<div className="pm-qn-add-row">
					<button type="button" className="pm-qn-scope-toggle" disabled={scopeLocked} title="Где сохранить заметку"
						aria-label={`Область новой заметки: ${resolveQuickNoteScopeLabel(scope)}`}
						onClick={() => props.onPreferencesChange({ newNoteScope: scope === 'global' ? 'workspace' : 'global' })}>
						<QuickNoteIcon name={scope === 'global' ? 'globe' : 'folder'} size={13} />{resolveQuickNoteScopeLabel(scope)}
					</button>
					<span className="pm-qn-muted">Enter — добавить · Shift+Enter — новая строка · Esc — отмена</span>
				</div>
			</div>
		);
	};

	/** Стикер заметки. */
	const renderSticky = (note: QuickNoteView) => {
		const progress = getQuickNoteChecklistProgress(note);
		const color = resolveQuickNoteColorCss(note.color);
		const images = note.files.filter(file => getContextFileKind(file.name) === 'image' && note.previewUris?.[file.id]).slice(0, 3);
		const dropSide = groupBy === 'none'
			? { before: ' is-drop-left', after: ' is-drop-right' }
			: { before: ' is-drop-before', after: ' is-drop-after' };
		const dropClass = drag?.target?.kind === 'note' && drag.target.noteId === note.id ? dropSide[drag.target.placement] : '';
		return (
			<article
				key={note.id}
				className={`pm-qn-sticky${color ? '' : ' is-plain'}${note.done ? ' is-done' : ''}${props.newNoteIds.has(note.id) ? ' is-new' : ''}`
					+ `${popoverId === note.id ? ' is-pop' : ''}${drag?.id === note.id ? ' is-dragging' : ''}${dropClass}`}
				style={color ? { ['--pm-qn-note' as string]: color } : undefined}
				tabIndex={0}
				data-qn-sticky={note.id}
				aria-label={note.title}
				aria-keyshortcuts="Enter Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
				onPointerDown={event => handleStickyPointerDown(event, note)}
				onClick={() => {
					if (suppressClickRef.current) {
						suppressClickRef.current = false;
						return;
					}
					if (popoverId) {
						setPopoverId(null);
						return;
					}
					props.onOpen(note, navigationIds);
				}}
				onKeyDown={event => {
					if (event.target !== event.currentTarget) {
						return;
					}
					if (event.key === 'Enter') {
						event.preventDefault();
						props.onOpen(note, navigationIds);
					} else if (event.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
						event.preventDefault();
						moveWithKeyboard(note, event.key);
					}
				}}
			>
				<header className="pm-qn-st-h">
					<button type="button" className="pm-qn-check" role="checkbox" aria-checked={note.done} aria-label={`Выполнена: ${note.title}`}
						onClick={event => { event.stopPropagation(); props.onToggleDone(note); }}>
						{note.done ? <QuickNoteIcon name="check" size={12} /> : null}
					</button>
					<h3 className="pm-qn-st-title">{note.title}</h3>
					<span className="pm-qn-st-actions">
						<button type="button" className="pm-qn-icon-btn" title="Цвет" aria-label={`Цвет заметки: ${note.title}`}
							aria-expanded={popoverId === note.id}
							onClick={event => { event.stopPropagation(); setPopoverId(popoverId === note.id ? null : note.id); }}>
							<QuickNoteIcon name="symbol-color" size={14} />
						</button>
						<button type="button" className="pm-qn-icon-btn" title="Открыть заметку" aria-label={`Открыть заметку: ${note.title}`}
							onClick={event => { event.stopPropagation(); props.onOpen(note, navigationIds); }}>
							<QuickNoteIcon name="link-external" size={14} />
						</button>
					</span>
				</header>
				{note.description.trim() ? <p className="pm-qn-st-desc">{note.description}</p> : null}
				{progress.total > 0 ? (
					<div className="pm-qn-st-items">
						{note.items.slice(0, 4).map(item => (
							<div key={item.id} className={`pm-qn-st-item${item.done ? ' is-done' : ''}`}>
								<button type="button" className="pm-qn-check is-small" role="checkbox" aria-checked={item.done} aria-label={item.text}
									onClick={event => { event.stopPropagation(); props.onToggleItem(note, item.id); }}>
									{item.done ? <QuickNoteIcon name="check" size={10} /> : null}
								</button>
								<span title={item.text}>{item.text}</span>
							</div>
						))}
						{progress.total > 4 ? <div className="pm-qn-st-more">ещё {progress.total - 4}</div> : null}
					</div>
				) : null}
				{images.length > 0 ? (
					<div className="pm-qn-st-imgs">
						{images.map(file => <img draggable={false} key={file.id} src={note.previewUris?.[file.id]} alt="" title={file.name} loading="lazy" decoding="async" />)}
					</div>
				) : null}
				<footer className="pm-qn-st-f">
					<span title={resolveQuickNoteScopeLabel(note.scope)}><QuickNoteIcon name={note.scope === 'global' ? 'globe' : 'folder'} size={13} /></span>
					{progress.total > 0 ? <span className="pm-qn-meta-item" title="Чек-лист"><QuickNoteIcon name="checklist" size={13} />{progress.done}/{progress.total}</span> : null}
					{note.files.length > 0 ? <span className="pm-qn-meta-item" title="Файлы"><QuickNoteIcon name="attach" size={13} />{note.files.length}</span> : null}
					{note.prompt ? <span className="pm-qn-meta-item is-link" title="Связан с промптом"><QuickNoteIcon name="sparkle" size={13} /></span> : null}
					<span className="pm-qn-grow" />
					<span title={`Изменена ${note.updatedAt}`}>{formatQuickNoteShortDate(note.updatedAt)}</span>
				</footer>
				{popoverId === note.id ? (
					<div className="pm-qn-popover" role="group" aria-label="Цвет заметки" onClick={event => event.stopPropagation()}>
						<button type="button" className="pm-qn-swatch is-none" aria-pressed={!note.color} title="Без цвета" aria-label="Без цвета"
							onClick={() => { setPopoverId(null); props.onSetColor(note, ''); }} />
						{QUICK_NOTE_PALETTE_COLORS.map(paletteColor => (
							<button key={paletteColor} type="button" className="pm-qn-swatch" aria-pressed={note.color === paletteColor}
								title={QUICK_NOTE_COLOR_LABELS[paletteColor]} aria-label={QUICK_NOTE_COLOR_LABELS[paletteColor]}
								style={{ background: resolveQuickNoteColorCss(paletteColor) }}
								onClick={() => { setPopoverId(null); props.onSetColor(note, paletteColor); }} />
						))}
					</div>
				) : null}
			</article>
		);
	};

	/** Колонка группировки по цвету или области. */
	const renderGroup = (group: QuickNotesBoardGroup) => {
		const label = resolveGroupLabel(groupBy, group.key);
		const over = drag?.target?.kind === 'group' && drag.target.groupKey === group.key;
		return (
			<section key={group.key} className="pm-qn-bcol" aria-label={label}>
				<header className="pm-qn-bcol-h">
					{groupBy === 'scope'
						? <QuickNoteIcon name={group.key === 'global' ? 'globe' : 'folder'} size={14} />
						: <span className={`pm-qn-bcol-dot${group.key === QUICK_NOTE_NO_COLOR_KEY ? ' is-none' : ''}`}
							style={group.key === QUICK_NOTE_NO_COLOR_KEY ? undefined : { background: resolveQuickNoteColorCss(group.key) }} />}
					<span>{label}</span>
					<span className="pm-qn-muted">{group.notes.length}</span>
					<span className="pm-qn-grow" />
					<button type="button" className="pm-qn-icon-btn" title="Новая заметка в колонке" aria-label={`Новая заметка: ${label}`}
						onClick={() => startAdding(group.key)}>
						<QuickNoteIcon name="add" size={14} />
					</button>
				</header>
				<div className={`pm-qn-bcol-list${over ? ' is-over' : ''}`} data-qn-group={group.key}>
					{renderAddSticky(group.key)}
					{group.notes.map(renderSticky)}
					{group.notes.length === 0 && adding !== group.key ? <div className="pm-qn-bcol-empty">Перетащите заметку сюда</div> : null}
				</div>
			</section>
		);
	};

	// Строгий row-major порядок: визуальный порядок совпадает с порядком операций переноса.
	const gridItems = [renderAddSticky('all'), ...boardNotes.map(renderSticky)];

	return (
		<main
			ref={rootRef}
			className={`pm-qn-board pm-qn-scope${drag ? ' is-reordering' : ''}`}
			aria-label="Доска быстрых заметок"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
			aria-hidden={props.covered ? true : undefined}
		>
			<div className="pm-qn-board-h">
				<div className="pm-qn-board-title">
					<QuickNoteIcon name="project" size={16} />Быстрые заметки
					<span className="pm-qn-board-count">{openCount} открытых · {doneCount} выполнено</span>
				</div>
				<label className="pm-qn-search">
					<QuickNoteIcon name="search" size={13} />
					<input ref={searchRef} value={search} placeholder="Поиск  /" aria-label="Поиск заметок" onChange={event => setSearch(event.target.value)} />
				</label>
				{colorKeys.length > 0 ? (
					<div className={`pm-qn-dots${colors.length === 0 ? ' is-all' : ''}`} role="group" aria-label="Фильтр по цвету">
						{colorKeys.map(key => (
							<button key={key} type="button" className={`pm-qn-dot${key === QUICK_NOTE_NO_COLOR_KEY ? ' is-none' : ''}`}
								aria-pressed={colors.includes(key)} title={resolveQuickNoteColorLabel(key)} aria-label={`Фильтр: ${resolveQuickNoteColorLabel(key)}`}
								style={key === QUICK_NOTE_NO_COLOR_KEY ? undefined : { background: resolveQuickNoteColorCss(key) }}
								onClick={() => setColors(colors.includes(key) ? colors.filter(value => value !== key) : [...colors, key])} />
						))}
					</div>
				) : null}
				<div className="pm-qn-seg" role="group" aria-label="Область">
					<button type="button" aria-pressed={preferences.boardScope === 'all'} onClick={() => props.onPreferencesChange({ boardScope: 'all' })}>Все</button>
					<button type="button" aria-pressed={preferences.boardScope === 'workspace'} disabled={!workspaceAvailable}
						onClick={() => props.onPreferencesChange({ boardScope: 'workspace' })}>
						<QuickNoteIcon name="folder" size={13} />Проект
					</button>
					<button type="button" aria-pressed={preferences.boardScope === 'global'} onClick={() => props.onPreferencesChange({ boardScope: 'global' })}>
						<QuickNoteIcon name="globe" size={13} />Глобальные
					</button>
				</div>
				<div className="pm-qn-seg" role="group" aria-label="Группировка">
					<button type="button" aria-pressed={groupBy === 'none'} title="Без группировки" onClick={() => { setAdding(null); props.onPreferencesChange({ boardGroupBy: 'none' }); }}>
						<QuickNoteIcon name="layout" size={13} />Сетка
					</button>
					<button type="button" aria-pressed={groupBy === 'color'} title="Колонки по цвету" onClick={() => { setAdding(null); props.onPreferencesChange({ boardGroupBy: 'color' }); }}>
						<QuickNoteIcon name="symbol-color" size={13} />По цвету
					</button>
					<button type="button" aria-pressed={groupBy === 'scope'} title="Колонки по области" onClick={() => { setAdding(null); props.onPreferencesChange({ boardGroupBy: 'scope' }); }}>
						<QuickNoteIcon name="folder" size={13} />По области
					</button>
				</div>
				<button type="button" className="pm-qn-chip" aria-pressed={preferences.boardShowDone}
					onClick={() => props.onPreferencesChange({ boardShowDone: !preferences.boardShowDone })}>
					<QuickNoteIcon name={preferences.boardShowDone ? 'eye' : 'eye-closed'} size={13} />Выполненные {doneCount}
				</button>
				<span className="pm-qn-grow" />
				<span className="pm-qn-board-keys">N — новая · / — поиск · Alt+стрелки — перенос</span>
			</div>
			{props.error ? (
				<div className="pm-qn-error" role="alert">
					<QuickNoteIcon name="info" size={14} />
					<span className="pm-qn-grow">{props.error}</span>
					{props.onDismissError ? (
						<button type="button" className="pm-qn-icon-btn" aria-label="Скрыть сообщение" title="Скрыть сообщение" onClick={props.onDismissError}>
							<QuickNoteIcon name="close" size={12} />
						</button>
					) : null}
				</div>
			) : null}
			{(['workspace', 'global'] as const).filter(scope => state.scopes[scope].error).map(scope => (
				<div key={scope} className="pm-qn-error" role="alert">
					<QuickNoteIcon name="info" size={14} />
					<span className="pm-qn-grow">{state.scopes[scope].error}</span>
					{props.onOpenStorageFile ? (
						<button type="button" className="pm-qn-btn is-secondary is-small" onClick={() => props.onOpenStorageFile?.(scope)}>Открыть файл</button>
					) : null}
					{props.onReload ? <button type="button" className="pm-qn-btn is-ghost is-small" onClick={props.onReload}>Перечитать</button> : null}
				</div>
			))}
			<div ref={bodyRef} className="pm-qn-board-b">
				{groupBy === 'none' ? (
					<div className="pm-qn-masonry" style={{ gridTemplateColumns: 'repeat(' + columnCount + ', minmax(0, 1fr))' }}>
						{gridItems}
					</div>
				) : (
					<div className="pm-qn-board-cols">{groups.map(renderGroup)}</div>
				)}
				{boardNotes.length === 0 && hasFilter ? (
					<div className="pm-qn-board-empty">
						Ничего не найдено.{' '}
						<button type="button" className="pm-qn-link-btn" style={{ marginLeft: 0 }}
							onClick={() => { setSearch(''); setColors([]); props.onPreferencesChange({ boardScope: 'all' }); }}>Сбросить фильтры</button>
					</div>
				) : null}
				{state.notes.length === 0 ? (
					<div className="pm-qn-board-empty">Здесь будут стикеры заметок. Нажмите N или «Новая заметка», чтобы добавить первую.</div>
				) : null}
			</div>
			{drag ? <div className="pm-qn-drag-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }} aria-hidden="true">
				{state.notes.find(note => note.id === drag.id && note.scope === drag.scope)?.title || ''}
			</div> : null}
		</main>
	);
}

/** Вспомогательная проверка ключа цвета заметки для тестов доски. */
export function isQuickNoteInBoardGroup(note: QuickNoteView, groupBy: QuickNotesBoardGroupBy, groupKey: string): boolean {
	return groupBy === 'color' ? getQuickNoteColorKey(note) === groupKey : groupBy === 'scope' ? note.scope === groupKey : true;
}
