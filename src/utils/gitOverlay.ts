import type { GitOverlayBranchKind, GitOverlayGraphEdge, GitOverlayGraphNode } from '../types/git.js';

export function resolveGitOverlayBranchNames(
	trackedBranches: string[],
	promptBranch: string,
	currentBranch: string,
): string[] {
	const result = new Set<string>();

	for (const branch of trackedBranches) {
		const normalized = branch.trim();
		if (normalized) {
			result.add(normalized);
		}
	}

	const normalizedPromptBranch = promptBranch.trim();
	if (normalizedPromptBranch) {
		result.add(normalizedPromptBranch);
	}

	const normalizedCurrentBranch = currentBranch.trim();
	if (normalizedCurrentBranch) {
		result.add(normalizedCurrentBranch);
	}

	return [...result];
}

export function canDeleteGitOverlayBranch(
	branchName: string,
	currentBranch: string,
	trackedBranches: string[],
	promptBranch: string,
): boolean {
	const normalizedBranch = branchName.trim();
	if (!normalizedBranch) {
		return false;
	}

	if (normalizedBranch === currentBranch.trim()) {
		return false;
	}

	if (normalizedBranch === promptBranch.trim()) {
		return false;
	}

	return !trackedBranches
		.map(branch => branch.trim())
		.filter(Boolean)
		.includes(normalizedBranch);
}

export function normalizeCommitMessageGenerationInstructions(value: unknown): string {
	if (typeof value === 'string') {
		return value.trim();
	}

	if (Array.isArray(value)) {
		return value
			.map(item => String(item || '').trim())
			.filter(Boolean)
			.join('\n');
	}

	return '';
}

export function buildGitOverlayGraph(input: {
	branchNames: string[];
	trackedBranches: string[];
	promptBranch: string;
	currentBranch: string;
	currentUpstream?: string;
}): { nodes: GitOverlayGraphNode[]; edges: GitOverlayGraphEdge[] } {
	const nodes = new Map<string, GitOverlayGraphNode>();
	const edges = new Map<string, GitOverlayGraphEdge>();

	const addNode = (name: string, kind: GitOverlayBranchKind, current = false) => {
		const normalized = name.trim();
		if (!normalized) {
			return;
		}

		const existing = nodes.get(normalized);
		if (existing) {
			nodes.set(normalized, {
				...existing,
				kind: existing.kind === 'current' || existing.kind === 'prompt' ? existing.kind : kind,
				current: existing.current || current,
			});
			return;
		}

		nodes.set(normalized, {
			id: normalized,
			label: normalized,
			kind,
			current,
		});
	};

	for (const branchName of input.branchNames) {
		const normalized = branchName.trim();
		if (!normalized) {
			continue;
		}

		let kind: GitOverlayBranchKind = 'local';
		if (normalized === input.currentBranch.trim()) {
			kind = 'current';
		} else if (normalized === input.promptBranch.trim()) {
			kind = 'prompt';
		} else if (input.trackedBranches.map(branch => branch.trim()).includes(normalized)) {
			kind = 'tracked';
		}

		addNode(normalized, kind, normalized === input.currentBranch.trim());
	}

	const normalizedPromptBranch = input.promptBranch.trim();
	if (normalizedPromptBranch) {
		addNode(normalizedPromptBranch, 'prompt', normalizedPromptBranch === input.currentBranch.trim());
	}

	for (const trackedBranch of input.trackedBranches) {
		const normalizedTrackedBranch = trackedBranch.trim();
		if (!normalizedTrackedBranch) {
			continue;
		}

		addNode(normalizedTrackedBranch, 'tracked', normalizedTrackedBranch === input.currentBranch.trim());
		if (normalizedPromptBranch && normalizedPromptBranch !== normalizedTrackedBranch) {
			edges.set(
				`${normalizedPromptBranch}->${normalizedTrackedBranch}:prompt-base`,
				{
					from: normalizedPromptBranch,
					to: normalizedTrackedBranch,
					kind: 'prompt-base',
					label: 'base',
				},
			);
		}
		if (!normalizedPromptBranch) {
			continue;
		}
		edges.set(
			`${normalizedTrackedBranch}->${normalizedPromptBranch}:tracked`,
			{
				from: normalizedTrackedBranch,
				to: normalizedPromptBranch,
				kind: 'tracked',
				label: 'tracked',
			},
		);
	}

	const normalizedCurrentBranch = input.currentBranch.trim();
	const normalizedCurrentUpstream = (input.currentUpstream || '').trim();
	if (normalizedCurrentBranch && normalizedCurrentUpstream) {
		addNode(normalizedCurrentBranch, 'current', true);
		addNode(normalizedCurrentUpstream, 'remote');
		edges.set(
			`${normalizedCurrentBranch}->${normalizedCurrentUpstream}:current-upstream`,
			{
				from: normalizedCurrentBranch,
				to: normalizedCurrentUpstream,
				kind: 'current-upstream',
				label: 'upstream',
			},
		);
	}

	return {
		nodes: [...nodes.values()],
		edges: [...edges.values()],
	};
}