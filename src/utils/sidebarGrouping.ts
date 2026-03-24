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

export function makeSidebarGroupCollapseKey(group: GroupBy, name: string): string {
	return `${group}::${name}`;
}

