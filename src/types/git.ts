export type GitOverlayChangeGroup = 'merge' | 'staged' | 'working-tree' | 'untracked';

export type GitOverlayBranchKind = 'tracked' | 'prompt' | 'current' | 'local' | 'cleanup' | 'remote';

export type GitOverlayReviewProvider = 'github' | 'gitlab' | 'unknown';

export type GitOverlayReviewRequestState = 'open' | 'closed' | 'accepted';

export type GitOverlayReviewSetupAction = 'install-and-auth' | 'auth';

export type GitOverlayReviewUnsupportedReason = 'missing-remote' | 'unrecognized-remote' | 'unsupported-provider';

export type GitOverlayActionKind = 'push' | 'review-request' | 'merge';

export type GitOverlayActionScope = 'single' | 'all';

export interface GitOverlayReviewComment {
	id: string;
	author: string;
	body: string;
	createdAt: string;
	system: boolean;
}

export interface GitOverlayReviewRemote {
	provider: GitOverlayReviewProvider;
	host: string;
	remoteName: string;
	remoteUrl: string;
	repositoryPath: string;
	owner: string;
	name: string;
	supported: boolean;
	cliCommand: 'gh' | 'glab' | '';
	cliAvailable: boolean;
	actionLabel: string;
}

export interface GitOverlayReviewRequest {
	id: string;
	number: string;
	title: string;
	url: string;
	state: GitOverlayReviewRequestState;
	sourceBranch: string;
	targetBranch: string;
	isDraft: boolean;
	comments: GitOverlayReviewComment[];
}

export interface GitOverlayReviewState {
	remote: GitOverlayReviewRemote | null;
	request: GitOverlayReviewRequest | null;
	error: string;
	setupAction: GitOverlayReviewSetupAction | null;
	titlePrefix?: string;
	unsupportedReason?: GitOverlayReviewUnsupportedReason | null;
}

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
	fileSizeBytes: number;
	additions: number | null;
	deletions: number | null;
	isBinary: boolean;
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
	commitError?: string;
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
	changeDetailsHydrated?: boolean;
	branchDetailsHydrated?: boolean;
	reviewHydrated?: boolean;
	review: GitOverlayReviewState;
	recentCommits: GitOverlayCommit[];
	staleLocalBranches: string[];
	graph: {
		nodes: GitOverlayGraphNode[];
		edges: GitOverlayGraphEdge[];
	};
}

export interface GitOverlaySnapshot {
	generatedAt: string;
	detailLevel?: 'full' | 'summary';
	promptBranch: string;
	trackedBranches: string[];
	projects: GitOverlayProjectSnapshot[];
	otherProjects?: GitOverlayProjectSnapshot[];
}

export interface GitOverlayProjectCommitMessage {
	project: string;
	message: string;
}

export interface GitOverlayProjectReviewRequestInput {
	project: string;
	targetBranch: string;
	title: string;
	draft?: boolean;
	removeSourceBranch?: boolean;
}

export interface GitOverlayReviewCliSetupRequest {
	project: string;
	cliCommand: 'gh' | 'glab';
	host: string;
	action: GitOverlayReviewSetupAction;
}

export interface GitOverlayFileHistoryPayload {
	project: string;
	filePath: string;
	entries: GitOverlayFileHistoryEntry[];
}