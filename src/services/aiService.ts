/**
 * AI Service — generates titles, descriptions and slugs using VS Code Language Model API
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DEFAULT_COPILOT_MODEL_FAMILY, isCopilotModelIdentifier, isZeroCostCopilotModelPickerCategory, normalizeCopilotModelFamily, normalizeOptionalCopilotModelFamily } from '../constants/ai.js';
import { getPromptManagerOutputChannel } from '../utils/promptManagerOutput.js';
import { appendPromptAiLog } from '../utils/promptAiLogger.js';
import { buildDescriptionGenerationUserPrompt, buildPromptFieldLanguageRule, buildTitleGenerationUserPrompt } from '../utils/aiPromptBuilders.js';
import { normalizeCommitMessageGenerationInstructions } from '../utils/gitOverlay.js';
import { readSqliteItemValue } from '../utils/sqliteItemTable.js';
import type { PromptDashboardProjectSummary } from '../types/promptDashboard.js';
import { areInternalAiFeaturesEnabled } from './aiSettingsConfig.js';

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

type ChatModelVisibilityState = {
	hiddenModels?: string[];
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

type CachedSelectedModelEntry = {
	model: vscode.LanguageModelChat;
	expiresAtMs: number;
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
	/** Reuse the selected chat model briefly to avoid repeated selector latency on bursty requests. */
	private static readonly SELECTED_MODEL_CACHE_TTL_MS = 60_000;
	private static readonly DEFAULT_IMPROVE_PROMPT_INSTRUCTIONS = [
		// 'Пиши на русском языке.',
		'Пиши ответ с обращением к одному лицу.',
	];

	constructor(private readonly context?: vscode.ExtensionContext) { }
	private sqliteBinaryPath: string | null | undefined;
	private resolvedStateDbPath: string | null | undefined;
	private readonly stateDbItemCache = new Map<string, { fingerprint: string; items: Map<string, string> }>();
	private readonly selectedModelCache = new Map<string, CachedSelectedModelEntry>();
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
			'### Что происходит',
			'Пока недостаточно данных, чтобы уверенно оценить состояние веток и проверок.',
			'### На что обратить внимание',
			'- Проверьте локальные изменения, pipeline и MR/PR вручную.',
			'### Что сделать дальше',
			'- Обновите dashboard и повторите AI review после загрузки Git-данных.',
		].join('\n');

		const systemPrompt = [
			'Ты анализируешь состояние параллельных веток, pipeline и merge requests в редакторе задач.',
			'Пиши на русском языке, коротко, понятно для обычного пользователя и без внутреннего жаргона.',
			'Используй только переданные данные, ничего не выдумывай.',
			'Объясняй не команды Git, а пользовательский смысл: можно продолжать, что мешает, что проверить.',
			'Сфокусируйся на конфликтах, сломанных проверках, незавершенных MR/PR и безопасном порядке действий.',
			'Верни Markdown с разделами: ### Что происходит, ### На что обратить внимание, ### Что сделать дальше.',
		].join(' ');

		const projectSummary = input.projects.map(project => {
			const pipelineChecks = project.pipeline?.checks || [];
			const failingChecks = pipelineChecks
				.filter(check => ['failed', 'error', 'cancelled'].includes(String(check.state || '').toLowerCase()))
				.slice(0, 5)
				.map(check => check.name);
			const runningChecks = pipelineChecks
				.filter(check => ['pending', 'queued', 'running', 'in_progress'].includes(String(check.state || '').toLowerCase()))
				.slice(0, 5)
				.map(check => check.name);

			return {
				project: project.project,
				currentBranch: project.currentBranch,
				promptBranch: project.promptBranch,
				trackedBranch: project.trackedBranch,
				dirty: project.dirty,
				hasConflicts: project.hasConflicts,
				conflictFileCount: project.conflictFiles.length,
				conflictFiles: project.conflictFiles.slice(0, 5),
				ahead: project.ahead,
				behind: project.behind,
				recentCommits: project.recentCommits.slice(0, 2).map(commit => ({
					sha: commit.shortSha,
					subject: commit.subject,
					changedFileCount: commit.changedFiles.length,
					topFiles: commit.changedFiles.slice(0, 4).map(file => this.formatPromptDashboardAiFileSummary(file)),
				})),
				review: {
					provider: project.review.remote?.provider || null,
					requestState: project.review.request?.state || null,
					unsupportedReason: project.review.unsupportedReason || null,
					error: project.review.error || '',
				},
				pipeline: project.pipeline ? {
					provider: project.pipeline.provider,
					state: project.pipeline.state,
					totalChecks: pipelineChecks.length,
					failingChecks,
					runningChecks,
					error: project.pipeline.error,
				} : null,
				parallelBranches: project.parallelBranches.slice(0, 3).map(branch => ({
					name: branch.name,
					ahead: branch.ahead,
					behind: branch.behind,
					affectedFileCount: branch.affectedFiles.length,
					topFiles: branch.affectedFiles.slice(0, 4).map(file => this.formatPromptDashboardAiFileSummary(file)),
					conflictCount: branch.potentialConflicts.length,
					topConflicts: branch.potentialConflicts.slice(0, 5).map(item => item.path),
				})),
			};
		});

		const userPrompt = [
			`Задача: ${input.promptTitle || 'Без названия'}`,
			input.promptContent.trim() ? `Текст промпта:\n${input.promptContent.trim().slice(0, 4000)}` : '',
			`Данные dashboard (сжатая выжимка):\n${JSON.stringify(projectSummary, null, 2).slice(0, 12000)}`,
		].filter(Boolean).join('\n\n');

		return this.chat(systemPrompt, userPrompt, fallback, 'prompt-dashboard-review', 'AiService.analyzePromptDashboardReview');
	}

	private formatPromptDashboardAiFileSummary(file: {
		status: string;
		path: string;
		previousPath?: string;
		additions?: number | null;
		deletions?: number | null;
		isBinary?: boolean;
	}): string {
		const rename = file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path;
		const binarySuffix = file.isBinary === true ? ' (bin)' : '';
		const statsSuffix = typeof file.additions === 'number' && typeof file.deletions === 'number'
			? ` (+${file.additions}/-${file.deletions})`
			: '';
		return `${file.status} ${rename}${statsSuffix}${binarySuffix}`;
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

		const modelSelector = await this.resolveAiRequestModelSelector(modelFamily || this.modelSelector.family);
		if (!modelSelector) {
			return fallback;
		}
		return this.chatWithSelector(
			modelSelector,
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

		const modelSelector = await this.resolveAiRequestModelSelector(modelFamily || this.modelSelector.family);
		if (!modelSelector) {
			return fallback;
		}
		return this.chatWithSelector(
			modelSelector,
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

		const modelSelector = await this.resolveAiRequestModelSelector(modelFamily || this.modelSelector.family);
		if (!modelSelector) {
			return fallback;
		}
		return this.chatWithSelector(
			modelSelector,
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

		const modelSelector = await this.resolveAiRequestModelSelector(modelFamily || this.modelSelector.family);
		if (!modelSelector) {
			return fallback;
		}
		return this.chatWithSelector(
			modelSelector,
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
		/** Skip internal AI flows early when the extension-level AI toggle is disabled. */
		if (!areInternalAiFeaturesEnabled()) {
			this.logAiRequest(`label=${requestLabel} result=disabled-by-setting selector="${this.formatSelectorForLog(selector)}"`);
			return fallback;
		}
		const selectorCacheKey = this.getSelectorCacheKey(selector);
		try {
			const allowFreeCopilotFallback = options?.allowFreeCopilotFallback ?? true;
			const cachedModel = this.getCachedSelectedModel(selector);
			if (cachedModel) {
				this.logAiRequest(`label=${requestLabel} result=model-cache-hit selector="${this.formatSelectorForLog(selector)}" model="${this.formatModelForLog(cachedModel)}"`);
				return this.chatWithModel(cachedModel, systemPrompt, userPrompt, fallback, requestLabel, selector, callerMethod);
			}
			const [model] = await vscode.lm.selectChatModels(selector);
			if (!model) {
				this.selectedModelCache.delete(selectorCacheKey);
				if (!allowFreeCopilotFallback) {
					this.logAiRequest(`label=${requestLabel} result=no-model selector="${this.formatSelectorForLog(selector)}" fallback=disabled`);
					return fallback;
				}

				const fallbackModel = await this.selectFreeFallbackModel(selector);
				if (!fallbackModel) {
					this.logAiRequest(`label=${requestLabel} result=no-free-model selector="${this.formatSelectorForLog(selector)}" fallback=free-only`);
					return fallback;
				}
				this.setCachedSelectedModel(selector, fallbackModel);
				this.logAiRequest(`label=${requestLabel} result=free-fallback selector="${this.formatSelectorForLog(selector)}" model="${this.formatModelForLog(fallbackModel)}"`);
				return this.chatWithModel(fallbackModel, systemPrompt, userPrompt, fallback, requestLabel, selector, callerMethod);
			}
			this.setCachedSelectedModel(selector, model);
			return this.chatWithModel(model, systemPrompt, userPrompt, fallback, requestLabel, selector, callerMethod);
		} catch (err) {
			this.selectedModelCache.delete(selectorCacheKey);
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
			this.logAiRequest(`label=${requestLabel} result=send-request selector="${this.formatSelectorForLog(selector)}" model="${this.formatModelForLog(model)}" systemChars=${systemPrompt.length} userChars=${userPrompt.length}`);
			void appendPromptAiLog({
				kind: 'ai',
				prompt: `SYSTEM: ${systemPrompt}\nUSER: ${userPrompt}`,
				callerMethod,
				model: this.getModelNameForPromptLog(model),
			}).catch(() => undefined);
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
			this.selectedModelCache.delete(this.getSelectorCacheKey(selector));
			const message = err instanceof Error ? err.message : String(err);
			this.logAiRequest(`label=${requestLabel} result=send-error selector="${this.formatSelectorForLog(selector)}" model="${this.formatModelForLog(model)}" error="${message}"`);
			return fallback;
		}
	}

	private getSelectorCacheKey(selector: vscode.LanguageModelChatSelector): string {
		/** Build a stable cache key for short-lived selected-model reuse. */
		return JSON.stringify({
			vendor: selector.vendor || '',
			id: selector.id || '',
			family: selector.family || '',
			version: selector.version || '',
		});
	}

	private getCachedSelectedModel(selector: vscode.LanguageModelChatSelector): vscode.LanguageModelChat | null {
		/** Drop expired model entries before they can add stale-selector failures. */
		const cacheKey = this.getSelectorCacheKey(selector);
		const cached = this.selectedModelCache.get(cacheKey);
		if (!cached) {
			return null;
		}
		if (cached.expiresAtMs <= Date.now()) {
			this.selectedModelCache.delete(cacheKey);
			return null;
		}
		return cached.model;
	}

	private setCachedSelectedModel(selector: vscode.LanguageModelChatSelector, model: vscode.LanguageModelChat): void {
		/** Keep the most recent selected model only for a short burst window. */
		this.selectedModelCache.set(this.getSelectorCacheKey(selector), {
			model,
			expiresAtMs: Date.now() + AiService.SELECTED_MODEL_CACHE_TTL_MS,
		});
	}

	/** Reset Copilot model caches after an account or catalog change. */
	clearCopilotModelCaches(): void {
		this.selectedModelCache.clear();
		this.stateDbItemCache.clear();
		this.resolvedStateDbPath = undefined;
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
		const models = await this.selectUserFacingChatModels();
		const dbPath = await this.resolveStateDbPath();
		const hiddenModelIds = dbPath
			? await this.getHiddenUserFacingModelIds(dbPath)
			: new Set<string>();
		const modelLookup = dbPath
			? await this.buildUserFacingModelLookup(dbPath)
			: new Map<string, AvailableModelOption>();
		const sessionScopedModelKeys = dbPath
			? await this.getSessionScopedModelKeys(dbPath)
			: new Set<string>();
		const cachedCopilotModels = dbPath
			? await this.getCachedCopilotUserFacingModels(dbPath, models)
			: [];
		const cachedNonCopilotModels = dbPath
			? await this.getCachedNonCopilotUserFacingModels(dbPath, hiddenModelIds)
			: [];
		const controlCopilotModels = dbPath
			? await this.getAllVisibleCopilotModelsFromControl(dbPath, models)
			: [];

		const liveModels = this.normalizeAvailableModels(models
			.filter(model => !this.isSessionScopedLanguageModel(sessionScopedModelKeys, model))
			.map(model => ({
				model,
				option: this.resolveUserFacingLanguageModelOption(model, modelLookup),
			}))
			.filter(({ model, option }) => this.isCopilotLanguageModel(model) || !this.isHiddenUserFacingLanguageModel(hiddenModelIds, model, option.id))
			.map(({ option }) => option));

		const userFacingModels = this.mergeAvailableModelOptions([
			...controlCopilotModels,
			...liveModels,
			...cachedCopilotModels,
			...cachedNonCopilotModels,
		]);
		if (dbPath) {
			return await this.getCuratedUserFacingModels(dbPath, userFacingModels);
		}

		return userFacingModels;
	}

	/** Get available GitHub Copilot Chat model families for internal AI settings. */
	async getAvailableCopilotModelFamilies(): Promise<AvailableModelOption[]> {
		const models = await this.getAvailableModels();
		return this.normalizeAvailableModels(models.map(model => ({
			id: normalizeOptionalCopilotModelFamily(model.id),
			name: model.name,
		})));
	}

	/** Resolve a selected model against the full GitHub Copilot Chat catalog. */
	async resolveCopilotModelFamily(modelId: string | undefined | null): Promise<string> {
		const requested = String(modelId || '').trim();
		const normalizedRequested = normalizeOptionalCopilotModelFamily(requested);
		if (!normalizedRequested) {
			return '';
		}

		const models = await this.getAvailableCopilotModelFamilies();
		if (models.length === 0) {
			return normalizedRequested;
		}

		const matched = this.findBestAvailableModelMatch(models, requested)
			|| this.findBestAvailableModelMatch(models, normalizedRequested);
		return matched
			? normalizeOptionalCopilotModelFamily(matched.id)
			: '';
	}

	/** Resolve any user-facing Chat picker model to the stable identifier stored in settings. */
	async resolveAiRequestModelIdentifier(modelId: string | undefined | null): Promise<string> {
		const requested = String(modelId || '').trim();
		if (!requested) {
			return '';
		}

		const models = await this.getAvailableModels();
		if (models.length === 0) {
			return requested.includes('/') ? requested : normalizeOptionalCopilotModelFamily(requested);
		}

		const matched = this.findBestAvailableModelMatch(models, requested);
		return matched?.id || '';
	}

	private async resolveAiRequestModelSelector(modelId: string | undefined | null): Promise<vscode.LanguageModelChatSelector | undefined> {
		const resolvedId = await this.resolveAiRequestModelIdentifier(modelId);
		if (!resolvedId) {
			return undefined;
		}

		return this.resolveChatOpenModelSelector(resolvedId);
	}

	/**
	 * Build the set of `vendor/id` keys for models that are bound to a specific chat session
	 * type (`targetChatSessionType`). VS Code excludes these from the general model picker and
	 * only surfaces them inside a matching session, but the public `vscode.lm.selectChatModels()`
	 * API still returns them without exposing `targetChatSessionType`, so they must be filtered
	 * out using the cached metadata. Examples: `copilotcli/*`, `claude-code/*`.
	 */
	private async getSessionScopedModelKeys(dbPath: string): Promise<Set<string>> {
		const cachedModelsRaw = await this.readStateItemValue(dbPath, 'chat.cachedLanguageModels.v2');
		const cachedModels = this.parseJson<CachedLanguageModelEntry[]>(cachedModelsRaw);
		const keys = new Set<string>();

		for (const entry of cachedModels || []) {
			const metadata = entry.metadata;
			if (!metadata || !metadata.targetChatSessionType) {
				continue;
			}

			const vendor = String(metadata.vendor || '').trim().toLowerCase();
			const id = String(metadata.id || '').trim().toLowerCase();
			const identifier = String(entry.identifier || '').trim().toLowerCase();
			if (vendor && id) {
				keys.add(`${vendor}/${id}`);
			}
			if (identifier) {
				keys.add(identifier);
			}
		}

		return keys;
	}

	/** Skip live models that VS Code binds to a specific chat session type (not general picker). */
	private isSessionScopedLanguageModel(
		sessionScopedModelKeys: Set<string>,
		model: vscode.LanguageModelChat,
	): boolean {
		if (sessionScopedModelKeys.size === 0) {
			return false;
		}

		const vendor = String(model.vendor || '').trim().toLowerCase();
		const id = String(model.id || '').trim().toLowerCase();
		const family = String(model.family || '').trim().toLowerCase();
		const identifier = String((model as any).identifier || '').trim().toLowerCase();

		return (!!vendor && !!id && sessionScopedModelKeys.has(`${vendor}/${id}`))
			|| (!!vendor && !!family && sessionScopedModelKeys.has(`${vendor}/${family}`))
			|| (!!identifier && sessionScopedModelKeys.has(identifier));
	}

	/** Mirror the VS Code model picker placement in a flat prompt-page select list. */
	private async getCuratedUserFacingModels(
		dbPath: string,
		models: AvailableModelOption[],
	): Promise<AvailableModelOption[]> {
		const [pinnedRaw, recentRaw, controlRaw, copilotSkuRaw, currentRaw, currentLocalRaw] = await Promise.all([
			this.readStateItemValue(dbPath, 'chatModelPinned'),
			this.readStateItemValue(dbPath, 'chatModelRecentlyUsed'),
			this.readStateItemValue(dbPath, 'chat.modelsControl'),
			this.readStateItemValue(dbPath, 'extensionsAssignmentFilterProvider.copilotSku'),
			this.readStateItemValue(dbPath, 'chat.currentLanguageModel.chat'),
			this.readStateItemValue(dbPath, 'chat.currentLanguageModel.chat.local'),
		]);
		const lookup = this.buildAvailableModelOptionLookup(models);
		const result: AvailableModelOption[] = [];
		const seen = new Set<string>();
		const pinnedIds = this.parseStringArray(pinnedRaw);
		const recentIds = this.parseStringArray(recentRaw);
		const pinnedSet = new Set(pinnedIds.map(id => id.trim().toLowerCase()).filter(Boolean));
		const pushOption = (option: AvailableModelOption | undefined): void => {
			if (!option?.id || this.isAutoModelIdentifier(option.id)) {
				return;
			}

			const seenKeys = this.getModelPickerPlacementSeenKeys(option.id);
			if (seenKeys.length === 0 || seenKeys.some(key => seen.has(key))) {
				return;
			}

			seenKeys.forEach(key => seen.add(key));
			result.push(option);
		};
		const pushById = (id: string): void => pushOption(this.resolveAvailableModelOption(lookup, id));

		for (const id of pinnedIds) {
			pushById(id);
		}

		pushById(currentRaw);
		pushById(currentLocalRaw);

		for (const id of recentIds.filter(id => !pinnedSet.has(id.trim().toLowerCase())).slice(0, 3)) {
			pushById(id);
		}

		const modelsControl = this.parseJson<ChatModelsControl>(controlRaw);
		if (modelsControl) {
			for (const entry of this.getVisibleControlEntries(modelsControl, this.resolveCopilotTier(copilotSkuRaw))) {
				pushById(entry.id || '');
			}
		}

		for (const model of this.sortModelPickerOtherModels(models)) {
			pushOption(model);
		}

		return result.length > 0 ? result : this.normalizeAvailableModels(models);
	}

	/** Build placement keys matching VS Code picker duplicate suppression. */
	private getModelPickerPlacementSeenKeys(modelId: string): string[] {
		const raw = String(modelId || '').trim().toLowerCase();
		if (!raw) {
			return [];
		}

		const keys = [this.getModelOptionSeenKey(raw)];
		if (raw.startsWith('copilot/') || raw.startsWith('customendpoint/')) {
			keys.push(this.normalizeModelInput(raw));
		}

		return Array.from(new Set(keys.map(key => key.trim().toLowerCase()).filter(Boolean)));
	}

	/** Sort remaining Other Models in the same quiet alphabetical style as VS Code. */
	private sortModelPickerOtherModels(models: AvailableModelOption[]): AvailableModelOption[] {
		return [...models].sort((left, right) => {
			const leftVendor = this.getModelOptionVendorRank(left.id);
			const rightVendor = this.getModelOptionVendorRank(right.id);
			if (leftVendor !== rightVendor) {
				return leftVendor - rightVendor;
			}

			return left.name.localeCompare(right.name, 'ru', { sensitivity: 'base' });
		});
	}

	/** Keep Copilot Other Models before external providers, matching VS Code bucket order. */
	private getModelOptionVendorRank(modelId: string): number {
		return String(modelId || '').trim().toLowerCase().startsWith('copilot/') ? 0 : 1;
	}

	/** Read hidden user-facing model identifiers from the VS Code picker state. */
	private async getHiddenUserFacingModelIds(dbPath: string): Promise<Set<string>> {
		const raw = await this.readStateItemValue(dbPath, 'chatModelVisibility');
		const parsed = this.parseJson<ChatModelVisibilityState>(raw);
		const hidden = new Set<string>();

		for (const modelId of parsed?.hiddenModels || []) {
			this.addHiddenUserFacingModelVariants(hidden, modelId);
		}

		return hidden;
	}

	/** Index VS Code hidden model ids with and without provider labels. */
	private addHiddenUserFacingModelVariants(hiddenModelIds: Set<string>, modelId: string): void {
		const normalized = String(modelId || '').trim().toLowerCase();
		if (!normalized) {
			return;
		}

		this.addModelIdMatchKey(hiddenModelIds, normalized);
		const parts = this.splitModelIdentifierParts(normalized);
		if (parts.length < 2) {
			return;
		}

		const vendor = parts[0];
		const modelTail = parts[parts.length - 1];
		if (parts.length >= 3) {
			this.addModelIdMatchKey(hiddenModelIds, [vendor, ...parts.slice(2)].join('/'));
		}

		if (modelTail) {
			this.addModelIdMatchKey(hiddenModelIds, `${vendor}/${modelTail}`);
		}
	}

	/** Unify version separators so `claude-sonnet-4.6` matches VS Code's persisted `claude-sonnet-4-6`. */
	private normalizeModelIdSeparators(value: string): string {
		return String(value || '').trim().toLowerCase().replace(/[._]/g, '-');
	}

	/** Register a model id together with a separator-normalized variant for robust hidden matching. */
	private addModelIdMatchKey(target: Set<string>, value: string): void {
		const normalized = String(value || '').trim().toLowerCase();
		if (!normalized) {
			return;
		}

		target.add(normalized);
		const unified = this.normalizeModelIdSeparators(normalized);
		if (unified && unified !== normalized) {
			target.add(unified);
		}
	}

	/** Skip live models that the VS Code model picker currently marks as hidden. */
	private isHiddenUserFacingLanguageModel(
		hiddenModelIds: Set<string>,
		model: vscode.LanguageModelChat,
		resolvedIdentifier?: string,
	): boolean {
		if (hiddenModelIds.size === 0) {
			return false;
		}

		const candidates = new Set<string>();
		const vendor = String(model.vendor || '').trim().toLowerCase();
		this.addHiddenModelMatchCandidates(candidates, resolvedIdentifier || '', vendor);
		this.addHiddenModelMatchCandidates(candidates, model.id, vendor);
		this.addHiddenModelMatchCandidates(candidates, model.family, vendor);
		this.addHiddenModelMatchCandidates(candidates, String((model as any).identifier || ''), vendor);

		return this.hasHiddenModelMatch(hiddenModelIds, candidates);
	}

	/** Skip cached picker options that the VS Code model picker marks as hidden. */
	private isHiddenUserFacingModelOption(
		hiddenModelIds: Set<string>,
		model: AvailableModelOption,
		vendor?: string,
	): boolean {
		if (hiddenModelIds.size === 0) {
			return false;
		}

		const candidates = new Set<string>();
		this.addHiddenModelMatchCandidates(candidates, model.id, vendor);
		return this.hasHiddenModelMatch(hiddenModelIds, candidates);
	}

	/** Add comparable model ids for hidden-state matching. */
	private addHiddenModelMatchCandidates(candidates: Set<string>, rawValue: string, rawVendor?: string): void {
		const normalized = String(rawValue || '').trim().toLowerCase();
		if (!normalized) {
			return;
		}

		this.addModelIdMatchKey(candidates, normalized);
		const vendor = String(rawVendor || '').trim().toLowerCase();
		const parts = this.splitModelIdentifierParts(normalized);
		const normalizedInput = this.normalizeModelInput(normalized);

		if (!vendor) {
			return;
		}

		if (parts[0] === vendor) {
			if (parts.length >= 3) {
				this.addModelIdMatchKey(candidates, [vendor, ...parts.slice(2)].join('/'));
			}

			const modelTail = parts[parts.length - 1];
			if (modelTail) {
				this.addModelIdMatchKey(candidates, `${vendor}/${modelTail}`);
			}
			return;
		}

		this.addModelIdMatchKey(candidates, `${vendor}/${normalized}`);
		if (normalizedInput) {
			this.addModelIdMatchKey(candidates, `${vendor}/${normalizedInput}`);
		}
	}

	/** Return true when any candidate is present in the hidden model index. */
	private hasHiddenModelMatch(hiddenModelIds: Set<string>, candidates: Set<string>): boolean {
		for (const candidate of candidates) {
			if (hiddenModelIds.has(candidate)) {
				return true;
			}
		}

		return false;
	}

	/** Split a model identifier into non-empty slash-delimited parts. */
	private splitModelIdentifierParts(value: string): string[] {
		return String(value || '')
			.trim()
			.toLowerCase()
			.split('/')
			.map(part => part.trim())
			.filter(Boolean);
	}

	/** Resolve a live API model to the full VS Code model identifier when possible. */
	private resolveUserFacingLanguageModelOption(
		model: vscode.LanguageModelChat,
		lookup: Map<string, AvailableModelOption>,
	): AvailableModelOption {
		const vendor = String(model.vendor || '').trim();
		const rawIdentifier = String((model as any).identifier || '').trim();
		const resolved = this.resolveUserFacingLookupOption(lookup, {
			vendor,
			id: model.id,
			family: model.family,
			name: model.name,
			identifier: rawIdentifier,
		});
		const id = resolved?.id || this.getPreferredModelOptionId(model.id, rawIdentifier);

		return {
			id,
			name: (model.name || '').trim() || resolved?.name || model.family || model.id || id,
		};
	}

	/** Upgrade cached or control options to full identifiers from the user-facing cache. */
	private resolveAvailableModelOptionIdentifier(
		option: AvailableModelOption,
		lookup: Map<string, AvailableModelOption>,
		vendor?: string,
	): AvailableModelOption {
		const resolved = this.resolveUserFacingLookupOption(lookup, {
			vendor,
			id: option.id,
			family: option.id,
			name: option.name,
			identifier: option.id,
		});
		if (!resolved || resolved.id === option.id) {
			return option;
		}

		return {
			id: resolved.id,
			name: option.name || resolved.name,
		};
	}

	/** Build a lookup from VS Code cached model ids to full user-facing identifiers. */
	private async buildUserFacingModelLookup(dbPath: string): Promise<Map<string, AvailableModelOption>> {
		const cachedModelsRaw = await this.readStateItemValue(dbPath, 'chat.cachedLanguageModels.v2');
		const cachedModels = this.parseJson<CachedLanguageModelEntry[]>(cachedModelsRaw);
		const lookup = new Map<string, AvailableModelOption>();

		for (const entry of cachedModels || []) {
			const metadata = entry.metadata;
			const identifier = String(entry.identifier || '').trim();
			if (!metadata || !identifier || metadata.isUserSelectable === false || metadata.targetChatSessionType) {
				continue;
			}

			const option: AvailableModelOption = {
				id: this.getPreferredModelOptionId(metadata.id || '', identifier),
				name: String(metadata.name || '').trim() || metadata.family || identifier,
			};
			for (const key of this.getUserFacingModelLookupKeys({
				vendor: metadata.vendor,
				id: metadata.id,
				family: metadata.family,
				name: metadata.name,
				identifier,
			})) {
				this.registerUserFacingLookupOption(lookup, key, option);
			}
		}

		return lookup;
	}

	/** Use cache v2 as a fallback for visible non-Copilot providers missing from the public LM API. */
	private async getCachedNonCopilotUserFacingModels(
		dbPath: string,
		hiddenModelIds: Set<string>,
	): Promise<AvailableModelOption[]> {
		const cachedModelsRaw = await this.readStateItemValue(dbPath, 'chat.cachedLanguageModels.v2');
		const cachedModels = this.parseJson<CachedLanguageModelEntry[]>(cachedModelsRaw);
		const result: AvailableModelOption[] = [];
		const seenIds = new Set<string>();

		for (const entry of cachedModels || []) {
			if (!this.isUserFacingCacheEntry(entry) || this.isCopilotCacheEntry(entry)) {
				continue;
			}

			const metadata = entry.metadata!;
			const vendor = String(metadata.vendor || '').trim().toLowerCase();
			const id = this.getPreferredModelOptionId(metadata.id || '', entry.identifier);
			const option: AvailableModelOption = {
				id,
				name: String(metadata.name || '').trim() || metadata.family || id,
			};
			const seenKey = this.getModelOptionSeenKey(option.id);
			if (!option.id || this.isAutoModelIdentifier(option.id) || seenIds.has(seenKey)) {
				continue;
			}

			if (this.isHiddenUserFacingModelOption(hiddenModelIds, option, vendor)) {
				continue;
			}

			seenIds.add(seenKey);
			result.push(option);
		}

		return this.normalizeAvailableModels(result);
	}

	/** Build lookup keys for resolving pinned/recent/control ids to options. */
	private buildAvailableModelOptionLookup(models: AvailableModelOption[]): Map<string, AvailableModelOption> {
		const lookup = new Map<string, AvailableModelOption>();
		const register = (key: string, option: AvailableModelOption): void => {
			const normalized = String(key || '').trim().toLowerCase();
			if (normalized && !lookup.has(normalized)) {
				lookup.set(normalized, option);
			}
		};

		for (const option of models) {
			const id = String(option.id || '').trim();
			if (!id) {
				continue;
			}

			register(id, option);
			if (id.toLowerCase().startsWith('copilot/')) {
				const copilotId = id.slice('copilot/'.length);
				register(copilotId, option);
				register(this.normalizeModelInput(copilotId), option);
			}
		}

		return lookup;
	}

	/** Resolve one stored picker id to an available option. */
	private resolveAvailableModelOption(
		lookup: Map<string, AvailableModelOption>,
		id: string,
	): AvailableModelOption | undefined {
		const normalized = String(id || '').trim().toLowerCase();
		if (!normalized) {
			return undefined;
		}

		const keys = [
			normalized,
			this.normalizeModelInput(normalized),
			`copilot/${normalized}`,
			`copilot/${this.normalizeModelInput(normalized)}`,
		]
			.map(key => key.trim().toLowerCase())
			.filter(Boolean);

		for (const key of keys) {
			const option = lookup.get(key);
			if (option) {
				return option;
			}
		}

		return undefined;
	}

	/** Parse a persisted string array safely. */
	private parseStringArray(raw: string): string[] {
		const parsed = this.parseJson<unknown>(raw);
		return Array.isArray(parsed)
			? parsed.map(value => String(value || '').trim()).filter(Boolean)
			: [];
	}

	/** Resolve a cached full-identifier option by stable model fields. */
	private resolveUserFacingLookupOption(
		lookup: Map<string, AvailableModelOption>,
		input: { vendor?: string; id?: string; family?: string; name?: string; identifier?: string },
	): AvailableModelOption | undefined {
		for (const key of this.getUserFacingModelLookupKeys(input)) {
			const option = lookup.get(key);
			if (option) {
				return option;
			}
		}

		return undefined;
	}

	/** Create lookup keys that preserve provider identity before falling back to broad ids. */
	private getUserFacingModelLookupKeys(input: {
		vendor?: string;
		id?: string;
		family?: string;
		name?: string;
		identifier?: string;
	}): string[] {
		const vendor = String(input.vendor || '').trim().toLowerCase();
		const id = String(input.id || '').trim().toLowerCase();
		const family = String(input.family || '').trim().toLowerCase();
		const name = String(input.name || '').trim().toLowerCase();
		const identifier = String(input.identifier || '').trim().toLowerCase();
		const keys: string[] = [];
		const add = (value: string): void => {
			const normalized = value.trim().toLowerCase();
			if (normalized && !keys.includes(normalized)) {
				keys.push(normalized);
			}
		};

		add(identifier);
		if (vendor && id && name) {
			add(`${vendor}\u0000${id}\u0000${name}`);
		}
		if (vendor && family && name) {
			add(`${vendor}\u0000${family}\u0000${name}`);
		}
		if (vendor && name) {
			add(`${vendor}\u0000${name}`);
		}
		if (vendor && id) {
			add(`${vendor}/${id}`);
		}
		if (vendor && family) {
			add(`${vendor}/${family}`);
		}
		if (vendor === 'copilot') {
			add(id);
			add(family);
		}

		return keys;
	}

	/** Register a lookup option, preferring full identifiers over bare ids. */
	private registerUserFacingLookupOption(
		lookup: Map<string, AvailableModelOption>,
		key: string,
		option: AvailableModelOption,
	): void {
		const normalizedKey = key.trim().toLowerCase();
		if (!normalizedKey) {
			return;
		}

		const existing = lookup.get(normalizedKey);
		if (!existing || (option.id.includes('/') && !existing.id.includes('/'))) {
			lookup.set(normalizedKey, option);
		}
	}

	/** Return true for cache entries that can appear in a user-facing model picker. */
	private isUserFacingCacheEntry(entry: CachedLanguageModelEntry): boolean {
		const metadata = entry.metadata;
		if (!metadata || !String(entry.identifier || '').trim() || metadata.targetChatSessionType) {
			return false;
		}

		return metadata.isUserSelectable !== false;
	}

	/** Return true when a cached entry belongs to the Copilot provider. */
	private isCopilotCacheEntry(entry: CachedLanguageModelEntry): boolean {
		const metadata = entry.metadata;
		const vendor = String(metadata?.vendor || '').trim().toLowerCase();
		const identifier = String(entry.identifier || '').trim().toLowerCase();
		return vendor === 'copilot' || identifier.startsWith('copilot/');
	}

	/** Return true when a live Language Model API entry belongs to GitHub Copilot Chat. */
	private isCopilotLanguageModel(model: vscode.LanguageModelChat): boolean {
		const vendor = String(model.vendor || '').trim().toLowerCase();
		const identifier = String((model as any).identifier || '').trim().toLowerCase();
		return vendor === 'copilot' || identifier.startsWith('copilot/');
	}

	/** Read the full chat-model catalog that the prompt-page picker should expose. */
	private async selectUserFacingChatModels(): Promise<vscode.LanguageModelChat[]> {
		try {
			return await vscode.lm.selectChatModels();
		} catch {
			try {
				return await vscode.lm.selectChatModels({ vendor: 'copilot' });
			} catch {
				return [];
			}
		}
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
			const controlFreeModels = await this.getVisibleCopilotModelsFromControl(dbPath, models, 'free');
			if (controlFreeModels.length > 0) {
				return this.normalizeAvailableModels(controlFreeModels.map(option => ({
					id: normalizeCopilotModelFamily(option.id),
					name: option.name,
				})));
			}

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

		const controlModels = await this.getVisibleCopilotModelsFromControl(dbPath, models, 'current');
		if (controlModels.length > 0) {
			return controlModels;
		}

		const legacyCachedModels = await this.getVisibleCopilotModelsFromLegacyCache(dbPath);
		if (legacyCachedModels.length > 0) {
			return legacyCachedModels;
		}

		if (workspaceSessionModels.length > 0) {
			return workspaceSessionModels;
		}

		return [];
	}

	/** Build the current visible Copilot picker options from VS Code model control state. */
	private async getVisibleCopilotModelsFromControl(
		dbPath: string,
		models: vscode.LanguageModelChat[],
		mode: 'current' | 'free',
	): Promise<AvailableModelOption[]> {
		const [modelsControlRaw, modelPickerPreferencesRaw, copilotSkuRaw] = await Promise.all([
			this.readStateItemValue(dbPath, 'chat.modelsControl'),
			this.readStateItemValue(dbPath, 'chatModelPickerPreferences'),
			this.readStateItemValue(dbPath, 'extensionsAssignmentFilterProvider.copilotSku'),
		]);

		const modelsControl = this.parseJson<ChatModelsControl>(modelsControlRaw);
		if (!modelsControl) {
			return [];
		}

		const featuredEntries = mode === 'free'
			? Object.values(modelsControl.free || {}).filter(entry => Boolean(entry?.featured))
			: this.getVisibleControlEntries(modelsControl, this.resolveCopilotTier(copilotSkuRaw));
		if (featuredEntries.length === 0) {
			return [];
		}

		const preferences = mode === 'free'
			? {}
			: (this.parseJson<Record<string, boolean>>(modelPickerPreferencesRaw) || {});
		const extraVisibleIdentifiers = mode === 'free'
			? []
			: Object.entries(preferences)
				.filter(([identifier, isVisible]) => isVisible && identifier.toLowerCase().startsWith('copilot/'))
				.map(([identifier]) => identifier);
		const result = await this.buildModelOptionsFromControlEntries(dbPath, models, featuredEntries, extraVisibleIdentifiers);

		if (result.length === 0) {
			return [];
		}

		return this.sortVisibleModels(result, featuredEntries);
	}

	/** Build Copilot model options from both paid and free VS Code control groups. */
	private async getAllVisibleCopilotModelsFromControl(
		dbPath: string,
		models: vscode.LanguageModelChat[],
	): Promise<AvailableModelOption[]> {
		const [modelsControlRaw, modelPickerPreferencesRaw] = await Promise.all([
			this.readStateItemValue(dbPath, 'chat.modelsControl'),
			this.readStateItemValue(dbPath, 'chatModelPickerPreferences'),
		]);

		const modelsControl = this.parseJson<ChatModelsControl>(modelsControlRaw);
		if (!modelsControl) {
			return [];
		}

		const controlEntries = [
			...Object.values(modelsControl.paid || {}),
			...Object.values(modelsControl.free || {}),
		].filter(entry => Boolean(entry?.id));
		if (controlEntries.length === 0) {
			return [];
		}

		const preferences = this.parseJson<Record<string, boolean>>(modelPickerPreferencesRaw) || {};
		const extraVisibleIdentifiers = Object.entries(preferences)
			.filter(([identifier, isVisible]) => isVisible && identifier.toLowerCase().startsWith('copilot/'))
			.map(([identifier]) => identifier);
		const result = await this.buildModelOptionsFromControlEntries(
			dbPath,
			models,
			controlEntries,
			extraVisibleIdentifiers,
		);

		return result.length > 0 ? this.sortVisibleModels(result, controlEntries) : [];
	}

	/** Read cached GitHub Copilot Chat models as a fallback when live LM results lag behind. */
	private async getCachedCopilotUserFacingModels(
		dbPath: string,
		models: vscode.LanguageModelChat[],
	): Promise<AvailableModelOption[]> {
		const [cachedModels, legacyCachedModels] = await Promise.all([
			this.getVisibleCopilotModelsFromCache(dbPath, models),
			this.getVisibleCopilotModelsFromLegacyCache(dbPath),
		]);

		return this.normalizeAvailableModels([...cachedModels, ...legacyCachedModels]);
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
			const seenKey = this.getModelOptionSeenKey(id);
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
			const seenKey = this.getModelOptionSeenKey(id);
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

	/** Merge model option groups while preserving first-seen order and removing aliases. */
	private mergeAvailableModelOptions(...groups: AvailableModelOption[][]): AvailableModelOption[] {
		return this.normalizeAvailableModels(groups.flat());
	}

	private normalizeAvailableModels(models: AvailableModelOption[]): AvailableModelOption[] {
		const result: AvailableModelOption[] = [];
		const seen = new Set<string>();

		for (const model of models) {
			const id = String(model.id || '').trim();
			const seenKey = this.getModelOptionSeenKey(id);
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

			const seenKey = this.getModelOptionSeenKey(option.id);
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
			const { stdout } = await execFileAsync(sqlitePath, ['-readonly', dbPath, sql], { timeout: 4000 });
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
		if (this.resolvedStateDbPath !== undefined) {
			return this.resolvedStateDbPath;
		}

		const existing: string[] = [];
		for (const candidate of this.getStateDbCandidates()) {
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
				existing.push(candidate);
			} catch {
				// continue
			}
		}

		const chosen = await this.pickStateDbWithPickerState(existing);
		this.resolvedStateDbPath = chosen;
		return chosen;
	}

	/**
	 * Choose the `state.vscdb` that actually holds the chat model picker state.
	 *
	 * The chat model visibility lives in VS Code's PROFILE storage, so when several
	 * candidate databases exist (custom profiles, an Extension Development Host with a
	 * fresh user-data dir, etc.) the first existing file can be an empty database with no
	 * hidden-model state. Returning that empty database would silently disable hidden
	 * filtering and leak every model into the picker, so prefer the candidate that
	 * actually carries `chatModelVisibility` data.
	 */
	private async pickStateDbWithPickerState(existing: string[]): Promise<string | null> {
		if (existing.length === 0) {
			return null;
		}

		if (existing.length === 1) {
			return existing[0];
		}

		let best: string | null = null;
		let bestMtime = -1;
		for (const candidate of existing) {
			const raw = await this.readStateItemValue(candidate, 'chatModelVisibility');
			const parsed = this.parseJson<ChatModelVisibilityState>(raw);
			const hasPickerState = Array.isArray(parsed?.hiddenModels) && parsed!.hiddenModels!.length > 0;
			if (!hasPickerState) {
				continue;
			}

			let mtime = 0;
			try {
				mtime = fs.statSync(candidate).mtimeMs;
			} catch {
				mtime = 0;
			}

			if (mtime > bestMtime) {
				bestMtime = mtime;
				best = candidate;
			}
		}

		return best ?? existing[0];
	}

	private getStateDbCandidates(): string[] {
		const candidates: string[] = [];
		const globalStorageUriPath = this.context?.globalStorageUri?.fsPath;
		if (globalStorageUriPath) {
			candidates.push(path.join(globalStorageUriPath, '..', 'state.vscdb'));
		}

		const home = os.homedir();
		const userDirs: string[] = [];
		if (process.platform === 'linux') {
			userDirs.push(
				path.join(home, '.config', 'Code', 'User'),
				path.join(home, '.config', 'Code - Insiders', 'User'),
				path.join(home, '.config', 'VSCodium', 'User'),
			);
		} else if (process.platform === 'darwin') {
			userDirs.push(
				path.join(home, 'Library', 'Application Support', 'Code', 'User'),
				path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User'),
				path.join(home, 'Library', 'Application Support', 'VSCodium', 'User'),
			);
		} else if (process.platform === 'win32') {
			const appData = process.env.APPDATA || '';
			userDirs.push(
				path.join(appData, 'Code', 'User'),
				path.join(appData, 'Code - Insiders', 'User'),
				path.join(appData, 'VSCodium', 'User'),
			);
		}

		for (const userDir of userDirs) {
			candidates.push(path.join(userDir, 'globalStorage', 'state.vscdb'));
			candidates.push(...this.getProfileStateDbCandidates(userDir));
		}

		return Array.from(new Set(candidates.filter(Boolean)));
	}

	/** Collect per-profile `state.vscdb` paths because chat picker state is PROFILE-scoped. */
	private getProfileStateDbCandidates(userDir: string): string[] {
		const profilesDir = path.join(userDir, 'profiles');
		try {
			return fs.readdirSync(profilesDir, { withFileTypes: true })
				.filter(entry => entry.isDirectory())
				.map(entry => path.join(profilesDir, entry.name, 'state.vscdb'))
				.filter(candidate => fs.existsSync(candidate));
		} catch {
			return [];
		}
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
			if (!this.isCopilotLanguageModel(model)) {
				continue;
			}

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
			const models = await this.selectUserFacingChatModels();
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
			const models = await this.selectUserFacingChatModels();
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
			const models = await this.selectUserFacingChatModels();
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
			const models = await this.selectUserFacingChatModels();
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

		const cachedSelector = await this.resolveCachedModelSelector(modelId);
		if (cachedSelector) {
			return cachedSelector;
		}

		return this.buildFallbackModelSelector(modelId, normalizedInput);
	}

	/** Resolve whether requested model exists in current Copilot environment */
	async resolveModelAvailability(modelId: string): Promise<{ matched: boolean; matchedId?: string; matchedFamily?: string }> {
		if (!modelId) {
			return { matched: false };
		}
		try {
			const models = await this.selectUserFacingChatModels();
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
			const models = await this.selectUserFacingChatModels();
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

		const cachedMatch = await this.resolveCachedModelEntry(modelId);
		if (cachedMatch) {
			return this.getPreferredModelOptionId(cachedMatch.metadata?.id || '', cachedMatch.identifier);
		}

		const raw = String(modelId || '').trim();
		if (raw.includes('/')) {
			return raw;
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

	private async resolveCachedModelSelector(modelId: string): Promise<vscode.LanguageModelChatSelector | undefined> {
		const entry = await this.resolveCachedModelEntry(modelId);
		const metadata = entry?.metadata;
		if (!metadata?.vendor || !metadata.id) {
			return undefined;
		}

		const selector: vscode.LanguageModelChatSelector = {
			vendor: metadata.vendor,
			id: metadata.id,
		};
		if (metadata.family) {
			selector.family = metadata.family;
		}
		if ((metadata as any).version) {
			selector.version = (metadata as any).version;
		}
		return selector;
	}

	private async resolveCachedModelEntry(modelId: string): Promise<CachedLanguageModelEntry | undefined> {
		const dbPath = await this.resolveStateDbPath();
		if (!dbPath) {
			return undefined;
		}

		const cachedModelsRaw = await this.readStateItemValue(dbPath, 'chat.cachedLanguageModels.v2');
		const cachedModels = this.parseJson<CachedLanguageModelEntry[]>(cachedModelsRaw);
		if (!cachedModels || cachedModels.length === 0) {
			return undefined;
		}

		const requested = String(modelId || '').trim().toLowerCase();
		const normalized = this.normalizeModelInput(modelId).toLowerCase();
		const candidates = [requested, normalized].filter(Boolean);
		return cachedModels.find(entry => {
			if (!this.isUserFacingCacheEntry(entry)) {
				return false;
			}

			const metadata = entry.metadata!;
			const optionId = this.getPreferredModelOptionId(metadata.id || '', entry.identifier).toLowerCase();
			const identifier = String(entry.identifier || '').trim().toLowerCase();
			const id = String(metadata.id || '').trim().toLowerCase();
			const family = String(metadata.family || '').trim().toLowerCase();
			const vendorFamily = `${String(metadata.vendor || '').trim().toLowerCase()}/${family}`;
			return candidates.some(candidate => candidate === optionId || candidate === identifier || candidate === id || candidate === family || candidate === vendorFamily);
		});
	}

	/** Build a safe selector fallback from a stored model identifier. */
	private buildFallbackModelSelector(
		modelId: string,
		normalizedInput: string,
	): vscode.LanguageModelChatSelector | undefined {
		const raw = String(modelId || '').trim();
		if (!raw && !normalizedInput) {
			return undefined;
		}

		if (raw.includes('/')) {
			const parts = raw.split('/').map(part => part.trim()).filter(Boolean);
			const vendor = parts[0] || undefined;
			const idParts = parts.length >= 3
				? parts.slice(2)
				: parts.slice(1);
			const terminalId = idParts.join('/') || parts[parts.length - 1] || normalizedInput || raw;
			return {
				vendor,
				id: terminalId,
				family: terminalId,
			};
		}

		return {
			vendor: 'copilot',
			id: normalizedInput,
		};
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
		if (identifier.includes('/') && !this.isAutoModelIdentifier(identifier)) {
			return identifier;
		}
		return String(rawId || '').trim() || identifier;
	}

	/** Keep custom-endpoint identifiers unique while collapsing Copilot aliases. */
	private getModelOptionSeenKey(value: string): string {
		const raw = String(value || '').trim().toLowerCase();
		if (!raw) {
			return '';
		}

		if (raw.startsWith('copilot/')) {
			return this.normalizeModelInput(raw) || raw;
		}

		if (raw.includes('/')) {
			return raw;
		}

		return this.normalizeModelInput(raw) || raw;
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
