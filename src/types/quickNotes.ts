/**
 * Контракты быстрых заметок: хранение в quick-notes.json, состояние для webview и операции изменения.
 * Логика нормализации и применения операций — src/utils/quickNotes.ts; тесты — tests/quickNotes.test.ts.
 */

/** Область хранения: рабочая область (первая папка) или глобальная папка пользователя. */
export type QuickNoteScope = 'workspace' | 'global';

/** Все области в порядке отображения и обхода. */
export const QUICK_NOTE_SCOPES: readonly QuickNoteScope[] = ['workspace', 'global'];

/** Имя файла заметок в корне хранилища области. */
export const QUICK_NOTES_FILE_NAME = 'quick-notes.json';

/** Папка копий вложений рядом с файлом заметок. */
export const QUICK_NOTES_FILES_DIR_NAME = 'quick-notes-files';

/** Подпапка временных копий черновиков окна заметки. */
export const QUICK_NOTES_PENDING_DIR_NAME = '.pending';

/** Размер каждого блока передачи файла из браузера через Remote Tunnel. */
export const QUICK_NOTE_LOCAL_FILE_CHUNK_BYTES = 512 * 1024;
/** Браузерный файл до 64 МиБ, одновременно выбирается не более 20 файлов и 256 МиБ суммарно. */
export const QUICK_NOTE_LOCAL_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const QUICK_NOTE_LOCAL_FILE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const QUICK_NOTE_LOCAL_FILE_MAX_COUNT = 20;

/** Текущая версия формата файла заметок. */
export const QUICK_NOTES_FILE_VERSION = 1;

/** Цвета палитры: шесть цветов темы VS Code и два собственных с вариантами для светлой и тёмной темы. */
export const QUICK_NOTE_PALETTE_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'teal'] as const;

/** Имя цвета палитры. */
export type QuickNotePaletteColor = typeof QUICK_NOTE_PALETTE_COLORS[number];

/** Пункт чек-листа заметки. */
export interface QuickNoteItem {
	id: string;
	text: string;
	done: boolean;
}

/** Копия прикреплённого файла в папке вложений заметки. */
export interface QuickNoteFile {
	id: string;
	/** Исходное имя файла для отображения. */
	name: string;
	/** Безопасное имя копии внутри папки вложений заметки. */
	storedName: string;
	/** Размер копии в байтах на момент прикрепления. */
	size: number;
	addedAt: string;
}

/** Ссылка на промпт, созданный из заметки. */
export interface QuickNotePromptLink {
	id: string;
	promptUuid: string;
}

/** Заметка в файле области; неизвестные поля сохраняются при записи. */
export interface QuickNote {
	id: string;
	title: string;
	description: string;
	/** Имя цвета палитры, `#rrggbb` или пустая строка без цвета. */
	color: string;
	done: boolean;
	/** Общая позиция в списке обеих областей; меньшее значение выше. */
	order: number;
	items: QuickNoteItem[];
	files: QuickNoteFile[];
	prompt?: QuickNotePromptLink;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

/** Содержимое quick-notes.json; неизвестные поля верхнего уровня сохраняются. */
export interface QuickNotesFileContent {
	version: number;
	notes: QuickNote[];
}

/** Заметка в состоянии webview: область и адреса превью вложений текущей панели. */
export interface QuickNoteView extends QuickNote {
	scope: QuickNoteScope;
	/** Адреса превью изображений по id файла; вычисляются расширением для конкретной панели. */
	previewUris?: Record<string, string>;
}

/** Состояние одной области для webview. */
export interface QuickNotesScopeState {
	scope: QuickNoteScope;
	/** Область недоступна, например рабочая область без открытой папки. */
	available: boolean;
	/** Абсолютный путь файла заметок области. */
	filePath: string;
	/** Ошибка чтения: повреждённый JSON не перезаписывается, область только для чтения. */
	error?: string;
}

/** Полное состояние заметок обеих областей. */
export interface QuickNotesState {
	scopes: Record<QuickNoteScope, QuickNotesScopeState>;
	notes: QuickNoteView[];
}

/** Изменяемые поля заметки для быстрых действий виджета и доски. */
export type QuickNotePatch = Partial<Pick<QuickNote, 'title' | 'description' | 'color' | 'done'>>;

/** Операции изменения заметок; одна чистая функция применяет их в webview и в расширении. */
export type QuickNoteOperation =
	/** Новая заметка целиком создаётся в webview, включая id, порядок и даты. */
	| { kind: 'create'; scope: QuickNoteScope; note: QuickNote; autoTitle?: boolean }
	/** Внутренняя условная запись AI-названия: не перезаписывает правки пользователя. */
	| { kind: 'setGeneratedTitle'; scope: QuickNoteScope; id: string; expectedTitle: string; expectedDescription: string; title: string; at: string }
	| { kind: 'update'; scope: QuickNoteScope; id: string; patch: QuickNotePatch; at: string }
	/** Явное значение отметки пункта: повтор операции не меняет результат. */
	| { kind: 'setItemDone'; scope: QuickNoteScope; id: string; itemId: string; done: boolean; at: string }
	| { kind: 'delete'; scope: QuickNoteScope; id: string }
	/** Удаляет выполненные заметки обеих областей. */
	| { kind: 'clearDone' }
	/** Задаёт позиции; при исчерпании промежутка передаёт новые позиции всех заметок обеих областей. */
	| { kind: 'setOrders'; orders: Record<string, number> }
	/** Перенос между областями с вложениями; одновременно может задать позицию и цвет. */
	| { kind: 'changeScope'; scope: QuickNoteScope; id: string; toScope: QuickNoteScope; order?: number; color?: string; at: string }
	/** Сохранение черновика окна; отклоняется, если заметка изменилась после baseUpdatedAt. */
	| {
		kind: 'replace';
		scope: QuickNoteScope;
		note: QuickNote;
		toScope: QuickNoteScope;
		baseUpdatedAt: string;
		/** Папка временных копий черновика, переносимых при сохранении. */
		draftId?: string;
		/** Запись поверх изменений другого окна после явного выбора «Перезаписать». */
		force?: boolean;
	}
	/** Ссылка на созданный промпт; выставляется расширением после создания промпта. */
	| { kind: 'setPrompt'; scope: QuickNoteScope; id: string; prompt: QuickNotePromptLink | null }
	/** Clear only the link deleted from storage, not a new link created in another window. */
	| { kind: 'clearDeletedPromptLink'; scope: QuickNoteScope; id: string; promptId: string; promptUuid?: string };

/** Причина отказа применить операцию. */
export type QuickNoteOperationErrorCode = 'conflict' | 'not-found' | 'unavailable' | 'read-only' | 'failed';

/** Результат операции для отправившей её панели. */
export interface QuickNoteOperationResult {
	ok: boolean;
	code?: QuickNoteOperationErrorCode;
	message?: string;
}

/** Источник файлов, добавляемых в черновик окна заметки. */
export type QuickNoteAttachSource =
	| { kind: 'dialog' }
	| { kind: 'clipboard' }
	| { kind: 'paths'; paths: string[] }
	| { kind: 'content'; files: Array<{ name: string; dataBase64: string }> };

/** Режим группировки доски. */
export type QuickNotesBoardGroupBy = 'none' | 'color' | 'scope';

/** Фильтр областей доски. */
export type QuickNotesBoardScopeFilter = 'all' | QuickNoteScope;

/** Контекст заметки для предложения нового пункта чек-листа; берётся из текущего черновика окна. */
export interface QuickNoteChecklistSuggestionInput {
	title: string;
	description: string;
	items: Array<{ text: string; done: boolean }>;
	fileNames: string[];
	/** Варианты, уже показанные в этом блоке, чтобы перегенерация не повторялась. */
	previousSuggestions: string[];
}
