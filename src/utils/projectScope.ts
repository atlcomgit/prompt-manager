/** Normalize requested project names and preserve the first-seen order. */
export function normalizeProjectNames(projectNames: string[]): string[] {
	return Array.from(new Set((projectNames || [])
		.map(project => project.trim())
		.filter(Boolean)));
}

/** Resolve project scope against workspace projects with fallback to the full workspace. */
export function resolveEffectiveProjectNames(
	requestedProjectNames: string[],
	workspaceProjectNames: string[],
): string[] {
	const normalizedWorkspaceProjects = normalizeProjectNames(workspaceProjectNames);
	if (normalizedWorkspaceProjects.length === 0) {
		return [];
	}

	const normalizedRequestedProjects = normalizeProjectNames(requestedProjectNames);
	if (normalizedRequestedProjects.length === 0) {
		return normalizedWorkspaceProjects;
	}

	const workspaceProjects = new Set(normalizedWorkspaceProjects);
	const matchedProjects = normalizedRequestedProjects.filter(project => workspaceProjects.has(project));
	return matchedProjects.length > 0 ? matchedProjects : normalizedWorkspaceProjects;
}