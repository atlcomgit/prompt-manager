import type { FilterState, GroupBy } from '../types/prompt.js';

export function hasActiveSidebarFilters(filters: FilterState): boolean {
	return Boolean(
		filters.search
		|| filters.status.length > 0
		|| filters.projects.length > 0
		|| filters.languages.length > 0
		|| filters.frameworks.length > 0
		|| filters.favorites
		|| filters.createdAt !== 'all',
	);
}

export function shouldAutoExpandSidebarGroups(groupBy: GroupBy, filters: FilterState): boolean {
	return groupBy !== 'none' && hasActiveSidebarFilters(filters);
}

export function resolveEffectiveSidebarCollapsedGroups(
	collapsedGroups: Record<string, boolean>,
	filteredCollapsedGroups: Record<string, boolean>,
	shouldAutoExpandGroups: boolean,
): Record<string, boolean> {
	return shouldAutoExpandGroups ? filteredCollapsedGroups : collapsedGroups;
}

export function toggleSidebarGroupCollapsedState(
	collapsedGroups: Record<string, boolean>,
	collapseKey: string,
): Record<string, boolean> {
	if (collapsedGroups[collapseKey]) {
		const nextCollapsedGroups = { ...collapsedGroups };
		delete nextCollapsedGroups[collapseKey];
		return nextCollapsedGroups;
	}

	return {
		...collapsedGroups,
		[collapseKey]: true,
	};
}

export function makeSidebarGroupCollapseKey(group: GroupBy, name: string): string {
	return `${group}::${name}`;
}

