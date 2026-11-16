import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
	buildOpenCodeLaunchCommand, hasOpenCodeSubmission, isSupportedOpenCodeVersion, OpenCodeTerminalOutput,
	quoteOpenCodeShellArgument, validateOpenCodeContext,
} from '../src/utils/openCodeCli.js';

/** Проверяет версию протокола без запуска установленного CLI или обращения к БД. */
test('OpenCode accepts supported v2 versions and refuses v1, future majors and malformed output', () => {
	for (const value of ['opencode v2.1.4', 'opencode 2.2.0', 'opencode v2.1.10\n']) assert.equal(isSupportedOpenCodeVersion(value), true);
	for (const value of ['2.1.4', 'opencode v1.9.0', 'opencode v2.1.3', 'opencode v2.0.9', 'opencode v3.0.0']) {
		assert.equal(isSupportedOpenCodeVersion(value), false);
	}
});

/** Реальная оболочка получает аргумент буквально; никаких пользовательских команд тест не выполняет. */
test('OpenCode Bash quoting preserves spaces, quotes, substitutions and new-session arguments', () => {
	const value = "file ' \" `literal` $(literal) ; & привет";
	const command = `printf '%s' ${quoteOpenCodeShellArgument(value)}`;
	assert.equal(execFileSync('/bin/bash', ['-c', command], { encoding: 'utf8' }), value);
	for (const value of ['\0', '\n', '\r', '\x1b[201~', '\t']) assert.throws(() => quoteOpenCodeShellArgument(value));
});

/** Команда исправляет окружение после коллекций VS Code только для дочернего процесса CLI. */
test('OpenCode launch overrides conflicting Claude IDE environment at process execution', async () => {
	await mkdir('/tmp/codex', { recursive: true });
	const directory = await mkdtemp('/tmp/codex/task171-environment-');
	try {
		const executable = join(directory, "opencode ' $(literal)");
		await writeFile(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify({claude: process.env.CLAUDE_CODE_SSE_PORT, port: process.env.OPENCODE_EDITOR_SSE_PORT, args: process.argv.slice(2)}));\n', { mode: 0o700 });
		const sessionId = "ses_pm_'$(literal)`code`";
		const environment = { ...process.env, CLAUDE_CODE_SSE_PORT: '51114', OPENCODE_EDITOR_SSE_PORT: '51115' };
		const command = buildOpenCodeLaunchCommand(executable, sessionId, 51116);
		const result = JSON.parse(execFileSync('/bin/bash', ['-c', command], { env: environment, encoding: 'utf8' }));
		assert.deepEqual(result, { port: '51116', args: ['--session', sessionId] });
		assert.equal(environment.CLAUDE_CODE_SSE_PORT, '51114');
		for (const port of [0, -1, 65536, 1.5, NaN]) assert.throws(() => buildOpenCodeLaunchCommand(executable, sessionId, port));
	} finally { await rm(directory, { recursive: true, force: true }); }
});

/** Изолированные файлы проверяют доступность контекста и запрет терминальных escape-последовательностей. */
test('OpenCode validates files, deduplicates paths and rejects control injection before opening a terminal', async () => {
	await mkdir('/tmp/codex', { recursive: true });
	const directory = await mkdtemp('/tmp/codex/task171-context-');
	try {
		const file = join(directory, "русский '$ файл.md");
		await writeFile(file, 'Контекст\n');
		assert.deepEqual(await validateOpenCodeContext('Текст\n\tMarkdown', directory, [file, file]), [file]);
		for (const query of ['', ' \n', 'bad\x1b[201~', 'bad\0']) await assert.rejects(validateOpenCodeContext(query, directory, [file]));
		await assert.rejects(validateOpenCodeContext('text', directory, ['relative.md']));
		await assert.rejects(validateOpenCodeContext('text', directory, [directory]));
		await assert.rejects(validateOpenCodeContext('text', directory, [join(directory, 'missing.md')]));
	} finally { await rm(directory, { recursive: true, force: true }); }
});

/** Экспорт доказывает приём полного текста и реальных файлов только адресной сессией. */
test('OpenCode confirmation rejects another session, wrong directory, truncated text and missing native files', () => {
	const file = '/testing/context space.md';
	const data = { info: { id: 'ses_pm_test', location: { directory: '/testing' } }, messages: [{
		type: 'user', text: '@context space.md#1 \nТочный\nзапрос',
		files: [{ source: { type: 'uri', uri: `${pathToFileURL(file).href}?start=1` }, data: 'content' }],
	}] };
	const check = (value: unknown, strict = true) => hasOpenCodeSubmission(JSON.stringify(value), 'ses_pm_test', '/testing', 'Точный\nзапрос', [file], strict);
	assert.equal(check(data), true);
	assert.equal(check({ ...data, info: { ...data.info, id: 'ses_other' } }), false);
	assert.equal(check({ ...data, info: { ...data.info, location: { directory: '/other' } } }), false);
	assert.equal(check({ ...data, messages: [{ ...data.messages[0], files: [] }] }), false);
	const edited = { ...data, messages: [{ ...data.messages[0], text: 'Отредактировано вручную' }] };
	assert.equal(check(edited), false);
	assert.equal(check(edited, false), true);
	for (const value of ['not json', 'null', '[]', '{}']) {
		assert.equal(hasOpenCodeSubmission(value, 'ses_pm_test', '/testing', 'Точный\nзапрос', [file], true), false);
	}
});

/** Готовность требует TUI; OSC другой сессии и частичные пакеты не подменяют подтверждение экспорта. */
test('OpenCode terminal output waits for the editable home screen and tracks only the allocated session', async () => {
	const output = new OpenCodeTerminalOutput('ses_pm_test');
	await output.append('\x1b[?2004hstarting');
	assert.equal(output.ready, false);
	await output.append('\x1b[?25hAsk any');
	assert.equal(output.ready, false);
	await output.append('thing…\x1b[?2026l');
	assert.equal(output.ready, true);
	await output.append('\x1b]7501;state=working:id=ses_other:app=opencode\x1b\\');
	assert.equal(output.submitted, false);
	await output.append('\x1b]7501;state=working:id=ses_pm_');
	await output.append('test:app=opencode\x1b\\');
	assert.equal(output.submitted, true);
	output.dispose();
});

/** Обычный вывод и анимация не подтверждают вставку; новый текст или native-плейсхолдер подтверждают. */
test('OpenCode detects readiness and actual pasted text without synchronized output modes', async () => {
	const output = new OpenCodeTerminalOutput('ses_pm_test');
	await output.append('Ask anything…');
	assert.equal(output.ready, true);
	const query = 'Проверка\nвставки\nзапроса';
	output.beginPaste();
	assert.equal(output.hasPromptPaint(query), false);
	await output.append('\x1b[2Kspinner');
	assert.equal(output.hasPromptPaint(query), false);
	await output.append('[Pasted ~');
	assert.equal(output.hasPromptPaint(query), false);
	await output.append('3 lines]');
	assert.equal(output.hasPromptPaint(query), true);
	output.beginPaste();
	assert.equal(output.hasPromptPaint('Короткий запрос'), false);
	await output.append('Короткий запрос');
	assert.equal(output.hasPromptPaint('Короткий запрос'), true);
	output.dispose();
});

/** Рендерер меняет лишь различающиеся ячейки; basename второго файла отсутствует в сыром потоке. */
test('OpenCode reconstructs partial file repaint, clears stale text and recognizes wrapped paste', async () => {
	const output = new OpenCodeTerminalOutput('ses_pm_test');
	try {
		await output.append('\x1b]777;prompt-manager-size=109 353\x07\x1b[2J\x1b[57;143H@prompt-manager.instructions.md#1');
		assert.equal(output.hasMention('/testing/project.instructions.md'), false);
		const previous = '@prompt-manager.instructions.md#1';
		const next = '@project.instructions.md#1';
		let repaint = '\x1b[56;143H' + previous;
		for (let index = 0; index < previous.length; index++) {
			if (previous[index] !== (next[index] || ' ')) repaint += `\x1b[57;${143 + index}H${next[index] || ' '}`;
		}
		assert.ok(!repaint.includes('project.instructions.md'));
		// Часть CSI тоже может прийти в отдельном пакете.
		await output.append(repaint.slice(0, 4));
		await output.append(repaint.slice(4));
		assert.equal(output.hasMention('/testing/project.instructions.md'), true);
		output.beginPaste();
		await output.append('\x1b[57;205H[Pasted \x1b[58;140H┃\x1b[58;143H~3 lines]');
		assert.equal(output.hasPromptPaint('первая\nвторая\nтретья'), true);
		await output.append('\x1b[2J');
		assert.equal(output.hasMention('/testing/project.instructions.md'), false);
		assert.equal(output.hasPromptPaint('первая\nвторая\nтретья'), false);
	} finally { output.dispose(); }
});

/** Закрытие во время разбора не оставляет очередь write и не применяет поздний вывод. */
test('OpenCode output disposal cancels a pending screen write', async () => {
	const output = new OpenCodeTerminalOutput('ses_pm_test');
	const writing = output.append('Ask anything');
	output.dispose();
	await writing;
	await output.append('late');
	assert.equal(output.ready, false);
});

/** Ручная отправка продолжает отслеживаться после освобождения экрана черновика. */
test('OpenCode keeps submission signals after releasing the prepared screen', async () => {
	const output = new OpenCodeTerminalOutput('ses_pm_test');
	try {
		await output.append('Ask anything');
		output.finishPreparation();
		await output.append('\x1b]7501;state=working:id=ses_pm_test:app=opencode\x07');
		assert.equal(output.ready, true);
		assert.equal(output.submitted, true);
		assert.equal(output.hasMention('/testing/anything'), false);
	} finally { output.dispose(); }
});

/** Кадр анимации не заменяет пустую строку ввода после отдельной вставки перевода строки. */
test('OpenCode detects a blank input line only after the file row is left', async () => {
	const output = new OpenCodeTerminalOutput('ses_pm_test');
	try {
		await output.append('\x1b[10;1H┃ @project.instructions.md#1 ');
		assert.equal(output.hasBlankInputLine(), false);
		await output.append('\x1b[1;1Hspinner\x1b[10;30H');
		assert.equal(output.hasBlankInputLine(), false);
		await output.append('\x1b[11;1H┃   \x1b[11;3H');
		assert.equal(output.hasBlankInputLine(), true);
		output.finishPreparation();
		assert.equal(output.hasBlankInputLine(), false);
	} finally { output.dispose(); }
});

/** Полная длинная вставка прокручивает начало за пределы поля; видимым остаётся окончание. */
test('OpenCode confirms full paste when only the last lines remain visible', async () => {
	const output = new OpenCodeTerminalOutput('ses_pm_test');
	try {
		await output.append('\x1b[2J\x1b[10;1HAsk anything');
		output.beginPaste();
		const query = '# Задача 171\n' + 'Строка в середине\n'.repeat(60) + 'Последняя строка полного промпта';
		await output.append('\x1b[2J\x1b[10;1HСтрока в середине');
		assert.equal(output.hasPromptPaint(query), false);
		await output.append('\x1b[11;1HПоследняя строка полного промпта');
		assert.equal(output.hasPromptPaint(query), true);
	} finally { output.dispose(); }
});
