/**
 * Общие действия быстрых заметок для виджета редактора и страницы доски: создание, отметки, перенос,
 * показ ошибок операций и окно заметки. Окно выводится порталом в body.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { QuickNote, QuickNoteOperation, QuickNoteScope, QuickNoteView } from '../../../../types/quickNotes.js';
import { buildQuickNoteMoveOrders, createQuickNoteId, prepareQuickNoteCreationInput, resolveQuickNoteTopOrder, splitQuickNotes } from '../../../../utils/quickNotes.js';
import { QuickNoteModal } from './QuickNoteModal';
import type { QuickNotesClient } from './useQuickNotesClient';

/** Длительность подсветки новой заметки, мс. */
const NEW_NOTE_HIGHLIGHT_MS = 1300;

/** Открытое окно заметки: заметка, список перехода и место первого фокуса. */
export interface QuickNoteModalTarget {
	id: string;
	navigationIds: string[];
	initialFocus: 'title' | 'description';
}

/** Действия и состояние интерфейса заметок поверх клиента расширения. */
export interface QuickNotesActions {
	newNoteIds: ReadonlySet<string>;
	/** Последняя ошибка операции; показывается до закрытия пользователем. */
	error: string | null;
	dismissError(): void;
	/**
	 * Создаёт заметку первой в списке сразу, не дожидаясь записи; saved сообщает результат записи.
	 * null — состояние ещё не загружено, заметка не создаётся.
	 */
	createNote(input: { title: string; description?: string; scope: QuickNoteScope; color?: string; autoTitle?: boolean }): { note: QuickNote; saved: Promise<boolean> } | null;
	toggleDone(note: QuickNoteView): void;
	toggleItem(note: QuickNoteView, itemId: string): void;
	setColor(note: QuickNoteView, color: string): void;
	reorder(movingId: string, anchorId: string, placement: 'before' | 'after'): void;
	/** Отправляет операции одновременно: неподтверждённые переигрываются по порядку, без промежуточных состояний. */
	applyAll(operations: QuickNoteOperation[]): void;
	clearDone(): void;
	modal: QuickNoteModalTarget | null;
	openModal(note: Pick<QuickNoteView, 'id'>, navigationIds: string[], initialFocus?: 'title' | 'description'): void;
	closeModal(): void;
	navigateModal(id: string): void;
}

/** Создаёт действия заметок для одной страницы или виджета. */
export function useQuickNotesActions(client: QuickNotesClient): QuickNotesActions {
	const [newNoteIds, setNewNoteIds] = useState<ReadonlySet<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [modal, setModal] = useState<QuickNoteModalTarget | null>(null);
	const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
	const modalOpenerRef = useRef<HTMLElement | null>(null);
	const clientRef = useRef(client);
	clientRef.current = client;

	// Таймеры подсветки снимаются вместе с виджетом или страницей.
	useEffect(() => {
		const timers = timersRef.current;
		return () => {
			for (const timer of timers) {
				clearTimeout(timer);
			}
			timers.clear();
		};
	}, []);

	/** Применяет операцию и показывает причину отказа вместо молчаливой отмены изменения. */
	const run = useCallback(async (operation: QuickNoteOperation): Promise<boolean> => {
		const result = await clientRef.current.apply(operation);
		if (!result.ok) {
			setError(result.message || 'Не удалось сохранить изменение заметок.');
		}
		return result.ok;
	}, []);

	/** Коротко подсвечивает только что созданную заметку. */
	const highlight = useCallback((id: string) => {
		setNewNoteIds(previous => new Set([...previous, id]));
		const timer = setTimeout(() => {
			timersRef.current.delete(timer);
			setNewNoteIds(previous => {
				const next = new Set(previous);
				next.delete(id);
				return next;
			});
		}, NEW_NOTE_HIGHLIGHT_MS);
		timersRef.current.add(timer);
	}, []);

	const createNote = useCallback<QuickNotesActions['createNote']>(input => {
		const state = clientRef.current.state;
		if (!state) {
			return null;
		}
		const now = new Date().toISOString();
		const parsed = prepareQuickNoteCreationInput(input.title, input.description);
		const autoTitle = parsed.autoTitle === true || input.autoTitle === true;
		const note: QuickNote = {
			id: createQuickNoteId(),
			title: parsed.title,
			description: parsed.description,
			color: input.color ?? '',
			done: false,
			order: resolveQuickNoteTopOrder(state.notes),
			items: [],
			files: [],
			createdAt: now,
			updatedAt: now,
		};
		highlight(note.id);
		// Окно новой заметки (Ctrl+Enter) закрывается при отказе записи: причина показана сообщением, текст
		// возвращается в поле, а окно иначе сообщило бы, что заметку удалили в другом окне.
		const saved = run({ kind: 'create', scope: input.scope, note, ...(autoTitle ? { autoTitle: true } : {}) }).then(ok => {
			if (!ok) {
				setModal(previous => previous?.id === note.id ? null : previous);
			}
			return ok;
		});
		return { note, saved };
	}, [highlight, run]);

	const openModal = useCallback<QuickNotesActions['openModal']>((note, navigationIds, initialFocus = 'title') => {
		modalOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setModal({ id: note.id, navigationIds, initialFocus });
	}, []);

	const closeModal = useCallback(() => {
		setModal(null);
		const opener = modalOpenerRef.current;
		modalOpenerRef.current = null;
		requestAnimationFrame(() => {
			if (opener?.isConnected) {
				opener.focus();
			}
		});
	}, []);

	return {
		newNoteIds,
		error,
		dismissError: () => setError(null),
		createNote,
		toggleDone: note => void run({ kind: 'update', scope: note.scope, id: note.id, patch: { done: !note.done }, at: new Date().toISOString() }),
		toggleItem: (note, itemId) => {
			const item = note.items.find(entry => entry.id === itemId);
			if (item) {
				void run({ kind: 'setItemDone', scope: note.scope, id: note.id, itemId, done: !item.done, at: new Date().toISOString() });
			}
		},
		setColor: (note, color) => void run({ kind: 'update', scope: note.scope, id: note.id, patch: { color }, at: new Date().toISOString() }),
		reorder: (movingId, anchorId, placement) => {
			const orders = buildQuickNoteMoveOrders(splitQuickNotes(clientRef.current.state?.notes ?? []).open, movingId, anchorId, placement);
			if (orders) {
				void run({ kind: 'setOrders', orders });
			}
		},
		applyAll: operations => {
			for (const operation of operations) {
				void run(operation);
			}
		},
		clearDone: () => void run({ kind: 'clearDone' }),
		modal,
		openModal,
		closeModal,
		navigateModal: id => setModal(previous => previous ? { ...previous, id, initialFocus: 'title' } : previous),
	};
}

/** Окно заметки поверх страницы; удалённая в другом окне заметка показывается последней известной версией. */
export function QuickNoteModalHost({ client, actions }: { client: QuickNotesClient; actions: QuickNotesActions }): React.ReactElement | null {
	const lastNoteRef = useRef<QuickNoteView | null>(null);
	const { state } = client;
	const modal = actions.modal;
	const note = modal && state ? state.notes.find(entry => entry.id === modal.id) ?? null : null;
	if (note) {
		lastNoteRef.current = note;
	}
	const shown = note ?? (modal && lastNoteRef.current?.id === modal.id ? lastNoteRef.current : null);
	if (!modal || !state || !shown || typeof document === 'undefined') {
		return null;
	}
	return createPortal(
		<QuickNoteModal
			key={modal.id}
			note={shown}
			missing={!note}
			navigationIds={modal.navigationIds}
			workspaceAvailable={state.scopes.workspace.available}
			client={client}
			titleGenerating={client.generatingTitleKeys.has(shown.scope + ':' + shown.id)}
			initialFocus={modal.initialFocus}
			onNavigate={actions.navigateModal}
			onClose={actions.closeModal}
		/>,
		document.body,
	);
}
