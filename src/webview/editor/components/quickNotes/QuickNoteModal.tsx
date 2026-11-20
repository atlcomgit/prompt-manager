/**
 * Окно быстрой заметки: полный просмотр и правка в черновике, запись только по «Сохранить».
 * Тесты разметки — tests/quickNotesComponents.test.tsx; чистая логика черновика — src/utils/quickNotes.ts
 * (тесты — tests/quickNotes.test.ts).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
	QUICK_NOTE_PALETTE_COLORS,
	type QuickNoteAttachSource,
	type QuickNoteFile,
	type QuickNoteItem,
	type QuickNoteScope,
	type QuickNoteView,
} from '../../../../types/quickNotes.js';
import {
	buildQuickNoteReplaceOperation,
	canAcceptQuickNoteExternalTitle,
	createQuickNoteDraft,
	createQuickNoteId,
	getQuickNoteChecklistProgress,
	formatQuickNoteClipboardText,
	isQuickNoteDraftDirty,
	normalizeQuickNoteColor,
	resolveAdjacentQuickNoteId,
	syncQuickNoteFilesWithSaved,
} from '../../../../utils/quickNotes.js';
import {
	formatContextFileSize,
	getContextFileExtensionFromMimeType,
	getContextFileKind,
	getContextFileTileLabel,
} from '../../../../utils/contextFiles.js';
import { readClipboardImagePayloads } from '../../../shared/clipboardImages';
import { EditorSectionDragHandle, SortableEditorSections } from '../SortableEditorSections';
import { QuickNoteIcon } from './QuickNoteIcon';
import { trapQuickNotesTabKey, useQuickNotesFocusFallback } from './quickNotesFocus';
import { QUICK_NOTE_COLOR_LABELS, resolveQuickNoteColorCss } from './quickNotesStyles';
import type { QuickNotesClient } from './useQuickNotesClient';
import { resolveQuickNoteScopeLabel } from './QuickNotesWidget';

/** Действия клиента, которые использует окно заметки. */
export type QuickNoteModalClient = Pick<QuickNotesClient,
	'apply' | 'attach' | 'attachLocalFiles' | 'removeDraftFile' | 'discardDraft' | 'openFile' | 'createPrompt' | 'openPrompt' | 'suggest' | 'descriptionHeight' | 'setDescriptionHeight'>;

/** Свойства окна заметки. */
export interface QuickNoteModalProps {
	/** Актуальная версия заметки из состояния; при удалении в другом окне — последняя известная. */
	note: QuickNoteView;
	/** Заметка удалена или перенесена в другом окне. */
	missing?: boolean;
	navigationIds: string[];
	workspaceAvailable: boolean;
	client: QuickNoteModalClient;
	initialFocus?: 'title' | 'description';
	/** Показывает реальное состояние генерации AI-названия в поле ввода. */
	titleGenerating?: boolean;
	onNavigate(id: string): void;
	onClose(): void;
}

/** Состояние блока AI-предложения пункта. */
interface QuickNoteSuggestionState {
	status: 'loading' | 'ready' | 'error';
	text: string;
	error?: string;
	previous: string[];
}

/** Дата и время «18.11.2026 10:42» по локальному времени. */
export function formatQuickNoteDateTime(iso: string | undefined): string {
	const date = new Date(iso || '');
	if (!iso || Number.isNaN(date.getTime())) {
		return '—';
	}
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Пути из перетаскивания проводника VS Code и файлового менеджера (text/uri-list). */
export function parseQuickNoteDroppedUris(text: string): string[] {
	return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

/** Окно быстрой заметки. */
export function QuickNoteModal(props: QuickNoteModalProps): React.ReactElement {
	const { note, client } = props;
	const [original, setOriginal] = useState(() => createQuickNoteDraft(note));
	const [draft, setDraft] = useState(() => createQuickNoteDraft(note));
	const [draftId, setDraftId] = useState(() => createQuickNoteId());
	const [hasPendingFiles, setHasPendingFiles] = useState(false);
	const [extraPreviewUris, setExtraPreviewUris] = useState<Record<string, string>>({});
	const [suggestion, setSuggestion] = useState<QuickNoteSuggestionState | null>(null);
	const [tileMenuOpen, setTileMenuOpen] = useState(false);
	const [filesOver, setFilesOver] = useState(false);
	const [filesStatus, setFilesStatus] = useState('');
	const [uploadingLocalFiles, setUploadingLocalFiles] = useState(false);
	const [footerConfirm, setFooterConfirm] = useState<null | 'close' | 'delete'>(null);
	const [navigationTarget, setNavigationTarget] = useState<string | null>(null);
	const [banner, setBanner] = useState<null | { kind: 'conflict' | 'error'; message: string }>(null);
	const [saving, setSaving] = useState(false);
	const [promptStatus, setPromptStatus] = useState<null | { kind: 'busy' | 'ok' | 'error'; text: string }>(null);
	const [newItemText, setNewItemText] = useState('');
	const [copyStatus, setCopyStatus] = useState<'idle' | 'ok' | 'error'>('idle');
	const [focusItemId, setFocusItemId] = useState<string | null>(null);
	/** Своё удаление ждёт подтверждения: исчезновение заметки в это время не означает удаление в другом окне. */
	const [deleting, setDeleting] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const suggestionBoxRef = useRef<HTMLDivElement>(null);
	const suggestionInputRef = useRef<HTMLInputElement>(null);
	const titleRef = useRef<HTMLInputElement>(null);
	const localFileInputRef = useRef<HTMLInputElement>(null);
	const localUploadBusyRef = useRef(false);
	const descriptionRef = useRef<HTMLTextAreaElement>(null);
	const itemRefs = useRef(new Map<string, HTMLInputElement>());
	const suggestionSeqRef = useRef(0);
	const mountedRef = useRef(true);
	/** Дата изменения, которую ожидаем увидеть после собственного сохранения. */
	const expectedUpdatedAtRef = useRef<string | null>(null);
	// Набранный, но ещё не добавленный пункт тоже несохранённая правка: Ctrl+Enter сохранит его вместе с черновиком.
	const pendingItemText = newItemText.trim();
	const dirty = isQuickNoteDraftDirty(draft, original) || pendingItemText.length > 0;
	const progress = getQuickNoteChecklistProgress(draft);
	const position = props.navigationIds.indexOf(note.id);
	const previewUris = { ...(note.previewUris || {}), ...extraPreviewUris };

	// Копии несохранённого черновика удаляются и тогда, когда окно исчезает без закрытия (страница закрыта, панель
	// перестроена): иначе они лежали бы в .pending до суточной очистки.
	const pendingDraftRef = useRef<{ scope: QuickNoteScope; draftId: string } | null>(null);
	pendingDraftRef.current = hasPendingFiles ? { scope: original.scope, draftId } : null;
	const discardDraftRef = useRef(client.discardDraft);
	discardDraftRef.current = client.discardDraft;
	useEffect(() => () => {
		mountedRef.current = false;
		const pending = pendingDraftRef.current;
		if (pending) {
			discardDraftRef.current(pending.scope, pending.draftId);
		}
	}, []);

	// Первый фокус только при открытии: название или описание новой заметки, открытой сочетанием Ctrl+Enter.
	useEffect(() => {
		const target = props.initialFocus === 'description' ? descriptionRef.current : titleRef.current;
		target?.focus();
	}, []);

	// Ширина/высота поля не относятся к конкретной заметке: сохраняем размер через общие application preferences.
	const saveHeightRef = useRef(client.setDescriptionHeight);
	saveHeightRef.current = client.setDescriptionHeight;
	const descriptionHeightRef = useRef(client.descriptionHeight);
	descriptionHeightRef.current = client.descriptionHeight;
	useEffect(() => {
		const element = descriptionRef.current;
		if (!element || typeof ResizeObserver === 'undefined') return;
		let lastSize = Math.round(element.getBoundingClientRect().height);
		let pending: ReturnType<typeof setTimeout> | null = null;
		const observer = new ResizeObserver(() => {
			const next = Math.round(element.getBoundingClientRect().height);
			if (next < 84 || next > 1000 || Math.abs(next - lastSize) < 2) return;
			lastSize = next;
			if (descriptionHeightRef.current !== undefined
				&& Math.abs(next - descriptionHeightRef.current) < 2) return;
			if (pending) clearTimeout(pending);
			pending = setTimeout(() => saveHeightRef.current(next), 350);
		});
		observer.observe(element);
		return () => { observer.disconnect(); if (pending) clearTimeout(pending); };
	}, []);
	// Внешнее изменение: без правок черновик обновляется, с правками окно предупреждает о конфликте.
	// Эффект зависит только от даты изменения заметки, а не от каждой правки черновика.
	useEffect(() => {
		if (note.updatedAt === original.updatedAt || note.updatedAt === expectedUpdatedAtRef.current) {
			return;
		}
		if (!dirty) {
			setOriginal(createQuickNoteDraft(note));
			setDraft(createQuickNoteDraft(note));
			return;
		}
		// Изменилось только название (AI-название новой заметки), а своё пользователь не вводил: новое название
		// и дата изменения становятся базой черновика, остальные правки сохраняются без конфликта.
		if (canAcceptQuickNoteExternalTitle(original, draft, note)) {
			setOriginal(createQuickNoteDraft(note));
			setDraft(previous => ({ ...previous, title: note.title }));
			return;
		}
		setBanner({ kind: 'conflict', message: 'Заметка изменена в другом окне VS Code, пока открыт черновик.' });
	}, [note.updatedAt]);

	// Подтверждённая версия собственного сохранения может отличаться именами копий: расширение переименовывает
	// новую копию с занятым именем. Записи файлов берутся из неё по id, чтобы следующее сохранение не отправило
	// устаревшее имя; файлы, добавленные или убранные после сохранения, остаются как в черновике.
	const noteFilesKey = JSON.stringify(note.files);
	useEffect(() => {
		if (note.updatedAt !== original.updatedAt) {
			return;
		}
		setOriginal(previous => (previous.updatedAt === note.updatedAt
			? syncQuickNoteFilesWithSaved(previous, note)
			: previous));
		setDraft(previous => syncQuickNoteFilesWithSaved(previous, note));
	}, [note.updatedAt, original.updatedAt, noteFilesKey]);

	// Удаление связанного промпта может прийти, пока открыто окно заметки: убираем старый success-текст.
	useEffect(() => {
		if (!note.prompt && promptStatus?.kind === 'ok') setPromptStatus(null);
	}, [note.prompt?.id, promptStatus?.kind]);

	// Закрытое меню плитки, блок AI или подтверждение не оставляют фокус на body: Escape и Tab окна продолжают работать.
	useQuickNotesFocusFallback(rootRef);

	// Готовое предложение получает фокус, только если пользователь не перешёл к другому полю, пока ждал ответа модели.
	useEffect(() => {
		if (suggestion?.status !== 'ready') {
			return;
		}
		const active = document.activeElement;
		if (!active || active === document.body || active === rootRef.current || suggestionBoxRef.current?.contains(active)) {
			suggestionInputRef.current?.focus();
		}
	}, [suggestion?.status]);

	// Фокус на новый пункт после Enter в тексте пункта.
	useEffect(() => {
		if (focusItemId) {
			itemRefs.current.get(focusItemId)?.focus();
			setFocusItemId(null);
		}
	}, [focusItemId]);

	/** Обновляет поля черновика. */
	const patchDraft = (patch: Partial<QuickNoteView>) => setDraft(previous => ({ ...previous, ...patch }));

	/** Сохраняет черновик; при успехе окно продолжает работу с сохранённой версией. */
	const save = useCallback(async (force = false): Promise<boolean> => {
		if (localUploadBusyRef.current) {
			setFilesStatus('Дождитесь окончания загрузки файлов с компьютера.');
			return false;
		}
		setSaving(true);
		const draftToSave = pendingItemText
			? { ...draft, items: [...draft.items, { id: createQuickNoteId(), text: pendingItemText, done: false }] }
			: draft;
		// «Перезаписать» после переноса заметки в другом окне ищет её в текущей области, иначе запись не найдёт заметку.
		const operation = buildQuickNoteReplaceOperation(draftToSave, original, new Date().toISOString(), {
			draftId, force, sourceScope: force ? note.scope : undefined,
		});
		expectedUpdatedAtRef.current = operation.note.updatedAt;
		const result = await client.apply(operation);
		if (!mountedRef.current) {
			return result.ok;
		}
		setSaving(false);
		if (!result.ok) {
			expectedUpdatedAtRef.current = null;
			setBanner({
				kind: result.code === 'conflict' ? 'conflict' : 'error',
				message: result.message || 'Не удалось сохранить заметку.',
			});
			return false;
		}
		const saved: QuickNoteView = { ...draftToSave, ...operation.note, scope: operation.toScope };
		setOriginal(createQuickNoteDraft(saved));
		setDraft(createQuickNoteDraft(saved));
		if (pendingItemText) {
			setNewItemText(current => current.trim() === pendingItemText ? '' : current);
		}
		// Файлы перенесены из папки черновика: превью берутся из сохранённой заметки.
		setExtraPreviewUris({});
		pendingDraftRef.current = null;
		setHasPendingFiles(false);
		setDraftId(createQuickNoteId());
		setBanner(null);
		return true;
	}, [client, draft, draftId, note.scope, original, pendingItemText]);

	/** Закрывает окно и удаляет временные копии несохранённого черновика. */
	const closeNow = useCallback(() => {
		if (localUploadBusyRef.current) {
			setFilesStatus('Дождитесь завершения загрузки файлов перед закрытием окна.');
			return;
		}
		if (hasPendingFiles) {
			client.discardDraft(original.scope, draftId);
			pendingDraftRef.current = null;
		}
		props.onClose();
	}, [client, draftId, hasPendingFiles, original.scope, props]);

	/** Закрытие с вопросом при несохранённых правках. */
	const requestClose = () => {
		if (localUploadBusyRef.current) {
			setFilesStatus('Дождитесь завершения загрузки файлов перед закрытием окна.');
			return;
		}
		if (dirty && !props.missing) {
			setFooterConfirm('close');
			return;
		}
		closeNow();
	};

	/** Переход к соседней заметке с вопросом при несохранённых правках. */
	const navigate = (direction: 'previous' | 'next') => {
		if (localUploadBusyRef.current) {
			setFilesStatus('Дождитесь завершения загрузки файлов перед переходом.');
			return;
		}
		const targetId = resolveAdjacentQuickNoteId(props.navigationIds, note.id, direction);
		if (!targetId) {
			return;
		}
		if (dirty) {
			setNavigationTarget(targetId);
			return;
		}
		if (hasPendingFiles) {
			client.discardDraft(original.scope, draftId);
			pendingDraftRef.current = null;
		}
		props.onNavigate(targetId);
	};

	/** Сохраняет и закрывает окно. */
	const saveAndClose = async (force = false) => {
		if (await save(force)) {
			props.onClose();
		}
	};

	/** Удаляет заметку вместе с файлами. */
	const deleteNote = async () => {
		if (localUploadBusyRef.current) return;
		setFooterConfirm(null);
		setDeleting(true);
		const result = await client.apply({ kind: 'delete', scope: original.scope, id: original.id });
		if (!mountedRef.current) {
			return;
		}
		if (result.ok) {
			closeNow();
		} else {
			setDeleting(false);
			setBanner({ kind: 'error', message: result.message || 'Не удалось удалить заметку.' });
		}
	};

	/** Создаёт промпт-черновик из сохранённой версии заметки. */
	const createPrompt = async () => {
		if (note.prompt) {
			client.openPrompt(note.prompt.id, note.prompt.promptUuid);
			return;
		}
		if (dirty && !(await save())) {
			return;
		}
		setPromptStatus({ kind: 'busy', text: 'Создаём промпт…' });
		const result = await client.createPrompt(draft.scope, draft.id);
		if (!mountedRef.current) {
			return;
		}
		setPromptStatus(result.ok
			? { kind: 'ok', text: `Промпт «${result.promptTitle || draft.title}» создан и привязан к заметке.` }
			: { kind: 'error', text: result.message || 'Не удалось создать промпт.' });
	};

	/** Добавляет файлы из источника во временную папку черновика. */
	const attach = async (source: QuickNoteAttachSource) => {
		if (localUploadBusyRef.current) return;
		localUploadBusyRef.current = true;
		setUploadingLocalFiles(true);
		setHasPendingFiles(true);
		pendingDraftRef.current = { scope: original.scope, draftId };
		setTileMenuOpen(false);
		setFilesStatus(source.kind === 'dialog' ? '' : 'Добавляем файлы…');
		try {
			const result = await client.attach(original.scope, draftId, source);
			if (!mountedRef.current) return;
			if (result.files.length > 0) {
				setDraft(previous => ({ ...previous, files: [...previous.files, ...result.files] }));
				setExtraPreviewUris(previous => ({ ...previous, ...result.previewUris }));
			}
			const skipped = result.skipped.length ? 'Пропущено: ' + result.skipped.length + '.' : '';
			setFilesStatus([result.error, skipped].filter(Boolean).join(' '));
		} catch (error) {
			if (mountedRef.current) setFilesStatus(error instanceof Error ? error.message : String(error));
		} finally {
			localUploadBusyRef.current = false;
			if (mountedRef.current) setUploadingLocalFiles(false);
		}
	};
	/** Системный файловый диалог браузера и перетаскивание: оригинальные байты ПК отправляются в Ubuntu. */
	const attachLocalFiles = async (files: File[]) => {
		if (localUploadBusyRef.current || files.length === 0) return;
		localUploadBusyRef.current = true;
		setUploadingLocalFiles(true);
		setTileMenuOpen(false);
		setHasPendingFiles(true);
		pendingDraftRef.current = { scope: original.scope, draftId };
		setFilesStatus('Передаём файлы с этого компьютера…');
		try {
			const result = await client.attachLocalFiles(original.scope, draftId, files, (name, percent) => {
				if (mountedRef.current) setFilesStatus('Загружаем «' + name + '»: ' + percent + '%');
			});
			if (!mountedRef.current) return;
			if (result.files.length) {
				setDraft(previous => ({ ...previous, files: [...previous.files, ...result.files] }));
				setExtraPreviewUris(previous => ({ ...previous, ...result.previewUris }));
			}
			const skipped = result.skipped.length ? 'Пропущено: ' + result.skipped.length + '.' : '';
			setFilesStatus([result.error, skipped, result.files.length
				? 'Добавлено файлов: ' + result.files.length + '.' : ''].filter(Boolean).join(' '));
		} catch (error) {
			if (mountedRef.current) setFilesStatus('Ошибка передачи файла: '
				+ (error instanceof Error ? error.message : String(error)));
		} finally {
			localUploadBusyRef.current = false;
			if (mountedRef.current) setUploadingLocalFiles(false);
		}
	};

	/** Вставка из буфера: изображения содержимым, иначе пути к файлам из текста буфера. */
	const pasteFromClipboard = async () => {
		const images = await readClipboardImagePayloads();
		if (images.length > 0) {
			const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
			await attach({
				kind: 'content',
				files: images.map((image, index) => ({
					name: `clipboard-image-${stamp}-${index + 1}.${getContextFileExtensionFromMimeType(image.mimeType)}`,
					dataBase64: image.dataBase64,
				})),
			});
			return;
		}
		await attach({ kind: 'clipboard' });
	};

	/** Перетаскивание из локальной ОС получает приоритет над URI, которые могут быть Windows-путями. */
	const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		event.stopPropagation();
		setFilesOver(false);
		const files = Array.from(event.dataTransfer.files || []);
		if (files.some(file => file.size > 0)) {
			await attachLocalFiles(files);
			return;
		}
		const uriList = event.dataTransfer.getData('application/vnd.code.uri-list') || event.dataTransfer.getData('text/uri-list');
		const uris = parseQuickNoteDroppedUris(uriList);
		if (uris.length > 0) {
			await attach({ kind: 'paths', paths: uris });
			return;
		}
		if (files.length > 0) await attachLocalFiles(files);
	};

	/** Копирует название, отличающееся описание и чек-лист текущего черновика. */
	const copyNoteText = async () => {
		const text = formatQuickNoteClipboardText(draft);
		try {
			await navigator.clipboard.writeText(text);
			setCopyStatus('ok');
		} catch {
			setCopyStatus('error');
			setBanner({ kind: 'error', message: 'Браузер не разрешил запись в буфер обмена. Проверьте разрешения VS Code Tunnel.' });
		}
	};

	/** Запрашивает предложение пункта; поздний ответ после перегенерации или закрытия отбрасывается. */
	const requestSuggestion = async (rejectCurrent = false) => {
		if (suggestion?.status === 'loading') return;
		const sequence = ++suggestionSeqRef.current;
		const rejected = rejectCurrent && suggestion?.text.trim() ? suggestion.text.trim() : '';
		const previous = [...new Set([
			...(note.rejectedSuggestions || []), ...(suggestion?.previous || []), rejected,
		].map(text => text.trim()).filter(Boolean))].slice(-80);
		// Показываем загрузку до записи отклонённого варианта. Закрытие блока отменяет следующий запрос.
		setSuggestion({ status: 'loading', text: '', previous });
		if (rejected) {
			const stored = await client.apply({ kind: 'rejectSuggestion', scope: note.scope, id: note.id, text: rejected });
			if (!mountedRef.current || sequence !== suggestionSeqRef.current) return;
			if (!stored.ok) {
				setSuggestion({ status: 'error', text: '', previous, error: stored.message || 'Не удалось запомнить отклонённый пункт.' });
				return;
			}
		}
		const result = await client.suggest({
			title: draft.title,
			description: draft.description,
			items: draft.items.map(item => ({ text: item.text, done: item.done })),
			fileNames: draft.files.map(file => file.name),
			previousSuggestions: previous,
		});
		if (!mountedRef.current || sequence !== suggestionSeqRef.current) return;
		const repeated = Boolean(result.text && previous.some(value => value.toLocaleLowerCase() === result.text.trim().toLocaleLowerCase()));
		setSuggestion(result.text && !repeated
			? { status: 'ready', text: result.text, previous: [...previous, result.text] }
			: { status: 'error', text: '', error: repeated
				? 'AI повторил уже отклонённый пункт. Попробуйте перегенерировать.'
				: result.error || 'AI не предложил новый пункт. Попробуйте ещё раз.', previous });
	};

	/** Скрывает блок предложения и делает ожидаемый ответ устаревшим. */
	const closeSuggestion = () => {
		suggestionSeqRef.current += 1;
		setSuggestion(null);
	};

	/** Добавляет предложенный (и, возможно, исправленный) пункт в черновик. */
	const applySuggestion = () => {
		const text = suggestion?.text.trim();
		if (!text) {
			return;
		}
		patchDraft({ items: [...draft.items, { id: createQuickNoteId(), text, done: false }] });
		closeSuggestion();
	};

	/** Добавляет пункт из строки «Добавить пункт» и оставляет фокус в ней. */
	const addItem = () => {
		const text = newItemText.trim();
		if (!text) {
			return;
		}
		patchDraft({ items: [...draft.items, { id: createQuickNoteId(), text, done: false }] });
		setNewItemText('');
	};

	/** Меняет пункт черновика. */
	const updateItem = (itemId: string, patch: Partial<QuickNoteItem>) => {
		patchDraft({ items: draft.items.map(item => item.id === itemId ? { ...item, ...patch } : item) });
	};

	/** Клавиши пункта: Enter — новый пункт после текущего, Backspace в пустом — удаление. */
	const handleItemKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, item: QuickNoteItem, index: number) => {
		if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey) {
			event.preventDefault();
			const created: QuickNoteItem = { id: createQuickNoteId(), text: '', done: false };
			const items = [...draft.items];
			items.splice(index + 1, 0, created);
			patchDraft({ items });
			setFocusItemId(created.id);
		} else if (event.key === 'Backspace' && !item.text) {
			event.preventDefault();
			patchDraft({ items: draft.items.filter(entry => entry.id !== item.id) });
			setFocusItemId(draft.items[index - 1]?.id ?? null);
		}
	};

	/** Клавиши окна, удержание фокуса и вставка файлов из буфера. */
	const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		const typing = /^(INPUT|TEXTAREA)$/.test(target.tagName);
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			if (tileMenuOpen) {
				setTileMenuOpen(false);
			} else if (suggestion) {
				closeSuggestion();
			} else if (footerConfirm || navigationTarget) {
				setFooterConfirm(null);
				setNavigationTarget(null);
			} else {
				requestClose();
			}
			return;
		}
		// Сочетания сверяются по физической клавише: в русской раскладке Ctrl+S даёт key «ы».
		if ((event.ctrlKey || event.metaKey) && (event.code === 'KeyS' || event.key === 's' || event.key === 'S' || event.key === 'Enter')) {
			event.preventDefault();
			event.stopPropagation();
			if (dirty && !saving) {
				void saveAndClose();
			}
			return;
		}
		if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
			event.preventDefault();
			event.stopPropagation();
			navigate(event.key === 'ArrowLeft' ? 'previous' : 'next');
			return;
		}
		if ((event.ctrlKey || event.metaKey) && (event.code === 'KeyV' || event.key === 'v' || event.key === 'V') && !typing) {
			event.preventDefault();
			void pasteFromClipboard();
			return;
		}
		// Фокус остаётся внутри окна, пока оно открыто.
		trapQuickNotesTabKey(event, rootRef.current);
	};

	/** Новые файлы удаляем из .pending сразу; сохранённые — после Save, чтобы Отмена их восстановила. */
	const removeFile = async (file: QuickNoteFile) => {
		if (localUploadBusyRef.current || saving) return;
		const isNew = !original.files.some(saved => saved.id === file.id);
		if (isNew) {
			localUploadBusyRef.current = true;
			setUploadingLocalFiles(true);
			try {
				const outcome = await client.removeDraftFile(original.scope, draftId, file.storedName);
				if (!mountedRef.current) return;
				if (!outcome.ok) {
					setFilesStatus(outcome.error || 'Не удалось удалить временный файл на сервере.');
					return;
				}
			} finally {
				localUploadBusyRef.current = false;
				if (mountedRef.current) setUploadingLocalFiles(false);
			}
		}
		setDraft(previous => ({ ...previous, files: previous.files.filter(entry => entry.id !== file.id) }));
		setExtraPreviewUris(previous => {
			const next = { ...previous };
			delete next[file.id];
			return next;
		});
		setFilesStatus('');
	};
	/** Плитка файла с превью изображения или меткой типа. */
	const renderFile = (file: QuickNoteFile) => {
		const kind = getContextFileKind(file.name);
		const preview = previewUris[file.id];
		return (
			<div key={file.id} className="pm-qn-file">
				<button
					type="button"
					className="pm-qn-file-open"
					title={`${file.name} — открыть в VS Code`}
					aria-label={`Открыть файл ${file.name}`}
					onClick={() => client.openFile(original.scope, original.id, file.storedName, draftId)}
				>
					<span className="pm-qn-file-thumb">
						{preview && kind === 'image'
							? <img src={preview} alt="" loading="lazy" decoding="async" />
							: <>
								<QuickNoteIcon name={kind === 'pdf' ? 'file-pdf' : kind === 'code' ? 'file-code' : kind === 'image' ? 'file-media' : 'file'} size={22} />
								<span className="pm-qn-file-ext">{getContextFileTileLabel(file.name, kind)}</span>
							</>}
					</span>
					<span className="pm-qn-file-name">{file.name}</span>
					<span className="pm-qn-file-size">{formatContextFileSize(file.size)}</span>
				</button>
				<button
					type="button"
					className="pm-qn-icon-btn pm-qn-file-rm"
					title="Убрать файл"
					aria-label={`Убрать файл ${file.name}`}
					onClick={() => void removeFile(file)}
				>
					<QuickNoteIcon name="close" size={12} />
				</button>
			</div>
		);
	};

	const selectedColor = normalizeQuickNoteColor(draft.color);
	const scopes: QuickNoteScope[] = ['workspace', 'global'];

	return (
		<div className="pm-qn-overlay pm-qn-scope" role="presentation" onMouseDown={event => {
			if (event.target === event.currentTarget) {
				requestClose();
			}
		}}>
			<div
				ref={rootRef}
				className="pm-qn-modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="pm-qn-modal-title"
				tabIndex={-1}
				onKeyDown={handleKeyDown}
				data-pm-quick-note-modal={note.id}
			>
				<div className="pm-qn-modal-h">
					<span className="pm-qn-crumb">
						<QuickNoteIcon name={draft.scope === 'global' ? 'globe' : 'folder'} size={14} />
						Быстрая заметка · {resolveQuickNoteScopeLabel(draft.scope)}
					</span>
					{position >= 0 ? <span className="pm-qn-pos">{position + 1} из {props.navigationIds.length}</span> : null}
					<button type="button" className="pm-qn-icon-btn" title="Предыдущая заметка (Alt+←)" aria-label="Предыдущая заметка"
						disabled={uploadingLocalFiles || props.navigationIds.length < 2 || position < 0} onClick={() => navigate('previous')}>
						<QuickNoteIcon name="chevron-left" size={14} />
					</button>
					<button type="button" className="pm-qn-icon-btn" title="Следующая заметка (Alt+→)" aria-label="Следующая заметка"
						disabled={uploadingLocalFiles || props.navigationIds.length < 2 || position < 0} onClick={() => navigate('next')}>
						<QuickNoteIcon name="chevron-right" size={14} />
					</button>
					<button type="button" className="pm-qn-icon-btn" title="Закрыть (Escape)" aria-label="Закрыть" onClick={requestClose}>
						<QuickNoteIcon name="close" size={14} />
					</button>
				</div>
				<div className="pm-qn-modal-b">
					{props.missing && !deleting ? (
						<div className="pm-qn-banner is-error" role="alert">
							<QuickNoteIcon name="info" size={14} />
							<span className="pm-qn-grow">Заметка удалена или перенесена в другом окне VS Code.</span>
							<button type="button" className="pm-qn-btn is-secondary" onClick={closeNow}>Закрыть</button>
						</div>
					) : null}
					{banner ? (
						<div className={`pm-qn-banner${banner.kind === 'error' ? ' is-error' : ''}`} role="alert">
							<QuickNoteIcon name="info" size={14} />
							<span className="pm-qn-grow">{banner.message}</span>
							{banner.kind === 'conflict' ? (
								<>
									<button type="button" className="pm-qn-btn is-secondary" onClick={() => {
										setOriginal(createQuickNoteDraft(note));
										setDraft(createQuickNoteDraft(note));
										setNewItemText('');
										setBanner(null);
									}}>Загрузить актуальную</button>
									<button type="button" className="pm-qn-btn is-ghost" disabled={saving || uploadingLocalFiles} onClick={() => void saveAndClose(true)}>Перезаписать</button>
								</>
							) : (
								<button type="button" className="pm-qn-btn is-ghost" onClick={() => setBanner(null)}>Скрыть</button>
							)}
						</div>
					) : null}
					{navigationTarget ? (
						<div className="pm-qn-banner" role="alert">
							<QuickNoteIcon name="info" size={14} />
							<span className="pm-qn-grow">Сохранить изменения перед переходом к другой заметке?</span>
							<button type="button" className="pm-qn-btn is-primary" disabled={saving || uploadingLocalFiles} onClick={async () => {
								const target = navigationTarget;
								if (await save()) {
									props.onNavigate(target);
								}
							}}>Сохранить</button>
							<button type="button" className="pm-qn-btn is-secondary" onClick={() => {
								const target = navigationTarget;
								if (hasPendingFiles) {
									client.discardDraft(original.scope, draftId);
									pendingDraftRef.current = null;
								}
								props.onNavigate(target);
							}}>Не сохранять</button>
							<button type="button" className="pm-qn-btn is-ghost" onClick={() => setNavigationTarget(null)}>Остаться</button>
						</div>
					) : null}
					<div className="pm-qn-title-line">
						<button
							type="button"
							className="pm-qn-check is-large"
							role="checkbox"
							aria-checked={draft.done}
							aria-label="Выполнена"
							onClick={() => patchDraft({ done: !draft.done })}
						>
							{draft.done ? <QuickNoteIcon name="check" size={14} /> : null}
						</button>
						<div className="pm-qn-title-field">
						<input
							id="pm-qn-modal-title"
							ref={titleRef}
							className="pm-qn-title-input"
							value={draft.title}
							aria-label="Название заметки"
							onChange={event => patchDraft({ title: event.target.value })}
						/>
						{props.titleGenerating ? <span className="pm-qn-title-spinner" role="status" aria-label="Генерируем название" title="Генерируем название">
							<QuickNoteIcon name="loading" size={15} className="pm-qn-spin" />
						</span> : null}
						</div>
					</div>
					<div className="pm-qn-props">
						<div className="pm-qn-prop">
							<span className="pm-qn-label">Цвет</span>
							<div className="pm-qn-swatches" role="group" aria-label="Цвет заметки">
								<button type="button" className="pm-qn-swatch is-none" aria-pressed={!selectedColor}
									title="Без цвета" aria-label="Без цвета" onClick={() => patchDraft({ color: '' })} />
								{QUICK_NOTE_PALETTE_COLORS.map(color => (
									<button key={color} type="button" className="pm-qn-swatch" aria-pressed={selectedColor === color}
										title={QUICK_NOTE_COLOR_LABELS[color]} aria-label={QUICK_NOTE_COLOR_LABELS[color]}
										style={{ background: resolveQuickNoteColorCss(color) }} onClick={() => patchDraft({ color })} />
								))}
								<label className={`pm-qn-swatch is-custom${selectedColor.startsWith('#') ? ' is-selected' : ''}`} title="Свой цвет…">
									<input type="color" aria-label={selectedColor.startsWith('#') ? `Свой цвет: ${selectedColor}, выбран` : 'Свой цвет'}
										value={selectedColor.startsWith('#') ? selectedColor : '#3794ff'}
										onChange={event => patchDraft({ color: event.target.value })} />
								</label>
							</div>
						</div>
						<div className="pm-qn-prop">
							<span className="pm-qn-label">Область</span>
							<div className="pm-qn-seg" role="group" aria-label="Область заметки">
								{scopes.map(scope => (
									<button key={scope} type="button" aria-pressed={draft.scope === scope}
										disabled={scope === 'workspace' && !props.workspaceAvailable}
										title={scope === 'workspace' && !props.workspaceAvailable ? 'Откройте папку, чтобы хранить заметки проекта' : undefined}
										onClick={() => patchDraft({ scope })}>
										<QuickNoteIcon name={scope === 'global' ? 'globe' : 'folder'} size={13} />
										{scope === 'global' ? 'Глобальная' : 'Проект'}
									</button>
								))}
							</div>
						</div>
					</div>
					<div className="pm-qn-block">
						<span className="pm-qn-label">Описание</span>
						<textarea
							ref={descriptionRef}
							className="pm-qn-textarea"
							style={client.descriptionHeight ? { height: client.descriptionHeight } : undefined}
							value={draft.description}
							placeholder="Подробности, ссылки, идеи…"
							aria-label="Описание заметки"
							onChange={event => patchDraft({ description: event.target.value })}
						/>
					</div>
					<div className="pm-qn-block">
						<div className="pm-qn-block-h">
							<span className="pm-qn-label">Чек-лист</span>
							{progress.total > 0 ? (
								<>
									<span className="pm-qn-muted">{progress.done}/{progress.total}</span>
									<span className="pm-qn-progress" aria-hidden="true">
										<span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
									</span>
								</>
							) : null}
						</div>
						<div className="pm-qn-items">
							<SortableEditorSections
								order={draft.items.map(item => item.id)}
								scopeKey={`quick-note-items:${note.id}`}
								gap={0}
								onReorder={order => patchDraft({
									items: order.map(id => draft.items.find(item => item.id === id)).filter((item): item is QuickNoteItem => Boolean(item)),
								})}
							>
								{draft.items.map((item, index) => (
									<div key={item.id} data-pm-editor-section={item.id} className={`pm-qn-item${item.done ? ' is-done' : ''}`}>
										<span className="pm-qn-grip"><EditorSectionDragHandle sectionKey={item.id} title={item.text || 'пустой пункт'} itemLabel="пункт" /></span>
										<button type="button" className="pm-qn-check" role="checkbox" aria-checked={item.done}
											aria-label={`Выполнен: ${item.text}`} onClick={() => updateItem(item.id, { done: !item.done })}>
											{item.done ? <QuickNoteIcon name="check" size={12} /> : null}
										</button>
										<input
											ref={element => {
												if (element) {
													itemRefs.current.set(item.id, element);
												} else {
													itemRefs.current.delete(item.id);
												}
											}}
											className="pm-qn-item-text"
											value={item.text}
											aria-label="Текст пункта"
											onChange={event => updateItem(item.id, { text: event.target.value })}
											onKeyDown={event => handleItemKeyDown(event, item, index)}
										/>
										<button type="button" className="pm-qn-icon-btn pm-qn-item-del" title="Удалить пункт" aria-label="Удалить пункт"
											onClick={() => patchDraft({ items: draft.items.filter(entry => entry.id !== item.id) })}>
											<QuickNoteIcon name="close" size={12} />
										</button>
									</div>
								))}
							</SortableEditorSections>
							<div className="pm-qn-add-item">
								<QuickNoteIcon name="add" size={14} />
								<input
									value={newItemText}
									placeholder="Добавить пункт — Enter"
									aria-label="Новый пункт"
									onChange={event => setNewItemText(event.target.value)}
									onKeyDown={event => {
										// Ctrl+Enter не добавляет пункт, а всплывает к окну и сохраняет черновик вместе с набранным текстом.
										if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey) {
											event.preventDefault();
											addItem();
										}
									}}
								/>
							</div>
						</div>
						{suggestion ? (
							<div ref={suggestionBoxRef} className="pm-qn-ai-box" role="group" aria-label="Предложение AI">
								<div className="pm-qn-ai-h">
									<QuickNoteIcon name="sparkle" size={14} />
									<span className="pm-qn-grow">Предложение AI</span>
									<button type="button" className="pm-qn-icon-btn" title="Скрыть (Escape)" aria-label="Скрыть предложение" onClick={closeSuggestion}>
										<QuickNoteIcon name="close" size={12} />
									</button>
								</div>
								{suggestion.status === 'loading' ? (
									<div className="pm-qn-status" role="status"><QuickNoteIcon name="loading" size={14} className="pm-qn-spin" />Подбираю пункт по заметке…</div>
								) : suggestion.status === 'error' ? (
									<div className="pm-qn-status" role="alert">{suggestion.error}</div>
								) : (
									<input
										ref={suggestionInputRef}
										className="pm-qn-input"
										value={suggestion.text}
										aria-label="Предложенный пункт чек-листа"
										onChange={event => setSuggestion({ ...suggestion, text: event.target.value })}
										onKeyDown={event => {
											if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey) {
												event.preventDefault();
												applySuggestion();
											}
										}}
									/>
								)}
								<div className="pm-qn-actions">
									<span className="pm-qn-muted pm-qn-grow">Учитываются название, описание, пункты и файлы заметки. Текст можно поправить.</span>
									<button type="button" className="pm-qn-btn is-ghost" disabled={suggestion.status === 'loading'} onClick={() => void requestSuggestion(true)}>
										<QuickNoteIcon name="refresh" size={13} />Перегенерировать
									</button>
									<button type="button" className="pm-qn-btn is-primary" disabled={suggestion.status !== 'ready' || !suggestion.text.trim()} onClick={applySuggestion}>
										<QuickNoteIcon name="add" size={13} />Добавить в чек-лист
									</button>
								</div>
							</div>
						) : (
							<button type="button" className="pm-qn-ai-btn" onClick={() => void requestSuggestion()}>
								<QuickNoteIcon name="sparkle" size={13} />Добавить предложение AI
							</button>
						)}
					</div>
					<div className="pm-qn-block">
						<div className="pm-qn-block-h">
							<span className="pm-qn-label">Файлы</span>
							{draft.files.length > 0 ? <span className="pm-qn-muted">{draft.files.length}</span> : null}
							{filesStatus ? <span className="pm-qn-muted" role="status">{filesStatus}</span> : null}
						</div>
						<input ref={localFileInputRef} type="file" multiple style={{ display: 'none' }}
							aria-label="Выбрать файлы с этого компьютера" onChange={event => {
								const selected = Array.from(event.currentTarget.files || []);
								event.currentTarget.value = '';
								void attachLocalFiles(selected);
							}} />
						<div
							className={`pm-qn-files${filesOver ? ' is-over' : ''}`}
							onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setFilesOver(true); }}
							onDragLeave={event => {
								if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
									setFilesOver(false);
								}
							}}
							onDrop={event => void handleDrop(event)}
						>
							{draft.files.map(renderFile)}
							<div className="pm-qn-add-tile-wrap">
								<button type="button" className="pm-qn-add-tile" aria-haspopup="menu" aria-expanded={tileMenuOpen}
									title="Добавить файлы с компьютера или сервера; можно перетащить на эту область"
									onClick={() => setTileMenuOpen(!tileMenuOpen)}>
									<QuickNoteIcon name="add" size={22} />Добавить
								</button>
								{tileMenuOpen ? (
									<div className="pm-qn-menu" role="menu">
										<button type="button" role="menuitem" disabled={uploadingLocalFiles} onClick={() => { setTileMenuOpen(false); localFileInputRef.current?.click(); }}>
											<QuickNoteIcon name="folder-opened" size={14} />С этого компьютера…
										</button>
										<button type="button" role="menuitem" disabled={uploadingLocalFiles} onClick={() => void attach({ kind: 'dialog' })}>
											<QuickNoteIcon name="folder-opened" size={14} />С сервера / проекта…
										</button>
										<button type="button" role="menuitem" disabled={uploadingLocalFiles} onClick={() => void pasteFromClipboard()}>
											<QuickNoteIcon name="clippy" size={14} />Вставить из буфера<span className="pm-qn-menu-key">Ctrl+V</span>
										</button>
										<div className="pm-qn-menu-note">Или перетащите файлы сюда из проводника компьютера</div>
									</div>
								) : null}
							</div>
						</div>
					</div>
					<div className="pm-qn-prompt-box">
						<QuickNoteIcon name="sparkle" size={16} />
						<span className="pm-qn-prompt-text" role="status">
							{promptStatus ? promptStatus.text : note.prompt
								? <><b>Промпт создан</b> · черновик привязан к этой заметке</>
								: <><b>В промпт</b> — черновик с названием, описанием, чек-листом и файлами этой заметки. Редактор не откроется.</>}
						</span>
						{note.prompt ? (
							<button type="button" className="pm-qn-btn is-secondary" onClick={() => client.openPrompt(note.prompt!.id, note.prompt!.promptUuid)}>
								<QuickNoteIcon name="link-external" size={13} />Открыть промпт
							</button>
						) : (
							<button type="button" className="pm-qn-btn is-primary" disabled={promptStatus?.kind === 'busy' || saving || props.missing || uploadingLocalFiles}
								onClick={() => void createPrompt()}>
								<QuickNoteIcon name="sparkle" size={13} />В промпт
							</button>
						)}
					</div>
					<div className="pm-qn-muted">
						Создана {formatQuickNoteDateTime(note.createdAt)} · изменена {formatQuickNoteDateTime(note.updatedAt)}
					</div>
				</div>
				<div className="pm-qn-modal-f">
					{footerConfirm === 'delete' ? (
						<>
							<span style={{ fontSize: 12 }}>Удалить заметку и её файлы?</span>
							<button type="button" className="pm-qn-btn is-danger" onClick={() => void deleteNote()}>
								<QuickNoteIcon name="trash" size={13} />Удалить
							</button>
							<button type="button" className="pm-qn-btn is-ghost" onClick={() => setFooterConfirm(null)}>Нет</button>
						</>
					) : footerConfirm === 'close' ? (
						<>
							<span style={{ fontSize: 12 }}>Закрыть без сохранения изменений?</span>
							<button type="button" className="pm-qn-btn is-danger" onClick={closeNow}>Закрыть</button>
							<button type="button" className="pm-qn-btn is-ghost" onClick={() => setFooterConfirm(null)}>Остаться</button>
						</>
					) : (
						<button type="button" className="pm-qn-btn is-danger" disabled={props.missing || uploadingLocalFiles} onClick={() => setFooterConfirm('delete')}>
							<QuickNoteIcon name="trash" size={13} />Удалить
						</button>
					)}
					<span className="pm-qn-grow" />
					<button type="button" className="pm-qn-btn is-secondary" onClick={() => void copyNoteText()}>
						<QuickNoteIcon name="clippy" size={13}/>{copyStatus === 'ok' ? 'Скопировано' : 'Копировать'}
					</button>
					{dirty ? <span className="pm-qn-dirty">Есть несохранённые изменения</span> : null}
					<button type="button" className="pm-qn-btn is-secondary" onClick={requestClose}>Отмена</button>
					<button type="button" className="pm-qn-btn is-primary" disabled={!dirty || saving || props.missing || uploadingLocalFiles} onClick={() => void saveAndClose()}>
						{saving ? <QuickNoteIcon name="loading" size={13} className="pm-qn-spin" /> : null}
						Сохранить<span className="pm-qn-kbd">Ctrl+S</span>
					</button>
				</div>
			</div>
		</div>
	);
}
