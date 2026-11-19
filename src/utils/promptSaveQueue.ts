/**
 * Очередь ожидающих сохранений промптов.
 * Записи индексируются по составному ключу (uuid + id/путь директории),
 * что позволяет уникально идентифицировать промпт даже до создания папки на дискe.
 */

import type { Prompt } from '../types/prompt.js';

/**
 * Запись очереди: хранит моментальный снимок промпта и промис завершения записи на диск.
 */
export interface PendingSaveEntry {
	/** Снимок промпта на момент начала сохранения */
	readonly snapshot: Prompt;
	/** Промис завершения: резолвится сохранённым промптом или null при ошибке */
	readonly promise: Promise<Prompt | null>;
	/** Уникальный идентификатор операции, чтобы поздний finally не удалял более новую запись */
	readonly operationId: string;
}

/**
 * Формирует составной ключ очереди по UUID и id (имя директории) промпта.
 * Оба компонента включаются для однозначной идентификации.
 */
export function buildSaveQueueKey(promptUuid: string | undefined, promptId: string | undefined): string {
	const uuid = (promptUuid || '').trim();
	const id = (promptId || '').trim();
	return `${uuid}::${id}`;
}

/** Для открытия копии нужен точный снимок; после переименования допустим единственный снимок с нужным UUID. */
export function findPendingSaveEntry(
	queue: ReadonlyMap<string, PendingSaveEntry>,
	promptId: string | undefined,
	promptUuid: string | undefined,
): PendingSaveEntry | undefined {
	const id = (promptId || '').trim();
	const uuid = (promptUuid || '').trim();
	const entries = [...queue.values()];
	const candidates = uuid ? entries.filter(entry => entry.snapshot.promptUuid?.trim() === uuid) : entries;
	const exact = id ? candidates.find(entry => entry.snapshot.id?.trim() === id) : undefined;
	return exact ?? (uuid && candidates.length === 1 ? candidates[0] : undefined);
}
