import type { ChildProcess } from 'child_process';
import * as os from 'os';
import type { BackgroundTaskPriority } from '../types/backgroundTaskPriority.js';

type BackgroundYieldMode = 'checkpoint' | 'between-items';

type PendingChildProcessPromise<T> = Promise<T> & { child?: ChildProcess };

const PRIORITY_WEIGHTS: Record<BackgroundTaskPriority, number> = {
	high: 3,
	normal: 2,
	low: 1,
	lowest: 0,
};

const PRIORITY_SLEEP_MS: Record<BackgroundYieldMode, Record<BackgroundTaskPriority, number>> = {
	checkpoint: {
		high: 0,
		normal: 0,
		low: 5,
		lowest: 20,
	},
	'between-items': {
		high: 0,
		normal: 0,
		low: 50,
		lowest: 150,
	},
};

const PRIORITY_NICE_VALUES: Record<BackgroundTaskPriority, number> = {
	high: typeof os.constants?.priority?.PRIORITY_ABOVE_NORMAL === 'number'
		? os.constants.priority.PRIORITY_ABOVE_NORMAL
		: -5,
	normal: 0,
	low: 10,
	lowest: 19,
};

/** Normalize stored configuration values into shared background priority levels. */
export function normalizeBackgroundTaskPriority(
	value: string | null | undefined,
	fallback: BackgroundTaskPriority = 'normal',
): BackgroundTaskPriority {
	switch ((value || '').trim().toLowerCase()) {
		case 'lowest':
			return 'lowest';
		case 'lower':
		case 'low':
			return 'low';
		case 'higher':
		case 'high':
			return 'high';
		case 'normal':
			return 'normal';
		default:
			return fallback;
	}
}

/** Serialize shared priorities back to settings-friendly labels. */
export function serializeBackgroundTaskPriority(priority: BackgroundTaskPriority): string {
	switch (priority) {
		case 'lowest':
			return 'lowest';
		case 'low':
			return 'lower';
		case 'high':
			return 'higher';
		default:
			return 'normal';
	}
}

/** Return a numeric weight so queues keep higher-priority work ahead of lower-priority work. */
export function getBackgroundTaskPriorityWeight(priority: BackgroundTaskPriority): number {
	return PRIORITY_WEIGHTS[priority] ?? PRIORITY_WEIGHTS.normal;
}

/** Compare two priorities using the shared queue ordering. */
export function compareBackgroundTaskPriority(
	left: BackgroundTaskPriority,
	right: BackgroundTaskPriority,
): number {
	return getBackgroundTaskPriorityWeight(left) - getBackgroundTaskPriorityWeight(right);
}

/** Apply an OS-level priority to a spawned child process when possible. */
export function applyPriorityToChildProcess(
	child: ChildProcess | undefined | null,
	priority: BackgroundTaskPriority,
): void {
	if (!child?.pid || priority === 'normal') {
		return;
	}

	try {
		os.setPriority(child.pid, PRIORITY_NICE_VALUES[priority] ?? PRIORITY_NICE_VALUES.normal);
	} catch {
		// Ignore unsupported platforms and permission restrictions.
	}
}

/** Attach background priority to a promisified execFile call without changing its result type. */
export function applyPriorityToExecFilePromise<T>(
	pending: PendingChildProcessPromise<T>,
	priority: BackgroundTaskPriority,
): PendingChildProcessPromise<T> {
	applyPriorityToChildProcess(pending.child, priority);
	return pending;
}

/** Yield between background chunks so foreground work keeps CPU time first. */
export async function yieldForBackgroundTask(
	priority: BackgroundTaskPriority,
	mode: BackgroundYieldMode = 'checkpoint',
): Promise<void> {
	const delayMs = PRIORITY_SLEEP_MS[mode][priority] ?? 0;
	if (delayMs <= 0) {
		return;
	}

	await new Promise<void>(resolve => setTimeout(resolve, delayMs));
}