/**
 * MemoryContextService — Builds enriched context from project memory
 * for chat agents. Implements two-level memory: short-term (recent N commits)
 * and long-term (compressed architectural summaries).
 *
 * The main entry point `getContextForChat(prompt)` returns a formatted
 * text block ready to inject into the AI agent system prompt.
 */

import * as vscode from 'vscode';
import type { MemoryDatabaseService } from './memoryDatabaseService.js';
import type { MemoryEmbeddingService } from './memoryEmbeddingService.js';
import type {
	MemoryCommit,
	MemoryAnalysis,
	MemoryFilter,
	MemorySearchResult,
	MemorySummary,
} from '../types/memory.js';

/** Options for context generation */
export interface MemoryContextOptions {
	/** Maximum characters in the resulting context block */
	maxChars?: number;
	/** Number of recent commits for short-term context */
	shortTermLimit?: number;
	/** Whether to include long-term summaries */
	includeLongTerm?: boolean;
	/** Whether to use semantic search when available */
	useSemantic?: boolean;
	/** Filter to apply */
	filter?: MemoryFilter;
}

const DEFAULT_OPTIONS: Required<MemoryContextOptions> = {
	maxChars: 8000,
	shortTermLimit: 50,
	includeLongTerm: true,
	useSemantic: true,
	filter: {},
};

export class MemoryContextService {
	constructor(
		private db: MemoryDatabaseService,
		private embedding: MemoryEmbeddingService,
	) { }

	private isRussianLocale(): boolean {
		return vscode.env.language.toLowerCase().startsWith('ru');
	}

	private getLocaleText(): {
		rootTitle: string;
		shortTermTitle: string;
		longTermTitle: string;
		summaryLabel: string;
		categoriesLabel: string;
		highImpactLabel: string;
		repositorySummary: (repository: string, count: number) => string;
		commitsAnalyzed: (count: number) => string;
		mainCategories: (value: string) => string;
		mainLayers: (value: string) => string;
		components: (value: string) => string;
		domains: (value: string) => string;
		avgImpact: (value: string) => string;
		breakingChanges: (count: number) => string;
		keyInsights: (value: string) => string;
	} {
		if (this.isRussianLocale()) {
			return {
				rootTitle: '## Контекст проектной памяти',
				shortTermTitle: '### Недавние и релевантные изменения',
				longTermTitle: '### Архитектурная сводка',
				summaryLabel: 'Сводка',
				categoriesLabel: 'Категории',
				highImpactLabel: 'Высокое влияние на архитектуру',
				repositorySummary: (repository, count) => `**${repository}** (${count} коммитов):`,
				commitsAnalyzed: (count) => `${count} коммитов проанализировано.`,
				mainCategories: (value) => `Основные категории: ${value}.`,
				mainLayers: (value) => `Основные слои: ${value}.`,
				components: (value) => `Компоненты: ${value}.`,
				domains: (value) => `Домены: ${value}.`,
				avgImpact: (value) => `Среднее влияние на архитектуру: ${value}/10.`,
				breakingChanges: (count) => `Критические изменения: ${count}.`,
				keyInsights: (value) => `Ключевые выводы: ${value}.`,
			};
		}

		return {
			rootTitle: '## Project Memory Context',
			shortTermTitle: '### Recent & Relevant Changes',
			longTermTitle: '### Architecture Summary',
			summaryLabel: 'Summary',
			categoriesLabel: 'Categories',
			highImpactLabel: 'High architecture impact',
			repositorySummary: (repository, count) => `**${repository}** (${count} commits):`,
			commitsAnalyzed: (count) => `${count} commits analysed.`,
			mainCategories: (value) => `Main categories: ${value}.`,
			mainLayers: (value) => `Main layers: ${value}.`,
			components: (value) => `Components: ${value}.`,
			domains: (value) => `Domains: ${value}.`,
			avgImpact: (value) => `Avg architecture impact: ${value}/10.`,
			breakingChanges: (count) => `Breaking changes: ${count}.`,
			keyInsights: (value) => `Key insights: ${value}.`,
		};
	}

	/**
	 * Build context block for a chat agent based on the user's prompt.
	 * Combines short-term memory (recent commits) and long-term memory
	 * (architecture summaries). When embeddings are available and the
	 * user prompt is provided, semantic search prioritises relevant commits.
	 */
	async getContextForChat(
		prompt: string,
		options?: MemoryContextOptions,
	): Promise<string> {
		const opts = { ...DEFAULT_OPTIONS, ...options };
		const text = this.getLocaleText();
		const sections: string[] = [];

		// 1) Long-term context (architecture summaries)
		if (opts.includeLongTerm) {
			const longTermBlock = await this.buildLongTermContext(opts);
			if (longTermBlock) { sections.push(longTermBlock); }
		}

		// 2) Short-term context — semantically relevant or recent
		const shortTermBlock = await this.buildShortTermContext(prompt, opts);
		if (shortTermBlock) { sections.push(shortTermBlock); }

		if (sections.length === 0) { return ''; }

		// Compose the final block
		let context = `${text.rootTitle}\n\n${sections.join('\n\n')}`;

		// Truncate if exceeds maxChars
		if (context.length > opts.maxChars) {
			context = context.substring(0, opts.maxChars - 3) + '...';
		}

		return context;
	}

	/**
	 * Build short-term memory block.
	 * Uses semantic search when embeddings are enabled and model is ready;
	 * falls back to keyword search or plain recent-commits listing.
	 */
	private async buildShortTermContext(
		prompt: string,
		opts: Required<MemoryContextOptions>,
	): Promise<string> {
		const text = this.getLocaleText();
		let results: MemorySearchResult[] = [];

		// Try semantic search first
		if (prompt && opts.useSemantic && this.embedding.isReady()) {
			results = await this.semanticSearchCommits(prompt, opts.shortTermLimit);
		}

		// Fallback: keyword search
		if (results.length === 0 && prompt) {
			results = await this.keywordSearchCommits(prompt, opts.shortTermLimit);
		}

		// Fallback: just recent commits
		if (results.length === 0) {
			results = await this.getRecentCommits(opts.shortTermLimit, opts.filter);
		}

		if (results.length === 0) { return ''; }

		const lines = results.map(r => this.formatCommitEntry(r));
		return `${text.shortTermTitle}\n\n${lines.join('\n')}`;
	}

	/**
	 * Build long-term memory block from compressed summaries.
	 */
	private async buildLongTermContext(
		opts: Required<MemoryContextOptions>,
	): Promise<string> {
		const text = this.getLocaleText();
		// Get project-level summaries
		const summaries = await this.db.getSummaries('project', '');
		if (summaries.length === 0) { return ''; }

		const blocks = summaries
			.slice(0, 5)
			.map(s => `${text.repositorySummary(s.repository, s.commitCount)} ${s.summary}`);

		return `${text.longTermTitle}\n\n${blocks.join('\n\n')}`;
	}

	/**
	 * Semantic search over embeddings.
	 */
	private async semanticSearchCommits(
		query: string,
		limit: number,
	): Promise<MemorySearchResult[]> {
		const queryVector = await this.embedding.generateEmbedding(query);
		if (!queryVector) { return []; }

		const allEmbeddings = await this.db.getAllEmbeddings();
		if (allEmbeddings.length === 0) { return []; }

		const scored = this.embedding.semanticSearch(queryVector, allEmbeddings, limit, 0.3);

		// Load commit + analysis for each result
		const results: MemorySearchResult[] = [];
		for (const item of scored) {
			const commit = await this.db.getCommit(item.commitSha);
			if (!commit) { continue; }
			const analysis = await this.db.getAnalysis(item.commitSha);
			results.push({ commit, analysis: analysis || undefined, score: item.score });
		}

		return results;
	}

	/**
	 * Keyword search via database.
	 */
	private async keywordSearchCommits(
		query: string,
		limit: number,
	): Promise<MemorySearchResult[]> {
		const commits = await this.db.searchByKeyword(query);
		const results: MemorySearchResult[] = [];
		for (const commit of commits.slice(0, limit)) {
			const analysis = await this.db.getAnalysis(commit.sha);
			results.push({ commit, analysis: analysis || undefined, score: 1.0 });
		}
		return results;
	}

	/**
	 * Get recent commits when no query is available.
	 */
	private async getRecentCommits(
		limit: number,
		filter: MemoryFilter,
	): Promise<MemorySearchResult[]> {
		const { commits } = await this.db.getCommits({ ...filter, limit });
		const results: MemorySearchResult[] = [];

		for (const commit of commits) {
			const analysis = await this.db.getAnalysis(commit.sha);
			results.push({
				commit,
				analysis: analysis || undefined,
				score: 1.0,
			});
		}

		return results;
	}

	/**
	 * Format a single commit entry for context.
	 */
	private formatCommitEntry(result: MemorySearchResult): string {
		const text = this.getLocaleText();
		const { commit, analysis, score } = result;
		const date = commit.date.substring(0, 10);
		const sha = commit.sha.substring(0, 7);

		let line = `- [${date}] ${sha} ${commit.commitType}: ${commit.message.split('\n')[0]}`;

		if (analysis) {
			if (analysis.summary) {
				line += `\n  ${text.summaryLabel}: ${analysis.summary}`;
			}
			if (analysis.categories.length > 0) {
				line += ` | ${text.categoriesLabel}: ${analysis.categories.join(', ')}`;
			}
			if (analysis.architectureImpactScore > 5) {
				line += ` | ⚠ ${text.highImpactLabel} (${analysis.architectureImpactScore}/10)`;
			}
		}

		return line;
	}

	/**
	 * Generate or update project summary from recent analyses.
	 * Called periodically to compress short-term memory into long-term.
	 */
	async updateProjectSummary(repository: string): Promise<void> {
		// Get recent analyses (last 100 commits)
		const { commits } = await this.db.getCommits({ repositories: [repository], limit: 100 });
		if (commits.length === 0) { return; }

		const analyses: MemoryAnalysis[] = [];
		for (const c of commits) {
			const a = await this.db.getAnalysis(c.sha);
			if (a) { analyses.push(a); }
		}

		if (analyses.length === 0) { return; }

		// Compress into a summary
		const summary = this.compressSummary(analyses, repository);

		await this.db.upsertSummary({
			scope: 'project',
			period: repository,
			repository,
			summary: summary.summary,
			commitCount: summary.commitCount,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
	}

	/**
	 * Compress multiple analyses into a single summary.
	 * Pure algorithmic compression — no AI needed.
	 */
	private compressSummary(
		analyses: MemoryAnalysis[],
		repository: string,
	): { summary: string; commitCount: number } {
		const text = this.getLocaleText();
		// Collect stats
		const categoryCount: Record<string, number> = {};
		const layerCount: Record<string, number> = {};
		const componentSet = new Set<string>();
		const domainSet = new Set<string>();
		const insights: string[] = [];
		let breakingChanges = 0;
		let totalImpact = 0;

		for (const a of analyses) {
			for (const c of a.categories) { categoryCount[c] = (categoryCount[c] || 0) + 1; }
			for (const l of a.layers) { layerCount[l] = (layerCount[l] || 0) + 1; }
			for (const comp of a.components) { componentSet.add(comp); }
			for (const d of a.businessDomains) { domainSet.add(d); }
			if (a.keyInsights.length > 0) { insights.push(...a.keyInsights.slice(0, 2)); }
			if (a.isBreakingChange) { breakingChanges++; }
			totalImpact += a.architectureImpactScore;
		}

		// Build summary text
		const topCategories = Object.entries(categoryCount)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([cat, cnt]) => `${cat} (${cnt})`);

		const topLayers = Object.entries(layerCount)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([layer, cnt]) => `${layer} (${cnt})`);

		const avgImpact = analyses.length > 0 ? (totalImpact / analyses.length).toFixed(1) : '0';

		const parts = [
			`${text.repositorySummary(repository, analyses.length)} ${text.commitsAnalyzed(analyses.length)}`,
			text.mainCategories(topCategories.join(', ')),
			text.mainLayers(topLayers.join(', ')),
			text.components(Array.from(componentSet).slice(0, 10).join(', ')),
			domainSet.size > 0 ? text.domains(Array.from(domainSet).slice(0, 5).join(', ')) : '',
			text.avgImpact(avgImpact),
			breakingChanges > 0 ? text.breakingChanges(breakingChanges) : '',
			insights.length > 0 ? text.keyInsights(insights.slice(0, 5).join('; ')) : '',
		];

		return {
			summary: parts.filter(Boolean).join(' '),
			commitCount: analyses.length,
		};
	}
}
