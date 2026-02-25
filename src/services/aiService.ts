/**
 * AI Service — generates titles, descriptions and slugs using VS Code Language Model API
 */

import * as vscode from 'vscode';

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

export class AiService {
	private static readonly DEFAULT_IMPROVE_PROMPT_INSTRUCTIONS = [
		'Пиши на русском языке.',
		'Пиши ответ с обращением к одному лицу.',
	];

	private modelSelector: vscode.LanguageModelChatSelector = {
		vendor: 'copilot',
		family: 'gpt-4o',
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
		return this.chat(systemPrompt, userPrompt, 'Untitled Prompt');
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

	/** Generic chat with Language Model API */
	private async chat(systemPrompt: string, userPrompt: string, fallback: string): Promise<string> {
		try {
			const [model] = await vscode.lm.selectChatModels(this.modelSelector);
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
	async getAvailableModels(): Promise<Array<{ id: string; name: string }>> {
		try {
			const models = await vscode.lm.selectChatModels({});
			return models.map(m => ({
				id: m.id,
				name: this.toReadableModelName(m.vendor, m.family, m.id),
			})).sort((a, b) => `${a.name} ${a.id}`.localeCompare(`${b.name} ${b.id}`, 'ru', { sensitivity: 'base' }));
		} catch {
			return [];
		}
	}

	private toReadableModelName(vendor: string, family: string, modelId: string): string {
		const prettifyToken = (token: string): string => token
			.split(/[-_\s]+/)
			.filter(Boolean)
			.map((part) => {
				if (/^\d/.test(part) || part.length <= 2) {
					return part.toUpperCase();
				}
				return part.charAt(0).toUpperCase() + part.slice(1);
			})
			.join('-')
			.replace(/\bGpt\b/g, 'GPT')
			.replace(/\bO\b/g, 'o');

		const vendorName = prettifyToken(vendor || 'AI');
		const familyName = prettifyToken(family || modelId || 'Model');
		return `${vendorName} · ${familyName}`;
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
