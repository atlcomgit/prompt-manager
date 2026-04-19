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
import type { UncommittedProjectData } from './gitService.js';
import { ProjectStructureMapService } from './projectStructureMapService.js';
import { dedupeMemorySearchResults } from '../utils/memorySearchResults.js';
import { summarizeUncommittedProjects } from '../utils/uncommittedChangesSummary.js';
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
	/** Project names selected in the prompt */
	projectNames?: string[];
	/** Session-scoped snapshot of uncommitted changes */
	uncommittedProjects?: UncommittedProjectData[];
	/** Filter to apply */
	filter?: MemoryFilter;
}

const DEFAULT_OPTIONS: Required<MemoryContextOptions> = {
	maxChars: 8000,
	shortTermLimit: 50,
	includeLongTerm: true,
	useSemantic: true,
	projectNames: [],
	uncommittedProjects: [],
	filter: {},
};

/** Stats about the context sections built for the chat */
export interface MemoryContextStats {
	/** Number of short-term commits included */
	shortTermCommits: number;
	/** Number of long-term architecture summaries included */
	longTermSummaries: number;
	/** Whether the project map was included */
	hasProjectMap: boolean;
	/** Number of uncommitted-change projects included */
	uncommittedProjects: number;
	/** Total character count of the composed block */
	totalChars: number;
}

export class MemoryContextService {
	private readonly projectStructureMapService: ProjectStructureMapService;

	constructor(
		private db: MemoryDatabaseService,
		private embedding: MemoryEmbeddingService,
		projectStructureMapService?: ProjectStructureMapService,
	) {
		this.projectStructureMapService = projectStructureMapService || new ProjectStructureMapService();
	}

	private isRussianLocale(): boolean {
		return vscode.env.language.toLowerCase().startsWith('ru');
	}

	private getLocaleText(): {
		rootTitle: string;
		shortTermTitle: string;
		longTermTitle: string;
		projectMapTitle: string;
		uncommittedTitle: string;
		projectMapUnavailable: string;
		projectMapTruncated: (limit: number) => string;
		uncommittedSnapshotAt: (value: string) => string;
		uncommittedProjectSummary: (project: string, branch: string, totalFiles: number) => string;
		uncommittedScopeCount: (label: string, count: number) => string;
		uncommittedScopeLabel: (scope: 'staged' | 'unstaged' | 'untracked') => string;
		uncommittedRenamedCountLabel: string;
		uncommittedDeletedCountLabel: string;
		uncommittedRenamed: (previousPath: string) => string;
		uncommittedAreas: (value: string) => string;
		uncommittedSymbols: (value: string) => string;
		uncommittedNewFile: string;
		uncommittedDeletedFile: string;
		uncommittedFallbackHint: string;
		uncommittedHiddenFiles: (count: number) => string;
		uncommittedHiddenProjects: (count: number) => string;
		uncommittedTruncated: string;
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
				projectMapTitle: '### Карта файлов проекта',
				uncommittedTitle: '### Память о текущих незакомиченных изменениях',
				projectMapUnavailable: 'Карта файлов проекта недоступна для текущего рабочего пространства.',
				projectMapTruncated: (limit) => `... дополнительные узлы скрыты после достижения лимита ${limit}`,
				uncommittedSnapshotAt: (value) => `Снимок состояния: ${value}.`,
				uncommittedProjectSummary: (project, branch, totalFiles) => `Проект ${project} (ветка ${branch || 'unknown'}): ${totalFiles} файлов.`,
				uncommittedScopeCount: (label, count) => `${label}: ${count}`,
				uncommittedScopeLabel: (scope) => ({
					staged: 'staged',
					unstaged: 'unstaged',
					untracked: 'untracked',
				}[scope]),
				uncommittedRenamedCountLabel: 'переименовано',
				uncommittedDeletedCountLabel: 'удалено',
				uncommittedRenamed: (previousPath) => `переименован из ${previousPath}`,
				uncommittedAreas: (value) => `области: ${value}`,
				uncommittedSymbols: (value) => `символы: ${value}`,
				uncommittedNewFile: 'новый файл',
				uncommittedDeletedFile: 'удален',
				uncommittedFallbackHint: 'есть незакомиченная работа в процессе',
				uncommittedHiddenFiles: (count) => `... еще ${count} файлов скрыто`,
				uncommittedHiddenProjects: (count) => `... еще ${count} проектов скрыто`,
				uncommittedTruncated: 'дополнительные незакомиченные изменения скрыты из-за лимита контекста.',
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
			projectMapTitle: '### Project File Map',
			uncommittedTitle: '### Current Uncommitted Changes Memory',
			projectMapUnavailable: 'Project file map is unavailable for the current workspace.',
			projectMapTruncated: (limit) => `... additional nodes omitted after reaching the limit ${limit}`,
			uncommittedSnapshotAt: (value) => `Snapshot captured at: ${value}.`,
			uncommittedProjectSummary: (project, branch, totalFiles) => `Project ${project} (branch ${branch || 'unknown'}): ${totalFiles} files.`,
			uncommittedScopeCount: (label, count) => `${label}: ${count}`,
			uncommittedScopeLabel: (scope) => ({
				staged: 'staged',
				unstaged: 'unstaged',
				untracked: 'untracked',
			}[scope]),
			uncommittedRenamedCountLabel: 'renamed',
			uncommittedDeletedCountLabel: 'deleted',
			uncommittedRenamed: (previousPath) => `renamed from ${previousPath}`,
			uncommittedAreas: (value) => `areas: ${value}`,
			uncommittedSymbols: (value) => `symbols: ${value}`,
			uncommittedNewFile: 'new file',
			uncommittedDeletedFile: 'deleted',
			uncommittedFallbackHint: 'contains uncommitted work in progress',
			uncommittedHiddenFiles: (count) => `... ${count} more files hidden`,
			uncommittedHiddenProjects: (count) => `... ${count} more projects hidden`,
			uncommittedTruncated: 'additional uncommitted changes were hidden to fit the context budget.',
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
	 * Returns the composed text and section-level stats.
	 */
	async getContextForChat(
		prompt: string,
		options?: MemoryContextOptions,
	): Promise<{ context: string; stats: MemoryContextStats }> {
		const opts = { ...DEFAULT_OPTIONS, ...options };
		const text = this.getLocaleText();
		const sections: string[] = [];
		const stats: MemoryContextStats = {
			shortTermCommits: 0,
			longTermSummaries: 0,
			hasProjectMap: false,
			uncommittedProjects: 0,
			totalChars: 0,
		};

		// 1) Long-term context (architecture summaries)
		if (opts.includeLongTerm) {
			const { block, count } = await this.buildLongTermContextWithStats(opts);
			if (block) { sections.push(block); }
			stats.longTermSummaries = count;
		}

		const projectMapBlock = await this.buildProjectMapContext(opts);
		if (projectMapBlock) {
			sections.push(projectMapBlock);
			stats.hasProjectMap = true;
		}

		const { block: uncommittedBlock, projectCount } = this.buildUncommittedChangesContextWithStats(opts);
		if (uncommittedBlock) { sections.push(uncommittedBlock); }
		stats.uncommittedProjects = projectCount;

		// 3) Short-term context — semantically relevant or recent
		const { block: shortTermBlock, commitCount } = await this.buildShortTermContextWithStats(prompt, opts);
		if (shortTermBlock) { sections.push(shortTermBlock); }
		stats.shortTermCommits = commitCount;

		if (sections.length === 0) {
			return { context: '', stats };
		}

		// Compose the final block
		let context = `${text.rootTitle}\n\n${sections.join('\n\n')}`;

		// Truncate if exceeds maxChars
		if (context.length > opts.maxChars) {
			context = context.substring(0, opts.maxChars - 3) + '...';
		}

		stats.totalChars = context.length;
		return { context, stats };
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
		const { block } = await this.buildShortTermContextWithStats(prompt, opts);
		return block;
	}

	/** Short-term block with commit count stats */
	private async buildShortTermContextWithStats(
		prompt: string,
		opts: Required<MemoryContextOptions>,
	): Promise<{ block: string; commitCount: number }> {
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

		results = dedupeMemorySearchResults(results).slice(0, opts.shortTermLimit);

		if (results.length === 0) { return { block: '', commitCount: 0 }; }

		const lines = results.map(r => this.formatCommitEntry(r));
		return { block: `${text.shortTermTitle}\n\n${lines.join('\n')}`, commitCount: results.length };
	}

	/**
	 * Build long-term memory block from compressed summaries.
	 */
	private async buildLongTermContext(
		opts: Required<MemoryContextOptions>,
	): Promise<string> {
		const { block } = await this.buildLongTermContextWithStats(opts);
		return block;
	}

	/** Long-term block with summary count stats */
	private async buildLongTermContextWithStats(
		opts: Required<MemoryContextOptions>,
	): Promise<{ block: string; count: number }> {
		const text = this.getLocaleText();
		const summaries = await this.db.getSummaries('project', '');
		if (summaries.length === 0) { return { block: '', count: 0 }; }

		const limited = summaries.slice(0, 5);
		const blocks = limited.map(s => `${text.repositorySummary(s.repository, s.commitCount)} ${s.summary}`);
		return { block: `${text.longTermTitle}\n\n${blocks.join('\n\n')}`, count: limited.length };
	}

	private async buildProjectMapContext(
		opts: Required<MemoryContextOptions>,
	): Promise<string> {
		const text = this.getLocaleText();
		const result = await this.projectStructureMapService.buildProjectStructureMap({
			projectNames: opts.projectNames,
		});
		if (!result?.tree) {
			return '';
		}

		const lines = [
			text.projectMapTitle,
			'',
			'```text',
			result.tree,
			'```',
		];

		if (result.truncated) {
			lines.push('', text.projectMapTruncated(result.maxEntries));
		}

		return lines.join('\n');
	}

	private buildUncommittedChangesContext(opts: Required<MemoryContextOptions>): string {
		return this.buildUncommittedChangesContextWithStats(opts).block;
	}

	/** Uncommitted changes block with project count stats */
	private buildUncommittedChangesContextWithStats(opts: Required<MemoryContextOptions>): { block: string; projectCount: number } {
		if (opts.projectNames.length === 0 || opts.uncommittedProjects.length === 0) {
			return { block: '', projectCount: 0 };
		}

		const text = this.getLocaleText();
		const summary = summarizeUncommittedProjects(opts.uncommittedProjects, {
			maxProjects: 3,
			maxFilesPerProject: 4,
			maxAreasPerFile: 2,
			maxSymbolsPerFile: 2,
		});

		if (summary.projects.length === 0) {
			return { block: '', projectCount: 0 };
		}

		const lines: string[] = [
			text.uncommittedTitle,
			'',
			`- ${text.uncommittedSnapshotAt(summary.generatedAt)}`,
		];

		for (const project of summary.projects) {
			const countParts = [
				text.uncommittedScopeCount(text.uncommittedScopeLabel('staged'), project.counts.staged),
				text.uncommittedScopeCount(text.uncommittedScopeLabel('unstaged'), project.counts.unstaged),
				text.uncommittedScopeCount(text.uncommittedScopeLabel('untracked'), project.counts.untracked),
			];

			if (project.counts.renamed > 0) {
				countParts.push(text.uncommittedScopeCount(text.uncommittedRenamedCountLabel, project.counts.renamed));
			}
			if (project.counts.deleted > 0) {
				countParts.push(text.uncommittedScopeCount(text.uncommittedDeletedCountLabel, project.counts.deleted));
			}

			lines.push(`- ${text.uncommittedProjectSummary(project.project, project.branch, project.totalFiles)} ${countParts.join(', ')}.`);

			for (const file of project.files) {
				const scopeLabel = file.scopes.map(scope => text.uncommittedScopeLabel(scope)).join(', ');
				lines.push(`  - [${scopeLabel}] ${file.path} — ${this.formatUncommittedFileHint(file)}`);
			}

			if (project.hiddenFiles > 0) {
				lines.push(`  - ${text.uncommittedHiddenFiles(project.hiddenFiles)}`);
			}
		}

		if (summary.hiddenProjects > 0) {
			lines.push(`- ${text.uncommittedHiddenProjects(summary.hiddenProjects)}`);
		}

		const block = this.limitUncommittedBlock(lines, Math.min(1800, Math.max(900, Math.floor(opts.maxChars * 0.3))), text.uncommittedTruncated);
		return { block, projectCount: summary.projects.length + summary.hiddenProjects };
	}

	private formatUncommittedFileHint(file: {
		previousPath?: string;
		isNewFile: boolean;
		isDeleted: boolean;
		areas: string[];
		symbols: string[];
	}): string {
		const text = this.getLocaleText();
		const parts: string[] = [];

		if (file.isNewFile) {
			parts.push(text.uncommittedNewFile);
		}
		if (file.isDeleted) {
			parts.push(text.uncommittedDeletedFile);
		}
		if (file.previousPath) {
			parts.push(text.uncommittedRenamed(file.previousPath));
		}
		if (file.symbols.length > 0) {
			parts.push(text.uncommittedSymbols(file.symbols.join(', ')));
		}
		if (file.areas.length > 0) {
			parts.push(text.uncommittedAreas(file.areas.join(' | ')));
		}

		return parts.join('; ') || text.uncommittedFallbackHint;
	}

	private limitUncommittedBlock(lines: string[], maxChars: number, truncatedText: string): string {
		const result: string[] = [];
		let currentLength = 0;

		for (const line of lines) {
			const nextLength = currentLength + line.length + (result.length > 0 ? 1 : 0);
			if (nextLength > maxChars) {
				result.push(`- ${truncatedText}`);
				break;
			}

			result.push(line);
			currentLength = nextLength;
		}

		return result.join('\n');
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
