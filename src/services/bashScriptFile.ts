import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { lock } from 'proper-lockfile';

/** Размер ограничен только для встроенного текстового редактора. */
const MAX_EDIT_BYTES = 1024 * 1024;
const SCRIPT_EXTENSION = /\.(?:sh|bash)$/i;

/** Распознаёт Bash непосредственно или через env (включая env -S bash -e). */
function hasBashShebang(content: string): boolean {
	const line = content.split(/[\r\n]/, 1)[0];
	return /^#![ \t]*\/(?:[^ \t/]+\/)*bash(?:[ \t]|$)/.test(line)
		|| /^#![ \t]*\/(?:[^ \t/]+\/)*env[ \t]+(?:-S[ \t]+)?bash(?:[ \t]|$)/.test(line);
}

/** Возвращает путь и для ещё не созданного файла внутри каталога, открытого по ссылке. */
async function physicalPath(file: string): Promise<string> {
	try {
		return await fs.realpath(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		const parent = path.dirname(file);
		const folder = await fs.realpath(parent).catch(e => {
			if (e.code !== 'ENOENT') throw e;
			return parent;
		});
		return path.join(folder, path.basename(file));
	}
}

/** У ссылки на файл без расширения проверяется только первая строка, в том числе при заполнении списка. */
async function targetPath(file: string): Promise<string> {
	if (!SCRIPT_EXTENSION.test(file)) throw new Error('Выберите Bash-скрипт с расширением .sh или .bash.');
	const target = await fs.realpath(file).catch(async (error: NodeJS.ErrnoException) => {
		if (error.code !== 'ENOENT') throw error;
		const link = await fs.lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
		if (link?.isSymbolicLink()) throw new Error('Ссылка указывает на отсутствующий файл.');
		const parent = path.dirname(file);
		return path.join(await physicalPath(parent), path.basename(file));
	});
	if (SCRIPT_EXTENSION.test(target)) return target;
	if (!path.extname(target)) {
		const handle = await fs.open(target, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			if ((await handle.stat()).isFile()) {
				const head = Buffer.alloc(512);
				const { bytesRead } = await handle.read(head, 0, head.length, 0);
				if (hasBashShebang(head.toString('utf8', 0, bytesRead))) return target;
			}
		} finally {
			await handle.close();
		}
	}
	throw new Error('Для ссылки укажите Bash-скрипт с расширением .sh, .bash или файл без расширения со строкой #! для Bash.');
}

/** Ссылка требует проверки и при смене её цели вне наблюдаемого workspace. */
export async function inspectBashScriptAvailability(file: string): Promise<{ available: boolean; symlink: boolean }> {
	let symlink = false;
	try {
		if (!SCRIPT_EXTENSION.test(file)) return { available: false, symlink };
		const stat = await fs.lstat(file);
		symlink = stat.isSymbolicLink();
		const target = symlink ? await fs.stat(await targetPath(file)) : stat;
		if (!target.isFile()) return { available: false, symlink };
		await fs.access(file, constants.R_OK);
		return { available: true, symlink };
	} catch {
		return { available: false, symlink };
	}
}

export async function isBashScriptAvailable(file: string): Promise<boolean> {
	return (await inspectBashScriptAvailability(file)).available;
}

function revision(target: string, bytes?: Buffer): string {
	const hash = createHash('sha256').update(target).update('\0');
	if (bytes) hash.update('file\0').update(bytes);
	else hash.update('absent');
	return hash.digest('hex');
}

/** В существующем файле ревизия проверяется по тому же дескриптору, в который будет записан текст. */
async function readHandle(handle: fs.FileHandle, target: string) {
	const stat = await handle.stat();
	if (!stat.isFile()) throw new Error('Путь должен указывать на обычный файл.');
	const nativePreview = (reason: string) => ({ content: '', mode: stat.mode & 0o777, nativeEditorReason: reason,
		revision: 'native:' + revision(target, Buffer.from(stat.size + '/' + stat.mtimeMs)) });
	if (stat.size > MAX_EDIT_BYTES) return nativePreview('Файл больше 1 МиБ.');
	const bytes = await handle.readFile();
	const content = bytes.toString('utf8');
	if (content.includes('\0') || !Buffer.from(content).equals(bytes)) {
		return nativePreview('Для этого файла требуется выбор кодировки в редакторе VS Code.');
	}
	return { content, revision: revision(target, bytes), mode: stat.mode & 0o777, nativeEditorReason: undefined };
}

async function readTarget(target: string) {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(target, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		return { content: '', revision: revision(target), mode: undefined, nativeEditorReason: undefined };
	}
	try {
		return await readHandle(handle, target);
	} finally {
		await handle.close();
	}
}

export async function readBashScript(file: string) {
	return readTarget(await targetPath(file));
}

function samePath(a: string, b: string): boolean {
	return path.relative(a, b) === '';
}

/** Символьные и жёсткие ссылки открытого документа обозначают тот же изменяемый файл. */
async function assertClean(target: string, getDirtyPaths: () => readonly string[], stat?: BigIntStats): Promise<void> {
	for (const dirty of getDirtyPaths()) {
		let same = samePath(dirty, target);
		if (!same && stat && stat.ino !== 0n) {
			const other = await fs.stat(dirty, { bigint: true }).catch(() => undefined);
			same = other?.dev === stat.dev && other.ino === stat.ino;
		}
		if (!same) {
			const actual = await physicalPath(dirty).catch(() => undefined);
			same = !!actual && samePath(actual, target);
		}
		if (same) throw new Error('В VS Code есть несохранённые правки этого файла. Сохраните их и перечитайте скрипт.');
	}
}

/** Запись с явными смещениями сохраняет inode, владельца, ACL и все имена файла. */
export async function replaceContents(handle: fs.FileHandle, bytes: Buffer): Promise<void> {
	let offset = 0;
	while (offset < bytes.length) {
		const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
		if (!bytesWritten) throw new Error('Не удалось записать данные в файл.');
		offset += bytesWritten;
	}
	await handle.truncate(bytes.length);
	await handle.sync();
}

/** Имена жёстких ссылок используют общую блокировку, каталог исходного файла может быть только для чтения. */
export function bashFileLockPath(file: string, stat: BigIntStats, kind: 'catalog' | 'script'): string {
	const identity = stat.ino ? stat.dev + '-' + stat.ino : createHash('sha256').update(file.toLowerCase()).digest('hex');
	// В Unix один и тот же совместный проект может открываться с разными пользовательскими TMPDIR.
	const directory = process.platform === 'win32' ? os.tmpdir() : '/tmp';
	return path.join(directory, 'prompt-manager-bash-' + kind + '-' + identity);
}

export async function saveBashScript(file: string, content: string, expected: string, getDirtyPaths: () => readonly string[],
	createEmptyFile = true) {
	const target = await targetPath(file);
	const initial = await readTarget(target);
	if (initial.nativeEditorReason || expected.startsWith('native:')) {
		if (initial.revision === expected && !content) return;
		throw new Error('Перечитайте файл. Его содержимое можно изменить в редакторе VS Code.');
	}
	// HTML textarea возвращает LF даже для открытого файла в CRLF.
	if (initial.content.includes('\r\n') && !/(^|[^\r])\n/.test(initial.content)) content = content.replace(/\r?\n/g, '\r\n');
	if (initial.mode !== undefined && initial.content === content) return;
	if (initial.revision !== expected) throw new Error('Файл изменился. Перечитайте его перед сохранением.');
	if (initial.mode === undefined && !content && !createEmptyFile) return;
	const bytes = Buffer.from(content);
	if (bytes.length > MAX_EDIT_BYTES || content.includes('\0')) throw new Error('Сохраните текстовый скрипт размером до 1 МиБ.');
	if (!SCRIPT_EXTENSION.test(target) && !hasBashShebang(content)) throw new Error('Файлу без расширения нужна строка #! для Bash.');

	if (initial.mode === undefined) {
		// Создание через жёсткую ссылку публикует полный файл только если имя по-прежнему свободно.
		await assertClean(target, getDirtyPaths);
		const temp = path.join(path.dirname(target), '.prompt-manager-' + randomUUID() + '.tmp');
		const handle = await fs.open(temp, 'wx', 0o600);
		try {
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await assertClean(target, getDirtyPaths);
			await fs.link(temp, target);
		} finally {
			await fs.rm(temp, { force: true });
		}
		return;
	}

	const handle = await fs.open(target, constants.O_RDWR | constants.O_NONBLOCK);
	try {
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile()) throw new Error('Путь должен указывать на обычный файл.');
		// Редактирование таких файлов может автоматически снять специальные биты на уровне ОС.
		if (stat.mode & 0o6000n) throw new Error('Скрипт имеет специальные права доступа. Для редактирования откройте его в системном редакторе.');
		const lockPath = bashFileLockPath(target, stat, 'script');
		let compromised: Error | undefined;
		const release = await lock(lockPath, { realpath: false, retries: { retries: 12, minTimeout: 25, maxTimeout: 150 },
			onCompromised: error => { compromised = error; } });
		try {
			const current = await readHandle(handle, target);
			if (!current.nativeEditorReason && current.content === content) return;
			if (current.nativeEditorReason || current.revision !== expected) throw new Error('Файл изменился. Перечитайте его перед сохранением.');
			await assertClean(target, getDirtyPaths, stat);
			const live = await fs.stat(file, { bigint: true });
			if (live.dev !== stat.dev || live.ino !== stat.ino || live.ctimeNs !== stat.ctimeNs) {
				throw new Error('Файл изменился во время сохранения.');
			}
			if (compromised) throw compromised;
			try {
				await replaceContents(handle, bytes);
			} catch (error) {
				// Исходный текст проверен как UTF-8 и остаётся доступен даже после частичной записи или ENOSPC.
				await replaceContents(handle, Buffer.from(current.content));
				throw error;
			}
		} finally {
			if (!compromised) await release();
		}
	} finally {
		await handle.close();
	}
}
