import * as vscode from 'vscode';
import { getCodeMapSettings } from './codeMapConfig.js';
import type { CodeMapBranchResolution, CodeMapInstructionKind, CodeMapRuntimeCycle, CodeMapRuntimeEvent, CodeMapRuntimePhase, CodeMapRuntimeState, CodeMapRuntimeTask, CodeMapUpdatePriority, CodeMapUpdateTrigger } from '../types/codemap.js';
import { CodeMapDatabaseService } from './codeMapDatabaseService.js';
import { CodeMapInstructionService } from './codeMapInstructionService.js';
import { getPromptManagerOutputChannel } from '../utils/promptManagerOutput.js';
import {
	getBackgroundTaskPriorityWeight,
	yieldForBackgroundTask,
} from '../utils/backgroundTaskPriority.js';

interface QueueItem {
	jobId: number;
	requestedAt: string;
	startedAt?: string;
	resolution: CodeMapBranchResolution;
	instructionKind: CodeMapInstructionKind;
	aiModel?: string;
	trigger: CodeMapUpdateTrigger;
	priority: CodeMapUpdatePriority;
	phase: CodeMapRuntimePhase;
	detail?: string;
	progressCurrent?: number;
	progressTotal?: number;
}

const MAX_RUNTIME_EVENTS = 80;

export class CodeMapOrchestratorService {
	private readonly output = getPromptManagerOutputChannel();
	private readonly pendingKeys = new Set<string>();
	private readonly queue: QueueItem[] = [];
	private readonly recentEvents: CodeMapRuntimeEvent[] = [];
	private isProcessing = false;
	private lastActivityAt = '';
	private currentItem: QueueItem | null = null;
	private cycle: CodeMapRuntimeCycle = {
		queuedTotal: 0,
		startedTotal: 0,
		completedTotal: 0,
		failedTotal: 0,
	};

	constructor(
		private readonly db: CodeMapDatabaseService,
		private readonly instructionService: CodeMapInstructionService,
	) { }

	dispose(): void {
	}

	queueInstruction(
		resolution: CodeMapBranchResolution,
		instructionKind: CodeMapInstructionKind,
		trigger: CodeMapUpdateTrigger,
		priority: CodeMapUpdatePriority,
	): boolean {
		if (!String(getCodeMapSettings().aiModel || '').trim()) {
			this.output.appendLine(`[codemap] skipped ${resolution.repository}:${instructionKind} (${trigger}) because no AI model is selected`);
			return false;
		}

		const dedupeKey = this.getDedupeKey(resolution.repository, instructionKind === 'base' ? resolution.resolvedBranchName : resolution.currentBranch, instructionKind);
		if (this.pendingKeys.has(dedupeKey)) {
			return false;
		}

		if (!this.isProcessing && this.queue.length === 0 && !this.currentItem) {
			this.cycle = {
				queuedTotal: 0,
				startedTotal: 0,
				completedTotal: 0,
				failedTotal: 0,
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			this.recentEvents.length = 0;
		}

		const branchName = instructionKind === 'base' ? resolution.resolvedBranchName : resolution.currentBranch;
		const requestedAt = new Date().toISOString();
		const jobId = this.db.insertJob({
			repository: resolution.repository,
			branchName,
			resolvedBranchName: resolution.resolvedBranchName,
			instructionKind,
			triggerType: trigger,
			priority,
			status: 'queued',
			requestedAt,
		});

		this.pendingKeys.add(dedupeKey);
		this.touchActivity();
		const item: QueueItem = {
			jobId,
			requestedAt,
			resolution,
			instructionKind,
			trigger,
			priority,
			phase: 'queued',
		};
		const priorityWeight = getBackgroundTaskPriorityWeight(priority);
		const insertAt = this.queue.findIndex(existing => getBackgroundTaskPriorityWeight(existing.priority) < priorityWeight);
		if (insertAt >= 0) {
			this.queue.splice(insertAt, 0, item);
		} else {
			this.queue.push(item);
		}
		this.cycle.queuedTotal += 1;
		this.cycle.updatedAt = requestedAt;
		this.pushEvent({
			at: requestedAt,
			level: 'info',
			message: `Queued ${resolution.repository}:${branchName} (${instructionKind})`,
			jobId,
			repository: resolution.repository,
			branchName,
			phase: 'queued',
		});

		void this.processQueue();
		return true;
	}

	getRuntimeState(): CodeMapRuntimeState {
		const pendingCount = this.queue.length + (this.currentItem ? 1 : 0);
		return {
			pendingCount,
			queuedCount: this.queue.length,
			runningCount: this.currentItem ? 1 : 0,
			isProcessing: this.isProcessing,
			lastActivityAt: this.lastActivityAt || undefined,
			currentTask: this.currentItem ? this.toRuntimeTask(this.currentItem, 'running') : undefined,
			queuedTasks: this.queue.map(item => this.toRuntimeTask(item, 'queued')),
			scheduledRealtimeRefreshes: [],
			recentEvents: [...this.recentEvents],
			cycle: { ...this.cycle },
		};
	}

	private async processQueue(): Promise<void> {
		if (this.isProcessing) {
			return;
		}

		this.isProcessing = true;
		this.touchActivity();
		while (this.queue.length > 0) {
			const item = this.queue.shift();
			if (!item) {
				continue;
			}
			this.currentItem = item;
			this.currentItem.startedAt = new Date().toISOString();
			this.currentItem.phase = 'collecting-files';
			this.cycle.startedTotal += 1;
			this.cycle.updatedAt = this.currentItem.startedAt;

			const settings = getCodeMapSettings();
			const resolvedAiModel = await this.instructionService.resolveAiModel(settings.aiModel);
			this.currentItem.aiModel = resolvedAiModel;
			const branchName = item.instructionKind === 'base'
				? item.resolution.resolvedBranchName
				: item.resolution.currentBranch;

			try {
				if (!resolvedAiModel) {
					throw new Error('No AI model selected');
				}

				this.touchActivity();
				const totalStartedAt = Date.now();
				const heapBefore = process.memoryUsage().heapUsed;
				this.db.updateJobStatus(item.jobId, 'running');
				this.pushEvent({
					at: this.currentItem.startedAt,
					level: 'info',
					message: `Started ${item.resolution.repository}:${branchName}`,
					jobId: item.jobId,
					repository: item.resolution.repository,
					branchName,
					phase: 'collecting-files',
				});
				const generationStartedAt = Date.now();
				const record = await this.instructionService.generateInstruction(
					item.resolution,
					item.instructionKind,
					vscode.env.language,
					resolvedAiModel,
					(progress) => this.updateCurrentProgress(progress.stage as CodeMapRuntimePhase, progress.detail, progress.completed, progress.total),
				);
				const generationDurationMs = Date.now() - generationStartedAt;
				record.contentHash = this.db.computeContentHash(record.content);
				this.updateCurrentProgress('persisting-instruction', `${item.resolution.repository}:${branchName}`);
				this.db.upsertInstruction(record, settings.maxVersionsPerInstruction);
				const totalDurationMs = Date.now() - totalStartedAt;
				const heapAfter = process.memoryUsage().heapUsed;
				this.db.updateJobStatus(item.jobId, 'completed', undefined, {
					totalDurationMs,
					generationDurationMs,
					peakHeapUsedBytes: Math.max(heapBefore, heapAfter),
					instructionChars: record.content.length,
					fileCount: record.fileCount,
					fileGroups: Array.isArray(record.metadata?.fileGroups) ? record.metadata?.fileGroups : [],
					aiModel: record.aiModel,
					generatedBy: record.metadata?.generatedBy || 'codemap-bootstrap',
				});
				this.cycle.completedTotal += 1;
				this.cycle.updatedAt = new Date().toISOString();
				this.pushEvent({
					at: this.cycle.updatedAt,
					level: 'success',
					message: `Completed ${item.resolution.repository}:${branchName}`,
					jobId: item.jobId,
					repository: item.resolution.repository,
					branchName,
					phase: 'completed',
				});
				this.touchActivity();
				this.output.appendLine(`[codemap] updated ${item.resolution.repository}:${branchName} (${item.instructionKind}) via ${item.trigger}`);
			} catch (error) {
				this.db.updateJobStatus(item.jobId, 'failed', error instanceof Error ? error.message : String(error), {
					totalDurationMs: 0,
					generationDurationMs: 0,
					peakHeapUsedBytes: process.memoryUsage().heapUsed,
					aiModel: resolvedAiModel,
				});
				this.cycle.failedTotal += 1;
				this.cycle.updatedAt = new Date().toISOString();
				this.pushEvent({
					at: this.cycle.updatedAt,
					level: 'error',
					message: `Failed ${item.resolution.repository}:${branchName}: ${error instanceof Error ? error.message : String(error)}`,
					jobId: item.jobId,
					repository: item.resolution.repository,
					branchName,
					phase: 'failed',
				});
				this.touchActivity();
				this.output.appendLine(`[codemap] failed ${item.resolution.repository}:${branchName} (${item.instructionKind}) -> ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				this.pendingKeys.delete(this.getDedupeKey(item.resolution.repository, branchName, item.instructionKind));
				this.currentItem = null;
				this.touchActivity();
			}

			if (this.queue.length > 0) {
				await yieldForBackgroundTask(settings.updatePriority, 'between-items');
			}

			if (settings.aiDelayMs > 0 && this.queue.length > 0) {
				this.pushEvent({
					at: new Date().toISOString(),
					level: 'info',
					message: `Cooldown ${settings.aiDelayMs}ms before next job`,
					phase: 'cooldown',
				});
				await delay(settings.aiDelayMs);
			}
		}

		this.isProcessing = false;
		this.touchActivity();
	}

	private getDedupeKey(repository: string, branchName: string, instructionKind: CodeMapInstructionKind): string {
		return `${repository}::${branchName}::${instructionKind}`;
	}

	private touchActivity(): void {
		this.lastActivityAt = new Date().toISOString();
	}

	private updateCurrentProgress(
		phase: CodeMapRuntimePhase,
		detail?: string,
		progressCurrent?: number,
		progressTotal?: number,
	): void {
		if (!this.currentItem) {
			return;
		}

		const previousPhase = this.currentItem.phase;
		const previousDetail = this.currentItem.detail;
		const previousProgressCurrent = this.currentItem.progressCurrent;
		const previousProgressTotal = this.currentItem.progressTotal;
		this.currentItem.phase = phase;
		this.currentItem.detail = detail;
		this.currentItem.progressCurrent = progressCurrent;
		this.currentItem.progressTotal = progressTotal;
		if (
			previousPhase !== phase
			|| previousDetail !== detail
			|| previousProgressCurrent !== progressCurrent
			|| previousProgressTotal !== progressTotal
		) {
			const message = buildRuntimeProgressMessage(phase, detail, progressCurrent, progressTotal);
			const branchName = this.currentItem.instructionKind === 'base' ? this.currentItem.resolution.resolvedBranchName : this.currentItem.resolution.currentBranch;
			const latestEvent = this.recentEvents[0];
			if (!latestEvent || latestEvent.jobId !== this.currentItem.jobId || latestEvent.message !== message || latestEvent.phase !== phase) {
				this.pushEvent({
					at: new Date().toISOString(),
					level: 'info',
					message,
					jobId: this.currentItem.jobId,
					repository: this.currentItem.resolution.repository,
					branchName,
					phase,
				});
			}
		}
		this.touchActivity();
	}

	private pushEvent(event: Omit<CodeMapRuntimeEvent, 'id'>): void {
		this.recentEvents.unshift({
			id: `${event.at}-${event.message}`,
			...event,
		});
		if (this.recentEvents.length > MAX_RUNTIME_EVENTS) {
			this.recentEvents.length = MAX_RUNTIME_EVENTS;
		}
		this.touchActivity();
	}

	private toRuntimeTask(item: QueueItem, status: CodeMapRuntimeTask['status']): CodeMapRuntimeTask {
		return {
			jobId: item.jobId,
			repository: item.resolution.repository,
			branchName: item.instructionKind === 'base' ? item.resolution.resolvedBranchName : item.resolution.currentBranch,
			instructionKind: item.instructionKind,
			aiModel: item.aiModel,
			trigger: item.trigger,
			priority: item.priority,
			status,
			phase: item.phase,
			requestedAt: item.requestedAt,
			startedAt: item.startedAt,
			updatedAt: this.lastActivityAt || item.requestedAt,
			detail: item.detail,
			progressCurrent: item.progressCurrent,
			progressTotal: item.progressTotal,
		};
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function buildRuntimeProgressMessage(
	phase: CodeMapRuntimePhase,
	detail?: string,
	progressCurrent?: number,
	progressTotal?: number,
): string {
	const parts = [detail?.trim() || phase];
	if (progressTotal && progressTotal > 0 && progressCurrent !== undefined) {
		parts.push(`${progressCurrent}/${progressTotal}`);
	}
	return parts.filter(Boolean).join(' · ');
}
