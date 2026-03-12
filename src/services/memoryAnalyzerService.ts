/**
 * MemoryAnalyzerService — Uses VS Code Language Model API to analyse commits:
 * classify type, generate summary, extract insights, detect architectural impact,
 * build knowledge graph nodes, and detect bug-fix relations.
 */

import * as vscode from 'vscode';
import type {
	HookCommitPayload,
	MemoryAnalysis,
	MemoryAnalysisDepth,
	MemoryCategory,
	MemoryCommitType,
	MemoryFileChange,
	MemoryFileChangeType,
	MemoryKnowledgeNode,
	MemoryBugRelation,
	MemoryLayer,
} from '../types/memory.js';

export class MemoryAnalyzerService {
	/** Selector for the AI model */
	private modelSelector: vscode.LanguageModelChatSelector = {
		vendor: 'copilot',
		family: 'gpt-4o',
	};

	private isRussianLocale(): boolean {
		return vscode.env.language.toLowerCase().startsWith('ru');
	}

	/**
	 * Set the AI model family used for analysis.
	 */
	setModelFamily(family: string): void {
		this.modelSelector = { vendor: 'copilot', family };
	}

	/**
	 * Full analysis pipeline for a single commit.
	 * Returns analysis, knowledge nodes, bug relation (if applicable), and file changes.
	 */
	async analyzeCommit(
		payload: HookCommitPayload,
		depth: MemoryAnalysisDepth,
		diffLimit: number,
	): Promise<{
		analysis: MemoryAnalysis;
		knowledgeNodes: MemoryKnowledgeNode[];
		bugRelation: MemoryBugRelation | null;
		fileChanges: MemoryFileChange[];
	}> {
		// Truncate diff to configured limit
		const truncatedDiff = payload.diff.substring(0, diffLimit);

		// Build file changes
		const fileChanges = this.buildFileChanges(payload);

		// Build the analysis prompt
		const analysisInput = this.buildAnalysisInput(payload, truncatedDiff, depth);

		// Run AI analysis
		const rawResult = await this.runAnalysis(analysisInput, depth);

		// Build MemoryAnalysis from raw result
		const analysis: MemoryAnalysis = {
			commitSha: payload.sha,
			summary: rawResult.summary || payload.message.substring(0, 200),
			keyInsights: rawResult.keyInsights || [],
			components: rawResult.components || [],
			categories: this.validateCategories(rawResult.categories),
			keywords: rawResult.keywords || [],
			architectureImpact: rawResult.architectureImpact || '',
			architectureImpactScore: this.clampScore(rawResult.architectureImpactScore),
			layers: this.validateLayers(rawResult.layers),
			businessDomains: rawResult.businessDomains || [],
			isBreakingChange: rawResult.isBreakingChange || false,
			createdAt: new Date().toISOString(),
		};

		// Build knowledge graph nodes
		let knowledgeNodes: MemoryKnowledgeNode[] = [];
		if (rawResult.knowledgeNodes && Array.isArray(rawResult.knowledgeNodes)) {
			knowledgeNodes = rawResult.knowledgeNodes.map((n: any) => ({
				sourceComponent: String(n.source || ''),
				targetComponent: String(n.target || ''),
				relationType: String(n.relation || 'uses'),
				commitSha: payload.sha,
				sourceKind: this.normalizeKnowledgeKind(n.sourceKind),
				targetKind: this.normalizeKnowledgeKind(n.targetKind),
				sourceLayer: this.normalizeKnowledgeLayer(n.sourceLayer),
				targetLayer: this.normalizeKnowledgeLayer(n.targetLayer),
				sourceFilePath: this.normalizeOptionalString(n.sourceFile),
				targetFilePath: this.normalizeOptionalString(n.targetFile),
				relationStrength: this.clampRelationStrength(n.strength),
				confidence: this.clampConfidence(n.confidence),
			})).filter((n: MemoryKnowledgeNode) => n.sourceComponent && n.targetComponent);
		}

		// Detect bug-fix
		let bugRelation: MemoryBugRelation | null = null;
		if (rawResult.bugFix && rawResult.bugFix.sourceCommitSha) {
			bugRelation = {
				fixCommitSha: payload.sha,
				sourceCommitSha: String(rawResult.bugFix.sourceCommitSha),
				description: String(rawResult.bugFix.description || ''),
			};
		}

		return { analysis, knowledgeNodes, bugRelation, fileChanges };
	}

	/**
	 * Classify commit type from the message.
	 * Lightweight — no diff needed.
	 */
	classifyCommitType(message: string): MemoryCommitType {
		const lower = message.toLowerCase();
		const prefix = lower.split(/[\s(:]/)[0];

		const typeMap: Record<string, MemoryCommitType> = {
			feat: 'feat', feature: 'feat',
			fix: 'fix', bugfix: 'fix', hotfix: 'fix',
			refactor: 'refactor', refactoring: 'refactor',
			docs: 'docs', doc: 'docs', documentation: 'docs',
			test: 'test', tests: 'test',
			chore: 'chore',
			style: 'style', lint: 'style',
			perf: 'perf', performance: 'perf', optimize: 'perf',
			ci: 'ci',
			build: 'build',
			revert: 'revert',
		};

		if (typeMap[prefix]) { return typeMap[prefix]; }

		// Heuristic fallback
		if (lower.includes('fix') || lower.includes('исправ') || lower.includes('баг')) { return 'fix'; }
		if (lower.includes('добавл') || lower.includes('new ') || lower.includes('add ')) { return 'feat'; }
		if (lower.includes('рефакт') || lower.includes('refactor') || lower.includes('clean')) { return 'refactor'; }
		if (lower.includes('тест') || lower.includes('test')) { return 'test'; }
		if (lower.includes('документ') || lower.includes('readme')) { return 'docs'; }
		if (lower.includes('revert')) { return 'revert'; }

		return 'other';
	}

	// ---- Private helpers ----

	/** Build file change records from the hook payload */
	private buildFileChanges(payload: HookCommitPayload): MemoryFileChange[] {
		return payload.files.map(f => ({
			commitSha: payload.sha,
			filePath: f.path,
			changeType: this.mapGitStatus(f.status),
			diff: '', // diff is stored at commit level, not per-file
		}));
	}

	/** Map git status letter to MemoryFileChangeType */
	private mapGitStatus(status: string): MemoryFileChangeType {
		const map: Record<string, MemoryFileChangeType> = {
			A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied',
		};
		return map[status] || 'modified';
	}

	/** Build the text input for the AI analysis prompt */
	private buildAnalysisInput(
		payload: HookCommitPayload,
		truncatedDiff: string,
		depth: MemoryAnalysisDepth,
	): string {
		const fileList = payload.files.map(f => `${f.status}\t${f.path}`).join('\n');

		let sections = [
			`Commit: ${payload.sha}`,
			`Author: ${payload.author} <${payload.email}>`,
			`Date: ${payload.date}`,
			`Branch: ${payload.branch}`,
			`Repository: ${payload.repository}`,
			`\nMessage:\n${payload.message}`,
			`\nChanged files:\n${fileList}`,
		];

		if (depth !== 'minimal' && truncatedDiff) {
			sections.push(`\nDiff (truncated):\n${truncatedDiff}`);
		}

		return sections.join('\n');
	}

	/** Run the AI model to analyse the commit */
	private async runAnalysis(
		input: string,
		depth: MemoryAnalysisDepth,
	): Promise<any> {
		const systemPrompt = this.buildSystemPrompt(depth);
		try {
			const [model] = await vscode.lm.selectChatModels(this.modelSelector);
			if (!model) {
				const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
				if (models.length === 0) { return this.fallbackAnalysis(); }
				return this.chatJson(models[0], systemPrompt, input);
			}
			return this.chatJson(model, systemPrompt, input);
		} catch (err) {
			console.error('[PromptManager/Memory] AI analysis error:', err);
			return this.fallbackAnalysis();
		}
	}

	/** Build the system prompt appropriate for the analysis depth */
	private buildSystemPrompt(depth: MemoryAnalysisDepth): string {
		const base = [
			'You are a code analysis assistant. Analyse the provided git commit and return a JSON object.',
			'Return ONLY valid JSON, no markdown fences or explanations.',
			...(this.isRussianLocale()
				? [
					'The current VS Code UI language is Russian.',
					'Write all natural language values in Russian.',
					'Keep JSON keys, enum values, and the required schema exactly as specified.',
				]
				: []),
			'The JSON must have these fields:',
			'- "summary": string — brief summary of changes (1-3 sentences)',
			'- "keyInsights": string[] — key insights (up to 5)',
			'- "components": string[] — affected modules/components',
			'- "categories": string[] — from: frontend,backend,api,database,devops,documentation,tests,other',
			'- "keywords": string[] — search keywords (up to 10)',
			'- "architectureImpact": string — description of architecture impact',
			'- "architectureImpactScore": number — 0 (none) to 10 (massive)',
			'- "layers": string[] — from: controller,service,repository,model,middleware,migration,config,util,view,component,other',
			'- "businessDomains": string[] — affected business domains',
			'- "isBreakingChange": boolean — whether this is a breaking change',
			'- "commitType": string — from: feat,fix,refactor,docs,test,chore,style,perf,ci,build,revert,other',
		];

		if (depth === 'deep') {
			base.push(
				'- "knowledgeNodes": array of { "source": string, "target": string, "relation": string, "sourceKind"?: "layer"|"file"|"component", "targetKind"?: "layer"|"file"|"component", "sourceLayer"?: string, "targetLayer"?: string, "sourceFile"?: string, "targetFile"?: string, "strength"?: number, "confidence"?: number } — architectural relationships detected',
				'- "bugFix": { "sourceCommitSha": string, "description": string } | null — if this commit fixes a bug, identify the source commit if mentioned',
			);
		}

		return base.join('\n');
	}

	/** Send a chat request and parse JSON from response */
	private async chatJson(
		model: vscode.LanguageModelChat,
		systemPrompt: string,
		userPrompt: string,
	): Promise<any> {
		try {
			const messages = [
				vscode.LanguageModelChatMessage.User(systemPrompt),
				vscode.LanguageModelChatMessage.User(userPrompt),
			];
			const cts = new vscode.CancellationTokenSource();
			const response = await model.sendRequest(messages, {}, cts.token);
			let result = '';
			for await (const chunk of response.text) {
				result += chunk;
			}

			// Strip markdown fences if accidentally returned
			result = result.trim();
			if (result.startsWith('```')) {
				result = result.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
			}

			return JSON.parse(result);
		} catch (err) {
			console.error('[PromptManager/Memory] Failed to parse AI analysis response:', err);
			return this.fallbackAnalysis();
		}
	}

	/** Fallback analysis when AI is unavailable */
	private fallbackAnalysis(): any {
		return {
			summary: '',
			keyInsights: [],
			components: [],
			categories: ['other'],
			keywords: [],
			architectureImpact: '',
			architectureImpactScore: 0,
			layers: ['other'],
			businessDomains: [],
			isBreakingChange: false,
			commitType: 'other',
			knowledgeNodes: [],
			bugFix: null,
		};
	}

	/** Validate and filter categories against allowed values */
	private validateCategories(raw: any): MemoryCategory[] {
		const allowed: Set<string> = new Set([
			'frontend', 'backend', 'api', 'database', 'devops', 'documentation', 'tests', 'other',
		]);
		if (!Array.isArray(raw)) { return ['other']; }
		const valid = raw.filter((c: string) => allowed.has(c)) as MemoryCategory[];
		return valid.length > 0 ? valid : ['other'];
	}

	/** Validate and filter layers against allowed values */
	private validateLayers(raw: any): MemoryLayer[] {
		const allowed: Set<string> = new Set([
			'controller', 'service', 'repository', 'model', 'middleware',
			'migration', 'config', 'util', 'view', 'component', 'other',
		]);
		if (!Array.isArray(raw)) { return ['other']; }
		const valid = raw.filter((l: string) => allowed.has(l)) as MemoryLayer[];
		return valid.length > 0 ? valid : ['other'];
	}

	/** Clamp architecture impact score to 0-10 */
	private clampScore(value: any): number {
		const num = Number(value) || 0;
		return Math.max(0, Math.min(10, Math.round(num)));
	}

	private clampRelationStrength(value: any): number | undefined {
		if (value === undefined || value === null || value === '') {
			return undefined;
		}
		const num = Number(value);
		if (!Number.isFinite(num)) {
			return undefined;
		}
		return Math.max(1, Math.min(10, Math.round(num)));
	}

	private clampConfidence(value: any): number | undefined {
		if (value === undefined || value === null || value === '') {
			return undefined;
		}
		const num = Number(value);
		if (!Number.isFinite(num)) {
			return undefined;
		}
		return Math.max(0, Math.min(1, Number(num.toFixed(2))));
	}

	private normalizeOptionalString(value: any): string | undefined {
		if (typeof value !== 'string') {
			return undefined;
		}
		const normalized = value.trim();
		return normalized ? normalized : undefined;
	}

	private normalizeKnowledgeKind(value: any): 'layer' | 'file' | 'component' | undefined {
		if (value === 'layer' || value === 'file' || value === 'component') {
			return value;
		}
		return undefined;
	}

	private normalizeKnowledgeLayer(value: any): MemoryLayer | 'mixed' | undefined {
		if (value === 'mixed') {
			return value;
		}
		const normalized = this.normalizeOptionalString(value);
		if (!normalized) {
			return undefined;
		}
		const allowed: Set<string> = new Set([
			'controller', 'service', 'repository', 'model', 'middleware',
			'migration', 'config', 'util', 'view', 'component', 'other',
		]);
		return allowed.has(normalized) ? (normalized as MemoryLayer) : undefined;
	}
}
