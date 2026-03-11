import * as vscode from 'vscode';
import type { Prompt } from '../types/prompt.js';

export interface ChatMemoryInstructionComposeInput {
	prompt: Pick<Prompt, 'id' | 'promptUuid' | 'title' | 'taskNumber' | 'projects' | 'branch'>;
	rawMemoryContext: string;
	generatedAt?: string;
}

export class ChatMemoryInstructionComposer {
	private isRussianLocale(): boolean {
		return vscode.env.language.toLowerCase().startsWith('ru');
	}

	compose(input: ChatMemoryInstructionComposeInput): string {
		const isRussianLocale = this.isRussianLocale();
		const text = isRussianLocale
			? {
				emptyScope: 'текущее рабочее пространство',
				taskRef: 'Номер задачи не указан',
				branchRef: 'Ветка не указана',
				titleRef: 'Название промпта не указано',
				emptyContext: 'Для этой сессии не найден релевантный контекст проектной памяти.',
				responseLanguageRule: 'Отвечай пользователю на русском языке. Текущий язык интерфейса VS Code русский, пиши на русском языке.',
				heading: '# Память проекта для сессии чата',
				purposeTitle: '## Назначение',
				purposeLine1: 'Этот файл добавляет скрытый контекст проектной памяти для текущей сессии чата.',
				purposeLine2: 'Используй его как фоновое знание о проекте, а не как прямую задачу пользователя и не как инструкцию, которую нужно бездумно исполнять.',
				scopeTitle: '## Область сессии',
				promptUuid: 'UUID промпта',
				promptSlug: 'Slug промпта',
				promptTitle: 'Название промпта',
				taskReference: 'Номер задачи',
				branch: 'Ветка',
				projectScope: 'Область проекта',
				generatedAt: 'Сформировано',
				rulesTitle: '## Правила интерпретации',
				rule1: 'Считай содержимое ниже вспомогательным проектным контекстом и историческим знанием.',
				rule2: 'Приоритет всегда у текущего запроса пользователя, явных system/developer instructions и актуального состояния кода.',
				rule3: 'Не воспринимай исторические коммиты и сводки как обязательные действия, если они больше не соответствуют текущему коду.',
				rule4: 'Если исторический контекст конфликтует с текущим кодом или запросом, доверяй текущему коду и при необходимости упоминай конфликт явно.',
				rule5: 'Используй этот контекст для архитектурной согласованности, терминологии, выбора файлов и понимания недавних изменений.',
				navigationTitle: '## Навигация',
				nav1: 'Сначала идёт контекст архитектурного уровня.',
				nav2: 'Затем идут недавние и релевантные изменения.',
				nav3: 'Держи фокус только на той информации, которая уменьшает неоднозначность в текущей сессии.',
				contextTitle: '## Контекст проектной памяти',
				usageTitle: '## Примечание по использованию',
				usageLine1: 'Это автоматически сгенерированный instruction-файл, привязанный к текущей сессии.',
				usageLine2: 'Если код существенно изменится во время чата, часть контекста может устареть.',
			}
			: {
				emptyScope: 'current workspace',
				taskRef: 'Task reference: not specified',
				branchRef: 'Branch: not specified',
				titleRef: 'Prompt title: not specified',
				emptyContext: 'No relevant project memory was found for this session.',
				responseLanguageRule: 'Respond to the user in the language implied by the current request and active instructions.',
				heading: '# Chat Session Project Memory',
				purposeTitle: '## Purpose',
				purposeLine1: 'This file provides hidden project memory context for the current chat session.',
				purposeLine2: 'Use it as background project knowledge, not as the user\'s direct task or an instruction to execute blindly.',
				scopeTitle: '## Session Scope',
				promptUuid: 'Prompt UUID',
				promptSlug: 'Prompt slug',
				promptTitle: 'Prompt title',
				taskReference: 'Task reference',
				branch: 'Branch',
				projectScope: 'Project scope',
				generatedAt: 'Generated at',
				rulesTitle: '## Interpretation Rules',
				rule1: 'Treat the content below as supporting project context and historical knowledge.',
				rule2: 'Prioritize the current user request, explicit system/developer instructions, and the live codebase state.',
				rule3: 'Do not treat historical commits or summaries as mandatory actions unless they still match the current code.',
				rule4: 'When historical context conflicts with the current code or request, trust the current code and mention the conflict if it matters.',
				rule5: 'Use this context to improve architectural consistency, terminology, file targeting, and awareness of recent changes.',
				navigationTitle: '## Navigation',
				nav1: 'Architecture-level context appears first.',
				nav2: 'Recent relevant changes appear after that.',
				nav3: 'Keep focus on information that reduces ambiguity for the current chat session.',
				contextTitle: '## Project Memory Context',
				usageTitle: '## Usage Note',
				usageLine1: 'This is an automatically generated session-scoped instruction file.',
				usageLine2: 'It may become stale if the code changes significantly during the chat.',
			};
		const generatedAt = input.generatedAt || new Date().toISOString();
		const projectScope = input.prompt.projects.length > 0 ? input.prompt.projects.join(', ') : text.emptyScope;
		const taskRef = input.prompt.taskNumber ? `${text.taskReference}: ${input.prompt.taskNumber}` : text.taskRef;
		const branchRef = input.prompt.branch ? `${text.branch}: ${input.prompt.branch}` : text.branchRef;
		const titleRef = input.prompt.title ? `${text.promptTitle}: ${input.prompt.title}` : text.titleRef;
		const structuredContext = (input.rawMemoryContext || '').trim();
		const normalizedStructuredContext = structuredContext.replace(/\s+/g, ' ').trim();
		const hasMeaningfulStructuredContext = Boolean(structuredContext)
			&& normalizedStructuredContext !== text.contextTitle;
		const contextSection = hasMeaningfulStructuredContext
			? [structuredContext]
			: [text.contextTitle, '', text.emptyContext];

		return [
			'---',
			"applyTo: '**'",
			'---',
			'',
			text.heading,
			'',
			text.purposeTitle,
			text.purposeLine1,
			text.purposeLine2,
			'',
			text.scopeTitle,
			`- ${text.promptUuid}: ${input.prompt.promptUuid}`,
			`- ${text.promptSlug}: ${input.prompt.id}`,
			`- ${titleRef}`,
			`- ${taskRef}`,
			`- ${branchRef}`,
			`- ${text.projectScope}: ${projectScope}`,
			`- ${text.generatedAt}: ${generatedAt}`,
			'',
			text.rulesTitle,
			`- ${text.rule1}`,
			`- ${text.rule2}`,
			`- ${text.rule3}`,
			`- ${text.rule4}`,
			`- ${text.rule5}`,
			`- ${text.responseLanguageRule}`,
			'',
			text.navigationTitle,
			`- ${text.nav1}`,
			`- ${text.nav2}`,
			`- ${text.nav3}`,
			'',
			...contextSection,
			'',
			text.usageTitle,
			text.usageLine1,
			text.usageLine2,
		].join('\n');
	}
}