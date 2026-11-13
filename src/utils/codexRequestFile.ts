import { translate } from '../i18n/translations.js';

/**
 * Имя файла запроса в папке промпта. Файл заменяется при каждом запуске из браузерного клиента
 * и остаётся на диске, потому что Codex читает его по пути уже после отправки сообщения.
 */
export const CODEX_REQUEST_FILE_NAME = 'task.md';

/**
 * Формирует содержимое файла запроса для чата Codex: пояснение для модели и полный текст задачи.
 * Текст задачи не изменяется: сообщение с прикреплённым файлом не содержит собственного текста,
 * поэтому назначение файла объясняет первая строка. Тесты: tests/codexRequestFile.test.ts.
 */
export function buildCodexRequestFileContent(text: string, locale: string): string {
	return `${translate(locale, 'chatMessage.codexRequestFileIntro')}\n\n---\n\n${text}`;
}
