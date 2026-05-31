/** Supported Docker container lifecycle states displayed by the dashboard widget. */
export type DockerContainerLifecycleStatus =
	| 'running'
	| 'stopped'
	| 'paused'
	| 'restarting'
	| 'starting'
	| 'error'
	| 'unknown';

/** Dashboard color categories derived from Docker state and health metadata. */
export type DockerContainerStatusTone = 'ok' | 'neutral' | 'warning' | 'error' | 'progress';

/** Container action commands exposed by the prompt dashboard. */
export type DockerContainerActionKind = 'start' | 'restart' | 'stop' | 'remove';

/** Workspace-level Docker commands launched from the dashboard summary tiles. */
export type DockerWorkspaceActionKind = 'startPrevious' | 'restartAll' | 'stopAll';

/** Compose project orchestration commands launched from the Docker widget. */
export type DockerComposeProjectActionKind = 'up' | 'down' | 'restart';

/** Last failed hidden compose command shown inline in the Docker tree. */
export interface DockerComposeActionError {
	projectPath: string;
	composeFilePath: string;
	action: DockerComposeProjectActionKind;
	message: string;
	createdAt: string;
}

/** User-selectable visual modes for the Docker containers widget. */
export type DockerContainersViewMode = 'tree' | 'cards' | 'table' | 'list';

/** User-selectable lifecycle filter for the Docker containers widget. */
export type DockerContainersStatusFilter = 'all' | 'running' | 'stopped';

/** Normalized Docker daemon connection metadata used for diagnostics. */
export interface DockerDaemonInfo {
	platform: NodeJS.Platform;
	apiVersion: string;
	serverVersion: string;
	endpoint: string;
	osType?: string;
	architecture?: string;
}

/** One compose file discovered inside a workspace project. */
export interface DockerComposeFileReference {
	project: string;
	projectPath: string;
	filePath: string;
	relativePath: string;
}

/** A published or exposed container port normalized for compact rendering. */
export interface DockerContainerPortMapping {
	ip?: string;
	privatePort: number;
	publicPort?: number;
	type: string;
	label: string;
}

/** A Docker mount normalized for the details disclosure. */
export interface DockerContainerMountSummary {
	type: string;
	source: string;
	destination: string;
	mode?: string;
	name?: string;
	readWrite?: boolean;
}

/** A compact resource sample calculated from Docker stats output. */
export interface DockerContainerResourceStats {
	readAt: string;
	cpuPercent: number;
	memoryUsageBytes: number;
	memoryLimitBytes: number;
	memoryPercent: number;
	networkRxBytes: number;
	networkTxBytes: number;
	networkRxRateBytesPerSecond: number;
	networkTxRateBytesPerSecond: number;
}

/** Small historical resource sample used by the lightweight widget chart. */
export interface DockerContainerResourceSample {
	readAt: string;
	cpuPercent: number;
	memoryPercent: number;
	memoryUsageBytes: number;
	networkRxRateBytesPerSecond: number;
	networkTxRateBytesPerSecond: number;
}

/** One Docker container row/card shown in the dashboard widget. */
export interface DockerContainerSummary {
	id: string;
	shortId: string;
	name: string;
	project: string;
	service: string;
	image: string;
	imageId: string;
	command: string;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	uptimeMs: number;
	status: DockerContainerLifecycleStatus;
	statusTone: DockerContainerStatusTone;
	statusText: string;
	health?: string;
	composeWorkingDir: string;
	composeFilePaths: string[];
	ports: DockerContainerPortMapping[];
	mounts: DockerContainerMountSummary[];
	labels: Record<string, string>;
	stats?: DockerContainerResourceStats;
	samples: DockerContainerResourceSample[];
	error?: string;
}

/** Containers that belong to one discovered Docker Compose file. */
export interface DockerComposeFileContainerGroup {
	composeFile: DockerComposeFileReference;
	containers: DockerContainerSummary[];
	serviceNames?: string[];
	status?: DockerContainerLifecycleStatus;
	statusTone?: DockerContainerStatusTone;
	statusText?: string;
	runningCount: number;
	stoppedCount: number;
	warningCount: number;
	errorCount: number;
}

/** Containers grouped under one workspace project root. */
export interface DockerContainerProjectGroup {
	project: string;
	projectPath: string;
	composeFiles: DockerComposeFileReference[];
	composeFileGroups: DockerComposeFileContainerGroup[];
	containers: DockerContainerSummary[];
	runningCount: number;
	stoppedCount: number;
	warningCount: number;
	errorCount: number;
}

/** Persistable view state for the Docker dashboard widget. */
export interface DockerContainersWidgetState {
	viewMode: DockerContainersViewMode;
	statusFilter: DockerContainersStatusFilter;
	search: string;
	sortBy: 'name' | 'status' | 'uptime' | 'cpu' | 'memory';
	sortDirection: 'asc' | 'desc';
}

/** Complete Docker widget payload posted from the extension host to the webview. */
export interface DockerContainersData {
	enabled: boolean;
	available: boolean;
	generatedAt: string;
	defaultViewMode: DockerContainersViewMode;
	composeFilePatterns: string[];
	daemon?: DockerDaemonInfo;
	projects: DockerContainerProjectGroup[];
	totalContainers: number;
	runningContainers: number;
	stoppedContainers: number;
	warningContainers: number;
	errorContainers: number;
	restorableContainersCount?: number;
	error?: string;
	composeActionError?: DockerComposeActionError;
}