import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildSaveQueueKey,
	findPendingSaveEntry,
	type PendingSaveEntry,
} from '../src/utils/promptSaveQueue.js';

import { createDefaultPrompt } from '../src/types/prompt.js';

/** Хелпер: создаёт запись очереди с переданным snapshot и немедленно резолвящимся промисом */
function makeEntry(id: string, uuid: string, resolvedPrompt?: ReturnType<typeof createDefaultPrompt> | null): PendingSaveEntry {
	const snapshot = createDefaultPrompt('');
	snapshot.id = id;
	snapshot.promptUuid = uuid;
	return {
		snapshot,
		promise: Promise.resolve(resolvedPrompt ?? snapshot),
	};
}

test('buildSaveQueueKey combines uuid and id into a composite key', () => {
	assert.equal(buildSaveQueueKey('uuid-1', 'my-prompt'), 'uuid-1::my-prompt');
	assert.equal(buildSaveQueueKey('', 'my-prompt'), '::my-prompt');
	assert.equal(buildSaveQueueKey('uuid-1', ''), 'uuid-1::');
	assert.equal(buildSaveQueueKey(undefined, undefined), '::');
	assert.equal(buildSaveQueueKey('  uuid-1 ', ' my-prompt '), 'uuid-1::my-prompt');
});

test('findPendingSaveEntry returns undefined for empty inputs', () => {
	const queue = new Map<string, PendingSaveEntry>();
	queue.set('key', makeEntry('id-1', 'uuid-1'));

	assert.equal(findPendingSaveEntry(queue, '', ''), undefined);
	assert.equal(findPendingSaveEntry(queue, undefined, undefined), undefined);
	assert.equal(findPendingSaveEntry(queue, '', undefined), undefined);
});

test('findPendingSaveEntry matches by UUID with highest priority', () => {
	const queue = new Map<string, PendingSaveEntry>();
	const entry1 = makeEntry('id-1', 'uuid-aaa');
	const entry2 = makeEntry('id-2', 'uuid-bbb');
	queue.set('key-1', entry1);
	queue.set('key-2', entry2);

	/** Точное совпадение по UUID */
	assert.equal(findPendingSaveEntry(queue, undefined, 'uuid-aaa'), entry1);
	assert.equal(findPendingSaveEntry(queue, undefined, 'uuid-bbb'), entry2);

	/** UUID приоритетнее: даже если id также совпадает с другим entry, UUID побеждает */
	assert.equal(findPendingSaveEntry(queue, 'id-2', 'uuid-aaa'), entry1);
});

test('findPendingSaveEntry falls back to id match when UUID is not available', () => {
	const queue = new Map<string, PendingSaveEntry>();
	const entry = makeEntry('my-task', 'uuid-111');
	queue.set('key', entry);

	/** Поиск по id без UUID */
	assert.equal(findPendingSaveEntry(queue, 'my-task', undefined), entry);
	assert.equal(findPendingSaveEntry(queue, 'my-task', ''), entry);
});

test('findPendingSaveEntry returns undefined when nothing matches', () => {
	const queue = new Map<string, PendingSaveEntry>();
	queue.set('key', makeEntry('id-1', 'uuid-1'));

	assert.equal(findPendingSaveEntry(queue, 'other-id', 'other-uuid'), undefined);
	assert.equal(findPendingSaveEntry(queue, 'other-id', ''), undefined);
	assert.equal(findPendingSaveEntry(queue, '', 'other-uuid'), undefined);
});

test('findPendingSaveEntry works with empty queue', () => {
	const queue = new Map<string, PendingSaveEntry>();
	assert.equal(findPendingSaveEntry(queue, 'any-id', 'any-uuid'), undefined);
});

test('findPendingSaveEntry ignores entries with empty snapshot id and uuid', () => {
	const queue = new Map<string, PendingSaveEntry>();
	/** Запись со snapshot без id и uuid — не должна матчиться по id поиска */
	queue.set('key', makeEntry('', ''));

	assert.equal(findPendingSaveEntry(queue, 'id-1', 'uuid-1'), undefined);
	/** Но пустой id к пустому id не матчится (нормализация обрезает) */
	assert.equal(findPendingSaveEntry(queue, '', ''), undefined);
});
