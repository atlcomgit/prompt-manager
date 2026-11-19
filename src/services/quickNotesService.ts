/**
 * Файловое хранение быстрых заметок: quick-notes.json и копии вложений рабочей и глобальной области.
 * Использует только Node API; наблюдатель за файлами передаётся фабрикой. Тесты — tests/quickNotesService.test.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
	QUICK_NOTE_SCOPES,
	QUICK_NOTES_FILE_NAME,
	QUICK_NOTES_FILES_DIR_NAME,
	QUICK_NOTES_PENDING_DIR_NAME,
	QUICK_NOTE_LOCAL_FILE_CHUNK_BYTES,
	QUICK_NOTE_LOCAL_FILE_MAX_BYTES,
	type QuickNote,
	type QuickNoteFile,
	type QuickNoteOperation,
	type QuickNoteOperationResult,
	type QuickNoteScope,
	type QuickNotesFileContent,
	type QuickNotesScopeState,
	type QuickNotesState,
	type QuickNoteView,
} from '../types/quickNotes.js';
import {
	applyQuickNoteOperation,
	buildQuickNoteStoredName,
	createQuickNoteId,
	getQuickNoteOperationScopes,
	isSafeQuickNoteDirectoryId,
	isSafeQuickNoteStoredName,
	normalizeQuickNotesFile,
	serializeQuickNotesFile,
	toStoredQuickNote,
} from '../utils/quickNotes.js';

/** Фабрика наблюдателя за одним файлом в папке; адаптер на API редактора создаёт расширение. */
export type QuickNotesWatcherFactory = (directory: string, fileName: string, onChange: () => void) => { dispose(): void };

/** Параметры сервиса быстрых заметок. */
export interface QuickNotesServiceOptions {
	/** `<workspace>/.vscode/prompt-manager` или null без открытой папки. */
	workspaceStorageDir: string | null;
	/** `~/.vscode/prompt-manager` (путь передаётся снаружи). */
	globalStorageDir: string;
	/** Наблюдение за внешними изменениями quick-notes.json; без фабрики события не создаются. */
	createWatcher?: QuickNotesWatcherFactory;
	/** Текущее время для дат вложений и возраста папок черновиков. */
	now?: () => Date;
	/** Диагностические сообщения, например в канал вывода расширения. */
	log?: (message: string) => void;
	/** Задержка объединения внешних изменений, по умолчанию 120 мс. */
	debounceMs?: number;
}

/** Источник файла черновика: путь к существующему файлу или байты с исходным именем. */
export type QuickNotesImportSource = { path: string } | { name: string; data: Uint8Array };

/** Операция сохранения черновика окна заметки. */
type QuickNoteReplaceOperation = Extract<QuickNoteOperation, { kind: 'replace' }>;

/** Операция переноса заметки между областями. */
type QuickNoteChangeScopeOperation = Extract<QuickNoteOperation, { kind: 'changeScope' }>;

/** Задержка объединения событий наблюдателя по умолчанию, мс. */
const DEFAULT_DEBOUNCE_MS = 120;

/** Возраст папки черновика по mtime, после которого она считается брошенной, мс. */
const DEFAULT_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Число попыток цикла чтение-применение-запись, если файл одновременно меняет другое окно. */
const MAX_WRITE_ATTEMPTS = 3;

/** Наибольшая длина расширения, переносимого в запасное имя копии. */
const MAX_FALLBACK_EXTENSION_LENGTH = 16;

/** Прочитанный файл области: сырой текст для проверки гонки и нормализованное содержимое. */
interface QuickNotesSnapshot {
	scope: QuickNoteScope;
	filePath: string;
	/** Текст файла или null, если файла нет. */
	raw: string | null;
	content: QuickNotesFileContent;
	/** Описание повреждения: такой файл не перезаписывается. */
	error?: string;
}

/** План операции: итоговая операция и действия с вложениями вокруг записи JSON. */
interface QuickNotesOperationPlan {
	/** Операция для применения; при сохранении черновика имена новых копий могут быть уточнены. */
	operation: QuickNoteOperation;
	/** Подготовка копий до записи JSON; ошибка отменяет запись. */
	before?: () => Promise<void>;
	/** Очистка после записи по итоговым заметкам; ошибка только записывается в лог. */
	after?: (notes: readonly QuickNoteView[]) => Promise<void>;
}

/** Копия вложения: первый существующий источник копируется в цель. */
interface QuickNotesFileCopy {
	sources: string[];
	target: string;
	/** Новый файл черновика обязателен: без источника сохранение отменяется, а не пишет ссылку на пропавший файл. */
	required: boolean;
	/** Имя файла для сообщения об ошибке. */
	name: string;
}

/**
 * Хранилище быстрых заметок обеих областей: чтение состояния, атомарная запись операций с очередью на файл,
 * перенос вложений черновиков и уведомления о внешних изменениях. Тесты — tests/quickNotesService.test.ts.
 */
export class QuickNotesService {
	/** Папка хранилища рабочей области; null без открытой папки или при совпадении с глобальной. */
	private readonly workspaceStorageDir: string | null;
	private readonly globalStorageDir: string;
	private readonly now: () => Date;
	private readonly log: (message: string) => void;
	private readonly debounceMs: number;
	/** Хвосты очередей по ключу: область для quick-notes.json, папка черновика для импорта файлов. */
	private readonly queues = new Map<string, Promise<void>>();
	private readonly browserUploads = new Map<string, { name: string; size: number; chunkCount: number; nextIndex: number; received: number; tempPath: string }>();
	/**
	 * Последний известный текст файла: собственная запись или уже показанное внешнее изменение. Совпадение при
	 * срабатывании наблюдателя — эхо, а возврат к прежнему тексту после ручной правки остаётся изменением.
	 */
	private readonly knownTexts = new Map<string, string>();
	private readonly listeners = new Set<() => void>();
	private readonly watchers: Array<{ dispose(): void }> = [];
	private readonly debounceTimers = new Map<QuickNoteScope, ReturnType<typeof setTimeout>>();
	/** Проверки внешних изменений выполняются по одной в порядке срабатывания таймеров. */
	private changeChecks: Promise<void> = Promise.resolve();
	private disposed = false;

	/** Создаёт сервис и наблюдатели за файлами доступных областей. */
	constructor(options: QuickNotesServiceOptions) {
		this.globalStorageDir = path.resolve(options.globalStorageDir);
		const workspaceStorageDir = options.workspaceStorageDir ? path.resolve(options.workspaceStorageDir) : null;
		// Домашний каталог, открытый как папка, или ссылка на глобальную папку дают тот же файл: одна область
		// исключает дубли заметок. Пути сравниваются по реальному расположению и в Windows и macOS без учёта регистра.
		this.workspaceStorageDir = workspaceStorageDir && !isSameDirectory(workspaceStorageDir, this.globalStorageDir)
			? workspaceStorageDir
			: null;
		this.now = options.now ?? (() => new Date());
		this.log = options.log ?? (() => undefined);
		this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
		if (options.createWatcher) {
			for (const scope of QUICK_NOTE_SCOPES) {
				const directory = this.getStorageDir(scope);
				if (directory) {
					const onChange = () => this.scheduleChangeCheck(scope);
					this.watchers.push(options.createWatcher(directory, QUICK_NOTES_FILE_NAME, onChange));
				}
			}
		}
	}

	/** Подписка на внешние изменения файлов (своя запись не вызывает событие). */
	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	/** Папка хранилища области или null, если область недоступна. */
	getStorageDir(scope: QuickNoteScope): string | null {
		return scope === 'workspace' ? this.workspaceStorageDir : this.globalStorageDir;
	}

	/** `<storageDir>/quick-notes-files` или null. */
	getFilesRoot(scope: QuickNoteScope): string | null {
		const storageDir = this.getStorageDir(scope);
		return storageDir ? path.join(storageDir, QUICK_NOTES_FILES_DIR_NAME) : null;
	}

	/** Читает обе области. notes — QuickNoteView (scope проставлен, previewUris нет). */
	async getState(): Promise<QuickNotesState> {
		const scopes = {} as Record<QuickNoteScope, QuickNotesScopeState>;
		const notes: QuickNoteView[] = [];
		for (const scope of QUICK_NOTE_SCOPES) {
			const filePath = this.getNotesFilePath(scope);
			if (!filePath) {
				scopes[scope] = { scope, available: false, filePath: '' };
				continue;
			}
			try {
				const snapshot = await this.readSnapshot(scope, filePath);
				scopes[scope] = snapshot.error
					? { scope, available: true, filePath, error: snapshot.error }
					: { scope, available: true, filePath };
				notes.push(...snapshot.content.notes.map(note => ({ ...note, scope })));
			} catch (error) {
				scopes[scope] = {
					scope,
					available: true,
					filePath,
					error: `Не удалось прочитать файл ${QUICK_NOTES_FILE_NAME}: ${describeError(error)}`,
				};
			}
		}
		return { scopes, notes };
	}

	/**
	 * Применяет операцию к файлам затронутых областей и возвращает результат со свежим состоянием.
	 * Ошибки ввода-вывода возвращаются кодом failed; повреждённый или недоступный файл не меняется.
	 */
	async applyOperation(operation: QuickNoteOperation): Promise<{ result: QuickNoteOperationResult; state: QuickNotesState }> {
		const result = await this.applyOperationSafely(operation);
		return { result, state: await this.getState() };
	}

	/** Копирует файлы во временную папку черновика `<filesRoot>/.pending/<draftId>/`. */
	async importFiles(input: {
		scope: QuickNoteScope;
		draftId: string;
		sources: QuickNotesImportSource[];
	}): Promise<{ files: QuickNoteFile[]; skipped: string[] }> {
		if (!this.getFilesRoot(input.scope)) {
			throw new Error('Заметки проекта недоступны: папка рабочей области не открыта или совпадает с глобальной папкой заметок.');
		}
		const draftDir = this.getDraftDir(input.scope, input.draftId);
		if (!draftDir) {
			throw new Error('Некорректный идентификатор черновика заметки.');
		}
		// Импорт в один черновик последовательный, чтобы имена копий не совпали.
		return this.runExclusive([`draft:${draftDir}`], async () => {
			await this.assertSafeStoragePath(draftDir);
			await fs.promises.mkdir(draftDir, { recursive: true });
			const existing = new Set((await fs.promises.readdir(draftDir)).map(name => name.toLowerCase()));
			const files: QuickNoteFile[] = [];
			const skipped: string[] = [];
			for (const source of input.sources) {
				const label = 'path' in source ? source.path : source.name;
				try {
					const imported = await this.importSource(source, draftDir, existing);
					if (imported) {
						files.push(imported);
					} else {
						skipped.push(label);
					}
				} catch (error) {
					this.log(`[quick-notes] Не удалось добавить файл «${label}»: ${describeError(error)}`);
					skipped.push(label);
				}
			}
			return { files, skipped };
		});
	}

	/**
	 * Принимает один ограниченный блок файла браузера. Все блоки пишутся в черновик на Ubuntu;
	 * окончательная копия становится видимой только после успешной проверки полного размера.
	 */
	async importBrowserChunk(input: {
		scope: QuickNoteScope; draftId: string; uploadId: string; name: string;
		fileSize: number; chunkIndex: number; chunkCount: number; dataBase64: string;
	}): Promise<QuickNoteFile | null> {
		const { scope, draftId, uploadId, fileSize, chunkIndex, chunkCount, dataBase64 } = input;
		if (!isSafeQuickNoteDirectoryId(draftId) || !/^[a-zA-Z0-9-]{8,100}$/.test(uploadId)
			|| !Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > QUICK_NOTE_LOCAL_FILE_MAX_BYTES
			|| !Number.isInteger(chunkIndex) || !Number.isInteger(chunkCount)
			|| chunkCount !== Math.ceil(fileSize / QUICK_NOTE_LOCAL_FILE_CHUNK_BYTES)
			|| chunkIndex < 0 || chunkIndex >= chunkCount
			|| typeof input.name !== 'string' || !input.name.trim()
			|| typeof dataBase64 !== 'string' || dataBase64.length > 710_000
			|| !/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(dataBase64)) {
			throw new Error('Некорректный блок локального файла.');
		}
		const bytes = Buffer.from(dataBase64, 'base64');
		const expected = Math.min(QUICK_NOTE_LOCAL_FILE_CHUNK_BYTES, fileSize - chunkIndex * QUICK_NOTE_LOCAL_FILE_CHUNK_BYTES);
		if (bytes.length !== expected) throw new Error('Неверный размер блока локального файла.');
		const directory = this.getDraftDir(scope, draftId);
		if (!directory) throw new Error('Папка заметок недоступна.');
		const key = [scope, draftId, uploadId].join(':');
		return this.runExclusive(['draft:' + directory], async () => {
			await this.assertSafeStoragePath(directory);
			let entry = this.browserUploads.get(key);
			if (!entry && chunkIndex !== 0) throw new Error('Загрузка файла прервана; повторите добавление.');
			if (entry && (entry.nextIndex !== chunkIndex || entry.size !== fileSize
				|| entry.chunkCount !== chunkCount || entry.name !== input.name)) {
				throw new Error('Нарушен порядок передачи файла.');
			}
			const tempPath = path.join(directory, '.prompt-manager-upload-' + uploadId + '.tmp');
			if (!entry) {
				await fs.promises.mkdir(directory, { recursive: true });
				await this.assertSafeStoragePath(tempPath);
				entry = { name: input.name, size: fileSize, chunkCount, nextIndex: 0, received: 0, tempPath };
				this.browserUploads.set(key, entry);
			}
			try {
				await fs.promises.writeFile(tempPath, bytes, { flag: chunkIndex === 0 ? 'wx' : 'a', mode: 0o600 });
				entry.received += bytes.length;
				entry.nextIndex++;
				if (chunkIndex !== chunkCount - 1) return null;
				if (entry.received !== fileSize) throw new Error('Файл передан не полностью.');
				const existing = new Set((await fs.promises.readdir(directory)).map(name => name.toLowerCase()));
				const name = path.basename(input.name.replace(/\\/g, '/'));
				const storedName = buildSafeStoredName(name, existing);
				const target = path.join(directory, storedName);
				await this.assertSafeStoragePath(target);
				await fs.promises.rename(tempPath, target);
				this.browserUploads.delete(key);
				return { id: createQuickNoteId(), name, storedName, size: fileSize, addedAt: this.now().toISOString() };
			} catch (error) {
				this.browserUploads.delete(key);
				await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
				throw error;
			}
		});
	}

	/** Отмена передачи локального файла удаляет только его временный блок, не другие файлы заметки. */
	async cancelBrowserUpload(scope: QuickNoteScope, draftId: string, uploadId: string): Promise<void> {
		if (!isSafeQuickNoteDirectoryId(draftId) || !/^[a-zA-Z0-9-]{8,100}$/.test(uploadId)) return;
		const directory = this.getDraftDir(scope, draftId);
		if (!directory) return;
		await this.runExclusive(['draft:' + directory], async () => {
			const key = [scope, draftId, uploadId].join(':');
			const entry = this.browserUploads.get(key);
			this.browserUploads.delete(key);
			if (entry && await this.isSafeStoragePath(entry.tempPath)) {
				await fs.promises.rm(entry.tempPath, { force: true }).catch(() => undefined);
			}
		});
	}

	/** Убирает только новую копию из .pending, не затрагивая сохранённое вложение заметки. */
	async removeDraftFile(scope: QuickNoteScope, draftId: string, storedName: string): Promise<boolean> {
		if (!isSafeQuickNoteDirectoryId(draftId) || !isSafeQuickNoteStoredName(storedName)) {
			throw new Error('Некорректный путь вложения черновика.');
		}
		const draftDir = this.getDraftDir(scope, draftId);
		if (!draftDir) throw new Error('Область заметок недоступна.');
		return this.runExclusive(['draft:' + draftDir], async () => {
			const target = path.join(draftDir, storedName);
			await this.assertSafeStoragePath(target);
			if (!(await isRegularFile(target))) return false;
			await fs.promises.unlink(target);
			return true;
		});
	}

	/** Удаляет папку черновика. */
	async discardDraft(scope: QuickNoteScope, draftId: string): Promise<void> {
		const draftDir = this.getDraftDir(scope, draftId);
		if (!draftDir) {
			return;
		}
		await this.runExclusive([`draft:${draftDir}`], async () => {
			await this.removeDir(draftDir);
			const prefix = [scope, draftId, ''].join(':');
			for (const key of this.browserUploads.keys()) {
				if (key.startsWith(prefix)) this.browserUploads.delete(key);
			}
		});
	}

	/**
	 * Безопасный абсолютный путь существующей копии: сначала папка черновика (если draftId), затем папка заметки.
	 * Небезопасные имена, пути вне папки вложений и не обычные файлы дают null.
	 */
	async resolveFilePath(input: {
		scope: QuickNoteScope;
		noteId: string;
		storedName: string;
		draftId?: string;
	}): Promise<string | null> {
		const filesRoot = this.getFilesRoot(input.scope);
		if (!filesRoot || !isSafeQuickNoteStoredName(input.storedName) || !isSafeQuickNoteDirectoryId(input.noteId)) {
			return null;
		}
		if (input.draftId && !isSafeQuickNoteDirectoryId(input.draftId)) {
			return null;
		}
		const candidates = [
			...(input.draftId ? [path.join(filesRoot, QUICK_NOTES_PENDING_DIR_NAME, input.draftId, input.storedName)] : []),
			path.join(filesRoot, input.noteId, input.storedName),
		];
		for (const candidate of candidates) {
			if (isInsideDirectory(filesRoot, candidate) && await this.isSafeStoragePath(candidate) && await isRegularFile(candidate)) {
				return candidate;
			}
		}
		return null;
	}

	/** Удаляет папки `.pending/*` старше maxAgeMs (по mtime) в обеих областях. По умолчанию 24 ч. */
	async cleanupStalePending(maxAgeMs: number = DEFAULT_PENDING_MAX_AGE_MS): Promise<void> {
		const threshold = this.now().getTime() - maxAgeMs;
		for (const scope of QUICK_NOTE_SCOPES) {
			const filesRoot = this.getFilesRoot(scope);
			if (!filesRoot) {
				continue;
			}
			const pendingRoot = path.join(filesRoot, QUICK_NOTES_PENDING_DIR_NAME);
			let entries: fs.Dirent[];
			try {
				// Ссылка вместо папки черновиков (например, из репозитория) увела бы удаление за пределы хранилища.
				if (!(await this.isSafeStoragePath(pendingRoot))) {
					this.log(`[quick-notes] Папка черновиков ${pendingRoot} — символическая ссылка: очистка пропущена.`);
					continue;
				}
				entries = await fs.promises.readdir(pendingRoot, { withFileTypes: true });
			} catch (error) {
				if (!isMissingFileError(error)) {
					this.log(`[quick-notes] Не удалось прочитать папку черновиков: ${describeError(error)}`);
				}
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) {
					continue;
				}
				const draftDir = path.join(pendingRoot, entry.name);
				try {
					const stat = await fs.promises.stat(draftDir);
					if (stat.mtimeMs < threshold) {
						await fs.promises.rm(draftDir, { recursive: true, force: true });
					}
				} catch (error) {
					this.log(`[quick-notes] Не удалось удалить устаревший черновик ${entry.name}: ${describeError(error)}`);
				}
			}
		}
	}

	/** Снимает наблюдатели, таймеры и подписчиков; последующие события файлов игнорируются. */
	dispose(): void {
		this.disposed = true;
		for (const watcher of this.watchers.splice(0)) {
			try {
				watcher.dispose();
			} catch (error) {
				this.log(`[quick-notes] Не удалось остановить наблюдатель: ${describeError(error)}`);
			}
		}
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		this.listeners.clear();
	}

	/** Путь quick-notes.json области или null, если область недоступна. */
	private getNotesFilePath(scope: QuickNoteScope): string | null {
		const storageDir = this.getStorageDir(scope);
		return storageDir ? path.join(storageDir, QUICK_NOTES_FILE_NAME) : null;
	}

	/** Папка черновика области; null при недоступной области или небезопасном id. */
	private getDraftDir(scope: QuickNoteScope, draftId: string): string | null {
		const filesRoot = this.getFilesRoot(scope);
		return filesRoot && isSafeQuickNoteDirectoryId(draftId)
			? path.join(filesRoot, QUICK_NOTES_PENDING_DIR_NAME, draftId)
			: null;
	}

	/** Папка вложений заметки; null при недоступной области или небезопасном id. */
	private getNoteDir(scope: QuickNoteScope, noteId: string): string | null {
		const filesRoot = this.getFilesRoot(scope);
		return filesRoot && isSafeQuickNoteDirectoryId(noteId) ? path.join(filesRoot, noteId) : null;
	}

	/** Читает файл области; отсутствующий файл — пустой список, другие ошибки чтения пробрасываются. */
	private async readSnapshot(scope: QuickNoteScope, filePath: string): Promise<QuickNotesSnapshot> {
		const raw = await readTextOrNull(filePath);
		return { scope, filePath, raw, ...parseQuickNotesText(raw) };
	}

	/** Проверяет доступность областей и выполняет операцию в их очередях; ошибки превращаются в код failed. */
	private async applyOperationSafely(operation: QuickNoteOperation): Promise<QuickNoteOperationResult> {
		const requested = getQuickNoteOperationScopes(operation);
		// Операции над всеми заметками обходят недоступную область, адресные операции отклоняются.
		const spansAll = operation.kind === 'clearDone' || operation.kind === 'setOrders';
		const scopes = QUICK_NOTE_SCOPES.filter(scope => requested.includes(scope)
			&& (!spansAll || this.getStorageDir(scope) !== null));
		if (scopes.length === 0 || scopes.some(scope => this.getStorageDir(scope) === null)) {
			return {
				ok: false,
				code: 'unavailable',
				message: 'Заметки проекта недоступны: папка рабочей области не открыта или совпадает с глобальной папкой заметок.',
			};
		}
		try {
			return await this.runExclusive(
				scopes.map(scope => `scope:${scope}`),
				() => this.applyWithRetry(operation, scopes, spansAll),
			);
		} catch (error) {
			this.log(`[quick-notes] Не удалось выполнить операцию ${operation.kind}: ${describeError(error)}`);
			return { ok: false, code: 'failed', message: `Не удалось сохранить заметки: ${describeError(error)}` };
		}
	}

	/** Повторяет цикл, пока запись не пройдёт без вмешательства другого окна, но не больше трёх раз. */
	private async applyWithRetry(
		operation: QuickNoteOperation,
		scopes: readonly QuickNoteScope[],
		spansAll: boolean,
	): Promise<QuickNoteOperationResult> {
		for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
			const loaded = await Promise.all(scopes.map(scope => (
				this.readSnapshot(scope, this.getNotesFilePath(scope) as string)
			)));
			// Повреждённый файл не перезаписывается; операции над всеми заметками его пропускают.
			const damaged = loaded.filter(snapshot => snapshot.error);
			const snapshots = spansAll ? loaded.filter(snapshot => !snapshot.error) : loaded;
			if (snapshots.length === 0 || (!spansAll && damaged.length > 0)) {
				return { ok: false, code: 'read-only', message: damaged[0]?.error };
			}
			const outcome = await this.applyToSnapshots(operation, snapshots);
			if (outcome !== 'retry') {
				return outcome;
			}
			this.log(`[quick-notes] ${QUICK_NOTES_FILE_NAME} изменён другим окном во время записи, попытка ${attempt}.`);
		}
		return {
			ok: false,
			code: 'failed',
			message: `Файл ${QUICK_NOTES_FILE_NAME} одновременно изменяется другим окном VS Code. Повторите действие.`,
		};
	}

	/**
	 * Один цикл: применение к прочитанным заметкам, подготовка вложений, запись изменённых файлов и очистка.
	 * Возвращает retry, если файл изменили после чтения.
	 */
	private async applyToSnapshots(
		operation: QuickNoteOperation,
		snapshots: readonly QuickNotesSnapshot[],
	): Promise<QuickNoteOperationResult | 'retry'> {
		const views = dropLeftoverMoveCopies(operation, snapshots.flatMap(snapshot => (
			snapshot.content.notes.map(note => ({ ...note, scope: snapshot.scope }))
		)));
		const plan = this.planOperation(operation, views);
		const applied = applyQuickNoteOperation(views, plan.operation);
		if (!applied.result.ok) {
			return applied.result;
		}
		// Файл без смысловых изменений не переписывается, чтобы не трогать ручное форматирование и не будить окна.
		const writes = orderSnapshotsForWrite(operation, snapshots)
			.map(snapshot => ({ snapshot, text: serializeQuickNotesFile(buildScopeContent(snapshot, applied.notes)) }))
			.filter(({ snapshot, text }) => text !== serializeQuickNotesFile(snapshot.content));
		await plan.before?.();
		if (!(await this.writeAllIfUnchanged(writes.map(({ snapshot, text }) => ({
			filePath: snapshot.filePath, text, expectedRaw: snapshot.raw,
		}))))) {
			return 'retry';
		}
		try {
			await plan.after?.(applied.notes);
		} catch (error) {
			// Заметки уже сохранены: оставшиеся лишние копии не отменяют результат.
			this.log(`[quick-notes] Не удалось очистить вложения после ${operation.kind}: ${describeError(error)}`);
		}
		return applied.result;
	}

	/** Действия с папками вложений для операций, которые удаляют или переносят заметки. */
	private planOperation(operation: QuickNoteOperation, views: readonly QuickNoteView[]): QuickNotesOperationPlan {
		switch (operation.kind) {
			case 'delete':
				return { operation, after: () => this.removeDir(this.getNoteDir(operation.scope, operation.id)) };
			case 'clearDone':
				return {
					operation,
					after: async notes => {
						const removed = views.filter(view => (
							!notes.some(note => note.scope === view.scope && note.id === view.id)
						));
						for (const view of removed) {
							await this.removeDir(this.getNoteDir(view.scope, view.id));
						}
					},
				};
			case 'changeScope':
				return this.planChangeScope(operation, views);
			case 'replace':
				return this.planReplace(operation, views);
			default:
				return { operation };
		}
	}

	/** Перенос между областями: папка копируется до записи, исходная удаляется после записи обоих файлов. */
	private planChangeScope(operation: QuickNoteChangeScopeOperation, views: readonly QuickNoteView[]): QuickNotesOperationPlan {
		const exists = views.some(view => view.scope === operation.scope && view.id === operation.id);
		const sourceDir = this.getNoteDir(operation.scope, operation.id);
		const targetDir = this.getNoteDir(operation.toScope, operation.id);
		// Повтор уже выполненного переноса не трогает вложения.
		if (!exists || operation.scope === operation.toScope || !sourceDir || !targetDir) {
			return { operation };
		}
		return {
			operation,
			before: async () => {
				await this.assertSafeStoragePath(sourceDir);
				await this.assertSafeStoragePath(targetDir);
				if (await isDirectory(sourceDir)) {
					await fs.promises.cp(sourceDir, targetDir, { recursive: true, force: true });
				}
			},
			after: () => this.removeDir(sourceDir),
		};
	}

	/**
	 * Сохранение черновика: сохранённые копии берутся из папки заметки, новые — из папки черновика.
	 * Новая копия с именем сохранённой получает суффикс, иначе она заменила бы прежний файл.
	 * Имя копии уже сохранённого файла (тот же id) берётся из текущей версии, а не из сообщения окна:
	 * устаревшее имя после переименования новой копии удалило бы её при очистке папки.
	 * Тесты — tests/quickNotesService.test.ts.
	 */
	private planReplace(operation: QuickNoteReplaceOperation, views: readonly QuickNoteView[]): QuickNotesOperationPlan {
		const noteId = operation.note.id;
		const current = views.find(view => view.scope === operation.scope && view.id === noteId);
		// Черновик мог импортировать файлы в исходную или целевую область окна.
		const draftDirs = operation.draftId
			? unique([
				this.getDraftDir(operation.scope, operation.draftId),
				this.getDraftDir(operation.toScope, operation.draftId),
			])
			: [];
		const removeDrafts = async () => {
			for (const draftDir of draftDirs) {
				await this.removeDir(draftDir);
			}
		};
		const sourceDir = this.getNoteDir(operation.scope, noteId);
		const targetDir = this.getNoteDir(operation.toScope, noteId);
		// Повтор применённого сохранения: вложения уже перенесены, остаётся убрать папку черновика.
		if (!current) {
			return { operation, after: removeDrafts };
		}
		if (!sourceDir || !targetDir) {
			// id из файла, правленного вручную, не годится для имени папки: новые файлы черновика сохранить некуда,
			// а запись без копий оставила бы ссылки на отсутствующие файлы. Черновик при отказе сохраняется.
			const hasNewFiles = operation.note.files.some(file => !current.files.some(saved => saved.id === file.id));
			return hasNewFiles
				? {
					operation,
					before: async () => {
						throw new Error(`идентификатор заметки «${noteId}» не подходит для имени папки вложений, файлы не сохранены`);
					},
				}
				: { operation, after: removeDrafts };
		}
		const savedFiles = new Map(current.files.map(file => [file.id, file]));
		// Заняты имена всех текущих файлов, включая удаляемые: новая копия не перезапишет файл до записи JSON,
		// поэтому при сбое записи сохранённая заметка продолжает ссылаться на прежнее содержимое.
		const taken = new Set(current.files.map(file => file.storedName.toLowerCase()));
		const copies: QuickNotesFileCopy[] = [];
		const files = operation.note.files.map(incoming => {
			const saved = savedFiles.get(incoming.id);
			const file = saved && saved.storedName !== incoming.storedName
				? { ...incoming, storedName: saved.storedName }
				: incoming;
			if (!isSafeQuickNoteStoredName(file.storedName)) {
				return file;
			}
			const inNote = path.join(sourceDir, file.storedName);
			const inDrafts = draftDirs.map(draftDir => path.join(draftDir, file.storedName));
			if (saved) {
				copies.push({ sources: [inNote, ...inDrafts], target: path.join(targetDir, file.storedName), required: false, name: file.name });
				return file;
			}
			const storedName = taken.has(file.storedName.toLowerCase())
				? buildSafeStoredName(file.storedName, taken)
				: file.storedName;
			taken.add(storedName.toLowerCase());
			copies.push({ sources: [...inDrafts, inNote], target: path.join(targetDir, storedName), required: true, name: file.name });
			return storedName === file.storedName ? file : { ...file, storedName };
		});
		return {
			operation: { ...operation, note: { ...operation.note, files } },
			before: async () => {
				await this.assertSafeStoragePath(targetDir);
				for (const copy of copies) {
					await this.copyFirstExisting(copy);
				}
			},
			after: async notes => {
				const saved = notes.find(note => note.scope === operation.toScope && note.id === noteId);
				if (saved) {
					await this.assertSafeStoragePath(targetDir);
					await removeEntriesExcept(targetDir, new Set(saved.files.map(file => file.storedName)));
				}
				if (sourceDir !== targetDir) {
					await this.removeDir(sourceDir);
				}
				await removeDrafts();
			},
		};
	}

	/**
	 * Атомарно заменяет файлы, если ни один не изменился после чтения в начале цикла; false означает повтор цикла.
	 * Временные файлы пишутся заранее, а проверка и замена всех файлов выполняются одним синхронным шагом:
	 * перенос между областями не записывает один файл, если другой успело изменить другое окно.
	 * Записанный текст запоминается как известный, чтобы эхо наблюдателя не считалось внешним изменением.
	 */
	private async writeAllIfUnchanged(
		writes: ReadonlyArray<{ filePath: string; text: string; expectedRaw: string | null }>,
	): Promise<boolean> {
		const prepared: Array<{ filePath: string; text: string; expectedRaw: string | null; temporaryPath: string }> = [];
		try {
			for (const write of writes) {
				await fs.promises.mkdir(path.dirname(write.filePath), { recursive: true });
				const temporaryPath = `${write.filePath}.${crypto.randomUUID()}.tmp`;
				prepared.push({ ...write, temporaryPath });
				await fs.promises.writeFile(temporaryPath, write.text, 'utf-8');
			}
			// Проверка и замена синхронны: между ними не выполняется другой код этого процесса.
			if (prepared.some(write => readTextOrNullSync(write.filePath) !== write.expectedRaw)) {
				return false;
			}
			for (const write of prepared) {
				const previousText = this.knownTexts.get(write.filePath);
				this.knownTexts.set(write.filePath, write.text);
				try {
					fs.renameSync(write.temporaryPath, write.filePath);
				} catch (error) {
					if (previousText === undefined) {
						this.knownTexts.delete(write.filePath);
					} else {
						this.knownTexts.set(write.filePath, previousText);
					}
					throw error;
				}
			}
			return true;
		} finally {
			for (const write of prepared) {
				await fs.promises.rm(write.temporaryPath, { force: true });
			}
		}
	}

	/** Копирует один источник в папку черновика; каталог или не обычный файл возвращает null. */
	private async importSource(
		source: QuickNotesImportSource,
		draftDir: string,
		existing: Set<string>,
	): Promise<QuickNoteFile | null> {
		let name: string;
		if ('path' in source) {
			const stat = await fs.promises.stat(source.path);
			if (!stat.isFile()) {
				return null;
			}
			name = path.basename(source.path);
		} else {
			name = source.name.split(/[\\/]/).pop() || '';
		}
		const storedName = buildSafeStoredName(name, existing);
		existing.add(storedName.toLowerCase());
		const target = path.join(draftDir, storedName);
		if ('path' in source) {
			await fs.promises.copyFile(source.path, target);
		} else {
			await fs.promises.writeFile(target, source.data);
		}
		const { size } = await fs.promises.stat(target);
		return { id: createQuickNoteId(), name: name || storedName, storedName, size, addedAt: this.now().toISOString() };
	}

	/** Удаляет папку целиком; null означает отсутствие безопасного пути, путь через ссылку не удаляется. */
	private async removeDir(directory: string | null): Promise<void> {
		if (!directory) {
			return;
		}
		if (!(await this.isSafeStoragePath(directory))) {
			this.log(`[quick-notes] Путь ${directory} проходит через символическую ссылку: удаление пропущено.`);
			return;
		}
		await fs.promises.rm(directory, { recursive: true, force: true });
	}

	/**
	 * Путь внутри папки хранилища области без символических ссылок ниже неё: ссылка, например закоммиченная
	 * в репозиторий, не должна увести удаление, очистку или копирование за пределы хранилища. Сама папка хранилища
	 * может быть ссылкой; несуществующий хвост пути допустим.
	 */
	private async isSafeStoragePath(target: string): Promise<boolean> {
		const root = QUICK_NOTE_SCOPES
			.map(scope => this.getStorageDir(scope))
			.find((directory): directory is string => directory !== null && isInsideDirectory(directory, target));
		if (!root) {
			return false;
		}
		let current = root;
		for (const part of path.relative(root, target).split(path.sep)) {
			current = path.join(current, part);
			try {
				if ((await fs.promises.lstat(current)).isSymbolicLink()) {
					return false;
				}
			} catch (error) {
				if (isMissingFileError(error)) {
					return true;
				}
				throw error;
			}
		}
		return true;
	}

	/** Отменяет действие с файлами, если путь проходит через символическую ссылку. */
	private async assertSafeStoragePath(target: string): Promise<void> {
		if (!(await this.isSafeStoragePath(target))) {
			throw new Error(`папка вложений заметок содержит символическую ссылку (${target}), действие отменено`);
		}
	}

	/**
	 * Копирует первый существующий источник; совпадение с целью ничего не меняет. Источник через ссылку пропускается.
	 * Обязательная копия без источника отменяет сохранение.
	 */
	private async copyFirstExisting(copy: QuickNotesFileCopy): Promise<void> {
		for (const source of copy.sources) {
			if (!(await this.isSafeStoragePath(source)) || !(await isRegularFile(source))) {
				continue;
			}
			if (path.resolve(source) !== path.resolve(copy.target)) {
				await fs.promises.mkdir(path.dirname(copy.target), { recursive: true });
				await fs.promises.copyFile(source, copy.target);
			}
			return;
		}
		if (copy.required) {
			throw new Error(`не найден файл «${copy.name}» черновика заметки, добавьте его снова`);
		}
	}

	/**
	 * Выполняет задачу после завершения всех очередей ключей. Хвосты всех ключей фиксируются синхронно
	 * в порядке workspace → global, поэтому операции над двумя файлами не блокируют друг друга.
	 */
	private runExclusive<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
		const uniqueKeys = [...new Set(keys)];
		const previous = uniqueKeys.map(key => this.queues.get(key) ?? Promise.resolve());
		const run = Promise.all(previous).then(task);
		const tail = run.then(() => undefined, () => undefined);
		for (const key of uniqueKeys) {
			this.queues.set(key, tail);
		}
		// Освободившаяся очередь не удерживает завершённую цепочку.
		void tail.then(() => {
			for (const key of uniqueKeys) {
				if (this.queues.get(key) === tail) {
					this.queues.delete(key);
				}
			}
		});
		return run;
	}

	/** Объединяет частые события файла области в одну проверку. */
	private scheduleChangeCheck(scope: QuickNoteScope): void {
		if (this.disposed) {
			return;
		}
		const previous = this.debounceTimers.get(scope);
		if (previous) {
			clearTimeout(previous);
		}
		const timer = setTimeout(() => {
			this.debounceTimers.delete(scope);
			this.changeChecks = this.changeChecks.then(() => this.checkExternalChange(scope));
		}, this.debounceMs);
		timer.unref?.();
		this.debounceTimers.set(scope, timer);
	}

	/** Уведомляет подписчиков, если текст файла отличается от последней собственной записи. */
	private async checkExternalChange(scope: QuickNoteScope): Promise<void> {
		const filePath = this.getNotesFilePath(scope);
		if (this.disposed || !filePath) {
			return;
		}
		let isEcho = false;
		try {
			const text = await readTextOrNull(filePath);
			isEcho = text !== null && text === this.knownTexts.get(filePath);
			if (!isEcho) {
				if (text === null) {
					this.knownTexts.delete(filePath);
				} else {
					this.knownTexts.set(filePath, text);
				}
			}
		} catch (error) {
			// Нечитаемый файл тоже показывается панелям: состояние сообщит об ошибке области.
			this.log(`[quick-notes] Не удалось прочитать изменённый ${QUICK_NOTES_FILE_NAME}: ${describeError(error)}`);
		}
		if (this.disposed || isEcho) {
			return;
		}
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch (error) {
				this.log(`[quick-notes] Ошибка обработчика изменения заметок: ${describeError(error)}`);
			}
		}
	}
}

/** Разбирает текст файла: пустой или отсутствующий файл — пустой список, иное не-объектное содержимое — повреждение. */
function parseQuickNotesText(raw: string | null): { content: QuickNotesFileContent; error?: string } {
	const empty = normalizeQuickNotesFile(undefined);
	const text = (raw ?? '').replace(/^﻿/, '');
	if (!text.trim()) {
		return { content: empty };
	}
	const corrupted = (reason: string) => ({ content: empty, error: `Файл ${QUICK_NOTES_FILE_NAME} повреждён: ${reason}` });
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return corrupted(describeError(error));
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return corrupted('ожидается JSON-объект.');
	}
	const notes = (parsed as Record<string, unknown>).notes;
	if (notes !== undefined && !Array.isArray(notes)) {
		return corrupted('поле notes должно быть массивом.');
	}
	return { content: normalizeQuickNotesFile(parsed) };
}

/**
 * Новое содержимое файла области: верхнеуровневые поля и позиции записей сохраняются, новые заметки — в начало.
 * Повтор переноса после частичной записи может дать две копии одной заметки: остаётся первая.
 */
function buildScopeContent(snapshot: QuickNotesSnapshot, notes: readonly QuickNoteView[]): QuickNotesFileContent {
	const next = new Map<string, QuickNote>();
	for (const note of notes) {
		if (note.scope === snapshot.scope && !next.has(note.id)) {
			next.set(note.id, toStoredQuickNote(note));
		}
	}
	const kept: QuickNote[] = [];
	for (const note of snapshot.content.notes) {
		const updated = next.get(note.id);
		if (updated) {
			kept.push(updated);
			next.delete(note.id);
		}
	}
	return { ...snapshot.content, notes: [...next.values(), ...kept] };
}

/**
 * Копия заметки в целевой области, оставшаяся от прерванного переноса (сбой замены второго файла), убирается,
 * пока заметка есть в исходной области: перенос повторяется от исходной версии, а не от устаревшей копии.
 */
function dropLeftoverMoveCopies(operation: QuickNoteOperation, views: QuickNoteView[]): QuickNoteView[] {
	if ((operation.kind !== 'changeScope' && operation.kind !== 'replace') || operation.scope === operation.toScope) {
		return views;
	}
	const id = operation.kind === 'replace' ? operation.note.id : operation.id;
	if (!views.some(view => view.scope === operation.scope && view.id === id)) {
		return views;
	}
	return views.filter(view => !(view.scope === operation.toScope && view.id === id));
}

/** Ключ сравнения папок: реальный путь существующей части, в Windows и macOS без учёта регистра. */
function canonicalDirectoryKey(directory: string): string {
	let existing = path.resolve(directory);
	const rest: string[] = [];
	for (;;) {
		try {
			existing = fs.realpathSync.native(existing);
			break;
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) {
				break;
			}
			rest.unshift(path.basename(existing));
			existing = parent;
		}
	}
	const resolved = path.join(existing, ...rest);
	return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** Две папки указывают на одно место. */
function isSameDirectory(left: string, right: string): boolean {
	return canonicalDirectoryKey(left) === canonicalDirectoryKey(right);
}

/** Порядок записи: при смене области сначала целевой файл, затем исходный, иначе workspace → global. */
function orderSnapshotsForWrite(operation: QuickNoteOperation, snapshots: readonly QuickNotesSnapshot[]): QuickNotesSnapshot[] {
	if ((operation.kind === 'replace' || operation.kind === 'changeScope') && operation.scope !== operation.toScope) {
		const target = snapshots.filter(snapshot => snapshot.scope === operation.toScope);
		return [...target, ...snapshots.filter(snapshot => snapshot.scope !== operation.toScope)];
	}
	return [...snapshots];
}

/** Имя копии по общему правилу; если суффикс повтора сделал имя небезопасным, берётся случайное имя. */
function buildSafeStoredName(name: string, existing: ReadonlySet<string>): string {
	const storedName = buildQuickNoteStoredName(name, existing);
	if (isSafeQuickNoteStoredName(storedName)) {
		return storedName;
	}
	const extension = path.extname(storedName);
	return `${createQuickNoteId()}${extension.length <= MAX_FALLBACK_EXTENSION_LENGTH ? extension : ''}`;
}

/** Удаляет из папки записи, которых нет среди сохраняемых имён; отсутствующая папка пропускается. */
async function removeEntriesExcept(directory: string, keep: ReadonlySet<string>): Promise<void> {
	let names: string[];
	try {
		names = await fs.promises.readdir(directory);
	} catch (error) {
		if (isMissingFileError(error)) {
			return;
		}
		throw error;
	}
	for (const name of names) {
		if (!keep.has(name)) {
			await fs.promises.rm(path.join(directory, name), { recursive: true, force: true });
		}
	}
}

/** Проверяет, что путь лежит внутри папки и не совпадает с ней. */
function isInsideDirectory(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== '' && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
}

/** Обычный файл без перехода по символической ссылке. */
async function isRegularFile(filePath: string): Promise<boolean> {
	try {
		return (await fs.promises.lstat(filePath)).isFile();
	} catch {
		return false;
	}
}

/** Существующий каталог. */
async function isDirectory(directory: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(directory)).isDirectory();
	} catch {
		return false;
	}
}

/** Текст файла или null, если файла нет. */
async function readTextOrNull(filePath: string): Promise<string | null> {
	try {
		return await fs.promises.readFile(filePath, 'utf-8');
	} catch (error) {
		if (isMissingFileError(error)) {
			return null;
		}
		throw error;
	}
}

/** Синхронный вариант чтения для проверки непосредственно перед заменой файла. */
function readTextOrNullSync(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, 'utf-8');
	} catch (error) {
		if (isMissingFileError(error)) {
			return null;
		}
		throw error;
	}
}

/** Ошибка отсутствующего файла или папки. */
function isMissingFileError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Текст ошибки для сообщения и лога. */
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Непустые значения без повторов в исходном порядке. */
function unique(values: ReadonlyArray<string | null>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
