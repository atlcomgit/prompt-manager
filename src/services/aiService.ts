/**
 * AI Service — generates titles, descriptions and slugs using VS Code Language Model API
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DEFAULT_COPILOT_MODEL_FAMILY, normalizeCopilotModelFamily } from '../constants/ai.js';

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
		isUserSelectable?: boolean;
		targetChatSessionType?: string;
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

export class AiService {
	private static readonly DEFAULT_IMPROVE_PROMPT_INSTRUCTIONS = [
		// 'Пиши на русском языке.',
		'Пиши ответ с обращением к одному лицу.',
	];

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
	async generateTitle(content: string, globalContext?: string): Promise<string> {
		const systemPrompt = 'You are a helpful assistant that generates short, descriptive titles for prompts. Respond with ONLY the title, nothing else. The title should be 3-7 words, in the same language as the content.';
		const contextBlock = this.buildGlobalContextBlock(globalContext);
		const userPrompt = `${contextBlock}Generate a short title for this prompt:\n\n${content.substring(0, 2000)}`;
		return this.chat(systemPrompt, userPrompt, 'Промпт без названия');
	}

	/** Generate a short description from prompt content */
	async generateDescription(content: string, globalContext?: string): Promise<string> {
		const systemPrompt = 'You are a helpful assistant that generates short descriptions for prompts. Respond with ONLY the description, nothing else. The description should be 1-2 sentences, in the same language as the content.';
		const contextBlock = this.buildGlobalContextBlock(globalContext);
		const userPrompt = `${contextBlock}Generate a short description for this prompt:\n\n${content.substring(0, 2000)}`;
		return this.chat(systemPrompt, userPrompt, '');
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

		const result = await this.chat(systemPrompt, userPrompt, '');
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
		return this.chat(systemPrompt, userPrompt, normalized);
	}

	/** Detect programming languages from content */
	async detectLanguages(content: string): Promise<string[]> {
		const systemPrompt = 'You detect programming languages mentioned or implied in a prompt. Return a JSON array of language names. Example: ["TypeScript", "Python"]. Return ONLY the JSON array.';
		const userPrompt = content.substring(0, 2000);
		const result = await this.chat(systemPrompt, userPrompt, '[]');
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
		const result = await this.chat(systemPrompt, userPrompt, '[]');
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

		return this.chat(systemPrompt, userPrompt, fallback);
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

		return this.chatWithSelector(
			{ vendor: 'copilot', family: normalizeCopilotModelFamily(modelFamily || this.modelSelector.family) },
			systemPrompt,
			userPrompt,
			fallback,
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

		return this.chatWithSelector(
			{ vendor: 'copilot', family: normalizeCopilotModelFamily(modelFamily || this.modelSelector.family) },
			systemPrompt,
			userPrompt,
			fallback,
		);
	}

	/** Generic chat with Language Model API */
	private async chat(systemPrompt: string, userPrompt: string, fallback: string): Promise<string> {
		return this.chatWithSelector(this.modelSelector, systemPrompt, userPrompt, fallback);
	}

	private async chatWithSelector(
		selector: vscode.LanguageModelChatSelector,
		systemPrompt: string,
		userPrompt: string,
		fallback: string,
	): Promise<string> {
		try {
			const [model] = await vscode.lm.selectChatModels(selector);
			if (!model) {
				// Fallback: try any available model
				const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
				if (models.length === 0) {
					return fallback;
				}
				return this.chatWithModel(models[0], systemPrompt, userPrompt, fallback);
			}
			return this.chatWithModel(model, systemPrompt, userPrompt, fallback);
		} catch (err) {
			console.error('[PromptManager] AI error:', err);
			return fallback;
		}
	}

	private async chatWithModel(
		model: vscode.LanguageModelChat,
		systemPrompt: string,
		userPrompt: string,
		fallback: string
	): Promise<string> {
		try {
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
		} catch {
			return fallback;
		}
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
		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			const visibleModels = await this.getVisibleCopilotModels(models);
			if (visibleModels.length > 0) {
				return visibleModels;
			}

			return this.normalizeAvailableModels(models.map(model => ({
				id: model.id,
				name: (model.name || '').trim() || model.family || model.id,
			})));
		} catch {
			return [];
		}
	}

	private async getVisibleCopilotModels(models: vscode.LanguageModelChat[]): Promise<AvailableModelOption[]> {
		const dbPath = await this.resolveStateDbPath();
		if (!dbPath) {
			return [];
		}

		const cachedModels = await this.getVisibleCopilotModelsFromCache(dbPath, models);
		if (cachedModels.length > 0) {
			return cachedModels;
		}

		const [modelsControlRaw, modelPickerPreferencesRaw, copilotSkuRaw] = await Promise.all([
			this.readStateItemValue(dbPath, 'chat.modelsControl'),
			this.readStateItemValue(dbPath, 'chatModelPickerPreferences'),
			this.readStateItemValue(dbPath, 'extensionsAssignmentFilterProvider.copilotSku'),
		]);

		const modelsControl = this.parseJson<ChatModelsControl>(modelsControlRaw);
		if (!modelsControl) {
			return [];
		}

		const featuredEntries = this.getVisibleControlEntries(modelsControl, this.resolveCopilotTier(copilotSkuRaw));
		if (featuredEntries.length === 0) {
			return [];
		}

		const preferences = this.parseJson<Record<string, boolean>>(modelPickerPreferencesRaw) || {};
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
		const pushModel = (model: vscode.LanguageModelChat | undefined, nameOverride?: string): void => {
			if (!model) {
				return;
			}

			const id = (model.id || '').trim();
			if (!id || id === 'auto' || seenIds.has(id)) {
				return;
			}

			seenIds.add(id);
			result.push({
				id,
				name: (nameOverride || '').trim() || (model.name || '').trim() || model.family || id,
			});
		};

		for (const entry of featuredEntries) {
			const controlId = (entry.id || '').trim();
			if (!controlId) {
				continue;
			}

			pushModel(
				availableById.get(controlId) || availableByIdentifier.get(`copilot/${controlId}`),
				entry.label,
			);
		}

		for (const [identifier, isVisible] of Object.entries(preferences)) {
			if (!isVisible || !identifier.toLowerCase().startsWith('copilot/')) {
				continue;
			}

			pushModel(availableByIdentifier.get(identifier.toLowerCase()));
		}

		return this.sortVisibleModels(result, featuredEntries);
	}

	private async getVisibleCopilotModelsFromCache(
		dbPath: string,
		models: vscode.LanguageModelChat[],
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
		for (const entry of cachedModels) {
			const metadata = entry.metadata;
			if (!metadata || metadata.vendor !== 'copilot' || metadata.isUserSelectable !== true) {
				continue;
			}

			// Prompt Manager opens the regular Copilot chat panel, not special session types.
			if (metadata.targetChatSessionType) {
				continue;
			}

			const model = availableByIdentifier.get(String(entry.identifier || '').trim().toLowerCase())
				|| availableById.get(String(metadata.id || '').trim());
			if (!model) {
				continue;
			}

			const id = (model.id || '').trim();
			if (!id || id === 'auto' || seenIds.has(id)) {
				continue;
			}

			seenIds.add(id);
			result.push({
				id,
				name: String(metadata.name || '').trim() || (model.name || '').trim() || model.family || id,
			});
		}

		return result;
	}

	private sortVisibleModels(
		models: AvailableModelOption[],
		featuredEntries: ChatModelsControlEntry[],
	): AvailableModelOption[] {
		const featuredRank = new Map<string, number>();
		featuredEntries.forEach((entry, index) => {
			const id = String(entry.id || '').trim();
			if (id && !featuredRank.has(id)) {
				featuredRank.set(id, index);
			}
		});

		return [...models].sort((left, right) => {
			const leftFeatured = featuredRank.get(left.id);
			const rightFeatured = featuredRank.get(right.id);
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
			if (!id || id === 'auto' || seen.has(id)) {
				continue;
			}

			seen.add(id);
			result.push({
				id,
				name: String(model.name || '').trim() || id,
			});
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
		try {
			const sql = `SELECT value FROM ItemTable WHERE key='${this.escapeSql(key)}' LIMIT 1;`;
			const { stdout } = await execFileAsync('sqlite3', [dbPath, sql]);
			return (stdout || '').trim();
		} catch {
			return '';
		}
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
		const home = os.homedir();
		if (process.platform === 'linux') {
			return [
				path.join(home, '.config', 'Code', 'User', 'globalStorage', 'state.vscdb'),
				path.join(home, '.config', 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb'),
				path.join(home, '.config', 'VSCodium', 'User', 'globalStorage', 'state.vscdb'),
			];
		}
		if (process.platform === 'darwin') {
			return [
				path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb'),
				path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb'),
				path.join(home, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage', 'state.vscdb'),
			];
		}
		if (process.platform === 'win32') {
			const appData = process.env.APPDATA || '';
			return [
				path.join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb'),
				path.join(appData, 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb'),
				path.join(appData, 'VSCodium', 'User', 'globalStorage', 'state.vscdb'),
			];
		}
		return [];
	}

	private escapeSql(value: string): string {
		return value.replace(/'/g, "''");
	}

	/** Generate inline suggestion / continuation for prompt text */
	async generateSuggestion(textBefore: string, globalContext?: string): Promise<string> {
		const systemPrompt = 'You are an AI assistant that continues writing a prompt. Given the text written so far, generate a natural continuation (1-3 sentences or a code block). Respond with ONLY the continuation text, nothing else. Match the language and style of the input.';
		const contextBlock = (globalContext || '').trim()
			? `Global agent context:\n${(globalContext || '').trim().slice(0, 1500)}\n\n`
			: '';
		const userPrompt = `${contextBlock}Continue this prompt text:\n\n${textBefore.slice(-1500)}`;
		return this.chat(systemPrompt, userPrompt, '');
	}

	/** Generate multiple suggestion variants for prompt text */
	async generateSuggestionVariants(textBefore: string, count: number = 3, globalContext?: string): Promise<string[]> {
		const systemPrompt = `You are an AI assistant that continues writing a prompt. Given the text written so far, generate ${count} DIFFERENT natural continuations (each 1-3 sentences). Return a JSON array of strings. Example: ["continuation 1", "continuation 2", "continuation 3"]. Return ONLY the JSON array, nothing else. Match the language and style of the input.`;
		const contextBlock = (globalContext || '').trim()
			? `Global agent context:\n${(globalContext || '').trim().slice(0, 1500)}\n\n`
			: '';
		const userPrompt = `${contextBlock}Continue this prompt text (${count} variants):\n\n${textBefore.slice(-1500)}`;
		const result = await this.chat(systemPrompt, userPrompt, '[]');
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
