import type { BashScriptEntry } from '../../../../types/bashScripts.js';

/** Hash paths before storing project and folder choices in Settings Sync. */
export function groupPreferenceKey(key: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(key)) {
		hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
	}
	return 'bashScripts:' + hash.toString(16);
}

export interface ScriptGroup {
	key: string;
	preferenceKey: string;
	name: string;
	root?: string;
	entries: BashScriptEntry[];
}

/** Keep duplicate project names separate and preserve script order within each group. */
export function groupBashScripts(entries: readonly BashScriptEntry[]): ScriptGroup[] {
	const groups = new Map<string, ScriptGroup>();
	for (const entry of entries) {
		const project = entry.project;
		const key = project ? 'project:' + project.root : 'outside:' + entry.scope;
		let group = groups.get(key);
		if (!group) {
			group = { key, preferenceKey: groupPreferenceKey(key), name: project?.name ?? (entry.scope === 'global' ? 'Глобальные скрипты' : 'Вне проектов'),
				root: project?.root, entries: [] };
			groups.set(key, group);
		}
		group.entries.push(entry);
	}
	return [...groups.values()].sort((a, b) => Number(!!b.root) - Number(!!a.root)
		|| a.name.localeCompare(b.name, 'ru', { numeric: true }) || a.key.localeCompare(b.key));
}

export const scriptKey = (entry: BashScriptEntry) => entry.scope + ':' + entry.id;
export const PROJECT_ORDER_KEY = 'bashScripts:groups';

/** New catalog entries follow the saved siblings in their original (name or folder) order. */
function ordered<T>(items: T[], key: (item: T) => string, order?: string[]): T[] {
	if (!order?.length) return items;
	const ranks = new Map(order.map((id, i) => [id, i]));
	return [...items].sort((a, b) => (ranks.get(key(a)) ?? order.length) - (ranks.get(key(b)) ?? order.length));
}

/** Keep absent siblings in their saved slots, including projects opened in other workspaces. */
export function moveBashSibling(visible: string[], index: number, delta: number, saved: string[] = []): string[] {
	const moved = [...visible];
	const other = index + delta;
	[moved[index], moved[other]] = [moved[other], moved[index]];
	const present = new Set(visible);
	let next = 0;
	return saved.map(key => present.has(key) ? moved[next++] : key).concat(moved.slice(next));
}

function directory(entry: BashScriptEntry): string {
	const path = entry.project?.relativePath ?? '';
	return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

/** Use the full catalog so a search retains the same folder headings and identities. */
export function projectScriptFolders(entries: readonly BashScriptEntry[]) {
	const projects = new Map<string, { prefix: string; multiple: boolean }>();
	for (const entry of entries) {
		if (!entry.project) continue;
		const dir = directory(entry);
		const path = dir ? dir + '/' : '';
		const folders = projects.get(entry.project.root);
		if (!folders) {
			projects.set(entry.project.root, { prefix: path, multiple: false });
			continue;
		}
		if (path !== folders.prefix) folders.multiple = true;
		while (!path.startsWith(folders.prefix)) {
			folders.prefix = folders.prefix.slice(0, folders.prefix.lastIndexOf('/', folders.prefix.length - 2) + 1);
		}
	}
	return projects;
}

/** Project and folder order are independent. Script keys survive file renames and temporary filtering. */
export function buildBashScriptTree(entries: BashScriptEntry[], projects: ReturnType<typeof projectScriptFolders>,
	orders: Record<string, string[]>) {
	return ordered(groupBashScripts(entries), g => g.preferenceKey, orders[PROJECT_ORDER_KEY]).map(group => {
		const project = projects.get(group.root ?? '');
		const byFolder = new Map<string, BashScriptEntry[]>();
		for (const entry of group.entries) {
			const path = directory(entry);
			const siblings = byFolder.get(path);
			if (siblings) siblings.push(entry);
			else byFolder.set(path, [entry]);
		}
		const folders = Array.from(byFolder, ([path, entries]) => {
			const first = entries[0];
			// Git discovery may change the owner. The absolute directory remains stable on both Windows and POSIX.
			const relative = first.project?.relativePath;
			const fileName = relative?.slice(relative.lastIndexOf('/') + 1);
			const folderIdentity = fileName ? 'folder:' + first.absolutePath.slice(0, -fileName.length) : group.key;
			const key = groupPreferenceKey('scripts:' + folderIdentity);
			return { key, path, title: path.slice(project?.prefix.length ?? 0) || path || 'Корень проекта',
				entries: ordered(entries, scriptKey, orders[key]) };
		});
		return { ...group, showFolders: project?.multiple ?? false,
			folders: ordered(folders, f => f.key, orders[group.preferenceKey]) };
	});
}
