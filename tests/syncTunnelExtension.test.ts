import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

/** Импортирует реальный post-compile скрипт, не запуская его CLI над рабочим окружением. */
async function loadSync() {
	return import(pathToFileURL(path.resolve('scripts/sync-tunnel-extension.mjs')).href);
}

/** Все сборки, установки и реестр теста принадлежат отдельной временной папке; БД не используются. */
async function fixture(t: TestContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-tunnel-sync-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const project = path.join(root, 'project');
	const destination = path.join(root, 'extensions', 'prompt-manager');
	const backup = path.join(root, 'backups', 'original');
	for (const dir of [project, destination]) {
		await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
		await fs.mkdir(path.join(dir, 'media'));
		await fs.writeFile(path.join(dir, 'media', 'icon.svg'), '<svg/>');
		await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
			name: 'copilot-prompt-manager', publisher: 'alek-fiend', version: dir === project ? '0.2.55' : '0.2.54',
			...(dir === destination ? { __metadata: { targetPlatform: 'linux-x64' } } : {}),
		}));
		await fs.writeFile(path.join(dir, 'dist', 'extension.js'), dir === project ? 'new build' : 'old build');
	}
	await fs.mkdir(path.join(destination, 'node_modules'));
	await fs.writeFile(path.join(destination, 'node_modules', 'preserve.txt'), 'dependency');
	await fs.mkdir(path.join(project, '.vscode'));
	const configFile = path.join(project, '.vscode', 'tunnel-dev.json');
	await fs.writeFile(configFile, JSON.stringify({ enabled: true, extensionDirectory: destination, backupDirectory: backup }));
	const registry = path.join(root, 'extensions', 'extensions.json');
	const other = { identifier: { id: 'other.extension' }, version: '1.0.0', metadata: { pinned: false } };
	await fs.writeFile(registry, JSON.stringify([
		{ identifier: { id: 'alek-fiend.copilot-prompt-manager' }, version: '0.2.54',
			location: { path: destination }, metadata: { pinned: false } }, other,
	]));
	return { root, project, destination, backup, registry, configFile, other };
}

/** Отсутствие локального opt-in оставляет обычную сборку без побочных действий. */
test('tunnel sync skips projects without an enabled local configuration', async t => {
	const f = await fixture(t);
	const { syncTunnelExtension } = await loadSync();
	await fs.unlink(f.configFile);
	assert.equal(await syncTunnelExtension(f.project), false);
	assert.equal(await fs.readFile(path.join(f.destination, 'dist', 'extension.js'), 'utf8'), 'old build');
});

/** Сервер загружает физическую копию; реестр, metadata, зависимости и исходная резервная копия сохраняются. */
test('tunnel sync publishes physical runtime files and preserves unrelated extension state', async t => {
	const f = await fixture(t);
	const { syncTunnelExtension } = await loadSync();
	assert.equal(await syncTunnelExtension(f.project), true);
	assert.equal((await fs.lstat(f.destination)).isSymbolicLink(), false);
	assert.equal(await fs.realpath(path.join(f.destination, 'dist', 'extension.js')),
		path.join(f.destination, 'dist', 'extension.js'));
	assert.equal(await fs.readFile(path.join(f.destination, 'dist', 'extension.js'), 'utf8'), 'new build');
	assert.equal(await fs.readFile(path.join(f.backup, 'dist', 'extension.js'), 'utf8'), 'old build');
	const registry = JSON.parse(await fs.readFile(f.registry, 'utf8'));
	assert.equal(registry[0].metadata.pinned, true);
	assert.equal(registry[0].version, '0.2.55');
	assert.deepEqual(registry[1], f.other);
	assert.equal(JSON.parse(await fs.readFile(path.join(f.destination, 'package.json'), 'utf8')).__metadata.targetPlatform,
		'linux-x64');
	assert.equal(await fs.readFile(path.join(f.destination, 'node_modules', 'preserve.txt'), 'utf8'), 'dependency');
	await fs.writeFile(path.join(f.project, 'dist', 'extension.js'), 'next build');
	await syncTunnelExtension(f.project);
	assert.equal(await fs.readFile(path.join(f.destination, 'dist', 'extension.js'), 'utf8'), 'next build');
	assert.equal(await fs.readFile(path.join(f.backup, 'dist', 'extension.js'), 'utf8'), 'old build');
	assert.deepEqual(await fs.readdir(path.dirname(f.backup)), ['original']);
});

/** Ссылка на проект не допускается: Node должен сохранить путь установленного extension host. */
test('tunnel sync rejects a symbolic link instead of an installed extension directory', async t => {
	const f = await fixture(t);
	await fs.rename(f.destination, path.join(f.root, 'previous'));
	await fs.symlink(f.project, f.destination, 'dir');
	const { syncTunnelExtension } = await loadSync();
	await assert.rejects(syncTunnelExtension(f.project), /обычную папку/);
	assert.equal(await fs.readFile(path.join(f.project, 'dist', 'extension.js'), 'utf8'), 'new build');
});

/** Ошибочный путь настройки не разрешает перезаписать другое расширение. */
test('tunnel sync refuses an installation with a different extension identity', async t => {
	const f = await fixture(t);
	await fs.writeFile(path.join(f.destination, 'package.json'), JSON.stringify({ publisher: 'other', name: 'extension' }));
	const { syncTunnelExtension } = await loadSync();
	await assert.rejects(syncTunnelExtension(f.project), /не является установкой/);
	assert.equal(await fs.readFile(path.join(f.destination, 'dist', 'extension.js'), 'utf8'), 'old build');
});

/** Неполный build не заменяет работающую установку. */
test('tunnel sync leaves the installation intact if staging a runtime payload fails', async t => {
	const f = await fixture(t);
	await fs.rm(path.join(f.project, 'media'), { recursive: true });
	const before = await fs.readFile(f.registry, 'utf8');
	const { syncTunnelExtension } = await loadSync();
	await assert.rejects(syncTunnelExtension(f.project), { code: 'ENOENT' });
	assert.equal(await fs.readFile(path.join(f.destination, 'dist', 'extension.js'), 'utf8'), 'old build');
	assert.equal(await fs.readFile(f.registry, 'utf8'), before);
	assert.deepEqual(await fs.readdir(path.dirname(f.backup)), []);
});

/** Отказ последней записи откатывает runtime и manifest, не стирая другие записи реестра. */
test('tunnel sync rolls back runtime replacement when updating the registry fails', async t => {
	const f = await fixture(t);
	const before = await fs.readFile(f.registry, 'utf8');
	const { syncTunnelExtension } = await loadSync();
	const rename = fs.rename;
	let failOnce = true;
	fs.rename = async (from, to) => {
		if (String(to) === f.registry && failOnce) { failOnce = false; throw new Error('Simulated registry write failure'); }
		return rename(from, to);
	};
	try { await assert.rejects(syncTunnelExtension(f.project), /Simulated registry write failure/); }
	finally { fs.rename = rename; }
	assert.equal(await fs.readFile(path.join(f.destination, 'dist', 'extension.js'), 'utf8'), 'old build');
	assert.equal(JSON.parse(await fs.readFile(path.join(f.destination, 'package.json'), 'utf8')).version, '0.2.54');
	assert.equal(await fs.readFile(f.registry, 'utf8'), before);
	assert.deepEqual(await fs.readdir(path.dirname(f.backup)), ['original']);
});
