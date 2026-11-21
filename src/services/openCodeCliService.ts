import type * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
	findOpenCodeExecutable, hasOpenCodeSubmission, hasOpenCodeSessionTitle, isSupportedOpenCodeVersion, OpenCodeTerminalOutput,
	buildOpenCodeLaunchCommand, runOpenCodeCli, validateOpenCodeContext, type OpenCodeCliRunner,
} from '../utils/openCodeCli.js';

/** Только стабильные терминальные API; unit-тесты передают изолированный host. */
export type OpenCodeTerminalHost = Pick<typeof vscode.window,
	'createTerminal' | 'terminals' | 'onDidChangeTerminalShellIntegration' | 'onDidCloseTerminal'>;

/** Данные одного запуска не содержат настроек модели или разрешений OpenCode. */
export interface OpenCodeCliRequest {
	/** Стабильная принадлежность терминала переживает переименование папки промпта. */
	promptUuid: string;
	/** Общее название терминала и сессии: «Номер | Название», без номера — только название. */
	title: string;
	/** Абсолютный каталог на хосте Extension Host. */
	cwd: string;
	/** Готовый общий текст задачи без изменения модели и разрешений CLI. */
	query: string;
	/** Абсолютные пути native-вложений; сервис проверяет чтение и убирает дубли. */
	files: string[];
	/** Явно разрешённая отправка после подготовки; false оставляет черновик. */
	autoStart: boolean;
	/** Guard повторно проверяет поколение запуска после await перед изменением файлов промпта. */
	onManualSubmission?: (isCurrentLaunch: () => boolean) => Promise<void>;
	/** Ошибка оформления не отменяет подтверждённую отправку запроса. */
	onWarning?: (message: string) => void;
}

/** Подтверждённая отправка отличается от подготовленного или неподтверждённого запроса. */
export interface OpenCodeCliResult {
	/** true означает подтверждённый приём текста и файлов, а не запись Enter в терминал. */
	dispatched: boolean;
	/** Сообщает о готовности черновика либо результате подтверждения отправки. */
	message: string;
}

/** Runtime-привязка принадлежит UUID, терминалу и отдельному IDE-соединению. */
interface OpenCodeLaunch {
	/** Каждая попытка получает поколение до первого await; неудача не возвращает права старой сессии. */
	generation: symbol;
	/** Этап позволяет различать готовность CLI, IDE-соединение, добавление файлов и вставку. */
	stage: string;
	/** Точный терминал, созданный этой попыткой. */
	terminal?: vscode.Terminal;
	/** Собственный listener не обслуживает другие TUI или browser Origin. */
	server: WebSocketServer;
	/** Единственное IDE-соединение назначенного терминала. */
	socket?: WebSocket;
	/** Подтверждённый обмен initialize / notifications/initialized. */
	initialized: boolean;
	/** Закрытие отменяет ожидания и запрещает дальнейшую передачу. */
	closed: boolean;
	/** Повторные OSC-события не запускают дополнительные проверки одной отправки. */
	submissionChecked: boolean;
	/** Ограниченный хвост terminal output для сборки маркеров отрисовки. */
	output: OpenCodeTerminalOutput;
	/** Активные ожидания состояния, удаляемые при завершении или отмене. */
	wake: Set<() => void>;
	/** Новая identity назначается до запуска и проверяется по экспорту. */
	sessionId: string;
	/** Найденный и проверенный исполняемый файл, без shell-подстановок. */
	executable: string;
	/** Снимок условий запуска и callback ручного подтверждения. */
	request: OpenCodeCliRequest;
	/** Доступные файлы после устранения дубликатов. */
	files: string[];
	/** Прерывает чтение после закрытия IDE-канала, даже если TUI больше не пишет данные. */
	stopOutput?: () => void;
}

/** Метка сохраняет принадлежность живого терминала при повторной активации расширения. */
const TERMINAL_UUID_KEY = 'PROMPT_MANAGER_OPENCODE_UUID';

/** Определяет промпт по метке терминала Prompt Manager, в том числе после восстановления окна. */
export function getOpenCodeTerminalPromptUuid(terminal: vscode.Terminal | undefined): string | undefined {
	const options = terminal?.creationOptions;
	return options && 'env' in options ? options.env?.[TERMINAL_UUID_KEY] ?? undefined : undefined;
}

/** Предел холодного запуска не подменяет проверку готовности произвольной паузой. */
const STARTUP_TIMEOUT_MS = 120_000;

/** Запускает отдельный TUI с адресными файлами; проверки: tests/openCodeCliService.test.ts. */
export class OpenCodeCliService {
	/** Запущенные терминалы и блокировки независимы для каждого промпта. */
	private readonly launches = new Map<string, OpenCodeLaunch>();
	/** Лёгкая привязка переживает закрытие потока без удержания текста запроса. */
	private readonly terminalsByPrompt = new Map<string, vscode.Terminal>();
	/** Не позволяет начать две параллельные подготовки одного UUID. */
	private readonly starting = new Set<string>();
	/** Поколение отделено от живого терминала: восстановленный после ошибки терминал остаётся только навигацией. */
	private readonly generations = new Map<string, symbol>();
	/** Единственная подписка на закрытие терминалов освобождается вместе с сервисом. */
	private readonly closeSubscription: vscode.Disposable;
	/** Защищает от поздних результатов после деактивации расширения. */
	private disposed = false;

	/** CLI runner и timeout подменяются только в тестах без запуска моделей или рабочей БД. */
	constructor(
		private readonly host: OpenCodeTerminalHost,
		private readonly runner: OpenCodeCliRunner = runOpenCodeCli,
		private readonly findExecutable: () => Promise<string> = findOpenCodeExecutable,
		private readonly timeoutMs = STARTUP_TIMEOUT_MS,
		private readonly log: (message: string) => void = () => undefined,
	) {
		this.closeSubscription = host.onDidCloseTerminal(terminal => {
			for (const [uuid, launch] of this.launches) {
				if (launch.terminal !== terminal) continue;
				this.release(launch);
				this.launches.delete(uuid);
			}
		});
	}

	/** Показывает только терминал выбранного UUID, включая доступный после Reload Window. */
	open(promptUuid: string): boolean {
		const current = this.terminalsByPrompt.get(promptUuid);
		// Закрытый последний запуск не заменяется более старым чатом того же промпта.
		if (current && !this.host.terminals.includes(current)) return false;
		const terminal = current || [...this.host.terminals].reverse()
			.find(candidate => getOpenCodeTerminalPromptUuid(candidate) === promptUuid);
		if (!terminal || this.disposed) return false;
		this.terminalsByPrompt.set(promptUuid, terminal);
		terminal.show();
		return true;
	}

	/** Pastes into the exact live TUI after initial preparation or submission has finished. */
	insertIntoOpenChat(promptUuid: string, text: string): boolean {
		const launch = this.launches.get(promptUuid);
		if (!launch || !this.isCurrentLaunch(launch) || this.starting.has(promptUuid)
			|| !launch.terminal || !this.host.terminals.includes(launch.terminal)) return false;
		// The screen buffer is released after preparation; the live shell execution still owns the PTY.
		if (launch.stage !== 'prepared' && launch.stage !== 'submit') return false;
		const normalized = text.replace(/\r\n?/g, '\n');
		// Лимит относится к шаблону до подстановки. Отступы сохраняются, управляющие байты блокируются.
		if (!normalized.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(normalized)) return false;
		// Separate the first draft from the command and keep standalone slash commands after submission.
		const payload = launch.stage === 'prepared' && !launch.output.submitted ? '\n' + normalized : normalized;
		launch.terminal.show();
		launch.terminal.sendText('\x1b[200~' + payload + '\x1b[201~', false);
		return true;
	}

	/** До первой терминальной записи проверяет контекст; отправку признаёт только по экспорту сессии. */
	async start(request: OpenCodeCliRequest): Promise<OpenCodeCliResult> {
		if (this.disposed || this.starting.has(request.promptUuid)) {
			throw new Error('Подготовка OpenCode CLI для этого промпта уже выполняется или остановлена.');
		}
		this.starting.add(request.promptUuid);
		const generation = Symbol(request.promptUuid);
		this.generations.set(request.promptUuid, generation);
		let launch: OpenCodeLaunch | undefined;
		const previous = this.launches.get(request.promptUuid);
		const previousTerminal = this.terminalsByPrompt.get(request.promptUuid);
		try {
			if (process.platform !== 'linux') throw new Error('OpenCode CLI: эта интеграция поддерживает Linux-хост VS Code.');
			const files = await validateOpenCodeContext(request.query, request.cwd, request.files);
			const executable = await this.findExecutable();
			if (!isSupportedOpenCodeVersion(await this.runner(executable, ['--version'], request.cwd))) {
				throw new Error('OpenCode CLI: требуется совместимая версия 2, начиная с 2.1.4.');
			}
			const sessionId = `ses_pm_${randomUUID().replace(/-/g, '')}`;
			// OpenCode получает уникальный порт только в окружении собственного терминала.
			const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 65_536,
				verifyClient: (info: { req: IncomingMessage }) => !info.req.headers.origin });
			launch = { server, sessionId, generation, executable, request, files, initialized: false, closed: false, stage: 'shell',
				submissionChecked: false, output: new OpenCodeTerminalOutput(sessionId), wake: new Set() };
			const active = launch;
			await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
			server.on('error', () => this.release(active));
			server.on('connection', socket => this.connectEditor(active, socket));
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('OpenCode CLI: IDE-соединение недоступно.');
			const terminal = this.host.createTerminal({ name: request.title, cwd: request.cwd,
				shellPath: '/bin/bash', env: { [TERMINAL_UUID_KEY]: request.promptUuid,
					OPENCODE_EDITOR_SSE_PORT: String(address.port), CLAUDE_CODE_SSE_PORT: null } });
			active.terminal = terminal;
			this.launches.set(request.promptUuid, active);
			this.terminalsByPrompt.set(request.promptUuid, terminal);
			terminal.show(true);
			const integration = await this.waitForShellIntegration(active);
			if (active.closed) throw new Error('Терминал OpenCode CLI закрыт.');
			// exec заменяет shell: после сбоя CLI текст задачи не сможет попасть в Bash.
			active.stage = 'tui';
			this.log(`start session=${sessionId} files=${files.length}`);
			// Размер PTY передаётся только наблюдателю вывода; он нужен для корректного восстановления ANSI-экрана.
			const sizeCommand = 'printf \'\\033]777;prompt-manager-size=%s\\007\' "$(/usr/bin/stty size)"';
			const execution = integration.executeCommand(`${sizeCommand}; ${buildOpenCodeLaunchCommand(executable, sessionId, address.port)}`);
			void this.readOutput(active, execution.read());
			await this.waitFor(active, () => active.initialized && active.output.ready);
			this.log(`ready session=${sessionId}`);
			active.stage = 'files';
			for (const file of files) {
				const revision = active.output.revision;
				await this.sendMention(active, file);
				await this.waitFor(active, () => active.output.revision > revision && active.output.hasMention(file));
				// Отдельная вставка сохраняет перенос: длинный paste OpenCode обрезает по краям перед сворачиванием.
				const lineRevision = active.output.revision;
				terminal.sendText('\x1b[200~\n\x1b[201~', false);
				await this.waitFor(active, () => active.output.revision > lineRevision && active.output.hasBlankInputLine());
			}
			this.log(`files-ready session=${sessionId} files=${files.length}`);
			active.stage = 'paste';
			active.output.beginPaste();
			terminal.sendText(`\x1b[200~${request.query.replace(/\r\n?/g, '\n')}\x1b[201~`, false);
			await this.waitFor(active, () => active.output.hasPromptPaint(request.query));
			active.stage = 'prepared';
			active.output.finishPreparation();
			this.log(`prepared session=${sessionId} files=${files.length}`);
			if (previous) this.release(previous);
			terminal.show();
			if (!request.autoStart) return { dispatched: false,
				message: 'OpenCode CLI открыт. Текст и файлы подготовлены. Проверьте запрос и нажмите Enter для отправки.' };
			if (active.closed) throw new Error('Терминал OpenCode CLI закрыт до отправки.');
			active.stage = 'submit';
			terminal.sendText('\r', false);
			const dispatched = await this.confirmSubmission(active, true);
			active.submissionChecked = true;
			// Подтверждение доставки возвращается сразу; оформление сессии не блокирует события начала запроса.
			if (dispatched) void this.renameSession(active);
			return { dispatched, message: dispatched ? 'Запрос принят новой сессией OpenCode CLI.'
				: 'OpenCode CLI не подтвердил приём полного запроса с файлами. Проверьте терминал; план сохранён.' };
		} catch (error) {
			if (launch) {
				this.log(`failed session=${launch.sessionId} stage=${launch.stage} ide=${launch.initialized} tui=${launch.output.ready} output=${launch.output.revision}`);
				this.release(launch);
			}
			if (previous) this.launches.set(request.promptUuid, previous);
			else this.launches.delete(request.promptUuid);
			// Диагностический терминал остаётся доступным; ошибка подготовки не является просьбой закрыть TUI.
			if (launch?.terminal) this.terminalsByPrompt.set(request.promptUuid, launch.terminal);
			else if (previousTerminal) this.terminalsByPrompt.set(request.promptUuid, previousTerminal);
			else this.terminalsByPrompt.delete(request.promptUuid);
			throw error;
		} finally { this.starting.delete(request.promptUuid); }
	}

	/** Реализует штатное editor initialize и at_mentioned для одного адресного TUI. */
	private connectEditor(launch: OpenCodeLaunch, socket: WebSocket): void {
		if (launch.closed || launch.socket) { socket.close(); return; }
		launch.socket = socket;
		let handshake = false;
		socket.on('error', () => this.release(launch));
		socket.on('close', () => this.release(launch));
		socket.on('message', raw => {
			try {
				const message = JSON.parse(String(raw)) as { method?: string; id?: unknown; params?: { clientInfo?: { name?: string } } };
				if (message.method === 'initialize' && message.params?.clientInfo?.name === 'opencode') {
					handshake = true;
					socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
						protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'Prompt Manager', version: '1' },
					} }));
				} else if (handshake && message.method === 'notifications/initialized') {
					launch.initialized = true;
					this.wake(launch);
				}
			} catch { this.release(launch); }
		});
	}

	/** Отправляет native file mention без поиска по имени и без автодополнения путей с пробелами. */
	private sendMention(launch: OpenCodeLaunch, filePath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			if (launch.closed || launch.socket?.readyState !== WebSocket.OPEN) {
				reject(new Error('OpenCode CLI: IDE-соединение закрыто.')); return;
			}
			launch.socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'at_mentioned',
				// Равные границы дают start=1 без end: OpenCode прикрепляет файл с первой строки до конца.
				params: { filePath, lineStart: 1, lineEnd: 1 } }), error => error ? reject(error) : resolve());
		});
	}

	/** Подписка до повторной проверки защищает от поздней активации shell integration. */
	private async waitForShellIntegration(launch: OpenCodeLaunch): Promise<vscode.TerminalShellIntegration> {
		const subscription = this.host.onDidChangeTerminalShellIntegration(() => this.wake(launch));
		try {
			await this.waitFor(launch, () => Boolean(launch.terminal?.shellIntegration));
			return launch.terminal!.shellIntegration!;
		} finally { subscription.dispose(); }
	}

	/** Stream не сохраняет содержимое терминала и не управляет другими запущенными командами. */
	private async readOutput(launch: OpenCodeLaunch, stream: AsyncIterable<string>): Promise<void> {
		const iterator = stream[Symbol.asyncIterator]();
		const cancelled = new Promise<IteratorResult<string>>(resolve => {
			launch.stopOutput = () => resolve({ done: true, value: undefined });
		});
		try {
			while (!launch.closed && !this.disposed) {
				const packet = await Promise.race([iterator.next(), cancelled]);
				if (packet.done || launch.closed || this.disposed) break;
				await launch.output.append(packet.value);
				if (launch.closed || this.disposed) break;
				this.wake(launch);
				if (!launch.request.autoStart && launch.output.submitted && !launch.submissionChecked && this.isCurrentLaunch(launch)) {
					launch.submissionChecked = true;
					void this.confirmSubmission(launch, false).then(async confirmed => {
						if (confirmed && this.isCurrentLaunch(launch)) {
							// Оба действия стартуют независимо: закрытие во время rename не задерживает уведомление о доставке.
							await Promise.all([
								this.renameSession(launch),
								launch.request.onManualSubmission?.(() => this.isCurrentLaunch(launch)),
							]);
						}
					}).catch(() => { /* Неподтверждённая отправка сохраняет план. */ });
				}
			}
		} catch { /* Закрытие stream отменяет ожидания подготовки. */ }
		launch.stopOutput = undefined;
		void iterator.return?.().catch(() => undefined);
		this.release(launch);
	}

	/** Старое подтверждение не получает права менять задачу после начала следующей попытки. */
	private isCurrentLaunch(launch: OpenCodeLaunch): boolean {
		return !this.disposed && !launch.closed
			&& this.generations.get(launch.request.promptUuid) === launch.generation;
	}

	/** Ограниченное ожидание читает лишь новую известную сессию и не повторяет запрос. */
	private async confirmSubmission(launch: OpenCodeLaunch, strict: boolean): Promise<boolean> {
		for (let attempt = 0; attempt < 5 && !launch.closed && !this.disposed; attempt++) {
			try {
				const json = await this.runner(launch.executable, ['session', 'export', launch.sessionId], launch.request.cwd);
				if (!launch.closed && !this.disposed
					&& hasOpenCodeSubmission(json, launch.sessionId, launch.request.cwd, launch.request.query, launch.files, strict)) {
					return true;
				}
			} catch { /* Сессия может появиться после оптимистичной отрисовки TUI. */ }
			if (attempt < 4) await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, 500); timer.unref?.();
			});
		}
		return false;
	}

	/** Штатный API меняет только title; результат проверяется чтением, не выводом команды обновления. */
	private async renameSession(launch: OpenCodeLaunch): Promise<void> {
		if (!this.isCurrentLaunch(launch)) return;
		try {
			// Пустое title в API означает генерацию моделью, поэтому такой запрос запрещён.
			if (!launch.request.title.trim()) throw new Error('Пустое название сессии.');
			const sessionParam = `sessionID=${launch.sessionId}`;
			await this.runner(launch.executable, ['api', 'session.update', '--param', sessionParam,
				'--data', JSON.stringify({ title: launch.request.title })], launch.request.cwd);
			if (!this.isCurrentLaunch(launch)) return;
			const json = await this.runner(launch.executable, ['api', 'session.get', '--param', sessionParam], launch.request.cwd);
			if (!this.isCurrentLaunch(launch)) return;
			if (!hasOpenCodeSessionTitle(json, launch.sessionId, launch.request.cwd, launch.request.title)) {
				throw new Error('Название сессии не подтверждено.');
			}
			this.log(`renamed session=${launch.sessionId}`);
		} catch {
			if (!this.isCurrentLaunch(launch)) return;
			this.log(`rename-failed session=${launch.sessionId}`);
			// Ошибка уведомления также не должна запускать повторную проверку или отправку принятого запроса.
			try {
				launch.request.onWarning?.('OpenCode CLI: запрос отправлен, но название сессии не удалось подтвердить.');
			} catch { /* Подтверждённая доставка не зависит от отображения предупреждения. */ }
		}
	}

	/** Каждое ожидание удаляет таймер и подписку при успехе, закрытии и таймауте. */
	private waitFor(launch: OpenCodeLaunch, ready: () => boolean): Promise<void> {
		return new Promise((resolve, reject) => {
			const check = () => {
				if (!launch.closed && !this.disposed && !ready()) return;
				clearTimeout(timer); launch.wake.delete(check);
				if (launch.closed || this.disposed) reject(new Error('OpenCode CLI: подготовка прервана закрытием терминала или соединения.'));
				else resolve();
			};
			const timer = setTimeout(() => {
				launch.wake.delete(check);
				reject(new Error(launch.stage === 'shell'
					? 'OpenCode CLI: интеграция оболочки терминала недоступна. Терминал оставлен открытым.'
					: `OpenCode CLI: ожидание этапа ${launch.stage} истекло (IDE: ${launch.initialized ? 'готов' : 'не подключён'}, поле: ${launch.output.ready ? 'готово' : 'не обнаружено'}). Терминал оставлен открытым.`));
			}, this.timeoutMs);
			timer.unref?.();
			launch.wake.add(check); check();
		});
	}

	/** Сигналы содержат только изменение состояния, без копий пользовательского текста. */
	private wake(launch: OpenCodeLaunch): void { for (const check of [...launch.wake]) check(); }

	/** Освобождает собственный IDE-канал, оставляя пользовательский TUI открытым. */
	private release(launch: OpenCodeLaunch): void {
		if (launch.closed) return;
		launch.closed = true;
		launch.stopOutput?.();
		launch.output.dispose();
		launch.socket?.terminate();
		for (const socket of launch.server.clients) socket.terminate();
		launch.server.close();
		this.wake(launch);
	}

	/** Reload/dispose не закрывает работающие терминалы пользователя. */
	dispose(): void {
		this.disposed = true;
		this.closeSubscription.dispose();
		for (const launch of this.launches.values()) this.release(launch);
		this.launches.clear();
		this.terminalsByPrompt.clear();
		this.generations.clear();
	}
}
