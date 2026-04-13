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

/**
 * Ищет запись в очереди по promptId или promptUuid.
 * Совпадение по UUID имеет наивысший приоритет.
 * Возвращает первую подходящую запись или undefined.
 */
export function findPendingSaveEntry(
	queue: ReadonlyMap<string, PendingSaveEntry>,
	promptId: string | undefined,
	promptUuid: string | undefined,
): PendingSaveEntry | undefined {
	const normalizedId = (promptId || '').trim();
	const normalizedUuid = (promptUuid || '').trim();
	if (!normalizedId && !normalizedUuid) {
		return undefined;
	}

	/** Первый проход: ищем точное совпадение по UUID */
	if (normalizedUuid) {
		for (const entry of queue.values()) {
			const entryUuid = (entry.snapshot.promptUuid || '').trim();
			if (entryUuid && normalizedUuid === entryUuid) {
				return entry;
			}
		}
	}

	/** Второй проход: ищем совпадение по id (путь/папка) */
	if (normalizedId) {
		for (const entry of queue.values()) {
			const entryId = (entry.snapshot.id || '').trim();
			if (entryId && normalizedId === entryId) {
				return entry;
			}
		}
	}

	return undefined;
}
