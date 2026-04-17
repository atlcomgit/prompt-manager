/**
 * Тесты для утилиты chatMessageBuilder — формирование Markdown-сообщения чата.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatMessage } from '../src/utils/chatMessageBuilder.js';
import type { ChatMessageContext } from '../src/utils/chatMessageBuilder.js';
import type { Prompt } from '../src/types/prompt.js';
import { createDefaultPrompt } from '../src/types/prompt.js';

/** Создаёт минимальный контекст для тестов */
function makeContext(overrides?: Partial<ChatMessageContext>): ChatMessageContext {
	return {
		promptDirectory: '/workspace/.vscode/prompt-manager/test-prompt',
		promptFilePath: '/workspace/.vscode/prompt-manager/test-prompt/prompt.md',
		chatMemoryDirectory: '/workspace/.vscode/prompt-manager/chat-memory',
		promptContextReferences: [],
		instructionReferences: [],
		...overrides,
	};
}

/** Создаёт промпт с нужными полями */
function makePrompt(overrides?: Partial<Prompt>): Prompt {
	return {
		...createDefaultPrompt(),
		id: 'test-prompt',
		title: 'Test prompt',
		content: 'Do something useful',
		...overrides,
	};
}

// ---- Тест: полный набор полей ----
test('buildChatMessage produces correct markdown with all fields populated', () => {
	const prompt = makePrompt({
		id: '71-template',
		title: 'Шаблон Markdown',
		taskNumber: '71',
		content: 'Реализуй шаблон',
		chatMode: 'agent',
		projects: ['prompt-manager'],
		languages: ['TypeScript'],
		frameworks: ['VS Code'],
		skills: ['grep-timeout'],
		mcpTools: ['mcp-server-1'],
		hooks: ['agent-finish-telegram'],
		model: 'copilot/claude-opus-4.6',
		branch: 'feature/chat-template',
	});
	const ctx = makeContext({
		promptContextReferences: ['#file:/workspace/README.md'],
		instructionReferences: ['#file:/workspace/.vscode/pm/chat-memory/pm.instructions.md'],
	});

	const result = buildChatMessage(prompt, ctx, 'ru');

	/* Заголовок */
	assert.ok(result.includes('# Задача № 71'), 'должен содержать заголовок с номером задачи');
	assert.ok(result.includes('\nШаблон Markdown\n'), 'title должен быть отдельной строкой под заголовком');

	/* Режим работы */
	assert.ok(result.includes('## Режим работы'), 'должна быть секция режима работы');
	assert.ok(result.includes('**Agent**'), 'должен указывать Agent');

	/* Проекты */
	assert.ok(result.includes('## Проекты'), 'должна быть секция проектов');
	assert.ok(result.includes('- prompt-manager'), 'должен перечислять проекты');

	/* Описание задачи (content plain text → обёрнут) */
	assert.ok(result.includes('## Описание задачи'), 'должна быть секция описания задачи');
	assert.ok(result.includes('Реализуй шаблон'), 'должен содержать текст промпта');

	/* Контекст */
	assert.ok(result.includes('## Контекст'), 'должна быть секция контекста');
	assert.ok(result.includes('### Метаданные промпта'), 'должна быть подсекция метаданных');
	assert.ok(result.includes('### Технологии'), 'должна быть подсекция технологий');
	assert.ok(result.includes('### Инструменты'), 'должна быть подсекция инструментов');
	assert.ok(result.includes('### Задача и Git'), 'должна быть подсекция задачи и git');
	assert.ok(result.includes('### Файлы контекста'), 'должна быть подсекция файлов контекста');

	/* Инструкции */
	assert.ok(result.includes('## Инструкции'), 'должна быть секция инструкций');
	assert.ok(
		result.includes('При реализации задачи учитывай инструкции из приложенных файлов:'),
		'должна быть пояснительная фраза',
	);
	assert.ok(result.includes('- #file:/workspace/.vscode/pm/chat-memory/pm.instructions.md'), 'должен перечислять файлы инструкций');
});

// ---- Тест: заголовок с taskNumber и без ----
test('buildChatMessage title with and without taskNumber', () => {
	const withTask = buildChatMessage(
		makePrompt({ title: 'My task', taskNumber: '42' }),
		makeContext(),
		'en',
	);
	assert.ok(withTask.startsWith('# Task № 42'), 'с taskNumber должен быть "Task № 42"');
	assert.ok(withTask.includes('\nMy task\n'), 'title отдельной строкой');

	const withoutTask = buildChatMessage(
		makePrompt({ title: 'My task', taskNumber: '' }),
		makeContext(),
		'en',
	);
	assert.ok(withoutTask.startsWith('# Task\n'), 'без taskNumber — "# Task"');
	assert.ok(withoutTask.includes('\nMy task\n'), 'title отдельной строкой');

	const taskOnly = buildChatMessage(
		makePrompt({ title: '', taskNumber: '99' }),
		makeContext(),
		'en',
	);
	assert.ok(taskOnly.startsWith('# Task № 99'), 'только taskNumber без title');
});

// ---- Тест: режим Agent vs Plan ----
test('buildChatMessage renders Agent and Plan mode sections correctly', () => {
	const agentResult = buildChatMessage(
		makePrompt({ chatMode: 'agent' }),
		makeContext(),
		'en',
	);
	assert.ok(agentResult.includes('## Work mode'), 'должна быть секция Work mode');
	assert.ok(agentResult.includes('**Agent**'), 'должен содержать Agent');
	assert.ok(
		agentResult.includes('Proceed with implementation immediately'),
		'должна быть директива Agent',
	);

	const planResult = buildChatMessage(
		makePrompt({ chatMode: 'plan' }),
		makeContext(),
		'en',
	);
	assert.ok(planResult.includes('**Plan**'), 'должен содержать Plan');
	assert.ok(
		planResult.includes('Create a detailed implementation plan first'),
		'должна быть директива Plan',
	);
});

// ---- Тест: auto-detect markdown в content ----
test('buildChatMessage auto-detects markdown in content and skips wrapper', () => {
	const markdownContent = '# My custom heading\n\nSome detailed text';
	const result = buildChatMessage(
		makePrompt({ content: markdownContent }),
		makeContext(),
		'en',
	);
	/* Если content начинается с # — не оборачиваем в "## Task description" */
	assert.ok(!result.includes('## Task description'), 'не должна быть обёртка при markdown');
	assert.ok(result.includes('# My custom heading'), 'content должен быть вставлен как есть');
	assert.ok(result.includes('Some detailed text'), 'содержимое не должно быть потеряно');
});

test('buildChatMessage wraps plain text content in Task description section', () => {
	const plainContent = 'Implement feature X with condition Y';
	const result = buildChatMessage(
		makePrompt({ content: plainContent }),
		makeContext(),
		'en',
	);
	assert.ok(result.includes('## Task description'), 'plain text должен быть обёрнут');
	assert.ok(result.includes(plainContent), 'содержимое должно быть включено');
});

// ---- Тест: пустые поля пропускаются ----
test('buildChatMessage skips empty sections when data is missing', () => {
	const result = buildChatMessage(
		makePrompt({
			projects: [],
			languages: [],
			frameworks: [],
			skills: [],
			mcpTools: [],
			hooks: [],
			model: '',
			taskNumber: '',
			branch: '',
		}),
		makeContext({
			promptContextReferences: [],
			instructionReferences: [],
			chatMemoryDirectory: '',
		}),
		'en',
	);

	/* Пустые подсекции не должны отображаться */
	assert.ok(!result.includes('## Projects'), 'пустые проекты не отображаются');
	assert.ok(!result.includes('### Technologies'), 'пустые технологии не отображаются');
	assert.ok(!result.includes('### Tools'), 'пустые инструменты не отображаются');
	assert.ok(!result.includes('### Task and Git'), 'пустая задача/git не отображается');
	assert.ok(!result.includes('### Context files'), 'пустые файлы контекста не отображаются');
	assert.ok(!result.includes('## Instructions'), 'пустые инструкции не отображаются');
});

// ---- Тест: отсутствие лишних секций при пустых данных ----
test('buildChatMessage with minimal prompt produces valid markdown', () => {
	const result = buildChatMessage(
		makePrompt({
			id: '',
			title: '',
			taskNumber: '',
			content: '',
			projects: [],
			languages: [],
			frameworks: [],
			skills: [],
			mcpTools: [],
			hooks: [],
			model: '',
			branch: '',
		}),
		makeContext({
			promptDirectory: '',
			promptFilePath: '',
			chatMemoryDirectory: '',
			promptContextReferences: [],
			instructionReferences: [],
		}),
		'en',
	);

	/* Должен содержать режим работы (всегда) */
	assert.ok(result.includes('## Work mode'), 'режим работы есть всегда');
	/* Не должен содержать пустых секций */
	assert.ok(!result.includes('## Projects'), 'нет секции проектов');
	assert.ok(!result.includes('## Context'), 'нет секции контекста при пустых данных');
});

// ---- Тест: локализация en vs ru ----
test('buildChatMessage localizes section headings for ru locale', () => {
	const result = buildChatMessage(
		makePrompt({
			taskNumber: '10',
			title: 'Test',
			projects: ['api'],
			languages: ['PHP'],
		}),
		makeContext(),
		'ru',
	);

	assert.ok(result.includes('# Задача № 10'), 'ru: заголовок "Задача № 10"');
	assert.ok(result.includes('## Режим работы'), 'ru: секция "Режим работы"');
	assert.ok(result.includes('## Проекты'), 'ru: секция "Проекты"');
	assert.ok(result.includes('## Контекст'), 'ru: секция "Контекст"');
	assert.ok(result.includes('### Технологии'), 'ru: подсекция "Технологии"');
	assert.ok(result.includes('### Метаданные промпта'), 'ru: подсекция "Метаданные промпта"');
});

test('buildChatMessage localizes section headings for en locale', () => {
	const result = buildChatMessage(
		makePrompt({
			taskNumber: '10',
			title: 'Test',
			projects: ['api'],
			languages: ['PHP'],
		}),
		makeContext(),
		'en',
	);

	assert.ok(result.includes('# Task № 10'), 'en: заголовок "Task № 10"');
	assert.ok(result.includes('## Work mode'), 'en: секция "Work mode"');
	assert.ok(result.includes('## Projects'), 'en: секция "Projects"');
	assert.ok(result.includes('## Context'), 'en: секция "Context"');
	assert.ok(result.includes('### Technologies'), 'en: подсекция "Technologies"');
	assert.ok(result.includes('### Prompt metadata'), 'en: подсекция "Prompt metadata"');
});

// ---- Тест: секция Инструкции ----
test('buildChatMessage renders Instructions section with attached files', () => {
	const refs = [
		'#file:/workspace/pm/instructions1.md',
		'#file:/workspace/pm/instructions2.md',
	];
	const result = buildChatMessage(
		makePrompt(),
		makeContext({ instructionReferences: refs }),
		'ru',
	);

	assert.ok(result.includes('## Инструкции'), 'должна быть секция инструкций');
	assert.ok(
		result.includes('При реализации задачи учитывай инструкции из приложенных файлов:'),
		'должна быть пояснительная фраза',
	);
	assert.ok(result.includes('- #file:/workspace/pm/instructions1.md'), 'первый файл в списке');
	assert.ok(result.includes('- #file:/workspace/pm/instructions2.md'), 'второй файл в списке');
});

test('buildChatMessage hides Instructions section when no instruction files', () => {
	const result = buildChatMessage(
		makePrompt(),
		makeContext({ instructionReferences: [] }),
		'ru',
	);
	assert.ok(!result.includes('## Инструкции'), 'секция инструкций не должна появляться');
});
