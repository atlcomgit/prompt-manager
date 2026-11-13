import type { DockerContainersStatusFilter, DockerContainersViewMode } from './docker.js';

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

/** Фильтры TODO, одинаковые для всех промптов рабочей области. */
export interface DashboardTodosWidgetState {
	/** Нормализованные расширения файлов; пустой список означает отсутствие фильтра. */
	selectedFileTypes: string[];
	/** Текст поиска сохраняется без преобразований. */
	search: string;
}

/** Общие настройки представления виджетов, не зависящие от ширины и выбранного промпта. */
export interface PromptDashboardPreferences {
	/** Независимые фильтры и раскрытия Docker и TODO. */
	docker: DashboardDockerWidgetState;
	todos: DashboardTodosWidgetState;
	/** Явный false сохраняет закрытие узлов Git, раскрытых по умолчанию. */
	expanded: Record<string, boolean>;
	/** Показывать в карточке веток все проекты, а не только проекты промпта. */
	showAllBranchProjects: boolean;
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
		expanded,
		showAllBranchProjects: input.showAllBranchProjects === true,
	};
}
