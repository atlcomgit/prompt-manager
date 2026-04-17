import type { PromptStatus } from '../types/prompt';

export type TimeTrackingBucket = 'writing' | 'task' | 'none';

export class TimeTrackingService {
	static getBucketByStatus(status: PromptStatus): TimeTrackingBucket {
		switch (status) {
			case 'draft':
				return 'writing';
			case 'in-progress':
			case 'completed':
			case 'report':
			case 'review':
				return 'task';
			case 'stopped':
			case 'cancelled':
			case 'closed':
			default:
				return 'none';
		}
	}

	static buildElapsedPatch(status: PromptStatus, elapsedMs: number): { timeSpentWriting?: number; timeSpentOnTask?: number } {
		const deltaMs = Math.max(0, elapsedMs);
		if (deltaMs <= 0) {
			return {};
		}

		switch (TimeTrackingService.getBucketByStatus(status)) {
			case 'writing':
				return { timeSpentWriting: deltaMs };
			case 'task':
				return { timeSpentOnTask: deltaMs };
			case 'none':
			default:
				return {};
		}
	}

	static applyElapsedToPrompt<T extends { status: PromptStatus; timeSpentWriting?: number; timeSpentOnTask?: number }>(
		prompt: T,
		elapsedMs: number,
	): T {
		const patch = TimeTrackingService.buildElapsedPatch(prompt.status, elapsedMs);

		return {
			...prompt,
			timeSpentWriting: (prompt.timeSpentWriting || 0) + (patch.timeSpentWriting || 0),
			timeSpentOnTask: (prompt.timeSpentOnTask || 0) + (patch.timeSpentOnTask || 0),
		};
	}

	static applyElapsedBeforeStatusChange<T extends { status: PromptStatus; timeSpentWriting?: number; timeSpentOnTask?: number }>(
		prompt: T,
		nextStatus: PromptStatus,
		elapsedMs: number,
	): T {
		return {
			...TimeTrackingService.applyElapsedToPrompt(prompt, elapsedMs),
			status: nextStatus,
		};
	}
}
