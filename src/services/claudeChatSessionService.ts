import { constants, watch as watchDirectory, type FSWatcher, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type {
	ClaudeChatConfiguration, ClaudeChatPendingLaunch, ClaudeChatSdkAdapter,
	ClaudeChatSessionBinding, ClaudeChatSessionInfo, ClaudeChatSessionSnapshot,
} from '../types/claudeChat.js';
import {
	ClaudeChatSessionError, ClaudeChatTranscriptAccumulator, encodeClaudeChatProjectPath,
	getClaudeChatHumanUser, hasClaudeChatLaunchMarker, isClaudeChatLaunchMarker, isClaudeChatSessionId,
	normalizeClaudeChatProjectPath, type ClaudeChatTranscriptAnalysis,
} from '../utils/claudeChat.js';

export { ClaudeChatSessionError } from '../utils/claudeChat.js';
export type { ClaudeChatSdkAdapter } from '../types/claudeChat.js';

/** Ограничения защищают extension host от неограниченной переписки и зависшего SDK. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_LIST_SESSIONS = 1_000;
const SDK_TIMEOUT_MS = 15_000;
const WATCH_DEBOUNCE_MS = 150;

/** Фиксированный worker разрешает только файловые SDK-операции; пользовательский код не исполняется. */
const SDK_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
// Список методов исключает query, startup и запуск CLI даже при ошибке вызывающего кода.
(async () => {
  if (!['listSessions', 'renameSession'].includes(workerData.method)) throw new Error('unsupported SDK method');
  const sdk = await import(workerData.moduleUrl);
  const value = await sdk[workerData.method](...workerData.args);
  parentPort.postMessage({ ok: true, value });
})().catch(() => parentPort.postMessage({ ok: false }));
`;

/** Сигнатура stat и компактные результаты, без хранения строк transcript. */
interface CachedTranscript {
	/** Изменение inode, размера или времени отменяет повторное использование результата. */
	signature: string;
	/** Метаданные проверенной сессии для чтения и подтверждения первого запуска. */
	analysis?: ClaudeChatTranscriptAnalysis;
	/** Проверка существования не зависит от возможности точного расчёта длительности. */
	identity: SessionIdentity;
	/** Неподдержанный неизменённый файл не разбирается при каждом событии интерфейса. */
	timingError?: ClaudeChatSessionError;
}

/** Безопасно подтверждённая принадлежность файла без восстановления времени и цепочек компактации. */
interface SessionIdentity {
	/** Есть сообщения именно указанного UUID, а не только заголовок или пустой файл. */
	hasMessages: boolean;
	/** Первый обычный запрос нужен только для корреляции нового запуска. */
	firstUser?: ClaudeChatTranscriptAnalysis['firstUser'];
}

/** Отслеживает только собственные подписки; не зависит от VS Code и не запускает AI. */
export class ClaudeChatSessionService {
	/** Неизменяемая копия разрешённого конфигурационного scope. */
	private readonly config: ClaudeChatConfiguration;
	/** Кэш ограничен числом сессий, а параллельные чтения одного файла объединяются. */
	private readonly cache = new Map<string, CachedTranscript>();
	private readonly reads = new Map<string, Promise<ClaudeChatTranscriptAnalysis | undefined>>();
	/** Собственные worker и подписки освобождаются даже при закрытии manager во время операции. */
	private readonly workers = new Map<Worker, () => void>();
	private readonly subscriptions = new Set<{ dispose(): void }>();
	private disposed = false;
	/** Последовательный запуск SDK ограничивает число тяжёлых импортов и операции переименования. */
	private sdkQueue: Promise<void> = Promise.resolve();

	/** Принимает проверенный effective configDir; тестовый adapter не читает пользовательские ресурсы. */
	constructor(config: ClaudeChatConfiguration, private readonly sdkAdapter?: ClaudeChatSdkAdapter) {
		if (!path.isAbsolute(config.configDir) || !normalizeClaudeChatProjectPath(config.configDir)) {
			throw new ClaudeChatSessionError('invalid-state', 'Каталог конфигурации Claude должен быть абсолютным.');
		}
		if (config.projectDirName !== undefined && (!/^[A-Za-z0-9_-]{1,64}$/.test(config.projectDirName)
			|| /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(config.projectDirName))) {
			throw new ClaudeChatSessionError('invalid-state', 'Некорректное имя каталога проекта Claude.');
		}
		this.config = { ...config, configDir: path.resolve(config.configDir) };
	}

	/** Связывает только новый корневой transcript с единственным полным маркером; см. service tests. */
	async findSession(pending: ClaudeChatPendingLaunch): Promise<ClaudeChatSessionBinding | undefined> {
		this.assertActive();
		if (!isClaudeChatLaunchMarker(pending.marker) || !Number.isSafeInteger(pending.startedAt)
			|| pending.startedAt < 0 || !Array.isArray(pending.projectPaths)
			|| pending.projectPaths.length === 0 || pending.projectPaths.length > 32) {
			throw new ClaudeChatSessionError('invalid-state', 'Некорректное ожидание запуска Claude.');
		}
		const found = new Map<string, ClaudeChatSessionBinding>();
		for (const requestedPath of new Set(pending.projectPaths)) {
			const projectPath = await this.projectPath(requestedPath);
			// Предварительная проверка запрещает SDK проходить через подменённый projects/каталог проекта.
			if (!await this.storageDirectory(projectPath)) continue;
			const sessions = await this.callSdk('listSessions', [{
				dir: projectPath, includeWorktrees: false, includeProgrammatic: false, limit: MAX_LIST_SESSIONS + 1,
			}]) as ClaudeChatSessionInfo[];
			if (!Array.isArray(sessions) || sessions.length > MAX_LIST_SESSIONS) {
				throw new ClaudeChatSessionError('ambiguous-session', 'Список сессий слишком велик для однозначной привязки.');
			}
			for (const session of sessions) {
				if (!isClaudeChatSessionId(session.sessionId) || !hasClaudeChatLaunchMarker(session.firstPrompt, pending.marker)) continue;
				const binding: ClaudeChatSessionBinding = { sessionId: session.sessionId, projectPath, accountedMs: 0 };
				let identity: SessionIdentity | undefined;
				try { identity = await this.readTranscript(projectPath, binding.sessionId, true); }
				catch (error) {
					if (error instanceof ClaudeChatSessionError && error.code === 'not-main-session') continue;
					throw error;
				}
				const first = identity?.firstUser;
				if (!first || first.timestamp < pending.startedAt || !hasClaudeChatLaunchMarker(first.prefix, pending.marker)) continue;
				if (!first.cwd || await this.projectPath(first.cwd) !== projectPath) continue;
				found.set(`${projectPath}\0${binding.sessionId}`, binding);
			}
		}
		if (found.size > 1) throw new ClaudeChatSessionError('ambiguous-session', 'Маркер найден в нескольких сессиях Claude.');
		return found.values().next().value;
	}

	/** Возвращает точное состояние проверенного файла; неподдержанный формат остаётся явной ошибкой. */
	async readSession(binding: ClaudeChatSessionBinding): Promise<ClaudeChatSessionSnapshot | undefined> {
		const analysis = await this.readAnalysis(binding);
		return analysis?.firstUser ? { ...analysis.snapshot } : undefined;
	}

	/** Подтверждает существование и принадлежность файла даже при неподдержанной истории длительностей. */
	async hasSession(binding: ClaudeChatSessionBinding): Promise<boolean> {
		this.assertActive();
		if (!isClaudeChatSessionId(binding.sessionId)) throw new ClaudeChatSessionError('invalid-state', 'Некорректный UUID Claude.');
		const identity = await this.readTranscript(await this.projectPath(binding.projectPath), binding.sessionId, true);
		return identity?.hasMessages === true;
	}

	/** Единственная мутация передаётся публичному SDK после проверки идентификатора и существующего файла. */
	async renameSession(binding: ClaudeChatSessionBinding, title: string): Promise<void> {
		if (typeof title !== 'string' || !title.trim() || title.length > 1_000 || /[\x00-\x1f\x7f]/.test(title)) {
			throw new ClaudeChatSessionError('invalid-state', 'Название сессии Claude должно быть непустой строкой.');
		}
		if (!await this.hasSession(binding)) throw new ClaudeChatSessionError('invalid-state', 'Сессия Claude не найдена.');
		await this.callSdk('renameSession', [binding.sessionId, title.trim(), { dir: await this.projectPath(binding.projectPath) }]);
		this.cache.clear();
	}

	/** Наблюдает нужные каталоги и их создание; события объединяются без периодического опроса диска. */
	watch(projectPaths: string[], callback: (error?: Error) => void | Promise<void>): { dispose(): void } {
		this.assertActive();
		if (projectPaths.length === 0 || projectPaths.length > 32) {
			throw new ClaudeChatSessionError('invalid-state', 'Для наблюдения Claude требуется ограниченный список проектов.');
		}
		// Подписка владеет только своими дескрипторами и одним отложенным уведомлением.
		const watchers = new Map<string, FSWatcher>();
		/** На Linux путь может остаться прежним после замены inode каталога. */
		const watcherIdentities = new Map<string, string>();
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let refreshing = false;
		let again = false;
		/** Исключение потребителя не создаёт бесконечную цепочку уведомлений об ошибке. */
		const notify = (error?: Error): void => {
			Promise.resolve().then(() => stopped ? undefined : callback(error)).catch(() => undefined);
		};
		/** Событие каталога вызывает одну сверку подписок после серии файловых записей. */
		const schedule = (): void => {
			if (stopped) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => { timer = undefined; void refresh(true); }, WATCH_DEBOUNCE_MS);
			timer.unref?.();
		};
		/** Для ещё не созданного каталога наблюдается только имя следующего отсутствующего компонента. */
		const locate = async (target: string): Promise<{ directory: string; child?: string }> => {
			let directory = target;
			let child: string | undefined;
			while (true) {
				try {
					const stat = await lstat(directory);
					if (!stat.isDirectory() || stat.isSymbolicLink()) this.unsafePath();
					return { directory, child };
				} catch (error) {
					if (!isMissing(error)) throw error;
					const parent = path.dirname(directory);
					if (parent === directory) throw error;
					child = path.basename(directory);
					directory = parent;
				}
			}
		};
		/** Перестраивает только изменившиеся уровни; первоначальное уведомление закрывает гонку начала наблюдения. */
		const refresh = async (emit: boolean): Promise<void> => {
			if (stopped) return;
			if (refreshing) { again = true; return; }
			refreshing = true;
			try {
				const targets = new Map<string, { directory: string; child?: string }>();
				for (const requested of new Set(projectPaths)) {
					const project = await this.projectPath(requested);
					const root = await this.configRoot();
					const target = path.join(root ?? this.config.configDir, 'projects', this.projectKey(project));
					// Проверяем существующие компоненты перед регистрацией системного наблюдателя.
					await this.storageDirectory(project);
					const located = await locate(target);
					targets.set(`${located.directory}\0${located.child ?? ''}`, located);
					// Родители остаются под наблюдением после создания файла и замечают удаление/пересоздание каталогов.
					for (const childPath of [root ?? this.config.configDir, path.dirname(target), target]) {
						const parent = await locate(path.dirname(childPath));
						const child = parent.child ?? path.basename(childPath);
						targets.set(`${parent.directory}\0${child}`, { directory: parent.directory, child });
					}
				}
				if (stopped) return;
				for (const [key, watcher] of watchers) if (!targets.has(key)) {
					watcher.close(); watchers.delete(key); watcherIdentities.delete(key);
				}
				for (const [key, target] of targets) {
					const stat = await lstat(target.directory, { bigint: true });
					const identity = `${stat.dev}:${stat.ino}`;
					if (watchers.has(key) && watcherIdentities.get(key) === identity) continue;
					watchers.get(key)?.close();
					const watcher = watchDirectory(target.directory, { persistent: false }, (_event, filename) => {
						const name = filename?.toString();
						if (!name || (target.child ? name === target.child : /^[0-9a-f-]{36}\.jsonl$/i.test(name))) schedule();
					});
					watcher.on('error', () => {
						watcher.close(); watchers.delete(key); watcherIdentities.delete(key);
						if (!stopped) notify(new ClaudeChatSessionError('unsafe-path', 'Наблюдение за сессиями Claude прервано.'));
					});
					watchers.set(key, watcher);
					watcherIdentities.set(key, identity);
				}
				if (emit && !stopped) notify();
			} catch (error) { if (!stopped) notify(safeError(error)); }
			finally { refreshing = false; if (again && !stopped) { again = false; schedule(); } }
		};
		const subscription = {
			/** Освобождает именно эту подписку, не затрагивая других потребителей сервиса. */
			dispose: (): void => {
				stopped = true;
				if (timer) clearTimeout(timer);
				for (const watcher of watchers.values()) watcher.close();
				watchers.clear();
				watcherIdentities.clear();
				this.subscriptions.delete(subscription);
			},
		};
		this.subscriptions.add(subscription);
		void refresh(true);
		return subscription;
	}

	/** Закрывает подписки, прерывает worker и запрещает дальнейшие операции. */
	dispose(): void {
		this.disposed = true;
		for (const subscription of [...this.subscriptions]) subscription.dispose();
		for (const cancel of this.workers.values()) cancel();
		this.cache.clear();
	}

	/** Сопоставляет абсолютный проект с реальным cwd без обращения к другим рабочим областям. */
	private async projectPath(value: string): Promise<string> {
		this.assertActive();
		if (!path.isAbsolute(value) || !normalizeClaudeChatProjectPath(value)) {
			throw new ClaudeChatSessionError('invalid-state', 'Некорректный абсолютный путь проекта Claude.');
		}
		try { return await realpath(value); }
		catch (error) { if (isMissing(error)) return path.resolve(value); throw safeError(error); }
	}

	/** Следует только явно настроенной ссылке configDir, сохраняя её реальный корень как границу. */
	private async configRoot(): Promise<string | undefined> {
		try {
			const root = await realpath(this.config.configDir);
			if (!(await lstat(root)).isDirectory()) this.unsafePath();
			return root;
		}
		catch (error) { if (isMissing(error)) return undefined; throw safeError(error); }
	}

	/** Использует штатное фиксированное имя или точное кодирование cwd текущего CLI. */
	private projectKey(project: string): string {
		return this.config.projectDirName ?? encodeClaudeChatProjectPath(project);
	}

	/** Проверяет каждый управляемый компонент пути и не следует ссылкам вне или внутри projects. */
	private async storageDirectory(project: string): Promise<string | undefined> {
		const root = await this.configRoot();
		if (!root) return undefined;
		let current = root;
		for (const segment of ['projects', this.projectKey(project)]) {
			current = path.join(current, segment);
			try {
				const stat = await lstat(current);
				if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) this.unsafePath();
			} catch (error) { if (isMissing(error)) return undefined; throw error; }
		}
		return current;
	}

	/** Объединяет конкурирующие чтения одного UUID, сохраняя ошибки вместо фиктивного успеха. */
	private async readAnalysis(binding: ClaudeChatSessionBinding): Promise<ClaudeChatTranscriptAnalysis | undefined> {
		this.assertActive();
		if (!isClaudeChatSessionId(binding.sessionId)) throw new ClaudeChatSessionError('invalid-state', 'Некорректный UUID Claude.');
		const project = await this.projectPath(binding.projectPath);
		const key = `${project}\0${binding.sessionId}`;
		const pending = this.reads.get(key);
		if (pending) return pending;
		const read = this.readTranscript(project, binding.sessionId);
		this.reads.set(key, read);
		try { return await read; }
		finally { this.reads.delete(key); }
	}

	/** Читает ограниченный снимок одного regular file; stat-кэш не перечитывает неизменённый transcript. */
	private readTranscript(project: string, sessionId: string, identityOnly: true): Promise<SessionIdentity | undefined>;
	private readTranscript(project: string, sessionId: string, identityOnly?: false): Promise<ClaudeChatTranscriptAnalysis | undefined>;
	private async readTranscript(project: string, sessionId: string, identityOnly = false):
		Promise<ClaudeChatTranscriptAnalysis | SessionIdentity | undefined> {
		const directory = await this.storageDirectory(project);
		if (!directory) return undefined;
		const filename = path.join(directory, `${sessionId}.jsonl`);
		let initial: BigIntStats;
		try { initial = await lstat(filename, { bigint: true }); }
		catch (error) { if (isMissing(error)) { this.cache.delete(filename); return undefined; } throw safeError(error); }
		if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n) this.unsafePath();
		if (initial.size > BigInt(MAX_TRANSCRIPT_BYTES)) {
			throw new ClaudeChatSessionError('unsupported-transcript', 'Transcript превышает безопасный размер чтения.');
		}
		const signature = statSignature(initial);
		const cached = this.cache.get(filename);
		if (cached?.signature === signature) {
			if (identityOnly) return cached.identity;
			if (cached.timingError) throw cached.timingError;
			if (cached.analysis) return cached.analysis;
		}
		const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
		const handle = await open(filename, flags).catch(error => { throw safeError(error); });
		try {
			if (statSignature(await handle.stat({ bigint: true })) !== signature
				|| await realpath(filename) !== filename || await this.storageDirectory(project) !== directory) this.unsafePath();
			const parser = new ClaudeChatTranscriptAccumulator(sessionId);
			const identity: SessionIdentity = { hasMessages: false };
			let timingError: ClaudeChatSessionError | undefined;
			let sawSidechain = false;
			// Буфер и незаконченная строка ограничены независимо от полного размера transcript.
			const buffer = Buffer.alloc(64 * 1024);
			let pending = Buffer.alloc(0);
			let position = 0;
			while (position < Number(initial.size)) {
				this.assertActive();
				const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(initial.size) - position), position);
				if (bytesRead === 0) throw new ClaudeChatSessionError('session-changed', 'Transcript изменился во время чтения.');
				position += bytesRead;
				const chunk = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
				let start = 0;
				let end = chunk.indexOf(10, start);
				while (end !== -1) {
					if (end - start > MAX_LINE_BYTES) this.largeLine();
					const line = chunk.subarray(start, end).toString('utf8').trim();
					if (line) {
						let entry: unknown;
						try { entry = JSON.parse(line); }
						catch { throw new ClaudeChatSessionError('unsupported-transcript', 'В transcript обнаружена повреждённая строка.'); }
						if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
							throw new ClaudeChatSessionError('unsupported-transcript', 'Некорректная запись transcript.');
						}
						const record = entry as Record<string, unknown>;
						if (record.sessionId !== undefined && record.sessionId !== sessionId) this.unsafePath();
						if (record.forkedFrom || record.parentSessionId) {
							throw new ClaudeChatSessionError('not-main-session', 'Копия сессии не подтверждает новый запуск.');
						}
						if (record.isSidechain || record.teamName || record.agentId) sawSidechain = true;
						else if (record.type === 'user' || record.type === 'assistant') {
							if (record.sessionId !== sessionId || !isClaudeChatSessionId(record.uuid)) this.unsafePath();
							identity.hasMessages = true;
							identity.firstUser ??= getClaudeChatHumanUser(record);
						}
						if (!identityOnly && !timingError) {
							try { parser.add(entry); }
							catch (error) {
								if (!(error instanceof ClaudeChatSessionError) || error.code !== 'unsupported-transcript') throw error;
								timingError = error;
							}
						}
					}
					start = end + 1;
					end = chunk.indexOf(10, start);
				}
				pending = Buffer.from(chunk.subarray(start));
				if (pending.length > MAX_LINE_BYTES) this.largeLine();
			}
			// Без завершающего LF строка может дописываться Claude, поэтому не считаем её окончанием запроса.
			if (!identity.hasMessages && sawSidechain) {
				throw new ClaudeChatSessionError('not-main-session', 'Transcript относится к дочерней сессии.');
			}
			let analysis: ClaudeChatTranscriptAnalysis | undefined;
			if (!identityOnly && !timingError) {
				try { analysis = parser.finish(pending.toString('utf8').trim().length > 0); }
				catch (error) {
					if (!(error instanceof ClaudeChatSessionError) || error.code !== 'unsupported-transcript') throw error;
					timingError = error;
				}
			}
			if (statSignature(await handle.stat({ bigint: true })) !== signature
				|| statSignature(await lstat(filename, { bigint: true })) !== signature) {
				throw new ClaudeChatSessionError('session-changed', 'Transcript изменился во время чтения.');
			}
			this.assertActive();
			this.cache.delete(filename);
			this.cache.set(filename, { signature, analysis, identity, timingError });
			while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
			if (timingError) throw timingError;
			return identityOnly ? identity : analysis;
		} finally { await handle.close(); }
	}

	/** Последовательный SDK worker получает отдельное окружение; общий process.env остаётся неизменным. */
	private callSdk(method: 'listSessions' | 'renameSession', args: unknown[]): Promise<unknown> {
		const operation = this.sdkQueue.then(async () => {
			this.assertActive();
			if (this.sdkAdapter) {
				if (method === 'listSessions') return this.sdkAdapter.listSessions(args[0] as Parameters<ClaudeChatSdkAdapter['listSessions']>[0]);
				return this.sdkAdapter.renameSession(args[0] as string, args[1] as string, args[2] as { dir: string });
			}
			// Выпуск содержит отдельный ESM bundle; тесты исходников используют закреплённую dev-зависимость.
			let moduleUrl: string;
			try {
				const bundledPath = path.join(__dirname, 'claude-chat-sdk.mjs');
				const bundled = await lstat(bundledPath).then(stat => stat.isFile(), error => {
					if (isMissing(error)) return false;
					throw error;
				});
				moduleUrl = pathToFileURL(bundled ? bundledPath : require.resolve('@anthropic-ai/claude-agent-sdk')).href;
			}
			catch { throw new ClaudeChatSessionError('sdk-error', 'Публичный SDK Claude недоступен в установке расширения.'); }
			const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: this.config.configDir };
			if (this.config.projectDirName) env.CLAUDE_CODE_PROJECT_DIR_NAME = this.config.projectDirName;
			else delete env.CLAUDE_CODE_PROJECT_DIR_NAME;
			return new Promise<unknown>((resolve, reject) => {
				const worker = new Worker(SDK_WORKER, { eval: true, env, workerData: { moduleUrl, method, args } });
				let settled = false;
				/** Любой исход закрывает worker; текст внутренних ошибок SDK не раскрывается пользователю. */
				const finish = (error?: Error, value?: unknown): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					this.workers.delete(worker);
					worker.removeAllListeners();
					void worker.terminate().catch(() => undefined);
					if (error) reject(error); else resolve(value);
				};
				const timer = setTimeout(() => finish(new ClaudeChatSessionError('sdk-error', 'SDK Claude не ответил вовремя.')), SDK_TIMEOUT_MS);
				this.workers.set(worker, () => finish(new ClaudeChatSessionError('disposed', 'Сервис Claude закрыт.')));
				worker.once('message', response => response?.ok === true ? finish(undefined, response.value)
					: finish(new ClaudeChatSessionError('sdk-error', 'SDK Claude не смог выполнить файловую операцию.')));
				worker.once('error', () => finish(new ClaudeChatSessionError('sdk-error', 'Не удалось загрузить SDK Claude.')));
				worker.once('exit', () => finish(new ClaudeChatSessionError('sdk-error', 'SDK Claude завершился без результата.')));
			});
		});
		this.sdkQueue = operation.then(() => undefined, () => undefined);
		return operation;
	}

	/** Запрещает новые операции после освобождения ресурсов. */
	private assertActive(): void {
		if (this.disposed) throw new ClaudeChatSessionError('disposed', 'Сервис Claude закрыт.');
	}

	/** Общая безопасная ошибка для ссылок, специальных файлов и подмены inode. */
	private unsafePath(): never {
		throw new ClaudeChatSessionError('unsafe-path', 'Путь к сессии Claude не прошёл безопасную проверку.');
	}

	/** Размер одной строки ограничен, даже если весь файл ещё укладывается в лимит. */
	private largeLine(): never {
		throw new ClaudeChatSessionError('unsupported-transcript', 'Строка transcript превышает безопасный размер.');
	}
}

/** Отсутствующий каталог не является ошибкой: новый чат мог ещё не записать transcript. */
function isMissing(error: unknown): boolean {
	return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');
}

/** Сравнивает точные времена и inode, чтобы одинаковый размер не маскировал переписанный файл. */
function statSignature(stat: BigIntStats): string {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** Не включает пути, содержимое transcript и диагностические секреты SDK в исключение. */
function safeError(error: unknown): ClaudeChatSessionError {
	return error instanceof ClaudeChatSessionError ? error
		: new ClaudeChatSessionError('unsafe-path', 'Не удалось безопасно прочитать локальную сессию Claude.');
}
