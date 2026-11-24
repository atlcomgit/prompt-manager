import React, { useContext, useEffect, useId, useRef, useState } from 'react';
import type { BashScriptEntry, BashScriptScope } from '../../../../types/bashScripts.js';
import { QuickNoteIcon } from '../quickNotes/QuickNoteIcon';
import { OpenBashScriptEditor } from './BashScriptEditorHost';
import { rememberWidgetDialogOpener } from '../quickNotes/quickNotesFocus';
import { getVsCodeApi } from '../../../shared/vscodeApi';
import { BashScriptRow } from './BashScriptRow';
import { newScriptDraft } from './bashScriptDraft';
import { useBashScripts } from './useBashScripts';
import { buildBashScriptTree, groupPreferenceKey, moveBashSibling, projectScriptFolders, PROJECT_ORDER_KEY, scriptKey } from './bashScriptGroups';
import { BASH_SCRIPTS_CSS } from './bashScriptsStyles';

export { groupBashScripts } from './bashScriptGroups';

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

/** The toggle and move buttons are separate keyboard targets at both levels of the tree. */
function GroupHeading({ title, path, hint, folder, count, expanded, toggle, orderActions, visibilityAction, children }: {
	title: string; path?: string; hint?: string; folder?: boolean; count?: number; expanded: boolean;
	toggle(): void; orderActions: React.ReactNode; visibilityAction?: React.ReactNode; children: React.ReactNode;
}) {
	const id = useId();
	return <>
		<div className="pm-bs-heading">
			<button type="button" className={'pm-bs-group-toggle' + (folder ? ' pm-bs-folder-title' : '')}
				aria-label={path ? `${title} · ${path}` : title} aria-expanded={expanded} aria-controls={expanded ? id : undefined}
				onClick={toggle} title={hint || title}>
				<QuickNoteIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
				{folder && <QuickNoteIcon name="folder" size={13} />}
				<span className={folder ? undefined : 'pm-bs-group-name'}>{title}</span>
				{path && <code className="pm-bs-group-path">{path}</code>}
				{count !== undefined && <span className="pm-bs-group-count">{count}</span>}
			</button>
			{visibilityAction}
			{orderActions}
		</div>
		{expanded && <ul className="pm-bs-list" id={id} aria-label={folder ? hint || title : title}>{children}</ul>}
	</>;
}

/** Keep boundary buttons focusable when the item reaches the end of its list. */
function OrderActions({ label, index, keys, move }: {
	label: string; index: number; keys: string[]; move(delta: number): void;
}) {
	return <span className="pm-bs-order-actions">
		{[-1, 1].map(delta => {
			const disabled = index + delta < 0 || index + delta >= keys.length;
			const title = `Переместить ${label} ${delta < 0 ? 'выше' : 'ниже'}`;
			return <button type="button" className="pm-qn-icon-btn" key={delta} aria-label={title}
				title={title} aria-disabled={disabled} onClick={() => { if (!disabled) move(delta); }}>
				<QuickNoteIcon name="chevron-down" className={delta < 0 ? 'pm-bs-up' : undefined} size={14} />
			</button>;
		})}
	</span>;
}

/** Виджет использует общую оболочку панели, сохраняет черновик вне списка и ждёт подтверждения операций host. */
export function BashScriptsWidget({ collapsed, onToggleCollapse, expandedGroups, onGroupChoicesChange, bashScriptOrder, bashScriptFavorites, bashScriptHiddenFolders, onFolderHiddenChange, onOrderChange, onFavoriteChange, renderShell }: {
	collapsed: boolean; onToggleCollapse(): void; renderShell(actions: React.ReactNode, body: React.ReactNode): React.ReactNode;
	bashScriptOrder: Record<string, string[]>; bashScriptFavorites: Record<string, boolean>;
	bashScriptHiddenFolders: Record<string, boolean>; onFolderHiddenChange(key: string, hidden: boolean): void;
	onOrderChange(parent: string, order: string[]): void; onFavoriteChange(key: string, favorite: boolean): void;
	expandedGroups: Record<string, boolean>; onGroupChoicesChange(patch: Record<string, boolean>): void;
}) {
	const { entries, listError, send, reload, afterRun } = useBashScripts(!collapsed);
	const [searchOpen, setSearchOpen] = useState(false);
	const [search, setSearch] = useState('');
	const [scope, setScope] = useState<BashScriptScope | 'all'>('all');
	const [filter, setFilter] = useState<ScriptFilter>('all');
	const [showHidden, setShowHidden] = useState(false);
	const [editingOrder, setEditingOrder] = useState(false);
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
	const foldersByProject = React.useMemo(() => projectScriptFolders(entries ?? []), [entries]);
	const tree = React.useMemo(() => buildBashScriptTree(visible, foldersByProject, filter === 'recent' ? {} : bashScriptOrder),
		[visible, foldersByProject, filter, bashScriptOrder]);
	const allGroupKeys = React.useMemo(() => tree.map(group => group.preferenceKey), [tree]);
	const hiddenCount = tree.reduce((total, group) => total + group.folders.filter(folder => bashScriptHiddenFolders[folder.key]).length, 0);
	const groups = React.useMemo(() => tree.flatMap(group => {
		const folders = showHidden ? group.folders : group.folders.filter(folder => !bashScriptHiddenFolders[folder.key]);
		if (!folders.length) return [];
		return [{ ...group, folders, allFolderKeys: group.folders.map(folder => folder.key),
			visibleCount: folders.reduce((total, folder) => total + folder.entries.length, 0) }];
	}), [tree, showHidden, bashScriptHiddenFolders]);
	const visibleCount = groups.reduce((total, group) => total + group.visibleCount, 0);
	const groupKeys = groups.map(group => group.preferenceKey);
	const hasFolderHeading = (multiple: boolean, key: string) =>
		multiple || !!bashScriptHiddenFolders[key] || expandedGroups[key] !== undefined;
	const foldKeys = groups.flatMap(group => [group.preferenceKey, ...group.folders
		.filter(folder => hasFolderHeading(group.showFolders, folder.key)).map(folder => folder.key)]);
	const query = JSON.stringify([scope, filter, search.trim().toLocaleLowerCase()]);
	useEffect(() => setFilteredChoice(undefined), [query]);
	const duplicateNames = React.useMemo(() => findDuplicateNames(groups), [groups]);
	useEffect(() => { if (showFilters && document.hasFocus() && !document.querySelector('[aria-modal="true"]')) searchField.current?.focus({ preventScroll: true }); }, [showFilters]);
	function openEditor(opener: HTMLButtonElement, entry?: BashScriptEntry) {
		rememberWidgetDialogOpener(opener);
		open(newScriptDraft(entry, scope === 'global' ? 'global' : 'project'), opener);
	}
	/** Поиск временно раскрывает совпадения. Для большой коллекции исходное представление — список проектов. */
	function isExpanded(key: string, defaultValue: boolean): boolean {
		if (hasFilters) return !(filteredChoice?.query === query && filteredChoice.closed.has(key));
		return expandedGroups[key] ?? defaultValue;
	}
	const projectExpanded = (group: typeof tree[number]) =>
		isExpanded(group.preferenceKey, legacyChoices[group.key] ?? (entries?.length ?? 0) <= 8);
	const collapseGroups = groups.some(projectExpanded);
	const groupAction = collapseGroups ? 'Свернуть все группы' : 'Раскрыть все группы';
	/** Filtered matches can be folded independently without changing the regular tree. */
	function setGroupsExpanded(keys: string[], expanded: boolean) {
		if (hasFilters) {
			setFilteredChoice(current => {
				const closed = new Set(current?.query === query ? current.closed : []);
				for (const key of keys) {
					if (expanded) closed.delete(key); else closed.add(key);
				}
				return { query, closed };
			});
			return;
		}
		// При первом ручном изменении переносим из старой панели только явно сохранённые решения.
		const patch: Record<string, boolean> = {};
		for (const [key, value] of Object.entries(legacyChoices)) {
			const preferenceKey = groupPreferenceKey(key);
			if (expandedGroups[preferenceKey] === undefined) patch[preferenceKey] = value;
		}
		for (const key of keys) patch[key] = expanded;
		onGroupChoicesChange(patch);
	}
	function orderActions(parent: string, keys: string[], index: number, name: string, allKeys: string[] = keys) {
		if (!editingOrder || hasFilters || keys.length < 2) return null;
		return <OrderActions keys={keys} index={index} label={name} move={delta =>
			onOrderChange(parent, moveBashSibling(keys, index, delta, [...new Set([...(bashScriptOrder[parent] ?? []), ...allKeys])]))} />;
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
		{entries && <span className="pm-qn-count" title="Скриптов в списке">{hasFilters || visibleCount !== entries.length ? `${visibleCount}/${entries.length}` : entries.length}</span>}
		<button type="button" className="pm-qn-icon-btn" title="Поиск и фильтры скриптов" aria-label="Поиск и фильтры скриптов"
			aria-expanded={showFilters} aria-controls={showFilters ? filters : undefined} data-active={hasFilters || undefined}
			onClick={() => { setSearchOpen(!showFilters); if (collapsed) onToggleCollapse(); }}><QuickNoteIcon name="search" size={15} /></button>
		{!collapsed && (hiddenCount > 0 || showHidden) && <button type="button" className="pm-qn-icon-btn"
			title="Показать скрытые подгруппы" aria-label="Показать скрытые подгруппы" aria-pressed={showHidden} data-active={showHidden || undefined}
			onClick={() => setShowHidden(!showHidden)}><QuickNoteIcon name="eye" size={15} /></button>}
		{!collapsed && (entries?.length ?? 0) > 1 && <button type="button" className="pm-qn-icon-btn" title={hasFilters ? 'Для изменения порядка сбросьте фильтры' : 'Изменить порядок'}
			aria-label="Изменить порядок" aria-pressed={editingOrder && !hasFilters} data-active={editingOrder && !hasFilters || undefined} disabled={hasFilters}
			onClick={() => setEditingOrder(!editingOrder)}>
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
				<path d="M4 13V3m-3 3 3-3 3 3m5-3v10m-3-3 3 3 3-3" />
			</svg>
		</button>}
		{!collapsed && foldKeys.length > 1 && <button type="button" className="pm-qn-icon-btn pm-bs-fold" title={groupAction}
			aria-label={groupAction} onClick={() => setGroupsExpanded(foldKeys, !collapseGroups)}>
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
		{!listError && !visibleCount && <div className="pm-qn-empty" role="status">{entries === null ? 'Загрузка скриптов…' : hiddenCount > 0 ? 'Подгруппы скрыты. Их можно показать кнопкой с глазом в шапке виджета.' : hasFilters ? 'Подходящих скриптов нет.' : 'Скриптов пока нет. Добавьте файл кнопкой «+».'}</div>}
		{groups.map((group, groupIndex) => {
			const expanded = projectExpanded(group);
			const folderKeys = group.folders.map(folder => folder.key);
			return <section className="pm-bs-group" key={group.key}>
				<GroupHeading title={group.name} path={duplicateNames.has(group.name) ? group.root : undefined} hint={group.root}
					count={group.visibleCount} expanded={expanded} toggle={() => setGroupsExpanded([group.preferenceKey], !expanded)}
					orderActions={orderActions(PROJECT_ORDER_KEY, groupKeys, groupIndex, group.name, allGroupKeys)}>
					{expanded && group.folders.map((folder, folderIndex) => {
						const hidden = !!bashScriptHiddenFolders[folder.key];
						const hasHeading = hasFolderHeading(group.showFolders, folder.key);
						const open = !hasHeading || isExpanded(folder.key, true);
						const keys = folder.entries.map(scriptKey);
						const rows = open && folder.entries.map((entry, index) => {
							const key = keys[index];
							const target = hideTarget?.scope === entry.scope && hideTarget.id === entry.id ? hideTarget : null;
							const path = entry.project?.relativePath;
							return <BashScriptRow key={key} entry={entry} displayPath={path?.slice(path.lastIndexOf('/') + 1)} busy={busy.has(key)}
								favorite={!!bashScriptFavorites[key]} onToggleFavorite={() => onFavoriteChange(key, !bashScriptFavorites[key])}
								rowOrderActions={orderActions(folder.key, keys, index, entry.name)}
								launching={busy.get(key) === 'run'} historyOpen={historyKey === key} hideTarget={target}
								onRun={() => void perform('run', key, entry)} onEdit={opener => openEditor(opener, entry)}
								onHistory={() => setHistoryKey(historyKey === key ? '' : key)} onHide={setHideTarget}
								confirmHide={shown => void perform('hide', key, shown)} />;
						});
						if (!hasHeading) return <React.Fragment key={folder.key}>{rows}</React.Fragment>;
						const visibilityLabel = (hidden ? 'Вернуть подгруппу ' : 'Скрыть подгруппу ') + folder.title;
						return <li className="pm-bs-folder" key={folder.key} data-hidden={hidden || undefined}>
							<GroupHeading folder title={folder.title} hint={folder.path} expanded={open}
								toggle={() => setGroupsExpanded([folder.key], !open)}
								visibilityAction={<button type="button" className="pm-qn-icon-btn pm-bs-folder-visibility"
									aria-label={visibilityLabel} title={visibilityLabel}
									onClick={() => {
										onFolderHiddenChange(folder.key, !hidden);
										if (hidden && hiddenCount === 1) setShowHidden(false);
									}}><QuickNoteIcon name={hidden ? 'eye' : 'eye-closed'} size={13} /></button>}
								orderActions={orderActions(group.preferenceKey, folderKeys, folderIndex, folder.title,
									group.allFolderKeys)}>
								{rows}
							</GroupHeading>
						</li>;
					})}
				</GroupHeading>
			</section>;
		})}
	</div>;
	return <>{renderShell(actions, body)}<style>{BASH_SCRIPTS_CSS}</style></>;
}
