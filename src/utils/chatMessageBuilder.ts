/**
 * Утилита формирования структурированного Markdown-сообщения
 * для отправки в чат VS Code при нажатии "Начать чат".
 */

import { translate } from '../i18n/translations';
import type { Prompt } from '../types/prompt';

/** Метаданные контекста для формирования сообщения чата */
export interface ChatMessageContext {
	/** Абсолютный путь к папке промпта */
	promptDirectory: string;
	/** Абсолютный путь к файлу prompt.md */
	promptFilePath: string;
	/** Абсолютный путь к папке chat-memory */
	chatMemoryDirectory: string;
	/** Ссылки на контекстные файлы промпта (формат #file:/path) */
	promptContextReferences: string[];
	/** Ссылки на instruction-файлы (формат #file:/path) */
	instructionReferences: string[];
}

/**
 * Формирует структурированное Markdown-сообщение для отправки в чат VS Code.
 * Все заголовки секций локализуются через translate(locale, key).
 */
export function buildChatMessage(
	prompt: Prompt,
	context: ChatMessageContext,
	locale: string,
): string {
	/** Хелпер перевода */
	const t = (key: string): string => translate(locale, key);

	const lines: string[] = [];

	// --- Главный заголовок ---
	lines.push(buildTitle(prompt, t));
	lines.push('');

	// --- Режим работы ---
	lines.push(`## ${t('chatMessage.workMode')}`);
	lines.push('');
	const modeKey = prompt.chatMode === 'plan'
		? 'chatMessage.workModePlan'
		: 'chatMessage.workModeAgent';
	lines.push(t(modeKey));
	lines.push('');

	// --- Проекты ---
	if (prompt.projects.length > 0) {
		lines.push(`## ${t('chatMessage.projects')}`);
		lines.push('');
		for (const project of prompt.projects) {
			lines.push(`- ${project}`);
		}
		lines.push('');
	}

	// --- Описание задачи (content) ---
	lines.push(buildContentSection(prompt.content, t));
	lines.push('');

	// --- Разделитель ---
	lines.push('---');
	lines.push('');

	// --- Контекст ---
	const contextSections = buildContextSections(prompt, context, t);
	if (contextSections.length > 0) {
		lines.push(`## ${t('chatMessage.context')}`);
		lines.push('');
		lines.push(contextSections);
	}

	// --- Инструкции ---
	if (context.instructionReferences.length > 0) {
		lines.push(`## ${t('chatMessage.instructions')}`);
		lines.push('');
		lines.push(t('chatMessage.instructionsNote'));
		for (const ref of context.instructionReferences) {
			lines.push(`- ${ref}`);
		}
		lines.push('');
	}

	return lines.join('\n').trimEnd();
}

/**
 * Формирует главный заголовок сообщения.
 * Всегда начинается с "# Задача".
 * Если есть taskNumber — "# Задача № N", иначе — "# Задача".
 * Title выводится отдельной строкой ниже заголовка.
 */
function buildTitle(prompt: Prompt, t: (key: string) => string): string {
	const titleText = (prompt.title || '').trim();
	const taskNum = (prompt.taskNumber || '').trim();

	/* Формируем заголовок первого уровня */
	const heading = taskNum
		? `# ${t('chatMessage.task')} № ${taskNum}`
		: `# ${t('chatMessage.task')}`;

	/* Title — отдельная строка под заголовком */
	if (titleText) {
		return `${heading}\n\n${titleText}`;
	}
	return heading;
}

/**
 * Формирует секцию содержимого промпта.
 * Если content начинается с markdown-заголовка (#) — вставляется как есть.
 * Иначе — оборачивается в секцию "## Описание задачи".
 */
function buildContentSection(
	content: string,
	t: (key: string) => string,
): string {
	const trimmed = (content || '').trim();
	if (!trimmed) {
		return '';
	}

	/* Если content уже начинается с markdown-заголовка — вставляем как есть */
	if (trimmed.startsWith('#')) {
		return trimmed;
	}

	return `## ${t('chatMessage.taskDescription')}\n\n${trimmed}`;
}

/**
 * Формирует подсекции контекста (###).
 * Пустые подсекции пропускаются.
 */
function buildContextSections(
	prompt: Prompt,
	context: ChatMessageContext,
	t: (key: string) => string,
): string {
	const sections: string[] = [];

	// ### Метаданные промпта
	const metadata: string[] = [];
	if (prompt.id) {
		metadata.push(`- **Prompt ID**: ${prompt.id}`);
	}
	if (prompt.title) {
		metadata.push(`- **Prompt title**: ${prompt.title}`);
	}
	if (context.promptDirectory) {
		metadata.push(`- **Prompt directory**: ${context.promptDirectory}`);
	}
	if (context.promptFilePath) {
		metadata.push(`- **Prompt file**: ${context.promptFilePath}`);
	}
	if (context.promptDirectory) {
		metadata.push(`- **Report file**: ${context.promptDirectory}/report.txt`);
		metadata.push(`- **Plan file**: ${context.promptDirectory}/plan.md`);
	}
	if (metadata.length > 0) {
		sections.push(`### ${t('chatMessage.promptMetadata')}\n${metadata.join('\n')}`);
	}

	// ### Технологии
	const tech: string[] = [];
	if (prompt.languages.length > 0) {
		tech.push(`- **Languages**: ${prompt.languages.join(', ')}`);
	}
	if (prompt.frameworks.length > 0) {
		tech.push(`- **Frameworks**: ${prompt.frameworks.join(', ')}`);
	}
	if (tech.length > 0) {
		sections.push(`### ${t('chatMessage.technologies')}\n${tech.join('\n')}`);
	}

	// ### Инструменты
	const tools: string[] = [];
	if (prompt.skills.length > 0) {
		tools.push(`- **Skills**: ${prompt.skills.join(', ')}`);
	}
	if (prompt.mcpTools.length > 0) {
		tools.push(`- **MCP Tools**: ${prompt.mcpTools.join(', ')}`);
	}
	if (prompt.hooks.length > 0) {
		tools.push(`- **Hooks**: ${prompt.hooks.join(', ')}`);
	}
	if (prompt.model) {
		tools.push(`- **Preferred model**: ${prompt.model}`);
	}
	if (tools.length > 0) {
		sections.push(`### ${t('chatMessage.tools')}\n${tools.join('\n')}`);
	}

	// ### Задача и Git
	const taskGit: string[] = [];
	if (prompt.taskNumber) {
		taskGit.push(`- **Task**: ${prompt.taskNumber}`);
	}
	if (prompt.branch) {
		taskGit.push(`- **Branch**: ${prompt.branch}`);
	}
	if (taskGit.length > 0) {
		sections.push(`### ${t('chatMessage.taskAndGit')}\n${taskGit.join('\n')}`);
	}

	// ### Файлы контекста
	const files: string[] = [];
	if (context.promptContextReferences.length > 0) {
		files.push(`- **Context files**: ${context.promptContextReferences.join(' ')}`);
	}
	if (context.chatMemoryDirectory) {
		files.push(`- **Chat memory directory**: ${context.chatMemoryDirectory}`);
	}
	if (files.length > 0) {
		sections.push(`### ${t('chatMessage.contextFiles')}\n${files.join('\n')}`);
	}

	return sections.join('\n\n');
}
