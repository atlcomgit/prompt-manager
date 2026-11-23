import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isBashScriptAvailable, readBashScript, saveBashScript } from '../src/services/bashScriptFile.js';

async function directory(t: TestContext) {
	const result = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bash-script-'));
	t.after(() => fs.rm(result, { recursive: true, force: true }));
	return result;
}

test('Сохранение через любую ссылку сохраняет inode и замечает открытые правки через другое имя', async t => {
	const dir = await directory(t);
	const file = path.join(dir, 'team.sh');
	const shared = path.join(dir, 'deploy.sh');
	const native = path.join(dir, 'native.sh');
	await fs.writeFile(file, 'exit 0\n', { mode: 0o750 });
	await fs.link(file, shared);
	await fs.symlink(file, native);
	const opened = await readBashScript(shared);
	for (const alias of [native, file]) {
		await assert.rejects(saveBashScript(shared, 'exit 7\n', opened.revision, () => [alias]), /несохранённые/);
	}
	const before = await fs.stat(shared);
	await saveBashScript(shared, 'exit 7\n', opened.revision, () => [path.join(dir, 'other.sh')]);
	const after = await fs.stat(file);
	assert.equal(await fs.readFile(native, 'utf8'), 'exit 7\n');
	assert.equal(after.ino, before.ino);
	assert.equal(after.nlink, 2);
	assert.equal(after.mode, before.mode);
	assert.equal(after.uid, before.uid);
	assert.equal(after.gid, before.gid);
});

test('Два редактора жёстких ссылок не записывают одновременно разные версии одного скрипта', async t => {
	const dir = await directory(t);
	const one = path.join(dir, 'one.sh');
	const two = path.join(dir, 'two.sh');
	await fs.writeFile(one, 'echo before');
	await fs.link(one, two);
	const [a, b] = await Promise.all([readBashScript(one), readBashScript(two)]);
	const writes = await Promise.allSettled([saveBashScript(one, 'echo one', a.revision, () => []),
		saveBashScript(two, 'echo two', b.revision, () => [])]);
	assert.equal(writes.filter(r => r.status === 'fulfilled').length, 1);
	assert.equal(writes.filter(r => r.status === 'rejected').length, 1);
	assert.equal(await fs.readFile(one, 'utf8'), await fs.readFile(two, 'utf8'));
});

test('Ошибка записи возвращает исходные байты на диск и сохраняет алиасы файла', async t => {
	const dir = await directory(t);
	const file = path.join(dir, 'rollback.sh');
	const alias = path.join(dir, 'alias.sh');
	const original = 'echo до сохранения\n';
	await fs.writeFile(file, original);
	await fs.link(file, alias);
	const loaded = await readBashScript(file);
	const probe = await fs.open(file);
	const prototype = Object.getPrototypeOf(probe) as Pick<fs.FileHandle, 'sync'>;
	await probe.close();
	const sync = prototype.sync;
	let injected = false;
	t.mock.method(prototype, 'sync', async function (this: fs.FileHandle) {
		if (!injected) { injected = true; throw new Error('контрольный отказ sync'); }
		return sync.call(this);
	});
	await assert.rejects(saveBashScript(file, 'exit 2\n', loaded.revision, () => []), /контрольный отказ/);
	assert.equal(await fs.readFile(alias, 'utf8'), original);
	assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('Одинаковые правила чтения, сохранения и доступности для ссылок на скрипты без расширения', async t => {
	const dir = await directory(t);
	const target = path.join(dir, 'entrypoint');
	const alias = path.join(dir, 'entrypoint.sh');
	await fs.writeFile(target, '#!/usr/bin/env -S bash -eu\necho test\n');
	await fs.symlink(target, alias);
	assert.equal(await isBashScriptAvailable(alias), true);
	const loaded = await readBashScript(alias);
	const next = '#!/bin/bash\nexit 0\n';
	await saveBashScript(alias, next, loaded.revision, () => []);
	assert.equal(await fs.readFile(target, 'utf8'), next);
	assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
	await assert.rejects(saveBashScript(alias, 'plain text', (await readBashScript(alias)).revision, () => []), /#!/);
	await fs.writeFile(target, '#!/usr/bin/env python3\n');
	assert.equal(await isBashScriptAvailable(alias), false);
	await assert.rejects(readBashScript(alias), /#!/);
	const folderAlias = path.join(dir, 'linked-directory');
	await fs.symlink(dir, folderAlias, 'dir');
	await fs.unlink(target);
	await assert.rejects(readBashScript(path.join(folderAlias, 'entrypoint.sh')), /отсутствующий/);
	assert.equal(await isBashScriptAvailable(alias), false);
});

test('Существующий скрипт сохраняет POSIX ACL и расширенный пользовательский атрибут', { skip: process.platform !== 'linux' }, async t => {
	const dir = await directory(t);
	const file = path.join(dir, 'team.sh');
	await fs.writeFile(file, 'exit 1\n');
	try {
		execFileSync('setfacl', ['-m', 'g:65534:r--', file], { stdio: 'pipe' });
		execFileSync('python3', ['-c', 'import os,sys; os.setxattr(sys.argv[1], "user.pm-test", b"review")', file], { stdio: 'pipe' });
	} catch { t.skip('Нужны POSIX ACL, пользовательские xattr, setfacl и python3.'); return; }
	const before = execFileSync('getfacl', ['-cpn', file], { encoding: 'utf8' });
	const loaded = await readBashScript(file);
	await saveBashScript(file, 'exit 0\n', loaded.revision, () => []);
	assert.equal(execFileSync('getfacl', ['-cpn', file], { encoding: 'utf8' }), before);
	assert.equal(execFileSync('python3', ['-c', 'import os,sys; print(os.getxattr(sys.argv[1], "user.pm-test").decode())', file],
		{ encoding: 'utf8' }).trim(), 'review');
});

test('Создание нового скрипта публикует полный текст с приватными правами', async t => {
	const dir = await directory(t);
	const file = path.join(dir, 'new.sh');
	const opened = await readBashScript(file);
	await saveBashScript(file, 'echo new\n', opened.revision, () => []);
	assert.equal(await fs.readFile(file, 'utf8'), 'echo new\n');
	if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});
