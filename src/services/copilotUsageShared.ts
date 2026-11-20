import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tryLockQuotaRefresh, writeQuotaCacheFile } from './accountQuotaCache.js';

/** GitHub quota metrics with credentials, session text, and local estimates omitted. */
export interface CopilotQuotaMetrics {
	kind: 'metrics';
	used: number;
	limit: number;
	source: 'api' | 'inferred';
	planType?: string;
	snapshots?: Array<{ date: string; used: number; limit: number }>;
	statusText: string;
}

/** Keep authentication errors local to the session whose token was rejected. */
export interface CopilotRemoteQuota {
	planType?: string;
	metrics: CopilotQuotaMetrics | { kind: 'auth-error'; statusText: string } | null;
}

/** A successful quota snapshot for one account and billing period. */
interface CopilotQuotaRecord {
	key: string;
	periodStart: string;
	checkedAt: number;
	planType?: string;
	metrics: CopilotQuotaMetrics;
}

/** Reuse shared snapshots for up to five minutes during automatic refresh. */
const REFRESH_MS = 5 * 60_000;

/** Match local and shared snapshots by a hash of the account identifier. */
export function copilotQuotaAccountKey(accountId: string): string {
	return createHash('sha256').update('pm-copilot-quota-v1\0' + accountId).digest('hex');
}

/** Share GitHub quotas between extension hosts and allow one Copilot refresh per OS user. */
export class CopilotQuotaCoordinator {
	constructor(private readonly directory: string) {}

	/** Validate the account and billing period before restoring a snapshot. */
	private async read(file: string, key: string, periodStart: string): Promise<CopilotQuotaRecord | null> {
		try {
			const record = JSON.parse(await readFile(file, 'utf8')) as CopilotQuotaRecord;
			const metrics = record.metrics;
			if (record.key !== key || record.periodStart !== periodStart || !Number.isFinite(record.checkedAt)
				|| !metrics || metrics.kind !== 'metrics' || !Number.isFinite(metrics.used)
				|| !Number.isFinite(metrics.limit) || !['api', 'inferred'].includes(metrics.source)) return null;
			return {
				...record,
				planType: typeof record.planType === 'string' ? record.planType : undefined,
				metrics: {
					...metrics, planType: typeof metrics.planType === 'string' ? metrics.planType : undefined,
					statusText: 'shared-github-quota',
					snapshots: Array.isArray(metrics.snapshots) ? metrics.snapshots : undefined,
				},
			};
		} catch {
			return null;
		}
	}

	/** Return a shared snapshot or a busy state immediately when another process holds the lock. */
	async get(
		accountId: string,
		periodStart: string,
		force: boolean,
		poll: () => Promise<CopilotRemoteQuota>,
	): Promise<{ data: CopilotRemoteQuota | null; checkedAt?: number; busy?: boolean; polled?: boolean }> {
		const key = copilotQuotaAccountKey(accountId);
		const file = path.join(this.directory, `copilot-quota-${key}.json`);
		/** Treat future timestamps after a clock adjustment as stale. */
		const isFresh = (record: CopilotQuotaRecord) => {
			const age = Date.now() - record.checkedAt;
			return !force && age >= 0 && age < REFRESH_MS;
		};
		const cached = await this.read(file, key, periodStart);
		if (cached && isFresh(cached)) return { data: cached, checkedAt: cached.checkedAt };

		const release = await tryLockQuotaRefresh(this.directory, 'copilot');
		try {
			const newest = await this.read(file, key, periodStart);
			if (!release) return { data: newest, checkedAt: newest?.checkedAt, busy: true };
			if (newest && (newest.checkedAt !== cached?.checkedAt || isFresh(newest))) {
				return { data: newest, checkedAt: newest.checkedAt };
			}
			const data = await poll();
			const checkedAt = Date.now();
			const metrics = data.metrics;
			if (metrics?.kind === 'metrics') {
				await writeQuotaCacheFile(file, {
					key, periodStart, checkedAt, planType: data.planType,
					metrics: {
						kind: 'metrics', used: metrics.used, limit: metrics.limit, source: metrics.source,
						planType: metrics.planType, statusText: 'shared-github-quota',
						snapshots: metrics.snapshots?.slice(-62).map(({ date, used, limit }) => ({ date, used, limit })),
					},
				}).catch(() => undefined);
			} else if (!metrics && newest) {
				return { data: newest, checkedAt: newest.checkedAt, polled: true };
			}
			return { data, checkedAt, polled: true };
		} finally {
			await release?.().catch(() => undefined);
		}
	}
}
