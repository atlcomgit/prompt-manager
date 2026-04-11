import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import initSqlJs, { type Database } from 'sql.js';
import type {
	CodeMapArtifactKind,
	CodeMapBranchArtifactPayload,
	CodeMapFileGroupStat,
	CodeMapInstructionDetail,
	CodeMapInstructionListItem,
	CodeMapInstructionRecord,
	CodeMapInstructionVersion,
	CodeMapJobRecord,
	CodeMapJobStatus,
	CodeMapJobSummary,
	CodeMapStatistics,
	StoredCodeMapBranchArtifact,
	StoredCodeMapInstruction,
} from '../types/codemap.js';

const SCHEMA_VERSION = 3;

export class CodeMapDatabaseService {
	private db: Database | null = null;
	private dbPath = '';

	constructor(private readonly extensionUri: vscode.Uri) { }

	async initialize(workspaceRoot: string): Promise<void> {
		const pmDir = path.join(workspaceRoot, '.vscode', 'prompt-manager');
		this.dbPath = path.join(pmDir, 'codemap.db');

		if (!fs.existsSync(pmDir)) {
			fs.mkdirSync(pmDir, { recursive: true });
		}

		const wasmPath = vscode.Uri.joinPath(this.extensionUri, 'dist', 'sql-wasm.wasm').fsPath;
		const SQL = await initSqlJs({ locateFile: () => wasmPath });

		if (fs.existsSync(this.dbPath)) {
			this.db = new SQL.Database(fs.readFileSync(this.dbPath));
		} else {
			this.db = new SQL.Database();
		}

		this.db.run('PRAGMA journal_mode = WAL;');
		this.db.run('PRAGMA foreign_keys = ON;');
		this.runMigrations();
		this.resetActiveJobs();
		this.save();
	}

	close(): void {
		if (!this.db) {
			return;
		}

		this.save();
		this.db.close();
		this.db = null;
	}

	deleteInstruction(id: number): boolean {
		const db = this.requireDb();
		db.run('DELETE FROM codemap_instructions WHERE id = ?;', [id]);
		this.save();
		return true;
	}

	deleteInstructionsByIds(ids: number[]): number {
		const uniqueIds = Array.from(new Set(ids.filter(id => Number.isFinite(id) && id > 0)));
		if (uniqueIds.length === 0) {
			return 0;
		}

		const db = this.requireDb();
		const placeholders = uniqueIds.map(() => '?').join(', ');
		db.run(`DELETE FROM codemap_instructions WHERE id IN (${placeholders});`, uniqueIds);
		this.save();
		return uniqueIds.length;
	}

	deleteBranchArtifactsByKeys(keys: string[]): number {
		const uniqueKeys = Array.from(new Set(keys.map(item => String(item || '').trim()).filter(Boolean)));
		const db = this.requireDb();
		if (uniqueKeys.length === 0) {
			const count = this.readSingleNumber('SELECT COUNT(*) FROM codemap_branch_artifacts;');
			db.run('DELETE FROM codemap_branch_artifacts;');
			this.save();
			return count;
		}

		const result = db.exec(
			`SELECT repository, branch_name, artifact_kind
			FROM codemap_branch_artifacts;`,
		);
		if (result.length === 0) {
			return 0;
		}

		const idsToDelete = result[0].values
			.map((row) => ({
				repository: String(row[0] || ''),
				branchName: String(row[1] || ''),
				artifactKind: String(row[2] || ''),
			}))
			.filter(item => !uniqueKeys.includes(`${item.repository}::${item.branchName}::${item.artifactKind}`));

		for (const item of idsToDelete) {
			db.run(
				`DELETE FROM codemap_branch_artifacts
				WHERE repository = ?
					AND branch_name = ?
					AND artifact_kind = ?;`,
				[item.repository, item.branchName, item.artifactKind],
			);
		}
		if (idsToDelete.length > 0) {
			this.save();
		}
		return idsToDelete.length;
	}

	listLatestInstructions(): CodeMapInstructionListItem[] {
		const db = this.requireDb();
		const result = db.exec(
			`SELECT
				id,
				repository,
				branch_name,
				resolved_branch_name,
				base_branch_name,
				branch_role,
				instruction_kind,
				locale,
				generated_at,
				updated_at,
				file_count,
				source_commit_sha,
				(
					SELECT COUNT(*)
					FROM codemap_instruction_versions versions
					WHERE versions.instruction_id = codemap_instructions.id
				) AS version_count
			FROM codemap_instructions
			ORDER BY updated_at DESC, generated_at DESC;`,
		);

		if (result.length === 0) {
			return [];
		}

		return result[0].values.map((row) => ({
			id: Number(row[0]),
			repository: String(row[1]),
			branchName: String(row[2]),
			resolvedBranchName: String(row[3]),
			baseBranchName: String(row[4]),
			branchRole: row[5] as CodeMapInstructionListItem['branchRole'],
			instructionKind: row[6] as CodeMapInstructionListItem['instructionKind'],
			locale: String(row[7]),
			generatedAt: String(row[8]),
			updatedAt: String(row[9]),
			fileCount: Number(row[10]),
			sourceCommitSha: String(row[11]),
			versionCount: Number(row[12] || 0),
		}));
	}

	getInstructionById(id: number): StoredCodeMapInstruction | null {
		const db = this.requireDb();
		const result = db.exec(
			`SELECT
				id,
				repository,
				branch_name,
				resolved_branch_name,
				base_branch_name,
				branch_role,
				instruction_kind,
				locale,
				ai_model,
				content_gzip,
				content_hash,
				uncompressed_size,
				compressed_size,
				file_count,
				source_commit_sha,
				generated_at,
				updated_at,
				metadata_json,
				(
					SELECT COUNT(*)
					FROM codemap_instruction_versions versions
					WHERE versions.instruction_id = codemap_instructions.id
				) AS version_count
			FROM codemap_instructions
			WHERE id = ?
			LIMIT 1;`,
			[id],
		);

		if (result.length === 0 || result[0].values.length === 0) {
			return null;
		}

		return this.mapInstructionRow(result[0].values[0]);
	}

	getInstructionVersions(instructionId: number, limit = 20): CodeMapInstructionVersion[] {
		const db = this.requireDb();
		const result = db.exec(
			`SELECT id, instruction_id, content_hash, generated_at, metadata_json
			FROM codemap_instruction_versions
			WHERE instruction_id = ?
			ORDER BY generated_at DESC, id DESC
			LIMIT ?;`,
			[instructionId, limit],
		);

		if (result.length === 0) {
			return [];
		}

		return result[0].values.map((row) => ({
			id: Number(row[0]),
			instructionId: Number(row[1]),
			contentHash: String(row[2]),
			generatedAt: String(row[3]),
			metadata: this.parseMetadata(row[4]),
		}));
	}

	getRecentJobs(limit = 50): CodeMapJobSummary[] {
		const db = this.requireDb();
		const result = db.exec(
			`SELECT id, repository, branch_name, resolved_branch_name, instruction_kind, trigger_type, priority, status, requested_at, started_at, finished_at, error_text, payload_json
			FROM codemap_jobs
			ORDER BY requested_at DESC, id DESC
			LIMIT ?;`,
			[limit],
		);

		if (result.length === 0) {
			return [];
		}

		return result[0].values.map((row) => this.mapJobRow(row));
	}

	getRecentJobsForInstruction(repository: string, branchName: string, instructionKind: CodeMapInstructionRecord['instructionKind'], limit = 20): CodeMapJobSummary[] {
		const db = this.requireDb();
		const result = db.exec(
			`SELECT id, repository, branch_name, resolved_branch_name, instruction_kind, trigger_type, priority, status, requested_at, started_at, finished_at, error_text, payload_json
			FROM codemap_jobs
			WHERE repository = ?
				AND branch_name = ?
				AND instruction_kind = ?
			ORDER BY requested_at DESC, id DESC
			LIMIT ?;`,
			[repository, branchName, instructionKind, limit],
		);

		if (result.length === 0) {
			return [];
		}

		return result[0].values.map((row) => this.mapJobRow(row));
	}

	getInstructionDetail(id: number): CodeMapInstructionDetail | null {
		const instruction = this.getInstructionById(id);
		if (!instruction) {
			return null;
		}

		return {
			instruction,
			versions: this.getInstructionVersions(id),
			recentJobs: this.getRecentJobsForInstruction(instruction.repository, instruction.branchName, instruction.instructionKind),
		};
	}

	getStatistics(): CodeMapStatistics {
		const instructionCount = this.readSingleNumber('SELECT COUNT(*) FROM codemap_instructions;');
		const versionCount = this.readSingleNumber('SELECT COUNT(*) FROM codemap_instruction_versions;');
		const totalJobs = this.readSingleNumber('SELECT COUNT(*) FROM codemap_jobs;');
		const queuedJobs = this.readSingleNumber(`SELECT COUNT(*) FROM codemap_jobs WHERE status = 'queued';`);
		const runningJobs = this.readSingleNumber(`SELECT COUNT(*) FROM codemap_jobs WHERE status = 'running';`);
		const completedJobs = this.readSingleNumber(`SELECT COUNT(*) FROM codemap_jobs WHERE status = 'completed';`);
		const failedJobs = this.readSingleNumber(`SELECT COUNT(*) FROM codemap_jobs WHERE status = 'failed';`);
		const repositories = this.readDistinctStrings('SELECT DISTINCT repository FROM codemap_instructions ORDER BY repository ASC;');
		const branches = this.readDistinctStrings('SELECT DISTINCT branch_name FROM codemap_instructions ORDER BY branch_name ASC;');
		const latestUpdatedAt = this.readSingleString('SELECT updated_at FROM codemap_instructions ORDER BY updated_at DESC LIMIT 1;');
		const allJobs = this.getRecentJobs(Math.max(totalJobs, 1));
		const completedWithDuration = allJobs.filter(job => job.status === 'completed' && (job.totalDurationMs || 0) > 0);
		const completedWithGeneration = allJobs.filter(job => job.status === 'completed' && (job.generationDurationMs || 0) > 0);
		const avgDurationMs = completedWithDuration.length > 0
			? Math.round(completedWithDuration.reduce((sum, job) => sum + (job.totalDurationMs || 0), 0) / completedWithDuration.length)
			: 0;
		const avgGenerationDurationMs = completedWithGeneration.length > 0
			? Math.round(completedWithGeneration.reduce((sum, job) => sum + (job.generationDurationMs || 0), 0) / completedWithGeneration.length)
			: 0;
		const maxDurationMs = completedWithDuration.reduce((max, job) => Math.max(max, job.totalDurationMs || 0), 0);
		const peakHeapUsedBytes = allJobs.reduce((max, job) => Math.max(max, job.peakHeapUsedBytes || 0), 0);
		const aiModels = this.aggregateAiModelStats(allJobs);
		const triggerStats = this.aggregateTriggerStats(allJobs);
		const repositoryStats = this.aggregateRepositoryStats(allJobs);

		return {
			totalInstructions: instructionCount,
			totalVersions: versionCount,
			totalJobs,
			queuedJobs,
			runningJobs,
			completedJobs,
			failedJobs,
			dbSizeBytes: this.dbPath && fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0,
			repositories,
			branches,
			latestUpdatedAt: latestUpdatedAt || undefined,
			avgDurationMs,
			avgGenerationDurationMs,
			maxDurationMs,
			peakHeapUsedBytes,
			aiModels,
			triggerStats,
			repositoryStats,
		};
	}

	getLatestInstruction(
		repository: string,
		branchName: string,
		instructionKind: CodeMapInstructionRecord['instructionKind'],
		locale: string,
	): StoredCodeMapInstruction | null {
		const db = this.requireDb();
		const result = db.exec(
			`SELECT
				id,
				repository,
				branch_name,
				resolved_branch_name,
				base_branch_name,
				branch_role,
				instruction_kind,
				locale,
				ai_model,
				content_gzip,
				content_hash,
				uncompressed_size,
				compressed_size,
				file_count,
				source_commit_sha,
				generated_at,
				updated_at,
				metadata_json,
				(
					SELECT COUNT(*)
					FROM codemap_instruction_versions versions
					WHERE versions.instruction_id = codemap_instructions.id
				) AS version_count
			FROM codemap_instructions
			WHERE repository = ?
				AND branch_name = ?
				AND instruction_kind = ?
				AND locale = ?
			ORDER BY updated_at DESC, generated_at DESC, id DESC
			LIMIT 1;`,
			[repository, branchName, instructionKind, locale],
		);

		if (result.length === 0 || result[0].values.length === 0) {
			return null;
		}

		return this.mapInstructionRow(result[0].values[0]);
	}

	getBranchArtifact(
		repository: string,
		branchName: string,
		artifactKind: CodeMapArtifactKind,
		locale: string,
		generationFingerprint: string,
	): StoredCodeMapBranchArtifact | null {
		if (!generationFingerprint) {
			return null;
		}

		const db = this.requireDb();
		const result = db.exec(
			`SELECT
				repository,
				branch_name,
				artifact_kind,
				locale,
				generation_fingerprint,
				source_snapshot_token,
				tree_sha,
				head_sha,
				based_on_branch_name,
				based_on_snapshot_token,
				payload_gzip,
				payload_hash,
				uncompressed_size,
				compressed_size,
				generated_at,
				updated_at
			FROM codemap_branch_artifacts
			WHERE repository = ?
				AND branch_name = ?
				AND artifact_kind = ?
				AND locale = ?
				AND generation_fingerprint = ?
			LIMIT 1;`,
			[repository, branchName, artifactKind, locale, generationFingerprint],
		);

		if (result.length === 0 || result[0].values.length === 0) {
			return null;
		}

		return this.mapBranchArtifactRow(result[0].values[0]);
	}

	upsertBranchArtifact(
		repository: string,
		branchName: string,
		artifactKind: CodeMapArtifactKind,
		locale: string,
		generationFingerprint: string,
		payload: CodeMapBranchArtifactPayload,
		options: {
			sourceSnapshotToken: string;
			treeSha: string;
			headSha: string;
			basedOnBranchName?: string;
			basedOnSnapshotToken?: string;
			generatedAt: string;
		},
	): StoredCodeMapBranchArtifact | null {
		if (!generationFingerprint) {
			return null;
		}

		const db = this.requireDb();
		const now = new Date().toISOString();
		const encoded = this.encodeCompressedJson(payload);
		db.run(
			`INSERT INTO codemap_branch_artifacts (
				repository,
				branch_name,
				artifact_kind,
				locale,
				generation_fingerprint,
				source_snapshot_token,
				tree_sha,
				head_sha,
				based_on_branch_name,
				based_on_snapshot_token,
				payload_gzip,
				payload_hash,
				uncompressed_size,
				compressed_size,
				generated_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(repository, branch_name, artifact_kind, locale, generation_fingerprint)
			DO UPDATE SET
				source_snapshot_token = excluded.source_snapshot_token,
				tree_sha = excluded.tree_sha,
				head_sha = excluded.head_sha,
				based_on_branch_name = excluded.based_on_branch_name,
				based_on_snapshot_token = excluded.based_on_snapshot_token,
				payload_gzip = excluded.payload_gzip,
				payload_hash = excluded.payload_hash,
				uncompressed_size = excluded.uncompressed_size,
				compressed_size = excluded.compressed_size,
				generated_at = excluded.generated_at,
				updated_at = excluded.updated_at;`,
			[
				repository,
				branchName,
				artifactKind,
				locale,
				generationFingerprint,
				options.sourceSnapshotToken,
				options.treeSha,
				options.headSha,
				options.basedOnBranchName || null,
				options.basedOnSnapshotToken || null,
				encoded.compressed,
				encoded.hash,
				encoded.uncompressedSize,
				encoded.compressedSize,
				options.generatedAt,
				now,
			],
		);
		this.save();
		return this.getBranchArtifact(repository, branchName, artifactKind, locale, generationFingerprint);
	}

	getCachedFileSummary<T>(repository: string, filePath: string, blobSha: string, locale: string, generationFingerprint: string): T | null {
		if (!blobSha || !generationFingerprint) {
			return null;
		}
		const db = this.requireDb();
		const result = db.exec(
			`SELECT summary_gzip, summary_json
			FROM codemap_file_summaries
			WHERE repository = ?
				AND file_path = ?
				AND blob_sha = ?
				AND locale = ?
				AND generation_fingerprint = ?
			LIMIT 1;`,
			[repository, filePath, blobSha, locale, generationFingerprint],
		);
		if (result.length === 0 || result[0].values.length === 0) {
			return null;
		}
		return this.decodeCompressedJson<T>(result[0].values[0][0], result[0].values[0][1]);
	}

	upsertCachedFileSummary(repository: string, filePath: string, blobSha: string, locale: string, generationFingerprint: string, summary: unknown): void {
		if (!blobSha || !generationFingerprint) {
			return;
		}
		const db = this.requireDb();
		const now = new Date().toISOString();
		const encoded = this.encodeCompressedJson(summary || {});
		db.run(
			`INSERT INTO codemap_file_summaries (
				repository,
				file_path,
				blob_sha,
				locale,
				generation_fingerprint,
				summary_gzip,
				summary_json,
				uncompressed_size,
				compressed_size,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(repository, file_path, blob_sha, locale, generation_fingerprint)
			DO UPDATE SET
				summary_gzip = excluded.summary_gzip,
				summary_json = excluded.summary_json,
				uncompressed_size = excluded.uncompressed_size,
				compressed_size = excluded.compressed_size,
				updated_at = excluded.updated_at;`,
			[
				repository,
				filePath,
				blobSha,
				locale,
				generationFingerprint,
				encoded.compressed,
				'{}',
				encoded.uncompressedSize,
				encoded.compressedSize,
				now,
				now,
			],
		);
	}

	getCachedAreaSummary<T>(repository: string, areaKey: string, snapshotToken: string, locale: string, generationFingerprint: string): T | null {
		if (!snapshotToken || !generationFingerprint) {
			return null;
		}
		const db = this.requireDb();
		const result = db.exec(
			`SELECT summary_gzip, summary_json
			FROM codemap_area_summaries
			WHERE repository = ?
				AND area_key = ?
				AND snapshot_token = ?
				AND locale = ?
				AND generation_fingerprint = ?
			LIMIT 1;`,
			[repository, areaKey, snapshotToken, locale, generationFingerprint],
		);
		if (result.length === 0 || result[0].values.length === 0) {
			return null;
		}
		return this.decodeCompressedJson<T>(result[0].values[0][0], result[0].values[0][1]);
	}

	upsertCachedAreaSummary(repository: string, areaKey: string, snapshotToken: string, locale: string, generationFingerprint: string, summary: unknown): void {
		if (!snapshotToken || !generationFingerprint) {
			return;
		}
		const db = this.requireDb();
		const now = new Date().toISOString();
		const encoded = this.encodeCompressedJson(summary || {});
		db.run(
			`INSERT INTO codemap_area_summaries (
				repository,
				area_key,
				snapshot_token,
				locale,
				generation_fingerprint,
				summary_gzip,
				summary_json,
				uncompressed_size,
				compressed_size,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(repository, area_key, snapshot_token, locale, generation_fingerprint)
			DO UPDATE SET
				summary_gzip = excluded.summary_gzip,
				summary_json = excluded.summary_json,
				uncompressed_size = excluded.uncompressed_size,
				compressed_size = excluded.compressed_size,
				updated_at = excluded.updated_at;`,
			[
				repository,
				areaKey,
				snapshotToken,
				locale,
				generationFingerprint,
				encoded.compressed,
				'{}',
				encoded.uncompressedSize,
				encoded.compressedSize,
				now,
				now,
			],
		);
	}

	upsertInstruction(record: CodeMapInstructionRecord, maxVersionsPerInstruction: number): StoredCodeMapInstruction {
		const db = this.requireDb();
		const now = new Date().toISOString();
		const contentBuffer = Buffer.from(record.content, 'utf-8');
		const compressed = gzipSync(contentBuffer);
		const metadataJson = JSON.stringify(record.metadata || {});
		const existing = this.getLatestInstruction(record.repository, record.branchName, record.instructionKind, record.locale);

		if (existing) {
			db.run(
				`UPDATE codemap_instructions
				SET resolved_branch_name = ?,
					base_branch_name = ?,
					branch_role = ?,
					locale = ?,
					ai_model = ?,
					content_gzip = ?,
					content_hash = ?,
					uncompressed_size = ?,
					compressed_size = ?,
					file_count = ?,
					source_commit_sha = ?,
					generated_at = ?,
					updated_at = ?,
					metadata_json = ?
				WHERE id = ?;`,
				[
					record.resolvedBranchName,
					record.baseBranchName,
					record.branchRole,
					record.locale,
					record.aiModel,
					compressed,
					record.contentHash,
					contentBuffer.length,
					compressed.length,
					record.fileCount,
					record.sourceCommitSha,
					record.generatedAt,
					now,
					metadataJson,
					existing.id,
				],
			);
			this.insertVersion(existing.id, compressed, record.contentHash, record.generatedAt, metadataJson);
			this.pruneVersions(existing.id, maxVersionsPerInstruction);
			this.save();
			return this.getLatestInstruction(record.repository, record.branchName, record.instructionKind, record.locale) as StoredCodeMapInstruction;
		}

		db.run(
			`INSERT INTO codemap_instructions (
				repository,
				branch_name,
				resolved_branch_name,
				base_branch_name,
				branch_role,
				instruction_kind,
				locale,
				ai_model,
				content_gzip,
				content_hash,
				uncompressed_size,
				compressed_size,
				file_count,
				source_commit_sha,
				generated_at,
				updated_at,
				metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
			[
				record.repository,
				record.branchName,
				record.resolvedBranchName,
				record.baseBranchName,
				record.branchRole,
				record.instructionKind,
				record.locale,
				record.aiModel,
				compressed,
				record.contentHash,
				contentBuffer.length,
				compressed.length,
				record.fileCount,
				record.sourceCommitSha,
				record.generatedAt,
				now,
				metadataJson,
			],
		);

		const insertedId = Number(db.exec('SELECT last_insert_rowid();')[0].values[0][0]);
		this.insertVersion(insertedId, compressed, record.contentHash, record.generatedAt, metadataJson);
		this.pruneVersions(insertedId, maxVersionsPerInstruction);
		this.save();

		return this.getLatestInstruction(record.repository, record.branchName, record.instructionKind, record.locale) as StoredCodeMapInstruction;
	}

	insertJob(job: CodeMapJobRecord): number {
		const db = this.requireDb();
		db.run(
			`INSERT INTO codemap_jobs (
				repository,
				branch_name,
				resolved_branch_name,
				instruction_kind,
				trigger_type,
				priority,
				status,
				requested_at,
				started_at,
				finished_at,
				error_text,
				payload_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
			[
				job.repository,
				job.branchName,
				job.resolvedBranchName,
				job.instructionKind,
				job.triggerType,
				job.priority,
				job.status,
				job.requestedAt,
				job.startedAt || null,
				job.finishedAt || null,
				job.errorText || null,
				JSON.stringify(job.payload || {}),
			],
		);
		this.save();
		return Number(db.exec('SELECT last_insert_rowid();')[0].values[0][0]);
	}

	updateJobStatus(id: number, status: CodeMapJobStatus, errorText?: string, payload?: Record<string, unknown>): void {
		const db = this.requireDb();
		const now = new Date().toISOString();
		const startedAt = status === 'running' ? now : null;
		const finishedAt = status === 'completed' || status === 'failed' ? now : null;

		db.run(
			`UPDATE codemap_jobs
			SET status = ?,
				started_at = COALESCE(?, started_at),
				finished_at = COALESCE(?, finished_at),
				error_text = ?,
				payload_json = COALESCE(?, payload_json)
			WHERE id = ?;`,
			[status, startedAt, finishedAt, errorText || null, payload ? JSON.stringify(payload) : null, id],
		);
		this.save();
	}

	private resetActiveJobs(): void {
		const db = this.requireDb();
		const now = new Date().toISOString();
		db.run(
			`UPDATE codemap_jobs
			SET status = 'failed',
				finished_at = COALESCE(finished_at, ?),
				error_text = COALESCE(error_text, 'Interrupted before completion')
			WHERE status IN ('queued', 'running');`,
			[now],
		);
	}

	computeContentHash(content: string): string {
		return crypto.createHash('sha256').update(content).digest('hex');
	}

	private runMigrations(): void {
		const db = this.requireDb();
		db.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);');
		const result = db.exec('SELECT version FROM schema_version LIMIT 1;');
		const currentVersion = result.length > 0 && result[0].values.length > 0
			? Number(result[0].values[0][0])
			: 0;

		if (currentVersion < 1) {
			this.migrateV1();
		}
		if (currentVersion < 2) {
			this.migrateV2();
		}
		if (currentVersion < 3) {
			this.migrateV3();
		}

		if (currentVersion === 0) {
			db.run('INSERT INTO schema_version (version) VALUES (?);', [SCHEMA_VERSION]);
		} else if (currentVersion < SCHEMA_VERSION) {
			db.run('UPDATE schema_version SET version = ?;', [SCHEMA_VERSION]);
		}
	}

	private migrateV1(): void {
		const db = this.requireDb();
		db.run(`
			CREATE TABLE IF NOT EXISTS codemap_instructions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				repository TEXT NOT NULL,
				branch_name TEXT NOT NULL,
				resolved_branch_name TEXT NOT NULL,
				base_branch_name TEXT NOT NULL,
				branch_role TEXT NOT NULL,
				instruction_kind TEXT NOT NULL,
				locale TEXT NOT NULL,
				ai_model TEXT NOT NULL,
				content_gzip BLOB NOT NULL,
				content_hash TEXT NOT NULL,
				uncompressed_size INTEGER NOT NULL,
				compressed_size INTEGER NOT NULL,
				file_count INTEGER NOT NULL DEFAULT 0,
				source_commit_sha TEXT NOT NULL DEFAULT '',
				generated_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				metadata_json TEXT NOT NULL DEFAULT '{}'
			);
		`);
		db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_codemap_instructions_unique ON codemap_instructions(repository, branch_name, instruction_kind, locale);');
		db.run(`
			CREATE TABLE IF NOT EXISTS codemap_instruction_versions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				instruction_id INTEGER NOT NULL,
				content_gzip BLOB NOT NULL,
				content_hash TEXT NOT NULL,
				generated_at TEXT NOT NULL,
				metadata_json TEXT NOT NULL DEFAULT '{}',
				FOREIGN KEY (instruction_id) REFERENCES codemap_instructions(id) ON DELETE CASCADE
			);
		`);
		db.run('CREATE INDEX IF NOT EXISTS idx_codemap_versions_instruction ON codemap_instruction_versions(instruction_id, generated_at DESC);');
		db.run(`
			CREATE TABLE IF NOT EXISTS codemap_jobs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				repository TEXT NOT NULL,
				branch_name TEXT NOT NULL,
				resolved_branch_name TEXT NOT NULL,
				instruction_kind TEXT NOT NULL,
				trigger_type TEXT NOT NULL,
				priority TEXT NOT NULL,
				status TEXT NOT NULL,
				requested_at TEXT NOT NULL,
				started_at TEXT,
				finished_at TEXT,
				error_text TEXT,
				payload_json TEXT NOT NULL DEFAULT '{}'
			);
		`);
		db.run('CREATE INDEX IF NOT EXISTS idx_codemap_jobs_lookup ON codemap_jobs(repository, branch_name, instruction_kind, status);');
	}

	private migrateV2(): void {
		const db = this.requireDb();
		db.run(`
			CREATE TABLE IF NOT EXISTS codemap_file_summaries (
				repository TEXT NOT NULL,
				file_path TEXT NOT NULL,
				blob_sha TEXT NOT NULL,
				locale TEXT NOT NULL,
				generation_fingerprint TEXT NOT NULL,
				summary_json TEXT NOT NULL DEFAULT '{}',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (repository, file_path, blob_sha, locale, generation_fingerprint)
			);
		`);
		db.run('CREATE INDEX IF NOT EXISTS idx_codemap_file_summaries_lookup ON codemap_file_summaries(repository, file_path, locale, updated_at DESC);');
		db.run(`
			CREATE TABLE IF NOT EXISTS codemap_area_summaries (
				repository TEXT NOT NULL,
				area_key TEXT NOT NULL,
				snapshot_token TEXT NOT NULL,
				locale TEXT NOT NULL,
				generation_fingerprint TEXT NOT NULL,
				summary_json TEXT NOT NULL DEFAULT '{}',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (repository, area_key, snapshot_token, locale, generation_fingerprint)
			);
		`);
		db.run('CREATE INDEX IF NOT EXISTS idx_codemap_area_summaries_lookup ON codemap_area_summaries(repository, area_key, locale, updated_at DESC);');
	}

	private migrateV3(): void {
		const db = this.requireDb();
		this.ensureColumnExists('codemap_file_summaries', 'summary_gzip', 'BLOB');
		this.ensureColumnExists('codemap_file_summaries', 'uncompressed_size', 'INTEGER NOT NULL DEFAULT 0');
		this.ensureColumnExists('codemap_file_summaries', 'compressed_size', 'INTEGER NOT NULL DEFAULT 0');
		this.ensureColumnExists('codemap_area_summaries', 'summary_gzip', 'BLOB');
		this.ensureColumnExists('codemap_area_summaries', 'uncompressed_size', 'INTEGER NOT NULL DEFAULT 0');
		this.ensureColumnExists('codemap_area_summaries', 'compressed_size', 'INTEGER NOT NULL DEFAULT 0');
		db.run(`
			CREATE TABLE IF NOT EXISTS codemap_branch_artifacts (
				repository TEXT NOT NULL,
				branch_name TEXT NOT NULL,
				artifact_kind TEXT NOT NULL,
				locale TEXT NOT NULL,
				generation_fingerprint TEXT NOT NULL,
				source_snapshot_token TEXT NOT NULL DEFAULT '',
				tree_sha TEXT NOT NULL DEFAULT '',
				head_sha TEXT NOT NULL DEFAULT '',
				based_on_branch_name TEXT,
				based_on_snapshot_token TEXT,
				payload_gzip BLOB NOT NULL,
				payload_hash TEXT NOT NULL,
				uncompressed_size INTEGER NOT NULL DEFAULT 0,
				compressed_size INTEGER NOT NULL DEFAULT 0,
				generated_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (repository, branch_name, artifact_kind, locale, generation_fingerprint)
			);
		`);
		db.run('CREATE INDEX IF NOT EXISTS idx_codemap_branch_artifacts_lookup ON codemap_branch_artifacts(repository, artifact_kind, locale, updated_at DESC);');
		this.backfillCompressedSummaries('codemap_file_summaries');
		this.backfillCompressedSummaries('codemap_area_summaries');
	}

	private insertVersion(instructionId: number, content: Buffer, contentHash: string, generatedAt: string, metadataJson: string): void {
		const db = this.requireDb();
		db.run(
			`INSERT INTO codemap_instruction_versions (
				instruction_id,
				content_gzip,
				content_hash,
				generated_at,
				metadata_json
			) VALUES (?, ?, ?, ?, ?);`,
			[instructionId, content, contentHash, generatedAt, metadataJson],
		);
	}

	private pruneVersions(instructionId: number, maxVersionsPerInstruction: number): void {
		const db = this.requireDb();
		db.run(
			`DELETE FROM codemap_instruction_versions
			WHERE instruction_id = ?
				AND id NOT IN (
					SELECT id
					FROM codemap_instruction_versions
					WHERE instruction_id = ?
					ORDER BY generated_at DESC, id DESC
					LIMIT ?
				);`,
			[instructionId, instructionId, maxVersionsPerInstruction],
		);
	}

	private mapInstructionRow(row: unknown[]): StoredCodeMapInstruction {
		const compressed = Buffer.from(row[9] as Uint8Array);
		return {
			id: Number(row[0]),
			repository: String(row[1]),
			branchName: String(row[2]),
			resolvedBranchName: String(row[3]),
			baseBranchName: String(row[4]),
			branchRole: row[5] as StoredCodeMapInstruction['branchRole'],
			instructionKind: row[6] as StoredCodeMapInstruction['instructionKind'],
			locale: String(row[7]),
			aiModel: String(row[8]),
			content: gunzipSync(compressed).toString('utf-8'),
			contentHash: String(row[10]),
			uncompressedSize: Number(row[11]),
			compressedSize: Number(row[12]),
			fileCount: Number(row[13]),
			sourceCommitSha: String(row[14]),
			generatedAt: String(row[15]),
			updatedAt: String(row[16]),
			metadata: this.parseMetadata(row[17]),
			versionCount: Number(row[18] || 0),
		};
	}

	private mapBranchArtifactRow(row: unknown[]): StoredCodeMapBranchArtifact | null {
		const payload = this.decodeCompressedJson<CodeMapBranchArtifactPayload>(row[10], null);
		if (!payload) {
			return null;
		}

		return {
			repository: String(row[0]),
			branchName: String(row[1]),
			artifactKind: row[2] as StoredCodeMapBranchArtifact['artifactKind'],
			locale: String(row[3]),
			generationFingerprint: String(row[4]),
			sourceSnapshotToken: String(row[5] || ''),
			treeSha: String(row[6] || ''),
			headSha: String(row[7] || ''),
			basedOnBranchName: row[8] ? String(row[8]) : undefined,
			basedOnSnapshotToken: row[9] ? String(row[9]) : undefined,
			payload,
			payloadHash: String(row[11] || ''),
			uncompressedSize: Number(row[12] || 0),
			compressedSize: Number(row[13] || 0),
			generatedAt: String(row[14]),
			updatedAt: String(row[15]),
		};
	}

	private parseMetadata(value: unknown): Record<string, unknown> {
		try {
			return JSON.parse(String(value || '{}')) as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	private parseJsonRecord(value: unknown): Record<string, unknown> | null {
		try {
			const parsed = JSON.parse(String(value || '{}')) as unknown;
			return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
		} catch {
			return null;
		}
	}

	private encodeCompressedJson(value: unknown): { compressed: Buffer; hash: string; uncompressedSize: number; compressedSize: number } {
		const json = JSON.stringify(value || {});
		const input = Buffer.from(json, 'utf-8');
		const compressed = gzipSync(input);
		return {
			compressed,
			hash: this.computeContentHash(json),
			uncompressedSize: input.length,
			compressedSize: compressed.length,
		};
	}

	private decodeCompressedJson<T>(compressedValue: unknown, fallbackJson: unknown): T | null {
		if (compressedValue instanceof Uint8Array || Buffer.isBuffer(compressedValue)) {
			try {
				const compressed = Buffer.from(compressedValue as Uint8Array);
				return JSON.parse(gunzipSync(compressed).toString('utf-8')) as T;
			} catch {
				// Fall through to the legacy JSON column.
			}
		}

		if (typeof fallbackJson === 'string' && fallbackJson.trim()) {
			try {
				return JSON.parse(fallbackJson) as T;
			} catch {
				return null;
			}
		}

		return null;
	}

	private ensureColumnExists(tableName: string, columnName: string, columnDefinition: string): void {
		const db = this.requireDb();
		const result = db.exec(`PRAGMA table_info(${tableName});`);
		const existingColumns = new Set(
			result.length > 0
				? result[0].values.map((row) => String(row[1] || ''))
				: [],
		);
		if (existingColumns.has(columnName)) {
			return;
		}
		db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
	}

	private backfillCompressedSummaries(tableName: 'codemap_file_summaries' | 'codemap_area_summaries'): void {
		const db = this.requireDb();
		const keyColumns = tableName === 'codemap_file_summaries'
			? ['repository', 'file_path', 'blob_sha', 'locale', 'generation_fingerprint']
			: ['repository', 'area_key', 'snapshot_token', 'locale', 'generation_fingerprint'];
		const result = db.exec(
			`SELECT ${keyColumns.join(', ')}, summary_json
			FROM ${tableName}
			WHERE (summary_gzip IS NULL OR length(summary_gzip) = 0)
				AND summary_json IS NOT NULL
				AND TRIM(summary_json) <> '';`,
		);
		if (result.length === 0) {
			return;
		}

		for (const row of result[0].values) {
			const summaryJson = String(row[keyColumns.length] || '').trim();
			if (!summaryJson) {
				continue;
			}
			const encoded = this.encodeCompressedJson(JSON.parse(summaryJson));
			db.run(
				`UPDATE ${tableName}
				SET summary_gzip = ?,
					summary_json = '{}',
					uncompressed_size = ?,
					compressed_size = ?
				WHERE ${keyColumns.map((column) => `${column} = ?`).join(' AND ')};`,
				[
					encoded.compressed,
					encoded.uncompressedSize,
					encoded.compressedSize,
					...row.slice(0, keyColumns.length),
				],
			);
		}
	}

	private mapJobRow(row: unknown[]): CodeMapJobSummary {
		const payload = this.parseMetadata(row[12]);
		return {
			id: Number(row[0]),
			repository: String(row[1]),
			branchName: String(row[2]),
			resolvedBranchName: String(row[3]),
			instructionKind: row[4] as CodeMapJobSummary['instructionKind'],
			triggerType: row[5] as CodeMapJobSummary['triggerType'],
			priority: row[6] as CodeMapJobSummary['priority'],
			status: row[7] as CodeMapJobSummary['status'],
			requestedAt: String(row[8]),
			startedAt: row[9] ? String(row[9]) : undefined,
			finishedAt: row[10] ? String(row[10]) : undefined,
			errorText: row[11] ? String(row[11]) : undefined,
			payload,
			totalDurationMs: toOptionalNumber(payload.totalDurationMs),
			generationDurationMs: toOptionalNumber(payload.generationDurationMs),
			peakHeapUsedBytes: toOptionalNumber(payload.peakHeapUsedBytes),
			instructionChars: toOptionalNumber(payload.instructionChars),
			fileCount: toOptionalNumber(payload.fileCount),
			fileGroups: normalizeFileGroups(payload.fileGroups),
		};
	}

	private aggregateTriggerStats(jobs: CodeMapJobSummary[]): CodeMapStatistics['triggerStats'] {
		const groups = new Map<string, CodeMapStatistics['triggerStats'][number]>();
		for (const job of jobs) {
			const key = job.triggerType;
			const current = groups.get(key) || {
				trigger: job.triggerType,
				total: 0,
				completed: 0,
				failed: 0,
				avgDurationMs: 0,
				avgGenerationDurationMs: 0,
			};
			current.total += 1;
			if (job.status === 'completed') {
				current.completed += 1;
				current.avgDurationMs += job.totalDurationMs || 0;
				current.avgGenerationDurationMs += job.generationDurationMs || 0;
			}
			if (job.status === 'failed') {
				current.failed += 1;
			}
			groups.set(key, current);
		}

		return Array.from(groups.values())
			.map(item => ({
				...item,
				avgDurationMs: item.completed > 0 ? Math.round(item.avgDurationMs / item.completed) : 0,
				avgGenerationDurationMs: item.completed > 0 ? Math.round(item.avgGenerationDurationMs / item.completed) : 0,
			}))
			.sort((left, right) => right.total - left.total);
	}

	private aggregateAiModelStats(jobs: CodeMapJobSummary[]): CodeMapStatistics['aiModels'] {
		const counts = new Map<string, number>();

		for (const job of jobs) {
			const model = typeof job.payload.aiModel === 'string' ? job.payload.aiModel.trim() : '';
			if (!model) {
				continue;
			}
			counts.set(model, (counts.get(model) || 0) + 1);
		}

		if (counts.size === 0) {
			const db = this.requireDb();
			const result = db.exec(
				`SELECT ai_model, COUNT(*) as cnt
				FROM codemap_instructions
				WHERE TRIM(ai_model) <> ''
				GROUP BY ai_model
				ORDER BY cnt DESC, ai_model ASC;`,
			);
			if (result.length === 0) {
				return [];
			}

			return result[0].values.map(value => ({
				model: String(value[0]),
				count: Number(value[1]),
			}));
		}

		return Array.from(counts.entries())
			.map(([model, count]) => ({ model, count }))
			.sort((left, right) => right.count - left.count || left.model.localeCompare(right.model));
	}

	private aggregateRepositoryStats(jobs: CodeMapJobSummary[]): CodeMapStatistics['repositoryStats'] {
		const groups = new Map<string, CodeMapStatistics['repositoryStats'][number]>();
		for (const job of jobs) {
			const key = job.repository;
			const current = groups.get(key) || {
				repository: job.repository,
				total: 0,
				completed: 0,
				failed: 0,
				avgDurationMs: 0,
			};
			current.total += 1;
			if (job.status === 'completed') {
				current.completed += 1;
				current.avgDurationMs += job.totalDurationMs || 0;
			}
			if (job.status === 'failed') {
				current.failed += 1;
			}
			groups.set(key, current);
		}

		return Array.from(groups.values())
			.map(item => ({
				...item,
				avgDurationMs: item.completed > 0 ? Math.round(item.avgDurationMs / item.completed) : 0,
			}))
			.sort((left, right) => right.total - left.total);
	}

	private readSingleNumber(query: string): number {
		const db = this.requireDb();
		const result = db.exec(query);
		if (result.length === 0 || result[0].values.length === 0) {
			return 0;
		}

		return Number(result[0].values[0][0] || 0);
	}

	private readSingleString(query: string): string {
		const db = this.requireDb();
		const result = db.exec(query);
		if (result.length === 0 || result[0].values.length === 0 || !result[0].values[0][0]) {
			return '';
		}

		return String(result[0].values[0][0]);
	}

	private readDistinctStrings(query: string): string[] {
		const db = this.requireDb();
		const result = db.exec(query);
		if (result.length === 0) {
			return [];
		}

		return result[0].values.map((row) => String(row[0])).filter(Boolean);
	}

	private save(): void {
		if (!this.db || !this.dbPath) {
			return;
		}

		fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
	}

	private requireDb(): Database {
		if (!this.db) {
			throw new Error('Code map database is not initialized');
		}

		return this.db;
	}
}

function toOptionalNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	return undefined;
}

function normalizeFileGroups(value: unknown): CodeMapFileGroupStat[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	return value
		.map((item) => {
			if (!item || typeof item !== 'object') {
				return null;
			}

			const group = 'group' in item ? String((item as { group: unknown }).group || '') : '';
			const count = 'count' in item ? Number((item as { count: unknown }).count || 0) : 0;
			if (!group) {
				return null;
			}

			return { group, count };
		})
		.filter((item): item is CodeMapFileGroupStat => Boolean(item));
}
