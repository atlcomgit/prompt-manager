/**
 * Type definitions for Project Memory system.
 * Provides structured types for commits, analyses, embeddings,
 * knowledge graph, filters, settings, and webview messages.
 */

// ---- Enums & Constants ----

/** Categories of code changes */
export type MemoryCategory =
	| 'frontend'
	| 'backend'
	| 'api'
	| 'database'
	| 'devops'
	| 'documentation'
	| 'tests'
	| 'other';

/** All available memory categories */
export const MEMORY_CATEGORIES: MemoryCategory[] = [
	'frontend', 'backend', 'api', 'database', 'devops', 'documentation', 'tests', 'other',
];

/** Architecture layers */
export type MemoryLayer =
	| 'controller'
	| 'service'
	| 'repository'
	| 'model'
	| 'middleware'
	| 'migration'
	| 'config'
	| 'util'
	| 'view'
	| 'component'
	| 'other';

/** All available memory layers */
export const MEMORY_LAYERS: MemoryLayer[] = [
	'controller', 'service', 'repository', 'model', 'middleware',
	'migration', 'config', 'util', 'view', 'component', 'other',
];

/** Commit types (conventional commits) */
export type MemoryCommitType =
	| 'feat'
	| 'fix'
	| 'refactor'
	| 'docs'
	| 'test'
	| 'chore'
	| 'style'
	| 'perf'
	| 'ci'
	| 'build'
	| 'revert'
	| 'other';

/** File change types */
export type MemoryFileChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

/** AI analysis depth levels */
export type MemoryAnalysisDepth = 'minimal' | 'standard' | 'deep';

/** Notification types */
export type MemoryNotificationType = 'info' | 'statusbar' | 'silent';

/** Architecture impact level (0-10) */
export type ArchitectureImpactScore = number;

// ---- Core Data Models ----

/** Metadata of a single Git commit stored in memory */
export interface MemoryCommit {
	/** SHA hash of the commit */
	sha: string;
	/** Author name */
	author: string;
	/** Author email */
	email: string;
	/** ISO date string of the commit */
	date: string;
	/** Branch the commit was made on */
	branch: string;
	/** Repository name (folder name) */
	repository: string;
	/** Parent commit SHA */
	parentSha: string;
	/** Classified commit type */
	commitType: MemoryCommitType;
	/** Commit message */
	message: string;
}

/** A single file change within a commit */
export interface MemoryFileChange {
	/** Auto-generated ID */
	id?: number;
	/** SHA of the parent commit */
	commitSha: string;
	/** File path relative to repository root */
	filePath: string;
	/** Type of change */
	changeType: MemoryFileChangeType;
	/** Unified diff content (may be truncated) */
	diff: string;
}

/** AI analysis result for a commit */
export interface MemoryAnalysis {
	/** Auto-generated ID */
	id?: number;
	/** SHA of the analysed commit */
	commitSha: string;
	/** Short summary of changes */
	summary: string;
	/** Key insights extracted by AI */
	keyInsights: string[];
	/** List of affected components/modules */
	components: string[];
	/** Change categories */
	categories: MemoryCategory[];
	/** Extracted keywords for search */
	keywords: string[];
	/** Description of architectural impact */
	architectureImpact: string;
	/** Architecture impact score 0-10 */
	architectureImpactScore: ArchitectureImpactScore;
	/** Affected architecture layers */
	layers: MemoryLayer[];
	/** Affected business domains */
	businessDomains: string[];
	/** Whether this commit contains breaking changes */
	isBreakingChange: boolean;
	/** ISO date string of analysis creation */
	createdAt: string;
}

/** Vector embedding for semantic search */
export interface MemoryEmbedding {
	/** Auto-generated ID */
	id?: number;
	/** SHA of the related commit */
	commitSha: string;
	/** Raw vector as Float32Array (384 dimensions for MiniLM) */
	vector: Float32Array;
	/** Source text used to generate the embedding */
	text: string;
	/** ISO date string */
	createdAt: string;
}

/** Knowledge graph node (component relationship) */
export interface MemoryKnowledgeNode {
	/** Auto-generated ID */
	id?: number;
	/** Source component name */
	sourceComponent: string;
	/** Target component name */
	targetComponent: string;
	/** Type of relation (uses, extends, imports, calls) */
	relationType: string;
	/** Commit where this relation was detected */
	commitSha: string;
}

/** Bug-fix relationship */
export interface MemoryBugRelation {
	/** Auto-generated ID */
	id?: number;
	/** SHA of the fix commit */
	fixCommitSha: string;
	/** SHA of the commit that introduced the bug */
	sourceCommitSha: string;
	/** Description of the bug */
	description: string;
}

/** Summary entry (for context compression) */
export interface MemorySummary {
	/** Auto-generated ID */
	id?: number;
	/** Scope: 'daily' | 'weekly' | 'project' */
	scope: string;
	/** Period identifier (YYYY-MM-DD for daily, YYYY-Wxx for weekly, repo name for project) */
	period: string;
	/** Repository name */
	repository: string;
	/** Compressed summary text */
	summary: string;
	/** Number of commits covered */
	commitCount: number;
	/** ISO date string */
	createdAt: string;
	/** ISO date string */
	updatedAt: string;
}

// ---- Filter & Settings ----

/** Filter parameters for querying memory data */
export interface MemoryFilter {
	/** Filter by author names */
	authors?: string[];
	/** Filter by date range start (ISO) */
	dateFrom?: string;
	/** Filter by date range end (ISO) */
	dateTo?: string;
	/** Filter by branch names */
	branches?: string[];
	/** Filter by change categories */
	categories?: MemoryCategory[];
	/** Filter by file path patterns */
	files?: string[];
	/** Filter by keywords */
	keywords?: string[];
	/** Filter by component names */
	components?: string[];
	/** Filter by architecture layers */
	layers?: MemoryLayer[];
	/** Filter by business domains */
	businessDomains?: string[];
	/** Filter by repository names */
	repositories?: string[];
	/** Filter by commit types */
	commitTypes?: MemoryCommitType[];
	/** Text search query */
	searchQuery?: string;
	/** Maximum number of results */
	limit?: number;
	/** Offset for pagination */
	offset?: number;
}

/** Memory system settings (persisted in DB settings table) */
export interface MemorySettings {
	/** Whether memory is enabled */
	enabled: boolean;
	/** AI model family for analysis */
	aiModel: string;
	/** Analysis depth level */
	analysisDepth: MemoryAnalysisDepth;
	/** Maximum diff characters to send to AI */
	diffLimit: number;
	/** Maximum total records in DB */
	maxRecords: number;
	/** Data retention period in days */
	retentionDays: number;
	/** Short-term memory limit (recent commits) */
	shortTermLimit: number;
	/** Whether auto-cleanup is enabled */
	autoCleanup: boolean;
	/** Whether notifications are enabled */
	notificationsEnabled: boolean;
	/** Notification type */
	notificationType: MemoryNotificationType;
	/** Whether vector embeddings are enabled */
	embeddingsEnabled: boolean;
	/** Whether knowledge graph is enabled */
	knowledgeGraphEnabled: boolean;
	/** Fixed HTTP server port (0 = random) */
	httpPort: number;
}

/** Default memory settings */
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
	enabled: true,
	aiModel: 'gpt-4o',
	analysisDepth: 'standard',
	diffLimit: 10000,
	maxRecords: 5000,
	retentionDays: 365,
	shortTermLimit: 50,
	autoCleanup: true,
	notificationsEnabled: true,
	notificationType: 'statusbar',
	embeddingsEnabled: true,
	knowledgeGraphEnabled: true,
	httpPort: 0,
};

// ---- Semantic Search Result ----

/** Result of a semantic or keyword search */
export interface MemorySearchResult {
	/** Commit data */
	commit: MemoryCommit;
	/** AI analysis (if available) */
	analysis?: MemoryAnalysis;
	/** Relevance score (0.0 - 1.0) */
	score: number;
}

// ---- Commit Data from Hook ----

/** Raw commit data received from the git hook via HTTP */
export interface HookCommitPayload {
	/** Commit SHA */
	sha: string;
	/** Author name */
	author: string;
	/** Author email */
	email: string;
	/** ISO date string */
	date: string;
	/** Branch name */
	branch: string;
	/** Repository name */
	repository: string;
	/** Parent commit SHA */
	parentSha: string;
	/** Commit message */
	message: string;
	/** Unified diff of changes */
	diff: string;
	/** Changed files with status */
	files: Array<{
		status: string;
		path: string;
		oldPath?: string;
	}>;
}

// ---- Embedding Model Status ----

/** Status of the embedding model download */
export type EmbeddingModelStatus = 'not-downloaded' | 'downloading' | 'ready' | 'failed';

// ---- Knowledge Graph Visualization ----

/** Node in the knowledge graph visualization */
export interface KnowledgeGraphNode {
	/** Component name */
	id: string;
	/** Display label */
	label: string;
	/** Component type (service, controller, etc.) */
	type: string;
	/** Number of connections */
	weight: number;
}

/** Edge in the knowledge graph visualization */
export interface KnowledgeGraphEdge {
	/** Source component */
	source: string;
	/** Target component */
	target: string;
	/** Relation type */
	type: string;
	/** Number of commits with this relation */
	weight: number;
}

/** Full knowledge graph data for visualization */
export interface KnowledgeGraphData {
	nodes: KnowledgeGraphNode[];
	edges: KnowledgeGraphEdge[];
}

// ---- Statistics ----

/** Aggregated memory statistics */
export interface MemoryStatistics {
	/** Total commits stored */
	totalCommits: number;
	/** Total commits analysed */
	totalAnalyses: number;
	/** Total embeddings generated */
	totalEmbeddings: number;
	/** Database file size in bytes */
	dbSizeBytes: number;
	/** Most active authors */
	topAuthors: Array<{ author: string; count: number }>;
	/** Most changed files */
	hotFiles: Array<{ filePath: string; count: number }>;
	/** Category distribution */
	categoryDistribution: Array<{ category: MemoryCategory; count: number }>;
	/** Commits per day (recent 30 days) */
	commitsPerDay: Array<{ date: string; count: number }>;
}

// ---- WebView Message Types ----

/** Messages from Memory WebView to the extension */
export type MemoryWebviewToExtensionMessage =
	| { type: 'memoryReady' }
	| { type: 'getMemoryCommits'; filter?: MemoryFilter }
	| { type: 'getMemoryCommitDetail'; sha: string }
	| { type: 'openMemoryFile'; repository: string; filePath: string }
	| { type: 'searchMemory'; query: string; filter?: MemoryFilter }
	| { type: 'deleteMemoryCommit'; sha: string }
	| { type: 'clearMemory' }
	| { type: 'runManualAnalysis'; fromCommit?: string; toCommit?: string; limit?: number }
	| { type: 'getMemorySettings' }
	| { type: 'saveMemorySettings'; settings: Partial<MemorySettings> }
	| { type: 'exportMemoryData'; format: 'csv' | 'json'; filter?: MemoryFilter }
	| { type: 'getKnowledgeGraph'; repository?: string }
	| { type: 'getMemoryStatistics' }
	| { type: 'getMemoryCategories' }
	| { type: 'getMemoryAuthors' }
	| { type: 'getMemoryBranches' }
	| { type: 'getMemoryRepositories' };

/** Messages from the extension to Memory WebView */
export type MemoryExtensionToWebviewMessage =
	| { type: 'memoryCommits'; commits: MemoryCommit[]; total: number; filter?: MemoryFilter }
	| { type: 'memoryCommitDetail'; commit: MemoryCommit; fileChanges: MemoryFileChange[]; analysis?: MemoryAnalysis; bugRelations?: MemoryBugRelation[] }
	| { type: 'memorySearchResults'; results: MemorySearchResult[]; query: string }
	| { type: 'memorySettings'; settings: MemorySettings }
	| { type: 'memoryStatistics'; statistics: MemoryStatistics }
	| { type: 'memoryKnowledgeGraph'; data: KnowledgeGraphData }
	| { type: 'memoryCategories'; categories: string[] }
	| { type: 'memoryAuthors'; authors: string[] }
	| { type: 'memoryBranches'; branches: string[] }
	| { type: 'memoryRepositories'; repositories: string[] }
	| { type: 'memoryExportReady'; format: 'csv' | 'json'; data: string }
	| { type: 'memoryAnalysisProgress'; current: number; total: number; message: string }
	| { type: 'memoryAnalysisComplete'; count: number }
	| { type: 'memoryError'; message: string }
	| { type: 'memoryInfo'; message: string }
	| { type: 'memoryCleared' };
