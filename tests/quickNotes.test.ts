import test from 'node:test';
import assert from 'node:assert/strict';
import type { QuickNote, QuickNoteScope, QuickNoteView } from '../src/types/quickNotes.js';
import {
	applyQuickNoteOperation,
	buildQuickNoteMoveOrders,
	buildQuickNotePromptContent,
	buildQuickNoteReplaceOperation,
	buildQuickNoteStoredName,
	canAcceptQuickNoteExternalTitle,
	collectQuickNoteColorKeys,
	createQuickNoteDraft,
	distributeQuickNotesIntoColumns,
	formatQuickNoteClipboardText,
	getQuickNoteOperationScopes,
	groupQuickNotesForBoard,
	isQuickNoteDraftDirty,
	isSafeQuickNoteDirectoryId,
	isSafeQuickNoteStoredName,
	matchesQuickNoteFilter,
	normalizeQuickNoteAiTitle,
	normalizeQuickNoteColor,
	normalizeQuickNotesFile,
	prepareQuickNoteCreationInput,
	parseQuickNoteWebviewOperation,
	planQuickNoteBoardMove,
	QUICK_NOTE_ORDER_STEP,
	resolveAdjacentQuickNoteId,
	resolveQuickNoteOrderBetween,
	resolveQuickNotesBoardColumnCount,
	resolveQuickNotesBoardNotes,
	resolveQuickNoteTopOrder,
	sanitizeQuickNoteFileName,
	serializeQuickNotesFile,
	splitQuickNotes,
	syncQuickNoteFilesWithSaved,
	toStoredQuickNote,
} from '../src/utils/quickNotes.js';

/** Название и описание копируются в порядке полей, одинаковый текст добавляется один раз. */
test('clipboard text includes title, distinct description and checklist', () => {
	const items = [{ id: 'check', text: 'Проверить', done: true }];
	assert.equal(formatQuickNoteClipboardText({ title: 'Название ', description: 'Описание', items }),
		'Название.\n\nОписание:\n\n- [x] Проверить');
	assert.equal(formatQuickNoteClipboardText({ title: 'Описание', description: ' Описание\n', items }),
		'Описание.\n\n- [x] Проверить');
	assert.equal(formatQuickNoteClipboardText({ title: 'Название.', description: 'Описание:', items }),
		'Название.\n\nОписание:\n\n- [x] Проверить');
	assert.equal(formatQuickNoteClipboardText({ title: 'Название', description: '', items: [] }), 'Название.');
	assert.equal(formatQuickNoteClipboardText({
		title: 'Название.', description: 'Описание', items: [{ id: 'empty', text: ' \n', done: true }],
	}), 'Название.\n\nОписание');
});

/** Создаёт заметку представления с заполненными обязательными полями. */
function note(id: string, patch: Partial<QuickNoteView> = {}, scope: QuickNoteScope = 'workspace'): QuickNoteView {
	return {
		id,
		title: `Заметка ${id}`,
		description: '',
		color: '',
		done: false,
		order: 0,
		items: [],
		files: [],
		createdAt: '2026-11-18T08:00:00.000Z',
		updatedAt: '2026-11-18T08:00:00.000Z',
		scope,
		...patch,
	};
}

/** Неизвестные поля файла, заметки, пункта и вложения сохраняются; служебные поля представления — нет. */
test('normalizeQuickNotesFile keeps unknown fields and drops view-only fields', () => {
	const content = normalizeQuickNotesFile({
		version: 7,
		custom: { keep: true },
		notes: [{
			id: 'a', title: 'A', color: 'RED', done: true, completedAt: '2026-11-18T09:00:00.000Z', order: 5,
			extra: 'x', scope: 'global', previewUris: { f: 'uri' },
			items: [{ id: 'i1', text: 'Пункт', done: true, flag: 1 }],
			files: [{ id: 'f', name: 'a.png', storedName: 'a.png', size: 10, addedAt: '', meta: 'm' }],
		}],
	});
	assert.equal(content.version, 1);
	assert.deepEqual((content as unknown as Record<string, unknown>).custom, { keep: true });
	const [first] = content.notes;
	assert.equal(first.color, 'red');
	assert.equal(first.completedAt, '2026-11-18T09:00:00.000Z');
	assert.equal((first as unknown as Record<string, unknown>).extra, 'x');
	assert.equal('scope' in first, false);
	assert.equal('previewUris' in first, false);
	assert.equal((first.items[0] as unknown as Record<string, unknown>).flag, 1);
	assert.equal((first.files[0] as unknown as Record<string, unknown>).meta, 'm');
});

/** Повреждённые значения заменяются безопасными, дубли id получают суффикс, записи без копии отбрасываются. */
test('normalizeQuickNotesFile repairs malformed entries deterministically', () => {
	const content = normalizeQuickNotesFile({
		notes: [
			null, 'text', { title: 7, color: 'url(evil)', order: 'x', items: [null, { text: 'ok' }] },
			{ id: 'dup' }, { id: 'dup', files: [{ name: 'no-stored' }, { storedName: 'b.txt', size: -1 }] },
		],
	});
	assert.equal(content.notes.length, 3);
	assert.equal(content.notes[0].id, 'note-3');
	assert.equal(content.notes[0].title, '');
	assert.equal(content.notes[0].color, '');
	assert.equal(content.notes[0].order, 2 * QUICK_NOTE_ORDER_STEP);
	assert.deepEqual(content.notes[0].items, [{ id: 'item-2', text: 'ok', done: false }]);
	assert.deepEqual(content.notes.map(entry => entry.id), ['note-3', 'dup', 'dup-2']);
	assert.deepEqual(content.notes[2].files.map(file => [file.storedName, file.size, file.name]), [['b.txt', 0, 'b.txt']]);
	assert.deepEqual(normalizeQuickNotesFile('broken'), { version: 1, notes: [] });
});

/** Цвет допускает только палитру и шестнадцатеричное значение, что исключает подстановку в CSS. */
test('normalizeQuickNoteColor accepts palette names and hex colors only', () => {
	for (const [input, expected] of [
		['Blue', 'blue'], ['#A1B2C3', '#a1b2c3'], ['#abc', ''], ['var(--x)', ''], ['red; background:url(x)', ''], [null, ''],
	] as const) {
		assert.equal(normalizeQuickNoteColor(input), expected, String(input));
	}
});

/** Файл сериализуется с отступом 2 и переводом строки в конце. */
test('serializeQuickNotesFile writes readable JSON with trailing newline', () => {
	const text = serializeQuickNotesFile({ version: 1, notes: [] });
	assert.equal(text, '{\n  "version": 1,\n  "notes": []\n}\n');
});

/** Повтор операций безопасен: webview переигрывает неподтверждённые операции поверх состояния. */
test('applyQuickNoteOperation is idempotent for replayed create, delete and item marks', () => {
	const created = note('n1', { order: 10 });
	const once = applyQuickNoteOperation([], { kind: 'create', scope: 'global', note: toStoredQuickNote(created) });
	const twice = applyQuickNoteOperation(once.notes, { kind: 'create', scope: 'global', note: toStoredQuickNote(created) });
	assert.equal(twice.notes.length, 1);
	assert.equal(twice.notes[0].scope, 'global');
	const deleted = applyQuickNoteOperation(twice.notes, { kind: 'delete', scope: 'global', id: 'n1' });
	assert.deepEqual(applyQuickNoteOperation(deleted.notes, { kind: 'delete', scope: 'global', id: 'n1' }).notes, []);
	const withItem = [note('n2', { items: [{ id: 'i', text: 'a', done: false }] })];
	const setDone = { kind: 'setItemDone', scope: 'workspace', id: 'n2', itemId: 'i', done: true, at: 'T1' } as const;
	const checked = applyQuickNoteOperation(withItem, setDone);
	assert.equal(checked.notes[0].items[0].done, true);
	assert.equal(checked.notes[0].updatedAt, 'T1');
	// Повтор той же отметки поверх уже применённой не возвращает пункт в прежнее состояние.
	assert.equal(applyQuickNoteOperation(checked.notes, setDone).notes[0].items[0].done, true);
	assert.equal(applyQuickNoteOperation(withItem, { ...setDone, itemId: 'x' }).result.code, 'not-found');
});

/** Отметка выполнения ставит и снимает дату; пустое название не затирает прежнее. */
test('applyQuickNoteOperation update maintains completion date and ignores empty title', () => {
	const done = applyQuickNoteOperation([note('a')], { kind: 'update', scope: 'workspace', id: 'a', patch: { done: true, title: '  ' }, at: 'T2' });
	assert.equal(done.notes[0].completedAt, 'T2');
	assert.equal(done.notes[0].title, 'Заметка a');
	const reopened = applyQuickNoteOperation(done.notes, { kind: 'update', scope: 'workspace', id: 'a', patch: { done: false }, at: 'T3' });
	assert.equal(reopened.notes[0].completedAt, undefined);
	assert.equal(applyQuickNoteOperation([note('a')], { kind: 'update', scope: 'global', id: 'a', patch: {}, at: 'T' }).result.code, 'not-found');
});

/** Сохранение черновика отклоняется при изменении заметки в другом окне и проходит с явной перезаписью. */
test('replace operation detects conflicts and supports explicit overwrite', () => {
	const original = note('a', { updatedAt: 'T1' });
	const draft = { ...createQuickNoteDraft(original), title: 'Новое', items: [{ id: 'i', text: '  ', done: false }] };
	const operation = buildQuickNoteReplaceOperation(draft, original, 'T9');
	assert.deepEqual(operation.note.items, [], 'пустые пункты не сохраняются');
	const changedElsewhere = [note('a', { updatedAt: 'T5' })];
	assert.equal(applyQuickNoteOperation(changedElsewhere, operation).result.code, 'conflict');
	const forced = applyQuickNoteOperation(changedElsewhere, { ...operation, force: true });
	assert.equal(forced.result.ok, true);
	assert.equal(forced.notes[0].title, 'Новое');
	const saved = applyQuickNoteOperation([original], operation);
	assert.equal(saved.notes[0].updatedAt, 'T9');
	// Повтор после подтверждения не считается конфликтом.
	assert.equal(applyQuickNoteOperation(saved.notes, operation).result.ok, true);
	assert.equal(applyQuickNoteOperation([], operation).result.code, 'not-found');
});

/** Смена области в черновике переносит заметку; признак изменений учитывает область и файлы. */
test('draft helpers detect changes and move notes between scopes', () => {
	const original = note('a', { updatedAt: 'T1', files: [] });
	const draft = createQuickNoteDraft(original);
	assert.equal(isQuickNoteDraftDirty(draft, original), false);
	draft.scope = 'global';
	assert.equal(isQuickNoteDraftDirty(draft, original), true);
	const operation = buildQuickNoteReplaceOperation(draft, original, 'T2', { draftId: 'd1' });
	assert.deepEqual([operation.scope, operation.toScope, operation.draftId], ['workspace', 'global', 'd1']);
	assert.deepEqual(getQuickNoteOperationScopes(operation), ['workspace', 'global']);
	const moved = applyQuickNoteOperation([original], operation);
	assert.equal(moved.notes[0].scope, 'global');
});

/** Открытые заметки идут по позиции, выполненные — по дате выполнения, новая заметка встаёт первой. */
test('ordering helpers keep a shared order across scopes', () => {
	const notes = [
		note('b', { order: 20 }), note('a', { order: 10 }, 'global'),
		note('d', { done: true, completedAt: '2026-11-18T10:00:00.000Z' }), note('c', { done: true, completedAt: '2026-11-18T11:00:00.000Z' }),
	];
	const { open, done } = splitQuickNotes(notes);
	assert.deepEqual(open.map(entry => entry.id), ['a', 'b']);
	assert.deepEqual(done.map(entry => entry.id), ['c', 'd']);
	assert.equal(resolveQuickNoteTopOrder(notes), -QUICK_NOTE_ORDER_STEP);
	assert.equal(resolveQuickNoteTopOrder([]), 0);
	assert.equal(resolveQuickNoteOrderBetween(10, 20), 15);
	assert.equal(resolveQuickNoteOrderBetween(undefined, 10), 10 - QUICK_NOTE_ORDER_STEP);
	assert.equal(resolveQuickNoteOrderBetween(10, undefined), 10 + QUICK_NOTE_ORDER_STEP);
	assert.equal(resolveQuickNoteOrderBetween(1, 1 + 1e-9), null);
});

/** Перенос задаёт позицию между соседями, а при исчерпании промежутка пересчитывает все позиции. */
test('buildQuickNoteMoveOrders inserts between neighbours and renumbers when exhausted', () => {
	const open = [note('a', { order: 0 }), note('b', { order: 10 }), note('c', { order: 20 })];
	assert.deepEqual(buildQuickNoteMoveOrders(open, 'c', 'a', 'after'), { c: 5 });
	assert.deepEqual(buildQuickNoteMoveOrders(open, 'a', 'c', 'after'), { a: 20 + QUICK_NOTE_ORDER_STEP });
	assert.equal(buildQuickNoteMoveOrders(open, 'a', 'a', 'before'), null);
	const tight = [note('a', { order: 0 }), note('b', { order: 1e-9 }), note('c', { order: 1 })];
	assert.deepEqual(buildQuickNoteMoveOrders(tight, 'c', 'b', 'before'), { a: 0, c: QUICK_NOTE_ORDER_STEP, b: 2 * QUICK_NOTE_ORDER_STEP });
});

/** Фильтр ищет по названию, описанию и пунктам без учёта регистра, учитывает цвет и область. */
test('matchesQuickNoteFilter combines search, colors and scope', () => {
	const target = note('a', { title: 'Кеш', description: 'Сравнить файлы', color: 'blue', items: [{ id: 'i', text: 'Добавить ТЕСТ', done: false }] }, 'global');
	assert.equal(matchesQuickNoteFilter(target, { search: 'тест' }), true);
	assert.equal(matchesQuickNoteFilter(target, { search: 'сравнить' }), true);
	assert.equal(matchesQuickNoteFilter(target, { search: 'нет' }), false);
	assert.equal(matchesQuickNoteFilter(target, { colors: ['red'] }), false);
	assert.equal(matchesQuickNoteFilter(target, { colors: ['blue', 'none'] }), true);
	assert.equal(matchesQuickNoteFilter(target, { scope: 'workspace' }), false);
	assert.equal(matchesQuickNoteFilter(note('b'), { colors: ['none'] }), true);
	assert.deepEqual(collectQuickNoteColorKeys([note('x', { color: 'teal' }), note('y'), note('z', { color: '#ffffff' }), note('w', { color: 'red' })]),
		['red', 'teal', '#ffffff', 'none']);
});

/** Переход по кругу между заметками списка окна. */
test('resolveAdjacentQuickNoteId wraps around and ignores unknown notes', () => {
	assert.equal(resolveAdjacentQuickNoteId(['a', 'b', 'c'], 'c', 'next'), 'a');
	assert.equal(resolveAdjacentQuickNoteId(['a', 'b', 'c'], 'a', 'previous'), 'c');
	assert.equal(resolveAdjacentQuickNoteId(['a'], 'a', 'next'), null);
	assert.equal(resolveAdjacentQuickNoteId(['a', 'b'], 'x', 'next'), null);
});

/** Доска: отбор, группы по цвету и области, колонки по очереди и их число по ширине. */
test('board helpers select, group and distribute notes', () => {
	const notes = [
		note('a', { order: 1, color: 'red' }), note('b', { order: 2 }, 'global'), note('c', { order: 3, color: 'red' }, 'global'),
		note('d', { done: true, completedAt: 'T' }),
	];
	assert.deepEqual(resolveQuickNotesBoardNotes(notes, {}).map(entry => entry.id), ['a', 'b', 'c']);
	assert.deepEqual(resolveQuickNotesBoardNotes(notes, { showDone: true }).map(entry => entry.id), ['a', 'b', 'c', 'd']);
	const byColor = groupQuickNotesForBoard(resolveQuickNotesBoardNotes(notes, {}), 'color', notes);
	assert.deepEqual(byColor.map(group => [group.key, group.notes.map(entry => entry.id)]), [['red', ['a', 'c']], ['none', ['b']]]);
	assert.deepEqual(groupQuickNotesForBoard([], 'color', []).map(group => group.key), ['none']);
	const byScope = groupQuickNotesForBoard(resolveQuickNotesBoardNotes(notes, {}), 'scope', notes, ['global']);
	assert.deepEqual(byScope.map(group => [group.key, group.notes.length]), [['global', 2]]);
	assert.deepEqual(distributeQuickNotesIntoColumns([1, 2, 3, 4, 5], 2), [[1, 3, 5], [2, 4]]);
	assert.deepEqual(distributeQuickNotesIntoColumns([1], 0), [[1]]);
	assert.equal(resolveQuickNotesBoardColumnCount(1000), 4);
	assert.equal(resolveQuickNotesBoardColumnCount(100), 1);
	assert.equal(resolveQuickNotesBoardColumnCount(Number.NaN), 1);
});

/** Перенос в колонку другого цвета меняет цвет и позицию, в колонку другой области — область. */
test('planQuickNoteBoardMove changes group attributes together with order', () => {
	const notes = [note('a', { order: 0, color: 'red' }), note('b', { order: 10 }), note('c', { order: 20, color: 'red' }, 'global')];
	const toColor = planQuickNoteBoardMove({ notes, movingId: 'b', movingScope: 'workspace', target: { kind: 'group', groupKey: 'red' }, groupBy: 'color', at: 'T' });
	assert.deepEqual(toColor, [
		{ kind: 'update', scope: 'workspace', id: 'b', patch: { color: 'red' }, at: 'T' },
		{ kind: 'setOrders', orders: { b: 20 + QUICK_NOTE_ORDER_STEP } },
	]);
	const toScope = planQuickNoteBoardMove({ notes, movingId: 'a', movingScope: 'workspace', target: { kind: 'note', noteId: 'c', placement: 'before' }, groupBy: 'scope', at: 'T' });
	assert.deepEqual(toScope, [{ kind: 'changeScope', scope: 'workspace', id: 'a', toScope: 'global', order: 15, at: 'T' }]);
	const sameGroup = planQuickNoteBoardMove({ notes, movingId: 'a', movingScope: 'workspace', target: { kind: 'note', noteId: 'b', placement: 'after' }, groupBy: 'none', at: 'T' });
	assert.deepEqual(sameGroup, [{ kind: 'setOrders', orders: { a: 15 } }]);
	assert.deepEqual(planQuickNoteBoardMove({ notes, movingId: 'a', movingScope: 'workspace', target: { kind: 'note', noteId: 'a', placement: 'after' }, groupBy: 'none', at: 'T' }), []);
});

/** Текст промпта собирается из описания и чек-листа с исходными отметками. */
test('buildQuickNotePromptContent combines description and checklist', () => {
	assert.equal(buildQuickNotePromptContent({
		title: 'T', description: ' Описание ', items: [{ id: '1', text: 'Сделать', done: false }, { id: '2', text: 'Готово', done: true }, { id: '3', text: ' ', done: false }],
	}), 'Описание\n\n- [ ] Сделать\n- [x] Готово');
	assert.equal(buildQuickNotePromptContent({ title: ' Только название ', description: '', items: [] }), 'Только название');
});

/** Имена копий безопасны, идемпотентны и уникальны без превышения предельной длины. */
test('stored file names are safe, idempotent and unique', () => {
	for (const name of ['../../etc/passwd', ' .bashrc', 'a<b>:c?.txt', '...', '\u0001x.png', 'C:\\Users\\a\\b.txt']) {
		const safe = sanitizeQuickNoteFileName(name);
		assert.equal(sanitizeQuickNoteFileName(safe), safe, name);
		assert.equal(isSafeQuickNoteStoredName(safe), true, name);
	}
	assert.equal(sanitizeQuickNoteFileName('../../etc/passwd'), 'passwd');
	assert.equal(sanitizeQuickNoteFileName('...'), 'file');
	assert.equal(buildQuickNoteStoredName('a.png', new Set(['a.png'])), 'a (2).png');
	assert.equal(buildQuickNoteStoredName('A.png', new Set(['a.png', 'a (2).png'])), 'A (3).png');
	const longName = `${'x'.repeat(118)}.png`;
	const unique = buildQuickNoteStoredName(longName, new Set([sanitizeQuickNoteFileName(longName).toLowerCase()]));
	assert.equal(unique.length <= 120, true);
	assert.equal(isSafeQuickNoteStoredName(unique), true);
	const longExtension = `a.${'e'.repeat(200)}`;
	const withLongExtension = buildQuickNoteStoredName(longExtension, new Set([sanitizeQuickNoteFileName(longExtension).toLowerCase()]));
	assert.equal(isSafeQuickNoteStoredName(withLongExtension), true);
	assert.equal(isSafeQuickNoteDirectoryId('0f8e-ab_1'), true);
	assert.equal(isSafeQuickNoteDirectoryId('../x'), false);
	assert.equal(isSafeQuickNoteDirectoryId('.pending'), false);
});

/** Типы заметки файла и представления совместимы: стираются только поля представления. */
test('toStoredQuickNote removes scope and preview addresses', () => {
	const stored: QuickNote = toStoredQuickNote(note('a', { previewUris: { f: 'u' } }));
	assert.equal('scope' in stored, false);
	assert.equal('previewUris' in stored, false);
});

/** Старый черновик окна не стирает ссылку на промпт и не откатывает перенос, выполненные без смены даты. */
test('replace keeps prompt link and order changed while the draft was open', () => {
	const original = note('a', { updatedAt: 'T1', order: 10 });
	const draft = { ...createQuickNoteDraft(original), title: 'Правка' };
	let notes: QuickNoteView[] = [original];
	notes = applyQuickNoteOperation(notes, { kind: 'setPrompt', scope: 'workspace', id: 'a', prompt: { id: 'p1', promptUuid: 'u1' } }).notes;
	notes = applyQuickNoteOperation(notes, { kind: 'setOrders', orders: { a: -50 } }).notes;
	const saved = applyQuickNoteOperation(notes, buildQuickNoteReplaceOperation(draft, original, 'T2'));
	assert.equal(saved.result.ok, true);
	assert.equal(saved.notes[0].title, 'Правка');
	assert.deepEqual(saved.notes[0].prompt, { id: 'p1', promptUuid: 'u1' });
	assert.equal(saved.notes[0].order, -50);
});

/** «Перезаписать» после переноса заметки в другом окне ищет её в текущей области и сохраняет черновик. */
test('forced replace from the current scope saves a draft after another window moved the note', () => {
	const original = note('a', { updatedAt: 'T1', description: 'старое' });
	const movedByOtherWindow = { ...original, scope: 'global' as const, updatedAt: 'T2' };
	const draft = { ...createQuickNoteDraft(original), description: 'моё' };
	const stale = applyQuickNoteOperation([movedByOtherWindow], buildQuickNoteReplaceOperation(draft, original, 'T3', { force: true }));
	assert.equal(stale.result.code, 'not-found');
	const operation = buildQuickNoteReplaceOperation(draft, original, 'T3', { force: true, sourceScope: 'global' });
	assert.deepEqual([operation.scope, operation.toScope], ['global', 'workspace']);
	const saved = applyQuickNoteOperation([movedByOtherWindow], operation);
	assert.deepEqual(saved.result, { ok: true });
	assert.deepEqual(saved.notes.map(entry => [entry.scope, entry.description]), [['workspace', 'моё']]);
});

/** Операции webview проверяются на границе расширения: неверная форма отклоняется, лишние поля отбрасываются. */
test('parseQuickNoteWebviewOperation accepts valid operations and rejects malformed ones', () => {
	assert.deepEqual(
		parseQuickNoteWebviewOperation({ kind: 'update', scope: 'workspace', id: 'a', at: 'T', patch: { done: true, scope: 'global', id: 'b' } }),
		{ kind: 'update', scope: 'workspace', id: 'a', at: 'T', patch: { done: true } },
	);
	assert.deepEqual(parseQuickNoteWebviewOperation({ kind: 'clearDone', extra: 1 }), { kind: 'clearDone' });
	assert.deepEqual(
		parseQuickNoteWebviewOperation({ kind: 'changeScope', scope: 'global', toScope: 'workspace', id: 'a', at: 'T', order: 5 }),
		{ kind: 'changeScope', scope: 'global', toScope: 'workspace', id: 'a', at: 'T', order: 5 },
	);
	const replace = { kind: 'replace', scope: 'workspace', toScope: 'global', note: note('a'), baseUpdatedAt: 'T', draftId: 'd1' };
	assert.equal(parseQuickNoteWebviewOperation(replace)?.kind, 'replace');
	const malformed: unknown[] = [
		null, 'delete', [], { kind: 'unknown' },
		{ kind: 'changeScope', scope: 'global', toScope: 'bogus', id: 'a', at: 'T' },
		{ kind: 'update', scope: 'other', id: 'a', at: 'T', patch: {} },
		{ kind: 'update', scope: 'workspace', id: 'a', at: 'T', patch: { done: 'yes' } },
		{ kind: 'delete', scope: 'workspace', id: '' },
		{ kind: 'setOrders', orders: { a: Number.NaN } },
		{ kind: 'setItemDone', scope: 'workspace', id: 'a', itemId: 'i', done: 1, at: 'T' },
		{ ...replace, draftId: '../d1' },
		{ ...replace, note: { ...note('a'), files: [{ id: 'f' }] } },
		{ kind: 'setPrompt', scope: 'workspace', id: 'a', prompt: null },
	];
	for (const value of malformed) {
		assert.equal(parseQuickNoteWebviewOperation(value), null, JSON.stringify(value));
	}
});


/** Большой текст из поля названия целиком переносится в описание, а краткое название ожидает AI. */
test('quick note creation keeps long first-line text in description and requests AI title', () => {
	const long = 'При запуске проекта необходимо проверить конфигурацию окружения, сохранить все текущие переменные, изучить ошибки в логах и подготовить исправления.';
	const prepared = prepareQuickNoteCreationInput(long);
	assert.equal(prepared.description, long);
	assert.equal(prepared.autoTitle, true);
	assert.ok(prepared.title.length <= 73);
	assert.ok(!prepared.title.includes('подготовить исправления'));
	const multiline = prepareQuickNoteCreationInput(long + '\nВторая строка с подробностями.', 'Третья строка.');
	assert.equal(multiline.description, long + '\nВторая строка с подробностями.\nТретья строка.');
	assert.equal(multiline.autoTitle, true);
	const concise = prepareQuickNoteCreationInput('Исправить доступ', 'Подробное многострочное описание'.repeat(50));
	assert.equal(concise.title, 'Исправить доступ');
	assert.equal(concise.autoTitle, undefined);
	assert.deepEqual(prepareQuickNoteCreationInput(''), { title: '', description: '' });
	assert.equal(normalizeQuickNoteAiTitle('## Проверка подключения и маршрутизации\nпояснение'), 'Проверка подключения и маршрутизации');
});

/** Дополнительное поле create проверяется на границе IPC; внутреннюю операцию менять через webview нельзя. */
test('AI title metadata is accepted only on create; internal generated-title update remains private', () => {
	const n = note('auto', { title: 'Короткая подпись', description: 'Описание' });
	const input = { kind: 'create', scope: 'workspace', note: n, autoTitle: true };
	assert.equal((parseQuickNoteWebviewOperation(input) as any)?.autoTitle, true);
	assert.equal(parseQuickNoteWebviewOperation({ ...input, autoTitle: 'true' }), null);
	assert.equal(parseQuickNoteWebviewOperation({
		kind: 'setGeneratedTitle', scope: 'workspace', id: n.id,
		expectedTitle: n.title, expectedDescription: n.description, title: 'AI', at: 'T',
	}), null);
});

/** Ответ AI применяется условно, чтобы не затереть ручное редактирование текста или названия. */
test('generated quick note title never overwrites a manually edited note', () => {
	const initial = note('a', { title: 'Предварительно', description: 'Большое описание' });
	const op = {
		kind: 'setGeneratedTitle' as const, scope: 'workspace' as const, id: 'a',
		expectedTitle: initial.title, expectedDescription: initial.description,
		title: 'Новый AI-заголовок', at: '2026-11-19T00:00:00.000Z',
	};
	assert.equal(applyQuickNoteOperation([initial], op).notes[0].title, 'Новый AI-заголовок');
	assert.equal(applyQuickNoteOperation([
		{ ...initial, title: 'Пользовательское название' },
	], op).notes[0].title, 'Пользовательское название');
	assert.equal(applyQuickNoteOperation([
		{ ...initial, description: 'Описание дополнено пользователем' },
	], op).notes[0].title, 'Предварительно');
	assert.deepEqual(getQuickNoteOperationScopes(op), ['workspace']);
});


/** Removing a deleted prompt's link must never clear a replacement association from another window. */
test('clearing a deleted prompt link matches the original id and UUID only', () => {
	const old = note('a', { prompt: { id: 'prompt-a', promptUuid: 'uuid-a' } });
	const other = note('b', { prompt: { id: 'prompt-a', promptUuid: 'uuid-new' } });
	const operation = {
		kind: 'clearDeletedPromptLink' as const,
		scope: 'workspace' as const, id: 'a',
		promptId: 'prompt-a', promptUuid: 'uuid-a',
	};
	const removed = applyQuickNoteOperation([old, other], operation);
	assert.equal(removed.result.ok, true);
	assert.equal(removed.notes[0].prompt, undefined);
	assert.deepEqual(removed.notes[1].prompt, other.prompt);
	const changed = applyQuickNoteOperation([{ ...old, prompt: { id: 'prompt-a', promptUuid: 'uuid-new' } }], operation);
	assert.equal(changed.notes[0].prompt?.promptUuid, 'uuid-new');
	const noLink = applyQuickNoteOperation(removed.notes, operation);
	assert.equal(noLink.result.ok, true);
	assert.deepEqual(getQuickNoteOperationScopes(operation), ['workspace']);
	assert.equal(parseQuickNoteWebviewOperation(operation), null);
});

/** Completed stickies can also be reordered; order changes stay in the completed partition. */
test('moving completed quick notes updates their order within completed notes', () => {
	const notes = [
		note('open', { order: 0 }),
		note('done-a', { order: 10, done: true }),
		note('done-b', { order: 20, done: true }),
	];
	const planned = planQuickNoteBoardMove({
		notes, movingId: 'done-a', movingScope: 'workspace',
		target: { kind: 'note', noteId: 'done-b', placement: 'after' },
		groupBy: 'none', at: 'T',
	});
	assert.equal(planned.length > 0, true);
	const updated = planned.reduce((current, op) => applyQuickNoteOperation(current, op).notes, notes);
	assert.deepEqual(splitQuickNotes(updated).done.map(x => x.id), ['done-b', 'done-a']);
});

/** Операция create из webview не выставляет ссылку на промпт и записи файлов (parseQuickNoteWebviewOperation). */
test('parseQuickNoteWebviewOperation strips the prompt link and files from created notes', () => {
	const created = {
		...toStoredQuickNote(note('new')),
		prompt: { id: 'foreign-prompt', promptUuid: 'foreign-uuid' },
		files: [{ id: 'f1', name: 'a.png', storedName: 'a.png', size: 1, addedAt: 'T' }],
		extra: 'keep',
	};
	const parsed = parseQuickNoteWebviewOperation({ kind: 'create', scope: 'global', note: created, autoTitle: true });
	assert.equal(parsed?.kind, 'create');
	const parsedNote = (parsed as Extract<typeof parsed, { kind: 'create' }>).note as QuickNote & { extra?: string };
	assert.equal('prompt' in parsedNote, false);
	assert.deepEqual(parsedNote.files, []);
	assert.equal(parsedNote.extra, 'keep');
	assert.equal((parsed as { autoTitle?: boolean }).autoTitle, true);
	const applied = applyQuickNoteOperation([], parsed!);
	assert.equal(applied.notes[0].prompt, undefined);
	assert.deepEqual(applied.notes[0].files, []);
});

/** Записи файлов подтверждённого сохранения переносятся в черновик по id (syncQuickNoteFilesWithSaved). */
test('syncQuickNoteFilesWithSaved takes renamed copies by id and keeps later draft files', () => {
	const first = { id: 'f1', name: 'a.png', storedName: 'a.png', size: 1, addedAt: 'T' };
	const second = { id: 'f2', name: 'a.png', storedName: 'a.png', size: 2, addedAt: 'T' };
	const added = { id: 'f3', name: 'b.png', storedName: 'b.png', size: 3, addedAt: 'T' };
	const saved = note('a', { files: [first, { ...second, storedName: 'a (2).png' }] });
	const draft = note('a', { description: 'правка после сохранения', files: [first, second, added] });
	const synced = syncQuickNoteFilesWithSaved(draft, saved);
	assert.deepEqual(synced.files.map(file => file.storedName), ['a.png', 'a (2).png', 'b.png']);
	assert.equal(synced.description, 'правка после сохранения');
	// Убранный после сохранения файл не возвращается, совпадающие записи не создают новый объект.
	const removed = note('a', { files: [first] });
	assert.equal(syncQuickNoteFilesWithSaved(removed, saved), removed);
	assert.equal(syncQuickNoteFilesWithSaved(saved, { files: saved.files.map(file => ({ ...file })) }), saved);
});

/** Внешнее AI-название принимается без конфликта только при единственном отличии в названии. */
test('canAcceptQuickNoteExternalTitle accepts only title-only external changes', () => {
	const original = note('a', { title: 'Длинная первая строка…', description: 'Текст заметки' });
	const draft = { ...original, description: 'Текст заметки и новая правка' };
	// Порядок ключей и дата изменения не важны: версия от расширения пришла из файла.
	const { title: _title, ...rest } = original;
	const external = { title: 'Краткое название', ...rest, updatedAt: '2026-11-18T09:00:00.000Z' };
	assert.equal(canAcceptQuickNoteExternalTitle(original, draft, external), true);
	// Позиция и ссылка на промпт не мешают: сохранение черновика берёт их из текущей версии.
	assert.equal(canAcceptQuickNoteExternalTitle(original, draft, {
		...external, order: 5, prompt: { id: 'p', promptUuid: 'u' },
	}), true);
	assert.equal(canAcceptQuickNoteExternalTitle(original, { ...draft, title: 'Своё название' }, external), false);
	assert.equal(canAcceptQuickNoteExternalTitle(original, draft, { ...external, description: 'Чужая правка' }), false);
	assert.equal(canAcceptQuickNoteExternalTitle(original, draft, { ...external, color: 'red' }), false);
	assert.equal(canAcceptQuickNoteExternalTitle(original, draft, { ...external, scope: 'global' }), false);
	assert.equal(canAcceptQuickNoteExternalTitle(original, draft, {
		...external, items: [{ id: 'i1', text: 'Пункт', done: false }],
	}), false);
	const withUnknownField = { ...external, unknownField: 1 } as QuickNoteView;
	assert.equal(canAcceptQuickNoteExternalTitle(original, draft, withUnknownField), false);
});
