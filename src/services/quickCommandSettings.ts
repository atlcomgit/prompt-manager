import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lock } from 'proper-lockfile';
import { refreshUserSettingsSnapshot } from './userSettingsSnapshot.js';
import {
	DASHBOARD_QUICK_COMMAND_LIMIT, DASHBOARD_QUICK_COMMAND_TEXT_LIMIT, DASHBOARD_QUICK_COMMAND_CATEGORY_LIMIT,
	normalizeDashboardQuickCommandsWidgetState, serializeDashboardQuickCommands,
	type DashboardQuickCommand, type DashboardQuickCommandEdit, type DashboardQuickCommandsConfiguration, type DashboardQuickCommandsWidgetState,
} from '../types/promptDashboardPreferences.js';

/** A client writes its own token to obtain a fresh, complete VS Code application configuration snapshot. */
const READ_TOKEN = 'quickCommandStorage.readToken';
export const QUICK_COMMAND_TRANSACTION = 'quickCommandStorage.pending';
export const QUICK_COMMAND_PREFIX = 'dashboardPreferences.quickCommands';
const FIELDS = ['categories', 'texts', 'textBindings', 'items'] as const;
type Field = typeof FIELDS[number];
type Change = { field: Field; before?: unknown; after?: unknown };
type Journal = { id: string; domain: string; recover?: boolean; changes: Change[] };
type Bindings = { titles: string[]; detached: Record<string, string> };
type Projection = Bindings & { texts: Record<string, string> };

export class QuickCommandConflict extends Error {
	constructor() { super('Команда изменилась в другом окне. Черновик сохранён в форме.'); }
}

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const keyFor = (field: Field): string => QUICK_COMMAND_PREFIX + '.' + field;

/** Map lookups must also support command names such as "constructor" and "__proto__". */
function strings(value: unknown): Map<string, string> {
	return new Map(value && typeof value === 'object' && !Array.isArray(value)
		? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string') : []);
}

/** Undo only the keys this transaction changed. Manual edits of other templates survive recovery. */
function undo(change: Change, value: unknown): unknown {
	if (equal(value, change.before)) return value;
	if (equal(value, change.after)) return change.before;
	if (change.field !== 'categories' && change.field !== 'texts') return value;
	const before = strings(change.before);
	const after = strings(change.after);
	const current = strings(value);
	for (const name of new Set([...before.keys(), ...after.keys()])) {
		if (before.get(name) === after.get(name) || current.get(name) !== after.get(name)) continue;
		if (before.has(name)) current.set(name, before.get(name)!);
		else current.delete(name);
	}
	return Object.fromEntries(current);
}

/** Old clients rename rows in place and append new phrases. Ambiguous replacements require explicit recovery. */
function projectLegacyList(titles: string[], previous: Projection): Projection {
	const old = previous.titles;
	const removed = old.filter(title => !titles.includes(title));
	const added = titles.filter(title => !old.includes(title));
	const texts = strings(previous.texts);
	const detached = strings(previous.detached);
	// A rename and a delete followed by an add produce indistinguishable legacy string lists.
	for (const title of removed) {
		if (texts.has(title)) detached.set(title, texts.get(title)!);
		texts.delete(title);
	}
	for (const title of added) {
		if (texts.has(title) && !detached.has(title)) detached.set(title, texts.get(title)!);
		texts.delete(title);
	}
	// A rename and an immediate re-add can arrive together. Never attach the old body to the new literal row.
	for (const [index, title] of old.entries()) {
		if (texts.has(title) && titles.includes(title) && added.includes(titles[index]) && titles[index] !== title) {
			detached.set(title, texts.get(title)!);
			texts.delete(title);
		}
	}
	return { titles, texts: Object.fromEntries(texts), detached: Object.fromEntries(detached) };
}

/** Validate the webview payload before choosing a row, including the original supplied for a retry. */
function validCommand(command: DashboardQuickCommand): boolean {
	return !!command && typeof command.title === 'string' && !!command.title.trim()
		&& command.title === command.title.trim() && command.title.length <= DASHBOARD_QUICK_COMMAND_TEXT_LIMIT
		&& typeof command.text === 'string' && command.text.length <= DASHBOARD_QUICK_COMMAND_TEXT_LIMIT
		&& (command.category === undefined || (typeof command.category === 'string' && command.category.length <= DASHBOARD_QUICK_COMMAND_CATEGORY_LIMIT));
}

/** Rebase the original row into the latest order after obtaining the lock. Other additions and reorders stay intact. */
function planEdit(live: DashboardQuickCommandsWidgetState, edit: DashboardQuickCommandEdit) {
	const { command, original, restore } = edit;
	if (!validCommand(command) || (original !== null && !validCommand(original))) throw new Error('Некорректные данные команды.');
	const source = original && live.items.find(row => row.title === original.title);
	const target = live.items.find(row => row.title === command.title);
	const recovered = { ...live.recoverableTexts };
	if (restore && Object.hasOwn(recovered, restore.title) && recovered[restore.title] === restore.text) delete recovered[restore.title];
	const next = { ...live, recoverableTexts: recovered };
	if ((original && !source) || (target && target.title !== original?.title)) {
		if (!source && target?.text === command.text && target.category === command.category) return { base: live, next };
		throw new QuickCommandConflict();
	}
	if (!original && live.items.length >= DASHBOARD_QUICK_COMMAND_LIMIT) throw new QuickCommandConflict();
	const before = original ? live.items.map(row => row === source ? original : row) : live.items;
	const after = original ? live.items.map(row => row === source ? command : row) : [...live.items, command];
	return { base: { ...live, items: before }, next: { ...next, items: after } };
}

/** Coordinates command writes. Source settings, drafts and rollback information belong to the client, including in Tunnel. */
export class QuickCommandSettings {
	private projection?: { source: string; value: Projection };
	private domain?: string;
	private foreign?: { id: string; since: number };

	constructor(private readonly directory: () => string, private readonly read: (key: string) => unknown,
		private readonly write: (key: string, value: unknown) => Promise<void>) {}

	/** Validate the field allowlist before using a transaction read from settings. */
	private pending(): Journal | undefined {
		const txn = this.read(QUICK_COMMAND_TRANSACTION) as Partial<Journal> | undefined;
		if (txn && typeof txn.id === 'string' && typeof txn.domain === 'string' && Array.isArray(txn.changes)
			&& txn.changes.length <= FIELDS.length && txn.changes.every(change => change && FIELDS.includes(change.field)))
			return txn as Journal;
		return undefined;
	}

	/** Two extension hosts may target one client's settings while holding locks in different server directories. */
	private async writerDomain(directory: string): Promise<string> {
		if (this.domain) return this.domain;
		const file = path.join(directory, 'quick-command-lock-domain');
		try { this.domain = await fs.readFile(file, 'utf8'); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			const id = randomUUID();
			await fs.writeFile(file, id, { flag: 'wx' });
			this.domain = id;
		}
		return this.domain;
	}

	private assertOwner(txn: Journal): void {
		if (this.pending()?.id !== txn.id) throw new QuickCommandConflict();
	}

	/** Readers see the committed command while another window writes or recovers related settings. */
	readCommands(raw: Partial<DashboardQuickCommandsConfiguration> | undefined): DashboardQuickCommandsWidgetState | undefined {
		const pending = this.pending()?.changes ?? [];
		if (!raw && !pending.length) return undefined;
		const source = { ...raw, textBindings: this.read(keyFor('textBindings')) } as Record<string, unknown>;
		for (const change of pending) source[change.field] = undo(change, source[change.field]);
		const commands = normalizeDashboardQuickCommandsWidgetState(source);
		const titles = commands.items.map(item => item.title);
		const bindings = source.textBindings as Partial<Bindings> | null;
		const signature = JSON.stringify([bindings, source.texts]);
		const previous = this.projection?.source === signature ? this.projection.value : {
			titles: Array.isArray(bindings?.titles) ? bindings.titles : titles,
			texts: Object.fromEntries(strings(source.texts)), detached: Object.fromEntries(strings(bindings?.detached)),
		};
		const value = projectLegacyList(titles, previous);
		this.projection = { source: signature, value };
		for (const item of commands.items) {
			if (Object.hasOwn(value.texts, item.title)) item.text = value.texts[item.title];
			else if (Object.hasOwn(source.texts ?? {}, item.title)) item.text = item.title;
		}
		if (Object.keys(value.detached).length) commands.recoverableTexts = value.detached;
		return commands;
	}

	/** A string-only client changed the title list without moving its extended metadata. */
	needsBindingRefresh(): boolean {
		const titles = this.read(keyFor('items'));
		const bindings = this.read(keyFor('textBindings')) as Partial<Bindings> | undefined;
		return !this.pending() && Array.isArray(titles) && (bindings !== undefined || strings(this.read(keyFor('texts'))).size > 0)
			&& !equal(titles, bindings?.titles);
	}

	/** VS Code reloads user settings after a Global update. The echoed token identifies that local client's snapshot. */
	private async refresh(): Promise<void> {
		await refreshUserSettingsSnapshot(READ_TOKEN, this.read, this.write,
			'Настройки быстрых команд ещё обновляются в этом окне.');
	}

	/** A failed rollback remains readable through its journal and can be resumed by a new host. */
	private async rollback(txn: Journal): Promise<void> {
		for (const change of [...txn.changes].reverse()) {
			this.assertOwner(txn);
			const key = keyFor(change.field);
			const current = this.read(key);
			const previous = undo(change, current);
			if (!equal(previous, current)) await this.write(key, previous);
		}
		this.assertOwner(txn);
		await this.write(QUICK_COMMAND_TRANSACTION, undefined);
	}

	/** A foreign directory lock cannot prove the writer stopped. Observe inactivity on this host's monotonic clock. */
	private async recover(domain: string): Promise<void> {
		const txn = this.pending();
		if (!txn) { this.foreign = undefined; return; }
		if (txn.domain !== domain && !txn.recover) {
			if (this.foreign?.id !== txn.id) this.foreign = { id: txn.id, since: performance.now() };
			if (performance.now() - this.foreign.since < 30_000) throw new Error('В другом окне сохраняются быстрые команды.');
		}
		await this.rollback(txn);
		this.foreign = undefined;
	}

	/** The journal is present before any data write and remains recoverable after an interrupted rollback. */
	private async commit(changes: Change[], domain: string): Promise<void> {
		if (!changes.length) return;
		const txn: Journal = { id: randomUUID(), domain, changes };
		await this.write(QUICK_COMMAND_TRANSACTION, txn);
		try {
			await this.refresh();
			for (const change of changes) {
				this.assertOwner(txn);
				const actual = this.read(keyFor(change.field));
				if (!equal(actual, change.before) && !equal(actual, change.after)) throw new QuickCommandConflict();
				await this.write(keyFor(change.field), change.after);
			}
			this.assertOwner(txn);
			await this.write(QUICK_COMMAND_TRANSACTION, undefined);
		} catch (error) {
			if (this.pending()?.id === txn.id) {
				await this.write(QUICK_COMMAND_TRANSACTION, { ...txn, recover: true });
				await this.rollback(txn);
			}
			throw error;
		}
	}

	/** Apply a three-way edit per field. An already committed edit is safe to retry after losing its acknowledgement. */
	async save(next: DashboardQuickCommandsWidgetState, base: DashboardQuickCommandsWidgetState | undefined,
		getCurrent: () => DashboardQuickCommandsWidgetState): Promise<void> {
		if (!this.hasLegacyRecords() && base && equal(next.items, base.items) && equal(next.recoverableTexts, base.recoverableTexts)) return;
		await this.writeChanges(getCurrent, () => ({ next, base }));
	}

	async edit(edit: DashboardQuickCommandEdit, getCurrent: () => DashboardQuickCommandsWidgetState): Promise<void> {
		await this.writeChanges(getCurrent, live => planEdit(live, edit));
	}

	private hasLegacyRecords(): boolean {
		const raw = this.read(keyFor('items'));
		return Array.isArray(raw) && raw.some(item => item && typeof item === 'object');
	}

	private async writeChanges(getCurrent: () => DashboardQuickCommandsWidgetState, planEdit: (live: DashboardQuickCommandsWidgetState) =>
		{ next: DashboardQuickCommandsWidgetState; base?: DashboardQuickCommandsWidgetState }): Promise<void> {
		const directory = this.directory();
		await fs.mkdir(directory, { recursive: true });
		const release = await lock(directory, { lockfilePath: path.join(directory, 'quick-command-settings.lock'), retries: 0 });
		try {
			await this.refresh();
			const domain = await this.writerDomain(directory);
			await this.recover(domain);
			const live = getCurrent();
			const { next, base } = planEdit(live);
			const desired = serializeDashboardQuickCommands(next);
			const previous = base && serializeDashboardQuickCommands(base);
			const migrate = this.hasLegacyRecords();
			const current = serializeDashboardQuickCommands(live);
			const original = previous ?? current;
			const orderChanged = !previous || !equal(original.items, desired.items);
			if (orderChanged && !equal(current.items, original.items) && !equal(current.items, desired.items)) {
				throw new QuickCommandConflict();
			}
			const titles = orderChanged ? desired.items : current.items;
			const removed = original.items.filter(title => !desired.items.includes(title));
			for (const title of removed) {
				const old = base?.items.find(item => item.title === title);
				const actual = live.items.find(item => item.title === title);
				if (old && actual && !equal(old, actual)) throw new QuickCommandConflict();
			}
			const writes: Change[] = [];
			const plan = (field: Field, value: unknown) => {
				const before = this.read(keyFor(field));
				if (!equal(before, value)) writes.push({ field, before, after: value });
			};
			const detached = strings(this.projection?.value.detached);
			for (const [title, text] of strings(base?.recoverableTexts)) {
				if (!Object.hasOwn(next.recoverableTexts ?? {}, title) && detached.get(title) === text) detached.delete(title);
			}
			for (const field of ['categories', 'texts'] as const) {
				const actual = strings(current[field]);
				const prior = strings(original[field]);
				const wanted = strings(desired[field]);
				const raw = this.read(keyFor(field));
				const merged = strings(raw);
				if (field === 'texts') {
					for (const name of Object.keys(live.recoverableTexts ?? {})) if (!current.items.includes(name)) merged.delete(name);
				}
				// Materialize old records and projected legacy renames without dropping still-visible metadata.
				for (const title of current.items) {
					if (actual.has(title)) merged.set(title, actual.get(title)!);
					else merged.delete(title);
				}
				for (const title of desired.items) {
					const value = wanted.get(title);
					const isNew = !original.items.includes(title);
					if (!isNew && prior.get(title) === value) continue;
					if ((!isNew && !current.items.includes(title))
						|| (actual.get(title) !== prior.get(title) && actual.get(title) !== value)) throw new QuickCommandConflict();
					if (value === undefined) merged.delete(title); else merged.set(title, value);
				}
				if (raw !== undefined || merged.size) plan(field, Object.fromEntries(merged));
				if (field === 'texts' && (merged.size || detached.size || this.read(keyFor('textBindings')))) {
					plan('textBindings', { titles, ...(detached.size ? { detached: Object.fromEntries(detached) } : {}) });
				}
			}
			if (migrate || orderChanged) plan('items', titles);
			await this.commit(writes, domain);
			// A failure here leaves the committed row intact. Retrying also cleans old names after a successful rename.
			if (!removed.length) return;
			await this.refresh();
			await this.recover(domain);
			const retained = new Set(getCurrent().items.map(item => item.title));
			const cleanup: Change[] = [];
			for (const field of ['categories', 'texts'] as const) {
				const before = this.read(keyFor(field));
				const raw = strings(before);
				let changed = false;
				for (const title of removed) if (!retained.has(title) && raw.delete(title)) changed = true;
				if (changed) cleanup.push({ field, before, after: Object.fromEntries(raw) });
			}
			await this.commit(cleanup, domain);
		} finally {
			await release();
		}
	}
}
