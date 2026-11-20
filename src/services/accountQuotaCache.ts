import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { lock } from 'proper-lockfile';

/** Quotas are shared by one OS user across all VS Code profiles on this host. */
export function accountQuotaCacheRoot(home = homedir()): string {
	return path.join(home, '.vscode', 'prompt-manager', 'quota-cache-v1');
}

/** Allow one refresh per provider across processes and return immediately when busy. */
export async function tryLockQuotaRefresh(directory: string, provider: 'codex' | 'copilot'): Promise<(() => Promise<void>) | null> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Небезопасный каталог кеша квот.');
	try {
		return await lock(directory, {
			lockfilePath: path.join(directory, `${provider}.lock`),
			retries: 0,
			stale: 120_000,
			update: 10_000,
			// Report a compromised lock on release without crashing the Extension Host.
			onCompromised: () => undefined,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return null;
		throw error;
	}
}

/** Replace the complete snapshot atomically while the writer holds the lock. */
export async function writeQuotaCacheFile(file: string, payload: object): Promise<void> {
	const temp = file + '.' + randomUUID() + '.tmp';
	try {
		await fs.writeFile(temp, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
		await fs.rename(temp, file);
	} finally {
		await fs.rm(temp, { force: true }).catch(() => undefined);
	}
}
