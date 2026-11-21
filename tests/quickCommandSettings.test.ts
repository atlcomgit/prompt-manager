import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { QuickCommandSettings, QUICK_COMMAND_PREFIX, QUICK_COMMAND_TRANSACTION } from '../src/services/quickCommandSettings.js';
import type { DashboardQuickCommand, DashboardQuickCommandsConfiguration } from '../src/types/promptDashboardPreferences.js';

const field = (name: string) => QUICK_COMMAND_PREFIX + '.' + name;
type Settings = Map<string, unknown>;

/** Each client has its own delivered snapshot. A Global write reloads the application settings it actually targets. */
function client(directory: string, disk: Settings, fail?: (key: string, value: unknown) => boolean) {
	let delivered = new Map(disk);
	const read = (key: string) => delivered.get(key);
	const write = async (key: string, value: unknown) => {
		if (fail?.(key, value)) throw new Error('simulated write failure');
		if (value === undefined) disk.delete(key); else disk.set(key, structuredClone(value));
		delivered = new Map(disk);
	};
	const store = new QuickCommandSettings(() => directory, read, write);
	const current = () => {
		const data: Partial<DashboardQuickCommandsConfiguration> = Object.fromEntries(
			['items', 'texts', 'categories'].map(name => [name, read(field(name))]));
		return store.readCommands(data)!;
	};
	return { store, current, deliver: () => { delivered = new Map(disk); },
		save: (base: DashboardQuickCommand[], items: DashboardQuickCommand[]) => store.save({ items }, { items: base }, current) };
}

async function profile(t: TestContext) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quick-command-storage-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

function initial(): Settings {
	return new Map<string, unknown>([[field('items'), ['A', 'B']], [field('texts'), { A: 'old' }]]);
}

/** Independent Tunnel clients sharing server storage must each refresh their own application settings. */
test('independent clients can save repeatedly through one remote storage directory', async t => {
	const dir = await profile(t);
	const a = client(dir, initial());
	const b = client(dir, initial());
	const base = a.current().items;
	await a.save(base, [{ title: 'A', text: 'first' }, base[1]]);
	await b.save(base, [{ title: 'A', text: 'second' }, base[1]]);
	const next = b.current().items;
	await b.save(next, [next[0], { title: 'B', text: 'more' }]);
	assert.equal(a.current().items[0].text, 'first');
	assert.deepEqual(b.current().items.map(item => item.text), ['second', 'more']);
});

/** A coalesced manual change can supersede any intermediate snapshot. Conflicting edits keep the first value. */
test('shared clients merge an unseen newer snapshot and reject conflicting edits to the same field', async t => {
	const dir = await profile(t);
	const disk = initial();
	const a = client(dir, disk);
	const b = client(dir, disk);
	const base = a.current().items;
	await a.save(base, [{ title: 'A', text: 'first' }, base[1]]);
	await assert.rejects(b.save(base, [{ title: 'A', text: 'second' }, base[1]]), /изменилась в другом окне/);
	disk.set(field('texts'), { A: 'ручная правка' });
	await b.save(base, [base[0], { title: 'B', text: 'ещё' }]);
	assert.deepEqual(b.current().items.map(item => item.text), ['ручная правка', 'ещё']);
});

/** A failed text write and even a failed rollback leave a complete, recoverable command for fresh readers. */
test('category and text remain atomic through failure, interrupted rollback, reopen and retry', async t => {
	const dir = await profile(t);
	const disk = initial();
	const a = client(dir, disk, (key, value) => key === field('texts') || (key === field('categories') && value === undefined));
	const base = a.current().items;
	const next = [{ title: 'A', text: 'changed', category: 'new' }, base[1]];
	await assert.rejects(a.save(base, next), /simulated/);
	assert.deepEqual(disk.get(field('categories')), { A: 'new' });
	assert.ok(disk.get(QUICK_COMMAND_TRANSACTION));
	const reopened = client(dir, disk);
	assert.deepEqual(reopened.current().items, base);
	await reopened.save(base, next);
	assert.equal(disk.has(QUICK_COMMAND_TRANSACTION), false);
	assert.deepEqual(reopened.current().items, next);
});

/** A lost confirmation of commit can be retried without an obsolete local checksum or stale aggregate overwrite. */
test('retries repair an interrupted commit before an unrelated stale writer edits B', async t => {
	const dir = await profile(t);
	const disk = initial();
	let rejectCommit = true;
	const a = client(dir, disk, (key, value) => {
		if (key !== QUICK_COMMAND_TRANSACTION || value !== undefined || !rejectCommit) return false;
		rejectCommit = false;
		return true;
	});
	const b = client(dir, disk);
	const base = a.current().items;
	const next = [{ title: 'A', text: 'saved' }, base[1]];
	await assert.rejects(a.save(base, next), /simulated/);
	await a.save(base, next);
	await b.save(base, [base[0], { title: 'B', text: 'saved B' }]);
	assert.deepEqual(b.current().items.map(row => row.text), ['saved', 'saved B']);
});

/** The count and position changes of an old client can reach the host separately or in one Settings Sync snapshot. */
test('legacy rename and reuse do not give the new phrase the old body, including after reopening', async t => {
	const dir = await profile(t);
	const disk: Settings = new Map([[field('items'), ['A']]]);
	const a = client(dir, disk);
	await a.save(a.current().items, [{ title: 'A', text: 'шаблон\n{{taskNumber}}' }]);
	disk.set(field('items'), ['C']);
	a.deliver();
	const renamed = a.current();
	assert.equal(renamed.items[0].text, 'C');
	assert.deepEqual(renamed.recoverableTexts, { A: 'шаблон\n{{taskNumber}}' });
	// Accept the old text explicitly for C. An older client can then reuse A without inheriting it.
	await a.store.save({ items: [{ title: 'C', text: renamed.recoverableTexts!.A }] }, renamed, a.current);
	disk.set(field('items'), ['C', 'A']);
	const b = client(dir, disk);
	assert.deepEqual(b.current().items, [{ title: 'C', text: 'шаблон\n{{taskNumber}}' }, { title: 'A', text: 'A' }]);
	const combined: Settings = new Map([[field('items'), ['A']]]);
	const c = client(dir, combined);
	await c.save(c.current().items, [{ title: 'A', text: 'сохранённый текст' }]);
	combined.set(field('items'), ['C', 'A']);
	const reopened = client(dir, combined);
	const current = reopened.current();
	assert.deepEqual(current.items, [{ title: 'C', text: 'C' }, { title: 'A', text: 'A' }]);
	assert.deepEqual(current.recoverableTexts, { A: 'сохранённый текст' });
	const edited = { ...current, items: [current.items[0], { ...current.items[1], category: 'new' }] };
	await reopened.store.save(edited, current, reopened.current);
	assert.deepEqual(client(dir, combined).current().recoverableTexts, current.recoverableTexts);
});

/** A second server-side directory may point at the same physical client settings, including a local/Tunnel pair. */
test('a different host cannot roll back an active writer in shared application settings', async t => {
	const disk = initial();
	const firstDirectory = await profile(t);
	const secondDirectory = await profile(t);
	const base = client(firstDirectory, disk).current().items;
	let entered!: () => void, resume!: () => void;
	const blocked = new Promise<void>(resolve => { entered = resolve; });
	const released = new Promise<void>(resolve => { resume = resolve; });
	const live = client(firstDirectory, disk);
	const first = new QuickCommandSettings(() => firstDirectory, key => disk.get(key), async (key, value) => {
		if (value === undefined) disk.delete(key); else disk.set(key, structuredClone(value));
		if (key === field('categories')) { entered(); await released; }
		live.deliver();
	});
	const second = client(secondDirectory, disk);
	const saving = first.save({ items: [{ title: 'A', text: 'first', category: 'new' }, base[1]] },
		{ items: base }, live.current);
	await blocked;
	const other = [base[0], { title: 'B', text: 'second' }];
	try { await assert.rejects(second.save(base, other), /другом окне/); } finally { resume(); await saving; }
	await second.save(base, other);
	assert.deepEqual(second.current().items, [{ title: 'A', text: 'first', category: 'new' }, other[1]]);
});

/** Host rebases a single submitted row after fetching the source, even after an order change or a lost reply. */
test('row edit retries against the current order without overwriting other rows or same-field changes', async t => {
	const dir = await profile(t);
	const disk = initial();
	const a = client(dir, disk);
	const b = client(dir, disk);
	const [original] = a.current().items;
	disk.set(field('items'), ['B', 'A', 'extra']);
	const rename = { original, command: { title: 'C', text: 'renamed' } };
	await a.store.edit(rename, a.current);
	await a.store.edit(rename, a.current);
	assert.deepEqual(a.current().items, [{ title: 'B', text: 'B' }, rename.command, { title: 'extra', text: 'extra' }]);
	await b.store.edit({ original: rename.command, command: { ...rename.command, text: 'other' } }, b.current);
	await assert.rejects(a.store.edit({ original: rename.command, command: { ...rename.command, text: 'my draft' } },
		a.current), /изменилась в другом окне/);
	assert.equal(a.current().items[1].text, 'other');
});
