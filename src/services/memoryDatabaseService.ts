/**
 * MemoryDatabaseService — Repository layer for project memory.
 * Uses sql.js (SQLite over WASM) for local persistent storage.
 * Handles schema migrations, CRUD operations, backup/restore,
 * and automatic .gitignore management.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { type Database } from 'sql.js';
import type {
	MemoryCommit,
	MemoryFileChange,
	MemoryAnalysis,
	MemoryEmbedding,
	MemoryKnowledgeNode,
	MemoryBugRelation,
	MemorySummary,
	MemoryFilter,
	MemorySettings,
	MemoryStatistics,
	MemoryCategory,
	KnowledgeGraphData,
	DEFAULT_MEMORY_SETTINGS,
} from '../types/memory.js';
import type { RawKnowledgeGraphCommitFile, RawKnowledgeGraphRecord } from '../utils/knowledgeGraph.js';
import { buildKnowledgeGraphData } from '../utils/knowledgeGraph.js';
import { logMemoryGraphDebug } from '../utils/memoryGraphDebug.js';

/** Current schema version — increment when adding migrations */
const SCHEMA_VERSION = 3;

/** Maximum number of backup files to keep */
const MAX_BACKUPS = 3;

export class MemoryDatabaseService {
	/** sql.js database instance */
	private db: Database | null = null;
	/** Path to the database file */
	private dbPath: string = '';
	/** Extension URI for locating WASM */
	private extensionUri: vscode.Uri;

	constructor(extensionUri: vscode.Uri) {
		this.extensionUri = extensionUri;
	}

	// ---- Initialization ----

	/**
	 * Initialize the database: open or create, run migrations, manage .gitignore.
	 * @param workspaceRoot Workspace root path
	 */
	async initialize(workspaceRoot: string): Promise<void> {
		const pmDir = path.join(workspaceRoot, '.vscode', 'prompt-manager');
		this.dbPath = path.join(pmDir, 'memory.db');

		// Ensure directory exists
		if (!fs.existsSync(pmDir)) {
			fs.mkdirSync(pmDir, { recursive: true });
		}

		// Load WASM and open/create database
		const wasmPath = vscode.Uri.joinPath(this.extensionUri, 'dist', 'sql-wasm.wasm').fsPath;
		const SQL = await initSqlJs({
			locateFile: () => wasmPath,
		});

		if (fs.existsSync(this.dbPath)) {
			const buffer = fs.readFileSync(this.dbPath);
			this.db = new SQL.Database(buffer);
		} else {
			this.db = new SQL.Database();
		}

		// Enable WAL mode for better concurrent access
		this.db.run('PRAGMA journal_mode = WAL;');
		this.db.run('PRAGMA foreign_keys = ON;');

		// Run schema migrations
		this.runMigrations();

		// Persist to disk
		this.save();

		// Ensure .gitignore has memory.db entries
		this.ensureGitignore(workspaceRoot);
	}

	/**
	 * Run schema migrations based on current version.
	 */
	private runMigrations(): void {
		if (!this.db) { return; }

		// Create schema_version table if not exists
		this.db.run(`
			CREATE TABLE IF NOT EXISTS schema_version (
				version INTEGER NOT NULL
			);
		`);

		// Get current version
		const result = this.db.exec('SELECT version FROM schema_version LIMIT 1;');
		let currentVersion = 0;
		if (result.length > 0 && result[0].values.length > 0) {
			currentVersion = result[0].values[0][0] as number;
		}

		// Apply migrations
		if (currentVersion < 1) {
			this.migrateV1();
		}
		if (currentVersion < 2) {
			this.migrateV2();
		}
		if (currentVersion < 3) {
			this.migrateV3();
		}

		// Update version
		if (currentVersion === 0) {
			this.db.run('INSERT INTO schema_version (version) VALUES (?);', [SCHEMA_VERSION]);
		} else if (currentVersion < SCHEMA_VERSION) {
			this.db.run('UPDATE schema_version SET version = ?;', [SCHEMA_VERSION]);
		}
	}

	/**
	 * Schema version 1: initial tables.
	 */
	private migrateV1(): void {
		if (!this.db) { return; }

		this.db.run(`
			CREATE TABLE IF NOT EXISTS commits (
				sha TEXT PRIMARY KEY,
				author TEXT NOT NULL,
				email TEXT NOT NULL,
				date TEXT NOT NULL,
				branch TEXT NOT NULL,
				repository TEXT NOT NULL,
				parentSha TEXT NOT NULL DEFAULT '',
				commitType TEXT NOT NULL DEFAULT 'other',
				message TEXT NOT NULL DEFAULT ''
			);
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS file_changes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				commitSha TEXT NOT NULL,
				filePath TEXT NOT NULL,
				changeType TEXT NOT NULL,
				diff TEXT NOT NULL DEFAULT '',
				FOREIGN KEY (commitSha) REFERENCES commits(sha) ON DELETE CASCADE
			);
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS analyses (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				commitSha TEXT NOT NULL UNIQUE,
				summary TEXT NOT NULL DEFAULT '',
				keyInsights TEXT NOT NULL DEFAULT '[]',
				components TEXT NOT NULL DEFAULT '[]',
				categories TEXT NOT NULL DEFAULT '[]',
				keywords TEXT NOT NULL DEFAULT '[]',
				architectureImpact TEXT NOT NULL DEFAULT '',
				architectureImpactScore INTEGER NOT NULL DEFAULT 0,
				layers TEXT NOT NULL DEFAULT '[]',
				businessDomains TEXT NOT NULL DEFAULT '[]',
				isBreakingChange INTEGER NOT NULL DEFAULT 0,
				createdAt TEXT NOT NULL,
				FOREIGN KEY (commitSha) REFERENCES commits(sha) ON DELETE CASCADE
			);
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS embeddings (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				commitSha TEXT NOT NULL,
				vector BLOB NOT NULL,
				text TEXT NOT NULL DEFAULT '',
				createdAt TEXT NOT NULL,
				FOREIGN KEY (commitSha) REFERENCES commits(sha) ON DELETE CASCADE
			);
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS knowledge_graph (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				sourceComponent TEXT NOT NULL,
				targetComponent TEXT NOT NULL,
				relationType TEXT NOT NULL,
				commitSha TEXT NOT NULL,
				FOREIGN KEY (commitSha) REFERENCES commits(sha) ON DELETE CASCADE
			);
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS bug_relations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				fixCommitSha TEXT NOT NULL,
				sourceCommitSha TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				FOREIGN KEY (fixCommitSha) REFERENCES commits(sha) ON DELETE CASCADE
			);
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS summaries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				scope TEXT NOT NULL,
				period TEXT NOT NULL,
				repository TEXT NOT NULL,
				summary TEXT NOT NULL DEFAULT '',
				commitCount INTEGER NOT NULL DEFAULT 0,
				createdAt TEXT NOT NULL,
				updatedAt TEXT NOT NULL
			);
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);

		// Create indexes for common queries
		this.db.run('CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(date);');
		this.db.run('CREATE INDEX IF NOT EXISTS idx_commits_repo ON commits(repository);');
		this.db.run('CREATE INDEX IF NOT EXISTS idx_commits_branch ON commits(branch);');
		this.db.run('CREATE INDEX IF NOT EXISTS idx_commits_author ON commits(author);');
		this.db.run('CREATE INDEX IF NOT EXISTS idx_file_changes_commit ON file_changes(commitSha);');
		this.db.run('CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes(filePath);');
		this.db.run('CREATE INDEX IF NOT EXISTS idx_analyses_commit ON analyses(commitSha);');
		this.db.run('CREATE INDEX IF NOT EXISTS idx_embeddings_commit ON embeddings(commitSha);');
		this.db.run('CREATE INDEX IF NOT EXISTS idx_knowledge_graph_source ON knowledge_graph(sourceComponent);');
		this.db.run('CREATE INDEX IF NOT EXISTS idx_knowledge_graph_target ON knowledge_graph(targetComponent);');
		this.db.run('CREATE INDEX IF NOT EXISTS idx_summaries_scope ON summaries(scope, period, repository);');
	}

	/**
	 * Schema version 2: keep a single embedding per commit.
	 */
	private migrateV2(): void {
		if (!this.db) { return; }

		this.db.run(`
			DELETE FROM embeddings
			WHERE id NOT IN (
				SELECT MAX(id)
				FROM embeddings
				GROUP BY commitSha
			);
		`);

		this.db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_commit_unique ON embeddings(commitSha);');
	}

	/**
	 * Schema version 3: richer metadata for knowledge graph visualization.
	 */
	private migrateV3(): void {
		if (!this.db) { return; }

		this.applyKnowledgeGraphSchemaV3();
	}

	private applyKnowledgeGraphSchemaV3(): boolean {
		if (!this.db) {
			return false;
		}

		let changed = false;
		changed = this.addColumnIfMissing('knowledge_graph', 'sourceKind', "TEXT NOT NULL DEFAULT 'component'") || changed;
		changed = this.addColumnIfMissing('knowledge_graph', 'targetKind', "TEXT NOT NULL DEFAULT 'component'") || changed;
		changed = this.addColumnIfMissing('knowledge_graph', 'sourceLayer', "TEXT NOT NULL DEFAULT ''") || changed;
		changed = this.addColumnIfMissing('knowledge_graph', 'targetLayer', "TEXT NOT NULL DEFAULT ''") || changed;
		changed = this.addColumnIfMissing('knowledge_graph', 'sourceFilePath', "TEXT NOT NULL DEFAULT ''") || changed;
		changed = this.addColumnIfMissing('knowledge_graph', 'targetFilePath', "TEXT NOT NULL DEFAULT ''") || changed;
		changed = this.addColumnIfMissing('knowledge_graph', 'relationStrength', 'INTEGER NOT NULL DEFAULT 1') || changed;
		changed = this.addColumnIfMissing('knowledge_graph', 'confidence', 'REAL NOT NULL DEFAULT 0') || changed;

		this.db.run('CREATE INDEX IF NOT EXISTS idx_knowledge_graph_commit ON knowledge_graph(commitSha);');
		this.db.run('CREATE INDEX IF NOT EXISTS idx_knowledge_graph_source_file ON knowledge_graph(sourceFilePath);');
		this.db.run('CREATE INDEX IF NOT EXISTS idx_knowledge_graph_target_file ON knowledge_graph(targetFilePath);');

		return changed;
	}

	private ensureKnowledgeGraphSchemaCompatibility(): void {
		if (!this.db) {
			return;
		}

		const changed = this.applyKnowledgeGraphSchemaV3();
		const currentVersion = this.getSchemaVersion();
		if (currentVersion < SCHEMA_VERSION) {
			const previousVersion = currentVersion;
			if (currentVersion === 0) {
				this.db.run('INSERT INTO schema_version (version) VALUES (?);', [SCHEMA_VERSION]);
			} else {
				this.db.run('UPDATE schema_version SET version = ?;', [SCHEMA_VERSION]);
			}
			logMemoryGraphDebug('db:knowledgeGraph:schemaUpdated', {
				previousVersion,
				nextVersion: SCHEMA_VERSION,
				columns: Array.from(this.getTableColumns('knowledge_graph')).sort(),
				changed,
			});
			this.save();
			return;
		}

		if (changed) {
			logMemoryGraphDebug('db:knowledgeGraph:schemaPatched', {
				version: currentVersion,
				columns: Array.from(this.getTableColumns('knowledge_graph')).sort(),
			});
			this.save();
		}
	}

	private addColumnIfMissing(tableName: string, columnName: string, sqlType: string): boolean {
		if (!this.db || this.hasColumn(tableName, columnName)) {
			return false;
		}
		this.db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlType};`);
		return true;
	}

	private getSchemaVersion(): number {
		if (!this.db) {
			return 0;
		}
		const result = this.db.exec('SELECT version FROM schema_version LIMIT 1;');
		if (result.length === 0) {
			return 0;
		}
		return Number(result[0].values[0]?.[0] || 0);
	}

	private getTableColumns(tableName: string): Set<string> {
		if (!this.db) {
			return new Set<string>();
		}
		const result = this.db.exec(`PRAGMA table_info(${tableName});`);
		if (result.length === 0) {
			return new Set<string>();
		}
		return new Set<string>(result[0].values.map(value => String(value[1])));
	}

	private hasColumn(tableName: string, columnName: string): boolean {
		return this.getTableColumns(tableName).has(columnName);
	}

	// ---- Persistence ----

	/** Flush database to disk */
	private save(): void {
		if (!this.db || !this.dbPath) { return; }
		const data = this.db.export();
		const buffer = Buffer.from(data);
		fs.writeFileSync(this.dbPath, buffer);
	}

	/** Save and close the database */
	close(): void {
		if (this.db) {
			this.save();
			this.db.close();
			this.db = null;
		}
	}

	// ---- .gitignore management ----

	/**
	 * Ensure .gitignore includes memory.db and backup files.
	 */
	private ensureGitignore(workspaceRoot: string): void {
		const gitignorePath = path.join(workspaceRoot, '.gitignore');
		const entries = ['memory.db', '*.db-backup'];

		let content = '';
		if (fs.existsSync(gitignorePath)) {
			content = fs.readFileSync(gitignorePath, 'utf-8');
		}

		const linesToAdd: string[] = [];
		for (const entry of entries) {
			// Check whether the pattern is anywhere in .gitignore
			const pattern = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			if (!new RegExp(`(^|\\n)\\s*${pattern}\\s*(\\n|$)`).test(content)) {
				linesToAdd.push(entry);
			}
		}

		if (linesToAdd.length > 0) {
			const suffix = content.endsWith('\n') ? '' : '\n';
			const addition = `${suffix}\n# Prompt Manager memory database\n${linesToAdd.join('\n')}\n`;
			fs.writeFileSync(gitignorePath, content + addition, 'utf-8');
		}
	}

	// ---- Backup / Restore ----

	/** Create a backup of the database file */
	backup(): void {
		if (!this.dbPath || !fs.existsSync(this.dbPath)) { return; }
		this.save();
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const backupPath = `${this.dbPath}-backup-${timestamp}`;
		fs.copyFileSync(this.dbPath, backupPath);

		// Cleanup old backups, keep only MAX_BACKUPS
		const dir = path.dirname(this.dbPath);
		const baseName = path.basename(this.dbPath);
		const backups = fs.readdirSync(dir)
			.filter(f => f.startsWith(`${baseName}-backup-`))
			.sort()
			.reverse();

		for (let i = MAX_BACKUPS; i < backups.length; i++) {
			fs.unlinkSync(path.join(dir, backups[i]));
		}
	}

	/** Attempt to restore from the latest backup */
	async restoreFromBackup(workspaceRoot: string): Promise<boolean> {
		const dir = path.dirname(this.dbPath);
		const baseName = path.basename(this.dbPath);
		const backups = fs.readdirSync(dir)
			.filter(f => f.startsWith(`${baseName}-backup-`))
			.sort()
			.reverse();

		if (backups.length === 0) { return false; }

		// Close current DB
		if (this.db) {
			this.db.close();
			this.db = null;
		}

		// Copy backup over the corrupted file
		const latestBackup = path.join(dir, backups[0]);
		fs.copyFileSync(latestBackup, this.dbPath);

		// Re-initialize
		try {
			await this.initialize(workspaceRoot);
			return true;
		} catch {
			return false;
		}
	}

	/** Run VACUUM to optimize database size */
	vacuum(): void {
		if (!this.db) { return; }
		this.db.run('VACUUM;');
		this.save();
	}

	/** Get database file size in bytes */
	getDbSize(): number {
		if (!this.dbPath || !fs.existsSync(this.dbPath)) { return 0; }
		return fs.statSync(this.dbPath).size;
	}

	// ---- Commits CRUD ----

	/** Insert a commit (ignore if already exists) */
	insertCommit(commit: MemoryCommit): void {
		if (!this.db) { return; }
		this.db.run(
			`INSERT OR IGNORE INTO commits (sha, author, email, date, branch, repository, parentSha, commitType, message)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
			[commit.sha, commit.author, commit.email, commit.date, commit.branch,
			commit.repository, commit.parentSha, commit.commitType, commit.message],
		);
		this.save();
	}

	/** Check whether a commit exists */
	hasCommit(sha: string): boolean {
		if (!this.db) { return false; }
		const result = this.db.exec('SELECT 1 FROM commits WHERE sha = ? LIMIT 1;', [sha]);
		return result.length > 0 && result[0].values.length > 0;
	}

	/** Get a single commit by SHA */
	getCommit(sha: string): MemoryCommit | null {
		if (!this.db) { return null; }
		const stmt = this.db.prepare('SELECT * FROM commits WHERE sha = ?;');
		stmt.bind([sha]);
		if (stmt.step()) {
			const row = stmt.getAsObject();
			stmt.free();
			return this.rowToCommit(row);
		}
		stmt.free();
		return null;
	}

	/** Get commits with optional filtering */
	getCommits(filter?: MemoryFilter): { commits: MemoryCommit[]; total: number } {
		if (!this.db) { return { commits: [], total: 0 }; }

		const { where, params } = this.buildCommitWhereClause(filter);
		const limit = filter?.limit ?? 50;
		const offset = filter?.offset ?? 0;

		// Count total
		const countResult = this.db.exec(`SELECT COUNT(*) FROM commits ${where};`, params);
		const total = countResult.length > 0 ? (countResult[0].values[0][0] as number) : 0;

		// Fetch page
		const dataResult = this.db.exec(
			`SELECT * FROM commits ${where} ORDER BY date DESC LIMIT ? OFFSET ?;`,
			[...params, limit, offset],
		);

		const commits: MemoryCommit[] = [];
		if (dataResult.length > 0) {
			const columns = dataResult[0].columns;
			for (const values of dataResult[0].values) {
				const row: Record<string, unknown> = {};
				columns.forEach((col, i) => { row[col] = values[i]; });
				commits.push(this.rowToCommit(row));
			}
		}

		return { commits, total };
	}

	/** Delete a commit and all related data (cascaded) */
	deleteCommit(sha: string): void {
		if (!this.db) { return; }
		this.db.run('DELETE FROM commits WHERE sha = ?;', [sha]);
		this.save();
	}

	/** Delete all data */
	clearAll(): void {
		if (!this.db) { return; }
		this.db.run('DELETE FROM commits;');
		this.db.run('DELETE FROM summaries;');
		this.db.run('DELETE FROM settings;');
		this.save();
	}

	/** Get total number of commits */
	getCommitCount(): number {
		if (!this.db) { return 0; }
		const result = this.db.exec('SELECT COUNT(*) FROM commits;');
		return result.length > 0 ? (result[0].values[0][0] as number) : 0;
	}

	/** Get distinct authors */
	getAuthors(): string[] {
		if (!this.db) { return []; }
		const result = this.db.exec('SELECT DISTINCT author FROM commits ORDER BY author;');
		if (result.length === 0) { return []; }
		return result[0].values.map(v => v[0] as string);
	}

	/** Get distinct branches */
	getBranches(): string[] {
		if (!this.db) { return []; }
		const result = this.db.exec('SELECT DISTINCT branch FROM commits ORDER BY branch;');
		if (result.length === 0) { return []; }
		return result[0].values.map(v => v[0] as string);
	}

	/** Get distinct repositories */
	getRepositories(): string[] {
		if (!this.db) { return []; }
		const result = this.db.exec('SELECT DISTINCT repository FROM commits ORDER BY repository;');
		if (result.length === 0) { return []; }
		return result[0].values.map(v => v[0] as string);
	}

	// ---- File Changes ----

	/** Insert file changes for a commit */
	insertFileChanges(changes: MemoryFileChange[]): void {
		if (!this.db || changes.length === 0) { return; }
		const stmt = this.db.prepare(
			'INSERT INTO file_changes (commitSha, filePath, changeType, diff) VALUES (?, ?, ?, ?);',
		);
		for (const c of changes) {
			stmt.run([c.commitSha, c.filePath, c.changeType, c.diff]);
		}
		stmt.free();
		this.save();
	}

	/** Get file changes for a commit */
	getFileChanges(commitSha: string): MemoryFileChange[] {
		if (!this.db) { return []; }
		const result = this.db.exec(
			'SELECT * FROM file_changes WHERE commitSha = ?;',
			[commitSha],
		);
		if (result.length === 0) { return []; }
		const columns = result[0].columns;
		return result[0].values.map(values => {
			const row: Record<string, unknown> = {};
			columns.forEach((col, i) => { row[col] = values[i]; });
			return {
				id: row['id'] as number,
				commitSha: row['commitSha'] as string,
				filePath: row['filePath'] as string,
				changeType: row['changeType'] as MemoryFileChange['changeType'],
				diff: row['diff'] as string,
			};
		});
	}

	/** Get hot files (most frequently changed) */
	getHotFiles(limit = 20): Array<{ filePath: string; count: number }> {
		if (!this.db) { return []; }
		const result = this.db.exec(
			'SELECT filePath, COUNT(*) as cnt FROM file_changes GROUP BY filePath ORDER BY cnt DESC LIMIT ?;',
			[limit],
		);
		if (result.length === 0) { return []; }
		return result[0].values.map(v => ({
			filePath: v[0] as string,
			count: v[1] as number,
		}));
	}

	// ---- Analyses ----

	/** Insert or update AI analysis for a commit */
	insertAnalysis(analysis: MemoryAnalysis): void {
		if (!this.db) { return; }
		this.db.run(
			`INSERT OR REPLACE INTO analyses
				(commitSha, summary, keyInsights, components, categories, keywords,
				 architectureImpact, architectureImpactScore, layers, businessDomains, isBreakingChange, createdAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
			[
				analysis.commitSha,
				analysis.summary,
				JSON.stringify(analysis.keyInsights),
				JSON.stringify(analysis.components),
				JSON.stringify(analysis.categories),
				JSON.stringify(analysis.keywords),
				analysis.architectureImpact,
				analysis.architectureImpactScore,
				JSON.stringify(analysis.layers),
				JSON.stringify(analysis.businessDomains),
				analysis.isBreakingChange ? 1 : 0,
				analysis.createdAt,
			],
		);
		this.save();
	}

	/** Get analysis for a commit */
	getAnalysis(commitSha: string): MemoryAnalysis | null {
		if (!this.db) { return null; }
		const result = this.db.exec(
			'SELECT * FROM analyses WHERE commitSha = ?;',
			[commitSha],
		);
		if (result.length === 0 || result[0].values.length === 0) { return null; }
		const columns = result[0].columns;
		const row: Record<string, unknown> = {};
		columns.forEach((col, i) => { row[col] = result[0].values[0][i]; });
		return this.rowToAnalysis(row);
	}

	/** Check if analysis exists for a commit */
	hasAnalysis(commitSha: string): boolean {
		if (!this.db) { return false; }
		const result = this.db.exec('SELECT 1 FROM analyses WHERE commitSha = ? LIMIT 1;', [commitSha]);
		return result.length > 0 && result[0].values.length > 0;
	}

	/** Get count of analysed commits */
	getAnalysisCount(): number {
		if (!this.db) { return 0; }
		const result = this.db.exec('SELECT COUNT(*) FROM analyses;');
		return result.length > 0 ? (result[0].values[0][0] as number) : 0;
	}

	/** Get all distinct categories from analyses */
	getCategories(): string[] {
		if (!this.db) { return []; }
		const result = this.db.exec('SELECT categories FROM analyses;');
		if (result.length === 0) { return []; }
		const set = new Set<string>();
		for (const row of result[0].values) {
			const cats = JSON.parse(row[0] as string) as string[];
			cats.forEach(c => set.add(c));
		}
		return Array.from(set).sort();
	}

	// ---- Embeddings ----

	/** Insert a vector embedding */
	insertEmbedding(embedding: MemoryEmbedding): void {
		if (!this.db) { return; }
		const vectorBuffer = Buffer.from(embedding.vector.buffer);
		this.db.run(
			`INSERT INTO embeddings (commitSha, vector, text, createdAt)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(commitSha) DO UPDATE SET
			 	vector = excluded.vector,
			 	text = excluded.text,
			 	createdAt = excluded.createdAt;`,
			[embedding.commitSha, vectorBuffer, embedding.text, embedding.createdAt],
		);
		this.save();
	}

	/** Get all embeddings (for cosine similarity search) */
	getAllEmbeddings(): Array<{ commitSha: string; vector: Float32Array; text: string }> {
		if (!this.db) { return []; }
		const result = this.db.exec(`
			SELECT e.commitSha, e.vector, e.text
			FROM embeddings e
			INNER JOIN (
				SELECT MAX(id) AS id
				FROM embeddings
				GROUP BY commitSha
			) latest ON latest.id = e.id;
		`);
		if (result.length === 0) { return []; }
		return result[0].values.map(v => ({
			commitSha: v[0] as string,
			vector: new Float32Array((v[1] as Uint8Array).buffer),
			text: v[2] as string,
		}));
	}

	/** Get count of embeddings */
	getEmbeddingCount(): number {
		if (!this.db) { return 0; }
		const result = this.db.exec('SELECT COUNT(*) FROM embeddings;');
		return result.length > 0 ? (result[0].values[0][0] as number) : 0;
	}

	/** Check if embedding exists for a commit */
	hasEmbedding(commitSha: string): boolean {
		if (!this.db) { return false; }
		const result = this.db.exec('SELECT 1 FROM embeddings WHERE commitSha = ? LIMIT 1;', [commitSha]);
		return result.length > 0 && result[0].values.length > 0;
	}

	// ---- Knowledge Graph ----

	/** Insert knowledge graph edges */
	insertKnowledgeNodes(nodes: MemoryKnowledgeNode[]): void {
		if (!this.db || nodes.length === 0) { return; }
		this.ensureKnowledgeGraphSchemaCompatibility();
		const stmt = this.db.prepare(
			`INSERT INTO knowledge_graph (
				sourceComponent,
				targetComponent,
				relationType,
				commitSha,
				sourceKind,
				targetKind,
				sourceLayer,
				targetLayer,
				sourceFilePath,
				targetFilePath,
				relationStrength,
				confidence
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		);
		for (const n of nodes) {
			stmt.run([
				n.sourceComponent,
				n.targetComponent,
				n.relationType,
				n.commitSha,
				n.sourceKind || 'component',
				n.targetKind || 'component',
				n.sourceLayer || '',
				n.targetLayer || '',
				n.sourceFilePath || '',
				n.targetFilePath || '',
				n.relationStrength || 1,
				n.confidence || 0,
			]);
		}
		stmt.free();
		this.save();
	}

	/** Get knowledge graph data for visualization */
	getKnowledgeGraph(repository?: string): KnowledgeGraphData {
		if (!this.db) { return buildKnowledgeGraphData([], []); }
		this.ensureKnowledgeGraphSchemaCompatibility();

		const params: (string | number)[] = [];
		const where = repository ? 'WHERE c.repository = ?' : '';
		if (repository) {
			params.push(repository);
		}
		const knowledgeGraphColumns = this.getTableColumns('knowledge_graph');
		const kgColumn = (columnName: string, fallbackSql: string): string => (
			knowledgeGraphColumns.has(columnName)
				? `kg.${columnName} AS ${columnName}`
				: `${fallbackSql} AS ${columnName}`
		);

		const rowsResult = this.db.exec(
			`SELECT
				kg.sourceComponent,
				kg.targetComponent,
				kg.relationType,
				kg.commitSha,
				${kgColumn('sourceKind', "'component'")},
				${kgColumn('targetKind', "'component'")},
				${kgColumn('sourceLayer', "''")},
				${kgColumn('targetLayer', "''")},
				${kgColumn('sourceFilePath', "''")},
				${kgColumn('targetFilePath', "''")},
				${kgColumn('relationStrength', '1')},
				${kgColumn('confidence', '0')},
				c.repository,
				c.date,
				a.architectureImpactScore,
				a.layers,
				a.categories,
				a.businessDomains,
				a.components,
				a.isBreakingChange
			FROM knowledge_graph kg
			JOIN commits c ON kg.commitSha = c.sha
			LEFT JOIN analyses a ON kg.commitSha = a.commitSha
			${where}
			ORDER BY c.date DESC;`,
			params,
		);

		const commitFilesResult = this.db.exec(
			`SELECT fc.commitSha, c.repository, fc.filePath
			FROM file_changes fc
			JOIN commits c ON fc.commitSha = c.sha
			${where};`,
			params,
		);

		const commitFiles = this.rowsToCommitFiles(commitFilesResult);
		const graphRows = this.rowsToKnowledgeGraphRecords(rowsResult);
		const graph = buildKnowledgeGraphData(graphRows, commitFiles);
		logMemoryGraphDebug('db:getKnowledgeGraph:result', {
			repository: repository || null,
			schemaVersion: this.getSchemaVersion(),
			knowledgeGraphColumns: Array.from(this.getTableColumns('knowledge_graph')).sort(),
			rawGraphRows: graphRows.length,
			commitFiles: commitFiles.length,
			nodes: graph.nodes.length,
			edges: graph.edges.length,
			relationTypes: graph.summary.relationTypes,
			repositories: graph.summary.repositories,
			sampleRow: graphRows[0]
				? {
					sourceComponent: graphRows[0].sourceComponent,
					targetComponent: graphRows[0].targetComponent,
					relationType: graphRows[0].relationType,
					sourceKind: graphRows[0].sourceKind || null,
					targetKind: graphRows[0].targetKind || null,
					sourceLayer: graphRows[0].sourceLayer || null,
					targetLayer: graphRows[0].targetLayer || null,
				}
				: null,
		});
		return graph;
	}

	// ---- Bug Relations ----

	/** Insert a bug-fix relation */
	insertBugRelation(relation: MemoryBugRelation): void {
		if (!this.db) { return; }
		this.db.run(
			'INSERT INTO bug_relations (fixCommitSha, sourceCommitSha, description) VALUES (?, ?, ?);',
			[relation.fixCommitSha, relation.sourceCommitSha, relation.description],
		);
		this.save();
	}

	/** Get bug relations for a commit (both as fix and as source) */
	getBugRelations(commitSha: string): MemoryBugRelation[] {
		if (!this.db) { return []; }
		const result = this.db.exec(
			'SELECT * FROM bug_relations WHERE fixCommitSha = ? OR sourceCommitSha = ?;',
			[commitSha, commitSha],
		);
		if (result.length === 0) { return []; }
		const columns = result[0].columns;
		return result[0].values.map(values => {
			const row: Record<string, unknown> = {};
			columns.forEach((col, i) => { row[col] = values[i]; });
			return {
				id: row['id'] as number,
				fixCommitSha: row['fixCommitSha'] as string,
				sourceCommitSha: row['sourceCommitSha'] as string,
				description: row['description'] as string,
			};
		});
	}

	// ---- Summaries ----

	/** Upsert a summary entry */
	upsertSummary(summary: MemorySummary): void {
		if (!this.db) { return; }
		this.db.run(
			`INSERT INTO summaries (scope, period, repository, summary, commitCount, createdAt, updatedAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				summary = excluded.summary,
				commitCount = excluded.commitCount,
				updatedAt = excluded.updatedAt;`,
			[summary.scope, summary.period, summary.repository, summary.summary,
			summary.commitCount, summary.createdAt, summary.updatedAt],
		);
		this.save();
	}

	/** Get summaries by scope and repository */
	getSummaries(scope: string, repository: string, limit = 30): MemorySummary[] {
		if (!this.db) { return []; }
		const result = this.db.exec(
			'SELECT * FROM summaries WHERE scope = ? AND repository = ? ORDER BY period DESC LIMIT ?;',
			[scope, repository, limit],
		);
		if (result.length === 0) { return []; }
		const columns = result[0].columns;
		return result[0].values.map(values => {
			const row: Record<string, unknown> = {};
			columns.forEach((col, i) => { row[col] = values[i]; });
			return {
				id: row['id'] as number,
				scope: row['scope'] as string,
				period: row['period'] as string,
				repository: row['repository'] as string,
				summary: row['summary'] as string,
				commitCount: row['commitCount'] as number,
				createdAt: row['createdAt'] as string,
				updatedAt: row['updatedAt'] as string,
			};
		});
	}

	// ---- Settings ----

	/** Get a setting value */
	getSetting(key: string): string | null {
		if (!this.db) { return null; }
		const result = this.db.exec('SELECT value FROM settings WHERE key = ?;', [key]);
		if (result.length === 0 || result[0].values.length === 0) { return null; }
		return result[0].values[0][0] as string;
	}

	/** Set a setting value */
	setSetting(key: string, value: string): void {
		if (!this.db) { return; }
		this.db.run(
			'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?);',
			[key, value],
		);
		this.save();
	}

	// ---- Statistics ----

	/** Get aggregated memory statistics */
	getStatistics(): MemoryStatistics {
		const totalCommits = this.getCommitCount();
		const totalAnalyses = this.getAnalysisCount();
		const totalEmbeddings = this.getEmbeddingCount();
		const dbSizeBytes = this.getDbSize();
		const topAuthors = this.getTopAuthors();
		const hotFiles = this.getHotFiles(10);
		const categoryDistribution = this.getCategoryDistribution();
		const commitsPerDay = this.getCommitsPerDay(30);

		return {
			totalCommits,
			totalAnalyses,
			totalEmbeddings,
			dbSizeBytes,
			topAuthors,
			hotFiles,
			categoryDistribution,
			commitsPerDay,
		};
	}

	// ---- Cleanup ----

	/** Delete commits older than given days */
	deleteOlderThan(days: number): number {
		if (!this.db) { return 0; }
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
		const countResult = this.db.exec(
			'SELECT COUNT(*) FROM commits WHERE date < ?;',
			[cutoff],
		);
		const count = countResult.length > 0 ? (countResult[0].values[0][0] as number) : 0;
		if (count > 0) {
			this.db.run('DELETE FROM commits WHERE date < ?;', [cutoff]);
			this.save();
		}
		return count;
	}

	/** Keep only the most recent N commits, delete the rest */
	keepRecentCommits(maxCount: number): number {
		if (!this.db) { return 0; }
		const total = this.getCommitCount();
		if (total <= maxCount) { return 0; }

		const deleteCount = total - maxCount;
		this.db.run(
			`DELETE FROM commits WHERE sha IN (
				SELECT sha FROM commits ORDER BY date ASC LIMIT ?
			);`,
			[deleteCount],
		);
		this.save();
		return deleteCount;
	}

	/** Export all data as JSON */
	exportJson(filter?: MemoryFilter): string {
		const { commits } = this.getCommits({ ...filter, limit: 999999 });
		const data = commits.map(commit => {
			const fileChanges = this.getFileChanges(commit.sha);
			const analysis = this.getAnalysis(commit.sha);
			return { commit, fileChanges, analysis };
		});
		return JSON.stringify(data, null, 2);
	}

	/** Export all data as CSV */
	exportCsv(filter?: MemoryFilter): string {
		const { commits } = this.getCommits({ ...filter, limit: 999999 });
		const headers = ['sha', 'author', 'email', 'date', 'branch', 'repository', 'commitType', 'message', 'summary', 'categories', 'keywords'];
		const rows = commits.map(commit => {
			const analysis = this.getAnalysis(commit.sha);
			return [
				commit.sha,
				commit.author,
				commit.email,
				commit.date,
				commit.branch,
				commit.repository,
				commit.commitType,
				`"${commit.message.replace(/"/g, '""')}"`,
				`"${(analysis?.summary || '').replace(/"/g, '""')}"`,
				`"${(analysis?.categories || []).join(', ')}"`,
				`"${(analysis?.keywords || []).join(', ')}"`,
			].join(',');
		});
		return [headers.join(','), ...rows].join('\n');
	}

	// ---- Search (keyword-based fallback) ----

	/** Search commits by keyword in message, summary, and keywords fields */
	searchByKeyword(query: string, limit = 20): MemoryCommit[] {
		if (!this.db || !query.trim()) { return []; }
		const pattern = `%${query.trim()}%`;
		const result = this.db.exec(
			`SELECT DISTINCT c.* FROM commits c
			 LEFT JOIN analyses a ON c.sha = a.commitSha
			 WHERE c.message LIKE ?
				OR a.summary LIKE ?
				OR a.keywords LIKE ?
				OR a.components LIKE ?
			 ORDER BY c.date DESC LIMIT ?;`,
			[pattern, pattern, pattern, pattern, limit],
		);
		if (result.length === 0) { return []; }
		const columns = result[0].columns;
		return result[0].values.map(values => {
			const row: Record<string, unknown> = {};
			columns.forEach((col, i) => { row[col] = values[i]; });
			return this.rowToCommit(row);
		});
	}

	// ---- Private helpers ----

	/** Build WHERE clause from MemoryFilter */
	private buildCommitWhereClause(filter?: MemoryFilter): { where: string; params: (string | number)[] } {
		if (!filter) { return { where: '', params: [] }; }

		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (filter.authors && filter.authors.length > 0) {
			conditions.push(`author IN (${filter.authors.map(() => '?').join(',')})`);
			params.push(...filter.authors);
		}
		if (filter.dateFrom) {
			conditions.push('date >= ?');
			params.push(filter.dateFrom);
		}
		if (filter.dateTo) {
			conditions.push('date <= ?');
			params.push(filter.dateTo);
		}
		if (filter.branches && filter.branches.length > 0) {
			conditions.push(`branch IN (${filter.branches.map(() => '?').join(',')})`);
			params.push(...filter.branches);
		}
		if (filter.repositories && filter.repositories.length > 0) {
			conditions.push(`repository IN (${filter.repositories.map(() => '?').join(',')})`);
			params.push(...filter.repositories);
		}
		if (filter.commitTypes && filter.commitTypes.length > 0) {
			conditions.push(`commitType IN (${filter.commitTypes.map(() => '?').join(',')})`);
			params.push(...filter.commitTypes);
		}
		if (filter.searchQuery) {
			conditions.push('message LIKE ?');
			params.push(`%${filter.searchQuery}%`);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
		return { where, params };
	}

	/** Convert a raw DB row to MemoryCommit */
	private rowToCommit(row: Record<string, unknown>): MemoryCommit {
		return {
			sha: row['sha'] as string,
			author: row['author'] as string,
			email: row['email'] as string,
			date: row['date'] as string,
			branch: row['branch'] as string,
			repository: row['repository'] as string,
			parentSha: (row['parentSha'] as string) || '',
			commitType: (row['commitType'] as MemoryCommit['commitType']) || 'other',
			message: (row['message'] as string) || '',
		};
	}

	/** Convert a raw DB row to MemoryAnalysis */
	private rowToAnalysis(row: Record<string, unknown>): MemoryAnalysis {
		return {
			id: row['id'] as number,
			commitSha: row['commitSha'] as string,
			summary: (row['summary'] as string) || '',
			keyInsights: JSON.parse((row['keyInsights'] as string) || '[]'),
			components: JSON.parse((row['components'] as string) || '[]'),
			categories: JSON.parse((row['categories'] as string) || '[]'),
			keywords: JSON.parse((row['keywords'] as string) || '[]'),
			architectureImpact: (row['architectureImpact'] as string) || '',
			architectureImpactScore: (row['architectureImpactScore'] as number) || 0,
			layers: JSON.parse((row['layers'] as string) || '[]'),
			businessDomains: JSON.parse((row['businessDomains'] as string) || '[]'),
			isBreakingChange: !!(row['isBreakingChange'] as number),
			createdAt: (row['createdAt'] as string) || '',
		};
	}

	private rowsToKnowledgeGraphRecords(result: Array<{ columns: string[]; values: unknown[][] }>): RawKnowledgeGraphRecord[] {
		if (result.length === 0) {
			return [];
		}
		const columns = result[0].columns;
		return result[0].values.map(values => {
			const row: Record<string, unknown> = {};
			columns.forEach((col, index) => {
				row[col] = values[index];
			});
			return {
				sourceComponent: row['sourceComponent'] as string,
				targetComponent: row['targetComponent'] as string,
				relationType: row['relationType'] as string,
				commitSha: row['commitSha'] as string,
				repository: row['repository'] as string,
				commitDate: (row['date'] as string) || undefined,
				sourceKind: (row['sourceKind'] as string) || undefined,
				targetKind: (row['targetKind'] as string) || undefined,
				sourceLayer: (row['sourceLayer'] as string) || undefined,
				targetLayer: (row['targetLayer'] as string) || undefined,
				sourceFilePath: (row['sourceFilePath'] as string) || undefined,
				targetFilePath: (row['targetFilePath'] as string) || undefined,
				relationStrength: Number(row['relationStrength'] || 1),
				confidence: Number(row['confidence'] || 0),
				architectureImpactScore: Number(row['architectureImpactScore'] || 0),
				analysisLayers: this.parseStringArray(row['layers']),
				analysisCategories: this.parseStringArray(row['categories']),
				analysisBusinessDomains: this.parseStringArray(row['businessDomains']),
				analysisComponents: this.parseStringArray(row['components']),
				isBreakingChange: Boolean(row['isBreakingChange']),
			};
		});
	}

	private rowsToCommitFiles(result: Array<{ columns: string[]; values: unknown[][] }>): RawKnowledgeGraphCommitFile[] {
		if (result.length === 0) {
			return [];
		}
		return result[0].values.map(values => ({
			commitSha: values[0] as string,
			repository: values[1] as string,
			filePath: values[2] as string,
		}));
	}

	private parseStringArray(value: unknown): string[] {
		if (typeof value !== 'string' || !value.trim()) {
			return [];
		}
		try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
		} catch {
			return [];
		}
	}

	/** Get top authors by commit count */
	private getTopAuthors(limit = 10): Array<{ author: string; count: number }> {
		if (!this.db) { return []; }
		const result = this.db.exec(
			'SELECT author, COUNT(*) as cnt FROM commits GROUP BY author ORDER BY cnt DESC LIMIT ?;',
			[limit],
		);
		if (result.length === 0) { return []; }
		return result[0].values.map(v => ({
			author: v[0] as string,
			count: v[1] as number,
		}));
	}

	/** Get category distribution from analyses */
	private getCategoryDistribution(): Array<{ category: MemoryCategory; count: number }> {
		if (!this.db) { return []; }
		const result = this.db.exec('SELECT categories FROM analyses;');
		if (result.length === 0) { return []; }
		const counts = new Map<string, number>();
		for (const row of result[0].values) {
			const cats = JSON.parse(row[0] as string) as string[];
			for (const cat of cats) {
				counts.set(cat, (counts.get(cat) || 0) + 1);
			}
		}
		return Array.from(counts.entries())
			.map(([category, count]) => ({ category: category as MemoryCategory, count }))
			.sort((a, b) => b.count - a.count);
	}

	/** Get commits per day for the last N days */
	private getCommitsPerDay(days: number): Array<{ date: string; count: number }> {
		if (!this.db) { return []; }
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
		const result = this.db.exec(
			`SELECT SUBSTR(date, 1, 10) as day, COUNT(*) as cnt
			 FROM commits WHERE date >= ?
			 GROUP BY day ORDER BY day;`,
			[cutoff],
		);
		if (result.length === 0) { return []; }
		return result[0].values.map(v => ({
			date: v[0] as string,
			count: v[1] as number,
		}));
	}
}
