import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexRequestFileContent, CODEX_REQUEST_FILE_NAME } from '../src/utils/codexRequestFile.js';

/** Имя файла фиксировано: по нему пользователь узнаёт вложение в панели Codex. */
test('Codex request file has a stable Markdown name', () => {
	assert.equal(CODEX_REQUEST_FILE_NAME, 'task.md');
});

/** Текст задачи попадает в файл без изменений, включая пробелы, переводы строк и символы Unicode. */
test('Codex request file keeps the full request text unchanged after the explanation', () => {
	for (const text of ['', 'Короткий запрос', '  # Заголовок\r\n\r\n**MD** <tag> & + % # 😀\n\n', 'я'.repeat(30000)]) {
		const content = buildCodexRequestFileContent(text, 'ru');
		assert.ok(content.endsWith(`\n\n---\n\n${text}`));
		assert.match(content.split('\n')[0], /полный текст запроса пользователя/);
	}
});

/** Пояснение для модели следует языку интерфейса; неизвестный язык получает английский текст. */
test('Codex request file explanation follows the interface language', () => {
	const russian = buildCodexRequestFileContent('Task', 'ru-RU').split('\n')[0];
	const english = buildCodexRequestFileContent('Task', 'en').split('\n')[0];
	assert.match(russian, /Выполни изложенный ниже запрос/);
	assert.match(english, /Carry out the request below/);
	assert.equal(buildCodexRequestFileContent('Task', 'de').split('\n')[0], english);
});
