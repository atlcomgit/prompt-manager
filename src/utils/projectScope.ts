/** Normalize requested project names and preserve the first-seen order. */
export function normalizeProjectNames(projectNames: string[]): string[] {
	return Array.from(new Set((projectNames || [])
		.map(project => project.trim())
		.filter(Boolean)));
}

export interface ResolveProjectScopeOptions {
	excludedProjectNames?: string[];
	fallbackToWorkspaceWhenSelectionInvalid?: boolean;
}

/** Drop globally excluded projects from a project-name list while keeping the original order. */
export function excludeProjectNames(
	projectNames: string[],
	excludedProjectNames: string[],
): string[] {
	const normalizedProjectNames = normalizeProjectNames(projectNames);
	if (normalizedProjectNames.length === 0) {
		return [];
	}

	const excludedProjects = new Set(normalizeProjectNames(excludedProjectNames));
	if (excludedProjects.size === 0) {
		return normalizedProjectNames;
	}

	return normalizedProjectNames.filter(project => !excludedProjects.has(project));
}

/** Resolve project scope against workspace projects with fallback to the full workspace. */
export function resolveEffectiveProjectNames(
	requestedProjectNames: string[],
	workspaceProjectNames: string[],
	options: ResolveProjectScopeOptions = {},
): string[] {
	const normalizedExcludedProjectNames = normalizeProjectNames(options.excludedProjectNames || []);
	const visibleWorkspaceProjects = excludeProjectNames(
		workspaceProjectNames,
		normalizedExcludedProjectNames,
	);
	if (visibleWorkspaceProjects.length === 0) {
		return [];
	}

	const normalizedRequestedProjects = normalizeProjectNames(requestedProjectNames);
	if (normalizedRequestedProjects.length === 0) {
		return visibleWorkspaceProjects;
	}

	const nonExcludedRequestedProjects = normalizedRequestedProjects.filter(project => !normalizedExcludedProjectNames.includes(project));
	if (nonExcludedRequestedProjects.length === 0 && normalizedExcludedProjectNames.length > 0) {
		return [];
	}

	const workspaceProjects = new Set(visibleWorkspaceProjects);
	const matchedProjects = nonExcludedRequestedProjects.filter(project => workspaceProjects.has(project));
	if (matchedProjects.length > 0) {
		return matchedProjects;
	}

	return options.fallbackToWorkspaceWhenSelectionInvalid === false
		? []
		: visibleWorkspaceProjects;
}