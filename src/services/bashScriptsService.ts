/** Каталог виджета хранит ссылки и историю отдельно от самих файлов Bash. */
import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { check, lock } from 'proper-lockfile';
import { setTimeout as delay } from 'node:timers/promises';
import { bashFileLockPath, inspectBashScriptAvailability, replaceContents } from './bashScriptFile.js';
import type { BashScriptEntry, BashScriptRef, BashScriptRun, BashScriptScope } from '../types/bashScripts.js';

export const BASH_SCRIPTS_FILE = 'bash-scripts.json';
export const BASH_SCRIPT_HISTORY_LIMIT = 50;

type ProjectRoot = Pick<NonNullable<BashScriptEntry['project']>, 'root' | 'name'>;

interface CatalogOptions {
	globalStorageDir: string;
	projectStorageDir?: string | null;
	workspaceRoots: readonly (string | ProjectRoot)[];
}

interface ScriptRecord {
	id: string;
	name: string;
	path: string;
	history: BashScriptRun[];
	hidden?: boolean;
}

interface Catalog {
	version: 1;
	entries: ScriptRecord[];
	scannedRoots?: string[];
	/** Предыдущий путь перепривязанной вручную записи тоже остаётся исключённым из автопоиска. */
	excludedPaths: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isRun(value: unknown): boolean {
	return isObject(value) && typeof value.id === 'string' && typeof value.startedAt === 'string'
		&& (value.finishedAt === undefined || typeof value.finishedAt === 'string')
		&& (value.exitCode === undefined || Number.isInteger(value.exitCode))
		&& (value.endedBy === undefined || value.endedBy === 'shell' || value.endedBy === 'terminal');
}

function isRecord(value: unknown): boolean {
	return isObject(value) && typeof value.id === 'string' && !!value.id && typeof value.name === 'string'
		&& !!value.name.trim() && typeof value.path === 'string' && !!value.path.trim() && !value.path.includes('\0')
		&& Array.isArray(value.history) && value.history.every(isRun)
		&& (value.hidden === undefined || typeof value.hidden === 'boolean');
}

function samePathKey(file: string): string {
	return process.platform === 'win32' ? file.toLowerCase() : file;
}

function isInside(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

/** Путь внутри проекта всегда записывается через «/», независимо от разделителя платформы. */
function projectRelativePath(project: ProjectRoot, file: string): string {
	return path.relative(project.root, file).split(path.sep).join('/');
}

function projectRoot(root: string, name?: string): ProjectRoot {
	const absolute = path.resolve(root);
	return { root: absolute, name: name || path.basename(absolute) || absolute };
}

function requireName(value: string): string {
	const name = value.trim();
	if (!name) throw new Error('Укажите название скрипта.');
	return name;
}

const execFileAsync = promisify(execFile);

/** Пути передаются как данные окружения; PowerShell запускается из системной папки без пользовательского профиля. */
async function windowsFileOperation(script: string, file: string, temporary: string): Promise<void> {
	const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + script],
		{ windowsHide: true, timeout: 15000, env: { ...process.env, PM_BASH_STAGE: temporary, PM_BASH_TARGET: file } });
}

/** При невозможности сохранить метаданные атомарной заменой запись продолжится через исходный inode. */
async function copyCatalogAttributes(file: string, temporary: string, source: BigIntStats): Promise<boolean> {
	try {
		if (process.platform === 'darwin') {
			await execFileAsync('/bin/cp', ['-p', file, temporary], { timeout: 10000 });
		} else if (process.platform === 'linux') {
			await execFileAsync('/bin/cp', ['--attributes-only', '--preserve=mode,ownership,xattr', '--', file, temporary],
				{ timeout: 10000 });
		} else if (process.platform === 'win32') {
			await windowsFileOperation('Set-Acl -LiteralPath $env:PM_BASH_STAGE -AclObject (Get-Acl -LiteralPath $env:PM_BASH_TARGET)',
				file, temporary);
			return true;
		} else {
			return false;
		}
		const copied = await fs.stat(temporary, { bigint: true });
		return copied.uid === source.uid && copied.gid === source.gid && (copied.mode & 0o7777n) === (source.mode & 0o7777n);
	} catch {
		return false;
	}
}

/** Новое имя создаётся относительно реальной директории, существующая символическая ссылка сохраняется. */
async function catalogTarget(file: string): Promise<string> {
	try {
		return await fs.realpath(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		const link = await fs.lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
		if (link) throw new Error('Каталог Bash ссылается на отсутствующий файл.');
		return path.join(await fs.realpath(path.dirname(file)), path.basename(file));
	}
}

async function catalogStat(file: string): Promise<BigIntStats | undefined> {
	return fs.stat(file, { bigint: true }).catch(error => {
		if (error.code !== 'ENOENT') throw error;
		return undefined;
	});
}

function sameCatalogVersion(a: BigIntStats, b: BigIntStats | undefined): boolean {
	return !!b && a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.size === b.size;
}

async function withCatalogLock<T>(key: string, operation: (assertHeld: () => void) => Promise<T>): Promise<T> {
	let compromised: Error | undefined;
	const release = await lock(key, { realpath: false,
		retries: { retries: 60, factor: 1.3, minTimeout: 15, maxTimeout: 250 },
		onCompromised: error => { compromised = error; } });
	try {
		return await operation(() => { if (compromised) throw compromised; });
	} finally {
		if (!compromised) await release();
	}
}

/** ReplaceFile в Windows сливает DACL, именованные потоки и атрибуты заменяемого файла. */
async function publishCatalogFile(temporary: string, file: string, existing: boolean): Promise<void> {
	if (!existing) {
		await fs.link(temporary, file);
	} else if (process.platform === 'win32') {
		await windowsFileOperation(
			'[IO.File]::Replace($env:PM_BASH_STAGE,$env:PM_BASH_TARGET,[Management.Automation.Language.NullString]::Value,$false)',
			file, temporary);
	} else {
		await fs.rename(temporary, file);
	}
}

/** Все изменения одной области перечитывают актуальный каталог под общей для окон блокировкой. */
export class BashScriptsService {
	private readonly globalDirectory: string;
	private readonly projectDirectory?: string;
	private readonly workspaceRoots: ProjectRoot[];
	private projectRoots: ProjectRoot[] = [];
	private readonly availability = new Map<string, ReturnType<typeof inspectBashScriptAvailability>>();
	private readonly cachedCatalogs = new Map<BashScriptScope, { stat: BigIntStats; catalog: Catalog }>();

	constructor(options: CatalogOptions) {
		this.workspaceRoots = options.workspaceRoots.map(folder => typeof folder === 'string'
			? projectRoot(folder) : projectRoot(folder.root, folder.name));
		this.setRepositoryRoots([]);
		this.globalDirectory = path.resolve(options.globalStorageDir);
		const projectDirectory = options.projectStorageDir && path.resolve(options.projectStorageDir);
		if (this.workspaceRoots.length > 0 && projectDirectory && samePathKey(projectDirectory) !== samePathKey(this.globalDirectory)) {
			this.projectDirectory = projectDirectory;
		}
	}

	/** Сначала проверяем вложенные корни. При совпадении используем имя, заданное в workspace. */
	setRepositoryRoots(repositories: readonly string[]): void {
		const roots = new Map(this.workspaceRoots.map(project => [samePathKey(project.root), project]));
		for (const repository of repositories) {
			if (!path.isAbsolute(repository)) continue;
			const project = projectRoot(repository);
			const key = samePathKey(project.root);
			if (!roots.has(key)) roots.set(key, project);
		}
		this.projectRoots = [...roots.values()].sort((a, b) => b.root.length - a.root.length);
	}

	/** Относительный ввод привязан к первой папке рабочего пространства, включая пути из соседних корней. */
	resolvePath(scope: BashScriptScope, filePath: string): string {
		if (scope === 'project' && !this.projectDirectory) throw new Error('Откройте папку проекта.');
		if (!filePath.trim() || filePath.includes('\0')) throw new Error('Укажите путь к скрипту.');
		if (path.isAbsolute(filePath)) return path.normalize(filePath);
		if (!this.workspaceRoots[0]) throw new Error('Без открытого проекта нужен полный путь к скрипту.');
		return path.resolve(this.workspaceRoots[0].root, filePath);
	}

	private storedPath(scope: BashScriptScope, absolute: string): string {
		if (scope === 'project' && this.workspaceRoots.some(project => isInside(project.root, absolute))) {
			return path.relative(this.workspaceRoots[0].root, absolute).split(path.sep).join('/');
		}
		return absolute;
	}

	private file(scope: BashScriptScope): string {
		const directory = scope === 'project' ? this.projectDirectory : this.globalDirectory;
		if (!directory) throw new Error('Откройте папку проекта.');
		return path.join(directory, BASH_SCRIPTS_FILE);
	}

	/** Сломанный или неизвестный формат требует исправления. Запись поверх него потеряла бы пользовательский список. */
	private parse(file: string, source: string | undefined): Catalog {
		if (source === undefined) return { version: 1, entries: [], excludedPaths: [] };
		let catalog: unknown;
		try {
			catalog = JSON.parse(source);
		} catch {
			throw new Error('Не удалось прочитать каталог Bash: ' + file);
		}
		if (!isObject(catalog) || catalog.version !== 1 || !Array.isArray(catalog.entries)
			|| !catalog.entries.every(isRecord) || !Array.isArray(catalog.excludedPaths)
			|| !catalog.excludedPaths.every(value => typeof value === 'string' && !!value.trim() && !value.includes('\0'))) {
			throw new Error('Неизвестный формат каталога Bash: ' + file);
		}
		return catalog as unknown as Catalog;
	}

	/** Читатель не пишет в каталоги. При обновлении общего inode он дожидается полного снимка. */
	private async read(scope: BashScriptScope): Promise<Catalog> {
		const file = this.file(scope);
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline) {
			const before = await catalogStat(file);
			if (!before) {
				this.cachedCatalogs.delete(scope);
				return this.parse(file, undefined);
			}
			const cached = this.cachedCatalogs.get(scope);
			const target = await catalogTarget(file);
			const busy = async () => {
				if (await check(target, { realpath: false })) return true;
				return before.nlink > 1n && check(bashFileLockPath(target, before, 'catalog'), { realpath: false });
			};
			if (!await busy()) {
				if (cached && sameCatalogVersion(before, cached.stat) && sameCatalogVersion(before, await catalogStat(file)) && !await busy()) {
					return cached.catalog;
				}
				const source = await fs.readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
				if (typeof source === 'string' && sameCatalogVersion(before, await catalogStat(file)) && !await busy()) {
					const catalog = this.parse(file, source);
					this.cachedCatalogs.set(scope, { stat: before, catalog });
					return catalog;
				}
			}
			await delay(30);
		}
		throw new Error('Каталог Bash занят. Повторите чтение после завершения сохранения.');
	}

	private async update<T>(scope: BashScriptScope, change: (catalog: Catalog) => T, beforeCommit?: () => Promise<void>): Promise<T> {
		const file = this.file(scope);
		await fs.mkdir(path.dirname(file), { recursive: true });
		const target = await catalogTarget(file);
		return withCatalogLock(target, async assertNameLock => {
			const identity = await catalogStat(target);
			const commit = async (assertIdentityLock?: () => void) => {
				const source = await catalogStat(target);
				if (source?.dev !== identity?.dev || source?.ino !== identity?.ino || source?.nlink !== identity?.nlink) {
					throw new Error('Каталог Bash заменён в другом окне. Повторите сохранение.');
				}
				const assertCurrent = async () => {
					assertNameLock();
					assertIdentityLock?.();
					const live = await catalogStat(file);
					if (source ? !sameCatalogVersion(source, live) : live !== undefined) {
						throw new Error('Каталог Bash изменился в другом окне. Обновите список и повторите сохранение.');
					}
				};
				const original = source ? await fs.readFile(target, 'utf8') : undefined;
				const catalog = this.parse(file, original);
				const before = JSON.stringify(catalog);
				const result = change(catalog);
				if (before === JSON.stringify(catalog)) {
					await assertCurrent();
					await beforeCommit?.();
					return result;
				}
				const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
				if (source) {
					if (!source.isFile() || (source.mode & 0o6000n)) throw new Error('Каталог Bash имеет специальные права или тип файла.');
					await fs.access(target, constants.W_OK);
				}
				let temporary: string | undefined;
				let shared: fs.FileHandle | undefined;
				try {
					const uid = process.getuid?.();
					// Замена inode разорвала бы другие имена файла или потребовала бы chown другого владельца.
					const keepInode = source && (source.nlink > 1n || (uid !== undefined && BigInt(uid) !== source.uid));
					if (!keepInode) {
						temporary = target + '.' + randomUUID() + '.tmp';
						const staged = await fs.open(temporary, 'wx', !source && scope === 'project' ? 0o666 : 0o600);
						try {
							if (!source || await copyCatalogAttributes(target, temporary, source)) {
								await replaceContents(staged, bytes);
							} else {
								shared = await fs.open(target, 'r+');
							}
						} finally {
							await staged.close();
						}
					} else {
						shared = await fs.open(target, 'r+');
					}
					if (shared && source && !sameCatalogVersion(source, await shared.stat({ bigint: true }))) {
						throw new Error('Каталог Bash изменился во время открытия.');
					}
					await assertCurrent();
					await beforeCommit?.();
					await assertCurrent();
					if (shared) {
						try {
							await replaceContents(shared, bytes);
						} catch (error) {
							await replaceContents(shared, Buffer.from(original!));
							throw error;
						}
					} else {
						await publishCatalogFile(temporary!, target, !!source);
					}
					return result;
				} finally {
					try { await shared?.close(); } finally { if (temporary) await fs.rm(temporary, { force: true }); }
				}
			};
			if (!identity || identity.nlink === 1n) return commit();
			return withCatalogLock(bashFileLockPath(target, identity, 'catalog'), commit);
		});
	}

	private record(catalog: Catalog, id: string, includeHidden = false): ScriptRecord {
		const record = catalog.entries.find(entry => entry.id === id && (includeHidden || !entry.hidden));
		if (!record) throw new Error('Скрипт удалён из списка. Обновите виджет.');
		return record;
	}

	/** Событие файла затрагивает только этот путь. Ручной поиск проверяет весь список. */
	invalidateAvailability(file?: string): boolean {
		if (file !== undefined) return this.availability.delete(samePathKey(file));
		this.availability.clear();
		return true;
	}

	/** Восстановленный признак нужен для первого показа. Запуск всегда проверяет выбранный файл заново. */
	restoreAvailability(saved: unknown): void {
		if (!Array.isArray(saved)) return;
		for (const item of saved) {
			if (Array.isArray(item) && typeof item[0] === 'string' && path.isAbsolute(item[0]) && typeof item[1] === 'boolean') {
				this.availability.set(samePathKey(item[0]), Promise.resolve({ available: item[1], symlink: false }));
			}
		}
	}

	/** После пропущенного события достаточно сравнить версии двух файлов каталогов. */
	async catalogsChanged(): Promise<boolean> {
		const scopes: BashScriptScope[] = this.projectDirectory ? ['project', 'global'] : ['global'];
		const changed = await Promise.all(scopes.map(async scope => {
			const cached = this.cachedCatalogs.get(scope);
			const current = await catalogStat(this.file(scope));
			return current ? !cached || !sameCatalogVersion(cached.stat, current) : !!cached;
		}));
		return changed.some(Boolean);
	}

	/** После перезапуска проверяем доступность в фоне; при возврате фокуса — внешние пути, ссылки и пропавшие файлы. */
	async recheckAvailability(externalOnly: boolean): Promise<boolean> {
		const files = [...this.availability];
		let changed = false;
		for (let i = 0; i < files.length; i += 32) {
			await Promise.all(files.slice(i, i + 32).map(async ([file, cached]) => {
				const previous = await cached;
				if (externalOnly && !previous.symlink && previous.available && this.workspaceRoots.some(p => isInside(p.root, file))) return;
				const next = await inspectBashScriptAvailability(file);
				if (this.availability.get(file) !== cached) return;
				this.availability.set(file, Promise.resolve(next));
				if (next.available !== previous.available) changed = true;
			}));
		}
		return changed;
	}

	private async view(scope: BashScriptScope, record: ScriptRecord, projects = this.projectRoots, reuse = false): Promise<BashScriptEntry> {
		const absolutePath = this.resolvePath(scope, record.path);
		const key = samePathKey(absolutePath);
		let check = reuse && this.availability.get(key);
		if (!check) {
			check = inspectBashScriptAvailability(absolutePath);
			this.availability.set(key, check);
		}
		const { available } = await check;
		const owner = projects.find(project => isInside(project.root, absolutePath));
		const entry: BashScriptEntry = { id: record.id, scope, name: record.name, path: record.path, absolutePath,
			available, history: record.history };
		if (owner) entry.project = { ...owner, relativePath: projectRelativePath(owner, absolutePath) };
		return entry;
	}

	/**
	 * Абсолютный путь и путь от ближайшего корня проекта, как в строке виджета.
	 * Для файла вне рабочих папок и известных репозиториев относительного пути нет.
	 */
	describePath(scope: BashScriptScope, filePath: string): { absolutePath: string; relativePath?: string } {
		const absolutePath = this.resolvePath(scope, filePath);
		const owner = this.projectRoots.find(project => isInside(project.root, absolutePath));
		return owner ? { absolutePath, relativePath: projectRelativePath(owner, absolutePath) } : { absolutePath };
	}

	/** Читаем состояние файла непосредственно перед действием с выбранной записью. */
	async get(ref: BashScriptRef): Promise<BashScriptEntry> {
		const catalog = await this.read(ref.scope);
		return this.view(ref.scope, this.record(catalog, ref.id));
	}

	async list(onError?: (scope: BashScriptScope, error: unknown) => void, reuseAvailability = false): Promise<BashScriptEntry[]> {
		const scopes: BashScriptScope[] = this.projectDirectory ? ['project', 'global'] : ['global'];
		const result: BashScriptEntry[] = [];
		for (const scope of scopes) {
			let records: ScriptRecord[];
			try {
				records = (await this.read(scope)).entries.filter(entry => !entry.hidden);
			} catch (error) {
				if (!onError) throw error;
				onError(scope, error);
				continue;
			}
			const projects = this.projectRoots;
			// Ограничиваем число одновременных stat/access даже в больших монорепозиториях.
			for (let start = 0; start < records.length; start += 32) {
				result.push(...await Promise.all(records.slice(start, start + 32).map(record => this.view(scope, record, projects, reuseAvailability))));
			}
		}
		return result;
	}

	private discoveryRoots(): string[] {
		return this.workspaceRoots.map(p => path.relative(this.workspaceRoots[0].root, p.root).split(path.sep).join('/') || '.');
	}

	/** Старый каталог уже содержит результаты поиска. Пустой новый каталог тоже запоминает первый обход. */
	async needsDiscovery(): Promise<boolean> {
		if (!this.projectDirectory) return false;
		if (!await catalogStat(this.file('project'))) return true;
		const { scannedRoots } = await this.read('project');
		return Array.isArray(scannedRoots) && JSON.stringify(scannedRoots) !== JSON.stringify(this.discoveryRoots());
	}

	/** Сканирование сливается с текущими записями: ручные названия, скрытие и история приоритетны. */
	async scan(files: readonly string[]): Promise<void> {
		if (!this.projectDirectory) return;
		await this.update('project', catalog => {
			catalog.scannedRoots = this.discoveryRoots();
			const known = new Set([...catalog.entries.map(entry => entry.path), ...catalog.excludedPaths]
				.map(file => samePathKey(this.resolvePath('project', file))));
			for (const file of files) {
				if (!path.isAbsolute(file)) continue;
				const absolute = path.normalize(file);
				const key = samePathKey(absolute);
				if (known.has(key) || !this.workspaceRoots.some(project => isInside(project.root, absolute))) continue;
				known.add(key);
				catalog.entries.push({
					id: randomUUID(), name: path.basename(absolute), path: this.storedPath('project', absolute), history: [],
				});
			}
		});
	}

	/** Повторное ручное добавление скрытого пути восстанавливает его идентификатор и историю. */
	async register(scope: BashScriptScope, name: string, filePath: string, beforeCommit?: () => Promise<void>): Promise<BashScriptEntry> {
		const absolute = this.resolvePath(scope, filePath);
		const key = samePathKey(absolute);
		const stored = this.storedPath(scope, absolute);
		const title = requireName(name);
		const record = await this.update(scope, catalog => {
			const existing = catalog.entries.find(entry => samePathKey(this.resolvePath(scope, entry.path)) === key);
			if (existing && !existing.hidden) throw new Error('Этот скрипт уже есть в выбранной области.');
			const item = existing ?? { id: randomUUID(), path: stored, history: [], name: title };
			item.name = title;
			delete item.hidden;
			if (!existing) catalog.entries.push(item);
			return item;
		}, beforeCommit);
		return this.view(scope, record);
	}

	/** Изменение ссылки не перемещает файл. Предыдущий путь исключается, чтобы рескан не отменил решение. */
	async edit(ref: BashScriptRef, name: string, filePath: string, expected?: { name: string; path: string },
		beforeCommit?: () => Promise<void>): Promise<BashScriptEntry> {
		const absolute = this.resolvePath(ref.scope, filePath);
		const stored = this.storedPath(ref.scope, absolute);
		const key = samePathKey(absolute);
		const title = requireName(name);
		const record = await this.update(ref.scope, catalog => {
			const item = this.record(catalog, ref.id);
			if (expected && (item.name !== expected.name || item.path !== expected.path)) {
				throw new Error('Скрипт изменён в другом окне. Откройте его актуальную версию.');
			}
			if (catalog.entries.some(other => other !== item && samePathKey(this.resolvePath(ref.scope, other.path)) === key)) {
				throw new Error('Этот путь уже зарегистрирован. Скрытую запись можно восстановить через добавление.');
			}
			if (ref.scope === 'project' && samePathKey(this.resolvePath(ref.scope, item.path)) !== key
				&& !catalog.excludedPaths.includes(item.path)) catalog.excludedPaths.push(item.path);
			item.path = stored;
			item.name = title;
			return item;
		}, beforeCommit);
		return this.view(ref.scope, record);
	}

	async hide(ref: BashScriptRef, expectedAbsolutePath?: string): Promise<void> {
		await this.update(ref.scope, catalog => {
			const item = this.record(catalog, ref.id, true);
			const currentPath = this.resolvePath(ref.scope, item.path);
			if (expectedAbsolutePath !== undefined && samePathKey(currentPath) !== samePathKey(expectedAbsolutePath)) {
				throw new Error('Путь скрипта изменился в другом окне. Проверьте обновлённую запись перед скрытием.');
			}
			item.hidden = true;
		});
	}

	/** Один запуск имеет устойчивый id и может получить событие завершения после скрытия записи. */
	async recordRun(ref: BashScriptRef, run: BashScriptRun): Promise<void> {
		await this.update(ref.scope, catalog => {
			const item = this.record(catalog, ref.id, true);
			if (item.history.some(previous => previous.id === run.id)) return;
			item.history.push(run);
			item.history.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
			if (item.history.length > BASH_SCRIPT_HISTORY_LIMIT) item.history.length = BASH_SCRIPT_HISTORY_LIMIT;
		});
	}

	/** Сохраняет первое событие окончания вместе с его источником, даже если запись успели скрыть. */
	async finishRun(ref: BashScriptRef, runId: string, finishedAt: string, exitCode?: number, endedBy?: BashScriptRun['endedBy']): Promise<void> {
		await this.update(ref.scope, catalog => {
			const item = this.record(catalog, ref.id, true);
			const run = item.history.find(previous => previous.id === runId);
			if (run && !run.finishedAt) {
				run.finishedAt = finishedAt;
				if (exitCode !== undefined) run.exitCode = exitCode;
				if (endedBy) run.endedBy = endedBy;
			}
		});
	}
}
