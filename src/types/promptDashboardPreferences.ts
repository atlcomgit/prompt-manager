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

/** Фраза уникальна в списке, пустая категория означает общий список. */
export interface DashboardQuickCommand {
	text: string;
	category?: string;
}

/** Порядок фраз и выбранный агент общие для всех промптов. */
export interface DashboardQuickCommandsWidgetState {
	items: DashboardQuickCommand[];
	target?: DashboardQuickCommandTarget;
}

/** Формат глобальных настроек. Строковый список доступен в прежних версиях расширения. */
export interface DashboardQuickCommandsConfiguration {
	items: string[];
	categories: Record<string, string>;
	target?: DashboardQuickCommandTarget;
}

/** Записывает порядок отдельно от категорий, отсортированных по ключу для сравнения сохранений. */
export function serializeDashboardQuickCommands(state: DashboardQuickCommandsWidgetState): DashboardQuickCommandsConfiguration {
	const categories = new Map<string, string>();
	for (const { text, category } of state.items) {
		if (category) categories.set(text, category);
	}
	return {
		items: state.items.map(command => command.text),
		categories: Object.fromEntries([...categories].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
		target: state.target,
	};
}

/** Принимает только поддерживаемые цели сообщений и глобальных настроек. */
export function isDashboardQuickCommandTarget(value: unknown): value is DashboardQuickCommandTarget {
	return DASHBOARD_QUICK_COMMAND_TARGETS.some(target => target === value);
}

/** Читает сохранённые строки и записи с категориями в исходном порядке. Проверки в quickCommandsWidget.test.tsx. */
export function normalizeDashboardQuickCommandsWidgetState(value: unknown): DashboardQuickCommandsWidgetState {
	const input: { items?: unknown; categories?: unknown; target?: unknown } = value && typeof value === 'object' && !Array.isArray(value)
		? { ...value } : {};
	const entries: readonly unknown[] = Array.isArray(input.items)
		? input.items : ['/alek-review', 'есть еще уточнения или вопросы?'];
	const categories = input.categories && typeof input.categories === 'object' && !Array.isArray(input.categories)
		? new Map<string, unknown>(Object.entries(input.categories)) : new Map<string, unknown>();
	const commands = new Map<string, DashboardQuickCommand>();
	for (const entry of entries) {
		const command: { text?: unknown; category?: unknown } = typeof entry === 'string'
			? { text: entry } : entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
		const text = typeof command.text === 'string' ? command.text.trim() : '';
		if (!text || text.length > DASHBOARD_QUICK_COMMAND_TEXT_LIMIT || commands.has(text)) continue;
		const value = categories.has(text) ? categories.get(text) : command.category;
		const category = typeof value === 'string' ? value.trim().slice(0, DASHBOARD_QUICK_COMMAND_CATEGORY_LIMIT) : '';
		commands.set(text, category ? { text, category } : { text });
		if (commands.size === DASHBOARD_QUICK_COMMAND_LIMIT) break;
	}
	return { items: [...commands.values()], ...(isDashboardQuickCommandTarget(input.target) ? { target: input.target } : {}) };
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

/** Проверяет сохранённый JSON и сохраняет закрытые узлы; tests/promptDashboardPreferences.test.ts. */
export function normalizePromptDashboardPreferences(value: unknown): PromptDashboardPreferences {
	// Состояние состоит только из известных полей; прототипные ключи не становятся ключами раскрытий.
	const input: Partial<PromptDashboardPreferences> = value && typeof value === 'object' && !Array.isArray(value)
		? { ...value }
		: {};
	const expanded: Record<string, boolean> = {};
	if (input.expanded && typeof input.expanded === 'object' && !Array.isArray(input.expanded)) {
		for (const [key, isExpanded] of Object.entries(input.expanded)) {
			if (key.trim() && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
				&& typeof isExpanded === 'boolean') {
				expanded[key] = isExpanded;
			}
		}
	}
	return {
		docker: normalizePromptDashboardDockerWidgetState(input.docker),
		todos: normalizePromptDashboardTodosWidgetState(input.todos),
		quickNotes: normalizePromptDashboardQuickNotesWidgetState(input.quickNotes),
		quickCommands: normalizeDashboardQuickCommandsWidgetState(input.quickCommands),
		expanded,
		showAllBranchProjects: input.showAllBranchProjects === true,
		hiddenSections: normalizePromptDashboardHiddenSections(input.hiddenSections),
	};
}
