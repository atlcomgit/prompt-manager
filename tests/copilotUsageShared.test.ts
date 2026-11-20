import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { accountQuotaCacheRoot } from '../src/services/accountQuotaCache.js';
import { CopilotQuotaCoordinator } from '../src/services/copilotUsageShared.js';

/** Пока владелец ждёт GitHub, другой процесс пропускает опрос, даже при ручном обновлении. */
test('Copilot shares a committed result and excludes concurrent requests across processes', async t => {
	const home = await mkdtemp(path.join(tmpdir(), 'pm-copilot-quota-process-'));
	t.after(() => rm(home, { recursive: true, force: true }));
	const directory = accountQuotaCacheRoot(home);
	const period = '2026-11-01T00:00:00.000Z';
	const coordinator = new CopilotQuotaCoordinator(directory);
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const finish = new Promise<void>(resolve => { release = resolve; });
	const first = coordinator.get('gh-account-a', period, false, async () => {
		entered();
		await finish;
		return { planType: 'Pro', metrics: {
			kind: 'metrics', used: 19, limit: 300, source: 'api', statusText: 'private diagnostic not cached',
		} };
	});
	const worker = [
		'const {CopilotQuotaCoordinator}=require(process.argv[1]);',
		'const [directory, account, period, force]=process.argv.slice(2);',
		'new CopilotQuotaCoordinator(directory).get(account,period,force==="true",async()=>{throw new Error("second upstream request");})',
		'.then(data=>process.stdout.write(JSON.stringify(data))).catch(e=>{console.error(e.message);process.exitCode=1;});',
	].join('\n');
	const readInOtherHost = async (account: string, force: boolean) => {
		const { stdout } = await promisify(execFile)(process.execPath, [
			'-e', worker, require.resolve('../src/services/copilotUsageShared.js'), directory, account, period, String(force),
		], { timeout: 3000 });
		return JSON.parse(stdout);
	};
	try {
		await Promise.race([started, first.then(() => { throw new Error('Copilot never entered refresh'); })]);
		assert.deepEqual(await readInOtherHost('gh-account-a', false), { busy: true, data: null });
		assert.deepEqual(await readInOtherHost('other-account', true), { busy: true, data: null });
	} finally {
		release();
		await first;
	}
	const cached = await readInOtherHost('gh-account-a', false);
	assert.equal(cached.data.metrics.used, 19);
	assert.equal(cached.data.metrics.limit, 300);
	assert.equal(typeof cached.checkedAt, 'number');
	const [file] = await readdir(directory);
	assert.doesNotMatch(file + await readFile(path.join(directory, file), 'utf8'), /gh-account-a|private diagnostic/);
});
