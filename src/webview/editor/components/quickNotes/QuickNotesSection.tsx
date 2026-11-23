/**
 * Карточка виджета «Быстрые заметки» в панели «Обзор». Клиент, действия, окно заметки и текст поля добавления
 * хранит PromptDashboard: карточка пересоздаётся при смене числа колонок или порядка виджетов, а черновик не должен
 * пропадать. Доска открывается отдельной страницей (вкладкой редактора) кнопкой в заголовке.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { DashboardQuickNotesWidgetState } from '../../../../types/promptDashboardPreferences.js';
import type { QuickNoteView } from '../../../../types/quickNotes.js';
import { QuickNoteIcon } from './QuickNoteIcon';
import { buildQuickNoteExpandedKey, QuickNotesWidget } from './QuickNotesWidget';
import type { QuickNotesActions } from './useQuickNotesActions';
import type { QuickNotesClient } from './useQuickNotesClient';

/** Свойства карточки: клиент и действия панели, оболочка карточки и общие настройки вида. */
export interface QuickNotesSectionProps {
	client: QuickNotesClient;
	actions: QuickNotesActions;
	/** Текст поля «Новая заметка…», хранимый панелью. */
	addText: string;
	/** Порядковый номер вставки, после которой нужно вернуть фокус в поле заметки. */
	voiceFocusSignal?: number;
	onStartVoice?(): void;
	voiceBusy?: boolean;
	/** Recording or pending transcription for the note draft. */
	voiceInProgress?: boolean;
	onAddTextChange(text: string): void;
	collapsed: boolean;
	onToggleCollapse(): void;
	/** Собирает карточку с заголовком панели; body отсутствует у свёрнутого виджета. */
	renderShell(actions: React.ReactNode, body: React.ReactNode | null): React.ReactNode;
	preferences: DashboardQuickNotesWidgetState;
	onPreferencesChange(next: DashboardQuickNotesWidgetState): void;
	expanded: Record<string, boolean>;
	onExpandedChange(next: Record<string, boolean>): void;
}

/** Карточка «Быстрые заметки» в панели «Обзор». */
export function QuickNotesSection(props: QuickNotesSectionProps): React.ReactElement {
	const { client, actions } = props;
	const { state } = client;
	const addInputRef = useRef<HTMLTextAreaElement>(null);
	// При открытии карточки показываем уже действующие фильтры.
	const hasFilter = Boolean(props.preferences.search.trim() || props.preferences.colors.length);
	const [searchOpen, setSearchOpen] = useState(() => hasFilter);
	useEffect(() => {
		if (hasFilter) setSearchOpen(true);
	}, [hasFilter]);
	const lastVoiceFocusSignal = useRef(props.voiceFocusSignal);
	const focusAddRef = useRef(false);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const focusSearchRef = useRef(false);
	useEffect(() => {
		if (focusSearchRef.current && searchOpen && !props.collapsed) {
			focusSearchRef.current = false;
			if (document.hasFocus() && !document.querySelector('[aria-modal="true"]')) searchInputRef.current?.focus({ preventScroll: true });
		}
	}, [searchOpen, props.collapsed]);
	const previousNotesRef = useRef<QuickNoteView[] | null>(null);
	const expandedRef = useRef(props.expanded);
	expandedRef.current = props.expanded;
	const onExpandedChangeRef = useRef(props.onExpandedChange);
	onExpandedChangeRef.current = props.onExpandedChange;
	const openCount = state ? state.notes.filter(note => !note.done).length : 0;

	// Фокус в поле добавления после раскрытия свёрнутого виджета кнопкой «+».
	useEffect(() => {
		if (focusAddRef.current && !props.collapsed) {
			focusAddRef.current = false;
			if (document.hasFocus() && !document.querySelector('[aria-modal="true"]')) addInputRef.current?.focus({ preventScroll: true });
		}
	}, [props.collapsed]);

	// Окно записи уже закрыто, а вставленный текст находится в DOM.
	useEffect(() => {
		if (props.voiceBusy || props.voiceFocusSignal === lastVoiceFocusSignal.current || !addInputRef.current) return;
		lastVoiceFocusSignal.current = props.voiceFocusSignal;
		if (!document.hasFocus() || document.querySelector('[aria-modal="true"]')) return;
		addInputRef.current.focus({ preventScroll: true });
		addInputRef.current.setSelectionRange(props.addText.length, props.addText.length);
	}, [props.addText, props.collapsed, props.voiceBusy, props.voiceFocusSignal]);

	// Ключи раскрытия исчезнувших заметок снимаются, а при смене области переходят на новый ключ: ключ содержит
	// область. Заметки других рабочих областей не затрагиваются — сравниваются только заметки этого окна.
	useEffect(() => {
		const previous = previousNotesRef.current;
		previousNotesRef.current = state?.notes ?? null;
		if (!previous || !state) {
			return;
		}
		const currentKeys = new Set(state.notes.map(note => buildQuickNoteExpandedKey(note)));
		let next: Record<string, boolean> | null = null;
		for (const note of previous) {
			const key = buildQuickNoteExpandedKey(note);
			if (currentKeys.has(key) || !(key in expandedRef.current)) {
				continue;
			}
			next = next ?? { ...expandedRef.current };
			const moved = state.notes.find(entry => entry.id === note.id);
			if (moved && next[key]) {
				next[buildQuickNoteExpandedKey(moved)] = true;
			}
			delete next[key];
		}
		if (next) {
			onExpandedChangeRef.current(next);
		}
	}, [state]);

	const headerActions = (
		// Enter и пробел на кнопках не всплывают к заголовку карточки, который по ним сворачивает виджет.
		<span className="pm-qn-header-actions pm-qn-scope" onKeyDown={event => event.stopPropagation()}>
			{openCount > 0 ? <span className="pm-qn-count" title="Открытых заметок">{openCount}</span> : null}
			<button type="button" className="pm-qn-icon-btn" aria-pressed={searchOpen}
				title={hasFilter && !searchOpen ? 'Поиск заметок (фильтры действуют)' : 'Поиск и фильтр заметок'}
				aria-label="Поиск заметок" aria-expanded={searchOpen && !props.collapsed}
				onClick={event => {
					event.stopPropagation();
					if (props.collapsed) props.onToggleCollapse();
					focusSearchRef.current = props.collapsed || !searchOpen;
					setSearchOpen(open => props.collapsed || !open);
				}}>
				<QuickNoteIcon name="search" size={15}/>
			</button>
			<button
				type="button"
				className="pm-qn-icon-btn"
				title="Новая заметка"
				aria-label="Новая заметка"
				onClick={event => {
					event.stopPropagation();
					if (props.collapsed) {
						focusAddRef.current = true;
						props.onToggleCollapse();
					} else {
						addInputRef.current?.focus();
					}
				}}
			>
				<QuickNoteIcon name="add" size={16} />
			</button>
			<button
				type="button"
				className="pm-qn-icon-btn"
				title="Доска заметок — откроется отдельной вкладкой"
				aria-label="Открыть доску заметок"
				onClick={event => {
					event.stopPropagation();
					client.openBoard();
				}}
			>
				<QuickNoteIcon name="project" size={16} />
			</button>
		</span>
	);

	const body = props.collapsed ? null : (
		<QuickNotesWidget
			state={state}
			preferences={props.preferences}
			expanded={props.expanded}
			newNoteIds={actions.newNoteIds}
			error={actions.error}
			addInputRef={addInputRef}
			searchOpen={searchOpen}
			searchInputRef={searchInputRef}
			onStartVoice={props.onStartVoice}
			voiceBusy={props.voiceBusy}
			voiceInProgress={props.voiceInProgress}
			addText={props.addText}
			onAddTextChange={props.onAddTextChange}
			onAdd={(title, scope, openAfter, color) => {
				const created = actions.createNote({ title, scope, color });
				if (!created) {
					return false;
				}
				if (openAfter) {
					actions.openModal(created.note, [created.note.id], 'description');
				}
				return created.saved;
			}}
			onDismissError={actions.dismissError}
			onPreferencesChange={patch => props.onPreferencesChange({ ...props.preferences, ...patch })}
			onToggleExpanded={key => props.onExpandedChange({ ...props.expanded, [key]: !props.expanded[key] })}
			onToggleDone={actions.toggleDone}
			onToggleItem={actions.toggleItem}
			onOpen={(note, navigationIds) => actions.openModal(note, navigationIds)}
			onOpenPrompt={note => {
				if (note.prompt) {
					client.openPrompt(note.prompt.id, note.prompt.promptUuid);
				}
			}}
			onReorder={actions.reorder}
			onClearDone={actions.clearDone}
			onOpenStorageFile={client.openStorageFile}
			onReload={client.reload}
			onPin={actions.togglePin}
			onDuplicate={actions.duplicate}
			onDelete={actions.deleteNote}
			onSetColor={actions.setColor}
		/>
	);

	return <>{props.renderShell(headerActions, body)}</>;
}
