export type CodeMapInstructionKind = 'base' | 'delta';

export type CodeMapBranchRole = 'tracked' | 'resolved-base' | 'current';

export type CodeMapJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export type CodeMapUpdateTrigger =
	| 'startup'
	| 'start-chat'
	| 'manual'
	| 'post-commit'
	| 'post-merge'
	| 'post-checkout'
	| 'workspace-open';

export type CodeMapUpdatePriority = 'low' | 'normal' | 'high';

export type CodeMapBlockDescriptionMode = 'short' | 'medium' | 'long';

export type CodeMapRuntimePhase =
	| 'queued'
	| 'collecting-files'
	| 'describing-areas'
	| 'describing-files'
	| 'collecting-history'
	| 'assembling-instruction'
	| 'persisting-instruction'
	| 'cooldown'
	| 'completed'
	| 'failed';

export interface CodeMapSettings {
	enabled: boolean;
	trackedBranches: string[];
	autoUpdate: boolean;
	notificationsEnabled: boolean;
	aiModel: string;
	instructionMaxChars: number;
	blockDescriptionMode: CodeMapBlockDescriptionMode;
	blockMaxChars: number;
	batchContextMaxChars: number;
	areaBatchMaxItems: number;
	symbolBatchMaxItems: number;
	symbolBatchMaxFiles: number;
	updatePriority: CodeMapUpdatePriority;
	aiDelayMs: number;
	startupDelayMs: number;
	maxVersionsPerInstruction: number;
}

export interface CodeMapBranchResolution {
	repository: string;
	projectPath: string;
	currentBranch: string;
	resolvedBranchName: string;
	baseBranchName: string;
	branchRole: CodeMapBranchRole;
	isTrackedBranch: boolean;
	hasUncommittedChanges: boolean;
	resolvedHeadSha: string;
	currentHeadSha: string;
	resolvedTreeSha?: string;
	currentTreeSha?: string;
}

export interface CodeMapInstructionRecord {
	repository: string;
	branchName: string;
	resolvedBranchName: string;
	baseBranchName: string;
	branchRole: CodeMapBranchRole;
	instructionKind: CodeMapInstructionKind;
	locale: string;
	aiModel: string;
	content: string;
	contentHash: string;
	generatedAt: string;
	sourceCommitSha: string;
	fileCount: number;
	metadata?: Record<string, unknown>;
}

export interface StoredCodeMapInstruction extends Omit<CodeMapInstructionRecord, 'content' | 'metadata'> {
	id: number;
	uncompressedSize: number;
	compressedSize: number;
	content: string;
	metadata: Record<string, unknown>;
	updatedAt: string;
	versionCount: number;
}

export interface CodeMapJobRecord {
	id?: number;
	repository: string;
	branchName: string;
	resolvedBranchName: string;
	instructionKind: CodeMapInstructionKind;
	triggerType: CodeMapUpdateTrigger;
	priority: CodeMapUpdatePriority;
	status: CodeMapJobStatus;
	requestedAt: string;
	startedAt?: string;
	finishedAt?: string;
	errorText?: string;
	payload?: Record<string, unknown>;
}

export interface CodeMapMaterializationTarget {
	resolution: CodeMapBranchResolution;
	baseInstruction: StoredCodeMapInstruction | null;
	currentInstruction: StoredCodeMapInstruction | null;
	uncommittedSummary?: string;
	queuedBaseRefresh: boolean;
	queuedCurrentRefresh: boolean;
}

export interface CodeMapInstructionListItem {
	id: number;
	repository: string;
	branchName: string;
	resolvedBranchName: string;
	baseBranchName: string;
	branchRole: CodeMapBranchRole;
	instructionKind: CodeMapInstructionKind;
	locale: string;
	generatedAt: string;
	updatedAt: string;
	fileCount: number;
	sourceCommitSha: string;
	versionCount: number;
	isObsolete?: boolean;
}

export interface CodeMapFileGroupStat {
	group: string;
	count: number;
}

export interface CodeMapInstructionVersion {
	id: number;
	instructionId: number;
	contentHash: string;
	generatedAt: string;
	metadata: Record<string, unknown>;
}

export interface CodeMapJobSummary {
	id: number;
	repository: string;
	branchName: string;
	resolvedBranchName: string;
	instructionKind: CodeMapInstructionKind;
	triggerType: CodeMapUpdateTrigger;
	priority: CodeMapUpdatePriority;
	status: CodeMapJobStatus;
	requestedAt: string;
	startedAt?: string;
	finishedAt?: string;
	errorText?: string;
	payload: Record<string, unknown>;
	totalDurationMs?: number;
	generationDurationMs?: number;
	peakHeapUsedBytes?: number;
	instructionChars?: number;
	fileCount?: number;
	fileGroups?: CodeMapFileGroupStat[];
}

export interface CodeMapRuntimeTask {
	jobId: number;
	repository: string;
	branchName: string;
	instructionKind: CodeMapInstructionKind;
	aiModel?: string;
	trigger: CodeMapUpdateTrigger;
	priority: CodeMapUpdatePriority;
	status: 'queued' | 'running';
	phase: CodeMapRuntimePhase;
	requestedAt: string;
	startedAt?: string;
	updatedAt?: string;
	detail?: string;
	progressCurrent?: number;
	progressTotal?: number;
}

export interface CodeMapRuntimeEvent {
	id: string;
	at: string;
	level: 'info' | 'success' | 'error';
	message: string;
	jobId?: number;
	repository?: string;
	branchName?: string;
	phase?: CodeMapRuntimePhase;
}

export interface CodeMapRuntimeCycle {
	queuedTotal: number;
	startedTotal: number;
	completedTotal: number;
	failedTotal: number;
	startedAt?: string;
	updatedAt?: string;
}

export interface CodeMapRuntimeState {
	pendingCount: number;
	queuedCount: number;
	runningCount: number;
	isProcessing: boolean;
	lastActivityAt?: string;
	currentTask?: CodeMapRuntimeTask;
	queuedTasks: CodeMapRuntimeTask[];
	recentEvents: CodeMapRuntimeEvent[];
	cycle: CodeMapRuntimeCycle;
}

export interface CodeMapTriggerStatistics {
	trigger: CodeMapUpdateTrigger;
	total: number;
	completed: number;
	failed: number;
	avgDurationMs: number;
	avgGenerationDurationMs: number;
}

export interface CodeMapRepositoryStatistics {
	repository: string;
	total: number;
	completed: number;
	failed: number;
	avgDurationMs: number;
}

export interface CodeMapActivity {
	statistics: CodeMapStatistics;
	runtime: CodeMapRuntimeState;
	recentJobs: CodeMapJobSummary[];
}

export interface CodeMapInstructionDetail {
	instruction: StoredCodeMapInstruction;
	versions: CodeMapInstructionVersion[];
	recentJobs: CodeMapJobSummary[];
}

export interface CodeMapStatistics {
	totalInstructions: number;
	totalVersions: number;
	totalJobs: number;
	queuedJobs: number;
	runningJobs: number;
	completedJobs: number;
	failedJobs: number;
	dbSizeBytes: number;
	repositories: string[];
	branches: string[];
	latestUpdatedAt?: string;
	avgDurationMs: number;
	avgGenerationDurationMs: number;
	maxDurationMs: number;
	peakHeapUsedBytes: number;
	aiModels: Array<{ model: string; count: number }>;
	triggerStats: CodeMapTriggerStatistics[];
	repositoryStats: CodeMapRepositoryStatistics[];
}
