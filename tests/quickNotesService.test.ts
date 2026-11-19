import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	QuickNotesService,
	type QuickNotesServiceOptions,
	type QuickNotesWatcherFactory,
} from '../src/services/quickNotesService.js';
import type { QuickNote, QuickNoteOperation } from '../src/types/quickNotes.js';

/** Фиксированное время сервиса: даты вложений и возраст черновиков не зависят от часов машины. */
const NOW = new Date('2026-11-18T10:00:00.000Z');

/** Временные папки обеих областей и сервис над ними; всё удаляется после теста. */
function createFixture(t: TestContext, options: Partial<QuickNotesServiceOptions> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-notes-'));
	const workspaceDir = path.join(root, 'workspace', '.vscode', 'prompt-manager');
	const globalDir = path.join(root, 'home', '.vscode', 'prompt-manager');
	const service = new QuickNotesService({
		workspaceStorageDir: workspaceDir,
		globalStorageDir: globalDir,
		now: () => NOW,
		...options,
	});
	t.after(() => {
		service.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	});
	return { root, workspaceDir, globalDir, service };
}

/** Заметка с обязательными полями; переопределения задают проверяемое отличие. */
function makeNote(id: string, overrides: Partial<QuickNote> = {}): QuickNote {
	return {
		id,
		title: `Заметка ${id}`,
		description: '',
		color: '',
		done: false,
		order: 0,
		items: [],
		files: [],
		createdAt: '2026-11-18T09:00:00.000Z',
		updatedAt: '2026-11-18T09:00:00.000Z',
		...overrides,
	};
}

/** Путь quick-notes.json в папке области. */
function notesFile(storageDir: string): string {
	return path.join(storageDir, 'quick-notes.json');
}

/** Сырой текст и разобранное содержимое quick-notes.json. */
function readNotesFile(storageDir: string): { raw: string; json: { version: number; notes: Array<Record<string, any>>; [key: string]: unknown } } {
	const raw = fs.readFileSync(notesFile(storageDir), 'utf-8');
	return { raw, json: JSON.parse(raw) };
}

/** Папка вложений заметки или черновика в области. */
function filesDir(storageDir: string, ...segments: string[]): string {
	return path.join(storageDir, 'quick-notes-files', ...segments);
}

/** Применяет операцию и требует успешный результат. */
async function applyOk(service: QuickNotesService, operation: QuickNoteOperation): Promise<void> {
	const { result } = await service.applyOperation(operation);
	assert.deepEqual(result, { ok: true });
}

/** Ждёт условие коротким опросом с ограниченным таймаутом вместо фиксированной паузы. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error('Условие не выполнено за отведённое время.');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

/** Сохраняет в рабочей области заметку с файлами через черновик и возвращает сохранённую версию. */
async function createNoteWithFiles(
	service: QuickNotesService,
	scope: 'workspace' | 'global',
	id: string,
	files: Array<{ name: string; data: Uint8Array }>,
): Promise<QuickNote> {
	const note = makeNote(id);
	await applyOk(service, { kind: 'create', scope, note });
	const imported = await service.importFiles({ scope, draftId: `draft-${id}`, sources: files });
	const saved = { ...note, files: imported.files, updatedAt: '2026-11-18T09:30:00.000Z' };
	await applyOk(service, { kind: 'replace', scope, toScope: scope, note: saved, baseUpdatedAt: note.updatedAt, draftId: `draft-${id}` });
	return saved;
}

test('getState returns empty available scopes without creating files', async t => {
	const { service, workspaceDir, globalDir } = createFixture(t);

	const state = await service.getState();

	assert.deepEqual(state.notes, []);
	assert.deepEqual(state.scopes.workspace, { scope: 'workspace', available: true, filePath: notesFile(workspaceDir) });
	assert.deepEqual(state.scopes.global, { scope: 'global', available: true, filePath: notesFile(globalDir) });
	assert.equal(service.getFilesRoot('global'), filesDir(globalDir));
	assert.equal(fs.existsSync(workspaceDir), false);
});

test('workspace without folder is unavailable while global operations still work', async t => {
	const { service, globalDir } = createFixture(t, { workspaceStorageDir: null });

	const state = await service.getState();
	assert.deepEqual(state.scopes.workspace, { scope: 'workspace', available: false, filePath: '' });
	assert.equal(service.getStorageDir('workspace'), null);
	assert.equal(service.getFilesRoot('workspace'), null);

	const { result } = await service.applyOperation({ kind: 'create', scope: 'workspace', note: makeNote('w1') });
	assert.equal(result.ok, false);
	assert.equal(result.code, 'unavailable');

	// Операции над всеми заметками обходят недоступную область.
	await applyOk(service, { kind: 'create', scope: 'global', note: makeNote('g1', { done: true }) });
	await applyOk(service, { kind: 'clearDone' });
	assert.deepEqual(readNotesFile(globalDir).json.notes, []);
});

test('operations update the file in readable format and keep positions', async t => {
	const { service, workspaceDir } = createFixture(t);
	const first = makeNote('a', { items: [{ id: 'i1', text: 'Пункт', done: false }] });

	await applyOk(service, { kind: 'create', scope: 'workspace', note: first });
	await applyOk(service, { kind: 'create', scope: 'workspace', note: makeNote('b') });
	let file = readNotesFile(workspaceDir);
	assert.equal(file.raw, `${JSON.stringify(file.json, null, 2)}\n`);
	assert.equal(file.json.version, 1);
	assert.deepEqual(file.json.notes.map(note => note.id), ['b', 'a']);

	await applyOk(service, { kind: 'update', scope: 'workspace', id: 'a', patch: { title: 'Новое' }, at: '2026-11-18T09:10:00.000Z' });
	await applyOk(service, { kind: 'setItemDone', scope: 'workspace', id: 'a', itemId: 'i1', done: true, at: '2026-11-18T09:11:00.000Z' });
	await applyOk(service, { kind: 'setOrders', orders: { a: 5, b: 7 } });
	file = readNotesFile(workspaceDir);
	assert.deepEqual(file.json.notes.map(note => [note.id, note.order]), [['b', 7], ['a', 5]]);
	assert.equal(file.json.notes[1].title, 'Новое');
	assert.equal(file.json.notes[1].items[0].done, true);
	assert.equal(file.json.notes[1].updatedAt, '2026-11-18T09:11:00.000Z');

	await applyOk(service, { kind: 'update', scope: 'workspace', id: 'b', patch: { done: true }, at: '2026-11-18T09:12:00.000Z' });
	assert.equal(readNotesFile(workspaceDir).json.notes[0].completedAt, '2026-11-18T09:12:00.000Z');
	await applyOk(service, { kind: 'clearDone' });
	assert.deepEqual(readNotesFile(workspaceDir).json.notes.map(note => note.id), ['a']);

	// Операция без изменений не переписывает файл, даже с иным форматированием.
	const custom = JSON.stringify(readNotesFile(workspaceDir).json, null, 4);
	fs.writeFileSync(notesFile(workspaceDir), custom);
	await applyOk(service, { kind: 'create', scope: 'workspace', note: first });
	assert.equal(fs.readFileSync(notesFile(workspaceDir), 'utf-8'), custom);

	await applyOk(service, { kind: 'delete', scope: 'workspace', id: 'a' });
	assert.deepEqual(readNotesFile(workspaceDir).json.notes, []);
});

test('unknown top-level and note fields survive writes', async t => {
	const { service, workspaceDir } = createFixture(t);
	fs.mkdirSync(workspaceDir, { recursive: true });
	fs.writeFileSync(notesFile(workspaceDir), JSON.stringify({
		version: 1,
		app: { theme: 'warm' },
		notes: [{ ...makeNote('a'), custom: { key: 1 }, items: [{ id: 'i1', text: 'x', done: false, extra: true }] }],
	}));

	await applyOk(service, { kind: 'update', scope: 'workspace', id: 'a', patch: { color: 'red' }, at: '2026-11-18T09:20:00.000Z' });
	await applyOk(service, { kind: 'create', scope: 'workspace', note: makeNote('b') });

	const { json } = readNotesFile(workspaceDir);
	assert.deepEqual(json.app, { theme: 'warm' });
	assert.deepEqual(json.notes.map(note => note.id), ['b', 'a']);
	assert.deepEqual(json.notes[1].custom, { key: 1 });
	assert.equal(json.notes[1].items[0].extra, true);
	assert.equal(json.notes[1].color, 'red');
});

test('corrupted file is reported and never overwritten', async t => {
	const { service, workspaceDir, globalDir } = createFixture(t);
	const broken = '{"version": 1, "notes": [';
	fs.mkdirSync(workspaceDir, { recursive: true });
	fs.writeFileSync(notesFile(workspaceDir), broken);
	await applyOk(service, { kind: 'create', scope: 'global', note: makeNote('g1', { done: true }) });

	const state = await service.getState();
	assert.match(state.scopes.workspace.error ?? '', /^Файл quick-notes\.json повреждён: /);
	assert.deepEqual(state.notes.map(note => note.id), ['g1']);

	const { result } = await service.applyOperation({ kind: 'create', scope: 'workspace', note: makeNote('w1') });
	assert.equal(result.code, 'read-only');
	await applyOk(service, { kind: 'clearDone' });
	assert.equal(fs.readFileSync(notesFile(workspaceDir), 'utf-8'), broken);
	assert.deepEqual(readNotesFile(globalDir).json.notes, []);
});

test('concurrent creates from one or two services keep every note', async t => {
	const { service, workspaceDir, globalDir } = createFixture(t);
	// Второй экземпляр моделирует другое окно VS Code над теми же файлами.
	const other = new QuickNotesService({ workspaceStorageDir: workspaceDir, globalStorageDir: globalDir });
	t.after(() => other.dispose());

	const ids = ['n1', 'n2', 'n3', 'n4', 'n5'];
	const results = await Promise.all(ids.map(id => service.applyOperation({ kind: 'create', scope: 'global', note: makeNote(id) })));
	assert.ok(results.every(({ result }) => result.ok));
	assert.deepEqual(readNotesFile(globalDir).json.notes.map(note => note.id).sort(), ids);

	const windows = await Promise.all([
		service.applyOperation({ kind: 'create', scope: 'workspace', note: makeNote('a1') }),
		other.applyOperation({ kind: 'create', scope: 'workspace', note: makeNote('b1') }),
		service.applyOperation({ kind: 'create', scope: 'workspace', note: makeNote('a2') }),
		other.applyOperation({ kind: 'create', scope: 'workspace', note: makeNote('b2') }),
	]);
	assert.ok(windows.every(({ result }) => result.ok));
	assert.deepEqual(readNotesFile(workspaceDir).json.notes.map(note => note.id).sort(), ['a1', 'a2', 'b1', 'b2']);
});

test('draft files move into the note folder on replace, removed and conflicting drafts are handled', async t => {
	const { service, workspaceDir, root } = createFixture(t);
	const note = makeNote('n1');
	await applyOk(service, { kind: 'create', scope: 'workspace', note });
	const reportPath = path.join(root, 'report.txt');
	fs.writeFileSync(reportPath, 'отчёт');
	const folderPath = path.join(root, 'folder');
	fs.mkdirSync(folderPath);
	const missingPath = path.join(root, 'missing.txt');

	const imported = await service.importFiles({
		scope: 'workspace',
		draftId: 'draft1',
		sources: [{ path: reportPath }, { name: 'image.png', data: Uint8Array.from([1, 2, 3]) }, { path: folderPath }, { path: missingPath }],
	});
	assert.deepEqual(imported.skipped, [folderPath, missingPath]);
	assert.deepEqual(imported.files.map(file => [file.name, file.storedName, file.size, file.addedAt]), [
		['report.txt', 'report.txt', Buffer.byteLength('отчёт'), NOW.toISOString()],
		['image.png', 'image.png', 3, NOW.toISOString()],
	]);
	assert.ok(fs.existsSync(filesDir(workspaceDir, '.pending', 'draft1', 'report.txt')));

	const saved = { ...note, files: imported.files, updatedAt: '2026-11-18T09:30:00.000Z' };
	await applyOk(service, { kind: 'replace', scope: 'workspace', toScope: 'workspace', note: saved, baseUpdatedAt: note.updatedAt, draftId: 'draft1' });
	assert.deepEqual(fs.readdirSync(filesDir(workspaceDir, 'n1')).sort(), ['image.png', 'report.txt']);
	assert.equal(fs.existsSync(filesDir(workspaceDir, '.pending', 'draft1')), false);

	// Новая копия с тем же именем получает суффикс, удалённый в черновике файл исчезает из папки.
	const second = await service.importFiles({ scope: 'workspace', draftId: 'draft2', sources: [{ name: 'image.png', data: Uint8Array.from([9]) }] });
	const keptImage = imported.files[1];
	const updated = { ...saved, files: [keptImage, ...second.files], updatedAt: '2026-11-18T09:40:00.000Z' };
	await applyOk(service, { kind: 'replace', scope: 'workspace', toScope: 'workspace', note: updated, baseUpdatedAt: saved.updatedAt, draftId: 'draft2' });
	const stored = readNotesFile(workspaceDir).json.notes[0];
	assert.deepEqual(stored.files.map((file: { storedName: string }) => file.storedName), ['image.png', 'image (2).png']);
	assert.deepEqual(fs.readdirSync(filesDir(workspaceDir, 'n1')).sort(), ['image (2).png', 'image.png']);
	assert.deepEqual([...fs.readFileSync(filesDir(workspaceDir, 'n1', 'image.png'))], [1, 2, 3]);
	assert.deepEqual([...fs.readFileSync(filesDir(workspaceDir, 'n1', 'image (2).png'))], [9]);

	// Устаревшая база сохранения: конфликт без изменения файлов заметки и черновика.
	const third = await service.importFiles({ scope: 'workspace', draftId: 'draft3', sources: [{ name: 'c.txt', data: Uint8Array.from([7]) }] });
	const before = fs.readFileSync(notesFile(workspaceDir), 'utf-8');
	const { result } = await service.applyOperation({
		kind: 'replace', scope: 'workspace', toScope: 'workspace', draftId: 'draft3',
		note: { ...saved, files: third.files, updatedAt: '2026-11-18T09:50:00.000Z' }, baseUpdatedAt: saved.updatedAt,
	});
	assert.equal(result.code, 'conflict');
	assert.equal(fs.readFileSync(notesFile(workspaceDir), 'utf-8'), before);
	assert.ok(fs.existsSync(filesDir(workspaceDir, '.pending', 'draft3', 'c.txt')));
	assert.deepEqual(fs.readdirSync(filesDir(workspaceDir, 'n1')).sort(), ['image (2).png', 'image.png']);

	await service.discardDraft('workspace', 'draft3');
	assert.equal(fs.existsSync(filesDir(workspaceDir, '.pending', 'draft3')), false);
});

test('replace with scope change moves the note and its files between scopes', async t => {
	const { service, workspaceDir, globalDir } = createFixture(t);
	const saved = await createNoteWithFiles(service, 'workspace', 'n1', [{ name: 'a.txt', data: Uint8Array.from([1]) }]);
	const draft = await service.importFiles({ scope: 'workspace', draftId: 'move', sources: [{ name: 'b.txt', data: Uint8Array.from([2]) }] });

	await applyOk(service, {
		kind: 'replace', scope: 'workspace', toScope: 'global', draftId: 'move', baseUpdatedAt: saved.updatedAt,
		note: { ...saved, files: [...saved.files, ...draft.files], updatedAt: '2026-11-18T09:45:00.000Z' },
	});

	assert.deepEqual(readNotesFile(workspaceDir).json.notes, []);
	assert.deepEqual(readNotesFile(globalDir).json.notes.map(note => note.id), ['n1']);
	assert.deepEqual(fs.readdirSync(filesDir(globalDir, 'n1')).sort(), ['a.txt', 'b.txt']);
	assert.equal(fs.existsSync(filesDir(workspaceDir, 'n1')), false);
	assert.equal(fs.existsSync(filesDir(workspaceDir, '.pending', 'move')), false);
	const state = await service.getState();
	assert.deepEqual(state.notes.map(note => [note.scope, note.id]), [['global', 'n1']]);
});

test('changeScope moves the note with its attachment folder', async t => {
	const { service, workspaceDir, globalDir } = createFixture(t);
	await createNoteWithFiles(service, 'global', 'n1', [{ name: 'a.txt', data: Uint8Array.from([1]) }]);

	await applyOk(service, { kind: 'changeScope', scope: 'global', id: 'n1', toScope: 'workspace', order: 10, at: '2026-11-18T09:50:00.000Z' });

	assert.deepEqual(readNotesFile(globalDir).json.notes, []);
	const moved = readNotesFile(workspaceDir).json.notes[0];
	assert.equal(moved.order, 10);
	assert.deepEqual(fs.readdirSync(filesDir(workspaceDir, 'n1')), ['a.txt']);
	assert.equal(fs.existsSync(filesDir(globalDir, 'n1')), false);
});

test('delete removes the attachment folder of the note', async t => {
	const { service, workspaceDir } = createFixture(t);
	await createNoteWithFiles(service, 'workspace', 'n1', [{ name: 'a.txt', data: Uint8Array.from([1]) }]);
	assert.ok(fs.existsSync(filesDir(workspaceDir, 'n1', 'a.txt')));

	await applyOk(service, { kind: 'delete', scope: 'workspace', id: 'n1' });

	assert.equal(fs.existsSync(filesDir(workspaceDir, 'n1')), false);
	assert.deepEqual(readNotesFile(workspaceDir).json.notes, []);
});

test('resolveFilePath prefers the draft copy and rejects unsafe names', async t => {
	const { service, workspaceDir } = createFixture(t);
	await createNoteWithFiles(service, 'workspace', 'n1', [{ name: 'a.txt', data: Uint8Array.from([1]) }]);
	await service.importFiles({ scope: 'workspace', draftId: 'draft', sources: [{ name: 'a.txt', data: Uint8Array.from([2]) }] });

	assert.equal(await service.resolveFilePath({ scope: 'workspace', noteId: 'n1', storedName: 'a.txt' }), filesDir(workspaceDir, 'n1', 'a.txt'));
	assert.equal(
		await service.resolveFilePath({ scope: 'workspace', noteId: 'n1', storedName: 'a.txt', draftId: 'draft' }),
		filesDir(workspaceDir, '.pending', 'draft', 'a.txt'),
	);
	assert.equal(await service.resolveFilePath({ scope: 'workspace', noteId: 'n1', storedName: 'missing.txt' }), null);

	const unsafe = [
		{ noteId: 'n1', storedName: '../quick-notes.json' },
		{ noteId: 'n1', storedName: 'sub/a.txt' },
		{ noteId: 'n1', storedName: '..' },
		{ noteId: '../n1', storedName: 'a.txt' },
		{ noteId: '..', storedName: 'quick-notes.json' },
		{ noteId: 'n1', storedName: 'a.txt', draftId: '../draft' },
	];
	for (const input of unsafe) {
		assert.equal(await service.resolveFilePath({ scope: 'workspace', ...input }), null, JSON.stringify(input));
	}
});

test('own writes do not notify listeners, external writes do', async t => {
	const watchers: Array<{ directory: string; fileName: string; onChange: () => void; disposed: boolean }> = [];
	/** Ручной наблюдатель: тест сам сообщает о событии файла. */
	const createWatcher: QuickNotesWatcherFactory = (directory, fileName, onChange) => {
		const watcher = { directory, fileName, onChange, disposed: false };
		watchers.push(watcher);
		return { dispose: () => { watcher.disposed = true; } };
	};
	const { service, workspaceDir, globalDir } = createFixture(t, { createWatcher, debounceMs: 0 });
	assert.deepEqual(watchers.map(watcher => [watcher.directory, watcher.fileName]), [
		[workspaceDir, 'quick-notes.json'],
		[globalDir, 'quick-notes.json'],
	]);
	let changes = 0;
	service.onDidChange(() => { changes += 1; });
	await applyOk(service, { kind: 'create', scope: 'workspace', note: makeNote('w1') });
	await applyOk(service, { kind: 'create', scope: 'global', note: makeNote('g1') });

	// Проверки идут по очереди: эхо рабочей области проверяется раньше внешней записи глобальной.
	watchers[0].onChange();
	const external = readNotesFile(globalDir).json;
	external.notes.push(makeNote('g2') as unknown as Record<string, unknown>);
	fs.writeFileSync(notesFile(globalDir), JSON.stringify(external));
	watchers[1].onChange();
	await waitFor(() => changes > 0);
	assert.equal(changes, 1);

	service.dispose();
	assert.ok(watchers.every(watcher => watcher.disposed));
});

test('cleanupStalePending removes old draft folders and keeps fresh ones', async t => {
	const { service, workspaceDir, globalDir } = createFixture(t);
	const hour = 60 * 60 * 1000;
	/** Создаёт папку черновика с файлом и заданным возрастом mtime. */
	const makeDraft = (storageDir: string, draftId: string, ageMs: number) => {
		const directory = filesDir(storageDir, '.pending', draftId);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, 'a.txt'), 'a');
		const mtime = new Date(NOW.getTime() - ageMs);
		fs.utimesSync(directory, mtime, mtime);
		return directory;
	};
	const oldWorkspace = makeDraft(workspaceDir, 'old', 48 * hour);
	const oldGlobal = makeDraft(globalDir, 'stale', 25 * hour);
	const fresh = makeDraft(globalDir, 'fresh', hour);

	await service.cleanupStalePending();
	assert.equal(fs.existsSync(oldWorkspace), false);
	assert.equal(fs.existsSync(oldGlobal), false);
	assert.ok(fs.existsSync(fresh));

	await service.cleanupStalePending(30 * 60 * 1000);
	assert.equal(fs.existsSync(fresh), false);
});

test('symlinks inside quick-notes-files are never followed for cleanup, saving, deleting or copying', async t => {
	const { service, workspaceDir, root } = createFixture(t);
	const hour = 60 * 60 * 1000;
	// Чужая папка вне хранилища: ссылки из репозитория не должны её очищать или читать.
	const outside = path.join(root, 'outside');
	const victimDraft = path.join(outside, 'old-project');
	fs.mkdirSync(victimDraft, { recursive: true });
	fs.writeFileSync(path.join(outside, 'secret.txt'), 'секрет');
	const old = new Date(NOW.getTime() - 48 * hour);
	fs.utimesSync(victimDraft, old, old);
	fs.mkdirSync(filesDir(workspaceDir), { recursive: true });
	fs.symlinkSync(outside, filesDir(workspaceDir, '.pending'), 'dir');

	await service.cleanupStalePending();
	assert.ok(fs.existsSync(victimDraft), 'очистка черновиков не идёт по ссылке');
	await assert.rejects(service.importFiles({ scope: 'workspace', draftId: 'd1', sources: [{ name: 'a.txt', data: Uint8Array.from([1]) }] }));
	assert.equal(fs.existsSync(path.join(outside, 'd1')), false);

	// Папка заметки — ссылка: сохранение не удаляет файлы цели, путь к ним не выдаётся, удаление не трогает цель.
	const note = makeNote('n1', { files: [{ id: 'f1', name: 'secret.txt', storedName: 'secret.txt', size: 1, addedAt: NOW.toISOString() }] });
	await applyOk(service, { kind: 'create', scope: 'workspace', note });
	fs.symlinkSync(outside, filesDir(workspaceDir, 'n1'), 'dir');
	assert.equal(await service.resolveFilePath({ scope: 'workspace', noteId: 'n1', storedName: 'secret.txt' }), null);
	const { result } = await service.applyOperation({
		kind: 'replace', scope: 'workspace', toScope: 'workspace', baseUpdatedAt: note.updatedAt,
		note: { ...note, files: [], updatedAt: '2026-11-18T09:30:00.000Z' },
	});
	assert.equal(result.ok, false);
	assert.ok(fs.existsSync(path.join(outside, 'secret.txt')));
	await applyOk(service, { kind: 'delete', scope: 'workspace', id: 'n1' });
	assert.ok(fs.existsSync(path.join(outside, 'secret.txt')));
	assert.ok(fs.existsSync(victimDraft));
});

test('replace fails and keeps the draft when a new attachment cannot be saved', async t => {
	const { service, workspaceDir } = createFixture(t);
	const note = makeNote('n1');
	await applyOk(service, { kind: 'create', scope: 'workspace', note });
	const imported = await service.importFiles({ scope: 'workspace', draftId: 'draft1', sources: [{ name: 'a.txt', data: Uint8Array.from([1]) }] });
	fs.rmSync(filesDir(workspaceDir, '.pending', 'draft1', 'a.txt'));
	const before = fs.readFileSync(notesFile(workspaceDir), 'utf-8');

	const { result } = await service.applyOperation({
		kind: 'replace', scope: 'workspace', toScope: 'workspace', draftId: 'draft1', baseUpdatedAt: note.updatedAt,
		note: { ...note, files: imported.files, updatedAt: '2026-11-18T09:30:00.000Z' },
	});
	assert.equal(result.code, 'failed');
	assert.match(result.message || '', /a\.txt/);
	assert.equal(fs.readFileSync(notesFile(workspaceDir), 'utf-8'), before);

	// id из файла, правленного вручную, не годится для имени папки: новые файлы не теряются молча.
	const manual = makeNote('note 1');
	fs.writeFileSync(notesFile(workspaceDir), JSON.stringify({ version: 1, notes: [manual] }));
	const draft = await service.importFiles({ scope: 'workspace', draftId: 'draft2', sources: [{ name: 'b.txt', data: Uint8Array.from([2]) }] });
	const unsafe = await service.applyOperation({
		kind: 'replace', scope: 'workspace', toScope: 'workspace', draftId: 'draft2', baseUpdatedAt: manual.updatedAt,
		note: { ...manual, files: draft.files, updatedAt: '2026-11-18T09:40:00.000Z' },
	});
	assert.equal(unsafe.result.code, 'failed');
	assert.ok(fs.existsSync(filesDir(workspaceDir, '.pending', 'draft2', 'b.txt')));
	assert.deepEqual(readNotesFile(workspaceDir).json.notes[0].files, []);
});

test('a leftover copy from an interrupted move does not replace the source version', async t => {
	const { service, workspaceDir, globalDir } = createFixture(t);
	// Прерванный перенос: устаревшая копия уже в целевой области, актуальная версия — в исходной.
	fs.mkdirSync(workspaceDir, { recursive: true });
	fs.mkdirSync(globalDir, { recursive: true });
	fs.writeFileSync(notesFile(workspaceDir), JSON.stringify({ version: 1, notes: [makeNote('n1', { description: 'устаревшая' })] }));
	fs.writeFileSync(notesFile(globalDir), JSON.stringify({ version: 1, notes: [makeNote('n1', { description: 'актуальная' })] }));

	await applyOk(service, { kind: 'changeScope', scope: 'global', id: 'n1', toScope: 'workspace', at: '2026-11-18T09:50:00.000Z' });

	assert.deepEqual(readNotesFile(globalDir).json.notes, []);
	assert.deepEqual(readNotesFile(workspaceDir).json.notes.map(note => note.description), ['актуальная']);
});

test('returning a file to the last written text after a manual edit is reported as a change', async t => {
	const watchers: Array<() => void> = [];
	const createWatcher: QuickNotesWatcherFactory = (_directory, _fileName, onChange) => {
		watchers.push(onChange);
		return { dispose: () => undefined };
	};
	const { service, workspaceDir } = createFixture(t, { createWatcher, debounceMs: 0 });
	let changes = 0;
	service.onDidChange(() => { changes += 1; });
	await applyOk(service, { kind: 'create', scope: 'workspace', note: makeNote('w1') });
	const own = fs.readFileSync(notesFile(workspaceDir), 'utf-8');

	fs.writeFileSync(notesFile(workspaceDir), JSON.stringify({ version: 1, notes: [] }));
	watchers[0]();
	await waitFor(() => changes === 1);
	// Отмена ручной правки или git checkout возвращает текст собственной записи: это тоже изменение.
	fs.writeFileSync(notesFile(workspaceDir), own);
	watchers[0]();
	await waitFor(() => changes === 2);
	// Повтор события без изменения текста не уведомляет.
	watchers[0]();
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.equal(changes, 2);
});

test('workspace storage that resolves to the global folder is unavailable', async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-notes-link-'));
	const globalDir = path.join(root, 'home', '.vscode', 'prompt-manager');
	const workspaceVscode = path.join(root, 'workspace', '.vscode');
	fs.mkdirSync(globalDir, { recursive: true });
	fs.mkdirSync(workspaceVscode, { recursive: true });
	fs.symlinkSync(globalDir, path.join(workspaceVscode, 'prompt-manager'), 'dir');
	const service = new QuickNotesService({ workspaceStorageDir: path.join(workspaceVscode, 'prompt-manager'), globalStorageDir: globalDir, now: () => NOW });
	t.after(() => {
		service.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	});
	assert.equal(service.getStorageDir('workspace'), null);
	assert.equal((await service.getState()).scopes.workspace.available, false);
});


/** Chunked uploads from browser files are byte-perfect and never expose partial files in the note. */
test('browser local file chunks are assembled safely into a note draft', async t => {
	const { service, workspaceDir } = createFixture(t);
	const input = Buffer.alloc(512 * 1024 + 31, 0x53);
	const chunkSize = 512 * 1024;
	const upload = async (id: string) => {
		let result = null;
		const count = Math.ceil(input.length / chunkSize);
		for (let index = 0; index < count; index++) {
			result = await service.importBrowserChunk({
				scope: 'workspace', draftId: 'draft-local', uploadId: id, name: 'my-file.txt',
				fileSize: input.length, chunkIndex: index, chunkCount: count,
				dataBase64: input.subarray(index * chunkSize, Math.min(input.length, (index + 1) * chunkSize)).toString('base64'),
			});
			if (index < count - 1) assert.equal(result, null);
		}
		return result;
	};
	const first = await upload('qn-upload-abcdefgh');
	assert.ok(first);
	assert.equal(first!.size, input.length);
	assert.deepEqual(fs.readFileSync(filesDir(workspaceDir, '.pending', 'draft-local', first!.storedName)), input);
	const second = await upload('qn-upload-ijklmnop');
	assert.ok(second);
	assert.notEqual(second!.storedName, first!.storedName);
	assert.deepEqual(fs.readFileSync(filesDir(workspaceDir, '.pending', 'draft-local', first!.storedName)), input);
	assert.deepEqual(fs.readFileSync(filesDir(workspaceDir, '.pending', 'draft-local', second!.storedName)), input);
});

/** Invalid or interrupted browser uploads never create a finished attachment. */
test('browser upload rejects invalid chunks, size limits and unsafe identifiers', async t => {
	const { service, workspaceDir } = createFixture(t);
	const basic = {
		scope: 'workspace' as const, draftId: 'draft-interrupt', uploadId: 'qn-upload-abcd1234',
		name: 'file.txt', fileSize: 512 * 1024 + 2, chunkCount: 2,
	};
	await assert.rejects(service.importBrowserChunk({
		...basic, chunkIndex: 0, dataBase64: Buffer.alloc(512 * 1024).toString('base64'), draftId: '../escape',
	}), /Некорректный/);
	await assert.rejects(service.importBrowserChunk({
		...basic, fileSize: 70 * 1024 * 1024, chunkIndex: 0, dataBase64: Buffer.alloc(512 * 1024).toString('base64'),
	}), /Некорректный/);
	const started = await service.importBrowserChunk({
		...basic, chunkIndex: 0, dataBase64: Buffer.alloc(512 * 1024).toString('base64'),
	});
	assert.equal(started, null);
	await assert.rejects(service.importBrowserChunk({
		...basic, chunkIndex: 1, dataBase64: 'Zm9v',
	}), /размер/);
	await service.cancelBrowserUpload(basic.scope, basic.draftId, basic.uploadId);
	const dir = filesDir(workspaceDir, '.pending', basic.draftId);
	assert.equal(fs.readdirSync(dir).filter(x => x.includes(basic.uploadId)).length, 0);
	await assert.rejects(service.importBrowserChunk({
		...basic, chunkIndex: 1, dataBase64: Buffer.from('hi').toString('base64'),
	}), /Загрузка файла прервана/);
});


/** Removing an unsaved attachment must remove only its pending copy, not any already persisted file. */
test('unsaved file removal deletes its pending copy immediately without touching saved files', async t => {
	const { service, workspaceDir } = createFixture(t);
	const existing = await createNoteWithFiles(service, 'workspace', 'saved-note', [
		{ name: 'saved.txt', data: Buffer.from('saved-content') },
	]);
	const savedFile = existing.files[0];
	const savedPath = filesDir(workspaceDir, 'saved-note', savedFile.storedName);
	const newFile = (await service.importFiles({
		scope: 'workspace', draftId: 'edit-draft',
		sources: [{ name: 'temporary.txt', data: Buffer.from('temporary-content') }],
	})).files[0];
	const pendingPath = filesDir(workspaceDir, '.pending', 'edit-draft', newFile.storedName);
	assert.equal(fs.existsSync(pendingPath), true);
	assert.equal(await service.removeDraftFile('workspace', 'edit-draft', newFile.storedName), true);
	assert.equal(fs.existsSync(pendingPath), false);
	assert.equal(fs.readFileSync(savedPath, 'utf8'), 'saved-content');
	await assert.rejects(service.removeDraftFile('workspace', 'edit-draft', '../saved.txt'), /Некорректный/);
	await service.discardDraft('workspace', 'edit-draft');
	assert.equal(fs.existsSync(filesDir(workspaceDir, '.pending', 'edit-draft')), false);
	assert.equal(fs.readFileSync(savedPath, 'utf8'), 'saved-content');
});

/** Removing a saved file is deferred until the note is saved, and deleting the note removes its folder. */
test('saving removal and deleting note remove persisted attachments', async t => {
	const { service, workspaceDir } = createFixture(t);
	const note = await createNoteWithFiles(service, 'workspace', 'remove-saved-note', [
		{ name: 'a.txt', data: Buffer.from('aaa') },
		{ name: 'b.txt', data: Buffer.from('bbb') },
	]);
	const dir = filesDir(workspaceDir, 'remove-saved-note');
	assert.equal(fs.readdirSync(dir).length, 2);
	// Until Save, user may cancel and retain both files.
	const removed = note.files[0];
	assert.equal(fs.existsSync(path.join(dir, removed.storedName)), true);
	await applyOk(service, {
		kind: 'replace', scope: 'workspace', toScope: 'workspace', baseUpdatedAt: note.updatedAt,
		note: { ...note, files: [note.files[1]], updatedAt: '2026-11-18T10:30:00.000Z' },
	});
	assert.equal(fs.existsSync(path.join(dir, removed.storedName)), false);
	assert.equal(fs.existsSync(path.join(dir, note.files[1].storedName)), true);
	await applyOk(service, { kind: 'delete', scope: 'workspace', id: note.id });
	assert.equal(fs.existsSync(dir), false);
	assert.equal((await service.getState()).notes.some(n => n.id === note.id), false);
});

/** Discarding a draft after an upload or failed save removes all unsaved server copies. */
test('discarding a note edit removes pending upload chunks and draft files', async t => {
	const { service, workspaceDir } = createFixture(t);
	const file = Buffer.from('hello');
	const uploadId = 'qn-upload-cancel1234';
	const uploaded = await service.importBrowserChunk({
		scope: 'workspace', draftId: 'discarded', uploadId,
		name: 'from-windows.txt', fileSize: file.length, chunkIndex: 0, chunkCount: 1,
		dataBase64: file.toString('base64'),
	});
	assert.ok(uploaded);
	const draftDir = filesDir(workspaceDir, '.pending', 'discarded');
	assert.equal(fs.existsSync(path.join(draftDir, uploaded!.storedName)), true);
	await service.discardDraft('workspace', 'discarded');
	assert.equal(fs.existsSync(draftDir), false);
});

/**
 * Повторное сохранение из окна с устаревшим именем копии не удаляет переименованный файл: имена сохранённых
 * вложений берутся из текущей версии заметки (QuickNotesService.planReplace).
 */
test('repeated replace with a stale stored name keeps the renamed attachment', async t => {
	const { service, workspaceDir } = createFixture(t);
	const storedNames = () => readNotesFile(workspaceDir).json.notes[0].files
		.map((file: { storedName: string }) => file.storedName);
	const saved = await createNoteWithFiles(service, 'workspace', 'n1', [{ name: 'a.png', data: Uint8Array.from([1]) }]);
	// Второй файл с тем же именем: в папке черновика он тоже a.png, при сохранении получает суффикс.
	const second = await service.importFiles({
		scope: 'workspace', draftId: 'draft2', sources: [{ name: 'a.png', data: Uint8Array.from([2]) }],
	});
	const withSecond = { ...saved, files: [...saved.files, ...second.files], updatedAt: '2026-11-18T09:40:00.000Z' };
	await applyOk(service, {
		kind: 'replace', scope: 'workspace', toScope: 'workspace', note: withSecond,
		baseUpdatedAt: saved.updatedAt, draftId: 'draft2',
	});
	assert.deepEqual(storedNames(), ['a.png', 'a (2).png']);

	// Окно не знает о переименовании и присылает a.png для обоих файлов, а для первого — небезопасное имя.
	const stale = {
		...withSecond,
		description: 'правка после сохранения',
		files: [{ ...saved.files[0], storedName: '../evil.png' }, { ...second.files[0], storedName: 'a.png' }],
		updatedAt: '2026-11-18T09:50:00.000Z',
	};
	await applyOk(service, {
		kind: 'replace', scope: 'workspace', toScope: 'workspace', note: stale,
		baseUpdatedAt: withSecond.updatedAt, draftId: 'draft3',
	});
	assert.equal(readNotesFile(workspaceDir).json.notes[0].description, 'правка после сохранения');
	assert.deepEqual(storedNames(), ['a.png', 'a (2).png']);
	assert.deepEqual(fs.readdirSync(filesDir(workspaceDir, 'n1')).sort(), ['a (2).png', 'a.png']);
	assert.deepEqual([...fs.readFileSync(filesDir(workspaceDir, 'n1', 'a.png'))], [1]);
	assert.deepEqual([...fs.readFileSync(filesDir(workspaceDir, 'n1', 'a (2).png'))], [2]);
});
