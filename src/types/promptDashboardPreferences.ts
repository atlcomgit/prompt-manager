import type { DockerContainersStatusFilter, DockerContainersViewMode } from './docker.js';
import { PROMPT_DASHBOARD_SECTION_KEYS, type PromptDashboardSectionKey } from './promptDashboard.js';
import { QUICK_NOTE_PALETTE_COLORS, type QuickNoteScope, type QuickNotesBoardGroupBy, type QuickNotesBoardScopeFilter } from './quickNotes.js';
import { normalizeQuickNoteColor } from '../utils/quickNotes.js';

/** Поле сортировки контейнеров, общее для host и webview. */
export type DockerContainerSortBy = 'name' | 'status' | 'uptime' | 'cpu' | 'memory';

/** Сохраняемые настройки Docker без текущих операций и загружаемых метрик. */
export interface DashboardDockerWidgetState {
	/** Отсутствующий вид позволяет использовать настройку расширения при первом открытии. */
	viewMode?: DockerContainersViewMode;
	/** Фильтр, строка поиска и порядок отображения контейнеров. */
	statusFilter: DockerContainersStatusFilter;
	search: string;
	sortBy: DockerContainerSortBy;
	/** Ключи раскрытых контейнеров, проектов и compose-файлов. */
	expandedContainerIds: string[];
}

/** Фильтры TODO, общие для рабочих областей через пользовательские настройки. */
export interface DashboardTodosWidgetState {
	/** Нормализованные расширения файлов; пустой список означает отсутствие фильтра. */
	selectedFileTypes: string[];
	/** Текст поиска сохраняется без преобразований. */
	search: string;
}

/** Вид быстрых заметок: область новой заметки, фильтры виджета и параметры доски. */
export interface DashboardQuickNotesWidgetState {
	/** Куда сохраняется новая заметка из поля виджета и доски при фильтре «Все». */
	newNoteScope: QuickNoteScope;
	/** Последний цвет, выбранный в поле добавления виджета. */
	newNoteColor: string;
	/** Поиск и выбранные ключи цветов списка виджета; пустой список — без фильтра. */
	search: string;
	colors: string[];
	/** Группировка, фильтр области и показ выполненных на доске. */
	boardGroupBy: QuickNotesBoardGroupBy;
	boardScope: QuickNotesBoardScopeFilter;
	boardShowDone: boolean;
	/** Общая высота поля описания в окне заметки (пользовательская настройка). */
	descriptionHeight?: number;
}

/** Цели виджета, включая открытый чат текущего окна. */
export const DASHBOARD_QUICK_COMMAND_TARGETS = ['current', 'copilot', 'codex', 'claude', 'opencode-cli'] as const;

/** Выбранный способ адресации черновика. */
export type DashboardQuickCommandTarget = typeof DASHBOARD_QUICK_COMMAND_TARGETS[number];

/** Ограничения общих настроек, формы команды и сообщения вставки. */
export const DASHBOARD_QUICK_COMMAND_LIMIT = 120;
export const DASHBOARD_QUICK_COMMAND_TEXT_LIMIT = 3000;
export const DASHBOARD_QUICK_COMMAND_CATEGORY_LIMIT = 80;

/** Название уникально в списке. Текст черновика может быть многострочным или пустым. */
export interface DashboardQuickCommand {
	title: string;
	text: string;
	category?: string;
}

/** A modal saves only its own row. The original remains the comparison base across retries. */
export interface DashboardQuickCommandEdit {
	original: DashboardQuickCommand | null;
	command: DashboardQuickCommand;
	restore?: { title: string; text: string };
}

/** Порядок команд и выбранный агент общие для всех промптов. */
export interface DashboardQuickCommandsWidgetState {
	items: DashboardQuickCommand[];
	/** Unassigned legacy templates can be restored explicitly in any command editor. */
	recoverableTexts?: Record<string, string>;
	target?: DashboardQuickCommandTarget;
}

/** Формат глобальных настроек. Строковый список доступен в прежних версиях расширения. */
export interface DashboardQuickCommandsConfiguration {
	items: string[];
	categories: Record<string, string>;
	texts: Record<string, string>;
	target?: DashboardQuickCommandTarget;
}

/** Старая фраза служит текстом по умолчанию. Явно очищенный текст сохраняется пустой строкой. */
export function serializeDashboardQuickCommands(state: DashboardQuickCommandsWidgetState): DashboardQuickCommandsConfiguration {
	const byTitle = [...state.items].sort((a, b) => a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
	return {
		items: state.items.map(command => command.title),
		categories: Object.fromEntries(byTitle.flatMap(({ title, category }) => category ? [[title, category]] : [])),
		texts: Object.fromEntries(byTitle.filter(item => item.title !== item.text).map(item => [item.title, item.text])),
		target: state.target,
	};
}

/** Принимает только поддерживаемые цели сообщений и глобальных настроек. */
export function isDashboardQuickCommandTarget(value: unknown): value is DashboardQuickCommandTarget {
	return DASHBOARD_QUICK_COMMAND_TARGETS.some(target => target === value);
}

/** Читает карту по собственным ключам, включая названия команд вроде «constructor». */
function readQuickCommandMap(value: unknown): Map<string, unknown> {
	return new Map(value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []);
}

/** Читает старые фразы и новые именованные команды. Проверки в quickCommandsWidget.test.tsx. */
export function normalizeDashboardQuickCommandsWidgetState(value: unknown): DashboardQuickCommandsWidgetState {
	const input: Partial<Record<keyof DashboardQuickCommandsConfiguration | 'recoverableTexts', unknown>> = value && typeof value === 'object' && !Array.isArray(value)
		? { ...value } : {};
	const entries: readonly unknown[] = Array.isArray(input.items)
		? input.items : ['/alek-review', 'есть еще уточнения или вопросы?'];
	const categories = readQuickCommandMap(input.categories);
	const texts = readQuickCommandMap(input.texts);
	const commands = new Map<string, DashboardQuickCommand>();
	for (const entry of entries) {
		const command: Partial<Record<keyof DashboardQuickCommand, unknown>> =
			entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : {};
		const named = Object.hasOwn(command, 'title');
		const rawTitle = typeof entry === 'string' ? entry : named ? command.title : command.text;
		const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
		if (!title || title.length > DASHBOARD_QUICK_COMMAND_TEXT_LIMIT || commands.has(title)) continue;
		const rawText = texts.has(title) ? texts.get(title) : named ? command.text : title;
		const text = typeof rawText === 'string' && rawText.length <= DASHBOARD_QUICK_COMMAND_TEXT_LIMIT ? rawText : '';
		const value = categories.has(title) ? categories.get(title) : command.category;
		const category = typeof value === 'string' ? value.trim().slice(0, DASHBOARD_QUICK_COMMAND_CATEGORY_LIMIT) : '';
		commands.set(title, { title, text, ...(category ? { category } : {}) });
		if (commands.size === DASHBOARD_QUICK_COMMAND_LIMIT) break;
	}
	const recovered = [...readQuickCommandMap(input.recoverableTexts)].filter((entry): entry is [string, string] =>
		typeof entry[1] === 'string' && entry[1].length <= DASHBOARD_QUICK_COMMAND_TEXT_LIMIT);
	return { items: [...commands.values()], ...(recovered.length ? { recoverableTexts: Object.fromEntries(recovered) } : {}),
		...(isDashboardQuickCommandTarget(input.target) ? { target: input.target } : {}) };
}

/** Общие настройки представления виджетов, не зависящие от ширины и выбранного промпта. */
export interface PromptDashboardPreferences {
	/** Независимые фильтры и раскрытия Docker и TODO. */
	docker: DashboardDockerWidgetState;
	todos: DashboardTodosWidgetState;
	quickNotes: DashboardQuickNotesWidgetState;
	quickCommands: DashboardQuickCommandsWidgetState;
	/** Явный false сохраняет закрытие узлов Git, раскрытых по умолчанию. */
	expanded: Record<string, boolean>;
	/** Раскрытые и свёрнутые проекты и папки Bash в текущей рабочей области. */
	bashScriptExpanded: Record<string, boolean>;
	/** Ordered child identifiers for each list in the Bash scripts widget. */
	bashScriptOrder: Record<string, string[]>;
	/** Favorite scripts are keyed independently from their current folder. */
	bashScriptFavorites: Record<string, boolean>;
	/** Hiding a folder preserves its disclosure, scripts and ordering. */
	bashScriptHiddenFolders: Record<string, boolean>;
	/** Показывать в карточке веток все проекты, а не только проекты промпта. */
	showAllBranchProjects: boolean;
	/**
	 * Виджеты, скрытые меню «⋯» панели «Обзор»: не отображаются и не загружают данные. Общая настройка для всех
	 * рабочих областей и обеих ширин панели, в отличие от сворачивания.
	 */
	hiddenSections: PromptDashboardSectionKey[];
}

/** Известные ключи скрытых виджетов без повторов в порядке секций панели. */
export function normalizePromptDashboardHiddenSections(value: unknown): PromptDashboardSectionKey[] {
	const requested = new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
	return PROMPT_DASHBOARD_SECTION_KEYS.filter(section => requested.has(section));
}

/** Нормализует Docker state без усечения валидных данных; tests/promptDashboardPreferences.test.ts. */
export function normalizePromptDashboardDockerWidgetState(value: unknown): DashboardDockerWidgetState {
	// Копирование собственных полей исключает унаследованные настройки и значения из массивов.
	const input: Partial<DashboardDockerWidgetState> = value && typeof value === 'object' && !Array.isArray(value)
		? { ...value }
		: {};
	const viewMode = input.viewMode === 'tree' || input.viewMode === 'cards'
		|| input.viewMode === 'table' || input.viewMode === 'list' ? input.viewMode : undefined;
	const statusFilter = input.statusFilter === 'running' || input.statusFilter === 'stopped'
		? input.statusFilter : 'all';
	const search = typeof input.search === 'string' ? input.search : '';
	const sortBy = input.sortBy === 'name' || input.sortBy === 'uptime' || input.sortBy === 'cpu'
		|| input.sortBy === 'memory' ? input.sortBy : 'status';
	const expandedContainerIds = Array.isArray(input.expandedContainerIds)
		? Array.from(new Set(input.expandedContainerIds.filter(
			(item): item is string => typeof item === 'string' && item.trim().length > 0,
		)))
		: [];
	return viewMode
		? { viewMode, statusFilter, search, sortBy, expandedContainerIds }
		: { statusFilter, search, sortBy, expandedContainerIds };
}

/** Нормализует фильтры TODO, отбрасывая нестроковые значения; tests/promptDashboardPreferences.test.ts. */
export function normalizePromptDashboardTodosWidgetState(value: unknown): DashboardTodosWidgetState {
	// Старые строковые фильтры сохраняют прежнюю нормализацию регистра и пробелов.
	const input: Partial<DashboardTodosWidgetState> = value && typeof value === 'object' && !Array.isArray(value)
		? { ...value }
		: {};
	const selectedFileTypes = Array.isArray(input.selectedFileTypes)
		? Array.from(new Set(input.selectedFileTypes
			.filter((item): item is string => typeof item === 'string')
			.map(item => item.trim().toLowerCase())
			.filter(Boolean)))
		: [];
	const search = typeof input.search === 'string' ? input.search : '';
	return { selectedFileTypes, search };
}

/** Нормализует вид быстрых заметок; ключи цветов — палитра, `#rrggbb` или `none`; tests/promptDashboardPreferences.test.ts. */
export function normalizePromptDashboardQuickNotesWidgetState(value: unknown): DashboardQuickNotesWidgetState {
	const input: Partial<Record<keyof DashboardQuickNotesWidgetState, unknown>> = value && typeof value === 'object'
		&& !Array.isArray(value) ? { ...value } : {};
	const isColorKey = (key: string) => key === 'none' || /^#[0-9a-f]{6}$/.test(key)
		|| (QUICK_NOTE_PALETTE_COLORS as readonly string[]).includes(key);
	const colors = Array.isArray(input.colors)
		? Array.from(new Set(input.colors
			.filter((item): item is string => typeof item === 'string')
			.map(item => item.trim().toLowerCase())
			.filter(isColorKey)))
		: [];
	return {
		newNoteScope: input.newNoteScope === 'global' ? 'global' : 'workspace',
		newNoteColor: normalizeQuickNoteColor(input.newNoteColor),
		search: typeof input.search === 'string' ? input.search : '',
		colors,
		boardGroupBy: input.boardGroupBy === 'color' || input.boardGroupBy === 'scope' ? input.boardGroupBy : 'none',
		boardScope: input.boardScope === 'workspace' || input.boardScope === 'global' ? input.boardScope : 'all',
		boardShowDone: input.boardShowDone === true,
		...(typeof input.descriptionHeight === 'number' && Number.isFinite(input.descriptionHeight)
			? { descriptionHeight: Math.max(84, Math.min(1000, Math.round(input.descriptionHeight))) }
			: {}),
	};
}

/** Read own map entries and exclude names that cannot safely participate in a settings patch. */
function preferenceEntries(value: unknown): [string, unknown][] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
	return Object.entries(value).filter(([key]) =>
		key.trim() && key !== '__proto__' && key !== 'constructor' && key !== 'prototype');
}

/** Keep explicit false values for both default-open disclosures and manually edited settings. */
function booleanPreferences(value: unknown): Record<string, boolean> {
	return Object.fromEntries(preferenceEntries(value).filter((entry): entry is [string, boolean] =>
		typeof entry[1] === 'boolean'));
}

/** Copy each child list in its saved order, retaining the first occurrence of each identifier. */
function normalizeBashScriptOrder(value: unknown): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [parent, children] of preferenceEntries(value)) {
		if (!Array.isArray(children)) continue;
		result[parent] = [...new Set(children.filter((id): id is string => typeof id === 'string' && !!id.trim()))];
	}
	return result;
}

/** Проверяет сохранённый JSON и сохраняет закрытые узлы; tests/promptDashboardPreferences.test.ts. */
export function normalizePromptDashboardPreferences(value: unknown): PromptDashboardPreferences {
	// Состояние состоит только из известных полей; прототипные ключи не становятся ключами раскрытий.
	const input: Partial<PromptDashboardPreferences> = value && typeof value === 'object' && !Array.isArray(value)
		? { ...value }
		: {};
	const expanded = booleanPreferences(input.expanded);
	return {
		docker: normalizePromptDashboardDockerWidgetState(input.docker),
		todos: normalizePromptDashboardTodosWidgetState(input.todos),
		quickNotes: normalizePromptDashboardQuickNotesWidgetState(input.quickNotes),
		quickCommands: normalizeDashboardQuickCommandsWidgetState(input.quickCommands),
		expanded,
		// До появления отдельного поля виджет сохранял свои ключи в общей карте раскрытий.
		bashScriptExpanded: input.bashScriptExpanded === undefined
			? Object.fromEntries(Object.entries(expanded).filter(([key]) => key.startsWith('bashScripts:')))
			: booleanPreferences(input.bashScriptExpanded),
		bashScriptOrder: normalizeBashScriptOrder(input.bashScriptOrder),
		bashScriptFavorites: booleanPreferences(input.bashScriptFavorites),
		bashScriptHiddenFolders: booleanPreferences(input.bashScriptHiddenFolders),
		showAllBranchProjects: input.showAllBranchProjects === true,
		hiddenSections: normalizePromptDashboardHiddenSections(input.hiddenSections),
	};
}
