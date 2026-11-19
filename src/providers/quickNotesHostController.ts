/**
 * Сторона расширения для быстрых заметок: сообщения webview редактора промпта и страницы доски,
 * рассылка состояния во все панели, вложения, промпт из заметки, AI-предложение и настройки вида.
 */
import * as path from 'path';
import { existsSync } from 'fs';
import * as vscode from 'vscode';
import type { AiService } from '../services/aiService.js';
import type { QuickNotesImportSource, QuickNotesService } from '../services/quickNotesService.js';
import type { StateService } from '../services/stateService.js';
import type { StorageService } from '../services/storageService.js';
import type { ExtensionToWebviewMessage, PromptOpenTarget, WebviewToExtensionMessage } from '../types/messages.js';
import type { Prompt } from '../types/prompt.js';
import {
	normalizePromptDashboardPreferences,
	normalizePromptDashboardQuickNotesWidgetState,
} from '../types/promptDashboardPreferences.js';
import {
	QUICK_NOTES_PENDING_DIR_NAME,
	type QuickNoteAttachSource,
	type QuickNoteOperation,
	type QuickNoteScope,
	type QuickNotesState,
} from '../types/quickNotes.js';
import { extractContextFilePathsFromClipboardText, getContextFileKind } from '../utils/contextFiles.js';
import { appendPromptManagerLog } from '../utils/promptManagerOutput.js';
import {
	buildQuickNotePromptContent,
	isSafeQuickNoteDirectoryId,
	isSafeQuickNoteStoredName,
	parseQuickNoteWebviewOperation,
	normalizeQuickNoteAiTitle,
} from '../utils/quickNotes.js';

/** Сообщения webview о быстрых заметках, которые обрабатывает контроллер. */
export type QuickNotesWebviewMessage = Extract<WebviewToExtensionMessage, { type:
	| 'quickNotesRequestState' | 'quickNotesApply' | 'quickNotesAttach' | 'quickNotesUploadChunk' | 'quickNotesCancelUpload' | 'quickNotesDiscardDraft' | 'quickNotesRemoveDraftFile' | 'quickNotesOpenFile'
	| 'quickNotesOpenStorageFile' | 'quickNotesCreatePrompt' | 'quickNotesOpenPrompt' | 'quickNotesSuggestItem'
	| 'quickNotesOpenBoard' | 'quickNotesRequestPreferences' | 'quickNotesSavePreferences' | 'quickNotesSetDescriptionHeight' }>;

/** Типы сообщений контроллера для маршрутизации в менеджерах панелей. */
export const QUICK_NOTES_WEBVIEW_MESSAGE_TYPES: ReadonlySet<string> = new Set<QuickNotesWebviewMessage['type']>([
	'quickNotesRequestState', 'quickNotesApply', 'quickNotesAttach', 'quickNotesUploadChunk', 'quickNotesCancelUpload', 'quickNotesDiscardDraft', 'quickNotesRemoveDraftFile', 'quickNotesOpenFile',
	'quickNotesOpenStorageFile', 'quickNotesCreatePrompt', 'quickNotesOpenPrompt', 'quickNotesSuggestItem',
	'quickNotesOpenBoard', 'quickNotesRequestPreferences', 'quickNotesSavePreferences', 'quickNotesSetDescriptionHeight',
]);

/** Проверяет, что сообщение относится к быстрым заметкам. */
export function isQuickNotesWebviewMessage(message: WebviewToExtensionMessage): message is QuickNotesWebviewMessage {
	return QUICK_NOTES_WEBVIEW_MESSAGE_TYPES.has(message.type);
}

/** Канал одной панели: webview для адресов превью и отправка сообщений. */
export interface QuickNotesChannel {
	webview: vscode.Webview;
	post(message: ExtensionToWebviewMessage): Promise<void>;
}

/** Зависимости контроллера; создание и открытие промпта выполняет менеджер редактора. */
export interface QuickNotesHostControllerDeps {
	service: QuickNotesService;
	aiService: Pick<AiService, 'suggestQuickNoteChecklistItem' | 'generateQuickNoteTitle'>;
	/** Поиск промпта ссылки заметки; getPrompt сверяет UUID папки, найденной только по id. */
	storageService: Pick<StorageService, 'listPrompts' | 'exists' | 'getPrompt'>;
	stateService: Pick<StateService, 'getPromptDashboardPreferences' | 'savePromptDashboardPreferences' | 'waitForPromptDashboardSaves'>;
	/** Открытые панели с виджетом или доской заметок. */
	getChannels(): QuickNotesChannel[];
	createPrompt(content: string, options: { title: string; attachments: Array<{ path: string; name: string }> }): Promise<Prompt | null>;
	openPrompt(target: PromptOpenTarget): Promise<void>;
	openBoard(): Promise<void>;
	/** Разрешает путь из буфера или перетаскивания так же, как для файлов контекста промпта. */
	resolveFileReference(reference: string): vscode.Uri | null;
}

/** Контроллер быстрых заметок для всех панелей; освобождается вместе с расширением. */
export class QuickNotesHostController implements vscode.Disposable {
	private readonly disposables: Array<{ dispose(): void }> = [];
	/** Заметки, из которых сейчас создаётся промпт: повторное нажатие на доске и в редакторе не создаёт второй. */
	private readonly creatingPrompts = new Set<string>();
	/** AI-названия запускаются после сохранения и не задерживают добавление заметок. */
	private titleGenerationQueue: Promise<void> = Promise.resolve();
	private readonly generatingTitles = new Set<string>();
	private disposed = false;

	/** Подписывается на внешние изменения файлов и настроек вида. */
	constructor(private readonly deps: QuickNotesHostControllerDeps) {
		this.disposables.push(
			deps.service.onDidChange(() => {
				void this.broadcastState();
			}),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('promptManager.dashboardPreferences.quickNotes')) {
					void this.broadcastPreferences();
				}
			}),
		);
	}

	/**
	 * Обновляет только ещё не изменённое пользователем исходное название.
	 * Условная запись выполняется внутри очереди сохранения quick-notes.json.
	 */
	private scheduleGeneratedTitle(operation: Extract<QuickNoteOperation, { kind: 'create' }>): void {
		const key = `${operation.scope}:${operation.note.id}`;
		if (this.generatingTitles.has(key)) return;
		this.generatingTitles.add(key);
		void this.broadcastTitleGeneration();
		this.titleGenerationQueue = this.titleGenerationQueue.then(async () => {
			if (this.disposed) return;
			const original = operation.note;
			const state = await this.deps.service.getState();
			const current = state.notes.find(note => note.scope === operation.scope && note.id === original.id);
			if (!current || current.title !== original.title || current.description !== original.description) return;
			const suggested = normalizeQuickNoteAiTitle(await this.deps.aiService.generateQuickNoteTitle(original.description));
			if (!suggested || suggested === original.title || this.disposed) return;
			const { result, state: updatedState } = await this.deps.service.applyOperation({
				kind: 'setGeneratedTitle',
				scope: operation.scope,
				id: original.id,
				expectedTitle: original.title,
				expectedDescription: original.description,
				title: suggested,
				at: new Date().toISOString(),
			});
			if (!result.ok) {
				appendPromptManagerLog(`[quick-notes] Не удалось сохранить AI-название: ${result.code || 'failed'}`);
				return;
			}
			await this.broadcastState(updatedState);
		}).catch(error => {
			appendPromptManagerLog(`[quick-notes] Не удалось сгенерировать название: ${error instanceof Error ? error.message : String(error)}`);
		}).finally(() => {
			this.generatingTitles.delete(key);
			void this.broadcastTitleGeneration();
		});
	}

	/** Посылает во все открытые панели точный список заметок, для которых AI ещё работает. */
	private async broadcastTitleGeneration(): Promise<void> {
		const generatingTitleKeys = [...this.generatingTitles];
		await Promise.all(this.deps.getChannels().map(channel => channel.post({
			type: 'quickNotesTitleGeneration', generatingTitleKeys,
		})));
	}

	/** Папка вложений глобальной области для корней ресурсов webview. */
	getGlobalFilesRoot(): string | null {
		return this.deps.service.getFilesRoot('global');
	}

	/** Корни ресурсов webview: папки вложений обеих областей. */
	getFilesRoots(): string[] {
		return (['workspace', 'global'] as const)
			.map(scope => this.deps.service.getFilesRoot(scope))
			.filter((root): root is string => Boolean(root));
	}

	/** Отправляет каналу полное состояние заметок; requestId и result подтверждают его операцию. */
	async postState(
		channel: QuickNotesChannel,
		extra: Pick<Extract<ExtensionToWebviewMessage, { type: 'quickNotesState' }>, 'requestId' | 'result'> = {},
		knownState?: QuickNotesState,
	): Promise<void> {
		const state = knownState ?? await this.deps.service.getState();
		await channel.post({
			type: 'quickNotesState',
			state: this.decorateState(state, channel.webview),
			generatingTitleKeys: [...this.generatingTitles],
			descriptionHeight: this.readPreferences().descriptionHeight,
			...extra,
		});
	}

	/** Рассылает состояние всем открытым панелям, кроме получившей адресный ответ. */
	async broadcastState(knownState?: QuickNotesState, except?: QuickNotesChannel): Promise<void> {
		const channels = this.deps.getChannels().filter(channel => channel.webview !== except?.webview);
		if (channels.length === 0) {
			return;
		}
		const state = knownState ?? await this.deps.service.getState();
		await Promise.all(channels.map(channel => this.postState(channel, {}, state)));
	}

	/** Рассылает настройки вида заметок, например после изменения в другом окне или на другой странице. */
	async broadcastPreferences(): Promise<void> {
		// Событие конфигурации приходит до конца собственной записи, а сервис до её завершения отдаёт прежнее
		// подтверждённое значение: без ожидания доска получила бы старые настройки и откатила выбор.
		await this.deps.stateService.waitForPromptDashboardSaves();
		const state = this.readPreferences();
		await Promise.all(this.deps.getChannels().map(channel => channel.post({ type: 'quickNotesPreferences', state })));
	}

	/** Обрабатывает сообщение заметок от панели; ошибки сообщаются пользователю и не прерывают работу панели. */
	async handleMessage(msg: QuickNotesWebviewMessage, channel: QuickNotesChannel): Promise<void> {
		try {
			await this.dispatch(msg, channel);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			appendPromptManagerLog(`[quick-notes] ${msg.type} failed: ${message}`);
			void vscode.window.showErrorMessage(`Быстрые заметки: ${message}`);
		}
	}

	/** Снимает подписки контроллера. */
	dispose(): void {
		this.disposed = true;
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
	}

	/** Маршрутизирует сообщение по типу. */
	private async dispatch(msg: QuickNotesWebviewMessage, channel: QuickNotesChannel): Promise<void> {
		const service = this.deps.service;
		switch (msg.type) {
			case 'quickNotesRequestState':
				await this.postState(channel, { requestId: msg.requestId });
				return;
			case 'quickNotesApply': {
				// Форма операции проверяется здесь: неверное значение области или полей не должно удалять заметки.
				const operation = parseQuickNoteWebviewOperation(msg.operation);
				if (!operation) {
					await this.postState(channel, {
						requestId: msg.requestId,
						result: { ok: false, code: 'failed', message: 'Некорректная операция заметок: изменение не применено.' },
					});
					return;
				}
				const { result, state } = await service.applyOperation(operation);
				await this.postState(channel, { requestId: msg.requestId, result }, state);
				await this.broadcastState(state, channel);
				if (result.ok && operation.kind === 'create' && operation.autoTitle === true) {
					this.scheduleGeneratedTitle(operation);
				}
				return;
			}
			case 'quickNotesAttach':
				await this.handleAttach(msg, channel);
				return;
			case 'quickNotesUploadChunk':
				await this.handleBrowserUpload(msg, channel);
				return;
			case 'quickNotesCancelUpload':
				await service.cancelBrowserUpload(msg.scope, msg.draftId, msg.uploadId);
				return;
			case 'quickNotesDiscardDraft':
				await service.discardDraft(msg.scope, msg.draftId);
				return;
			case 'quickNotesRemoveDraftFile': {
				let error: string | undefined;
				try {
					await service.removeDraftFile(msg.scope, msg.draftId, msg.storedName);
				} catch (reason) {
					error = reason instanceof Error ? reason.message : String(reason);
				}
				await channel.post({
					type: 'quickNotesDraftFileRemoved', requestId: msg.requestId, ok: !error,
					...(error ? { error } : {}),
				});
				return;
			}
			case 'quickNotesOpenFile': {
				const filePath = await service.resolveFilePath({
					scope: msg.scope, noteId: msg.noteId, storedName: msg.storedName, draftId: msg.draftId,
				});
				if (!filePath) {
					void vscode.window.showWarningMessage('Файл заметки не найден.');
					return;
				}
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), {
					viewColumn: vscode.ViewColumn.Beside, preview: false, preserveFocus: false,
				});
				return;
			}
			case 'quickNotesOpenStorageFile': {
				const state = await service.getState();
				const filePath = state.scopes[msg.scope as QuickNoteScope]?.filePath;
				if (!filePath || !existsSync(filePath)) {
					void vscode.window.showWarningMessage('Файл быстрых заметок ещё не создан.');
					return;
				}
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), { preview: false });
				return;
			}
			case 'quickNotesCreatePrompt':
				await this.handleCreatePrompt(msg, channel);
				return;
			case 'quickNotesOpenPrompt':
				await this.handleOpenPrompt(msg);
				return;
			case 'quickNotesSuggestItem': {
				let text = '';
				let error: string | undefined;
				try {
					text = await this.deps.aiService.suggestQuickNoteChecklistItem(msg.input);
				} catch (suggestError) {
					error = `Не удалось получить предложение: ${suggestError instanceof Error ? suggestError.message : String(suggestError)}`;
				}
				await channel.post({
					type: 'quickNotesSuggestion',
					requestId: msg.requestId,
					text,
					error: text ? undefined
						: error || 'AI не предложил новый пункт: модель недоступна, внутренний AI выключен или ответ повторяет пункты.',
				});
				return;
			}
			case 'quickNotesOpenBoard':
				await this.deps.openBoard();
				return;
			case 'quickNotesSetDescriptionHeight': {
				if (!Number.isFinite(msg.height) || msg.height < 84 || msg.height > 1000) return;
				const current = this.deps.stateService.getPromptDashboardPreferences()
					?? normalizePromptDashboardPreferences(undefined);
				const next = { ...current, quickNotes: { ...current.quickNotes, descriptionHeight: Math.round(msg.height) } };
				if (next.quickNotes.descriptionHeight === current.quickNotes.descriptionHeight) return;
				await this.deps.stateService.savePromptDashboardPreferences(next, current);
				await this.broadcastPreferences();
				return;
			}
			case 'quickNotesRequestPreferences':
				await channel.post({ type: 'quickNotesPreferences', state: this.readPreferences() });
				return;
			case 'quickNotesSavePreferences': {
				// Записываются только изменённые поля вида заметок: остальные настройки панели не затрагиваются.
				const current = this.deps.stateService.getPromptDashboardPreferences() ?? normalizePromptDashboardPreferences(undefined);
				const next = { ...current, quickNotes: normalizePromptDashboardQuickNotesWidgetState(msg.state) };
				const base = msg.baseState
					? { ...current, quickNotes: normalizePromptDashboardQuickNotesWidgetState(msg.baseState) }
					: current;
				await this.deps.stateService.savePromptDashboardPreferences(next, base);
				return;
			}
			default:
				return;
		}
	}

	/** Текущие настройки вида заметок из application-настроек. */
	private readPreferences() {
		return (this.deps.stateService.getPromptDashboardPreferences() ?? normalizePromptDashboardPreferences(undefined)).quickNotes;
	}

	/** Добавляет адреса превью изображений заметок для конкретной панели. */
	private decorateState(state: QuickNotesState, webview: vscode.Webview): QuickNotesState {
		return {
			...state,
			notes: state.notes.map(note => {
				const filesRoot = this.deps.service.getFilesRoot(note.scope);
				if (!filesRoot || note.files.length === 0 || !isSafeQuickNoteDirectoryId(note.id)) {
					return note;
				}
				const previewUris: Record<string, string> = {};
				for (const file of note.files) {
					if (getContextFileKind(file.storedName) === 'image' && isSafeQuickNoteStoredName(file.storedName)) {
						previewUris[file.id] = webview.asWebviewUri(vscode.Uri.file(path.join(filesRoot, note.id, file.storedName))).toString();
					}
				}
				return Object.keys(previewUris).length > 0 ? { ...note, previewUris } : note;
			}),
		};
	}

	/** Источники файлов черновика; null означает отменённый выбор в диалоге. */
	private async resolveAttachSources(source: QuickNoteAttachSource): Promise<QuickNotesImportSource[] | null> {
		switch (source.kind) {
			case 'dialog': {
				const uris = await vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: true,
					openLabel: 'Прикрепить к заметке',
				});
				return uris ? uris.map(uri => ({ path: uri.fsPath })) : null;
			}
			case 'clipboard': {
				const text = await vscode.env.clipboard.readText();
				return extractContextFilePathsFromClipboardText(text)
					.map(reference => this.deps.resolveFileReference(reference)?.fsPath)
					.filter((filePath): filePath is string => Boolean(filePath))
					.map(filePath => ({ path: filePath }));
			}
			case 'paths':
				// Проводник VS Code передаёт URI ресурса, файловый менеджер — file:// или обычный путь.
				return (source.paths || [])
					.map(value => /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
						? vscode.Uri.parse(value).fsPath
						: this.deps.resolveFileReference(value)?.fsPath)
					.filter((filePath): filePath is string => Boolean(filePath))
					.map(filePath => ({ path: filePath }));
			case 'content':
				return (source.files || [])
					.map(file => ({ name: String(file.name || ''), data: Buffer.from(String(file.dataBase64 || ''), 'base64') }))
					.filter(file => file.data.byteLength > 0);
			default:
				return [];
		}
	}

	/** Передаёт один блок локального файла браузера в Ubuntu без потери файла и без чтения произвольных путей ПК. */
	private async handleBrowserUpload(
		msg: Extract<QuickNotesWebviewMessage, { type: 'quickNotesUploadChunk' }>,
		channel: QuickNotesChannel,
	): Promise<void> {
		try {
			const file = await this.deps.service.importBrowserChunk(msg);
			const root = file && this.deps.service.getFilesRoot(msg.scope);
			const previewUri = file && root && getContextFileKind(file.storedName) === 'image'
				? channel.webview.asWebviewUri(vscode.Uri.file(
					path.join(root, QUICK_NOTES_PENDING_DIR_NAME, msg.draftId, file.storedName),
				)).toString()
				: undefined;
			await channel.post({
				type: 'quickNotesUploadResult', requestId: msg.requestId, draftId: msg.draftId,
				...(file ? { file } : {}), ...(previewUri ? { previewUri } : {}),
			});
		} catch (error) {
			await channel.post({
				type: 'quickNotesUploadResult', requestId: msg.requestId, draftId: msg.draftId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Копирует выбранные, вставленные или перетащенные файлы в папку черновика и возвращает адреса превью. */
	private async handleAttach(
		msg: Extract<QuickNotesWebviewMessage, { type: 'quickNotesAttach' }>,
		channel: QuickNotesChannel,
	): Promise<void> {
		const empty = { type: 'quickNotesAttached' as const, requestId: msg.requestId, draftId: msg.draftId, files: [], previewUris: {}, skipped: [] };
		try {
			const sources = await this.resolveAttachSources(msg.source);
			if (sources === null || sources.length === 0) {
				await channel.post({
					...empty,
					error: sources === null ? undefined : msg.source.kind === 'clipboard'
						? 'В буфере обмена нет изображений или путей к существующим файлам.'
						: 'Не найдено файлов для добавления.',
				});
				return;
			}
			const { files, skipped } = await this.deps.service.importFiles({ scope: msg.scope, draftId: msg.draftId, sources });
			const filesRoot = this.deps.service.getFilesRoot(msg.scope);
			const previewUris: Record<string, string> = {};
			for (const file of files) {
				if (filesRoot && getContextFileKind(file.storedName) === 'image') {
					previewUris[file.id] = channel.webview.asWebviewUri(vscode.Uri.file(
						path.join(filesRoot, QUICK_NOTES_PENDING_DIR_NAME, msg.draftId, file.storedName),
					)).toString();
				}
			}
			await channel.post({ ...empty, files, previewUris, skipped });
		} catch (error) {
			await channel.post({ ...empty, error: `Не удалось добавить файлы: ${error instanceof Error ? error.message : String(error)}` });
		}
	}

	/** Создаёт промпт-черновик из сохранённой заметки и привязывает его; неудачная привязка сообщается явно. */
	private async handleCreatePrompt(
		msg: Extract<QuickNotesWebviewMessage, { type: 'quickNotesCreatePrompt' }>,
		channel: QuickNotesChannel,
	): Promise<void> {
		const service = this.deps.service;
		const key = `${msg.scope}:${msg.noteId}`;
		if (this.creatingPrompts.has(key)) {
			await channel.post({
				type: 'quickNotesPromptCreated', requestId: msg.requestId, ok: false, message: 'Промпт из этой заметки уже создаётся.',
			});
			return;
		}
		this.creatingPrompts.add(key);
		try {
			const state = await service.getState();
			const note = state.notes.find(entry => entry.scope === msg.scope && entry.id === msg.noteId);
			if (!note) {
				await channel.post({ type: 'quickNotesPromptCreated', requestId: msg.requestId, ok: false, message: 'Заметка не найдена.' });
				return;
			}
			// Правило «повторное создание не выполняется» соблюдается и здесь, а не только кнопкой окна.
			if (note.prompt) {
				await channel.post({
					type: 'quickNotesPromptCreated', requestId: msg.requestId, ok: false,
					message: 'Из этой заметки уже создан промпт: откройте его по ссылке.',
				});
				return;
			}
			const attachments: Array<{ path: string; name: string }> = [];
			for (const file of note.files) {
				const filePath = await service.resolveFilePath({ scope: note.scope, noteId: note.id, storedName: file.storedName });
				if (filePath) {
					attachments.push({ path: filePath, name: file.name });
				}
			}
			const saved = await this.deps.createPrompt(buildQuickNotePromptContent(note), { title: note.title, attachments });
			if (!saved) {
				await channel.post({
					type: 'quickNotesPromptCreated', requestId: msg.requestId, ok: false, message: 'Не удалось создать промпт: заметка пустая.',
				});
				return;
			}
			const { result, state: nextState } = await service.applyOperation({
				kind: 'setPrompt', scope: note.scope, id: note.id, prompt: { id: saved.id, promptUuid: saved.promptUuid },
			});
			await this.broadcastState(nextState);
			await channel.post(result.ok
				? { type: 'quickNotesPromptCreated', requestId: msg.requestId, ok: true, promptTitle: saved.title }
				: {
					type: 'quickNotesPromptCreated', requestId: msg.requestId, ok: false,
					message: `Промпт «${saved.title}» создан, но ссылку в заметке сохранить не удалось: ${result.message || 'ошибка записи'}.`,
				});
		} catch (error) {
			await channel.post({
				type: 'quickNotesPromptCreated', requestId: msg.requestId, ok: false,
				message: `Не удалось создать промпт: ${error instanceof Error ? error.message : String(error)}`,
			});
		} finally {
			this.creatingPrompts.delete(key);
		}
	}

	/** Связанный промпт удалён: снимаем ссылку сразу и во всех открытых панелях. */
	async handleDeletedPrompt(info: { id: string; promptUuid?: string }): Promise<void> {
		const state = await this.deps.service.getState();
		let changed = false;
		for (const note of state.notes) {
			const link = note.prompt;
			if (!link || link.id !== info.id
				|| (info.promptUuid && link.promptUuid && link.promptUuid !== info.promptUuid)) continue;
			const { result } = await this.deps.service.applyOperation({
				kind: 'clearDeletedPromptLink', scope: note.scope, id: note.id,
				promptId: info.id, promptUuid: info.promptUuid,
			});
			if (!result.ok) {
				appendPromptManagerLog('[quick-notes] Не удалось снять ссылку на удалённый промпт: ' + (result.message || result.code));
			} else {
				changed = true;
			}
		}
		if (changed) await this.broadcastState();
	}

	/**
	 * Открывает связанный промпт, включая архивный. Промпт с тем же id, но другим UUID — чужой и целью не считается.
	 * Глобальные заметки видны во всех рабочих областях, а промпты хранятся в текущей: у них ссылка не снимается.
	 * У заметок проекта ссылка снимается условно, только если она не изменилась.
	 * Тесты — tests/quickNotesHostController.test.ts.
	 */
	private async handleOpenPrompt(msg: Extract<QuickNotesWebviewMessage, { type: 'quickNotesOpenPrompt' }>): Promise<void> {
		const storage = this.deps.storageService;
		// Сначала кеш списка; перечитывание папок нужно, если промпт создан или переименован в другом окне.
		const findTarget = (prompts: Awaited<ReturnType<StorageService['listPrompts']>>) =>
			prompts.find(prompt => msg.promptUuid && prompt.promptUuid === msg.promptUuid)
			?? prompts.find(prompt => prompt.id === msg.promptId
				&& !hasDifferentPromptUuid(prompt.promptUuid, msg.promptUuid));
		const target = findTarget(await storage.listPrompts({ includeArchived: true }))
			?? findTarget(await storage.listPrompts({ includeArchived: true, forceRefresh: true }));
		if (target) {
			await this.deps.openPrompt({ id: target.id, promptUuid: target.promptUuid });
			return;
		}
		// Папка с тем же id сверяется по UUID; нечитаемая конфигурация не опровергает ссылку и открывается как раньше.
		if (msg.promptId && await storage.exists(msg.promptId)) {
			const existing = msg.promptUuid ? await storage.getPrompt(msg.promptId) : null;
			if (!hasDifferentPromptUuid(existing?.promptUuid, msg.promptUuid)) {
				await this.deps.openPrompt({ id: msg.promptId, promptUuid: msg.promptUuid });
				return;
			}
		}
		const state = await this.deps.service.getState();
		const linked = state.notes.filter(note => note.prompt && (
			(msg.promptUuid && note.prompt.promptUuid === msg.promptUuid)
			|| (note.prompt.id === msg.promptId && !hasDifferentPromptUuid(note.prompt.promptUuid, msg.promptUuid))));
		let cleared = 0;
		let keptGlobal = 0;
		for (const note of linked) {
			if (note.scope === 'global') {
				keptGlobal += 1;
				continue;
			}
			const link = note.prompt!;
			const { result } = await this.deps.service.applyOperation({
				kind: 'clearDeletedPromptLink', scope: note.scope, id: note.id,
				promptId: link.id, promptUuid: link.promptUuid || undefined,
			});
			if (result.ok) {
				cleared += 1;
			} else {
				appendPromptManagerLog('[quick-notes] Не удалось снять ссылку на ненайденный промпт: '
					+ (result.message || result.code));
			}
		}
		if (cleared > 0) {
			await this.broadcastState();
		}
		void vscode.window.showInformationMessage(keptGlobal > 0
			? 'Связанный промпт не найден в этой рабочей области: возможно, он создан в другой. '
				+ 'Ссылка в глобальной заметке сохранена.' + (cleared > 0 ? ' У заметки проекта ссылка снята.' : '')
			: cleared > 0 ? 'Связанный промпт не найден: ссылка снята с заметки.' : 'Связанный промпт не найден.');
	}
}

/**
 * Оба UUID известны и различаются: совпадение только по id означает другой промпт с тем же именем папки,
 * например созданный в другой рабочей области. Отсутствующий UUID с любой стороны совпадению не мешает.
 */
function hasDifferentPromptUuid(left: string | undefined, right: string | undefined): boolean {
	const leftUuid = (left || '').trim();
	const rightUuid = (right || '').trim();
	return Boolean(leftUuid && rightUuid && leftUuid !== rightUuid);
}
