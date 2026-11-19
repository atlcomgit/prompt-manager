/**
 * Упрощённый виджет быстрых заметок: добавление, фильтры, компактный список и блок выполненных.
 * Полное управление заметкой — в окне QuickNoteModal; тесты разметки — tests/quickNotesComponents.test.tsx.
 */
import React, { useRef, useState } from 'react';
import type { DashboardQuickNotesWidgetState } from '../../../../types/promptDashboardPreferences.js';
import type { QuickNoteScope, QuickNotesState, QuickNoteView } from '../../../../types/quickNotes.js';
import {
	collectQuickNoteColorKeys,
	getQuickNoteChecklistProgress,
	matchesQuickNoteFilter,
	prepareQuickNoteCreationInput,
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

	/** Добавляет заметку по Enter, Ctrl+Enter дополнительно открывает окно заметки. */
	const handleAddKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
			return;
		}
		event.preventDefault();
		const value = title.trim();
		if (!value || !state) {
			return;
		}
		const saved = props.onAdd(value, newNoteScope, event.ctrlKey || event.metaKey);
		if (saved === false) {
			return;
		}
		// Новая заметка встаёт первой и подсвечивается: сохранённый фильтр, который её скрыл бы, сбрасывается.
		const prepared = prepareQuickNoteCreationInput(value);
		if (hasFilter && !matchesQuickNoteFilter({ title: prepared.title, description: prepared.description, items: [], color: '', scope: newNoteScope }, filter)) {
			props.onPreferencesChange({ search: '', colors: [] });
		}
		setTitle('');
		// Несохранённый текст не теряется: возвращается, если пользователь ещё не начал новую заметку.
		void saved.then(ok => {
			if (!ok && !titleRef.current) {
				setTitle(value);
			}
		});
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
		return (
			<div key={note.id} data-pm-editor-section={note.id}>
				<div
					className={`pm-qn-row${note.done ? ' is-done' : ''}${props.newNoteIds.has(note.id) ? ' is-new' : ''}`}
					style={color ? { ['--pm-qn-note' as string]: color } : undefined}
					data-pm-quick-note={note.id}
					onDoubleClick={event => {
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
					<span className="pm-qn-title" title={note.title}>{note.title}</span>
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

	return (
		<div className="pm-qn pm-qn-scope" data-pm-quick-notes="widget">
			<div className="pm-qn-add">
				<span className="pm-qn-add-lead"><QuickNoteIcon name="add" size={14} /></span>
				<textarea
					rows={1}
					ref={props.addInputRef}
					value={title}
					placeholder="Новая заметка…"
					aria-label="Новая заметка"
					spellCheck={false}
					onChange={event => setTitle(event.target.value)}
					onKeyDown={handleAddKeyDown}
				/>
				<button
					type="button"
					className="pm-qn-scope-toggle"
					disabled={!workspaceAvailable}
					title={workspaceAvailable ? 'Где сохранить новую заметку' : 'Откройте папку, чтобы хранить заметки проекта'}
					aria-label={`Область новой заметки: ${resolveQuickNoteScopeLabel(newNoteScope)}`}
					onClick={() => props.onPreferencesChange({ newNoteScope: newNoteScope === 'global' ? 'workspace' : 'global' })}
				>
					<QuickNoteIcon name={newNoteScope === 'global' ? 'globe' : 'folder'} size={13} />
					{resolveQuickNoteScopeLabel(newNoteScope)}
				</button>
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
					<div className="pm-qn-filters">
						<label className="pm-qn-search">
							<QuickNoteIcon name="search" size={13} />
							<input
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
					</div>
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
		</div>
	);
}
