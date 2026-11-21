import React, { useEffect, useId, useRef, useState } from 'react';
import {
	DASHBOARD_QUICK_COMMAND_CATEGORY_LIMIT,
	DASHBOARD_QUICK_COMMAND_LIMIT,
	DASHBOARD_QUICK_COMMAND_TARGETS,
	DASHBOARD_QUICK_COMMAND_TEXT_LIMIT,
	isDashboardQuickCommandTarget,
	type DashboardQuickCommand,
	type DashboardQuickCommandTarget,
} from '../../../types/promptDashboardPreferences.js';
import { EditorSectionDragHandle, SortableEditorSections } from './SortableEditorSections';
import { QuickNoteIcon } from './quickNotes/QuickNoteIcon';

/** Подписи целей сохраняют привычный выбор провайдера и добавляют текущий чат. */
const TARGET_LABELS: Record<DashboardQuickCommandTarget, string> = {
	current: 'Текущий',
	copilot: 'Copilot',
	codex: 'OpenAI Codex',
	claude: 'Claude Code',
	'opencode-cli': 'OpenCode CLI',
};

/** Исходная фраза привязывает черновик к строке при перемещении и удалении соседей. */
type QuickCommandDraft = { originalText: string | null; text: string; category: string };

/** Общий список черновиков команд. Проверки в quickCommandsWidget.test.tsx. */
export function QuickCommandsWidget({
	items, target, pendingText, collapsed, onToggleCollapse, renderShell, onTargetChange, onItemsChange, onInsert, onCopy,
}: {
	items: DashboardQuickCommand[];
	target: DashboardQuickCommandTarget;
	pendingText?: string | null;
	collapsed: boolean;
	onToggleCollapse(): void;
	renderShell(actions: React.ReactNode, body: React.ReactNode | null): React.ReactNode;
	onTargetChange(target: DashboardQuickCommandTarget): void;
	onItemsChange(items: DashboardQuickCommand[]): void;
	onInsert(text: string, target: DashboardQuickCommandTarget): void;
	onCopy(text: string): void;
}): React.ReactElement {
	// Поиск и незавершённые действия относятся только к открытому виджету.
	const [filter, setFilter] = useState('');
	const [searchOpen, setSearchOpen] = useState(false);
	const searchId = useId();
	const searchInput = useRef<HTMLInputElement>(null);
	const editorInput = useRef<HTMLTextAreaElement>(null);
	const focusSearchOnOpen = useRef(false);
	const [draft, setDraft] = useState<QuickCommandDraft | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);
	const categoryListId = useId();
	const commandText = draft?.text.trim() ?? '';
	const duplicate = Boolean(draft && items.some(item => item.text === commandText && item.text !== draft.originalText));
	const canAdd = items.length < DASHBOARD_QUICK_COMMAND_LIMIT;
	const showSearch = searchOpen && !collapsed;

	// Фокус ставится после раскрытия карточки, когда поле уже появилось в DOM.
	useEffect(() => {
		if (showSearch && focusSearchOnOpen.current) {
			focusSearchOnOpen.current = false;
			searchInput.current?.focus();
		}
	}, [showSearch]);

	useEffect(() => {
		// Внешнее обновление настроек может удалить строку с открытой формой или подтверждением.
		setDraft(previous => previous?.originalText && !items.some(item => item.text === previous.originalText) ? null : previous);
		setDeleting(previous => previous && !items.some(item => item.text === previous) ? null : previous);
	}, [items]);

	/** Открывает форму команды с текущей категорией или пустыми полями. */
	const openEditor = (item?: DashboardQuickCommand) => {
		focusSearchOnOpen.current = false;
		if (collapsed) onToggleCollapse();
		setDeleting(null);
		if (!item && draft?.originalText === null) {
			editorInput.current?.focus();
			return;
		}
		setDraft({ originalText: item?.text ?? null, text: item?.text ?? '', category: item?.category ?? '' });
	};

	/** Обновляет выбранную строку или дописывает новую команду, сохраняя её категорию. */
	const save = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!draft || !commandText || duplicate || commandText.length > DASHBOARD_QUICK_COMMAND_TEXT_LIMIT) return;
		const category = draft.category.trim();
		const command: DashboardQuickCommand = category ? { text: commandText, category } : { text: commandText };
		if (draft.originalText === null) {
			if (!canAdd) return;
			onItemsChange([...items, command]);
		} else {
			if (!items.some(item => item.text === draft.originalText)) return;
			onItemsChange(items.map(item => item.text === draft.originalText ? command : item));
		}
		setDraft(null);
	};

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
			: commands.filter(item => item.text.toLocaleLowerCase().includes(query));
		return visible.length ? [{ category, commands, visible }] : [];
	});

	/** Переставляет команды в выбранной группе, сохраняя позиции остальных групп. */
	const reorder = (category: string, commands: DashboardQuickCommand[], order: string[]) => {
		const commandsByText = new Map(commands.map(command => [command.text, command]));
		const ordered = order.map(text => commandsByText.get(text)).filter(command => command !== undefined);
		let index = 0;
		onItemsChange(items.map(item => (item.category ?? '') === category ? ordered[index++] ?? item : item));
	};

	// Одна форма обслуживает добавление и редактирование внутри списка.
	const editor = draft && (
		<form className="pm-quick-commands-edit" onSubmit={save} onKeyDown={event => {
			if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
				event.stopPropagation();
				setDraft(null);
			}
		}}>
			<textarea ref={editorInput} rows={2} autoFocus value={draft.text} maxLength={DASHBOARD_QUICK_COMMAND_TEXT_LIMIT}
				aria-label={draft.originalText === null ? 'Новая быстрая команда' : 'Редактировать быструю команду'}
				placeholder="Введите команду или фразу…"
				onChange={event => setDraft({ ...draft, text: event.target.value })}
				onKeyDown={event => {
					if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
						event.preventDefault();
						event.currentTarget.form?.requestSubmit();
					}
				}} />
			<label>Категория
				<input value={draft.category} placeholder="Без категории" list={categoryListId}
					maxLength={DASHBOARD_QUICK_COMMAND_CATEGORY_LIMIT}
					onChange={event => setDraft({ ...draft, category: event.target.value })} />
			</label>
			{duplicate && <div className="pm-quick-commands-error" role="alert">Такая команда уже есть.</div>}
			<div className="pm-quick-commands-actions">
				<button type="button" onClick={() => setDraft(null)}>Отмена</button>
				<button type="submit" className="is-primary" disabled={!commandText || duplicate}>Сохранить</button>
			</div>
		</form>
	);

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
					openEditor();
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
				onChange={event => setFilter(event.target.value)} />}
			<datalist id={categoryListId}>
				{[...categories.keys()].filter(Boolean).map(category => <option key={category} value={category} />)}
			</datalist>
			<div className="pm-quick-commands-list">
				{visibleGroups.length === 0 && !draft && <span className="pm-quick-commands-muted">
					{query ? 'Команды не найдены.' : 'Команд пока нет.'}
				</span>}
				{visibleGroups.map(({ category, commands, visible }) => (
					<div key={category} role="group" aria-label={category || 'Без категории'}>
						{(category || categories.size > 1) &&
							<div className="pm-quick-commands-category">{category || 'Без категории'}</div>}
						<SortableEditorSections scopeKey={category} gap={4} order={commands.map(item => item.text)}
							disabled={visible.length < 2} onReorder={order => reorder(category, commands, order)}>
							{visible.map(item => {
								const loading = pendingText === item.text;
								return (
									<div key={item.text} data-pm-editor-section={item.text}>
										{draft?.originalText === item.text ? editor : <>
											<div className="pm-quick-commands-row">
												<EditorSectionDragHandle sectionKey={item.text} title={item.text} itemLabel="команду" />
												<button type="button" className="pm-quick-commands-run"
													title="Двойной щелчок или Enter — вставить без отправки"
													disabled={Boolean(pendingText)} aria-busy={loading || undefined}
													onClick={event => { if (event.detail === 0) onInsert(item.text, target); }}
													onDoubleClick={() => onInsert(item.text, target)}>
													<span>{item.text}</span>
													{loading && <span className="pm-quick-commands-progress" role="status" aria-label="Вставляю команду">
														<QuickNoteIcon name="loading" size={14} />
													</span>}
												</button>
												<button type="button" className="pm-quick-commands-icon" aria-label="Копировать команду"
													title="Копировать команду" disabled={Boolean(pendingText)} onClick={() => onCopy(item.text)}>
													<QuickNoteIcon name="clippy" size={13} />
												</button>
												<button type="button" className="pm-quick-commands-icon" aria-label="Изменить команду"
													title="Изменить команду" disabled={loading} onClick={() => openEditor(item)}>✎</button>
												<button type="button" className="pm-quick-commands-icon" aria-label="Удалить команду"
													title="Удалить команду" disabled={loading} onClick={() => setDeleting(item.text)}>
													<QuickNoteIcon name="trash" size={13} />
												</button>
											</div>
											{deleting === item.text && <div className="pm-quick-commands-confirm" role="group"
												aria-label="Подтверждение удаления команды">
												<span>Удалить эту команду?</span>
												<div className="pm-quick-commands-actions">
													<button type="button" autoFocus onClick={() => setDeleting(null)}>Отмена</button>
													<button type="button" className="is-primary" disabled={loading} onClick={() => {
														onItemsChange(items.filter(command => command.text !== item.text));
														setDeleting(null);
													}}>Удалить</button>
												</div>
											</div>}
										</>}
									</div>
								);
							})}
						</SortableEditorSections>
					</div>
				))}
			</div>
			{draft?.originalText === null && editor}
		</div>
	);
	return <>{renderShell(headerActions, body)}<style>{QUICK_COMMANDS_CSS}</style></>;
}

/** Компактные строки и формы используют цвета VS Code и сохраняют место для действий. */
const QUICK_COMMANDS_CSS = `
.pm-quick-commands, .pm-quick-commands-list { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.pm-quick-commands label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.pm-quick-commands input, .pm-quick-commands textarea {
	font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px;
	padding: 5px 7px; min-width: 0; box-sizing: border-box;
}
.pm-quick-commands-search { width: 100%; }
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
.pm-quick-commands-list { max-height: 260px; overflow-y: auto; }
.pm-quick-commands-category, .pm-quick-commands-muted { font-size: 11px; color: var(--vscode-descriptionForeground); }
.pm-quick-commands-category { margin: 0 0 4px; font-weight: 600; overflow-wrap: anywhere; }
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
.pm-quick-commands-edit, .pm-quick-commands-confirm { display: flex; flex-direction: column; gap: 5px; }
.pm-quick-commands-edit textarea { resize: vertical; }
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
.pm-quick-commands-error { color: var(--vscode-errorForeground); font-size: 12px; }
`;
