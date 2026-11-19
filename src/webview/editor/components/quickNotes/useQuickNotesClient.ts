/**
 * Клиент быстрых заметок в webview: состояние от расширения, мгновенное применение операций и запросы по requestId.
 * Неподтверждённые операции переигрываются поверх каждого нового состояния расширения: операции задают значения,
 * а не переключают их, поэтому повтор уже применённой операции не меняет результат.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
	QuickNoteAttachSource,
	QuickNoteChecklistSuggestionInput,
	QuickNoteFile,
	QuickNoteOperation,
	QuickNoteOperationResult,
	QuickNoteScope,
	QuickNotesState,
} from '../../../../types/quickNotes.js';
import { QUICK_NOTE_LOCAL_FILE_CHUNK_BYTES, QUICK_NOTE_LOCAL_FILE_MAX_BYTES, QUICK_NOTE_LOCAL_FILE_MAX_TOTAL_BYTES, QUICK_NOTE_LOCAL_FILE_MAX_COUNT } from '../../../../types/quickNotes.js';
import { applyQuickNoteOperation } from '../../../../utils/quickNotes.js';
import { getVsCodeApi } from '../../../shared/vscodeApi';
import { blobToBase64 } from '../../../shared/clipboardImages';

/** Предельное ожидание ответа расширения; после него операция считается неудачной и откатывается. */
const QUICK_NOTES_RESPONSE_TIMEOUT_MS = 20_000;

/** Ожидание ответа на AI-предложение: запрос к модели может идти дольше обычных операций. */
const QUICK_NOTES_SUGGESTION_TIMEOUT_MS = 90_000;

/** Результат добавления файлов в черновик. */
export interface QuickNotesAttachResult {
	files: QuickNoteFile[];
	previewUris: Record<string, string>;
	skipped: string[];
	error?: string;
}

/** Результат создания промпта из заметки. */
export interface QuickNotesPromptResult {
	ok: boolean;
	promptTitle?: string;
	message?: string;
}

/** Результат AI-предложения пункта; пустой text с error — пункт не предложен. */
export interface QuickNotesSuggestionResult {
	text: string;
	error?: string;
}

/** Действия и состояние заметок для виджета, окна и доски. */
export interface QuickNotesClient {
	/** Состояние с применёнными неподтверждёнными операциями; null до первого ответа. */
	state: QuickNotesState | null;
	/** Какие заметки сейчас получают AI-название, в формате scope:id. */
	generatingTitleKeys: ReadonlySet<string>;
	/** Высота описания, общая для всех заметок и проектов. */
	descriptionHeight?: number;
	setDescriptionHeight(height: number): void;
	/** Применяет операцию сразу и ждёт подтверждения записи; при отказе изменение снимается. */
	apply(operation: QuickNoteOperation): Promise<QuickNoteOperationResult>;
	/** Копирует файлы источника во временную папку черновика окна заметки. */
	attach(scope: QuickNoteScope, draftId: string, source: QuickNoteAttachSource): Promise<QuickNotesAttachResult>;
	/** Передаёт локальные файлы небольшими блоками через Remote Tunnel. */
	attachLocalFiles(scope: QuickNoteScope, draftId: string, files: readonly File[],
		onProgress?: (fileName: string, percent: number) => void): Promise<QuickNotesAttachResult>;
	/** Удаляет временные копии отменённого черновика. */
	discardDraft(scope: QuickNoteScope, draftId: string): void;
	/** Удаляет только несохранённый файл из временной папки. */
	removeDraftFile(scope: QuickNoteScope, draftId: string, storedName: string): Promise<{ ok: boolean; error?: string }>;
	/** Открывает файл заметки или черновика в редакторе VS Code. */
	openFile(scope: QuickNoteScope, noteId: string, storedName: string, draftId?: string): void;
	/** Открывает quick-notes.json области, например при ошибке чтения. */
	openStorageFile(scope: QuickNoteScope): void;
	/** Создаёт промпт-черновик из сохранённой заметки. */
	createPrompt(scope: QuickNoteScope, noteId: string): Promise<QuickNotesPromptResult>;
	/** Открывает связанный промпт в редакторе. */
	openPrompt(promptId: string, promptUuid?: string): void;
	/** Запрашивает у AI новый пункт чек-листа по черновику. */
	suggest(input: QuickNoteChecklistSuggestionInput): Promise<QuickNotesSuggestionResult>;
	/** Заново запрашивает состояние у расширения. */
	reload(): void;
	/** Открывает страницу доски заметок отдельной вкладкой. */
	openBoard(): void;
}

/** Ожидающий ответа запрос: обработчик и таймер ограничения ожидания. */
interface PendingRequest {
	resolve: (message: Record<string, unknown> | null) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Создаёт уникальный идентификатор запроса панели. */
function createRequestId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Применяет неподтверждённые операции поверх состояния расширения. */
export function resolveEffectiveQuickNotesState(
	host: QuickNotesState | null,
	pending: ReadonlyArray<{ operation: QuickNoteOperation }>,
): QuickNotesState | null {
	if (!host) {
		return null;
	}
	const notes = pending.reduce((current, entry) => applyQuickNoteOperation(current, entry.operation).notes, host.notes);
	return notes === host.notes ? host : { ...host, notes };
}

/** Подключает webview к сервису заметок расширения. */
export function useQuickNotesClient(): QuickNotesClient {
	const [hostState, setHostState] = useState<QuickNotesState | null>(null);
	const [generatingTitleKeys, setGeneratingTitleKeys] = useState<ReadonlySet<string>>(new Set());
	const [descriptionHeight, setDescriptionHeightState] = useState<number | undefined>();
	const [pendingOperations, setPendingOperations] = useState<Array<{ requestId: string; operation: QuickNoteOperation }>>([]);
	const pendingRequestsRef = useRef(new Map<string, PendingRequest>());

	/** Отправляет сообщение расширению; вне webview (SSR и тесты) ничего не делает. */
	const post = useCallback((message: Record<string, unknown>) => {
		try {
			getVsCodeApi().postMessage(message);
		} catch {
			// Вне webview API недоступен: компонент остаётся в состоянии загрузки.
		}
	}, []);

	/** Регистрирует ожидание ответа с ограниченным таймаутом. */
	const waitForResponse = useCallback((requestId: string, timeoutMs: number) => new Promise<Record<string, unknown> | null>(resolve => {
		const timer = setTimeout(() => {
			pendingRequestsRef.current.delete(requestId);
			resolve(null);
		}, timeoutMs);
		pendingRequestsRef.current.set(requestId, { resolve, timer });
	}), []);

	// Ответы расширения адресуются по requestId; полное состояние приходит и без него при внешних изменениях.
	useEffect(() => {
		const pendingRequests = pendingRequestsRef.current;
		const listener = (event: MessageEvent) => {
			const message = event.data as Record<string, unknown> | null;
			if (!message || typeof message.type !== 'string' || !message.type.startsWith('quickNotes')) {
				return;
			}
			if (message.type === 'quickNotesState') {
				setHostState(message.state as QuickNotesState);
				if (typeof message.descriptionHeight === 'number') setDescriptionHeightState(message.descriptionHeight);
				if (Array.isArray(message.generatingTitleKeys)) {
					setGeneratingTitleKeys(new Set(message.generatingTitleKeys.filter((x): x is string => typeof x === 'string')));
				}
				if (typeof message.requestId === 'string') {
					const requestId = message.requestId;
					setPendingOperations(previous => previous.filter(entry => entry.requestId !== requestId));
				}
			}
			if (message.type === 'quickNotesPreferences') {
				const prefs = message.state as { descriptionHeight?: number } | undefined;
				setDescriptionHeightState(typeof prefs?.descriptionHeight === 'number' ? prefs.descriptionHeight : undefined);
			}
			if (message.type === 'quickNotesTitleGeneration' && Array.isArray(message.generatingTitleKeys)) {
				setGeneratingTitleKeys(new Set(message.generatingTitleKeys.filter((x): x is string => typeof x === 'string')));
			}
			if (typeof message.requestId === 'string') {
				const pending = pendingRequests.get(message.requestId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingRequests.delete(message.requestId);
					pending.resolve(message);
				}
			}
		};
		window.addEventListener('message', listener);
		post({ type: 'quickNotesRequestState' });
		return () => {
			window.removeEventListener('message', listener);
			for (const pending of pendingRequests.values()) {
				clearTimeout(pending.timer);
				pending.resolve(null);
			}
			pendingRequests.clear();
		};
	}, [post]);

	/** Применяет операцию сразу и снимает её, если расширение отказало или не ответило. */
	const apply = useCallback(async (operation: QuickNoteOperation): Promise<QuickNoteOperationResult> => {
		const requestId = createRequestId('qn-op');
		setPendingOperations(previous => [...previous, { requestId, operation }]);
		const response = waitForResponse(requestId, QUICK_NOTES_RESPONSE_TIMEOUT_MS);
		post({ type: 'quickNotesApply', operation, requestId });
		const message = await response;
		// Без ответа операция снимается, и виджет возвращается к подтверждённому состоянию расширения.
		setPendingOperations(previous => previous.filter(entry => entry.requestId !== requestId));
		if (!message) {
			return { ok: false, code: 'failed', message: 'Расширение не ответило. Изменение не сохранено.' };
		}
		return (message.result as QuickNoteOperationResult | undefined) ?? { ok: true };
	}, [post, waitForResponse]);

	/** Добавляет файлы в черновик; выбор в диалоге ждёт дольше обычного ответа. */
	const attach = useCallback(async (
		scope: QuickNoteScope,
		draftId: string,
		source: QuickNoteAttachSource,
	): Promise<QuickNotesAttachResult> => {
		const requestId = createRequestId('qn-attach');
		// Выбор файлов в диалоге ограничен только пользователем, поэтому ожидание длиннее обычного.
		const response = waitForResponse(requestId, source.kind === 'dialog' ? 10 * 60_000 : QUICK_NOTES_RESPONSE_TIMEOUT_MS * 3);
		post({ type: 'quickNotesAttach', scope, draftId, source, requestId });
		const message = await response;
		if (!message) {
			return { files: [], previewUris: {}, skipped: [], error: 'Расширение не ответило. Файлы не добавлены.' };
		}
		return {
			files: (message.files as QuickNoteFile[]) || [],
			previewUris: (message.previewUris as Record<string, string>) || {},
			skipped: (message.skipped as string[]) || [],
			error: typeof message.error === 'string' ? message.error : undefined,
		};
	}, [post, waitForResponse]);

	/** Создаёт промпт из заметки и ждёт результата расширения. */
	const createPrompt = useCallback(async (scope: QuickNoteScope, noteId: string): Promise<QuickNotesPromptResult> => {
		const requestId = createRequestId('qn-prompt');
		const response = waitForResponse(requestId, QUICK_NOTES_RESPONSE_TIMEOUT_MS * 3);
		post({ type: 'quickNotesCreatePrompt', scope, noteId, requestId });
		const message = await response;
		if (!message) {
			return { ok: false, message: 'Расширение не ответило. Промпт не создан.' };
		}
		return {
			ok: message.ok === true,
			promptTitle: typeof message.promptTitle === 'string' ? message.promptTitle : undefined,
			message: typeof message.message === 'string' ? message.message : undefined,
		};
	}, [post, waitForResponse]);

	/** Запрашивает AI-предложение пункта с увеличенным ожиданием ответа модели. */
	const suggest = useCallback(async (input: QuickNoteChecklistSuggestionInput): Promise<QuickNotesSuggestionResult> => {
		const requestId = createRequestId('qn-suggest');
		const response = waitForResponse(requestId, QUICK_NOTES_SUGGESTION_TIMEOUT_MS);
		post({ type: 'quickNotesSuggestItem', input, requestId });
		const message = await response;
		if (!message) {
			return { text: '', error: 'Модель не ответила вовремя. Попробуйте ещё раз.' };
		}
		return {
			text: typeof message.text === 'string' ? message.text : '',
			error: typeof message.error === 'string' ? message.error : undefined,
		};
	}, [post, waitForResponse]);


	/** Local files travel from browser to remote Ubuntu in bounded chunks. */
	const attachLocalFiles = useCallback(async (
		scope: QuickNoteScope, draftId: string, files: readonly File[],
		onProgress?: (fileName: string, percent: number) => void,
	): Promise<QuickNotesAttachResult> => {
		const accepted: QuickNoteFile[] = [];
		const previewUris: Record<string, string> = {};
		const skipped: string[] = [];
		const errors: string[] = [];
		if (files.length > QUICK_NOTE_LOCAL_FILE_MAX_COUNT) {
			return { files: [], previewUris, skipped: files.map(f => f.name),
				error: 'Можно выбрать не больше ' + QUICK_NOTE_LOCAL_FILE_MAX_COUNT + ' файлов за один раз.' };
		}
		const total = files.reduce((sum, file) => sum + file.size, 0);
		if (total > QUICK_NOTE_LOCAL_FILE_MAX_TOTAL_BYTES) {
			return { files: [], previewUris, skipped: files.map(f => f.name),
				error: 'Суммарный размер вложений за один раз не должен превышать 256 МиБ.' };
		}
		for (const file of files) {
			if (!file.size || file.size > QUICK_NOTE_LOCAL_FILE_MAX_BYTES) {
				skipped.push(file.name);
				errors.push('«' + file.name + '»: поддерживаются файлы размером от 1 байта до 64 МиБ.');
				continue;
			}
			const uploadId = createRequestId('qn-upload');
			const chunkCount = Math.ceil(file.size / QUICK_NOTE_LOCAL_FILE_CHUNK_BYTES);
			for (let index = 0; index < chunkCount; index++) {
				const start = index * QUICK_NOTE_LOCAL_FILE_CHUNK_BYTES;
				const end = Math.min(start + QUICK_NOTE_LOCAL_FILE_CHUNK_BYTES, file.size);
				try {
					const dataBase64 = await blobToBase64(file.slice(start, end));
					const requestId = createRequestId('qn-chunk');
					const response = waitForResponse(requestId, QUICK_NOTES_RESPONSE_TIMEOUT_MS * 3);
					post({
						type: 'quickNotesUploadChunk', scope, draftId, uploadId, name: file.name,
						fileSize: file.size, chunkIndex: index, chunkCount, dataBase64, requestId,
					});
					const result = await response;
					if (!result || typeof result.error === 'string') {
						throw new Error(typeof result?.error === 'string' ? result.error
							: 'Удалённый VS Code не ответил во время передачи.');
					}
					onProgress?.(file.name, Math.round((end / file.size) * 100));
					if (index === chunkCount - 1) {
						if (!result.file || typeof result.file !== 'object') {
							throw new Error('Сервер не подтвердил сохранение файла.');
						}
						const savedFile = result.file as QuickNoteFile;
						accepted.push(savedFile);
						if (typeof result.previewUri === 'string') previewUris[savedFile.id] = result.previewUri;
					}
				} catch (error) {
					skipped.push(file.name);
					errors.push('«' + file.name + '»: ' + (error instanceof Error ? error.message : String(error)));
					post({ type: 'quickNotesCancelUpload', scope, draftId, uploadId });
					break;
				}
			}
		}
		return { files: accepted, previewUris, skipped, error: errors.join(' ') || undefined };
	}, [post, waitForResponse]);

	const removeDraftFile = useCallback(async (scope: QuickNoteScope, draftId: string, storedName: string) => {
		const requestId = createRequestId('qn-remove-file');
		const response = waitForResponse(requestId, QUICK_NOTES_RESPONSE_TIMEOUT_MS * 3);
		post({ type: 'quickNotesRemoveDraftFile', scope, draftId, storedName, requestId });
		const result = await response;
		return result
			? { ok: result.ok === true, error: typeof result.error === 'string' ? result.error : undefined }
			: { ok: false, error: 'Удалённый сервер не подтвердил удаление временного файла.' };
	}, [post, waitForResponse]);

	const state = useMemo(() => resolveEffectiveQuickNotesState(hostState, pendingOperations), [hostState, pendingOperations]);

	return useMemo<QuickNotesClient>(() => ({
		state,
		generatingTitleKeys,
		descriptionHeight,
		setDescriptionHeight: height => post({ type: 'quickNotesSetDescriptionHeight', height }),
		apply,
		attach,
		attachLocalFiles,
		discardDraft: (scope, draftId) => post({ type: 'quickNotesDiscardDraft', scope, draftId }),
		removeDraftFile,
		openFile: (scope, noteId, storedName, draftId) => post({ type: 'quickNotesOpenFile', scope, noteId, storedName, draftId }),
		openStorageFile: scope => post({ type: 'quickNotesOpenStorageFile', scope }),
		createPrompt,
		openPrompt: (promptId, promptUuid) => post({ type: 'quickNotesOpenPrompt', promptId, promptUuid }),
		suggest,
		reload: () => post({ type: 'quickNotesRequestState' }),
		openBoard: () => post({ type: 'quickNotesOpenBoard' }),
	}), [state, generatingTitleKeys, descriptionHeight, apply, attach, attachLocalFiles, removeDraftFile, createPrompt, suggest, post]);
}
