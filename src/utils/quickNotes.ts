/**
 * Чистая логика быстрых заметок без Node и VS Code API: используется webview и расширением.
 * Тесты — tests/quickNotes.test.ts.
 */
import {
	QUICK_NOTE_PALETTE_COLORS,
	QUICK_NOTES_FILE_VERSION,
	type QuickNote,
	type QuickNoteFile,
	type QuickNoteItem,
	type QuickNoteOperation,
	type QuickNoteOperationResult,
	type QuickNotePatch,
	type QuickNotePromptLink,
	type QuickNoteScope,
	type QuickNotesBoardGroupBy,
	type QuickNotesBoardScopeFilter,
	type QuickNotesFileContent,
	type QuickNoteView,
} from '../types/quickNotes.js';

/** Шаг позиций при пересчёте: оставляет место для многих вставок между соседями. */
export const QUICK_NOTE_ORDER_STEP = 1024;

/** Минимальный промежуток позиций, при котором вставка между соседями ещё различима. */
const QUICK_NOTE_ORDER_EPSILON = 1e-6;

/** Длинная первая строка — это текст заметки, а не осмысленное название. */
export const QUICK_NOTE_LONG_TITLE_THRESHOLD = 100;
const QUICK_NOTE_PREVIEW_TITLE_LIMIT = 72;

/** Короткий читаемый заголовок на случай недоступности AI. Полный текст всегда остаётся в описании. */
function previewQuickNoteTitle(text: string): string {
	const first = text.replace(/\s+/g, ' ').trim();
	if (first.length <= QUICK_NOTE_PREVIEW_TITLE_LIMIT) {
		return first;
	}
	const segment = first.slice(0, QUICK_NOTE_PREVIEW_TITLE_LIMIT);
	const lastSpace = segment.lastIndexOf(' ');
	return (lastSpace >= 24 ? segment.slice(0, lastSpace) : segment).trimEnd() + '…';
}

/** Единственное правило для виджета и доски: длинную первую строку переносим целиком в описание. */
export function prepareQuickNoteCreationInput(
	title: string,
	description = '',
): { title: string; description: string; autoTitle?: boolean } {
	const normalizedTitle = title.replace(/\r\n?/g, '\n').trim();
	const normalizedDescription = description.replace(/\r\n?/g, '\n').trim();
	const [first = '', ...otherLines] = normalizedTitle.split('\n');
	const firstLine = first.trim();
	if (firstLine.length >= QUICK_NOTE_LONG_TITLE_THRESHOLD) {
		return {
			title: previewQuickNoteTitle(firstLine),
			description: [normalizedTitle, normalizedDescription].filter(Boolean).join('\n').trim(),
			autoTitle: true,
		};
	}
	return {
		title: firstLine,
		description: [...otherLines, normalizedDescription].filter(Boolean).join('\n').trim(),
	};
}

/** Нормализуем потенциально многострочный или оформленный ответ модели в краткое название. */
export function normalizeQuickNoteAiTitle(raw: string): string {
	const singleLine = (raw || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
	const title = singleLine.replace(/^(?:#{1,6}\s*|[-*]\s+|\d+[.)]\s+)/, '')
		.replace(/^[«“"'\s]+|[»”"'\s]+$/g, '').replace(/\s+/g, ' ').trim();
	return title ? previewQuickNoteTitle(title) : '';
}

/** Ключ фильтра для заметок без цвета. */
export const QUICK_NOTE_NO_COLOR_KEY = 'none';

/** Проверяет значение области хранения. */
export function isQuickNoteScope(value: unknown): value is QuickNoteScope {
	return value === 'workspace' || value === 'global';
}

/** Оставляет имя палитры или `#rrggbb`; иное значение не попадает в CSS и сохраняется как отсутствие цвета. */
export function normalizeQuickNoteColor(value: unknown): string {
	if (typeof value !== 'string') {
		return '';
	}
	const trimmed = value.trim().toLowerCase();
	if ((QUICK_NOTE_PALETTE_COLORS as readonly string[]).includes(trimmed)) {
		return trimmed;
	}
	return /^#[0-9a-f]{6}$/.test(trimmed) ? trimmed : '';
}

/** Возвращает ключ цвета для фильтров и групп: имя палитры, `#rrggbb` или `none`. */
export function getQuickNoteColorKey(note: Pick<QuickNote, 'color'>): string {
	return normalizeQuickNoteColor(note.color) || QUICK_NOTE_NO_COLOR_KEY;
}

/** Копирует собственные поля объекта, чтобы сохранить неизвестные поля при записи. */
function copyRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/** Возвращает строку или значение по умолчанию. */
function readString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

/** Нормализует пункт чек-листа; пункт без id получает устойчивый id по позиции. */
function normalizeQuickNoteItem(raw: unknown, index: number): QuickNoteItem | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}
	const source = copyRecord(raw);
	return {
		...source,
		id: readString(source.id).trim() || `item-${index + 1}`,
		text: readString(source.text),
		done: source.done === true,
	} as QuickNoteItem;
}

/** Нормализует запись о копии файла; запись без имени копии не может быть открыта и отбрасывается. */
function normalizeQuickNoteFile(raw: unknown, index: number): QuickNoteFile | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}
	const source = copyRecord(raw);
	const storedName = readString(source.storedName).trim();
	if (!storedName) {
		return null;
	}
	const size = typeof source.size === 'number' && Number.isFinite(source.size) && source.size >= 0 ? source.size : 0;
	return {
		...source,
		id: readString(source.id).trim() || `file-${index + 1}`,
		name: readString(source.name).trim() || storedName,
		storedName,
		size,
		addedAt: readString(source.addedAt),
	} as QuickNoteFile;
}

/** Нормализует ссылку на промпт; неполная ссылка отбрасывается. */
function normalizeQuickNotePromptLink(raw: unknown): QuickNotePromptLink | undefined {
	const source = copyRecord(raw);
	const id = readString(source.id).trim();
	const promptUuid = readString(source.promptUuid).trim();
	return id ? { ...source, id, promptUuid } as QuickNotePromptLink : undefined;
}

/** Убирает дубликаты id внутри списка, добавляя суффикс к повтору. */
function dedupeIds<T extends { id: string }>(entries: T[]): T[] {
	const seen = new Set<string>();
	return entries.map(entry => {
		let id = entry.id;
		let suffix = 2;
		while (seen.has(id)) {
			id = `${entry.id}-${suffix}`;
			suffix += 1;
		}
		seen.add(id);
		return id === entry.id ? entry : { ...entry, id };
	});
}

/** Нормализует заметку, сохраняя неизвестные поля; служебные поля представления не записываются. */
export function normalizeQuickNote(raw: unknown, index = 0): QuickNote | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}
	const source = copyRecord(raw);
	delete source.scope;
	delete source.previewUris;
	const items = (Array.isArray(source.items) ? source.items : [])
		.map((item, itemIndex) => normalizeQuickNoteItem(item, itemIndex))
		.filter((item): item is QuickNoteItem => item !== null);
	const files = (Array.isArray(source.files) ? source.files : [])
		.map((file, fileIndex) => normalizeQuickNoteFile(file, fileIndex))
		.filter((file): file is QuickNoteFile => file !== null);
	const prompt = normalizeQuickNotePromptLink(source.prompt);
	const done = source.done === true;
	const completedAt = readString(source.completedAt);
	const note: Record<string, unknown> = {
		...source,
		id: readString(source.id).trim() || `note-${index + 1}`,
		title: readString(source.title),
		description: readString(source.description),
		color: normalizeQuickNoteColor(source.color),
		done,
		order: typeof source.order === 'number' && Number.isFinite(source.order) ? source.order : index * QUICK_NOTE_ORDER_STEP,
		items: dedupeIds(items),
		files: dedupeIds(files),
		createdAt: readString(source.createdAt),
		updatedAt: readString(source.updatedAt),
	};
	if (prompt) {
		note.prompt = prompt;
	} else {
		delete note.prompt;
	}
	if (done && completedAt) {
		note.completedAt = completedAt;
	} else {
		delete note.completedAt;
	}
	return note as unknown as QuickNote;
}

/** Нормализует содержимое quick-notes.json; отсутствующий файл равен пустому списку. */
export function normalizeQuickNotesFile(raw: unknown): QuickNotesFileContent {
	const source = copyRecord(raw);
	const notes = (Array.isArray(source.notes) ? source.notes : [])
		.map((note, index) => normalizeQuickNote(note, index))
		.filter((note): note is QuickNote => note !== null);
	return { ...source, version: QUICK_NOTES_FILE_VERSION, notes: dedupeIds(notes) } as QuickNotesFileContent;
}

/** Сериализует файл в читаемом виде: отступ 2 и перевод строки в конце. */
export function serializeQuickNotesFile(content: QuickNotesFileContent): string {
	return `${JSON.stringify(content, null, 2)}\n`;
}

/** Убирает служебные поля представления перед записью заметки в файл. */
export function toStoredQuickNote(note: QuickNote | QuickNoteView): QuickNote {
	const { scope: _scope, previewUris: _previewUris, ...stored } = note as QuickNoteView;
	return stored as QuickNote;
}

/** Создаёт уникальный идентификатор; в webview и Node 19+ используется crypto.randomUUID. */
export function createQuickNoteId(): string {
	const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (cryptoApi?.randomUUID) {
		return cryptoApi.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Сравнивает открытые заметки по позиции, затем по дате создания и id для устойчивого порядка. */
function compareQuickNotesByOrder(left: QuickNote, right: QuickNote): number {
	return left.order - right.order
		|| left.createdAt.localeCompare(right.createdAt)
		|| left.id.localeCompare(right.id);
}

/** Сравнивает выполненные заметки: недавно выполненные выше. */
function compareQuickNotesByCompletion(left: QuickNote, right: QuickNote): number {
	return (right.completedAt || right.updatedAt).localeCompare(left.completedAt || left.updatedAt)
		|| compareQuickNotesByOrder(left, right);
}

/** Делит заметки на открытые по общему порядку и выполненные по дате выполнения. */
export function splitQuickNotes<T extends QuickNote>(notes: readonly T[]): { open: T[]; done: T[] } {
	return {
		open: notes.filter(note => !note.done).sort(compareQuickNotesByOrder),
		done: notes.filter(note => note.done).sort(compareQuickNotesByCompletion),
	};
}

/** Позиция новой заметки в начале списка. */
export function resolveQuickNoteTopOrder(notes: readonly QuickNote[]): number {
	if (notes.length === 0) {
		return 0;
	}
	return Math.min(...notes.map(note => note.order)) - QUICK_NOTE_ORDER_STEP;
}

/** Позиция между соседями; null означает исчерпание промежутка и необходимость пересчёта. */
export function resolveQuickNoteOrderBetween(previous?: number, next?: number): number | null {
	if (previous === undefined && next === undefined) {
		return 0;
	}
	if (previous === undefined) {
		return (next as number) - QUICK_NOTE_ORDER_STEP;
	}
	if (next === undefined) {
		return previous + QUICK_NOTE_ORDER_STEP;
	}
	if (next - previous <= QUICK_NOTE_ORDER_EPSILON) {
		return null;
	}
	const middle = previous + (next - previous) / 2;
	return middle > previous && middle < next ? middle : null;
}

/** Новые позиции по готовому порядку id с равным шагом. */
export function buildQuickNoteRenumberedOrders(orderedIds: readonly string[]): Record<string, number> {
	return Object.fromEntries(orderedIds.map((id, index) => [id, index * QUICK_NOTE_ORDER_STEP]));
}

/**
 * Переставляет заметку в общем порядке открытых заметок.
 * Возвращает изменение одной позиции или полный пересчёт при исчерпании промежутка.
 */
export function buildQuickNoteMoveOrders(
	openNotes: readonly QuickNote[],
	movingId: string,
	anchorId: string,
	placement: 'before' | 'after',
): Record<string, number> | null {
	const sorted = [...openNotes].sort(compareQuickNotesByOrder).filter(note => note.id !== movingId);
	const anchorIndex = sorted.findIndex(note => note.id === anchorId);
	if (anchorIndex < 0 || anchorId === movingId) {
		return null;
	}
	const insertIndex = placement === 'before' ? anchorIndex : anchorIndex + 1;
	const order = resolveQuickNoteOrderBetween(sorted[insertIndex - 1]?.order, sorted[insertIndex]?.order);
	if (order !== null) {
		return { [movingId]: order };
	}
	const ids = sorted.map(note => note.id);
	ids.splice(insertIndex, 0, movingId);
	return buildQuickNoteRenumberedOrders(ids);
}

/** Применяет изменение полей к заметке и обновляет даты выполнения и изменения. */
function patchQuickNote<T extends QuickNote>(note: T, patch: Partial<QuickNote>, at: string): T {
	const next = { ...note, ...patch, updatedAt: at } as T;
	if (patch.color !== undefined) {
		next.color = normalizeQuickNoteColor(patch.color);
	}
	if (patch.title !== undefined && !patch.title.trim()) {
		next.title = note.title;
	}
	if (patch.done !== undefined && patch.done !== note.done) {
		if (patch.done) {
			next.completedAt = at;
		} else {
			delete next.completedAt;
		}
	}
	return next;
}

/**
 * Применяет операцию к заметкам обеих областей. Повтор уже применённой операции не меняет результат,
 * поэтому webview может переигрывать неподтверждённые операции поверх состояния расширения.
 */
export function applyQuickNoteOperation(
	notes: readonly QuickNoteView[],
	operation: QuickNoteOperation,
): { notes: QuickNoteView[]; result: QuickNoteOperationResult } {
	const ok: QuickNoteOperationResult = { ok: true };
	const findIndex = (scope: QuickNoteScope, id: string) => notes.findIndex(note => note.scope === scope && note.id === id);
	switch (operation.kind) {
		case 'create': {
			if (notes.some(note => note.id === operation.note.id)) {
				return { notes: [...notes], result: ok };
			}
			const created = normalizeQuickNote(operation.note);
			if (!created) {
				return { notes: [...notes], result: { ok: false, code: 'failed', message: 'Некорректная заметка.' } };
			}
			return { notes: [{ ...created, scope: operation.scope }, ...notes], result: ok };
		}
		case 'setGeneratedTitle': {
			const index = findIndex(operation.scope, operation.id);
			if (index < 0) {
				return { notes: [...notes], result: { ok: false, code: 'not-found', message: 'Заметка не найдена.' } };
			}
			const original = notes[index];
			if (original.title !== operation.expectedTitle || original.description !== operation.expectedDescription) {
				return { notes: [...notes], result: ok };
			}
			const title = normalizeQuickNoteAiTitle(operation.title);
			if (!title || title === original.title) return { notes: [...notes], result: ok };
			const next = [...notes];
			next[index] = patchQuickNote(original, { title }, operation.at);
			return { notes: next, result: ok };
		}
		case 'update': {
			const index = findIndex(operation.scope, operation.id);
			if (index < 0) {
				return { notes: [...notes], result: { ok: false, code: 'not-found', message: 'Заметка не найдена.' } };
			}
			const next = [...notes];
			next[index] = patchQuickNote(notes[index], operation.patch, operation.at);
			return { notes: next, result: ok };
		}
		case 'setItemDone': {
			const index = findIndex(operation.scope, operation.id);
			if (index < 0 || !notes[index].items.some(item => item.id === operation.itemId)) {
				return { notes: [...notes], result: { ok: false, code: 'not-found', message: 'Пункт не найден.' } };
			}
			const next = [...notes];
			next[index] = {
				...notes[index],
				items: notes[index].items.map(item => item.id === operation.itemId ? { ...item, done: operation.done } : item),
				updatedAt: operation.at,
			};
			return { notes: next, result: ok };
		}
		case 'delete':
			return { notes: notes.filter(note => !(note.scope === operation.scope && note.id === operation.id)), result: ok };
		case 'clearDone':
			return { notes: notes.filter(note => !note.done), result: ok };
		case 'setOrders':
			return {
				notes: notes.map(note => Object.prototype.hasOwnProperty.call(operation.orders, note.id)
					&& Number.isFinite(operation.orders[note.id])
					? { ...note, order: operation.orders[note.id] } : note),
				result: ok,
			};
		case 'changeScope': {
			const index = findIndex(operation.scope, operation.id);
			if (index < 0) {
				// Повтор после подтверждения: заметка уже в целевой области.
				const moved = notes.some(note => note.scope === operation.toScope && note.id === operation.id);
				return moved
					? { notes: [...notes], result: ok }
					: { notes: [...notes], result: { ok: false, code: 'not-found', message: 'Заметка не найдена.' } };
			}
			const next = [...notes];
			const patch: Partial<QuickNote> = {};
			if (operation.order !== undefined && Number.isFinite(operation.order)) {
				patch.order = operation.order;
			}
			if (operation.color !== undefined) {
				patch.color = operation.color;
			}
			next[index] = { ...patchQuickNote(notes[index], patch, operation.at), scope: operation.toScope };
			return { notes: next, result: ok };
		}
		case 'replace': {
			const index = findIndex(operation.scope, operation.note.id);
			const current = index >= 0 ? notes[index] : undefined;
			if (!current) {
				const replaced = notes.find(note => note.scope === operation.toScope && note.id === operation.note.id);
				if (replaced && replaced.updatedAt === operation.note.updatedAt) {
					return { notes: [...notes], result: ok };
				}
				return { notes: [...notes], result: { ok: false, code: 'not-found', message: 'Заметка удалена или перенесена.' } };
			}
			if (current.updatedAt === operation.note.updatedAt && current.scope === operation.toScope) {
				return { notes: [...notes], result: ok };
			}
			if (!operation.force && current.updatedAt !== operation.baseUpdatedAt) {
				return {
					notes: [...notes],
					result: { ok: false, code: 'conflict', message: 'Заметка изменена в другом окне VS Code.' },
				};
			}
			const normalized = normalizeQuickNote(operation.note);
			if (!normalized) {
				return { notes: [...notes], result: { ok: false, code: 'failed', message: 'Некорректная заметка.' } };
			}
			// Позицию и ссылку на промпт окно не редактирует: они меняются без смены даты и берутся из текущей версии,
			// иначе старый черновик откатил бы перенос или стёр ссылку на созданный промпт.
			const replaced: QuickNoteView = { ...normalized, order: current.order, scope: operation.toScope };
			if (current.prompt) {
				replaced.prompt = current.prompt;
			} else {
				delete replaced.prompt;
			}
			const next = [...notes];
			next[index] = replaced;
			return { notes: next, result: ok };
		}
		case 'clearDeletedPromptLink': {
			const index = findIndex(operation.scope, operation.id);
			if (index < 0) return { notes: [...notes], result: ok };
			const linked = notes[index].prompt;
			if (!linked || linked.id !== operation.promptId
				|| (operation.promptUuid && linked.promptUuid && linked.promptUuid !== operation.promptUuid)) {
				return { notes: [...notes], result: ok };
			}
			const next = [...notes];
			const updated: QuickNoteView = { ...notes[index] };
			delete updated.prompt;
			next[index] = updated;
			return { notes: next, result: ok };
		}
		case 'setPrompt': {
			const index = findIndex(operation.scope, operation.id);
			if (index < 0) {
				return { notes: [...notes], result: { ok: false, code: 'not-found', message: 'Заметка не найдена.' } };
			}
			const next = [...notes];
			const updated: QuickNoteView = { ...notes[index] };
			if (operation.prompt) {
				updated.prompt = { id: operation.prompt.id, promptUuid: operation.prompt.promptUuid };
			} else {
				delete updated.prompt;
			}
			next[index] = updated;
			return { notes: next, result: ok };
		}
		default:
			return { notes: [...notes], result: { ok: false, code: 'failed', message: 'Неизвестная операция.' } };
	}
}

/** Обычный объект, не массив и не null. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Непустой идентификатор разумной длины. */
function isOperationId(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

/** Заметка операции: объект с id, массивами пунктов и файлов (сами поля нормализует применение операции). */
function isOperationNote(value: unknown): value is QuickNote {
	return isPlainRecord(value) && isOperationId(value.id)
		&& (value.items === undefined || Array.isArray(value.items))
		&& (value.files === undefined || (Array.isArray(value.files)
			&& value.files.every(file => isPlainRecord(file) && isOperationId(file.id) && typeof file.storedName === 'string')));
}

/**
 * Проверяет операцию из webview на границе расширения и копирует только известные поля: сообщения webview —
 * недоверенный ввод. Неверная форма даёт null. setPrompt выставляет только само расширение после создания промпта,
 * поэтому новая заметка create приходит без ссылки на промпт и без вложений. Тесты — tests/quickNotes.test.ts.
 */
export function parseQuickNoteWebviewOperation(value: unknown): QuickNoteOperation | null {
	if (!isPlainRecord(value)) {
		return null;
	}
	const at = typeof value.at === 'string' ? value.at : null;
	switch (value.kind) {
		case 'create': {
			if (!isQuickNoteScope(value.scope) || !isOperationNote(value.note)
				|| (value.autoTitle !== undefined && typeof value.autoTitle !== 'boolean')) {
				return null;
			}
			// Интерфейс создаёт заметку без файлов: вложения появляются только сохранением черновика окна,
			// которое копирует их в папку заметки. Ссылка на промпт и записи файлов без копий отбрасываются.
			const { prompt: _prompt, ...note } = value.note;
			return {
				kind: 'create', scope: value.scope, note: { ...note, files: [] },
				...(value.autoTitle === true ? { autoTitle: true } : {}),
			};
		}
		case 'update': {
			if (!isQuickNoteScope(value.scope) || !isOperationId(value.id) || at === null || !isPlainRecord(value.patch)) {
				return null;
			}
			const source = value.patch;
			const patch: QuickNotePatch = {};
			for (const key of ['title', 'description', 'color'] as const) {
				if (source[key] !== undefined) {
					if (typeof source[key] !== 'string') {
						return null;
					}
					patch[key] = source[key] as string;
				}
			}
			if (source.done !== undefined) {
				if (typeof source.done !== 'boolean') {
					return null;
				}
				patch.done = source.done;
			}
			return { kind: 'update', scope: value.scope, id: value.id, patch, at };
		}
		case 'setItemDone':
			return isQuickNoteScope(value.scope) && isOperationId(value.id) && isOperationId(value.itemId)
				&& typeof value.done === 'boolean' && at !== null
				? { kind: 'setItemDone', scope: value.scope, id: value.id, itemId: value.itemId, done: value.done, at }
				: null;
		case 'delete':
			return isQuickNoteScope(value.scope) && isOperationId(value.id) ? { kind: 'delete', scope: value.scope, id: value.id } : null;
		case 'clearDone':
			return { kind: 'clearDone' };
		case 'setOrders': {
			if (!isPlainRecord(value.orders)) {
				return null;
			}
			const entries = Object.entries(value.orders);
			return entries.every(([id, order]) => isOperationId(id) && typeof order === 'number' && Number.isFinite(order))
				? { kind: 'setOrders', orders: Object.fromEntries(entries) as Record<string, number> }
				: null;
		}
		case 'changeScope': {
			if (!isQuickNoteScope(value.scope) || !isQuickNoteScope(value.toScope) || !isOperationId(value.id) || at === null) {
				return null;
			}
			if ((value.order !== undefined && (typeof value.order !== 'number' || !Number.isFinite(value.order)))
				|| (value.color !== undefined && typeof value.color !== 'string')) {
				return null;
			}
			return {
				kind: 'changeScope', scope: value.scope, toScope: value.toScope, id: value.id, at,
				...(value.order !== undefined ? { order: value.order as number } : {}),
				...(value.color !== undefined ? { color: value.color as string } : {}),
			};
		}
		case 'replace': {
			if (!isQuickNoteScope(value.scope) || !isQuickNoteScope(value.toScope) || !isOperationNote(value.note)
				|| typeof value.baseUpdatedAt !== 'string') {
				return null;
			}
			if ((value.draftId !== undefined && (typeof value.draftId !== 'string' || !isSafeQuickNoteDirectoryId(value.draftId)))
				|| (value.force !== undefined && typeof value.force !== 'boolean')) {
				return null;
			}
			return {
				kind: 'replace', scope: value.scope, toScope: value.toScope, note: value.note, baseUpdatedAt: value.baseUpdatedAt,
				...(value.draftId !== undefined ? { draftId: value.draftId as string } : {}),
				...(value.force !== undefined ? { force: value.force as boolean } : {}),
			};
		}
		default:
			return null;
	}
}

/** Области, файлы которых меняет операция; используется расширением для очереди записи. */
export function getQuickNoteOperationScopes(operation: QuickNoteOperation): QuickNoteScope[] {
	switch (operation.kind) {
		case 'clearDone':
		case 'setOrders':
			return ['workspace', 'global'];
		case 'changeScope':
			return operation.scope === operation.toScope ? [operation.scope] : [operation.scope, operation.toScope];
		case 'replace':
			return operation.scope === operation.toScope ? [operation.scope] : [operation.scope, operation.toScope];
		default:
			return [operation.scope];
	}
}

/** Фильтр виджета и доски по тексту, цветам и области. */
export interface QuickNotesFilter {
	search?: string;
	colors?: readonly string[];
	scope?: QuickNotesBoardScopeFilter;
}

/** Проверяет заметку по названию, описанию и пунктам без учёта регистра, по цвету и области. */
export function matchesQuickNoteFilter(
	note: Pick<QuickNoteView, 'scope' | 'color' | 'title' | 'description' | 'items'>,
	filter: QuickNotesFilter,
): boolean {
	if (filter.scope && filter.scope !== 'all' && note.scope !== filter.scope) {
		return false;
	}
	if (filter.colors && filter.colors.length > 0 && !filter.colors.includes(getQuickNoteColorKey(note))) {
		return false;
	}
	const query = (filter.search || '').trim().toLocaleLowerCase();
	if (!query) {
		return true;
	}
	const haystack = [note.title, note.description, ...note.items.map(item => item.text)].join('\n').toLocaleLowerCase();
	return haystack.includes(query);
}

/** Ключи цветов, которые встречаются в заметках: палитра по порядку, затем свои цвета и «без цвета». */
export function collectQuickNoteColorKeys(notes: readonly QuickNote[]): string[] {
	const keys = new Set(notes.map(note => getQuickNoteColorKey(note)));
	const palette = QUICK_NOTE_PALETTE_COLORS.filter(color => keys.has(color));
	const custom = [...keys].filter(key => key.startsWith('#')).sort();
	return [...palette, ...custom, ...(keys.has(QUICK_NOTE_NO_COLOR_KEY) ? [QUICK_NOTE_NO_COLOR_KEY] : [])];
}

/** Количество выполненных и всех пунктов чек-листа. */
export function getQuickNoteChecklistProgress(note: Pick<QuickNote, 'items'>): { done: number; total: number } {
	return { done: note.items.filter(item => item.done).length, total: note.items.length };
}

/** Глубокая копия заметки для черновика окна. */
export function createQuickNoteDraft(note: QuickNoteView): QuickNoteView {
	return JSON.parse(JSON.stringify(note)) as QuickNoteView;
}

/**
 * Переносит в черновик или исходную версию окна записи файлов подтверждённой версии заметки по id: при сохранении
 * расширение может переименовать новую копию («a (2).png»), и устаревшее имя иначе ушло бы в следующее сохранение.
 * Файлы, добавленные или убранные в черновике после сохранения, не меняются; без отличий возвращается тот же объект.
 * Тесты — tests/quickNotes.test.ts.
 */
export function syncQuickNoteFilesWithSaved<T extends Pick<QuickNote, 'files'>>(
	target: T,
	saved: Pick<QuickNote, 'files'>,
): T {
	const savedById = new Map(saved.files.map(file => [file.id, file]));
	let changed = false;
	const files = target.files.map(file => {
		const confirmed = savedById.get(file.id);
		if (!confirmed || stringifyQuickNoteStable(confirmed) === stringifyQuickNoteStable(file)) {
			return file;
		}
		changed = true;
		return { ...confirmed };
	});
	return changed ? { ...target, files } : target;
}

/** JSON с упорядоченными ключами объектов: версии одной заметки из разных источников сравниваются по значениям. */
function stringifyQuickNoteStable(value: unknown): string {
	const compareKeys = ([left]: [string, unknown], [right]: [string, unknown]) => (
		left < right ? -1 : left > right ? 1 : 0);
	return JSON.stringify(value, (_key, entry: unknown) => (isPlainRecord(entry)
		? Object.fromEntries(Object.entries(entry).sort(compareKeys))
		: entry));
}

/**
 * Содержимое заметки без названия и полей, которые сохранение черновика не берёт из окна: дата изменения,
 * позиция и ссылка на промпт. Нормализация убирает служебные поля и устаревшую дату выполнения.
 */
function stringifyQuickNoteWithoutTitle(note: QuickNoteView): string | null {
	const normalized = normalizeQuickNote(note);
	if (!normalized) {
		return null;
	}
	const { title: _title, updatedAt: _updatedAt, order: _order, prompt: _prompt, ...content } = normalized;
	return stringifyQuickNoteStable(content);
}

/**
 * Решает, можно ли принять внешнее изменение заметки в черновик с правками без конфликта: версия другого окна
 * отличается от исходной только названием и датой изменения (например, AI-название новой заметки), а название
 * в черновике пользователь не менял. Иначе окно показывает конфликт. Тесты — tests/quickNotes.test.ts.
 */
export function canAcceptQuickNoteExternalTitle(
	original: QuickNoteView,
	draft: Pick<QuickNoteView, 'title'>,
	external: QuickNoteView,
): boolean {
	if (draft.title !== original.title || external.scope !== original.scope) {
		return false;
	}
	const originalContent = stringifyQuickNoteWithoutTitle(original);
	return originalContent !== null && originalContent === stringifyQuickNoteWithoutTitle(external);
}

/** Сравнивает редактируемые поля черновика с исходной заметкой. */
export function isQuickNoteDraftDirty(draft: QuickNoteView, original: QuickNoteView): boolean {
	const pick = (note: QuickNoteView) => JSON.stringify({
		title: note.title,
		description: note.description,
		color: normalizeQuickNoteColor(note.color),
		done: note.done,
		scope: note.scope,
		items: note.items.map(item => ({ id: item.id, text: item.text, done: item.done })),
		files: note.files.map(file => file.id),
	});
	return pick(draft) !== pick(original);
}

/**
 * Собирает операцию сохранения черновика: пустые пункты отбрасываются, пустое название не сохраняется.
 * sourceScope — текущая область заметки, если другое окно перенесло её после открытия черновика.
 */
export function buildQuickNoteReplaceOperation(
	draft: QuickNoteView,
	original: QuickNoteView,
	at: string,
	options: { draftId?: string; force?: boolean; sourceScope?: QuickNoteScope } = {},
): Extract<QuickNoteOperation, { kind: 'replace' }> {
	const title = draft.title.trim() || original.title;
	const done = draft.done;
	const note = toStoredQuickNote({
		...draft,
		title,
		items: draft.items
			.map(item => ({ ...item, text: item.text.trim() }))
			.filter(item => item.text.length > 0),
		updatedAt: at,
	});
	if (done && !original.done) {
		note.completedAt = at;
	} else if (!done) {
		delete note.completedAt;
	}
	return {
		kind: 'replace',
		scope: options.sourceScope ?? original.scope,
		toScope: draft.scope,
		note,
		baseUpdatedAt: original.updatedAt,
		draftId: options.draftId,
		force: options.force,
	};
}

/** Соседняя заметка списка с переходом по кругу; null, если в списке одна заметка или текущей нет. */
export function resolveAdjacentQuickNoteId(
	orderedIds: readonly string[],
	currentId: string,
	direction: 'previous' | 'next',
): string | null {
	const index = orderedIds.indexOf(currentId);
	if (index < 0 || orderedIds.length < 2) {
		return null;
	}
	const offset = direction === 'next' ? 1 : -1;
	return orderedIds[(index + offset + orderedIds.length) % orderedIds.length];
}

/** Параметры отбора заметок доски. */
export interface QuickNotesBoardOptions extends QuickNotesFilter {
	showDone?: boolean;
}

/** Заметки доски: открытые по общему порядку, затем выполненные, если они показаны. */
export function resolveQuickNotesBoardNotes(notes: readonly QuickNoteView[], options: QuickNotesBoardOptions): QuickNoteView[] {
	const { open, done } = splitQuickNotes(notes.filter(note => matchesQuickNoteFilter(note, options)));
	return options.showDone ? [...open, ...done] : open;
}

/** Колонка доски при группировке. */
export interface QuickNotesBoardGroup {
	key: string;
	notes: QuickNoteView[];
}

/** Группирует заметки доски по цвету или области; ключи групп берутся из всех заметок, а не только из отобранных. */
export function groupQuickNotesForBoard(
	boardNotes: readonly QuickNoteView[],
	groupBy: QuickNotesBoardGroupBy,
	allNotes: readonly QuickNoteView[],
	availableScopes: readonly QuickNoteScope[] = ['workspace', 'global'],
): QuickNotesBoardGroup[] {
	if (groupBy === 'color') {
		// Без заметок остаётся колонка «Без цвета», чтобы на пустой доске можно было добавить первую.
		const keys = collectQuickNoteColorKeys(allNotes);
		return (keys.length > 0 ? keys : [QUICK_NOTE_NO_COLOR_KEY]).map(key => ({
			key,
			notes: boardNotes.filter(note => getQuickNoteColorKey(note) === key),
		}));
	}
	if (groupBy === 'scope') {
		return availableScopes.map(scope => ({ key: scope, notes: boardNotes.filter(note => note.scope === scope) }));
	}
	return [{ key: 'all', notes: [...boardNotes] }];
}

/** Число колонок сетки доски по доступной ширине. */
export function resolveQuickNotesBoardColumnCount(width: number, minColumnWidth = 236, gap = 14): number {
	if (!Number.isFinite(width) || width <= 0) {
		return 1;
	}
	return Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)));
}

/** Раскладывает элементы по колонкам по очереди: порядок читается слева направо без пустот под короткими. */
export function distributeQuickNotesIntoColumns<T>(items: readonly T[], columnCount: number): T[][] {
	const count = Math.max(1, Math.floor(columnCount));
	const columns: T[][] = Array.from({ length: count }, () => []);
	items.forEach((item, index) => columns[index % count].push(item));
	return columns;
}

/** Цель переноса стикера: рядом с другим стикером или в конец колонки группы. */
export type QuickNotesBoardDropTarget =
	| { kind: 'note'; noteId: string; placement: 'before' | 'after' }
	| { kind: 'group'; groupKey: string };

/**
 * Операции переноса стикера: позиция в общем порядке и, при переносе в другую группу,
 * новый цвет или область. Пустой результат означает, что перенос ничего не меняет.
 */
export function planQuickNoteBoardMove(input: {
	notes: readonly QuickNoteView[];
	movingId: string;
	movingScope: QuickNoteScope;
	target: QuickNotesBoardDropTarget;
	groupBy: QuickNotesBoardGroupBy;
	at: string;
}): QuickNoteOperation[] {
	const moving = input.notes.find(note => note.id === input.movingId && note.scope === input.movingScope);
	if (!moving || (input.target.kind === 'note' && input.target.noteId === input.movingId)) {
		return [];
	}
	const separated = splitQuickNotes(input.notes);
	// Открытые и выполненные заметки показываются отдельно — каждую группу можно переставлять.
	const partition = moving.done ? separated.done : separated.open;
	const targetNote = input.target.kind === 'note'
		? input.notes.find(note => note.id === (input.target as { noteId: string }).noteId)
		: undefined;
	const groupKey = input.target.kind === 'group'
		? input.target.groupKey
		: targetNote
			? input.groupBy === 'color' ? getQuickNoteColorKey(targetNote) : input.groupBy === 'scope' ? targetNote.scope : 'all'
			: 'all';
	// Позиция: рядом со стикером или после последнего открытого стикера целевой группы.
	let orders: Record<string, number> | null = null;
	if (input.target.kind === 'note' && targetNote && targetNote.done === moving.done) {
		orders = buildQuickNoteMoveOrders(partition, moving.id, targetNote.id, input.target.placement);
	} else if (input.target.kind === 'group') {
		const groupOpen = partition.filter(note => note.id !== moving.id && (input.groupBy === 'color'
			? getQuickNoteColorKey(note) === groupKey
			: input.groupBy === 'scope' ? note.scope === groupKey : true));
		const last = groupOpen[groupOpen.length - 1];
		if (last) {
			orders = buildQuickNoteMoveOrders(partition, moving.id, last.id, 'after');
		}
	}
	const operations: QuickNoteOperation[] = [];
	const movingOrder = orders?.[moving.id];
	const otherOrders = orders ? Object.fromEntries(Object.entries(orders).filter(([id]) => id !== moving.id)) : {};
	if (input.groupBy === 'scope' && isQuickNoteScope(groupKey) && groupKey !== moving.scope) {
		operations.push({
			kind: 'changeScope', scope: moving.scope, id: moving.id, toScope: groupKey,
			order: movingOrder, at: input.at,
		});
	} else {
		if (input.groupBy === 'color') {
			const color = groupKey === QUICK_NOTE_NO_COLOR_KEY ? '' : groupKey;
			if (getQuickNoteColorKey(moving) !== groupKey) {
				operations.push({ kind: 'update', scope: moving.scope, id: moving.id, patch: { color }, at: input.at });
			}
		}
		if (movingOrder !== undefined) {
			otherOrders[moving.id] = movingOrder;
		}
	}
	if (Object.keys(otherOrders).length > 0) {
		operations.push({ kind: 'setOrders', orders: otherOrders });
	}
	return operations;
}

/** Текст промпта из заметки: описание и чек-лист с исходными отметками. */
export function buildQuickNotePromptContent(note: Pick<QuickNote, 'title' | 'description' | 'items'>): string {
	const parts: string[] = [];
	const description = note.description.trim();
	if (description) {
		parts.push(description);
	}
	const items = note.items.filter(item => item.text.trim());
	if (items.length > 0) {
		parts.push(items.map(item => `- [${item.done ? 'x' : ' '}] ${item.text.trim()}`).join('\n'));
	}
	return parts.join('\n\n') || note.title.trim();
}

/** Предельная длина имени копии вложения. */
const QUICK_NOTE_STORED_NAME_MAX_LENGTH = 120;

/**
 * Безопасное имя копии: последний сегмент пути без управляющих и запрещённых символов,
 * без ведущих точек и пробелов. Повторное применение не меняет результат.
 */
export function sanitizeQuickNoteFileName(name: string): string {
	const base = String(name || '').split(/[\\/]/).pop() || '';
	const cleaned = base
		.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
		.replace(/^[\s.]+/, '')
		.slice(0, QUICK_NOTE_STORED_NAME_MAX_LENGTH)
		.trim();
	return cleaned || 'file';
}

/** Уникальное имя копии в папке заметки: повтор получает суффикс перед расширением. */
export function buildQuickNoteStoredName(name: string, existing: ReadonlySet<string>): string {
	const safe = sanitizeQuickNoteFileName(name);
	if (!existing.has(safe.toLowerCase())) {
		return safe;
	}
	const dotIndex = safe.lastIndexOf('.');
	// Слишком длинное «расширение» считается частью имени, иначе суффикс не поместится в предел длины.
	const hasExtension = dotIndex > 0 && safe.length - dotIndex <= 32;
	const stem = hasExtension ? safe.slice(0, dotIndex) : safe;
	const extension = hasExtension ? safe.slice(dotIndex) : '';
	for (let suffix = 2; ; suffix += 1) {
		// Основа укорачивается, чтобы имя с суффиксом не превышало предельную длину.
		const tail = ` (${suffix})${extension}`;
		const trimmedStem = stem.slice(0, Math.max(1, QUICK_NOTE_STORED_NAME_MAX_LENGTH - tail.length)).trim() || 'file';
		const candidate = `${trimmedStem}${tail}`;
		if (!existing.has(candidate.toLowerCase()) && isSafeQuickNoteStoredName(candidate)) {
			return candidate;
		}
	}
}

/** Проверяет, что имя копии — один безопасный сегмент пути и не выводит за папку вложений. */
export function isSafeQuickNoteStoredName(storedName: string): boolean {
	return Boolean(storedName)
		&& storedName === sanitizeQuickNoteFileName(storedName)
		&& storedName !== '.'
		&& storedName !== '..';
}

/** Проверяет id заметки или черновика как имя папки. */
export function isSafeQuickNoteDirectoryId(id: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

/** Короткая дата для стикера и строки: «18.11 11:05» по локальному времени. */
export function formatQuickNoteShortDate(iso: string): string {
	const date = new Date(iso);
	if (!iso || Number.isNaN(date.getTime())) {
		return '';
	}
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
