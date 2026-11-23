import React, { useContext, useEffect, useId, useRef, useState } from 'react';
import type { BashScriptEntry, BashScriptScope } from '../../../../types/bashScripts.js';
import { QuickNoteIcon } from '../quickNotes/QuickNoteIcon';
import { OpenBashScriptEditor } from './BashScriptEditorHost';
import { rememberWidgetDialogOpener } from '../quickNotes/quickNotesFocus';
import { getVsCodeApi } from '../../../shared/vscodeApi';
import { BashScriptRow } from './BashScriptRow';
import { newScriptDraft } from './bashScriptDraft';
import { useBashScripts } from './useBashScripts';
import { BASH_SCRIPTS_CSS } from './bashScriptsStyles';

type ScriptFilter = 'all' | 'available' | 'missing' | 'recent';
/** Область, состояние и текст применяются совместно. Недавние отсортированы по времени запуска. */
export function filterBashScripts(entries: BashScriptEntry[], search: string, scope: BashScriptScope | 'all', filter: ScriptFilter) {
	const query = search.trim().toLocaleLowerCase();
	const filtered = entries.filter(entry => (scope === 'all' || scope === entry.scope)
		&& (filter !== 'recent' || entry.history.length > 0) && (filter !== 'available' || entry.available) && (filter !== 'missing' || !entry.available)
		&& (!query || [entry.name, entry.path, entry.absolutePath, entry.project?.relativePath, entry.project?.name]
			.some(value => value?.toLocaleLowerCase().includes(query))));
	return filtered.sort((left, right) => {
		if (filter === 'recent') {
			const difference = Date.parse(right.history[0].startedAt) - Date.parse(left.history[0].startedAt);
			if (difference) return difference;
		}
		return left.name.localeCompare(right.name, 'ru', { numeric: true }) || left.absolutePath.localeCompare(right.absolutePath);
	});
}

interface ScriptGroup {
	key: string;
	preferenceKey: string;
	name: string;
	root?: string;
	entries: BashScriptEntry[];
}

/** Стабильный ключ FNV-1a позволяет сохранять выбор группы без полного пути в Settings Sync. */
function groupPreferenceKey(key: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(key)) {
		hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
	}
	return 'bashScripts:' + hash.toString(16);
}

/** Keep duplicate project names separate and preserve the selected script ordering inside each group. */
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

interface ProjectFolders {
	prefix: string;
	multiple: boolean;
}

/** Use the unfiltered catalog so searching for one file preserves its folder heading. */
function projectScriptFolders(entries: readonly BashScriptEntry[]): Map<string, ProjectFolders> {
	const projects = new Map<string, ProjectFolders>();
	for (const { project } of entries) {
		if (!project) continue;
		const directory = project.relativePath.slice(0, project.relativePath.lastIndexOf('/') + 1);
		const folders = projects.get(project.root);
		if (!folders) {
			projects.set(project.root, { prefix: directory, multiple: false });
			continue;
		}
		if (directory !== folders.prefix) folders.multiple = true;
		while (!directory.startsWith(folders.prefix)) {
			folders.prefix = folders.prefix.slice(0, folders.prefix.lastIndexOf('/', folders.prefix.length - 2) + 1);
		}
	}
	return projects;
}

/** Keep folders in first-match order and preserve name or recency ordering within each folder. */
function ScriptFolders({ group, projectFolders, renderRow }: {
	group: ScriptGroup; projectFolders?: ProjectFolders; renderRow(entry: BashScriptEntry, displayPath?: string): React.ReactNode;
}) {
	const folders = React.useMemo(() => {
		const byFolder = new Map<string, BashScriptEntry[]>();
		for (const entry of group.entries) {
			const relative = entry.project?.relativePath ?? '';
			const folder = relative.slice(0, Math.max(0, relative.lastIndexOf('/')));
			const scripts = byFolder.get(folder);
			if (scripts) scripts.push(entry);
			else byFolder.set(folder, [entry]);
		}
		return byFolder;
	}, [group]);
	return <>{Array.from(folders, ([folder, scripts]) => {
		const rows = scripts.map(entry => {
			const path = entry.project?.relativePath;
			return renderRow(entry, path?.slice(path.lastIndexOf('/') + 1));
		});
		if (!folder || !projectFolders?.multiple) return <React.Fragment key={folder}>{rows}</React.Fragment>;
		const title = folder.slice(projectFolders.prefix.length) || folder;
		return <li className="pm-bs-folder" key={folder}>
			<div className="pm-bs-folder-title" title={folder}><QuickNoteIcon name="folder" size={13} /><span>{title}</span></div>
			<ul className="pm-bs-list" aria-label={folder}>{rows}</ul>
		</li>;
	})}</>;
}

/** Ранее панель хранила явный выбор групп по пути проекта в локальном состоянии webview. */
function readGroupChoices(): Record<string, boolean> {
	if (typeof window === 'undefined') return {};
	const value = getVsCodeApi().getState?.()?.bashScriptGroupChoices;
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, boolean] => typeof pair[1] === 'boolean'));
}

/** Для одноимённых проектов заголовок группы дополнительно показывает путь. */
function findDuplicateNames(items: readonly { name: string }[]): Set<string> {
	const names = new Set<string>();
	const duplicates = new Set<string>();
	for (const { name } of items) {
		if (names.has(name)) duplicates.add(name);
		names.add(name);
	}
	return duplicates;
}

/** Шапка группы ведёт себя как строка дерева рабочих папок. */
function ProjectGroup({ group, duplicateName, expanded, toggle, children }: {
	group: ScriptGroup; duplicateName: boolean; expanded: boolean; toggle(): void; children: React.ReactNode;
}) {
	const id = useId();
	const path = duplicateName ? group.root : undefined;
	return <section className="pm-bs-group">
		<button type="button" className="pm-bs-group-toggle" aria-label={path ? `${group.name} · ${path}` : group.name}
			aria-expanded={expanded} aria-controls={expanded ? id : undefined} onClick={toggle} title={group.root ?? group.name}>
			<QuickNoteIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
			<span className="pm-bs-group-name">{group.name}</span>
			{path && <code className="pm-bs-group-path">{path}</code>}
			<span className="pm-bs-group-count">{group.entries.length}</span>
		</button>
		{expanded && <ul className="pm-bs-list" id={id} aria-label={group.name}>{children}</ul>}
	</section>;
}

/** Виджет использует общую оболочку панели, сохраняет черновик вне списка и ждёт подтверждения операций host. */
export function BashScriptsWidget({ collapsed, onToggleCollapse, expandedGroups, onGroupChoicesChange, renderShell }: {
	collapsed: boolean; onToggleCollapse(): void; renderShell(actions: React.ReactNode, body: React.ReactNode): React.ReactNode;
	expandedGroups: Record<string, boolean>; onGroupChoicesChange(patch: Record<string, boolean>): void;
}) {
	const { entries, listError, send, reload, afterRun } = useBashScripts(!collapsed);
	const [searchOpen, setSearchOpen] = useState(false);
	const [search, setSearch] = useState('');
	const [scope, setScope] = useState<BashScriptScope | 'all'>('all');
	const [filter, setFilter] = useState<ScriptFilter>('all');
	const [historyKey, setHistoryKey] = useState('');
	const [hideTarget, setHideTarget] = useState<BashScriptEntry | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState<ReadonlyMap<string, 'run' | 'hide' | 'scan'>>(new Map());
	const inFlight = useRef(new Map<string, 'run' | 'hide' | 'scan'>());
	const open = useContext(OpenBashScriptEditor);
	const [legacyChoices, setLegacyChoices] = useState<Record<string, boolean>>({});
	useEffect(() => setLegacyChoices(readGroupChoices()), []);
	const [filteredChoice, setFilteredChoice] = useState<{ query: string; closed: Set<string> }>();
	const filters = useId();
	const searchField = useRef<HTMLInputElement>(null);
	const showFilters = !collapsed && searchOpen;
	const hasFilters = !!search.trim() || scope !== 'all' || filter !== 'all';
	const visible = React.useMemo(() => filterBashScripts(entries ?? [], search, scope, filter), [entries, search, scope, filter]);
	const groups = React.useMemo(() => groupBashScripts(visible), [visible]);
	const foldersByProject = React.useMemo(() => projectScriptFolders(entries ?? []), [entries]);
	const query = JSON.stringify([scope, filter, search.trim().toLocaleLowerCase()]);
	useEffect(() => setFilteredChoice(undefined), [query]);
	const duplicateNames = React.useMemo(() => findDuplicateNames(groups), [groups]);
	useEffect(() => { if (showFilters && document.hasFocus() && !document.querySelector('[aria-modal="true"]')) searchField.current?.focus({ preventScroll: true }); }, [showFilters]);
	function openEditor(opener: HTMLButtonElement, entry?: BashScriptEntry) {
		rememberWidgetDialogOpener(opener);
		open(newScriptDraft(entry, scope === 'global' ? 'global' : 'project'), opener);
	}
	/** Поиск временно раскрывает совпадения. Для большой коллекции исходное представление — список проектов. */
	function isGroupExpanded(group: ScriptGroup): boolean {
		if (hasFilters) return !(filteredChoice?.query === query && filteredChoice.closed.has(group.key));
		return expandedGroups[group.preferenceKey] ?? legacyChoices[group.key] ?? (entries?.length ?? 0) <= 8;
	}
	const collapseGroups = groups.some(isGroupExpanded);
	const groupAction = collapseGroups ? 'Свернуть все группы' : 'Раскрыть все группы';
	/** Меняет видимые группы, сохраняя обычный выбор при временной фильтрации. */
	function setGroupsExpanded(targets: ScriptGroup[], expanded: boolean) {
		if (hasFilters) {
			const closed = new Set(filteredChoice?.query === query ? filteredChoice.closed : []);
			for (const { key } of targets) {
				if (expanded) closed.delete(key); else closed.add(key);
			}
			setFilteredChoice({ query, closed });
			return;
		}
		// При первом ручном изменении переносим из старой панели только явно сохранённые решения.
		const patch: Record<string, boolean> = {};
		for (const [key, value] of Object.entries(legacyChoices)) {
			const preferenceKey = groupPreferenceKey(key);
			if (expandedGroups[preferenceKey] === undefined) patch[preferenceKey] = value;
		}
		for (const group of targets) patch[group.preferenceKey] = expanded;
		onGroupChoicesChange(patch);
	}
	async function perform(action: 'run' | 'hide' | 'scan', key: string, entry?: BashScriptEntry) {
		if (inFlight.current.has(key)) return;
		inFlight.current.set(key, action);
		setBusy(new Map(inFlight.current));
		setError('');
		try {
			if (action === 'scan') await reload(true);
			else if (entry) {
				await send({ action, ref: { scope: entry.scope, id: entry.id }, path: entry.absolutePath });
				if (action === 'run') await afterRun();
			}
		} catch (error) { setError((error as Error).message); }
		finally {
			if (action === 'hide') setHideTarget(current => current === entry ? null : current);
			inFlight.current.delete(key);
			setBusy(new Map(inFlight.current));
		}
	}
	const actions = <span className="pm-qn-header-actions pm-bs-actions" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
		{entries && <span className="pm-qn-count" title="Скриптов в списке">{hasFilters ? `${visible.length}/${entries.length}` : entries.length}</span>}
		<button type="button" className="pm-qn-icon-btn" title="Поиск и фильтры скриптов" aria-label="Поиск и фильтры скриптов"
			aria-expanded={showFilters} aria-controls={showFilters ? filters : undefined} data-active={hasFilters || undefined}
			onClick={() => { setSearchOpen(!showFilters); if (collapsed) onToggleCollapse(); }}><QuickNoteIcon name="search" size={15} /></button>
		{!collapsed && groups.length > 1 && <button type="button" className="pm-qn-icon-btn pm-bs-fold" title={groupAction}
			aria-label={groupAction} onClick={() => setGroupsExpanded(groups, !collapseGroups)}>
			<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
				<path d={collapseGroups ? 'm5 2 3 3 3-3 M3 8h10 m-8 6 3-3 3 3' : 'm5 5 3-3 3 3 M3 8h10 m-8 3 3 3 3-3'} />
			</svg>
		</button>}
		<button type="button" className="pm-qn-icon-btn" title="Повторно найти скрипты проекта" aria-label="Повторно найти скрипты проекта" disabled={busy.has('scan')}
			onClick={() => { if (collapsed) onToggleCollapse(); void perform('scan', 'scan'); }}><QuickNoteIcon name="refresh" size={15} /></button>
		<button type="button" className="pm-qn-icon-btn pm-bs-add" data-pm-bash-editor-opener="add" title="Добавить Bash скрипт" aria-label="Добавить Bash скрипт"
			onClick={e => { if (collapsed) onToggleCollapse(); openEditor(e.currentTarget); }}><QuickNoteIcon name="add" size={15} /></button>
	</span>;
	const body = collapsed ? null : <div className="pm-bs">
		{showFilters && <div className="pm-bs-filters" id={filters}>
			<input type="search" name="bashScriptSearch" aria-label="Поиск по названию, проекту или пути" placeholder="Название, проект или путь…" ref={searchField} value={search} onChange={e => setSearch(e.target.value)} />
			<div><select name="bashScriptsScopeFilter" aria-label="Область скриптов" value={scope} onChange={e => setScope(e.target.value as typeof scope)}>
				<option value="all">Все области</option><option value="project">Проектные</option><option value="global">Глобальные</option>
			</select><select name="bashScriptsStatusFilter" aria-label="Фильтр скриптов" value={filter} onChange={e => setFilter(e.target.value as ScriptFilter)}>
				<option value="all">Все скрипты</option><option value="available">Доступные</option><option value="missing">Недоступные</option><option value="recent">Недавние запуски</option>
			</select>{hasFilters && <button type="button" className="pm-qn-icon-btn" title="Сбросить фильтры" aria-label="Сбросить фильтры" onClick={() => { setFilter('all'); setScope('all'); setSearch(''); searchField.current?.focus(); }}><QuickNoteIcon name="close" size={14} /></button>}</div>
		</div>}
		{(error || listError) && <div className="pm-qn-error" role="alert">{error || listError}{listError && <button className="pm-qn-btn is-secondary" type="button" onClick={() => void reload()}>Повторить</button>}</div>}
		{busy.has('scan') && <span className="pm-qn-empty" role="status">Поиск скриптов в проекте…</span>}
		{!listError && !visible.length && <div className="pm-qn-empty" role="status">{entries === null ? 'Загрузка скриптов…' : hasFilters ? 'Подходящих скриптов нет.' : 'Скриптов пока нет. Добавьте файл кнопкой «+».'}</div>}
		{groups.map(group => {
			const expanded = isGroupExpanded(group);
			return <ProjectGroup key={group.key} group={group} duplicateName={duplicateNames.has(group.name)}
				expanded={expanded} toggle={() => setGroupsExpanded([group], !expanded)}>
				{expanded && <ScriptFolders group={group} projectFolders={foldersByProject.get(group.root ?? '')} renderRow={(entry, displayPath) => {
					const key = entry.scope + ':' + entry.id;
					const target = hideTarget?.scope === entry.scope && hideTarget.id === entry.id ? hideTarget : null;
					return <BashScriptRow key={key} entry={entry} displayPath={displayPath} busy={busy.has(key)}
						launching={busy.get(key) === 'run'} historyOpen={historyKey === key} hideTarget={target}
						onRun={() => void perform('run', key, entry)} onEdit={opener => openEditor(opener, entry)}
						onHistory={() => setHistoryKey(historyKey === key ? '' : key)} onHide={setHideTarget}
						confirmHide={shown => void perform('hide', key, shown)} />;
				}} />}
			</ProjectGroup>;
		})}
	</div>;
	return <>{renderShell(actions, body)}<style>{BASH_SCRIPTS_CSS}</style></>;
}
