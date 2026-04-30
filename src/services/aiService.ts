/**
 * AI Service — generates titles, descriptions and slugs using VS Code Language Model API
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DEFAULT_COPILOT_MODEL_FAMILY, isZeroCostCopilotModelPickerCategory, normalizeCopilotModelFamily, normalizeOptionalCopilotModelFamily } from '../constants/ai.js';
import { getPromptManagerOutputChannel } from '../utils/promptManagerOutput.js';
import { appendPromptAiLog } from '../utils/promptAiLogger.js';
import { buildDescriptionGenerationUserPrompt, buildPromptFieldLanguageRule, buildTitleGenerationUserPrompt } from '../utils/aiPromptBuilders.js';
import { normalizeCommitMessageGenerationInstructions } from '../utils/gitOverlay.js';
import { readSqliteItemValue } from '../utils/sqliteItemTable.js';
import type { PromptDashboardProjectSummary } from '../types/promptDashboard.js';

const execFileAsync = promisify(execFile);

type AvailableModelOption = { id: string; name: string };

type ChatModelsControlEntry = {
	id?: string;
	label?: string;
	featured?: boolean;
};

type ChatModelsControl = {
	free?: Record<string, ChatModelsControlEntry>;
	paid?: Record<string, ChatModelsControlEntry>;
};

type CachedLanguageModelEntry = {
	identifier?: string;
	metadata?: {
		id?: string;
		name?: string;
		vendor?: string;
		family?: string;
		isUserSelectable?: boolean;
		targetChatSessionType?: string;
		capabilities?: {
			agentMode?: boolean;
		};
		modelPickerCategory?: {
			label?: string;
			order?: number;
		};
	};
};

export type ChatModelApplyStatus =
	| 'applied'
	| 'model-not-found'
	| 'command-not-found'
	| 'command-failed';

export type ChatModelApplyResult = {
	status: ChatModelApplyStatus;
	applied: boolean;
	requestedModel: string;
	resolvedModelId?: string;
	resolvedModelFamily?: string;
	usedCommand?: string;
	usedArg?: unknown;
};

export type CodeMapAreaDescriptionInput = {
	repository: string;
	branchName: string;
	area: string;
	locale: string;
	mode: 'short' | 'medium' | 'long';
	maxChars: number;
	manifestDescription?: string;
	representativeFiles: string[];
	symbols: string[];
	snippets: Array<{ filePath: string; snippet: string }>;
};

export type CodeMapAreaBatchDescriptionInput = {
	repository: string;
	branchName: string;
	locale: string;
	mode: 'short' | 'medium' | 'long';
	maxChars: number;
	manifestDescription?: string;
	areas: Array<CodeMapAreaDescriptionInput & { id: string }>;
};

export type CodeMapSymbolDescriptionBatchItem = {
	id: string;
	filePath: string;
	fileRole: string;
	kind: string;
	name: string;
	signature: string;
	excerpt: string;
	fallbackDescription?: string;
};

export type CodeMapFileDescriptionBatchItem = {
	id: string;
	filePath: string;
	fileRole: string;
	lineCount: number;
	imports: string[];
	frontendContract: string[];
	frontendBlockNames: string[];
	excerpt: string;
	fallbackDescription?: string;
	symbols: CodeMapSymbolDescriptionBatchItem[];
};

export type CodeMapSymbolBatchDescriptionInput = {
	repository: string;
	branchName: string;
	locale: string;
	mode: 'short' | 'medium' | 'long';
	maxChars: number;
	files: CodeMapFileDescriptionBatchItem[];
};

export type CodeMapFrontendBlockDescriptionBatchItem = {
	id: string;
	filePath: string;
	fileRole: string;
	framework: 'vue' | 'html' | 'blade';
	blockKind: string;
	blockName: string;
	purpose: string;
	stateDeps: string[];
	eventHandlers: string[];
	dataSources: string[];
	childComponents: string[];
	conditions: string[];
	routes: string[];
	forms: string[];
	excerpt: string;
	linkedScriptSnippets: string[];
	fallbackDescription?: string;
};

export type CodeMapFrontendBlockBatchDescriptionInput = {
	repository: string;
	branchName: string;
	locale: string;
	mode: 'short' | 'medium' | 'long';
	maxChars: number;
	blocks: CodeMapFrontendBlockDescriptionBatchItem[];
};

export class AiService {
	private static readonly DEFAULT_IMPROVE_PROMPT_INSTRUCTIONS = [
		// 'Пиши на русском языке.',
		'Пиши ответ с обращением к одному лицу.',
	];

	constructor(private readonly context?: vscode.ExtensionContext) { }
	private sqliteBinaryPath: string | null | undefined;
	private readonly stateDbItemCache = new Map<string, { fingerprint: string; items: Map<string, string> }>();
	private readonly output = getPromptManagerOutputChannel();

	private modelSelector: vscode.LanguageModelChatSelector = {
		vendor: 'copilot',
		family: DEFAULT_COPILOT_MODEL_FAMILY,
	};

	private getImprovePromptInstructions(): string[] {
		const configured = vscode.workspace
			.getConfiguration('promptManager')
			.get<string[]>('improvePromptInstructions', AiService.DEFAULT_IMPROVE_PROMPT_INSTRUCTIONS);

		const normalized = (configured || [])
			.map(item => String(item || '').trim())
			.filter(Boolean);

		return normalized.length > 0
			? normalized
			: [...AiService.DEFAULT_IMPROVE_PROMPT_INSTRUCTIONS];
	}

	private buildGlobalContextBlock(globalContext?: string): string {
		const normalized = (globalContext || '').trim();
		if (!normalized) {
			return '';
		}
		return `Global agent context:\n${normalized.slice(0, 1500)}\n\n`;
	}

	/** Generate a short title from prompt content */
	async generateTitle(content: string): Promise<string> {
		const locale = vscode.env.language;
		const systemPrompt = `You are a helpful assistant that generates short, descriptive titles for prompts. Respond with ONLY the title, nothing else. The title should be 3-7 words. ${buildPromptFieldLanguageRule(locale)}`;
		const userPrompt = buildTitleGenerationUserPrompt(content, locale);
		return this.chat(systemPrompt, userPrompt, 'Промпт без названия', 'generate-title', 'AiService.generateTitle');
	}

	/** Generate a short description from prompt content */
	async generateDescription(content: string): Promise<string> {
		const locale = vscode.env.language;
		const systemPrompt = `You are a helpful assistant that generates short descriptions for prompts. Respond with ONLY the description, nothing else. The description should be 1-2 sentences. ${buildPromptFieldLanguageRule(locale)}`;
		const userPrompt = buildDescriptionGenerationUserPrompt(content, locale);
		return this.chat(systemPrompt, userPrompt, '', 'generate-description', 'AiService.generateDescription');
	}

	/** Generate a URL-friendly slug from title or description */
	async generateSlug(title: string, description: string, globalContext?: string): Promise<string> {
		const input = title || description;
		if (!input) {
			return `prompt-${Date.now()}`;
		}

		// Try to generate via AI first
		const systemPrompt = 'You are a helper that converts text to a short URL-friendly slug (lowercase, hyphens, no special chars, max 40 chars). Respond with ONLY the slug, nothing else.';
		const contextBlock = this.buildGlobalContextBlock(globalContext);
		const userPrompt = `${contextBlock}Convert to slug: "${input}"`;

		const result = await this.chat(systemPrompt, userPrompt, '', 'generate-slug', 'AiService.generateSlug');
		if (result) {
			return this.sanitizeSlug(result);
		}

		// Fallback: manual slug generation
		return this.sanitizeSlug(input);
	}

	/** Improve prompt text: fix errors, clarify, format, and optimize for AI agents */
	async improvePromptText(content: string, projectContext?: string): Promise<string> {
		const normalized = (content || '').trim();
		if (!normalized) {
			return '';
		}
		const extraInstructions = this.getImprovePromptInstructions();
		const extraInstructionBlock = extraInstructions.map(line => `- ${line}`).join(' ');

		const systemPrompt = [
			'You are an expert prompt editor for AI coding agents.',
			'Your task is to rewrite the given prompt text and return ONLY the improved final text.',
			'Do not include explanations, headings like "Improved version", analysis notes, or markdown fences unless they are part of the prompt itself.',
			'Preserve the original intent and requirements.',
			'Apply these improvements:',
			'- Fix grammar, spelling, and wording errors.',
			'- Remove ambiguity and make instructions explicit.',
			'- Improve readability and structure (short paragraphs, lists where useful).',
			'- Keep formatting clean and attractive for humans.',
			'- Optimize wording for reliable interpretation by AI agents.',
			'Additional required style instructions:',
			extraInstructionBlock,
		].join(' ');

		const contextBlock = (projectContext || '').trim()
			? `Project context snapshot:\n${(projectContext || '').trim().slice(0, 6000)}\n\n`
			: '';
		const userPrompt = `${contextBlock}Improve this prompt text:\n\n${normalized.substring(0, 12000)}`;
		return this.chat(systemPrompt, userPrompt, normalized, 'improve-prompt-text', 'AiService.improvePromptText');
	}

	/** Detect programming languages from content */
	async detectLanguages(content: string): Promise<string[]> {
		const systemPrompt = 'You detect programming languages mentioned or implied in a prompt. Return a JSON array of language names. Example: ["TypeScript", "Python"]. Return ONLY the JSON array.';
		const userPrompt = content.substring(0, 2000);
		const result = await this.chat(systemPrompt, userPrompt, '[]', 'detect-languages', 'AiService.detectLanguages');
		try {
			return JSON.parse(result);
		} catch {
			return [];
		}
	}

	/** Detect frameworks from content */
	async detectFrameworks(content: string): Promise<string[]> {
		const systemPrompt = 'You detect frameworks and libraries mentioned or implied in a prompt. Return a JSON array. Example: ["React", "Express"]. Return ONLY the JSON array.';
		const userPrompt = content.substring(0, 2000);
		const result = await this.chat(systemPrompt, userPrompt, '[]', 'detect-frameworks', 'AiService.detectFrameworks');
		try {
			return JSON.parse(result);
		} catch {
			return [];
		}
	}

	/** Generate a tester-facing implementation report from staged changes */
	async generateImplementationReport(input: {
		promptTitle?: string;
		taskNumber?: string;
		projects?: string[];
		languages?: string[];
		frameworks?: string[];
		promptContent?: string;
		stagedChangesSummary: string;
	}): Promise<string> {
		const fallback = [
			'- **Что сделано**.',
			'  Недостаточно данных для автоматического формирования отчета.',
			'- **Как протестировать**.',
			'  1. Проверить staged-изменения вручную.',
			'- **Особенности реализации**.',
			'  Существенных особенностей автоматически определить не удалось.',
			'- **Примеры**.',
			'  Не добавлялись.',
		].join('\n');

		const systemPrompt = [
			'Ты формируешь краткий отчет для тестировщика по изменениям в коде.',
			'Пиши строго на русском языке.',
			'Это правило относится только к генерации отчета.',
			'Пиши отчет понятным для обычного пользователя и тестировщика языком, а не языком разработчика.',
			'Используй только факты из переданных данных, ничего не выдумывай.',
			'Верни только итоговый Markdown-отчет без пояснений до и после.',
			'Не упоминай названия файлов, пути, директории, классы, методы, хуки, коммиты, diff, ветки и другие технические идентификаторы.',
			'Не перечисляй затронутые файлы и не ссылайся на структуру проекта.',
			'Описывай изменения через пользовательское поведение, бизнес-логику, интерфейс и сценарии проверки.',
			'Если изменение сугубо техническое, переведи его в понятное следствие для тестирования или сопровождения, не раскрывая файловую структуру.',
			'Строго соблюдай формат и заголовки:',
			'- **Что сделано**.',
			'  Краткое описание выполненных изменений и реализованного функционала.',
			'- **Как протестировать**.',
			'  Пошаговая инструкция по проверке работы функционала.',
			'- **Особенности реализации**.',
			'  Описание особенностей реализации, если таковые имеются.',
			'- **Примеры**.',
			'  Примеры HTTP-запросов, вызовов страниц и т.д., которые были созданы в процессе реализации.',
			'Если для раздела мало данных, кратко укажи это внутри раздела.',
			'В разделе Как протестировать используй нумерованный список, если можно выделить шаги.',
			'В разделе Примеры перечисляй только реально обнаруженные примеры; если их нет, напиши: Не добавлялись.',
		].join(' ');

		const metaLines = [
			input.promptTitle ? `Заголовок задачи: ${input.promptTitle}` : '',
			input.taskNumber ? `Номер задачи: ${input.taskNumber}` : '',
			input.projects && input.projects.length > 0 ? `Проекты: ${input.projects.join(', ')}` : '',
			input.languages && input.languages.length > 0 ? `Языки: ${input.languages.join(', ')}` : '',
			input.frameworks && input.frameworks.length > 0 ? `Фреймворки: ${input.frameworks.join(', ')}` : '',
		].filter(Boolean).join('\n');

		const promptBlock = (input.promptContent || '').trim()
			? `Контекст из промпта:\n${(input.promptContent || '').trim().slice(0, 4000)}\n\n`
			: '';

		const userPrompt = [
			metaLines ? `Метаданные:\n${metaLines}\n` : '',
			promptBlock,
			`Staged-изменения для анализа:\n${(input.stagedChangesSummary || '').trim().slice(0, 24000)}`,
		].filter(Boolean).join('\n');

		return this.chat(systemPrompt, userPrompt, fallback, 'generate-implementation-report', 'AiService.generateImplementationReport');
	}

	async generateCommitMessage(input: {
		projectName?: string;
		stagedChangesSummary: string;
	}): Promise<string> {
		const locale = vscode.env.language;
		const fallback = locale.toLowerCase().startsWith('ru') ? 'Обновить изменения' : 'Update changes';
		const commitInstructions = normalizeCommitMessageGenerationInstructions(
			vscode.workspace.getConfiguration().get<unknown>('github.copilot.chat.commitMessageGeneration.instructions')
		);

		const systemPromptParts = [
			'You generate git commit messages from staged changes.',
			'Behave like an editor-integrated Git commit message generator: infer the main intent from the staged changes and produce a ready-to-use commit message.',
			'Return only the commit message text with no Markdown fences, no commentary, and no surrounding quotes.',
			'Prefer a concise imperative subject line.',
			'Add a body only when it materially improves clarity.',
			'The subject line should usually stay within 72 characters.',
			'Base the message strictly on the provided staged changes summary.',
			'Do not mention that the message was generated by AI.',
			'Do not mention files, paths, diffs, repositories, prompts, or implementation internals unless necessary for clarity.',
			buildPromptFieldLanguageRule(locale),
		];

		if (commitInstructions) {
			systemPromptParts.push(`Additional commit message instructions:\n${commitInstructions}`);
		}

		const userPrompt = [
			input.projectName ? `Project: ${input.projectName}` : '',
			`Staged changes summary:\n${(input.stagedChangesSummary || '').trim().slice(0, 24000)}`,
		].filter(Boolean).join('\n');

		return this.chat(
			systemPromptParts.join(' '),
			userPrompt,
			fallback,
			'generate-commit-message',
			'AiService.generateCommitMessage',
		);
	}

	async analyzePromptDashboardReview(input: {
		promptTitle: string;
		promptContent: string;
		projects: PromptDashboardProjectSummary[];
	}): Promise<string> {
		const fallback = [
			'### Итог',
			'Недостаточно данных для автоматического анализа параллельных веток.',
			'### Риски',
			'- Проверьте локальные изменения, pipeline и MR/PR вручную.',
			'### Следующие действия',
			'- Обновите dashboard и повторите анализ после загрузки Git-данных.',
		].join('\n');

		const systemPrompt = [
			'Ты анализируешь состояние параллельных веток, pipeline и merge requests в редакторе задач.',
			'Пиши на русском языке, коротко и прикладно.',
			'Используй только переданные данные, ничего не выдумывай.',
			'Сфокусируйся на рисках конфликтов, сломанных проверках, незавершенных MR/PR и безопасном порядке действий.',
			'Верни Markdown с разделами: ### Итог, ### Риски, ### Следующие действия.',
		].join(' ');

		const projectSummary = input.projects.map(project => ({
			project: project.project,
			currentBranch: project.currentBranch,
			promptBranch: project.promptBranch,
			trackedBranch: project.trackedBranch,
			dirty: project.dirty,
			hasConflicts: project.hasConflicts,
			ahead: project.ahead,
			behind: project.behind,
			recentCommits: project.recentCommits.slice(0, 2).map(commit => ({
				sha: commit.shortSha,
				subject: commit.subject,
			})),
			review: {
				provider: project.review.remote?.provider || null,
				requestState: project.review.request?.state || null,
				requestUrl: project.review.request?.url || '',
				error: project.review.error || '',
			},
			pipeline: project.pipeline ? {
				provider: project.pipeline.provider,
				state: project.pipeline.state,
				checks: project.pipeline.checks.map(check => ({ name: check.name, state: check.state })),
				error: project.pipeline.error,
			} : null,
			parallelBranches: project.parallelBranches.map(branch => ({
				name: branch.name,
				ahead: branch.ahead,
				behind: branch.behind,
				affectedFiles: branch.affectedFiles.slice(0, 20).map(file => `${file.status}:${file.previousPath || ''}:${file.path}`),
				potentialConflicts: branch.potentialConflicts.slice(0, 10),
			})),
		}));

		const userPrompt = [
			`Задача: ${input.promptTitle || 'Без названия'}`,
			input.promptContent.trim() ? `Текст промпта:\n${input.promptContent.trim().slice(0, 4000)}` : '',
			`Данные dashboard:\n${JSON.stringify(projectSummary, null, 2).slice(0, 24000)}`,
		].filter(Boolean).join('\n\n');

		return this.chat(systemPrompt, userPrompt, fallback, 'prompt-dashboard-review', 'AiService.analyzePromptDashboardReview');
	}

	async generateCodeMapAreaDescription(
		input: CodeMapAreaDescriptionInput,
		modelFamily?: string,
	): Promise<string> {
		const isRussianLocale = input.locale.toLowerCase().startsWith('ru');
		const fallback = isRussianLocale
			? `Область ${input.area} объединяет связанные файлы ${input.representativeFiles.join(', ')} и ключевые символы ${input.symbols.join(', ')}.`
			: `Area ${input.area} groups related files ${input.representativeFiles.join(', ')} and key symbols ${input.symbols.join(', ')}.`;
		const systemPrompt = isRussianLocale
			? [
				'Ты анализируешь область кода для инструкции ИИ-агента.',
				'Верни только короткое, плотное описание на русском языке без markdown-списков и без вводных фраз.',
				'Опиши назначение области, главные обязанности, основные точки входа, связи между файлами и что именно в ней делает код.',
				'Не перечисляй просто имена файлов без объяснения.',
				'Не выдумывай то, чего нет в коде.',
				`Длина ответа: до ${Math.max(200, input.maxChars)} символов.`,
				`Глубина описания: ${input.mode}.`,
			].join(' ')
			: [
				'You analyze a code area for an AI-agent instruction.',
				'Return only a short dense description without markdown bullets or prefacing.',
				'Describe the purpose of the area, main responsibilities, control points, relationships between files, and what the code actually does.',
				'Do not only list file names.',
				'Do not invent details not grounded in the code.',
				`Keep the answer within ${Math.max(200, input.maxChars)} characters.`,
				`Description depth: ${input.mode}.`,
			].join(' ');

		const snippetBlock = input.snippets
			.map(item => `FILE: ${item.filePath}\n${item.snippet}`)
			.join('\n\n');
		const userPrompt = [
			`Repository: ${input.repository}`,
			`Branch: ${input.branchName}`,
			`Area: ${input.area}`,
			input.manifestDescription ? `Project description: ${input.manifestDescription}` : '',
			`Representative files: ${input.representativeFiles.join(', ') || 'none'}`,
			`Detected symbols: ${input.symbols.join(', ') || 'none'}`,
			'',
			'Code excerpts:',
			snippetBlock || 'No code excerpts available.',
		].filter(Boolean).join('\n');

		const resolvedFamily = await this.resolveFreeCopilotModel(modelFamily || this.modelSelector.family);
		if (!resolvedFamily) {
			return fallback;
		}
		return this.chatWithSelector(
			{ vendor: 'copilot', family: resolvedFamily },
			systemPrompt,
			userPrompt,
			fallback,
			{ allowFreeCopilotFallback: false, requestLabel: 'codemap-area-description', callerMethod: 'AiService.generateCodeMapAreaDescription' },
		);
	}

	async generateCodeMapAreaDescriptionsBatch(
		input: CodeMapAreaBatchDescriptionInput,
		modelFamily?: string,
	): Promise<string> {
		const isRussianLocale = input.locale.toLowerCase().startsWith('ru');
		const fallback = JSON.stringify({
			areas: input.areas.map(area => ({ id: area.id, description: '' })),
		});
		const systemPrompt = isRussianLocale
			? [
				'Ты анализируешь несколько областей кода для инструкции ИИ-агента.',
				'Верни только валидный JSON без markdown и пояснений.',
				'Формат ответа строго такой: {"areas":[{"id":"area-1","description":"..."}]}.',
				'Для каждого id верни короткое плотное описание на русском языке.',
				'Опиши назначение области, главные обязанности, ключевые точки входа и связи между файлами.',
				'Не перечисляй только имена файлов и не выдумывай детали.',
				`Длина каждого description: до ${Math.max(200, input.maxChars)} символов.`,
				`Глубина описания: ${input.mode}.`,
			].join(' ')
			: [
				'You analyze multiple code areas for an AI-agent instruction.',
				'Return only valid JSON without markdown or commentary.',
				'The response format must be exactly {"areas":[{"id":"area-1","description":"..."}]}.',
				'Return one concise dense description for every provided id.',
				'Describe purpose, main responsibilities, control points, and relationships between files.',
				'Do not merely list file names and do not invent unsupported details.',
				`Keep each description within ${Math.max(200, input.maxChars)} characters.`,
				`Description depth: ${input.mode}.`,
			].join(' ');

		const areaBlocks = input.areas.map(area => {
			const snippetBlock = area.snippets
				.map(item => `FILE: ${item.filePath}\n${item.snippet}`)
				.join('\n\n');
			return [
				`ID: ${area.id}`,
				`Area: ${area.area}`,
				`Representative files: ${area.representativeFiles.join(', ') || 'none'}`,
				`Detected symbols: ${area.symbols.join(', ') || 'none'}`,
				'Code excerpts:',
				snippetBlock || 'No code excerpts available.',
			].join('\n');
		}).join('\n\n=====\n\n');

		const userPrompt = [
			`Repository: ${input.repository}`,
			`Branch: ${input.branchName}`,
			input.manifestDescription ? `Project description: ${input.manifestDescription}` : '',
			'',
			'Areas to describe:',
			areaBlocks,
		].filter(Boolean).join('\n');

		const resolvedFamily = await this.resolveFreeCopilotModel(modelFamily || this.modelSelector.family);
		if (!resolvedFamily) {
			return fallback;
		}
		return this.chatWithSelector(
			{ vendor: 'copilot', family: resolvedFamily },
			systemPrompt,
			userPrompt,
			fallback,
			{ allowFreeCopilotFallback: false, requestLabel: 'codemap-area-description-batch', callerMethod: 'AiService.generateCodeMapAreaDescriptionsBatch' },
		);
	}

	async generateCodeMapSymbolDescriptionsBatch(
		input: CodeMapSymbolBatchDescriptionInput,
		modelFamily?: string,
	): Promise<string> {
		const isRussianLocale = input.locale.toLowerCase().startsWith('ru');
		const fallback = JSON.stringify({
			files: input.files.map(file => ({ id: file.id, description: '' })),
			symbols: input.files.flatMap(file => file.symbols.map(symbol => ({ id: symbol.id, description: '' }))),
		});
		const systemPrompt = isRussianLocale
			? [
				'Ты анализируешь пакет файлов и их символов для инструкции ИИ-агента.',
				'Верни только валидный JSON без markdown и пояснений.',
				'Формат ответа строго такой: {"files":[{"id":"file-1","description":"..."}],"symbols":[{"id":"symbol-1","description":"..."}]}.',
				'Для каждого id файла и символа верни конкретное и полезное описание на русском языке.',
				'Для файла опиши назначение самого файла, его главные обязанности, роль в системе и ключевые части содержимого.',
				'Опирайся на сигнатуру и кодовый фрагмент: объясни поведение символа, важные шаги, входы/выходы, побочные эффекты и ключевые вызовы.',
				'Не пиши пустые общие шаблоны вроде "выполняет действие своей области" или "инкапсулирует логику".',
				'Если по фрагменту видна только часть поведения, честно опиши только наблюдаемое.',
				`Длина каждого file description: до ${Math.max(180, input.maxChars)} символов.`,
				`Длина каждого symbol description: до ${Math.max(160, input.maxChars)} символов.`,
				`Глубина описания: ${input.mode}.`,
			].join(' ')
			: [
				'You analyze a batch of files and their code symbols for an AI-agent instruction.',
				'Return only valid JSON without markdown or commentary.',
				'The response format must be exactly {"files":[{"id":"file-1","description":"..."}],"symbols":[{"id":"symbol-1","description":"..."}]}.',
				'For each file id and symbol id, return a concrete and useful description.',
				'For a file description, explain the purpose of the file, its main responsibilities, its role in the system, and the key parts of its contents.',
				'Ground the description in the signature and code excerpt: explain behavior, key steps, inputs/outputs, side effects, and important calls.',
				'Do not use empty templates like "performs an area action" or "encapsulates logic".',
				'If the excerpt reveals only part of the behavior, describe only what is observable.',
				`Keep each file description within ${Math.max(180, input.maxChars)} characters.`,
				`Keep each symbol description within ${Math.max(160, input.maxChars)} characters.`,
				`Description depth: ${input.mode}.`,
			].join(' ');

		const fileBlocks = input.files.map(file => {
			const symbolsBlock = file.symbols.length > 0
				? file.symbols.map(symbol => [
					`ID: ${symbol.id}`,
					`Kind: ${symbol.kind}`,
					`Name: ${symbol.name}`,
					`Signature: ${symbol.signature}`,
					symbol.fallbackDescription ? `Fallback description: ${symbol.fallbackDescription}` : '',
					'Code excerpt:',
					symbol.excerpt || 'No code excerpt available.',
				].filter(Boolean).join('\n')).join('\n\n-----\n\n')
				: 'none';

			return [
				`FILE: ${file.filePath}`,
				`FILE_ID: ${file.id}`,
				`Role: ${file.fileRole}`,
				`Line count: ${file.lineCount}`,
				file.imports.length > 0 ? `Internal imports: ${file.imports.join(', ')}` : '',
				file.frontendContract.length > 0 ? `Frontend contract: ${file.frontendContract.join(' | ')}` : '',
				file.frontendBlockNames.length > 0 ? `Frontend blocks: ${file.frontendBlockNames.join(', ')}` : '',
				file.fallbackDescription ? `Fallback file description: ${file.fallbackDescription}` : '',
				'File excerpt:',
				file.excerpt || 'No file excerpt available.',
				'Symbols:',
				symbolsBlock,
			].join('\n');
		}).join('\n\n=====\n\n');

		const userPrompt = [
			`Repository: ${input.repository}`,
			`Branch: ${input.branchName}`,
			'Files and symbols to describe:',
			fileBlocks,
		].filter(Boolean).join('\n\n');

		const resolvedFamily = await this.resolveFreeCopilotModel(modelFamily || this.modelSelector.family);
		if (!resolvedFamily) {
			return fallback;
		}
		return this.chatWithSelector(
			{ vendor: 'copilot', family: resolvedFamily },
			systemPrompt,
			userPrompt,
			fallback,
			{ allowFreeCopilotFallback: false, requestLabel: 'codemap-symbol-description-batch', callerMethod: 'AiService.generateCodeMapSymbolDescriptionsBatch' },
		);
	}

	async generateCodeMapFrontendBlockDescriptionsBatch(
		input: CodeMapFrontendBlockBatchDescriptionInput,
		modelFamily?: string,
	): Promise<string> {
		const isRussianLocale = input.locale.toLowerCase().startsWith('ru');
		const fallback = JSON.stringify({
			blocks: input.blocks.map(block => ({ id: block.id, description: '' })),
		});
		const systemPrompt = isRussianLocale
			? [
				'Ты анализируешь UI-блоки frontend-файлов для инструкции ИИ-агента.',
				'Верни только валидный JSON без markdown и пояснений.',
				'Формат ответа строго такой: {"blocks":[{"id":"block-1","description":"..."}]}.',
				'Для каждого id верни конкретное и полезное описание на русском языке.',
				'Опирайся на purpose, stateDeps, eventHandlers, dataSources, childComponents, conditions, routes, формы и кодовые фрагменты.',
				'Объясняй, что пользователь видит в этом блоке, от каких состояний он зависит и какие действия инициирует.',
				'Не пиши пустые шаблоны вроде "отображает интерфейсный блок" или "рендерит часть страницы".',
				'Если данных недостаточно, честно опиши только наблюдаемое поведение.',
				`Длина каждого description: до ${Math.max(180, input.maxChars)} символов.`,
				`Глубина описания: ${input.mode}.`,
			].join(' ')
			: [
				'You analyze UI blocks from frontend files for an AI-agent instruction.',
				'Return only valid JSON without markdown or commentary.',
				'The response format must be exactly {"blocks":[{"id":"block-1","description":"..."}]}.',
				'For each id, return a concrete and useful description.',
				'Ground the description in purpose, stateDeps, eventHandlers, dataSources, childComponents, conditions, routes, form fields, and code snippets.',
				'Explain what the user sees, which state drives the block, and which actions it triggers.',
				'Do not use empty templates like "renders a UI block" or "shows part of the page".',
				'If the evidence is partial, describe only the observable behavior.',
				`Keep each description within ${Math.max(180, input.maxChars)} characters.`,
				`Description depth: ${input.mode}.`,
			].join(' ');

		const groupedByFile = new Map<string, CodeMapFrontendBlockDescriptionBatchItem[]>();
		for (const block of input.blocks) {
			const key = `${block.filePath}::${block.fileRole}::${block.framework}`;
			const group = groupedByFile.get(key) || [];
			group.push(block);
			groupedByFile.set(key, group);
		}

		const blockSections = Array.from(groupedByFile.entries()).map(([key, blocks]) => {
			const [filePath, fileRole, framework] = key.split('::');
			const blocksSection = blocks.map(block => [
				`ID: ${block.id}`,
				`Kind: ${block.blockKind}`,
				`Name: ${block.blockName}`,
				`Purpose: ${block.purpose}`,
				block.stateDeps.length > 0 ? `State deps: ${block.stateDeps.join(', ')}` : '',
				block.eventHandlers.length > 0 ? `Event handlers: ${block.eventHandlers.join(', ')}` : '',
				block.dataSources.length > 0 ? `Data sources: ${block.dataSources.join(', ')}` : '',
				block.childComponents.length > 0 ? `Child components: ${block.childComponents.join(', ')}` : '',
				block.conditions.length > 0 ? `Conditions: ${block.conditions.join(', ')}` : '',
				block.routes.length > 0 ? `Routes: ${block.routes.join(', ')}` : '',
				block.forms.length > 0 ? `Forms: ${block.forms.join(', ')}` : '',
				block.fallbackDescription ? `Fallback description: ${block.fallbackDescription}` : '',
				'Template excerpt:',
				block.excerpt || 'No template excerpt available.',
				block.linkedScriptSnippets.length > 0 ? 'Linked script snippets:' : '',
				...block.linkedScriptSnippets,
			].filter(Boolean).join('\n')).join('\n\n-----\n\n');

			return [
				`FILE: ${filePath}`,
				`Role: ${fileRole}`,
				`Framework: ${framework}`,
				'Blocks:',
				blocksSection,
			].join('\n');
		}).join('\n\n=====\n\n');

		const userPrompt = [
			`Repository: ${input.repository}`,
			`Branch: ${input.branchName}`,
			'Frontend blocks to describe:',
			blockSections,
		].filter(Boolean).join('\n\n');

		const resolvedFamily = await this.resolveFreeCopilotModel(modelFamily || this.modelSelector.family);
		if (!resolvedFamily) {
			return fallback;
		}
		return this.chatWithSelector(
			{ vendor: 'copilot', family: resolvedFamily },
			systemPrompt,
			userPrompt,
			fallback,
			{ allowFreeCopilotFallback: false, requestLabel: 'codemap-frontend-block-description-batch', callerMethod: 'AiService.generateCodeMapFrontendBlockDescriptionsBatch' },
		);
	}

	/** Generic chat with Language Model API */
	private async chat(
		systemPrompt: string,
		userPrompt: string,
		fallback: string,
		requestLabel: string,
		callerMethod: string,
	): Promise<string> {
		return this.chatWithSelector(this.modelSelector, systemPrompt, userPrompt, fallback, { requestLabel, callerMethod });
	}

	private async chatWithSelector(
		selector: vscode.LanguageModelChatSelector,
		systemPrompt: string,
		userPrompt: string,
		fallback: string,
		options?: {
			allowFreeCopilotFallback?: boolean;
			requestLabel?: string;
			callerMethod?: string;
		},
	): Promise<string> {
		const requestLabel = options?.requestLabel || 'generic-chat';
		const callerMethod = options?.callerMethod || `AiService.${requestLabel}`;
		try {
			const allowFreeCopilotFallback = options?.allowFreeCopilotFallback ?? true;
			const [model] = await vscode.lm.selectChatModels(selector);
			if (!model) {
				if (!allowFreeCopilotFallback) {
					this.logAiRequest(`label=${requestLabel} result=no-model selector="${this.formatSelectorForLog(selector)}" fallback=disabled`);
					return fallback;
				}

				const fallbackModel = await this.selectFreeFallbackModel(selector);
				if (!fallbackModel) {
					this.logAiRequest(`label=${requestLabel} result=no-free-model selector="${this.formatSelectorForLog(selector)}" fallback=free-only`);
					return fallback;
				}
				this.logAiRequest(`label=${requestLabel} result=free-fallback selector="${this.formatSelectorForLog(selector)}" model="${this.formatModelForLog(fallbackModel)}"`);
				return this.chatWithModel(fallbackModel, systemPrompt, userPrompt, fallback, requestLabel, selector, callerMethod);
			}
			return this.chatWithModel(model, systemPrompt, userPrompt, fallback, requestLabel, selector, callerMethod);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logAiRequest(`label=${requestLabel} result=selector-error selector="${this.formatSelectorForLog(selector)}" error="${message}"`);
			console.error('[PromptManager] AI error:', err);
			return fallback;
		}
	}

	private async chatWithModel(
		model: vscode.LanguageModelChat,
		systemPrompt: string,
		userPrompt: string,
		fallback: string,
		requestLabel: string,
		selector: vscode.LanguageModelChatSelector,
		callerMethod: string,
	): Promise<string> {
		try {
			this.logAiRequest(`label=${requestLabel} result=send-request selector="${this.formatSelectorForLog(selector)}" model="${this.formatModelForLog(model)}"`);
			await appendPromptAiLog({
				kind: 'ai',
				prompt: `SYSTEM: ${systemPrompt}\nUSER: ${userPrompt}`,
				callerMethod,
				model: this.getModelNameForPromptLog(model),
			});
			const messages = [
				vscode.LanguageModelChatMessage.User(systemPrompt),
				vscode.LanguageModelChatMessage.User(userPrompt),
			];
			const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
			let result = '';
			for await (const chunk of response.text) {
				result += chunk;
			}
			return result.trim() || fallback;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logAiRequest(`label=${requestLabel} result=send-error selector="${this.formatSelectorForLog(selector)}" model="${this.formatModelForLog(model)}" error="${message}"`);
			return fallback;
		}
	}

	private async selectFreeFallbackModel(
		selector: vscode.LanguageModelChatSelector,
	): Promise<vscode.LanguageModelChat | null> {
		const requestedModel = String(selector.id || selector.family || '').trim();
		const freeModels = await this.getAvailableFreeModels();
		if (freeModels.length === 0) {
			return null;
		}

		const allModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
		if (allModels.length === 0) {
			return null;
		}

		const preferred = requestedModel
			? this.findBestAvailableModelMatch(freeModels, requestedModel)
			: undefined;
		const candidates = preferred
			? [preferred, ...freeModels.filter(model => model.id !== preferred.id)]
			: freeModels;

		for (const candidate of candidates) {
			const matched = this.findBestModelMatch(allModels, candidate.id);
			if (matched) {
				return matched;
			}
		}

		return null;
	}

	private logAiRequest(message: string): void {
		this.output.appendLine(`[ai-request] ${message}`);
	}

	private formatSelectorForLog(selector: vscode.LanguageModelChatSelector): string {
		const parts = [
			selector.vendor ? `vendor=${selector.vendor}` : '',
			selector.id ? `id=${selector.id}` : '',
			selector.family ? `family=${selector.family}` : '',
			selector.version ? `version=${selector.version}` : '',
		].filter(Boolean);
		return parts.join(', ') || 'empty-selector';
	}

	private formatModelForLog(model: vscode.LanguageModelChat): string {
		const parts = [
			model.vendor ? `vendor=${model.vendor}` : '',
			model.id ? `id=${model.id}` : '',
			model.family ? `family=${model.family}` : '',
			model.name ? `name=${model.name}` : '',
			(model as { identifier?: string }).identifier ? `identifier=${(model as { identifier?: string }).identifier}` : '',
		].filter(Boolean);
		return parts.join(', ') || 'unknown-model';
	}

	private getModelNameForPromptLog(model: vscode.LanguageModelChat): string {
		return String(
			model.id
			|| (model as { identifier?: string }).identifier
			|| model.family
			|| model.name
			|| '',
		).trim() || 'unknown-model';
	}

	/** Sanitize a string into a URL-friendly slug */
	private sanitizeSlug(input: string): string {
		return input
			.toLowerCase()
			.replace(/[^\w\s-]/g, '')
			.replace(/[\s_]+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
			.substring(0, 40) || `prompt-${Date.now()}`;
	}

	/** Get available language models */
	async getAvailableModels(): Promise<AvailableModelOption[]> {
		let models: vscode.LanguageModelChat[] = [];
		try {
			models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
		} catch {
			// Keep going: cached Copilot model state is still useful for the picker.
		}

		const visibleModels = await this.getVisibleCopilotModels(models);
		if (visibleModels.length > 0) {
			return visibleModels;
		}

		return this.normalizeAvailableModels(models.map(model => ({
			id: this.getPreferredModelOptionId(model.id, String((model as any).identifier || '')),
			name: (model.name || '').trim() || model.family || model.id,
		})));
	}

	async getAvailableFreeModels(): Promise<AvailableModelOption[]> {
		let models: vscode.LanguageModelChat[] = [];
		try {
			models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
		} catch {
			// Keep going: we can still fall back to the default free family.
		}

		const dbPath = await this.resolveStateDbPath();
		if (dbPath) {
			const cachedStandardModels = await this.getVisibleCopilotModelsFromCache(
				dbPath,
				models,
				entry => this.isZeroCostCopilotCacheEntry(entry),
			);
			if (cachedStandardModels.length > 0) {
				return this.normalizeAvailableModels(cachedStandardModels.map(option => ({
					id: normalizeCopilotModelFamily(option.id),
					name: option.name,
				})));
			}

			const legacyStandardModels = await this.getVisibleCopilotModelsFromLegacyCache(
				dbPath,
				entry => this.isZeroCostCopilotCacheEntry(entry),
			);
			if (legacyStandardModels.length > 0) {
				return this.normalizeAvailableModels(legacyStandardModels.map(option => ({
					id: normalizeCopilotModelFamily(option.id),
					name: option.name,
				})));
			}
		}

		return [];
	}

	async resolveFreeCopilotModel(modelId: string | undefined | null): Promise<string> {
		const freeModels = await this.getAvailableFreeModels();
		if (freeModels.length === 0) {
			return '';
		}

		const matched = this.findBestAvailableModelMatch(freeModels, String(modelId || ''));
		if (matched) {
			return normalizeCopilotModelFamily(matched.id);
		}

		return '';
	}

	private async getVisibleCopilotModels(models: vscode.LanguageModelChat[]): Promise<AvailableModelOption[]> {
		const workspaceSessionModels = await this.getVisibleCopilotModelsFromWorkspaceSessions();
		const dbPath = await this.resolveStateDbPath();
		if (!dbPath) {
			return workspaceSessionModels;
		}

		const cachedModels = await this.getVisibleCopilotModelsFromCache(dbPath, models);
		if (cachedModels.length > 0) {
			return cachedModels;
		}

		const legacyCachedModels = await this.getVisibleCopilotModelsFromLegacyCache(dbPath);
		if (legacyCachedModels.length > 0) {
			return legacyCachedModels;
		}

		const [modelsControlRaw, modelPickerPreferencesRaw, copilotSkuRaw] = await Promise.all([
			this.readStateItemValue(dbPath, 'chat.modelsControl'),
			this.readStateItemValue(dbPath, 'chatModelPickerPreferences'),
			this.readStateItemValue(dbPath, 'extensionsAssignmentFilterProvider.copilotSku'),
		]);

		const modelsControl = this.parseJson<ChatModelsControl>(modelsControlRaw);
		if (!modelsControl) {
			return workspaceSessionModels;
		}

		const featuredEntries = this.getVisibleControlEntries(modelsControl, this.resolveCopilotTier(copilotSkuRaw));
		if (featuredEntries.length === 0) {
			return workspaceSessionModels;
		}

		const preferences = this.parseJson<Record<string, boolean>>(modelPickerPreferencesRaw) || {};
		const extraVisibleIdentifiers = Object.entries(preferences)
			.filter(([identifier, isVisible]) => isVisible && identifier.toLowerCase().startsWith('copilot/'))
			.map(([identifier]) => identifier);
		const result = await this.buildModelOptionsFromControlEntries(dbPath, models, featuredEntries, extraVisibleIdentifiers);

		if (result.length > 0) {
			return this.sortVisibleModels(result, featuredEntries);
		}

		return workspaceSessionModels;
	}

	private async getVisibleCopilotModelsFromCache(
		dbPath: string,
		models: vscode.LanguageModelChat[],
		entryFilter?: (entry: CachedLanguageModelEntry) => boolean,
	): Promise<AvailableModelOption[]> {
		const cachedModelsRaw = await this.readStateItemValue(dbPath, 'chat.cachedLanguageModels.v2');
		const cachedModels = this.parseJson<CachedLanguageModelEntry[]>(cachedModelsRaw);
		if (!cachedModels || cachedModels.length === 0) {
			return [];
		}

		const availableById = new Map<string, vscode.LanguageModelChat>();
		const availableByIdentifier = new Map<string, vscode.LanguageModelChat>();
		for (const model of models) {
			const id = (model.id || '').trim();
			if (id) {
				availableById.set(id, model);
				availableByIdentifier.set(`copilot/${id}`.toLowerCase(), model);
			}

			const family = (model.family || '').trim();
			if (family) {
				availableByIdentifier.set(`copilot/${family}`.toLowerCase(), model);
			}

			const identifier = String((model as any).identifier || '').trim();
			if (identifier) {
				availableByIdentifier.set(identifier.toLowerCase(), model);
			}
		}

		const result: AvailableModelOption[] = [];
		const seenIds = new Set<string>();
		const resultIndexByName = new Map<string, number>();
		for (const entry of cachedModels) {
			const metadata = entry.metadata!;
			if (!this.isVisibleCopilotCacheEntry(entry) || (entryFilter && !entryFilter(entry))) {
				continue;
			}

			// Prompt Manager opens the regular Copilot chat panel, not special session types.
			const model = availableByIdentifier.get(String(entry.identifier || '').trim().toLowerCase())
				|| availableById.get(String(metadata.id || '').trim());
			const id = this.getPreferredModelOptionId(
				(model?.id || metadata.id || '').trim(),
				String((model as any)?.identifier || entry.identifier || '').trim(),
			);
			const seenKey = (this.normalizeModelInput(id) || id).toLowerCase();
			if (!id || this.isAutoModelIdentifier(id) || seenIds.has(seenKey)) {
				continue;
			}

			seenIds.add(seenKey);
			const option: AvailableModelOption = {
				id,
				name: String(metadata.name || '').trim() || (model?.name || '').trim() || model?.family || id,
			};
			const nameKey = this.normalizeVisibleModelName(option.name);
			const existingIndex = nameKey ? resultIndexByName.get(nameKey) : undefined;
			if (existingIndex !== undefined) {
				const existing = result[existingIndex];
				if (this.shouldPreferVisibleModelOption(option, existing)) {
					result[existingIndex] = option;
				}
				continue;
			}

			if (nameKey) {
				resultIndexByName.set(nameKey, result.length);
			}
			result.push(option);
		}

		return result;
	}

	private async getVisibleCopilotModelsFromLegacyCache(
		dbPath: string,
		entryFilter?: (entry: CachedLanguageModelEntry) => boolean,
	): Promise<AvailableModelOption[]> {
		const cachedModelsRaw = await this.readStateItemValue(dbPath, 'chat.cachedLanguageModels');
		const cachedModels = this.parseJson<CachedLanguageModelEntry[]>(cachedModelsRaw);
		if (!cachedModels || cachedModels.length === 0) {
			return [];
		}

		const result: AvailableModelOption[] = [];
		const seenIds = new Set<string>();
		for (const entry of cachedModels) {
			if (!this.isVisibleCopilotCacheEntry(entry) || (entryFilter && !entryFilter(entry))) {
				continue;
			}

			const metadata = entry.metadata!;
			const id = this.getPreferredModelOptionId(metadata.id || '', entry.identifier);
			const seenKey = (this.normalizeModelInput(id) || id).toLowerCase();
			if (!id || this.isAutoModelIdentifier(id) || seenIds.has(seenKey)) {
				continue;
			}

			seenIds.add(seenKey);
			result.push({
				id,
				name: String(metadata.name || '').trim() || metadata.family || id,
			});
		}

		return result;
	}

	private isZeroCostCopilotCacheEntry(entry: CachedLanguageModelEntry): boolean {
		return isZeroCostCopilotModelPickerCategory(entry.metadata?.modelPickerCategory);
	}

	private sortVisibleModels(
		models: AvailableModelOption[],
		featuredEntries: ChatModelsControlEntry[],
	): AvailableModelOption[] {
		const featuredRank = new Map<string, number>();
		featuredEntries.forEach((entry, index) => {
			const id = this.normalizeModelInput(String(entry.id || '').trim()) || String(entry.id || '').trim();
			if (id && !featuredRank.has(id)) {
				featuredRank.set(id, index);
			}
		});

		return [...models].sort((left, right) => {
			const leftFeatured = featuredRank.get(this.normalizeModelInput(left.id) || left.id);
			const rightFeatured = featuredRank.get(this.normalizeModelInput(right.id) || right.id);
			if (leftFeatured !== undefined || rightFeatured !== undefined) {
				if (leftFeatured === undefined) {
					return 1;
				}
				if (rightFeatured === undefined) {
					return -1;
				}
				if (leftFeatured !== rightFeatured) {
					return leftFeatured - rightFeatured;
				}
			}

			return left.name.localeCompare(right.name, 'ru', { sensitivity: 'base' });
		});
	}

	private normalizeAvailableModels(models: AvailableModelOption[]): AvailableModelOption[] {
		const result: AvailableModelOption[] = [];
		const seen = new Set<string>();

		for (const model of models) {
			const id = String(model.id || '').trim();
			const seenKey = (this.normalizeModelInput(id) || id).toLowerCase();
			if (!id || this.isAutoModelIdentifier(id) || seen.has(seenKey)) {
				continue;
			}

			seen.add(seenKey);
			result.push({
				id,
				name: String(model.name || '').trim() || id,
			});
		}

		return result;
	}

	private async buildModelOptionsFromControlEntries(
		dbPath: string,
		models: vscode.LanguageModelChat[],
		entries: ChatModelsControlEntry[],
		extraIdentifiers: string[] = [],
	): Promise<AvailableModelOption[]> {
		const cacheLookup = await this.buildCopilotModelLookup(dbPath, models);
		const result: AvailableModelOption[] = [];
		const seenIds = new Set<string>();
		const pushModel = (modelIdOrIdentifier: string, nameOverride?: string): void => {
			const option = this.resolveLookupModelOption(cacheLookup, modelIdOrIdentifier, nameOverride);
			if (!option) {
				return;
			}

			const seenKey = (this.normalizeModelInput(option.id) || option.id).toLowerCase();
			if (!option.id || this.isAutoModelIdentifier(option.id) || seenIds.has(seenKey)) {
				return;
			}

			seenIds.add(seenKey);
			result.push(option);
		};

		for (const entry of entries) {
			const controlId = (entry.id || '').trim();
			if (!controlId) {
				continue;
			}

			pushModel(controlId, entry.label);
		}

		for (const identifier of extraIdentifiers) {
			pushModel(identifier);
		}

		return result;
	}

	private getVisibleControlEntries(modelsControl: ChatModelsControl, preferredTier: 'free' | 'paid'): ChatModelsControlEntry[] {
		const primary = preferredTier === 'free' ? modelsControl.free : modelsControl.paid;
		const fallback = preferredTier === 'free' ? modelsControl.paid : modelsControl.free;
		const source = primary && Object.keys(primary).length > 0 ? primary : fallback;
		if (!source) {
			return [];
		}

		return Object.values(source).filter(entry => Boolean(entry?.featured));
	}

	private resolveCopilotTier(rawSku: string): 'free' | 'paid' {
		const normalized = String(rawSku || '').trim().toLowerCase();
		return normalized.includes('free') ? 'free' : 'paid';
	}

	private parseJson<T>(raw: string): T | null {
		const normalized = String(raw || '').trim();
		if (!normalized) {
			return null;
		}

		try {
			return JSON.parse(normalized) as T;
		} catch {
			return null;
		}
	}

	private async readStateItemValue(dbPath: string, key: string): Promise<string> {
		const sqliteValue = await this.readStateItemValueWithSqlite(dbPath, key);
		if (sqliteValue.ok) {
			return sqliteValue.value;
		}

		const sqlJsValue = await this.readStateItemValueWithSqlJs(dbPath, key);
		return sqlJsValue ?? '';
	}

	private async readStateItemValueWithSqlite(dbPath: string, key: string): Promise<{ ok: boolean; value: string }> {
		const sqlitePath = this.resolveSqliteBinaryPath();
		if (!sqlitePath) {
			return { ok: false, value: '' };
		}

		try {
			const sql = `SELECT value FROM ItemTable WHERE key='${this.escapeSql(key)}' LIMIT 1;`;
			const { stdout } = await execFileAsync(sqlitePath, [dbPath, sql]);
			return { ok: true, value: (stdout || '').trim() };
		} catch {
			return { ok: false, value: '' };
		}
	}

	private async readStateItemValueWithSqlJs(dbPath: string, key: string): Promise<string | null> {
		const wasmPath = this.getSqlJsWasmPath();
		if (!wasmPath) {
			return null;
		}

		try {
			const fingerprint = this.getStateDbFingerprint(dbPath);
			if (!fingerprint) {
				return null;
			}

			const cached = this.stateDbItemCache.get(dbPath);
			if (!cached || cached.fingerprint !== fingerprint) {
				return await readSqliteItemValue(dbPath, wasmPath, key);
			}

			return this.stateDbItemCache.get(dbPath)?.items.get(key) ?? '';
		} catch {
			return null;
		}
	}

	private getSqlJsWasmPath(): string | null {
		const extensionUri = this.context?.extensionUri;
		if (!extensionUri) {
			return null;
		}

		const wasmPath = vscode.Uri.joinPath(extensionUri, 'dist', 'sql-wasm.wasm').fsPath;
		return fs.existsSync(wasmPath) ? wasmPath : null;
	}

	private getStateDbFingerprint(dbPath: string): string {
		const candidates = [
			dbPath,
			`${dbPath}-wal`,
			`${dbPath}-shm`,
			`${dbPath}-journal`,
		];

		const parts: string[] = [];
		for (const candidate of candidates) {
			try {
				const stat = fs.statSync(candidate);
				parts.push(`${candidate}:${stat.size}:${stat.mtimeMs}`);
			} catch {
				// continue
			}
		}

		return parts.join('|');
	}

	private async resolveStateDbPath(): Promise<string | null> {
		for (const candidate of this.getStateDbCandidates()) {
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
				return candidate;
			} catch {
				// continue
			}
		}
		return null;
	}

	private getStateDbCandidates(): string[] {
		const candidates: string[] = [];
		const globalStorageUriPath = this.context?.globalStorageUri?.fsPath;
		if (globalStorageUriPath) {
			candidates.push(path.join(globalStorageUriPath, '..', 'state.vscdb'));
		}

		const home = os.homedir();
		if (process.platform === 'linux') {
			candidates.push(
				path.join(home, '.config', 'Code', 'User', 'globalStorage', 'state.vscdb'),
				path.join(home, '.config', 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb'),
				path.join(home, '.config', 'VSCodium', 'User', 'globalStorage', 'state.vscdb'),
			);
		} else if (process.platform === 'darwin') {
			candidates.push(
				path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb'),
				path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb'),
				path.join(home, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage', 'state.vscdb'),
			);
		} else if (process.platform === 'win32') {
			const appData = process.env.APPDATA || '';
			candidates.push(
				path.join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb'),
				path.join(appData, 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb'),
				path.join(appData, 'VSCodium', 'User', 'globalStorage', 'state.vscdb'),
			);
		}

		return Array.from(new Set(candidates.filter(Boolean)));
	}

	private resolveSqliteBinaryPath(): string | null {
		if (this.sqliteBinaryPath !== undefined) {
			return this.sqliteBinaryPath;
		}

		const candidates = process.platform === 'win32'
			? [
				process.env.PROMPT_MANAGER_SQLITE3_PATH || '',
				path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sqlite3.exe'),
				'C:\\sqlite3\\sqlite3.exe',
				'C:\\Program Files\\SQLite\\sqlite3.exe',
				'C:\\Program Files (x86)\\SQLite\\sqlite3.exe',
				'sqlite3.exe',
			]
			: [
				process.env.PROMPT_MANAGER_SQLITE3_PATH || '',
				'/usr/bin/sqlite3',
				'/bin/sqlite3',
				'/usr/local/bin/sqlite3',
				'/opt/homebrew/bin/sqlite3',
				'sqlite3',
			];

		for (const candidate of candidates) {
			if (!candidate) {
				continue;
			}
			if (candidate.includes(path.sep) && !fs.existsSync(candidate)) {
				continue;
			}

			this.sqliteBinaryPath = candidate;
			return candidate;
		}

		this.sqliteBinaryPath = null;
		return null;
	}

	private escapeSql(value: string): string {
		return value.replace(/'/g, "''");
	}

	private async buildCopilotModelLookup(
		dbPath: string,
		models: vscode.LanguageModelChat[],
	): Promise<Map<string, AvailableModelOption>> {
		const lookup = new Map<string, AvailableModelOption>();
		const register = (key: string, option: AvailableModelOption): void => {
			const normalizedKey = key.trim().toLowerCase();
			if (!normalizedKey || lookup.has(normalizedKey)) {
				return;
			}
			lookup.set(normalizedKey, option);
		};

		for (const model of models) {
			const id = this.getPreferredModelOptionId(model.id, String((model as any).identifier || ''));
			if (!id || this.isAutoModelIdentifier(id)) {
				continue;
			}

			const option: AvailableModelOption = {
				id,
				name: (model.name || '').trim() || model.family || model.id,
			};
			register(id, option);
			register(model.id || '', option);
			register(String((model as any).identifier || ''), option);
			register(`copilot/${model.id || ''}`, option);
			register(`copilot/${model.family || ''}`, option);
		}

		const registerCachedEntries = (entries: CachedLanguageModelEntry[] | null): void => {
			for (const entry of entries || []) {
				const metadata = entry.metadata;
				if (!metadata || metadata.targetChatSessionType) {
					continue;
				}

				const vendor = String(metadata.vendor || '').trim().toLowerCase();
				const identifier = String(entry.identifier || '').trim();
				if (vendor !== 'copilot' && !identifier.toLowerCase().startsWith('copilot/')) {
					continue;
				}

				const optionId = this.getPreferredModelOptionId(metadata.id || '', identifier);
				if (!optionId || this.isAutoModelIdentifier(optionId)) {
					continue;
				}

				const option: AvailableModelOption = {
					id: optionId,
					name: String(metadata.name || '').trim() || metadata.family || optionId,
				};
				register(optionId, option);
				register(metadata.id || '', option);
				register(identifier, option);
				register(`copilot/${metadata.id || ''}`, option);
				register(`copilot/${metadata.family || ''}`, option);
			}
		};

		const [cachedModelsRaw, legacyCachedModelsRaw] = await Promise.all([
			this.readStateItemValue(dbPath, 'chat.cachedLanguageModels.v2'),
			this.readStateItemValue(dbPath, 'chat.cachedLanguageModels'),
		]);

		registerCachedEntries(this.parseJson<CachedLanguageModelEntry[]>(cachedModelsRaw));
		registerCachedEntries(this.parseJson<CachedLanguageModelEntry[]>(legacyCachedModelsRaw));

		return lookup;
	}

	private resolveLookupModelOption(
		lookup: Map<string, AvailableModelOption>,
		modelIdOrIdentifier: string,
		nameOverride?: string,
	): AvailableModelOption | undefined {
		const raw = String(modelIdOrIdentifier || '').trim();
		if (!raw) {
			return undefined;
		}

		const keys = [
			raw,
			raw.toLowerCase(),
			this.normalizeModelInput(raw),
			`copilot/${this.normalizeModelInput(raw)}`,
		]
			.map(value => value.trim().toLowerCase())
			.filter(Boolean);

		for (const key of keys) {
			const option = lookup.get(key);
			if (!option) {
				continue;
			}
			return {
				id: option.id,
				name: (nameOverride || '').trim() || option.name,
			};
		}

		return undefined;
	}

	private async getVisibleCopilotModelsFromWorkspaceSessions(): Promise<AvailableModelOption[]> {
		const chatSessionsDir = this.getWorkspaceChatSessionsDir();
		if (!chatSessionsDir || !fs.existsSync(chatSessionsDir)) {
			return [];
		}

		try {
			const entries = fs.readdirSync(chatSessionsDir, { withFileTypes: true })
				.filter(entry => entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')))
				.map(entry => {
					const fullPath = path.join(chatSessionsDir, entry.name);
					return {
						fullPath,
						mtimeMs: fs.statSync(fullPath).mtimeMs,
					};
				})
				.sort((left, right) => right.mtimeMs - left.mtimeMs)
				.slice(0, 40);

			const namesById = new Map<string, string>();
			const idsInOrder: string[] = [];
			const seenIds = new Set<string>();
			const modelIdPattern = /"modelId":"(copilot\/[^"]+)"/g;
			const namedIdentifierPattern = /"identifier":"(copilot\/[^"]+)".{0,600}?"name":"([^"]+)"/gs;

			for (const entry of entries) {
				const text = fs.readFileSync(entry.fullPath, 'utf8');
				namedIdentifierPattern.lastIndex = 0;
				modelIdPattern.lastIndex = 0;

				let namedMatch: RegExpExecArray | null;
				while ((namedMatch = namedIdentifierPattern.exec(text)) !== null) {
					const id = String(namedMatch[1] || '').trim();
					const name = String(namedMatch[2] || '').trim();
					if (!id || this.isAutoModelIdentifier(id)) {
						continue;
					}

					if (!seenIds.has(id.toLowerCase())) {
						idsInOrder.push(id);
						seenIds.add(id.toLowerCase());
					}
					if (name && !namesById.has(id)) {
						namesById.set(id, name);
					}
				}

				let idMatch: RegExpExecArray | null;
				while ((idMatch = modelIdPattern.exec(text)) !== null) {
					const id = String(idMatch[1] || '').trim();
					if (!id || this.isAutoModelIdentifier(id) || seenIds.has(id.toLowerCase())) {
						continue;
					}

					idsInOrder.push(id);
					seenIds.add(id.toLowerCase());
				}
			}

			return idsInOrder.map(id => ({
				id,
				name: namesById.get(id) || this.formatCopilotModelName(id),
			}));
		} catch {
			return [];
		}
	}

	private getWorkspaceChatSessionsDir(): string | null {
		const storageUriPath = this.context?.storageUri?.fsPath;
		if (!storageUriPath) {
			return null;
		}

		return path.join(storageUriPath, '..', 'chatSessions');
	}

	private formatCopilotModelName(modelId: string): string {
		const normalized = this.normalizeModelInput(modelId);
		if (!normalized) {
			return modelId;
		}

		if (normalized.startsWith('gpt-')) {
			return normalized
				.replace(/^gpt-/, 'GPT-')
				.replace(/-codex/gi, '-Codex')
				.replace(/-mini/gi, ' mini')
				.replace(/-max/gi, '-Max')
				.replace(/-fast/gi, ' fast')
				.replace(/-preview/gi, ' (Preview)');
		}

		return normalized
			.split(/[-._]/g)
			.filter(Boolean)
			.map(part => {
				const upper = part.toUpperCase();
				if (part.length <= 3 && /\d/.test(part)) {
					return upper;
				}
				if (part === 'gpt') {
					return 'GPT';
				}
				if (part === 'claude') {
					return 'Claude';
				}
				if (part === 'gemini') {
					return 'Gemini';
				}
				if (part === 'grok') {
					return 'Grok';
				}
				if (part === 'codex') {
					return 'Codex';
				}
				return part.charAt(0).toUpperCase() + part.slice(1);
			})
			.join(' ');
	}

	/** Generate inline suggestion / continuation for prompt text */
	async generateSuggestion(textBefore: string, globalContext?: string): Promise<string> {
		const systemPrompt = 'You are an AI assistant that continues writing a prompt. Given the text written so far, generate a natural continuation (1-3 sentences or a code block). Respond with ONLY the continuation text, nothing else. Match the language and style of the input.';
		const contextBlock = (globalContext || '').trim()
			? `Global agent context:\n${(globalContext || '').trim().slice(0, 1500)}\n\n`
			: '';
		const userPrompt = `${contextBlock}Continue this prompt text:\n\n${textBefore.slice(-1500)}`;
		return this.chat(systemPrompt, userPrompt, '', 'inline-suggestion', 'AiService.generateSuggestion');
	}

	/** Generate multiple suggestion variants for prompt text */
	async generateSuggestionVariants(textBefore: string, count: number = 3, globalContext?: string): Promise<string[]> {
		const systemPrompt = `You are an AI assistant that continues writing a prompt. Given the text written so far, generate ${count} DIFFERENT natural continuations (each 1-3 sentences). Return a JSON array of strings. Example: ["continuation 1", "continuation 2", "continuation 3"]. Return ONLY the JSON array, nothing else. Match the language and style of the input.`;
		const contextBlock = (globalContext || '').trim()
			? `Global agent context:\n${(globalContext || '').trim().slice(0, 1500)}\n\n`
			: '';
		const userPrompt = `${contextBlock}Continue this prompt text (${count} variants):\n\n${textBefore.slice(-1500)}`;
		const result = await this.chat(systemPrompt, userPrompt, '[]', 'inline-suggestion-variants', 'AiService.generateSuggestionVariants');
		try {
			const parsed = JSON.parse(result);
			if (Array.isArray(parsed) && parsed.length > 0) {
				return parsed.filter((s: unknown) => typeof s === 'string' && s.length > 0);
			}
		} catch {
			// If parsing fails, return a single-element array from the raw result
			if (result && result !== '[]') {
				return [result];
			}
		}
		return [];
	}

	/** Build robust argument variants for chat model switching commands */
	async getModelCommandArgs(modelId: string): Promise<unknown[]> {
		if (!modelId) {
			return [];
		}

		const normalizedInput = this.normalizeModelInput(modelId);
		const args: unknown[] = [
			modelId,
			normalizedInput,
			{ id: modelId },
			{ id: normalizedInput },
			{ model: modelId },
			{ model: normalizedInput },
			{ modelId },
			{ modelId: normalizedInput },
		];

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			const matched = this.findBestModelMatch(models, modelId);

			if (matched) {
				args.push(matched.id);
				args.push(matched.family);
				args.push(`${matched.vendor}/${matched.family}`);
				args.push((matched as any).identifier);
				args.push({
					id: matched.id,
					vendor: matched.vendor,
					family: matched.family,
					version: (matched as any).version,
					identifier: (matched as any).identifier,
				});
			}
		} catch {
			// ignore, base variants are enough
		}

		const seen = new Set<string>();
		return args.filter(a => {
			const key = JSON.stringify(a);
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
	}

	/** Resolve model alias suitable for slash-command fallback (/model ...) */
	async resolveModelAlias(modelId: string): Promise<string> {
		if (!modelId) {
			return '';
		}

		const normalizedInput = this.normalizeModelInput(modelId);

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			const matched = this.findBestModelMatch(models, modelId);
			if (matched) {
				return matched.family || modelId;
			}
		} catch {
			// ignore and fallback to original id
		}

		return normalizedInput || modelId;
	}

	/** Resolve ordered string candidates for /model command */
	async getModelSlashCandidates(modelId: string): Promise<string[]> {
		const candidates: string[] = [];
		if (!modelId) {
			return candidates;
		}

		candidates.push(modelId);
		const normalizedInput = this.normalizeModelInput(modelId);
		if (normalizedInput) {
			candidates.push(normalizedInput);
		}

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			const matched = this.findBestModelMatch(models, modelId);
			if (matched) {
				candidates.unshift(matched.id);
				if ((matched as any).identifier) {
					candidates.push(String((matched as any).identifier));
				}
				if (matched.family) {
					candidates.push(matched.family);
				}
			}
		} catch {
			// keep base candidates
		}

		const seen = new Set<string>();
		return candidates
			.map(c => c.trim())
			.filter(Boolean)
			.filter(c => {
				const key = c.toLowerCase();
				if (seen.has(key)) {
					return false;
				}
				seen.add(key);
				return true;
			});
	}

	/** Resolve chat open model selector for workbench.action.chat.open */
	async resolveChatOpenModelSelector(modelId: string): Promise<vscode.LanguageModelChatSelector | undefined> {
		if (!modelId) {
			return undefined;
		}

		const normalizedInput = this.normalizeModelInput(modelId);

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			const matched = this.findBestModelMatch(models, modelId);
			if (matched) {
				const selector: vscode.LanguageModelChatSelector = {
					vendor: matched.vendor,
					id: matched.id,
				};

				if (matched.family) {
					selector.family = matched.family;
				}

				if ((matched as any).version) {
					selector.version = (matched as any).version;
				}

				return selector;
			}
		} catch {
			// ignore and fallback
		}

		return {
			vendor: 'copilot',
			id: normalizedInput,
		};
	}

	/** Resolve whether requested model exists in current Copilot environment */
	async resolveModelAvailability(modelId: string): Promise<{ matched: boolean; matchedId?: string; matchedFamily?: string }> {
		if (!modelId) {
			return { matched: false };
		}
		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			const matched = this.findBestModelMatch(models, modelId);
			if (matched) {
				return {
					matched: true,
					matchedId: matched.id,
					matchedFamily: matched.family,
				};
			}
		} catch {
			// ignore
		}

		const cachedModels = await this.getVisibleCopilotModels([]);
		const cachedMatch = this.findBestAvailableModelMatch(cachedModels, modelId);
		if (cachedMatch) {
			const normalized = this.normalizeModelInput(cachedMatch.id) || cachedMatch.id;
			return {
				matched: true,
				matchedId: normalized,
				matchedFamily: normalized,
			};
		}

		return { matched: false };
	}

	async resolveModelStorageIdentifier(modelId: string): Promise<string> {
		if (!modelId) {
			return '';
		}

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			const matched = this.findBestModelMatch(models, modelId);
			if (matched) {
				const identifier = String((matched as any).identifier || '').trim();
				if (identifier) {
					return identifier;
				}
				if (matched.vendor && matched.family) {
					return `${matched.vendor}/${matched.family}`;
				}
				return matched.id;
			}
		} catch {
			// ignore and fallback
		}

		const normalized = this.normalizeModelInput(modelId);
		if (!normalized) {
			return modelId;
		}
		if (normalized.includes('/')) {
			return normalized;
		}
		return `copilot/${normalized}`;
	}

	/**
	 * Safely apply chat model through known commands.
	 * Does not touch VS Code storage directly.
	 */
	async tryApplyChatModelSafely(modelId: string): Promise<ChatModelApplyResult> {
		const requestedModel = modelId;
		if (!modelId) {
			return {
				status: 'model-not-found',
				applied: false,
				requestedModel,
			};
		}

		const availability = await this.resolveModelAvailability(modelId);
		if (!availability.matched) {
			return {
				status: 'model-not-found',
				applied: false,
				requestedModel,
			};
		}

		const commands = await vscode.commands.getCommands(true);
		const modelCmds = [
			'workbench.action.chat.setModel',
			'github.copilot.chat.setModel',
			'workbench.action.chat.selectModel',
		].filter(c => commands.includes(c));

		if (modelCmds.length === 0) {
			return {
				status: 'command-not-found',
				applied: false,
				requestedModel,
				resolvedModelId: availability.matchedId,
				resolvedModelFamily: availability.matchedFamily,
			};
		}

		const modelArgs = await this.getModelCommandArgs(availability.matchedId || modelId);
		for (const cmd of modelCmds) {
			for (const arg of modelArgs) {
				try {
					await vscode.commands.executeCommand(cmd, arg);
					return {
						status: 'applied',
						applied: true,
						requestedModel,
						resolvedModelId: availability.matchedId,
						resolvedModelFamily: availability.matchedFamily,
						usedCommand: cmd,
						usedArg: arg,
					};
				} catch {
					// try next argument/command
				}
			}
		}

		return {
			status: 'command-failed',
			applied: false,
			requestedModel,
			resolvedModelId: availability.matchedId,
			resolvedModelFamily: availability.matchedFamily,
		};
	}

	private normalizeModelInput(raw: string): string {
		const value = (raw || '').trim();
		if (!value) {
			return '';
		}

		const lower = value.toLowerCase();
		const withoutParens = lower.replace(/\([^)]*\)/g, ' ').trim();
		const compact = withoutParens.replace(/\s+/g, ' ');

		const explicitPattern = /(gpt-[\w.-]+|o[1-9][\w.-]*|claude-[\w.-]+|gemini-[\w.-]+)/i;
		const explicitMatch = value.match(explicitPattern) || withoutParens.match(explicitPattern);
		if (explicitMatch?.[1]) {
			return explicitMatch[1].toLowerCase();
		}

		if (compact.includes('/')) {
			const parts = compact.split('/').filter(Boolean);
			return parts[parts.length - 1].trim();
		}

		return compact;
	}

	private getPreferredModelOptionId(rawId: string, rawIdentifier?: string): string {
		const identifier = String(rawIdentifier || '').trim();
		if (identifier.toLowerCase().startsWith('copilot/')) {
			return identifier;
		}
		return String(rawId || '').trim() || identifier;
	}

	private isAutoModelIdentifier(value: string): boolean {
		return this.normalizeModelInput(value) === 'auto';
	}

	private isVisibleCopilotCacheEntry(entry: CachedLanguageModelEntry): boolean {
		const metadata = entry.metadata;
		if (!metadata || metadata.isUserSelectable !== true || metadata.targetChatSessionType) {
			return false;
		}

		const vendor = String(metadata.vendor || '').trim().toLowerCase();
		const identifier = String(entry.identifier || '').trim().toLowerCase();
		return vendor === 'copilot' || identifier.startsWith('copilot/');
	}

	private normalizeVisibleModelName(name: string): string {
		return String(name || '').trim().toLowerCase();
	}

	private shouldPreferVisibleModelOption(next: AvailableModelOption, current: AvailableModelOption): boolean {
		const nextIsCanonical = this.isCanonicalCopilotModelIdentifier(next.id);
		const currentIsCanonical = this.isCanonicalCopilotModelIdentifier(current.id);
		if (nextIsCanonical !== currentIsCanonical) {
			return nextIsCanonical;
		}

		const nextId = String(next.id || '').trim().toLowerCase();
		const currentId = String(current.id || '').trim().toLowerCase();
		const nextIsAlias = nextId.startsWith('copilot/copilot-');
		const currentIsAlias = currentId.startsWith('copilot/copilot-');
		if (nextIsAlias !== currentIsAlias) {
			return !nextIsAlias;
		}

		return nextId.length > currentId.length;
	}

	private isCanonicalCopilotModelIdentifier(value: string): boolean {
		return /^(gpt-[\w.-]+|o[1-9][\w.-]*|claude-[\w.-]+|gemini-[\w.-]+|grok-[\w.-]+)/i.test(
			this.normalizeModelInput(value),
		);
	}

	private findBestAvailableModelMatch(models: AvailableModelOption[], modelInput: string): AvailableModelOption | undefined {
		const raw = (modelInput || '').trim();
		const normalized = this.normalizeModelInput(raw);
		const candidates = [raw, normalized]
			.map(value => value.trim().toLowerCase())
			.filter(Boolean);

		const exact = models.find(model => {
			const id = (model.id || '').trim().toLowerCase();
			const normalizedId = this.normalizeModelInput(model.id || '').toLowerCase();
			return candidates.some(candidate => candidate === id || candidate === normalizedId);
		});
		if (exact) {
			return exact;
		}

		return models.find(model => {
			const text = [model.id, this.normalizeModelInput(model.id || ''), model.name]
				.filter(Boolean)
				.join(' ')
				.toLowerCase();
			return candidates.some(candidate => text.includes(candidate));
		});
	}

	private findBestModelMatch(models: vscode.LanguageModelChat[], modelInput: string): vscode.LanguageModelChat | undefined {
		const raw = (modelInput || '').trim();
		const normalized = this.normalizeModelInput(raw);
		const candidates = [raw, normalized]
			.map(v => v.trim().toLowerCase())
			.filter(Boolean);

		const exact = models.find(m => {
			const id = (m.id || '').toLowerCase();
			const identifier = String((m as any).identifier || '').toLowerCase();
			const family = (m.family || '').toLowerCase();
			const vendorFamily = `${(m.vendor || '').toLowerCase()}/${family}`;
			return candidates.some(c => c === id || c === identifier || c === family || c === vendorFamily);
		});
		if (exact) {
			return exact;
		}

		return models.find(m => {
			const text = [m.id, (m as any).identifier, m.family, `${m.vendor}/${m.family}`]
				.filter(Boolean)
				.join(' ')
				.toLowerCase();
			return candidates.some(c => text.includes(c));
		});
	}
}
