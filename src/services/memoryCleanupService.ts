/**
 * MemoryCleanupService — Automatic data cleanup for project memory.
 * Handles cleanup by age, by record count, and by DB size.
 * Runs at extension activation and on configurable intervals.
 */

import * as vscode from 'vscode';
import { MemoryDatabaseService } from './memoryDatabaseService.js';

/** Interval for periodic cleanup check (1 hour) */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export class MemoryCleanupService {
	/** Reference to the periodic timer */
	private timer: ReturnType<typeof setInterval> | null = null;
	/** Database service instance */
	private dbService: MemoryDatabaseService;

	constructor(dbService: MemoryDatabaseService) {
		this.dbService = dbService;
	}

	/**
	 * Start automatic cleanup based on extension configuration.
	 * Runs immediately once, then periodically.
	 */
	start(): void {
		this.runCleanup();
		this.timer = setInterval(() => this.runCleanup(), CLEANUP_INTERVAL_MS);
	}

	/** Stop periodic cleanup */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Execute cleanup based on current settings.
	 * Respects promptManager.memory.autoCleanup configuration.
	 */
	runCleanup(): void {
		const config = vscode.workspace.getConfiguration('promptManager.memory');
		const autoCleanup = config.get<boolean>('autoCleanup', true);

		if (!autoCleanup) { return; }

		const retentionDays = config.get<number>('retentionDays', 365);
		const maxRecords = config.get<number>('maxRecords', 5000);

		// Clean by age
		if (retentionDays > 0) {
			this.cleanByAge(retentionDays);
		}

		// Clean by record count
		if (maxRecords > 0) {
			this.cleanByCount(maxRecords);
		}
	}

	/**
	 * Delete records older than the specified number of days.
	 * @returns Number of deleted records
	 */
	cleanByAge(maxDays: number): number {
		return this.dbService.deleteOlderThan(maxDays);
	}

	/**
	 * Keep only the most recent N records, delete the rest.
	 * @returns Number of deleted records
	 */
	cleanByCount(maxRecords: number): number {
		return this.dbService.keepRecentCommits(maxRecords);
	}

	/**
	 * Delete records until DB size is under the target.
	 * Deletes oldest commits in batches of 100.
	 * @param maxSizeMb Target maximum size in MB
	 * @returns Total number of deleted records
	 */
	cleanBySize(maxSizeMb: number): number {
		const targetBytes = maxSizeMb * 1024 * 1024;
		let deleted = 0;

		while (this.dbService.getDbSize() > targetBytes) {
			const removed = this.dbService.keepRecentCommits(
				Math.max(0, this.dbService.getCommitCount() - 100),
			);
			if (removed === 0) { break; }
			deleted += removed;
			this.dbService.vacuum();
		}

		return deleted;
	}

	/** Dispose resources */
	dispose(): void {
		this.stop();
	}
}
