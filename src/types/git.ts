export type GitOverlayChangeGroup = 'merge' | 'staged' | 'working-tree' | 'untracked';

export type GitOverlayBranchKind = 'tracked' | 'prompt' | 'current' | 'local' | 'cleanup' | 'remote';

export interface GitOverlayCommit {
	sha: string;
	shortSha: string;
	subject: string;
	author: string;
	committedAt: string;
	refNames: string[];
}

export interface GitOverlayChangeFile {
	project: string;
	path: string;
	previousPath?: string;
	status: string;
	group: GitOverlayChangeGroup;
	conflicted: boolean;
	staged: boolean;
}

export interface GitOverlayBranchInfo {
	name: string;
	current: boolean;
	exists: boolean;
	kind: GitOverlayBranchKind;
	upstream: string;
	ahead: number;
	behind: number;
	lastCommit: GitOverlayCommit | null;
	canSwitch: boolean;
	canDelete: boolean;
	stale: boolean;
}

export interface GitOverlayGraphNode {
	id: string;
	label: string;
	kind: GitOverlayBranchKind;
	current: boolean;
}

export interface GitOverlayGraphEdge {
	from: string;
	to: string;
	kind: 'tracked' | 'prompt-base' | 'current-upstream';
	label: string;
}

export interface GitOverlayFileHistoryEntry {
	sha: string;
	shortSha: string;
	subject: string;
	author: string;
	committedAt: string;
	status: string;
}

export interface GitOverlayProjectSnapshot {
	project: string;
	repositoryPath: string;
	available: boolean;
	error: string;
	currentBranch: string;
	promptBranch: string;
	dirty: boolean;
	hasConflicts: boolean;
	upstream: string;
	ahead: number;
	behind: number;
	lastCommit: GitOverlayCommit | null;
	branches: GitOverlayBranchInfo[];
	cleanupBranches: GitOverlayBranchInfo[];
	changeGroups: {
		merge: GitOverlayChangeFile[];
		staged: GitOverlayChangeFile[];
		workingTree: GitOverlayChangeFile[];
		untracked: GitOverlayChangeFile[];
	};
	recentCommits: GitOverlayCommit[];
	staleLocalBranches: string[];
	graph: {
		nodes: GitOverlayGraphNode[];
		edges: GitOverlayGraphEdge[];
	};
}

export interface GitOverlaySnapshot {
	generatedAt: string;
	promptBranch: string;
	trackedBranches: string[];
	projects: GitOverlayProjectSnapshot[];
}

export interface GitOverlayProjectCommitMessage {
	project: string;
	message: string;
}

export interface GitOverlayFileHistoryPayload {
	project: string;
	filePath: string;
	entries: GitOverlayFileHistoryEntry[];
}