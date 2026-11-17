import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import type * as vscode from 'vscode';
import { OpenCodeCliService, type OpenCodeCliRequest, type OpenCodeTerminalHost } from '../src/services/openCodeCliService.js';
import type { OpenCodeCliRunner } from '../src/utils/openCodeCli.js';

/** Очередь моделирует только поток терминала: сеть editor bridge остаётся настоящей loopback WebSocket. */
function streamQueue() {
	const queue: string[] = [];
	let wake: (() => void) | undefined;
	let closed = false;
	return {
		push(text: string) { queue.push(text); wake?.(); },
		close() { closed = true; wake?.(); },
		async *read() {
			while (!closed) {
				if (queue.length) yield queue.shift()!;
				else await new Promise<void>(resolve => { wake = resolve; });
			}
		},
	};
}

/** Объекты VS Code подменены, subprocess/БД/модель не запускаются; проверяется полный порядок передачи. */
function fixture(options: { version?: string; mismatch?: boolean; shell?: boolean; noModes?: boolean;
	paint?: boolean; incremental?: boolean; onPaste?: (query: string) => void;
	renameError?: boolean; ignoreRename?: boolean; onRename?: () => Promise<void> } = {}) {
	const terminals: vscode.Terminal[] = [];
	const sessions: Array<{ id: string; text: string; files: string[]; enters: number; shows: number; disposals: number;
		draft: string; newlines: number; title: string; renames: number; options: vscode.TerminalOptions; close(): void }> = [];
	const apiCalls: string[][] = [];
	const logs: string[] = [];
	const closedListeners = new Set<(terminal: vscode.Terminal) => unknown>();
	const host = {
		terminals,
		onDidChangeTerminalShellIntegration: () => ({ dispose() {} }),
		onDidCloseTerminal: (listener: (terminal: vscode.Terminal) => unknown) => {
			closedListeners.add(listener); return { dispose: () => { closedListeners.delete(listener); } };
		},
		createTerminal(creationOptions: vscode.TerminalOptions) {
			const stream = streamQueue();
			let socket: WebSocket | undefined;
			let painted = false;
			const frameEnd = options.noModes ? '' : '\x1b[?2026l';
			const state = { id: '', text: '', draft: '', newlines: 0, title: 'Automatic title', renames: 0, files: [] as string[],
				enters: 0, shows: 0, disposals: 0, options: creationOptions,
				close() {
					stream.close(); socket?.terminate();
					const index = terminals.indexOf(terminal);
					if (index >= 0) terminals.splice(index, 1);
					for (const listener of closedListeners) listener(terminal);
				} };
			const shellIntegration = options.shell === false ? undefined : {
				executeCommand(command: string) {
					state.id = /--session '([^']+)'/.exec(command)![1];
					assert.ok(command.includes('prompt-manager-size=%s'));
					assert.match(command, /; exec \/usr\/bin\/env -u CLAUDE_CODE_SSE_PORT OPENCODE_EDITOR_SSE_PORT=\d+ '\/testing\/opencode'/);
					assert.doesNotMatch(command, /--prompt|--auto|run /);
					// TUI использует порт команды после запуска, а не загрязнённое окружение оболочки.
					const port = /OPENCODE_EDITOR_SSE_PORT=(\d+)/.exec(command)![1];
					assert.equal(port, creationOptions.env?.OPENCODE_EDITOR_SSE_PORT);
					socket = new WebSocket(`ws://127.0.0.1:${port}`);
					socket.on('open', () => socket!.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'opencode' } } })));
					socket.on('error', () => stream.close());
					socket.on('close', () => stream.close());
					socket.on('message', raw => {
						const message = JSON.parse(String(raw)) as { id?: number; method?: string;
							params?: { filePath: string; lineStart: number; lineEnd: number } };
						if (message.id === 1) {
							socket!.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
							stream.push(options.noModes ? 'Ask anything…' : '\x1b[?2004hAsk anything…\x1b[?25h' + frameEnd);
						} else if (message.method === 'at_mentioned') {
							const previous = state.files.at(-1);
							assert.equal(message.params!.lineStart, 1);
							assert.equal(message.params!.lineEnd, 1);
							if (previous) assert.ok(state.draft.endsWith('\n'), 'Next file must wait for the preceding newline');
							state.files.push(message.params!.filePath);
							const next = `@${basename(message.params!.filePath)}#1`;
							state.draft += next + ' ';
							if (options.incremental && previous) {
								const old = `@${basename(previous)}#1`;
								let repaint = '\x1b[9;1H' + old;
								for (let index = 0; index < Math.max(old.length, next.length); index++) {
									if (old[index] !== next[index]) repaint += `\x1b[10;${index + 1}H${next[index] || ' '}`;
								}
								stream.push(repaint);
							} else stream.push(`\x1b[10;1H${next}${frameEnd}`);
						}
					});
					return { read: () => stream.read() };
				},
			};
			const terminal = { creationOptions, shellIntegration,
				show() { state.shows++; }, dispose: () => { state.disposals++; state.close(); },
				sendText(text: string, addNewLine: boolean) {
					assert.equal(addNewLine, false);
					if (text === '\r') {
						assert.equal(painted, true, 'Enter must wait for paste processing, not any output frame');
						state.enters++;
						stream.push(`\x1b]7501;state=working:id=${state.id}:app=opencode\x1b\\`);
					} else {
						assert.ok(text.startsWith('\x1b[200~') && text.endsWith('\x1b[201~'));
						const content = text.slice(6, -6);
						if (content === '\n') {
							// Посторонний кадр не означает завершения асинхронной вставки переноса.
							stream.push('spinner' + frameEnd);
							setImmediate(() => {
								state.draft += '\n'; state.newlines++;
								stream.push('\x1b[11;1H\x1b[2K┃  \x1b[11;3H');
							});
							return;
						}
						if (state.files.length) assert.ok(state.draft.endsWith('\n'), 'Prompt must begin on a new line');
						state.text = content;
						state.draft += content;
						options.onPaste?.(content);
						stream.push('spinner' + frameEnd);
						// Асинхронная обработка paste может продолжаться после очередного кадра анимации.
						if (options.paint !== false) setImmediate(() => {
							painted = true;
							const lines = state.text.trim().split('\n');
							stream.push(options.incremental
								? `\x1b[12;30H[Pasted \x1b[13;1H┃\x1b[13;3H~${lines.length} lines]`
								: (lines.length >= 3 || state.text.length > 150
									? `[Pasted ~${lines.length} lines]` : state.text) + frameEnd);
						});
					}
				},
			} as unknown as vscode.Terminal;
			sessions.push(state); terminals.push(terminal); return terminal;
		},
	} as unknown as OpenCodeTerminalHost;
	const runner: OpenCodeCliRunner = async (_executable, args, cwd) => {
		if (args[0] === '--version') return options.version || 'opencode v2.1.4';
		if (args[0] === 'api') {
			apiCalls.push(args);
			const id = args[args.indexOf('--param') + 1].slice('sessionID='.length);
			const session = sessions.find(candidate => candidate.id === id);
			assert.ok(session && session.enters > 0, 'Rename must use the submitted exact session');
			if (args[1] === 'session.update') {
				await options.onRename?.();
				if (options.renameError) throw new Error('Rename unavailable');
				const body = JSON.parse(args[args.indexOf('--data') + 1]) as { title: string };
				assert.deepEqual(Object.keys(body), ['title']);
				session.renames++;
				if (!options.ignoreRename) session.title = body.title;
				return '';
			}
			assert.equal(args[1], 'session.get');
			return JSON.stringify({ data: { id, title: session.title, location: { directory: cwd } } });
		}
		const session = sessions.find(candidate => candidate.id === args[2]);
		return JSON.stringify({ info: { id: options.mismatch ? 'ses_other' : session?.id, location: { directory: cwd } },
			messages: session?.enters ? [{ type: 'user', text: session.text,
				files: session.files.map(file => ({ source: { type: 'uri', uri: pathToFileURL(file).href } })) }] : [] });
	};
	const service = new OpenCodeCliService(host, runner, async () => '/testing/opencode', 500, message => logs.push(message));
	return { service, sessions, host, logs, apiCalls };
}

/** Изолированный контекст живёт только в собственном временном каталоге. */
async function withContext(callback: (request: OpenCodeCliRequest) => Promise<void>) {
	await mkdir('/tmp/codex', { recursive: true });
	const cwd = await mkdtemp('/tmp/codex/task171-service-');
	const file = join(cwd, "контекст с '$ символами.md");
	await writeFile(file, 'контекст');
	try { await callback({ promptUuid: 'prompt-171', title: '171', cwd, query: 'Точный\nзапрос $(literal) `code`', files: [file], autoStart: false }); }
	finally { await rm(cwd, { recursive: true, force: true }); }
}

/** Черновик не выполняет запрос: файлы добавлены через IDE, Enter и экспорт не нужны. */
test('OpenCode service prepares native files and editable draft without sending', async () => withContext(async request => {
	const { service, sessions, apiCalls } = fixture();
	try {
		const result = await service.start({ ...request, files: [...request.files, ...request.files] });
		assert.equal(result.dispatched, false);
		assert.equal(sessions[0].text, request.query);
		assert.deepEqual(sessions[0].files, request.files);
		assert.equal(sessions[0].enters, 0);
		assert.equal(sessions[0].newlines, request.files.length);
		assert.equal(sessions[0].options.env?.CLAUDE_CODE_SSE_PORT, null);
		assert.equal(service.open(request.promptUuid), true);
		assert.equal(service.open('unrelated-prompt'), false);
		assert.equal(sessions[0].options.name, request.title);
		assert.deepEqual(apiCalls, []);
	} finally { service.dispose(); }
}));

/** Название не попадает в shell; обновление метаданных относится только к подтверждённому session ID. */
test('OpenCode applies the same exact title to terminal and submitted session', async () => withContext(async request => {
	const { service, sessions, apiCalls } = fixture();
	const title = '172 | Проверка "Kilo" $(literal) `code`';
	try {
		assert.equal((await service.start({ ...request, title, autoStart: true })).dispatched, true);
		// Подмена API завершается в микрозадачах, уже после независимого результата доставки.
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(sessions[0].options.name, title);
		assert.equal(sessions[0].title, title);
		assert.equal(sessions[0].renames, 1);
		assert.equal(sessions[0].enters, 1);
		assert.deepEqual(apiCalls.map(args => args[1]), ['session.update', 'session.get']);
		assert.ok(apiCalls.every(args => args.includes(`sessionID=${sessions[0].id}`)));
	} finally { service.dispose(); }
}));

/** Ошибка API или несовпадение прочитанного названия не отменяет приём запроса и не повторяет Enter. */
test('OpenCode warns on an unconfirmed title without retrying the accepted request', async () => withContext(async request => {
	for (const options of [{ renameError: true }, { ignoreRename: true }]) {
		const { service, sessions } = fixture(options);
		const warnings: string[] = [];
		try {
			const result = await service.start({ ...request, title: '172 | Проверка', autoStart: true,
				onWarning: message => warnings.push(message) });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(result.dispatched, true);
			assert.equal(sessions[0].enters, 1);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0], /запрос отправлен.*название/);
		} finally { service.dispose(); }
	}
}));

/** Пустая строка title означала бы генерацию названия моделью; служебный rename её не вызывает. */
test('OpenCode never requests model-generated titles for an empty label', async () => withContext(async request => {
	const { service, apiCalls } = fixture();
	const warnings: string[] = [];
	try {
		assert.equal((await service.start({ ...request, title: '', autoStart: true,
			onWarning: message => warnings.push(message) })).dispatched, true);
		assert.deepEqual(apiCalls, []);
		assert.equal(warnings.length, 1);
	} finally { service.dispose(); }
}));

/** Закрытие терминала во время медленного rename не теряет уже проверенную ручную отправку. */
test('OpenCode confirms manual delivery before a pending rename and terminal close', async () => withContext(async request => {
	let entered!: () => void, resume!: () => void;
	const renaming = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { resume = resolve; });
	const { service, sessions, host } = fixture({ onRename: async () => { entered(); await gate; } });
	let confirmations = 0;
	try {
		await service.start({ ...request, onManualSubmission: async () => { confirmations++; } });
		host.terminals[0].sendText('\r', false);
		await renaming;
		assert.equal(confirmations, 1);
		sessions[0].close();
		resume();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(confirmations, 1);
		assert.equal(sessions[0].enters, 1);
	} finally { resume(); service.dispose(); }
}));

/** Автостарт также возвращает приём запроса до завершения независимого оформления сессии. */
test('OpenCode returns automatic delivery while the rename is still pending', async () => withContext(async request => {
	let entered!: () => void, resume!: () => void;
	const renaming = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { resume = resolve; });
	const { service, sessions } = fixture({ onRename: async () => { entered(); await gate; } });
	let dispatched = false;
	let starting: Promise<void> | undefined;
	try {
		starting = service.start({ ...request, autoStart: true }).then(result => { dispatched = result.dispatched; });
		await renaming;
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(dispatched, true);
		sessions[0].close();
		resume();
		await starting;
		assert.equal(sessions[0].enters, 1);
	} finally { resume(); await starting; service.dispose(); }
}));

/** Frontend может не отдавать paste/cursor/synchronized-маркеры; асинхронная вставка всё равно завершается. */
test('OpenCode service prepares files and waits for actual paste without terminal mode markers', async () => withContext(async request => {
	const { service, sessions } = fixture({ noModes: true });
	try {
		const query = 'Первая строка\nВторая строка\nТретья строка';
		assert.equal((await service.start({ ...request, query, autoStart: true })).dispatched, true);
		assert.equal(sessions[0].text, query);
		assert.deepEqual(sessions[0].files, request.files);
		assert.equal(sessions[0].enters, 1);
	} finally { service.dispose(); }
}));

/** Второй похожий файл и перенесённая вставка видимы после частичной перерисовки TUI. */
test('OpenCode service pastes after two instruction files with incremental rendering', async () => withContext(async request => {
	const { service, sessions, logs } = fixture({ incremental: true });
	try {
		const files = ['prompt-manager.instructions.md', 'project.instructions.md'].map(name => join(request.cwd, name));
		for (const file of files) await writeFile(file, 'Изолированный контекст');
		const query = 'Текст задачи\nпосле файлов\nполностью';
		const result = await service.start({ ...request, files, query });
		assert.equal(result.dispatched, false);
		assert.equal(sessions[0].text, query);
		assert.deepEqual(sessions[0].files, files);
		assert.equal(sessions[0].enters, 0);
		assert.equal(sessions[0].newlines, 2);
		assert.equal(sessions[0].draft, files.map(file => `@${basename(file)}#1 \n`).join('') + query);
		assert.ok(logs.some(message => message.startsWith('files-ready ')));
	} finally { service.dispose(); }
}));

/** Без файлов сервис не добавляет пустой префикс к исходному тексту. */
test('OpenCode service preserves a prompt without files and inserts no extra newline', async () => withContext(async request => {
	const { service, sessions } = fixture();
	try {
		await service.start({ ...request, files: [] });
		assert.equal(sessions[0].draft, request.query);
		assert.equal(sessions[0].newlines, 0);
		assert.equal(sessions[0].enters, 0);
	} finally { service.dispose(); }
}));

/** Отказ подготовки сохраняет диагностический терминал и не отправляет неполный запрос. */
test('OpenCode service leaves the terminal open on paste timeout and reports the failed stage', async () => withContext(async request => {
	const { service, sessions, host, logs } = fixture({ paint: false });
	try {
		await assert.rejects(service.start({ ...request, autoStart: true }), /этапа paste.*Терминал оставлен открытым/);
		assert.equal(sessions[0].disposals, 0);
		assert.equal(host.terminals.length, 1);
		assert.equal(service.open(request.promptUuid), true);
		assert.equal(sessions[0].enters, 0);
		assert.ok(logs.some(message => /failed .*stage=paste ide=true tui=true/.test(message)));
		assert.ok(logs.every(message => !message.includes(request.query) && !message.includes(request.files[0])));
	} finally { service.dispose(); }
}));

/** Автозапуск отправляет один Enter и принимает только экспорт соответствующего нового запроса. */
test('OpenCode service submits once and keeps simultaneous prompts in separate terminals and sockets', async () => withContext(async request => {
	const { service, sessions } = fixture();
	try {
		const results = await Promise.all([
			service.start({ ...request, autoStart: true }),
			service.start({ ...request, promptUuid: 'second-prompt', query: 'Второй запрос', autoStart: true }),
		]);
		assert.ok(results.every(result => result.dispatched));
		assert.equal(sessions.length, 2);
		assert.notEqual(sessions[0].id, sessions[1].id);
		assert.notEqual(sessions[0].options.env?.OPENCODE_EDITOR_SSE_PORT, sessions[1].options.env?.OPENCODE_EDITOR_SSE_PORT);
		assert.deepEqual(sessions.map(session => session.enters), [1, 1]);
		assert.deepEqual(new Set(sessions.map(session => session.text)), new Set([request.query, 'Второй запрос']));
	} finally { service.dispose(); }
}));

/** Повтор до завершения первой попытки не создаёт второй терминал и не теряет первую попытку. */
test('OpenCode service rejects overlapping starts for the same prompt', async () => withContext(async request => {
	const { service, sessions } = fixture();
	try {
		const first = service.start(request);
		await assert.rejects(service.start(request), /уже выполняется/);
		await first;
		assert.equal(sessions.length, 1);
	} finally { service.dispose(); }
}));

/** Длинный русский текст передаётся целиком; закрытие последнего запуска не открывает предыдущий. */
test('OpenCode service preserves long Unicode drafts and opens only the latest launch', async () => withContext(async request => {
	const { service, sessions } = fixture();
	try {
		await service.start(request);
		const query = 'Русский текст 🧪 `code` $(literal)\n'.repeat(2000);
		await service.start({ ...request, query });
		assert.equal(sessions[1].text, query);
		const previousShows = sessions[0].shows;
		assert.equal(service.open(request.promptUuid), true);
		assert.equal(sessions[0].shows, previousShows);
		sessions[1].close();
		assert.equal(service.open(request.promptUuid), false);
		assert.equal(sessions[0].shows, previousShows);
	} finally { service.dispose(); }
}));

/** Ручная отправка обнаруживается один раз по точной сессии и не запускается сервисом. */
test('OpenCode service confirms a manual send once and releases the editor bridge without closing terminals', async () => withContext(async request => {
	const { service, host, sessions } = fixture();
	let submissions = 0;
	let confirmed!: () => void;
	const confirmation = new Promise<void>(resolve => { confirmed = resolve; });
	try {
		await service.start({ ...request, onManualSubmission: async () => { submissions++; confirmed(); } });
		host.terminals[0].sendText('\r', false);
		await confirmation;
		assert.equal(submissions, 1);
		assert.equal(sessions[0].enters, 1);
		assert.equal(sessions[0].title, request.title);
		assert.equal(sessions[0].renames, 1);
		service.dispose();
		assert.equal(service.open(request.promptUuid), false);
		assert.equal(sessions[0].enters, 1);
	} finally { service.dispose(); }
}));

/** Старая сессия не подтверждает новую задачу даже во время подготовки и после отказа следующей попытки. */
test('OpenCode ignores an old manual send while a newer launch is pending or failed', async () => withContext(async request => {
	let reachedNewPaste!: () => void;
	const newPaste = new Promise<void>(resolve => { reachedNewPaste = resolve; });
	const options = { paint: true, onPaste: (query: string) => { if (query === 'New prompt B') reachedNewPaste(); } };
	const { service, host } = fixture(options);
	let confirmations = 0;
	try {
		await service.start({ ...request, onManualSubmission: async () => { confirmations++; } });
		options.paint = false;
		const second = service.start({ ...request, query: 'New prompt B' });
		const rejected = assert.rejects(second, /этапа paste/);
		await newPaste;
		host.terminals[0].sendText('\r', false);
		await rejected;
		assert.equal(confirmations, 0);
		host.terminals[0].sendText('\r', false);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(confirmations, 0);
	} finally { service.dispose(); }
}));

/** Поколение меняется до проверок CLI и не восстанавливается вместе со старой навигационной привязкой. */
test('OpenCode invalidates a delivered callback guard even if the next launch fails before creating a terminal', async () => withContext(async request => {
	const options = { version: 'opencode v2.1.4' };
	const { service, host } = fixture(options);
	let received!: (guard: () => boolean) => void;
	const delivered = new Promise<() => boolean>(resolve => { received = resolve; });
	try {
		await service.start({ ...request, onManualSubmission: async guard => { received(guard); } });
		host.terminals[0].sendText('\r', false);
		const guard = await delivered;
		assert.equal(guard(), true);
		options.version = 'opencode v1.0.0';
		const second = service.start(request);
		assert.equal(guard(), false);
		await assert.rejects(second, /2.1.4/);
		assert.equal(guard(), false);
		assert.equal(service.open(request.promptUuid), true);
	} finally { service.dispose(); }
}));

/** Чужой экспорт не подтверждает доставку и не приводит к повторному Enter. */
test('OpenCode service keeps an unconfirmed send distinct from delivery and never retries Enter', async () => withContext(async request => {
	const { service, sessions } = fixture({ mismatch: true });
	try {
		const result = await service.start({ ...request, autoStart: true });
		assert.equal(result.dispatched, false);
		assert.equal(sessions[0].enters, 1);
		assert.match(result.message, /план сохранён/);
	} finally { service.dispose(); }
}));

/** Старый CLI отвергается до создания терминала, отсутствие shell integration заканчивается ограниченной ошибкой. */
test('OpenCode service rejects incompatible versions and unavailable shell integration', async () => withContext(async request => {
	for (const options of [{ version: 'opencode v1.0.0' }, { shell: false }]) {
		const { service, sessions } = fixture(options);
		try {
			await assert.rejects(service.start(request), options.version ? /2.1.4/ : /интеграция оболочки/);
			assert.equal(sessions.length, options.version ? 0 : 1);
			if (sessions.length) assert.equal(sessions[0].disposals, 0);
		} finally { service.dispose(); }
	}
}));
