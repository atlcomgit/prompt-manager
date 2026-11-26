import React, { useEffect, useId, useRef, useState } from 'react';
import {
	DASHBOARD_QUICK_COMMAND_LIMIT,
	DASHBOARD_QUICK_COMMAND_TARGETS,
	isDashboardQuickCommandTarget,
	type DashboardQuickCommand,
	type DashboardQuickCommandTarget,
} from '../../../types/promptDashboardPreferences.js';
import { EditorSectionDragHandle, SortableEditorSections } from './SortableEditorSections';
import { QuickNoteIcon } from './quickNotes/QuickNoteIcon';
import { focusInActiveWebview } from './quickNotes/quickNotesFocus';

/** Подписи целей сохраняют привычный выбор провайдера и добавляют текущий чат. */
const TARGET_LABELS: Record<DashboardQuickCommandTarget, string> = {
	current: 'Текущий',
	copilot: 'Copilot',
	codex: 'OpenAI Codex',
	claude: 'Claude Code',
	'opencode-cli': 'OpenCode CLI',
};

/** Кнопка категории остаётся доступна с клавиатуры, когда её список свёрнут. */
function QuickCommandGroup({ title, expanded, onToggle, children }: {
	title: string; expanded: boolean; onToggle(): void; children: React.ReactNode;
}) {
	const listId = useId();
	return <div role="group" aria-label={title}>
		<button type="button" className="pm-quick-commands-category" aria-expanded={expanded} aria-controls={listId} onClick={onToggle}>
			<QuickNoteIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
			<span>{title}</span>
		</button>
		<div id={listId} hidden={!expanded}>{expanded && children}</div>
	</div>;
}

/** Общий список черновиков команд. Проверки в quickCommandsWidget.test.tsx. */
export function QuickCommandsWidget({
	items, target, pendingTitle, collapsed, expandedGroups, onToggleGroup, onToggleCollapse,
	renderShell, onTargetChange, onItemsChange, onEdit, onInsert, onCopy,
}: {
	items: DashboardQuickCommand[];
	target: DashboardQuickCommandTarget;
	pendingTitle?: string | null;
	collapsed: boolean;
	/** Состояние категорий между открытиями панели хранится в общих настройках раскрытия обзора. */
	expandedGroups: Record<string, boolean>;
	onToggleGroup(key: string): void;
	onToggleCollapse(): void;
	renderShell(actions: React.ReactNode, body: React.ReactNode | null): React.ReactNode;
	onTargetChange(target: DashboardQuickCommandTarget): void;
	onItemsChange(items: DashboardQuickCommand[]): void;
	onEdit(item: DashboardQuickCommand | null, opener: HTMLButtonElement): void;
	onInsert(item: DashboardQuickCommand, target: DashboardQuickCommandTarget): void;
	onCopy(text: string): void;
}): React.ReactElement {
	// Поиск и незавершённые действия относятся только к открытому виджету.
	const [filter, setFilter] = useState('');
	const [searchExpanded, setSearchExpanded] = useState<Record<string, boolean>>({});
	const [searchOpen, setSearchOpen] = useState(false);
	const searchId = useId();
	const searchInput = useRef<HTMLInputElement>(null);
	const focusSearchOnOpen = useRef(false);
	const [deleting, setDeleting] = useState<string | null>(null);
	const canAdd = items.length < DASHBOARD_QUICK_COMMAND_LIMIT;
	const showSearch = searchOpen && !collapsed;

	// Фокус ставится после раскрытия карточки, когда поле уже появилось в DOM.
	useEffect(() => {
		if (showSearch && focusSearchOnOpen.current) {
			focusSearchOnOpen.current = false;
			if (document.hasFocus() && !document.querySelector('[aria-modal="true"]')) searchInput.current?.focus({ preventScroll: true });
		}
	}, [showSearch]);

	useEffect(() => {
		// Закрываем подтверждение, если команда удалена в другом окне.
		setDeleting(previous => previous && !items.some(item => item.title === previous) ? null : previous);
	}, [items]);

	// Категории следуют по первому появлению. Перенос сохраняет порядок остальных категорий и скрытых строк.
	const categories = new Map<string, DashboardQuickCommand[]>();
	for (const item of items) {
		const category = item.category ?? '';
		const commands = categories.get(category);
		if (commands) commands.push(item);
		else categories.set(category, [item]);
	}
	const query = filter.trim().toLocaleLowerCase();
	const visibleGroups = [...categories].flatMap(([category, commands]) => {
		const visible = category.toLocaleLowerCase().includes(query) ? commands
			: commands.filter(item => item.title.toLocaleLowerCase().includes(query) || item.text.toLocaleLowerCase().includes(query));
		if (!visible.length) return [];
		const key = 'quickCommands:' + category;
		const expanded = (query ? searchExpanded : expandedGroups)[key] ?? true;
		return [{ category, commands, visible, key, expanded }];
	});

	/** Сворачивание результатов действует до смены запроса. Обычный список запоминает выбор в настройках. */
	function toggleGroup(key: string) {
		if (query) setSearchExpanded(current => ({ ...current, [key]: !(current[key] ?? true) }));
		else onToggleGroup(key);
	}

	/** Переставляет команды в выбранной группе, сохраняя позиции остальных групп. */
	const reorder = (category: string, commands: DashboardQuickCommand[], order: string[]) => {
		const commandsByTitle = new Map(commands.map(command => [command.title, command]));
		const ordered = order.map(title => commandsByTitle.get(title)).filter(command => command !== undefined);
		let index = 0;
		onItemsChange(items.map(item => (item.category ?? '') === category ? ordered[index++] ?? item : item));
	};

	// Кнопки и нативное меню обрабатывают клавиши и щелчки независимо от сворачивания заголовка.
	const headerActions = (
		<span className="pm-qn-header-actions pm-quick-commands-header" onKeyDown={event => event.stopPropagation()}>
			<span className="pm-qn-count" title="Сохранённых команд">{items.length}</span>
			<button type="button" className="pm-qn-icon-btn" aria-label="Поиск быстрых команд"
				aria-expanded={showSearch} aria-controls={showSearch ? searchId : undefined} data-filter-active={query ? true : undefined}
				title={query ? `Поиск быстрых команд — ${filter.trim()}` : 'Поиск быстрых команд'}
				onClick={event => {
					event.stopPropagation();
					focusSearchOnOpen.current = !showSearch;
					setSearchOpen(!showSearch);
					if (collapsed) onToggleCollapse();
				}}>
				<QuickNoteIcon name="search" size={15} />
			</button>
			<button type="button" className="pm-qn-icon-btn" aria-label="Добавить быструю команду"
				title={canAdd ? 'Добавить быструю команду' : `Максимум ${DASHBOARD_QUICK_COMMAND_LIMIT} команд`}
				disabled={!canAdd} onClick={event => {
					event.stopPropagation();
					if (collapsed) onToggleCollapse();
					setDeleting(null);
					onEdit(null, event.currentTarget);
				}}>
				<QuickNoteIcon name="add" size={16} />
			</button>
			<label className="pm-qn-icon-btn pm-quick-commands-target" title={`Агент для быстрых команд — ${TARGET_LABELS[target]}`}
				onClick={event => event.stopPropagation()}>
				<QuickNoteIcon name="comment" size={14} />
				<span className="pm-quick-commands-target-name" aria-hidden="true">{TARGET_LABELS[target]}</span>
				<QuickNoteIcon name="chevron-down" size={10} />
				<select value={target} aria-label="Целевой чат агента" onChange={event => {
					const value = event.target.value;
					if (isDashboardQuickCommandTarget(value)) onTargetChange(value);
				}}>
					{DASHBOARD_QUICK_COMMAND_TARGETS.map(value => (
						<option key={value} value={value}>{TARGET_LABELS[value]}</option>
					))}
				</select>
			</label>
		</span>
	);

	const body = collapsed ? null : (
		<div className="pm-quick-commands">
			{searchOpen && <input type="search" className="pm-quick-commands-search" id={searchId} ref={searchInput}
				aria-label="Фильтр быстрых команд" placeholder="Поиск команды…" value={filter}
				onChange={event => {
					const value = event.target.value;
					if (value.trim().toLocaleLowerCase() !== query) setSearchExpanded({});
					setFilter(value);
				}} />}
			<div className="pm-quick-commands-list">
				{visibleGroups.length === 0 && <span className="pm-quick-commands-muted">
					{query ? 'Команды не найдены.' : 'Команд пока нет.'}
				</span>}
				{visibleGroups.map(({ category, commands, visible, key, expanded }) => (
					<QuickCommandGroup key={key} title={category || 'Без категории'} expanded={expanded} onToggle={() => toggleGroup(key)}>
						<SortableEditorSections scopeKey={category} gap={4} order={commands.map(item => item.title)}
							disabled={visible.length < 2} onReorder={order => reorder(category, commands, order)}>
							{visible.map(item => {
								const loading = pendingTitle === item.title;
								return (
									<div key={item.title} data-pm-editor-section={item.title}>
										<div className="pm-quick-commands-row">
											<EditorSectionDragHandle sectionKey={item.title} title={item.title} itemLabel="команду" />
											<button type="button" className="pm-quick-commands-run"
												title="Двойной щелчок или Enter — вставить без отправки"
												disabled={Boolean(pendingTitle)} aria-busy={loading || undefined}
												onClick={event => { if (event.detail === 0) onInsert(item, target); }}
												onDoubleClick={() => onInsert(item, target)}>
												<span>{item.title}</span>
												{loading && <span className="pm-quick-commands-progress" role="status" aria-label="Вставляю команду">
													<QuickNoteIcon name="loading" size={14} />
												</span>}
											</button>
											<button type="button" className="pm-quick-commands-icon" aria-label="Копировать команду"
												title="Копировать команду" disabled={Boolean(pendingTitle)} onClick={() => onCopy(item.text)}>
												<QuickNoteIcon name="clippy" size={13} />
											</button>
											<button type="button" className="pm-quick-commands-icon" aria-label="Изменить команду"
												title="Изменить команду" disabled={loading} onClick={event => { setDeleting(null); onEdit(item, event.currentTarget); }}>✎</button>
											<button type="button" className="pm-quick-commands-icon" aria-label="Удалить команду"
												title="Удалить команду" disabled={loading} onClick={() => setDeleting(item.title)}>
												<QuickNoteIcon name="trash" size={13} />
											</button>
										</div>
										{deleting === item.title && <div className="pm-quick-commands-confirm" role="group"
											aria-label="Подтверждение удаления команды">
											<span>Удалить эту команду?</span>
											<div className="pm-quick-commands-actions">
												<button type="button" ref={focusInActiveWebview} onClick={() => setDeleting(null)}>Отмена</button>
												<button type="button" className="is-primary" disabled={loading} onClick={() => {
													onItemsChange(items.filter(command => command.title !== item.title));
													setDeleting(null);
												}}>Удалить</button>
											</div>
										</div>}
									</div>
								);
							})}
						</SortableEditorSections>
					</QuickCommandGroup>
				))}
			</div>
		</div>
	);
	return <>{renderShell(headerActions, body)}<style>{QUICK_COMMANDS_CSS}</style></>;
}

/** Компактные строки и формы используют цвета VS Code и сохраняют место для действий. */
const QUICK_COMMANDS_CSS = `
.pm-quick-commands, .pm-quick-commands-list { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.pm-quick-commands-search {
	font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px;
	padding: 5px 7px; min-width: 0; box-sizing: border-box;
}
.pm-quick-commands-search { width: 100%; }
.pm-quick-command-modal label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
.pm-quick-command-modal input, .pm-quick-command-modal textarea { width: 100%; box-sizing: border-box; }
.pm-quick-command-modal [role="alert"] { color: var(--vscode-errorForeground); font-size: 12px; }
.pm-quick-command-variables { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.pm-quick-command-variables > span { flex-basis: 100%; }
.pm-quick-command-variables button { height: auto; min-height: 26px; white-space: normal; }
.pm-quick-command-preview { display: grid; justify-items: start; gap: 6px; min-width: 0; }
.pm-quick-command-preview [role="status"] {
	width: 100%; min-width: 0; min-height: 4em; padding: 8px 10px; box-sizing: border-box; border-radius: 4px;
	border: 1px solid var(--vscode-panel-border); background: var(--vscode-textCodeBlock-background);
	color: var(--vscode-foreground); overflow-wrap: anywhere; user-select: text;
}
.pm-quick-command-preview [aria-busy="true"] { color: var(--vscode-descriptionForeground); }
.pm-quick-command-preview-error { color: var(--vscode-errorForeground); }
.pm-quick-command-preview pre {
	margin: 0; white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace);
}
.pm-quick-commands-header [data-filter-active] { color: var(--vscode-textLink-foreground); }
.pm-quick-commands-header .pm-quick-commands-target { position: relative; width: auto; gap: 3px; padding: 0 3px; font-size: 11px; }
.pm-quick-commands-target select {
	position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer;
	color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
}
.pm-quick-commands-header button:focus-visible, .pm-quick-commands-target:has(select:focus-visible) {
	outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
}
@container pm-dashboard-widget (max-width: 359px) { .pm-quick-commands-target-name { display: none; } }
.pm-quick-commands-category, .pm-quick-commands-muted { font-size: 11px; color: var(--vscode-descriptionForeground); }
.pm-quick-commands-category {
	display: flex; align-items: center; gap: 4px; width: 100%; padding: 3px 2px;
	border: 0; background: transparent; font-family: inherit; font-weight: 600;
	text-align: start; overflow-wrap: anywhere; cursor: pointer;
}
.pm-quick-commands-category svg { flex: none; }
.pm-quick-commands-category[aria-expanded=true] { margin-bottom: 4px; }
.pm-quick-commands-category:hover { background: var(--vscode-list-hoverBackground); }
.pm-quick-commands-row { display: flex; align-items: stretch; border: 1px solid var(--vscode-panel-border); border-radius: 5px; }
.pm-quick-commands-row [data-pm-editor-section-handle] { flex: 0 0 18px; align-self: center; }
.pm-quick-commands-run {
	position: relative; display: flex; align-items: center; flex: 1; min-width: 0; padding: 6px 24px 6px 6px;
	background: transparent; text-align: left; color: var(--vscode-foreground); border: 0;
	cursor: pointer; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 12px;
}
.pm-quick-commands-run > span:first-child { flex: 1; min-width: 0; }
.pm-quick-commands-icon {
	display: grid; place-items: center; flex: 0 0 26px; border: 0; border-left: 1px solid var(--vscode-panel-border);
	background: transparent; color: var(--vscode-foreground); padding: 3px; cursor: pointer;
}
.pm-quick-commands-run:not(:disabled):hover, .pm-quick-commands-icon:not(:disabled):hover {
	background: var(--vscode-list-hoverBackground);
}
.pm-quick-commands-progress {
	position: absolute; inset-inline-end: 6px; display: flex; color: var(--vscode-progressBar-background);
}
.pm-quick-commands-progress svg { animation: pm-quick-command-spin 1s linear infinite; }
@keyframes pm-quick-command-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .pm-quick-commands-progress svg { animation: none; } }
.pm-quick-commands-confirm { display: flex; flex-direction: column; gap: 5px; }
.pm-quick-commands-confirm { padding: 5px; font-size: 12px; }
.pm-quick-commands-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 5px; }
.pm-quick-commands-actions button {
	padding: 5px 8px; color: var(--vscode-button-secondaryForeground);
	background: var(--vscode-button-secondaryBackground); border: 0; border-radius: 4px; cursor: pointer;
}
.pm-quick-commands-actions .is-primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.pm-quick-commands button:disabled { cursor: default; }
.pm-quick-commands-icon:disabled, .pm-quick-commands-actions button:disabled { opacity: .55; }
.pm-quick-commands :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
`;
