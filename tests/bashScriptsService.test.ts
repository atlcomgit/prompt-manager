import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BASH_SCRIPTS_FILE, BashScriptsService } from '../src/services/bashScriptsService.js';

/** Каждый тест получает отдельный домашний каталог и две рабочие папки с одноимёнными скриптами. */
async function fixture(t: TestContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-scripts-test-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const primary = path.join(root, 'primary');
	const second = path.join(root, 'second');
	const globalStorageDir = path.join(root, 'home');
	const projectStorageDir = path.join(primary, '.vscode', 'prompt-manager');
	const workspaceRoots = [primary, second];
	const files = workspaceRoots.map(folder => path.join(folder, 'build.sh'));
	for (const folder of workspaceRoots) await fs.mkdir(folder);
	for (const file of files) await fs.writeFile(file, 'echo test\n');
	const options = { globalStorageDir, projectStorageDir, workspaceRoots };
	return { root, primary, files, options, service: new BashScriptsService(options) };
}

test('Сканирование различает корни, сохраняет ручные названия, историю и скрытие', async t => {
	const { root, files, options, service } = await fixture(t);
	await service.scan([...files, files[0], path.join(root, 'outside.sh'), 'relative.sh']);
	const entries = await service.list();
	assert.deepEqual(entries.map(entry => [entry.path, entry.available]), [['build.sh', true], ['../second/build.sh', true]]);
	const [a, b] = entries;
	assert.deepEqual(a.project, { root: options.workspaceRoots[0], name: 'primary', relativePath: 'build.sh' });
	assert.deepEqual(b.project, { root: options.workspaceRoots[1], name: 'second', relativePath: 'build.sh' });
	const run = { id: 'first', startedAt: '2026-11-23T10:00:00Z' };
	await service.recordRun(a, run);
	await service.hide(a);
	await service.finishRun(a, run.id, '2026-11-23T10:01:00Z', 7);
	await service.edit(b, 'Тест', b.path);
	await service.scan(files);
	const reopened = new BashScriptsService(options);
	assert.deepEqual((await reopened.list()).map(entry => entry.name), ['Тест']);
	const restored = await reopened.register('project', 'Сборка', a.absolutePath);
	assert.equal(restored.id, a.id);
	assert.equal(restored.history[0].exitCode, 7);
	await fs.unlink(b.absolutePath);
	assert.equal((await service.get(b)).available, false);
	await fs.writeFile(b.absolutePath, '');
	assert.equal((await service.get(b)).available, true);
});

test('Перепривязка не перемещает файлы и не возвращает старый путь при автопоиске', async t => {
	const { service, files, root } = await fixture(t);
	await service.scan(files);
	const [previous, other] = await service.list();
	const external = path.join(root, 'daily.sh');
	await fs.writeFile(external, 'echo external');
	const edited = await service.edit(previous, 'Отчёт', external, previous);
	assert.equal(edited.path, external);
	await service.scan(files);
	assert.deepEqual((await service.list()).map(entry => entry.absolutePath), [external, other.absolutePath]);
	let called = false;
	await assert.rejects(service.edit(previous, 'Старый черновик', external, previous, async () => { called = true; }), /другом окне/);
	await assert.rejects(service.edit(edited, 'Дубликат', other.path, edited, async () => { called = true; }), /уже зарегистрирован/);
	assert.equal(called, false);
	assert.match(await fs.readFile(files[0], 'utf8'), /echo test/);
	await service.register('project', 'Вернуть вручную', files[0]);
	assert.equal((await service.list()).length, 3);
});

test('Области хранятся раздельно, глобальный путь работает при смене проекта и без рабочей папки', async t => {
	const { options, service, files } = await fixture(t);
	await service.scan(files);
	const global = await service.register('global', 'Глобальная сборка', 'build.sh');
	assert.equal(global.path, files[0]);
	const standalone = new BashScriptsService({ globalStorageDir: options.globalStorageDir, workspaceRoots: [] });
	await standalone.scan(files);
	const { project, ...unscoped } = global;
	assert.deepEqual(project, { root: options.workspaceRoots[0], name: 'primary', relativePath: 'build.sh' });
	assert.deepEqual(await standalone.list(), [unscoped]);
	assert.throws(() => standalone.resolvePath('global', 'relative.sh'), /полный путь/);
	await assert.rejects(standalone.register('project', 'X', files[0]), /папку проекта/);
});

test('Ближайший известный корень определяет проект независимо от области записи и наличия файла', async t => {
	const { root, primary, options, files } = await fixture(t);
	const service = new BashScriptsService({ ...options,
		workspaceRoots: options.workspaceRoots.map(folder => ({ root: folder, name: 'Проект' })) });
	const nested = path.join(primary, 'packages', 'tools');
	const externalRepository = path.join(root, 'external');
	service.setRepositoryRoots([externalRepository, nested, primary]);
	const nestedFile = path.join(nested, 'scripts', 'build.sh');
	const externalFile = path.join(externalRepository, 'missing.sh');
	const neighbor = path.join(primary + '-copy', 'other.sh');
	await fs.mkdir(path.dirname(nestedFile), { recursive: true });
	await fs.writeFile(nestedFile, 'exit 0');
	await service.scan([...files, nestedFile, externalFile, neighbor]);
	const nestedGlobal = await service.register('global', 'Глобальная сборка', nestedFile);
	const external = await service.register('project', 'Внешний репозиторий', externalFile);
	const outside = await service.register('project', 'За пределами корней', neighbor);
	const listed = await service.list();
	assert.equal(listed.length, 6);
	assert.deepEqual(listed.slice(0, 2).map(entry => entry.project), options.workspaceRoots.map(folder => ({
		root: folder, name: 'Проект', relativePath: 'build.sh',
	})));
	const nestedProject = { root: nested, name: 'tools', relativePath: 'scripts/build.sh' };
	assert.deepEqual(listed[2].project, nestedProject);
	assert.deepEqual(nestedGlobal.project, nestedProject);
	assert.equal(listed[2].path, 'packages/tools/scripts/build.sh');
	assert.equal(nestedGlobal.path, nestedFile);
	assert.deepEqual(external.project, { root: externalRepository, name: 'external', relativePath: 'missing.sh' });
	assert.equal(external.available, false);
	assert.equal(external.path, externalFile);
	assert.equal(outside.project, undefined);

	// Закрытие репозитория меняет группировку без перезаписи проектного или глобального каталога.
	const catalogs = [options.globalStorageDir, options.projectStorageDir].map(folder => path.join(folder, BASH_SCRIPTS_FILE));
	const published = await Promise.all(catalogs.map(file => fs.readFile(file, 'utf8')));
	service.setRepositoryRoots([]);
	assert.deepEqual((await service.get(nestedGlobal)).project, {
		root: primary, name: 'Проект', relativePath: 'packages/tools/scripts/build.sh',
	});
	assert.equal((await service.get(external)).project, undefined);
	assert.deepEqual(await Promise.all(catalogs.map(file => fs.readFile(file, 'utf8'))), published);
	assert.ok(published.every(source => JSON.parse(source).entries.every((entry: object) => !Object.hasOwn(entry, 'project'))));
});

test('Два окна объединяют параллельные правки и сохраняют порядок фактического старта', async t => {
	const { options, files, service } = await fixture(t);
	const other = new BashScriptsService(options);
	await Promise.all([service.scan([files[0]]), other.scan(files)]);
	const [entry] = await service.list();
	const first = { id: '1', startedAt: '2026-11-23T11:00:00Z' };
	const second = { id: '2', startedAt: '2026-11-23T11:01:00Z' };
	await Promise.all([service.recordRun(entry, second), other.recordRun(entry, first), service.edit(entry, 'Новый', entry.path)]);
	await other.finishRun(entry, first.id, '2026-11-23T11:03:00Z', 0);
	await service.recordRun(entry, first);
	const refreshed = await other.get(entry);
	assert.equal(refreshed.name, 'Новый');
	assert.deepEqual(refreshed.history.map(run => [run.id, run.exitCode]), [['2', undefined], ['1', 0]]);
	assert.equal((await service.list()).length, 2);
});

test('Ошибки в редакторе и повреждённый JSON оставляют каталог в исходном состоянии', async t => {
	const { options, files, service } = await fixture(t);
	await service.scan(files);
	const [entry] = await service.list();
	const file = path.join(options.projectStorageDir, BASH_SCRIPTS_FILE);
	const before = await fs.readFile(file, 'utf8');
	await assert.rejects(service.edit(entry, 'Новое', 'new.sh', entry, async () => { throw new Error('конфликт файла'); }), /конфликт/);
	assert.equal(await fs.readFile(file, 'utf8'), before);
	await service.scan(files);
	assert.equal(await fs.readFile(file, 'utf8'), before);
	await fs.writeFile(file, '{"version":1,"entries":[');
	await assert.rejects(service.scan(files), /прочитать каталог/);
	assert.equal(await fs.readFile(file, 'utf8'), '{"version":1,"entries":[');
});

test('Скрытие старой строки не убирает запись, перепривязанную в другом окне', async t => {
	const { service, files, root } = await fixture(t);
	await service.scan(files);
	const [stale] = await service.list();
	const actual = await service.edit(stale, 'Новая', path.join(root, 'new.sh'), stale);
	await assert.rejects(service.hide(stale, stale.absolutePath), /изменился/);
	assert.equal((await service.get(stale)).absolutePath, actual.absolutePath);
	await service.hide(actual, actual.absolutePath);
	await assert.rejects(service.get(actual), /удалён/);
});

test('Проект наследует права хранилища, сохраняет свои 0664, глобальная область остаётся приватной',
	{ skip: process.platform === 'win32' }, async t => {
	const { service, files, options } = await fixture(t);
	await service.scan(files);
	await service.register('global', 'Общая', files[0]);
	const projectFile = path.join(options.projectStorageDir, BASH_SCRIPTS_FILE);
	const globalFile = path.join(options.globalStorageDir, BASH_SCRIPTS_FILE);
	const reference = path.join(options.projectStorageDir, 'permissions-reference');
	await fs.writeFile(reference, '');
	assert.equal((await fs.stat(projectFile)).mode & 0o777, (await fs.stat(reference)).mode & 0o777);
	assert.equal((await fs.stat(globalFile)).mode & 0o777, 0o600);
	await fs.chmod(projectFile, 0o664);
	const before = await fs.stat(projectFile);
	const [project] = await service.list();
	await service.recordRun(project, { id: 'example', startedAt: new Date().toISOString() });
	const after = await fs.stat(projectFile);
	assert.equal(after.mode & 0o777, 0o664);
	assert.equal(after.uid, before.uid);
	assert.equal(after.gid, before.gid);
	const global = (await service.list()).find(e => e.scope === 'global')!;
	await service.hide(global, global.absolutePath);
	assert.equal((await fs.stat(globalFile)).mode & 0o777, 0o600);
});

test('Общий каталог сохраняет ACL, xattr и дополнительные жёсткие ссылки',
	{ skip: process.platform !== 'linux' }, async t => {
	const { service, files, options } = await fixture(t);
	await service.scan(files);
	const file = path.join(options.projectStorageDir, BASH_SCRIPTS_FILE);
	try {
		execFileSync('setfacl', ['-m', 'g:65534:rw-', file], { stdio: 'pipe' });
		execFileSync('python3', ['-c', 'import os,sys; os.setxattr(sys.argv[1], "user.pm-test", b"review")', file], { stdio: 'pipe' });
	} catch { t.skip('Нужны POSIX ACL, пользовательские xattr, setfacl и python3.'); return; }
	const acl = execFileSync('getfacl', ['-cpn', file], { encoding: 'utf8' });
	const [entry] = await service.list();
	await service.edit(entry, 'Имя', entry.path);
	assert.equal(execFileSync('getfacl', ['-cpn', file], { encoding: 'utf8' }), acl);
	assert.equal(execFileSync('python3', ['-c', 'import os,sys; print(os.getxattr(sys.argv[1], "user.pm-test").decode())', file],
		{ encoding: 'utf8' }).trim(), 'review');
	await fs.link(file, file + '.shared');
	let called = false;
	await service.edit(entry, 'Второе', entry.path, undefined, async () => { called = true; });
	assert.equal(called, true);
	assert.equal(JSON.parse(await fs.readFile(file + '.shared', 'utf8')).entries[0].name, 'Второе');
	assert.equal((await fs.stat(file)).ino, (await fs.stat(file + '.shared')).ino);
});

test('Читатель и писатель через разные жёсткие ссылки дожидаются целого JSON', async t => {
	const { service, files, options, root } = await fixture(t);
	const entry = await service.register('project', 'Длинное имя '.repeat(100), files[0]);
	const file = path.join(options.projectStorageDir, BASH_SCRIPTS_FILE);
	const alias = path.join(root, 'other-storage');
	await fs.mkdir(alias);
	await fs.link(file, path.join(alias, BASH_SCRIPTS_FILE));
	const other = new BashScriptsService({ ...options, projectStorageDir: alias });

	// Между короткой записью и truncate в хвосте ещё находятся байты прежнего, более длинного JSON.
	const probe = await fs.open(file);
	const inode = (await probe.stat()).ino;
	const prototype = Object.getPrototypeOf(probe) as Pick<fs.FileHandle, 'truncate'>;
	await probe.close();
	const truncate = prototype.truncate;
	let signalPartial!: () => void;
	const partial = new Promise<void>(resolve => { signalPartial = resolve; });
	let resume!: () => void;
	const gate = new Promise<void>(resolve => { resume = resolve; });
	t.mock.method(prototype, 'truncate', async function (this: fs.FileHandle, length?: number) {
		if ((await this.stat()).ino === inode) {
			signalPartial();
			await gate;
		}
		await truncate.call(this, length);
	});

	const write = service.edit(entry, 'Готово', entry.path);
	await Promise.race([partial, write.then(() => { throw new Error('Не перехвачен truncate'); })]);
	const read = other.get(entry);
	const concurrent = other.recordRun(entry, { id: 'during-write', startedAt: '2026-11-23T10:00:00Z' });
	try {
		const intermediate = await fs.readFile(file, 'utf8');
		assert.throws(() => JSON.parse(intermediate));
		await new Promise(resolve => setTimeout(resolve, 70));
	} finally { resume(); }
	await Promise.all([write, concurrent]);
	assert.equal((await read).name, 'Готово');
	assert.equal((await service.get(entry)).history[0].id, 'during-write');
});

test('Ошибка записи общего JSON восстанавливает исходные байты для всех имён', async t => {
	const { service, files, options } = await fixture(t);
	const entry = await service.register('project', 'Первое', files[0]);
	const file = path.join(options.projectStorageDir, BASH_SCRIPTS_FILE);
	const alias = file + '.shared';
	await fs.link(file, alias);
	const before = await fs.readFile(file);
	const probe = await fs.open(file);
	const prototype = Object.getPrototypeOf(probe) as Pick<fs.FileHandle, 'sync'>;
	await probe.close();
	const sync = prototype.sync;
	let fail = true;
	t.mock.method(prototype, 'sync', async function (this: fs.FileHandle) {
		if (fail) { fail = false; throw new Error('Контрольный отказ fsync'); }
		await sync.call(this);
	});
	await assert.rejects(service.edit(entry, 'Второе', entry.path), /Контрольный отказ/);
	assert.deepEqual(await fs.readFile(alias), before);
	assert.equal((await service.get(entry)).name, 'Первое');
});

test('Каталог только для чтения доступен для списка, запрет записи проверяется до сохранения скрипта',
	{ skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
	const { service, files, options } = await fixture(t);
	const entry = await service.register('project', 'Открыть', files[0]);
	const file = path.join(options.projectStorageDir, BASH_SCRIPTS_FILE);
	await fs.chmod(file, 0o444);
	await fs.chmod(options.projectStorageDir, 0o555);
	try {
		assert.equal((await service.list())[0].id, entry.id);
	} finally {
		await fs.chmod(options.projectStorageDir, 0o755);
	}
	let callback = false;
	await assert.rejects(service.edit(entry, 'Новое имя', entry.path, undefined, async () => { callback = true; }), { code: 'EACCES' });
	assert.equal(callback, false);
	assert.equal((await service.get(entry)).name, 'Открыть');
});

test('Список и выбор для запуска отражают тип текущей цели символической ссылки', async t => {
	const { service, options } = await fixture(t);
	const target = path.join(options.workspaceRoots[0], 'command');
	const alias = target + '.sh';
	await fs.writeFile(target, '#!/bin/bash\nexit 0\n');
	await fs.symlink(target, alias);
	await service.scan([alias]);
	const [entry] = await service.list();
	assert.equal(entry.available, true);
	assert.equal((await service.get(entry)).available, true);
	await fs.writeFile(target, '#!/usr/bin/python3\n');
	assert.equal((await service.list())[0].available, false);
	assert.equal((await service.get(entry)).available, false);
});
