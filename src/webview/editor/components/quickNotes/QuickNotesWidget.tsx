/**
 * Упрощённый виджет быстрых заметок: добавление, фильтры, компактный список и блок выполненных.
 * Полное управление заметкой — в окне QuickNoteModal; тесты разметки — tests/quickNotesComponents.test.tsx.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DashboardQuickNotesWidgetState } from '../../../../types/promptDashboardPreferences.js';
import { QUICK_NOTE_PALETTE_COLORS, type QuickNoteScope, type QuickNotesState, type QuickNoteView } from '../../../../types/quickNotes.js';
import {
	collectQuickNoteColorKeys,
	getQuickNoteChecklistProgress,
	matchesQuickNoteFilter,
	prepareQuickNoteCreationInput,
	formatQuickNoteClipboardText,
	QUICK_NOTE_NO_COLOR_KEY,
	splitQuickNotes,
} from '../../../../utils/quickNotes.js';
import { EditorSectionDragHandle, SortableEditorSections } from '../SortableEditorSections';
import { QuickNoteIcon } from './QuickNoteIcon';
import { resolveQuickNoteColorCss, resolveQuickNoteColorLabel } from './quickNotesStyles';

/** Ключ раскрытия строки заметки в общей карте раскрытий панели. */
export function buildQuickNoteExpandedKey(note: Pick<QuickNoteView, 'scope' | 'id'>): string {
	return `quick-note:${note.scope}:${note.id}`;
}

/** Ключ раскрытия блока выполненных заметок. */
export const QUICK_NOTES_DONE_EXPANDED_KEY = 'quick-notes:done';

/** Подпись области для подсказок. */
export function resolveQuickNoteScopeLabel(scope: QuickNoteScope): string {
	return scope === 'global' ? 'Глобальная' : 'Проект';
}

/** Свойства виджета: данные, вид и действия контейнера. */
export interface QuickNotesWidgetProps {
	state: QuickNotesState | null;
	preferences: DashboardQuickNotesWidgetState;
	expanded: Record<string, boolean>;
	/** Заметки, только что созданные в этой панели: коротко подсвечиваются. */
	newNoteIds: ReadonlySet<string>;
	/** Причина последнего отказа операции; показывается до закрытия. */
	error?: string | null;
	addInputRef?: React.Ref<HTMLTextAreaElement>;
	/** Header magnifier controls whether the filter field is visible. */
	searchOpen?: boolean;
	/**
	 * Текст поля «Новая заметка…», если он хранится у контейнера: так он переживает перестройку панели
	 * (смену числа колонок или порядка виджетов). Без этих свойств текст хранится в самом виджете.
	 */
	addText?: string;
	onAddTextChange?(text: string): void;
	/**
	 * Создаёт заметку. false — заметка не создана (данные ещё не загружены), текст остаётся в поле;
	 * обещание сообщает итог записи: при неудаче текст возвращается в пустое поле.
	 */
	onAdd(title: string, scope: QuickNoteScope, openAfter: boolean): false | Promise<boolean>;
	onDismissError?(): void;
	onPreferencesChange(patch: Partial<DashboardQuickNotesWidgetState>): void;
	onToggleExpanded(key: string): void;
	onToggleDone(note: QuickNoteView): void;
	onToggleItem(note: QuickNoteView, itemId: string): void;
	onOpen(note: QuickNoteView, navigationIds: string[]): void;
	onOpenPrompt(note: QuickNoteView): void;
	onReorder(movingId: string, anchorId: string, placement: 'before' | 'after'): void;
	onClearDone(): void;
	onOpenStorageFile(scope: QuickNoteScope): void;
	onReload(): void;
	onPin(note: QuickNoteView): void;
	onDelete(note: QuickNoteView): void;
	onDuplicate(note: QuickNoteView): void;
	onSetColor(note: QuickNoteView, color: string): void;
	/** Open the shared voice recorder with insertion targeted at the new-note field. */
	onStartVoice?(): void;
	voiceBusy?: boolean;
	/** Keep the editor expanded while the note's own dictation is active. */
	voiceInProgress?: boolean;
}

/** Находит перенесённый элемент и соседа, рядом с которым он оказался после жеста. */
export function resolveQuickNoteListMove(
	previousOrder: readonly string[],
	nextOrder: readonly string[],
): { movingId: string; anchorId: string; placement: 'before' | 'after' } | null {
	for (const candidate of previousOrder) {
		const withoutPrevious = previousOrder.filter(id => id !== candidate);
		const withoutNext = nextOrder.filter(id => id !== candidate);
		if (withoutPrevious.length !== withoutNext.length || withoutPrevious.some((id, index) => id !== withoutNext[index])) {
			continue;
		}
		const index = nextOrder.indexOf(candidate);
		if (index === previousOrder.indexOf(candidate)) {
			continue;
		}
		const after = nextOrder[index + 1];
		return after
			? { movingId: candidate, anchorId: after, placement: 'before' }
			: { movingId: candidate, anchorId: nextOrder[index - 1], placement: 'after' };
	}
	return null;
}

/** Виджет «Быстрые заметки» в панели «Обзор». */
export function QuickNotesWidget(props: QuickNotesWidgetProps): React.ReactElement {
	const { state, preferences } = props;
	const [localTitle, setLocalTitle] = useState('');
	const [addOpen, setAddOpen] = useState(Boolean(props.voiceInProgress));
	const addExpanded = addOpen || props.voiceInProgress;
	const [addHeight, setAddHeight] = useState(90);
	// Ключи включают область. Действия читают актуальные заметки, пока меню открыто.
	const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
	const [contextMenu, setContextMenu] = useState<{
		keys: ReadonlySet<string>; primaryKey: string; x: number; y: number; confirmDelete?: boolean; error?: string;
	} | null>(null);
	const [copiedKeys, setCopiedKeys] = useState<ReadonlySet<string>>(new Set());
	const copiedTextRef = useRef('');
	const searchRef = useRef<HTMLInputElement>(null);
	const addEditorRef = useRef<HTMLDivElement>(null);
	// Позднее подтверждение не закрывает поле после отправки следующего черновика.
	const saveVersionRef = useRef(0);
	const contextMenuRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (props.searchOpen) searchRef.current?.focus();
	}, [props.searchOpen]);
	useEffect(() => {
		if (!contextMenu) return;
		const closeOutside = (event: PointerEvent) => {
			if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null);
		};
		const closeEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setContextMenu(null);
		};
		window.addEventListener('pointerdown', closeOutside);
		window.addEventListener('keydown', closeEscape);
		return () => {
			window.removeEventListener('pointerdown', closeOutside);
			window.removeEventListener('keydown', closeEscape);
		};
	}, [contextMenu]);
	useEffect(() => {
		const verifyClipboard = () => {
			const expected = copiedTextRef.current;
			if (!expected || !navigator.clipboard?.readText) return;
			void navigator.clipboard.readText().then(text => {
				if (copiedTextRef.current === expected && text !== expected) {
					copiedTextRef.current = '';
					setCopiedKeys(new Set());
				}
			}).catch(() => undefined);
		};
		window.addEventListener('focus', verifyClipboard);
		window.addEventListener('copy', verifyClipboard);
		return () => {
			window.removeEventListener('focus', verifyClipboard);
			window.removeEventListener('copy', verifyClipboard);
		};
	}, []);
	const title = props.addText ?? localTitle;
	const titleRef = useRef(title);
	titleRef.current = title;
	const onAddTextChange = props.onAddTextChange;
	/** Меняет текст поля добавления там, где он хранится. */
	const setTitle = (next: string) => {
		titleRef.current = next;
		if (onAddTextChange) {
			onAddTextChange(next);
		} else {
			setLocalTitle(next);
		}
	};
	/** Снимает фокус внутри редактора. Активная диктовка продолжает удерживать поле раскрытым. */
	const collapseNewNoteEditor = () => {
		const editor = addEditorRef.current;
		const focused = editor?.ownerDocument.activeElement;
		if (focused instanceof HTMLElement && editor?.contains(focused)) focused.blur();
		setAddOpen(false);
	};
	/** Сбрасывает черновик и отменяет действие прежнего подтверждения сохранения. */
	const resetNewNote = () => {
		saveVersionRef.current++;
		setTitle('');
		setAddHeight(90);
	};
	/** Очищает текст, возвращая фокус при нажатии мышью или клавиатурой. */
	const clearNewNote = () => {
		resetNewNote();
		addEditorRef.current?.querySelector('textarea')?.focus({ preventScroll: true });
	};
	/** Отмена закрывает ввод, если поле не удерживает активная диктовка. */
	const cancelNewNote = () => {
		resetNewNote();
		collapseNewNoteEditor();
	};
	const [confirmClear, setConfirmClear] = useState(false);
	const workspaceAvailable = state?.scopes.workspace.available !== false;
	// Без открытой папки новая заметка сохраняется глобально независимо от выбора.
	const newNoteScope: QuickNoteScope = workspaceAvailable ? preferences.newNoteScope : 'global';
	const notes = state?.notes ?? [];
	const { open, done } = splitQuickNotes(notes);
	const filter = { search: preferences.search, colors: preferences.colors };
	const shownOpen = open.filter(note => matchesQuickNoteFilter(note, filter));
	const shownDone = done.filter(note => matchesQuickNoteFilter(note, filter));
	const colorKeys = collectQuickNoteColorKeys(notes);
	const hasFilter = preferences.search.trim().length > 0 || preferences.colors.length > 0;
	const doneExpanded = props.expanded[QUICK_NOTES_DONE_EXPANDED_KEY] === true;
	const errors = state ? (['workspace', 'global'] as const).filter(scope => state.scopes[scope].error) : [];
	const navigationIds = shownOpen.map(note => note.id);
	const visibleNotes = doneExpanded ? [...shownOpen, ...shownDone] : shownOpen;
	const menuNotes = contextMenu ? visibleNotes.filter(note => contextMenu.keys.has(buildQuickNoteExpandedKey(note))) : [];
	const primaryNote = menuNotes.find(note => buildQuickNoteExpandedKey(note) === contextMenu?.primaryKey) ?? menuNotes[0];
	const allPinned = menuNotes.every(note => note.pinned);
	const allDone = menuNotes.every(note => note.done);
	const bulkMenu = menuNotes.length > 1;
	// Show the selection size on each bulk action, including color changes and deletion.
	const bulkCount = bulkMenu ? ` (${menuNotes.length})` : '';

	/** Сворачивает поле после записи. При отказе возвращает текст, если поле ещё пустое. */
	const saveNewNote = (openAfter = false) => {
		const value = titleRef.current.trim();
		if (!value || !state) return;
		const saved = props.onAdd(value, newNoteScope, openAfter);
		if (saved === false) return;
		const version = ++saveVersionRef.current;
		const prepared = prepareQuickNoteCreationInput(value);
		if (hasFilter && !matchesQuickNoteFilter({
			title: prepared.title, description: prepared.description,
			items: [], color: '', scope: newNoteScope,
		}, filter)) props.onPreferencesChange({ search: '', colors: [] });
		setTitle('');
		void saved.then(ok => {
			if (version !== saveVersionRef.current || titleRef.current) return;
			if (!ok) {
				setTitle(value);
				return;
			}
			collapseNewNoteEditor();
		});
	};
	/** Enter saves; Shift+Enter adds a line; Ctrl+Enter saves and opens the modal. */
	const handleAddKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		saveNewNote(event.ctrlKey || event.metaKey);
	};
	/** Adjust only the floating editor, never the height reserved in the widget layout. */
	const measureExpandedInput = (element: HTMLTextAreaElement) => {
		requestAnimationFrame(() => {
			if (element.isConnected) setAddHeight(Math.min(280, Math.max(90, element.scrollHeight)));
		});
	};
	/** Переключает видимую строку в выделении и отбрасывает скрытые ключи после смены фильтра. */
	const toggleSelection = (key: string) => {
		setSelectedKeys(previous => {
			const next = new Set(visibleNotes.map(buildQuickNoteExpandedKey).filter(value => previous.has(value)));
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	/** Записывает выбранные заметки одним текстом и подсвечивает их после подтверждения. */
	const copyNotes = async (targets: QuickNoteView[]) => {
		try {
			const value = targets.map(formatQuickNoteClipboardText).filter(Boolean).join('\n\n---\n\n');
			await navigator.clipboard.writeText(value);
			copiedTextRef.current = value;
			setCopiedKeys(new Set(targets.map(buildQuickNoteExpandedKey)));
			setContextMenu(current => current === contextMenu ? null : current);
		} catch {
			setContextMenu(current => current && current === contextMenu
				? { ...current, error: 'Браузер не разрешил копирование. Проверьте доступ к буферу обмена.' }
				: current);
		}
	};
	/** Close the menu after a note operation; the host handles any save failure. */
	const useContextAction = (action: () => void) => {
		action();
		setContextMenu(null);
	};

	/** Переключает цвет фильтра; при выборе всех цветов фильтр не меняет список. */
	const toggleColor = (key: string) => {
		const colors = preferences.colors.includes(key)
			? preferences.colors.filter(value => value !== key)
			: [...preferences.colors, key];
		props.onPreferencesChange({ colors });
	};

	/** Строка заметки: отметка, название, значки и открытие окна. */
	const renderRow = (note: QuickNoteView, sortable: boolean) => {
		const progress = getQuickNoteChecklistProgress(note);
		const expandedKey = buildQuickNoteExpandedKey(note);
		const isExpanded = !note.done && progress.total > 0 && props.expanded[expandedKey] === true;
		const color = resolveQuickNoteColorCss(note.color);
		const selected = selectedKeys.has(expandedKey);
		return (
			<div key={note.id} data-pm-editor-section={note.id}>
				<div
					className={'pm-qn-row' + (note.done ? ' is-done' : '') + (note.pinned ? ' is-pinned' : '') + (selected ? ' is-selected' : '') + (copiedKeys.has(expandedKey) ? ' is-copied' : '') + (props.newNoteIds.has(note.id) ? ' is-new' : '')}
					style={color ? { ['--pm-qn-note' as string]: color } : undefined}
					data-pm-quick-note={note.id}
					data-selected={selected ? 'true' : undefined}
					role="group"
					tabIndex={0}
					aria-label={selected ? `${note.title}, выделена` : note.title}
					onClickCapture={event => {
						// Ctrl+ЛКМ выделяет строку и не выполняет действие её кнопки.
						if (event.ctrlKey || event.metaKey) {
							event.preventDefault();
							event.stopPropagation();
							event.currentTarget.focus({ preventScroll: true });
							toggleSelection(expandedKey);
						} else if (selectedKeys.size > 0) {
							setSelectedKeys(new Set());
						}
					}}
					onKeyDown={event => {
						if (event.target !== event.currentTarget || contextMenu) return;
						if (event.key === ' ' && (event.ctrlKey || event.metaKey)) {
							event.preventDefault();
							event.stopPropagation();
							toggleSelection(expandedKey);
						} else if (event.key === 'Escape') {
							setSelectedKeys(new Set());
						}
					}}
					onContextMenu={event => {
						event.preventDefault();
						if (!selected) setSelectedKeys(new Set());
						setContextMenu({
							keys: selected ? selectedKeys : new Set([expandedKey]), primaryKey: expandedKey,
							x: event.clientX, y: event.clientY,
						});
					}}
					onDoubleClick={event => {
						if (event.ctrlKey || event.metaKey) return;
						// Двойной щелчок по отметке или значку не открывает окно поверх их действия.
						if (!(event.target instanceof Element) || !event.target.closest('button, input, a')) {
							props.onOpen(note, navigationIds);
						}
					}}
				>
					{sortable ? <span className="pm-qn-grip"><EditorSectionDragHandle sectionKey={note.id} title={note.title} itemLabel="заметку" /></span> : null}
					<button
						type="button"
						className="pm-qn-check"
						role="checkbox"
						aria-checked={note.done}
						aria-label={`Выполнена: ${note.title}`}
						title={note.done ? 'Вернуть в работу' : 'Отметить выполненной'}
						onClick={() => props.onToggleDone(note)}
					>
						{note.done ? <QuickNoteIcon name="check" size={12} /> : null}
					</button>
					<span className="pm-qn-title" title={note.title}>{note.pinned ? "📌 " : ""}{note.title}</span>
					<span className="pm-qn-meta">
						<span className="pm-qn-meta-item" title={resolveQuickNoteScopeLabel(note.scope)}>
							<QuickNoteIcon name={note.scope === 'global' ? 'globe' : 'folder'} size={13} />
						</span>
						{progress.total > 0 ? (note.done ? (
							<span className="pm-qn-meta-item" title="Чек-лист"><QuickNoteIcon name="checklist" size={13} />{progress.done}/{progress.total}</span>
						) : (
							<button
								type="button"
								className="pm-qn-meta-toggle"
								aria-expanded={isExpanded}
								aria-label={`Чек-лист: ${progress.done} из ${progress.total}`}
								title={isExpanded ? 'Скрыть чек-лист' : 'Показать чек-лист'}
								onClick={() => props.onToggleExpanded(expandedKey)}
							>
								<QuickNoteIcon name="checklist" size={13} />{progress.done}/{progress.total}
							</button>
						)) : null}
						{note.description.trim() ? <span className="pm-qn-meta-item" title="Есть описание"><QuickNoteIcon name="note" size={13} /></span> : null}
						{note.files.length > 0 ? (
							<span className="pm-qn-meta-item" title="Файлы"><QuickNoteIcon name="attach" size={13} />{note.files.length}</span>
						) : null}
						{note.prompt ? (
							<button
								type="button"
								className="pm-qn-meta-toggle pm-qn-meta-item is-link"
								title="Открыть связанный промпт"
								aria-label="Открыть связанный промпт"
								onClick={() => props.onOpenPrompt(note)}
							>
								<QuickNoteIcon name="sparkle" size={13} />
							</button>
						) : null}
					</span>
					<button
						type="button"
						className="pm-qn-icon-btn pm-qn-open"
						title="Открыть заметку"
						aria-label={`Открыть заметку: ${note.title}`}
						onClick={() => props.onOpen(note, navigationIds)}
					>
						<QuickNoteIcon name="link-external" size={14} />
					</button>
				</div>
				{isExpanded ? (
					<div className="pm-qn-sub">
						{note.items.map(item => (
							<div key={item.id} className={`pm-qn-sub-row${item.done ? ' is-done' : ''}`}>
								<button
									type="button"
									className="pm-qn-check is-small"
									role="checkbox"
									aria-checked={item.done}
									aria-label={item.text}
									onClick={() => props.onToggleItem(note, item.id)}
								>
									{item.done ? <QuickNoteIcon name="check" size={10} /> : null}
								</button>
								<span>{item.text}</span>
							</div>
						))}
					</div>
				) : null}
			</div>
		);
	};

	// Opening the recorder keeps the input mounted from either placement of the microphone.
	const microphone = props.onStartVoice ? (
		<button type="button" className="pm-qn-icon-btn" aria-label="Голосовая заметка"
			title="Записать и преобразовать речь в текст" disabled={props.voiceBusy}
			onPointerDown={event => {
				if (event.button === 0) event.preventDefault();
			}}
			onClick={() => {
				addEditorRef.current?.querySelector('textarea')?.focus();
				setAddOpen(true);
				props.onStartVoice?.();
			}}>
			<QuickNoteIcon name="mic" size={14}/>
		</button>
	) : null;

	return (
		<div className="pm-qn pm-qn-scope" data-pm-quick-notes="widget">
			<div className="pm-qn-add-slot">
				<div ref={addEditorRef} className={'pm-qn-add' + (addExpanded ? ' is-expanded' : '')}
					onBlur={event => {
						if (!props.voiceInProgress && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
							setAddOpen(false);
						}
					}}>
					{!addExpanded ? <span className="pm-qn-add-lead"><QuickNoteIcon name="add" size={14}/></span> : null}
					<textarea
						rows={1}
						ref={props.addInputRef}
						value={title}
						style={{ height: addExpanded ? addHeight : 28 }}
						placeholder="Новая заметка…"
						aria-label="Новая заметка"
						spellCheck={false}
						onFocus={event => {
							setAddOpen(true);
							measureExpandedInput(event.currentTarget);
						}}
						onChange={event => {
							setTitle(event.target.value);
							measureExpandedInput(event.currentTarget);
						}}
						onKeyDown={handleAddKeyDown}
					/>
					{!addExpanded ? microphone : null}
					{addExpanded ? <div className="pm-qn-add-tools">
						<button type="button" className="pm-qn-btn is-secondary is-small pm-qn-add-clear"
							disabled={!title} onClick={clearNewNote}>Очистить</button>
						<button type="button" className="pm-qn-btn is-secondary is-small"
							onClick={cancelNewNote}>Отмена</button>
						{title.trim() ? <button type="button" className="pm-qn-btn is-primary is-small"
							aria-label="Сохранить новую заметку" onClick={() => saveNewNote()}>
							<QuickNoteIcon name="check" size={13}/>Сохранить
						</button> : null}
						<button type="button" className="pm-qn-scope-toggle" disabled={!workspaceAvailable}
							title="Где сохранить заметку"
							aria-label={'Область новой заметки: ' + resolveQuickNoteScopeLabel(newNoteScope)}
							onClick={() => props.onPreferencesChange({
								newNoteScope: newNoteScope === 'global' ? 'workspace' : 'global',
							})}>
							<QuickNoteIcon name={newNoteScope === 'global' ? 'globe' : 'folder'} size={13}/>
							{resolveQuickNoteScopeLabel(newNoteScope)}
						</button>
						{microphone}
					</div> : null}
				</div>
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
			{errors.map(scope => (
				<div key={scope} className="pm-qn-error" role="alert">
					<QuickNoteIcon name="info" size={14} />
					<span className="pm-qn-grow">{state?.scopes[scope].error}</span>
					<button type="button" className="pm-qn-btn is-secondary is-small" onClick={() => props.onOpenStorageFile(scope)}>Открыть файл</button>
					<button type="button" className="pm-qn-btn is-ghost is-small" onClick={props.onReload}>Перечитать</button>
				</div>
			))}
			{!state ? (
				<div className="pm-qn-status" role="status"><QuickNoteIcon name="loading" size={14} className="pm-qn-spin" />Загружаем заметки…</div>
			) : notes.length === 0 ? (
				<div className="pm-qn-hint">
					Запишите заметку и нажмите <kbd>Enter</kbd>; <kbd>Shift</kbd>+<kbd>Enter</kbd> — новая строка. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> — добавить и открыть заметку.
					<br />
					Заметки проекта хранятся в <code>.vscode/prompt-manager</code>, глобальные — в <code>~/.vscode/prompt-manager</code>.
				</div>
			) : (
				<>
					{props.searchOpen ? <div className="pm-qn-filters">
						<label className="pm-qn-search">
							<QuickNoteIcon name="search" size={13} />
							<input
								ref={searchRef}
								value={preferences.search}
								placeholder="Поиск"
								aria-label="Поиск заметок"
								onChange={event => props.onPreferencesChange({ search: event.target.value })}
							/>
							{preferences.search ? (
								<button type="button" className="pm-qn-icon-btn" aria-label="Очистить поиск" title="Очистить поиск"
									onClick={() => props.onPreferencesChange({ search: '' })}>
									<QuickNoteIcon name="close" size={12} />
								</button>
							) : null}
						</label>
						<div className={`pm-qn-dots${preferences.colors.length === 0 ? ' is-all' : ''}`} role="group" aria-label="Фильтр по цвету">
							{colorKeys.map(key => (
								<button
									key={key}
									type="button"
									className={`pm-qn-dot${key === QUICK_NOTE_NO_COLOR_KEY ? ' is-none' : ''}`}
									aria-pressed={preferences.colors.includes(key)}
									title={resolveQuickNoteColorLabel(key)}
									aria-label={`Фильтр: ${resolveQuickNoteColorLabel(key)}`}
									style={key === QUICK_NOTE_NO_COLOR_KEY ? undefined : { background: resolveQuickNoteColorCss(key) }}
									onClick={() => toggleColor(key)}
								/>
							))}
						</div>
					</div> : null}
					{shownOpen.length > 0 ? (
						<div className="pm-qn-list">
							<SortableEditorSections
								order={shownOpen.map(note => note.id)}
								scopeKey="quick-notes"
								gap={0}
								onReorder={order => {
									const move = resolveQuickNoteListMove(shownOpen.map(note => note.id), order);
									if (move) {
										props.onReorder(move.movingId, move.anchorId, move.placement);
									}
								}}
							>
								{shownOpen.map(note => renderRow(note, true))}
							</SortableEditorSections>
						</div>
					) : open.length > 0 || hasFilter ? (
						<div className="pm-qn-empty">
							Ничего не найдено.{' '}
							<button type="button" className="pm-qn-link-btn" style={{ marginLeft: 0 }}
								onClick={() => props.onPreferencesChange({ search: '', colors: [] })}>Сбросить фильтр</button>
						</div>
					) : (
						<div className="pm-qn-empty">Все заметки выполнены.</div>
					)}
					{shownDone.length > 0 ? (
						<>
							<div className="pm-qn-done-toggle">
								<button type="button" className="pm-qn-plain-btn" aria-expanded={doneExpanded}
									onClick={() => props.onToggleExpanded(QUICK_NOTES_DONE_EXPANDED_KEY)}>
									<QuickNoteIcon name={doneExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
									Выполнено ({shownDone.length})
								</button>
								{confirmClear ? (
									<span className="pm-qn-confirm">
										Удалить выполненные ({done.length}) вместе с файлами?
										<button type="button" className="pm-qn-btn is-danger is-small"
											onClick={() => { setConfirmClear(false); props.onClearDone(); }}>Удалить</button>
										<button type="button" className="pm-qn-btn is-ghost is-small" onClick={() => setConfirmClear(false)}>Нет</button>
									</span>
								) : (
									<button type="button" className="pm-qn-link-btn" onClick={() => setConfirmClear(true)}>Очистить</button>
								)}
							</div>
							{doneExpanded ? <div className="pm-qn-list">{shownDone.map(note => renderRow(note, false))}</div> : null}
						</>
					) : null}
				</>
			)}
			{contextMenu && primaryNote && typeof document !== 'undefined' ? createPortal(
				<div className="pm-qn-context-menu" role="menu" ref={element => {
					contextMenuRef.current = element;
					if (!element) return;
					// Меню подстраивается под подписи и остаётся в окне у правого или нижнего края.
					const { width, height } = element.getBoundingClientRect();
					element.style.left = `${Math.max(8, Math.min(contextMenu.x, window.innerWidth - width - 8))}px`;
					element.style.top = `${Math.max(8, Math.min(contextMenu.y, window.innerHeight - height - 8))}px`;
				}}>
					{contextMenu.error ? <div role="alert" className="pm-qn-menu-error">{contextMenu.error}</div> : null}
					{contextMenu.confirmDelete ? <>
						<span className="pm-qn-menu-note">{bulkMenu ? `Удалить выбранные заметки (${menuNotes.length}) и их файлы?` : 'Удалить заметку и её файлы?'}</span>
						<button type="button" role="menuitem" onClick={() => useContextAction(() => {
							menuNotes.forEach(props.onDelete);
							setSelectedKeys(new Set());
						})}>{bulkMenu ? `Удалить выбранные заметки${bulkCount}` : 'Удалить'}</button>
						<button type="button" role="menuitem" onClick={() => setContextMenu(null)}>Отмена</button>
					</> : <>
						<button type="button" role="menuitem" onClick={() => useContextAction(() => {
							props.onOpen(primaryNote, bulkMenu ? menuNotes.map(note => note.id) : navigationIds);
						})}>{bulkMenu ? `Редактировать выбранные заметки${bulkCount}` : 'Редактировать'}</button>
						<button type="button" role="menuitem" onClick={() => useContextAction(() => {
							menuNotes.filter(note => Boolean(note.pinned) === allPinned).forEach(props.onPin);
						})}>
							{allPinned ? 'Открепить' : 'Закрепить'}{bulkMenu ? ` выбранные заметки${bulkCount}` : ''}
						</button>
						{bulkMenu ? <button type="button" role="menuitem" onClick={() => useContextAction(() => {
							menuNotes.filter(note => note.done === allDone).forEach(props.onToggleDone);
						})}>{allDone ? 'Вернуть выбранные в работу' : 'Отметить выбранные выполненными'}{bulkCount}</button> : null}
						<button type="button" role="menuitem" onClick={() => void copyNotes(menuNotes)}>
							{bulkMenu ? `Копировать текст выбранных заметок${bulkCount}` : 'Копировать текст заметки'}
						</button>
						<button type="button" role="menuitem" onClick={() => useContextAction(() => menuNotes.forEach(props.onDuplicate))}>
							{bulkMenu ? `Дублировать выбранные заметки${bulkCount}` : 'Дублировать заметку'}
						</button>
						<div className="pm-qn-context-colors" role="group" aria-label={bulkMenu ? `Изменить цвет выбранных заметок${bulkCount}` : 'Изменить цвет заметки'}>
							<span>{bulkMenu ? `Цвет выбранных${bulkCount}` : 'Цвет'}</span>
							{['', ...QUICK_NOTE_PALETTE_COLORS].map(color => <button key={color}
								type="button" role="menuitem" className="pm-qn-context-color"
								title={bulkMenu ? `${resolveQuickNoteColorLabel(color)} для выбранных заметок${bulkCount}` : resolveQuickNoteColorLabel(color)}
								aria-label={bulkMenu ? `Цвет выбранных заметок${bulkCount}: ${resolveQuickNoteColorLabel(color)}` : 'Цвет: ' + resolveQuickNoteColorLabel(color)}
								style={{ background: color ? resolveQuickNoteColorCss(color) : 'transparent' }}
								onClick={() => useContextAction(() => menuNotes.filter(note => note.color !== color)
									.forEach(note => props.onSetColor(note, color)))} />)}
						</div>
						<button type="button" role="menuitem" onClick={() => setContextMenu({ ...contextMenu, confirmDelete: true })}>
							{bulkMenu ? `Удалить выбранные заметки${bulkCount}` : 'Удалить'}
						</button>
					</>}
				</div>,
				document.body,
			) : null}
		</div>
	);
}
