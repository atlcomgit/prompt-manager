import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Terminal } from '@xterm/headless';

/** Запускает только найденный CLI без shell; подмена в тестах не обращается к рабочим сессиям. */
export type OpenCodeCliRunner = (executable: string, args: string[], cwd: string) => Promise<string>;

/** Ограничивает чтение экспорта; stdout с текстом задачи никогда не попадает в журнал. */
export const runOpenCodeCli: OpenCodeCliRunner = (executable, args, cwd) => new Promise((resolve, reject) => {
	execFile(executable, args, { cwd, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
		if (error) reject(new Error('OpenCode CLI не выполнил служебную команду.'));
		else resolve(stdout);
	});
});

/** Ищет штатную установку на хосте расширения, не полагаясь на PATH браузера. */
export async function findOpenCodeExecutable(): Promise<string> {
	const directories = [...(process.env.PATH || '').split(path.delimiter),
		path.join(homedir(), '.opencode', 'bin'), path.join(homedir(), '.local', 'bin')];
	for (const directory of new Set(directories.filter(path.isAbsolute))) {
		const executable = path.join(directory, 'opencode');
		try {
			await access(executable, constants.X_OK);
			if ((await stat(executable)).isFile()) return executable;
		} catch { /* Проверяем следующий каталог установки. */ }
	}
	throw new Error('OpenCode CLI не найден на хосте VS Code. Установите opencode и проверьте PATH.');
}

/** Согласованная версия IDE-протокола; поведение проверяет tests/openCodeCli.test.ts. */
export function isSupportedOpenCodeVersion(output: string): boolean {
	const version = /\bopencode\s+v?(\d+)\.(\d+)\.(\d+)\b/i.exec(output.trim());
	return Boolean(version && Number(version[1]) === 2
		&& (Number(version[2]) > 1 || Number(version[2]) === 1 && Number(version[3]) >= 4));
}

/** Экранирует аргумент Bash; в команду запуска никогда не подставляется текст задачи. */
export function quoteOpenCodeShellArgument(value: string): string {
	if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('OpenCode CLI: недопустимый аргумент запуска.');
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Коллекции расширений применяются после env терминала; фиксируем IDE-канал только у самого CLI. */
export function buildOpenCodeLaunchCommand(executable: string, sessionId: string, editorPort: number): string {
	if (!Number.isInteger(editorPort) || editorPort < 1 || editorPort > 65_535) {
		throw new Error('OpenCode CLI: недопустимый порт IDE.');
	}
	return `exec /usr/bin/env -u CLAUDE_CODE_SSE_PORT OPENCODE_EDITOR_SSE_PORT=${editorPort} `
		+ `${quoteOpenCodeShellArgument(executable)} --session ${quoteOpenCodeShellArgument(sessionId)}`;
}

/** Проверяет данные до открытия терминала; ESC мог бы завершить защищённую вставку. */
export async function validateOpenCodeContext(query: string, cwd: string, files: readonly string[]): Promise<string[]> {
	if (!query.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(query)) {
		throw new Error('OpenCode CLI: пустой текст или управляющие символы терминала в промпте.');
	}
	if (!path.isAbsolute(cwd) || /[\x00-\x1f\x7f]/.test(cwd) || !(await stat(cwd)).isDirectory()) {
		throw new Error('OpenCode CLI: рабочий каталог недоступен.');
	}
	const unique = [...new Set(files)];
	for (const file of unique) {
		if (!path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) {
			throw new Error('OpenCode CLI: контекст должен содержать абсолютные пути к файлам.');
		}
		try {
			await access(file, constants.R_OK);
			if (!(await stat(file)).isFile()) throw new Error('not a file');
		} catch { throw new Error(`OpenCode CLI: файл контекста недоступен: ${file}`); }
	}
	return unique;
}

/** Сужает внешние JSON-значения без небезопасного предположения о форме экспорта. */
function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}

/** Проверяет точную сессию, каталог, тело и настоящие вложения; tests/openCodeCli.test.ts. */
export function hasOpenCodeSubmission(
	json: string, sessionId: string, cwd: string, query: string, files: readonly string[], strictText: boolean,
): boolean {
	try {
		const exported = object(JSON.parse(json));
		const info = object(exported.info);
		if (info.id !== sessionId || object(info.location).directory !== cwd || !Array.isArray(exported.messages)) return false;
		const message = exported.messages.map(object).find(candidate => candidate.type === 'user');
		if (!message || typeof message.text !== 'string' || !message.text.trim()) return false;
		if (strictText && !message.text.endsWith(query.replace(/\r\n?/g, '\n'))) return false;
		const attached = new Set((Array.isArray(message.files) ? message.files : []).flatMap(value => {
			const source = object(object(value).source);
			if (source.type !== 'uri' || typeof source.uri !== 'string') return [];
			try { return [fileURLToPath(source.uri)]; } catch { return []; }
		}));
		return files.every(file => attached.has(file));
	} catch { return false; }
}

/** Ответ session.get подтверждает название именно назначенной сессии и каталога; tests/openCodeCli.test.ts. */
export function hasOpenCodeSessionTitle(json: string, sessionId: string, cwd: string, title: string): boolean {
	try {
		const info = object(object(JSON.parse(json)).data);
		return info.id === sessionId && object(info.location).directory === cwd && info.title === title;
	} catch { return false; }
}

/** Наблюдает ограниченный фрагмент TUI, а не сохраняет журнал пользовательского терминала. */
export class OpenCodeTerminalOutput {
	/** Экран восстанавливает ANSI-перерисовку; scrollback не накапливает пользовательскую историю. */
	private readonly screen = new Terminal({ cols: 120, rows: 40, scrollback: 0,
		allowProposedApi: true, disableStdin: true, logLevel: 'off' });
	/** Снимок вычисляется один раз для последнего обработанного пакета. */
	private screenText: string | undefined;
	/** Освобождение не оставляет ожидание незавершённого write. */
	private finishWrite?: () => void;
	/** После закрытия вывод больше не удерживается и не применяется. */
	private disposed = false;
	/** После подготовки нужен только OSC отправки, восстановление дальнейшего ответа модели не требуется. */
	private painting = true;
	/** Поле нового чата отрисовано и принимает защищённую вставку. */
	ready = false;
	/** Любой пакет вывода учитывается, даже если терминал не поддерживает synchronized output. */
	revision = 0;
	/** Адресный OSC служит поводом прочитать экспорт, а не доказательством отправки. */
	submitted = false;
	/** Хвост нужен для последовательностей ANSI/OSC, разбитых на несколько пакетов. */
	private raw = '';
	/** Снимок до paste исключает прежний текст экрана из подтверждения новой вставки. */
	private beforePaste: string | undefined;
	/** Identity назначается до первой отправки и не выбирается по активному терминалу. */
	constructor(private readonly sessionId: string) {}

	/** Готовность требует поля нового чата независимо от необязательных режимов терминала. */
	async append(chunk: string): Promise<void> {
		if (this.disposed) return;
		this.raw = (this.raw + chunk).slice(-131_072);
		// Размер передаётся оболочкой до exec, иначе эмулятор неверно переносит строки широкого терминала.
		if (this.painting) {
			const size = /\x1b\]777;prompt-manager-size=(\d+)\s+(\d+)\x07/.exec(this.raw);
			if (size) {
				const rows = Number(size[1]), columns = Number(size[2]);
				if (rows > 0 && columns > 0 && rows * columns <= 1_048_576
					&& (rows !== this.screen.rows || columns !== this.screen.cols)) this.screen.resize(columns, rows);
			}
			await new Promise<void>(resolve => { this.finishWrite = resolve; this.screen.write(chunk, resolve); });
			this.finishWrite = undefined;
		}
		if (this.disposed) return;
		this.revision++;
		this.screenText = undefined;
		// Paste/cursor/synchronized-output режимы зависят от frontend терминала и не подтверждают готовность поля.
		if (!this.ready && this.visibleText().includes('Askanything')) {
			this.ready = true;
		}
		// OSC — сигнал для чтения экспорта, но сам по себе не подтверждение приёма запроса.
		for (const match of this.raw.matchAll(/\x1b\]7501;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
			const fields = new Map(match[1].split(':').map(field => field.split('=', 2) as [string, string]));
			if (fields.get('id') === this.sessionId && fields.get('app') === 'opencode'
				&& fields.get('state') === 'working') this.submitted = true;
		}
	}

	/** Отрисовка native mention отличает добавление файла от строки пути в общем тексте. */
	hasMention(file: string): boolean {
		return this.visibleText().includes(this.normalizeVisibleText(path.basename(file)));
	}

	/** Перенос принят, когда курсор расположен на пустой строке внутри поля, а не после имени файла. */
	hasBlankInputLine(): boolean {
		if (this.disposed || !this.painting) return false;
		const buffer = this.screen.buffer.active;
		const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) || '';
		return this.normalizeVisibleText(line) === '';
	}

	/** Начинает наблюдение именно за новой вставкой, не за текущим экраном или анимацией. */
	beginPaste(): void { this.beforePaste = this.visibleText(); }

	/** Полная вставка прокручивается к концу; подтверждаем также видимое окончание последней строки. */
	hasPromptPaint(query: string): boolean {
		if (this.beforePaste === undefined) return false;
		const text = this.visibleText();
		const trimmed = query.replace(/\r\n?/g, '\n').trim();
		const lines = trimmed.split('\n');
		const compact = `[Pasted ~${lines.length} lines]`;
		return [compact, lines[0].slice(0, 24), lines[lines.length - 1].slice(-64)]
			.map(value => this.normalizeVisibleText(value))
			.some(value => Boolean(value) && text.includes(value) && !this.beforePaste!.includes(value));
	}

	/** Рамка и перенос строки не являются частью имени файла или плейсхолдера OpenCode. */
	private normalizeVisibleText(value: string): string { return value.replace(/[\s┃│]/gu, ''); }

	/** Читает текущие ячейки после перемещения курсора, частичной перезаписи и очистки строк. */
	private visibleText(): string {
		if (this.disposed || !this.painting) return '';
		if (this.screenText !== undefined) return this.screenText;
		const buffer = this.screen.buffer.active;
		const rows: string[] = [];
		for (let row = 0; row < buffer.length; row++) rows.push(buffer.getLine(row)?.translateToString(true) || '');
		return this.screenText = this.normalizeVisibleText(rows.join(''));
	}

	/** Освобождает экран сразу после подготовки, сохраняя наблюдение за адресным сигналом отправки. */
	finishPreparation(): void {
		if (!this.painting) return;
		this.painting = false;
		this.finishWrite?.();
		this.screen.dispose();
		this.screenText = undefined;
		this.beforePaste = undefined;
	}

	/** Удаляет экран и ограниченный хвост, завершая возможную обработку пакета. */
	dispose(): void {
		this.disposed = true;
		this.finishPreparation();
		this.raw = '';
	}
}
