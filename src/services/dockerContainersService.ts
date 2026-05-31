import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import type {
	DockerComposeActionError,
	DockerComposeFileContainerGroup,
	DockerComposeFileReference,
	DockerComposeProjectActionKind,
	DockerContainerActionKind,
	DockerContainerLifecycleStatus,
	DockerContainerMountSummary,
	DockerContainerPortMapping,
	DockerContainerProjectGroup,
	DockerContainerResourceSample,
	DockerContainerResourceStats,
	DockerContainersData,
	DockerContainersViewMode,
	DockerContainerStatusTone,
	DockerContainerSummary,
} from '../types/docker.js';
import {
	DockerEngineApiClient,
	DockerEngineApiError,
	type DockerEngineContainerInspect,
	type DockerEngineContainerListItem,
	type DockerEngineContainerMount,
	type DockerEngineContainerPort,
	type DockerEngineContainerStats,
	type DockerEngineEventSubscription,
} from './dockerEngineApiClient.js';
import { DEFAULT_DOCKER_COMPOSE_FILE_PATTERNS, DockerComposeDiscoveryService } from './dockerComposeDiscoveryService.js';

const execFileAsync = promisify(execFile);

interface DockerContainersCacheEntry {
	updatedAtMs: number;
	composeFingerprint: string;
	data: DockerContainersData;
	source: 'live' | 'persistent' | 'error';
}

interface DockerContainersPersistentCacheEntry {
	version: 1;
	composeFingerprint: string;
	savedAt: string;
	data: DockerContainersData;
}

export type DockerContainersChangeReason = 'compose' | 'container' | 'snapshot';
export type DockerContainersRefreshMode = 'full' | 'stats';

interface DockerContainerStatsCacheEntry {
	updatedAtMs: number;
	stats: DockerContainerResourceStats;
}

interface DockerContainerNetworkTotals {
	readAtMs: number;
	rxBytes: number;
	txBytes: number;
}

interface DockerContainerComposeMatch {
	composeFiles: DockerComposeFileReference[];
	labels: Record<string, string>;
	composeWorkingDir: string;
	composeFilePaths: string[];
}

type DockerComposeServiceNamesByFile = Map<string, string[]>;

const DOCKER_COMPOSE_WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';
const DOCKER_COMPOSE_CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files';
const DOCKER_COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const DOCKER_COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const DOCKER_CONTAINER_SAMPLE_WINDOW_MS = 5 * 60 * 1000;
const DOCKER_CONTAINER_DETAILS_CONCURRENCY = 8;
const DOCKER_CONFIG_MIN_MS = 250;
const DOCKER_PERSISTENT_CACHE_VERSION = 1;
const DOCKER_PERSISTENT_CACHE_FILE = 'docker-containers-cache.json';
const DOCKER_ACTION_SETTLE_TIMEOUT_MS = 20000;
const DOCKER_ACTION_SETTLE_POLL_MS = 700;

/** Aggregates local Docker Engine data into the prompt dashboard payload. */
export class DockerContainersService implements vscode.Disposable {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<DockerContainersChangeReason>();
	private readonly discoveryListener: vscode.Disposable;
	private cache: DockerContainersCacheEntry | null = null;
	private eventSubscription: DockerEngineEventSubscription | null = null;
	private eventStreamStarted = false;
	private readonly statsCache = new Map<string, DockerContainerStatsCacheEntry>();
	private readonly networkTotalsByContainer = new Map<string, DockerContainerNetworkTotals>();
	private readonly samplesByContainer = new Map<string, DockerContainerResourceSample[]>();
	private persistentCacheLoaded = false;
	private persistentCache: DockerContainersPersistentCacheEntry | null = null;
	private composeActionError: DockerComposeActionError | null = null;
	private backgroundRefreshFingerprint = '';
	private backgroundRefreshPromise: Promise<void> | null = null;

	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(
		private readonly apiClient: DockerEngineApiClient = new DockerEngineApiClient(),
		private readonly composeDiscoveryService: DockerComposeDiscoveryService = new DockerComposeDiscoveryService(),
	) {
		this.discoveryListener = this.composeDiscoveryService.onDidChange(() => this.invalidate(true, 'compose'));
	}

	/** Returns a startup snapshot only when current compose files still match the persisted fingerprint. */
	getBootstrapDockerContainersData(): DockerContainersData | null {
		if (!this.isEnabled()) {
			return this.createEmptyData({ enabled: false, available: false });
		}
		if (this.cache) {
			return this.decorateData(this.cache.data);
		}
		const persistentCache = this.getPersistentCacheSync();
		if (!persistentCache) {
			return null;
		}
		try {
			const composeFiles = this.composeDiscoveryService.getComposeFilesSync();
			const composeFingerprint = buildComposeFilesFingerprintSync(composeFiles);
			if (composeFingerprint !== persistentCache.composeFingerprint) {
				return null;
			}
			this.cache = {
				updatedAtMs: Date.now(),
				composeFingerprint,
				data: persistentCache.data,
				source: 'persistent',
			};
			return this.decorateData(persistentCache.data);
		} catch {
			return null;
		}
	}

	/** Builds the current Docker widget payload from cache or Docker Engine. */
	async getDockerContainersData(force = false, refreshMode: DockerContainersRefreshMode = 'full'): Promise<DockerContainersData> {
		const enabled = this.isEnabled();
		if (!enabled) {
			return this.createEmptyData({ enabled: false, available: false });
		}

		try {
			const nowMs = Date.now();
			if (refreshMode === 'stats') {
				return this.getDockerContainersStatsData(nowMs, force);
			}
			if (!force && this.cache?.source === 'persistent') {
				this.ensureEventStream();
				this.refreshLiveDataAfterPersistentCacheSnapshot(this.cache.composeFingerprint);
				return this.decorateData(this.cache.data);
			}

			if (!force && (!this.cache || this.cache.source === 'error')) {
				const persistentCache = await this.getPersistentCache();
				if (persistentCache) {
					this.cache = {
						updatedAtMs: nowMs,
						composeFingerprint: persistentCache.composeFingerprint,
						data: persistentCache.data,
						source: 'persistent',
					};
					this.ensureEventStream();
					this.refreshLiveDataAfterPersistentCacheSnapshot(persistentCache.composeFingerprint);
					return this.decorateData(persistentCache.data);
				}
			}

			const composeFiles = await this.composeDiscoveryService.getComposeFiles(force);
			const composeFingerprint = await buildComposeFilesFingerprint(composeFiles);
			if (!force && this.cache && this.cache.composeFingerprint === composeFingerprint) {
				this.ensureEventStream();
				return this.decorateData(this.cache.data);
			}
			const persistentCache = force ? null : await this.getPersistentCache();
			if (persistentCache?.composeFingerprint === composeFingerprint) {
				this.cache = { updatedAtMs: nowMs, composeFingerprint, data: persistentCache.data, source: 'persistent' };
				this.ensureEventStream();
				this.refreshLiveDataAfterPersistentCache(composeFiles, composeFingerprint);
				return this.decorateData(persistentCache.data);
			}
			const data = await this.loadLiveDockerContainersData(composeFiles, composeFingerprint, nowMs);
			return this.decorateData(data);
		} catch (error) {
			const data = this.createEmptyData({
				enabled: true,
				available: false,
				error: error instanceof Error ? error.message : String(error),
			});
			this.cache = { updatedAtMs: Date.now(), composeFingerprint: '', data, source: 'error' };
			return this.decorateData(data);
		}
	}

	/** Refreshes only runtime stats when a live Docker snapshot already exists. */
	private async getDockerContainersStatsData(nowMs: number, force: boolean): Promise<DockerContainersData> {
		if (!this.cache || this.cache.source === 'error') {
			return this.getDockerContainersData(force, 'full');
		}
		if (this.cache.source !== 'live') {
			return this.getDockerContainersData(true, 'full');
		}

		const data = await this.refreshCachedRunningContainerStatsData(this.cache.data, nowMs);
		this.cache = {
			...this.cache,
			updatedAtMs: nowMs,
			data,
			source: 'live',
		};
		this.ensureEventStream();
		return this.decorateData(data);
	}

	/** Reuses the cached live topology and only refreshes running-container metrics. */
	private async refreshCachedRunningContainerStatsData(
		data: DockerContainersData,
		nowMs: number,
	): Promise<DockerContainersData> {
		const uniqueContainers = getUniqueDockerContainers(data);
		const containersById = new Map<string, DockerContainerSummary>();
		await mapLimited(uniqueContainers, DOCKER_CONTAINER_DETAILS_CONCURRENCY, async (container) => {
			let stats = container.stats;
			let samples = container.samples;
			if (container.status === 'running') {
				try {
					stats = await this.getContainerResourceStats(container.id);
					samples = this.getSamplesForContainer(container.id, stats);
				} catch {
					stats = container.stats;
					samples = container.samples;
				}
			}
			containersById.set(container.id, {
				...container,
				uptimeMs: resolveRuntimeDockerContainerUptimeMs(container, nowMs),
				stats,
				samples,
			});
			return undefined;
		});
		return rebuildDockerContainersDataRuntime(data, containersById, nowMs);
	}

	/** Validates a disk snapshot after it was already returned to the dashboard. */
	private refreshLiveDataAfterPersistentCacheSnapshot(composeFingerprint: string): void {
		if (this.backgroundRefreshPromise && this.backgroundRefreshFingerprint === composeFingerprint) {
			return;
		}

		this.backgroundRefreshFingerprint = composeFingerprint;
		const refreshPromise = (async () => {
			const composeFiles = await this.composeDiscoveryService.getComposeFiles(false);
			const freshFingerprint = await buildComposeFilesFingerprint(composeFiles);
			await this.loadLiveDockerContainersData(composeFiles, freshFingerprint);
			this.onDidChangeEmitter.fire('snapshot');
		})()
			.catch(() => {
				// Keep the persisted snapshot visible when Docker or compose discovery fails.
			})
			.finally(() => {
				if (this.backgroundRefreshPromise === refreshPromise) {
					this.backgroundRefreshPromise = null;
					this.backgroundRefreshFingerprint = '';
				}
			});
		this.backgroundRefreshPromise = refreshPromise;
	}

	/** Refreshes live Docker state after returning a persistent cache snapshot. */
	private refreshLiveDataAfterPersistentCache(
		composeFiles: DockerComposeFileReference[],
		composeFingerprint: string,
	): void {
		if (this.backgroundRefreshPromise && this.backgroundRefreshFingerprint === composeFingerprint) {
			return;
		}

		this.backgroundRefreshFingerprint = composeFingerprint;
		const refreshPromise = this.loadLiveDockerContainersData(composeFiles, composeFingerprint)
			.then(() => this.onDidChangeEmitter.fire('snapshot'))
			.catch(() => {
				// Keep the persisted snapshot visible when Docker is temporarily unavailable.
			})
			.finally(() => {
				if (this.backgroundRefreshPromise === refreshPromise) {
					this.backgroundRefreshPromise = null;
					this.backgroundRefreshFingerprint = '';
				}
			});
		this.backgroundRefreshPromise = refreshPromise;
	}

	/** Reads Docker Engine and compose files to build a fresh live widget payload. */
	private async loadLiveDockerContainersData(
		composeFiles: DockerComposeFileReference[],
		composeFingerprint: string,
		nowMs = Date.now(),
	): Promise<DockerContainersData> {
		const composeIndex = buildComposeFileIndex(composeFiles);
		const serviceNamesByComposeFile = await readComposeServiceNamesByFile(composeFiles);
		let daemon: DockerContainersData['daemon'];
		let containers: DockerEngineContainerListItem[] = [];
		if (composeFiles.length > 0) {
			[daemon, containers] = await Promise.all([this.apiClient.getDaemonInfo(), this.apiClient.listContainers()]);
		}
		const matchedContainers = containers
			.map(container => ({ container, match: matchContainerToComposeFiles(container, composeIndex) }))
			.filter((item): item is { container: DockerEngineContainerListItem; match: DockerContainerComposeMatch } => Boolean(item.match));

		const summaries = await mapLimited(matchedContainers, DOCKER_CONTAINER_DETAILS_CONCURRENCY, async ({ container, match }) => {
			return this.buildContainerSummary(container, match);
		});
		const projects = buildDockerContainerProjectGroups(composeFiles, summaries, serviceNamesByComposeFile);
		const data: DockerContainersData = {
			enabled: true,
			available: true,
			generatedAt: new Date().toISOString(),
			defaultViewMode: this.getDefaultViewMode(),
			composeFilePatterns: this.composeDiscoveryService.getComposeFilePatterns(),
			daemon,
			projects,
			totalContainers: summaries.length,
			runningContainers: summaries.filter(container => container.status === 'running').length,
			stoppedContainers: summaries.filter(container => container.status === 'stopped').length,
			warningContainers: summaries.filter(container => container.statusTone === 'warning').length,
			errorContainers: summaries.filter(container => container.statusTone === 'error').length,
		};
		this.cache = { updatedAtMs: nowMs, composeFingerprint, data, source: 'live' };
		void this.savePersistentCache(composeFingerprint, data);
		this.ensureEventStream();
		return data;
	}

	/** Runs a safe container action after verifying workspace ownership. */
	async runContainerAction(containerId: string, action: DockerContainerActionKind): Promise<void> {
		const container = await this.getWorkspaceContainer(containerId);
		if (!container) {
			throw new Error('Container is not part of this workspace Docker Compose scope.');
		}
		if (action === 'remove' && container.status !== 'stopped') {
			throw new Error('Only stopped containers can be removed from the Docker widget.');
		}
		if (action === 'start' && container.status === 'running') {
			throw new Error('Container is already running.');
		}

		switch (action) {
			case 'start':
				await this.apiClient.startContainer(container.id);
				break;
			case 'restart':
				await this.apiClient.restartContainer(container.id);
				break;
			case 'stop':
				await this.apiClient.stopContainer(container.id);
				break;
			case 'remove':
				await this.apiClient.removeContainer(container.id);
				break;
			default:
				throw new Error(`Unsupported Docker container action: ${action satisfies never}`);
		}
		this.invalidate(false, 'container');
		await this.waitForContainerActionResult(container.id, action);
		this.onDidChangeEmitter.fire('container');
	}

	/** Reads recent logs for one workspace-owned container. */
	async getContainerLogs(containerId: string, tail = 500): Promise<{ container: DockerContainerSummary; content: string }> {
		const container = await this.getWorkspaceContainer(containerId);
		if (!container) {
			throw new Error('Container is not part of this workspace Docker Compose scope.');
		}
		const content = await this.apiClient.getContainerLogs(container.id, tail);
		return { container, content };
	}

	/** Resolves one workspace-owned container by full or short ID. */
	async getWorkspaceContainer(containerId: string): Promise<DockerContainerSummary | null> {
		return this.findWorkspaceContainer(containerId);
	}

	/** Resolves one workspace-owned compose file target by project and file path. */
	async getWorkspaceComposeFile(projectPath: string, composeFilePath: string): Promise<{ project: DockerContainerProjectGroup; composeFile: DockerComposeFileReference } | null> {
		return this.findWorkspaceComposeFile(projectPath, composeFilePath);
	}

	/** Builds the command used for an interactive VS Code terminal. */
	buildContainerTerminalCommand(containerId: string): string {
		const configuredShell = vscode.workspace
			.getConfiguration('promptManager')
			.get<string>('docker.terminalShell', '')
			.trim();
		const shellCommand = configuredShell || "sh -lc 'if command -v bash >/dev/null; then exec bash; elif command -v ash >/dev/null; then exec ash; else exec sh; fi'";
		return `docker exec -it ${shellQuote(containerId)} ${shellCommand}`;
	}

	/** Builds the command used for streaming one container log tail in a VS Code terminal. */
	buildContainerLogsTerminalCommand(containerId: string, tail = 500): string {
		const normalizedTail = Math.max(10, Math.round(tail));
		return `docker logs -f --tail ${normalizedTail} ${shellQuote(containerId)}`;
	}

	/** Builds a one-file compose orchestration command with Docker Compose v2 or v1. */
	buildComposeFileTerminalCommand(composeFile: DockerComposeFileReference, action: DockerComposeProjectActionKind): string {
		const composeFileArgs = ['-f', composeFile.filePath];
		const actionArgs = action === 'up' ? ['up', '-d'] : [action];
		const args = [...composeFileArgs, ...actionArgs].map(shellQuote).join(' ');
		return `if docker compose version >/dev/null 2>/dev/null; then docker compose ${args}; elif command -v docker-compose >/dev/null 2>/dev/null; then docker-compose ${args}; else echo 'Docker Compose CLI is not available.'; fi`;
	}

	/** Runs one compose command hidden from the UI and returns combined process output. */
	async runComposeFileAction(
		project: DockerContainerProjectGroup,
		composeFile: DockerComposeFileReference,
		action: DockerComposeProjectActionKind,
	): Promise<string> {
		this.clearComposeActionError();
		const cwd = this.resolveComposeFileCwd(project, composeFile);
		const command = await resolveDockerComposeCommand(cwd);
		const actionArgs = action === 'up' ? ['up', '-d'] : [action];
		const args = command.kind === 'docker'
			? ['compose', '-f', composeFile.filePath, ...actionArgs]
			: ['-f', composeFile.filePath, ...actionArgs];
		try {
			const { stdout, stderr } = await execFileAsync(command.command, args, {
				cwd,
				maxBuffer: 2 * 1024 * 1024,
			});
			this.invalidate(false, 'compose');
			await this.waitForComposeFileActionResult(project.projectPath || composeFile.projectPath, composeFile.filePath, action);
			this.onDidChangeEmitter.fire('compose');
			this.clearComposeActionError();
			return [stdout, stderr].filter(Boolean).join('\n').trim();
		} catch (error) {
			throw new Error(formatDockerComposeExecutionError(error));
		}
	}

	/** Stores the last compose action failure so the dashboard can show it inline. */
	setComposeActionError(error: Omit<DockerComposeActionError, 'createdAt'>): void {
		this.composeActionError = {
			...error,
			createdAt: new Date().toISOString(),
		};
	}

	/** Clears any previously shown compose action failure. */
	clearComposeActionError(): void {
		this.composeActionError = null;
	}

	/** Resolves the terminal cwd for a compose file command. */
	resolveComposeFileCwd(project: DockerContainerProjectGroup, composeFile: DockerComposeFileReference): string | undefined {
		return project.projectPath || composeFile.projectPath || path.dirname(composeFile.filePath);
	}

	/** Returns whether destructive remove actions should ask the user first. */
	shouldConfirmRemove(): boolean {
		return vscode.workspace
			.getConfiguration('promptManager')
			.get<boolean>('docker.confirmRemove', true);
	}

	/** Clears cached payloads and optionally notifies listeners. */
	invalidate(notify = false, reason: DockerContainersChangeReason = 'container'): void {
		this.cache = null;
		if (notify) {
			this.onDidChangeEmitter.fire(reason);
		}
	}

	/** Waits until Docker reports the requested container state change or the polling budget expires. */
	private async waitForContainerActionResult(containerId: string, action: DockerContainerActionKind): Promise<void> {
		const deadlineMs = Date.now() + DOCKER_ACTION_SETTLE_TIMEOUT_MS;
		while (Date.now() < deadlineMs) {
			try {
				const status = await this.readObservedContainerStatus(containerId);
				if (isDockerContainerActionSettled(action, status)) {
					return;
				}
			} catch {
				return;
			}
			await delay(DOCKER_ACTION_SETTLE_POLL_MS);
		}
	}

	/** Waits until one compose file settles into its post-action lifecycle state. */
	private async waitForComposeFileActionResult(
		projectPath: string,
		composeFilePath: string,
		action: DockerComposeProjectActionKind,
	): Promise<void> {
		const normalizedProjectPath = normalizeFsPath(projectPath || path.dirname(composeFilePath));
		const normalizedComposePath = normalizeFsPath(composeFilePath);
		const deadlineMs = Date.now() + DOCKER_ACTION_SETTLE_TIMEOUT_MS;
		while (Date.now() < deadlineMs) {
			try {
				const data = await this.getDockerContainersData(true, 'full');
				const target = findComposeFileTarget(data, normalizedProjectPath, normalizedComposePath);
				const group = target?.project.composeFileGroups.find(item => normalizeFsPath(item.composeFile.filePath) === normalizedComposePath);
				if (isDockerComposeActionSettled(action, group)) {
					return;
				}
			} catch {
				return;
			}
			await delay(DOCKER_ACTION_SETTLE_POLL_MS);
		}
	}

	/** Reads the latest lifecycle status for one container directly from Docker inspect. */
	private async readObservedContainerStatus(containerId: string): Promise<DockerContainerLifecycleStatus | null> {
		try {
			const inspect = await this.apiClient.inspectContainer(containerId);
			return resolveContainerLifecycleStatus({ Id: inspect.Id, State: inspect.State?.Status } as DockerEngineContainerListItem, inspect);
		} catch (error) {
			if (error instanceof DockerEngineApiError && error.statusCode === 404) {
				return null;
			}
			throw error;
		}
	}

	/** Releases watchers, streams and event emitters. */
	dispose(): void {
		this.discoveryListener.dispose();
		this.eventSubscription?.dispose();
		this.composeDiscoveryService.dispose();
		this.onDidChangeEmitter.dispose();
	}

	/** Reads the last workspace Docker snapshot from disk once per extension session. */
	private async getPersistentCache(): Promise<DockerContainersPersistentCacheEntry | null> {
		if (this.persistentCacheLoaded) {
			return this.persistentCache;
		}
		this.persistentCacheLoaded = true;
		const cachePath = this.resolvePersistentCachePath();
		if (!cachePath) {
			return null;
		}
		try {
			const parsed = JSON.parse(await readFile(cachePath, 'utf8')) as Partial<DockerContainersPersistentCacheEntry>;
			if (parsed.version !== DOCKER_PERSISTENT_CACHE_VERSION || typeof parsed.composeFingerprint !== 'string' || !parsed.data) {
				return null;
			}
			this.persistentCache = parsed as DockerContainersPersistentCacheEntry;
			return this.persistentCache;
		} catch {
			return null;
		}
	}

	/** Reads the last workspace Docker snapshot synchronously for prompt-open bootstrap. */
	private getPersistentCacheSync(): DockerContainersPersistentCacheEntry | null {
		if (this.persistentCacheLoaded) {
			return this.persistentCache;
		}
		this.persistentCacheLoaded = true;
		const cachePath = this.resolvePersistentCachePath();
		if (!cachePath) {
			return null;
		}
		try {
			const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<DockerContainersPersistentCacheEntry>;
			if (parsed.version !== DOCKER_PERSISTENT_CACHE_VERSION || typeof parsed.composeFingerprint !== 'string' || !parsed.data) {
				return null;
			}
			this.persistentCache = parsed as DockerContainersPersistentCacheEntry;
			return this.persistentCache;
		} catch {
			return null;
		}
	}

	/** Saves the last successful Docker widget payload for fast startup reuse. */
	private async savePersistentCache(composeFingerprint: string, data: DockerContainersData): Promise<void> {
		const cachePath = this.resolvePersistentCachePath();
		if (!cachePath) {
			return;
		}
		const entry: DockerContainersPersistentCacheEntry = {
			version: DOCKER_PERSISTENT_CACHE_VERSION,
			composeFingerprint,
			savedAt: new Date().toISOString(),
			data,
		};
		this.persistentCache = entry;
		this.persistentCacheLoaded = true;
		try {
			await mkdir(path.dirname(cachePath), { recursive: true });
			await writeFile(cachePath, JSON.stringify(entry), 'utf8');
		} catch {
			// Ignore filesystem cache errors; live Docker data remains available.
		}
	}

	/** Resolves the workspace-scoped Docker cache file location. */
	private resolvePersistentCachePath(): string | null {
		const folder = vscode.workspace.workspaceFolders?.[0];
		return folder ? path.join(folder.uri.fsPath, '.vscode', 'prompt-manager', DOCKER_PERSISTENT_CACHE_FILE) : null;
	}

	/** Builds one normalized dashboard row by combining list, inspect and stats output. */
	private async buildContainerSummary(
		container: DockerEngineContainerListItem,
		match: DockerContainerComposeMatch,
	): Promise<DockerContainerSummary> {
		const listStatus = resolveContainerLifecycleStatus(container);
		const inspectTask = this.apiClient.inspectContainer(container.Id)
			.then(inspect => ({ inspect, error: '' }))
			.catch(cause => ({ inspect: null, error: cause instanceof Error ? cause.message : String(cause) }));
		const statsTask = listStatus === 'running'
			? this.getContainerResourceStats(container.Id)
				.then(stats => ({ stats, error: '' }))
				.catch(cause => ({ stats: undefined, error: cause instanceof Error ? cause.message : String(cause) }))
			: Promise.resolve({ stats: undefined, error: '' });
		const [inspectResult, statsResult] = await Promise.all([inspectTask, statsTask]);
		const inspect = inspectResult.inspect;
		let stats = statsResult.stats;
		let error = inspectResult.error || statsResult.error;

		const labels = { ...match.labels, ...(inspect?.Config?.Labels || {}) };
		const status = resolveContainerLifecycleStatus(container, inspect || undefined);
		if (status === 'running' && !stats) {
			try {
				stats = await this.getContainerResourceStats(container.Id);
			} catch (cause) {
				error = error || (cause instanceof Error ? cause.message : String(cause));
			}
		}

		const primaryComposeFile = match.composeFiles[0];
		const name = normalizeContainerName(inspect?.Name || container.Names?.[0] || container.Id);
		const service = labels[DOCKER_COMPOSE_SERVICE_LABEL] || name;
		const startedAt = normalizeDockerDate(inspect?.State?.StartedAt);
		const finishedAt = normalizeDockerDate(inspect?.State?.FinishedAt);
		const health = inspect?.State?.Health?.Status;
		const command = resolveContainerCommand(container, inspect || undefined);
		const samples = this.getSamplesForContainer(container.Id, stats);
		return {
			id: container.Id,
			shortId: container.Id.slice(0, 12),
			name,
			project: primaryComposeFile?.project || labels[DOCKER_COMPOSE_PROJECT_LABEL] || 'Docker',
			service,
			image: inspect?.Config?.Image || container.Image || '',
			imageId: inspect?.Image || container.ImageID || '',
			command,
			createdAt: normalizeDockerCreatedAt(inspect?.Created || container.Created),
			startedAt,
			finishedAt,
			uptimeMs: status === 'running' && startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0,
			status,
			statusTone: resolveContainerStatusTone(status, health, error),
			statusText: resolveContainerStatusText(container, inspect || undefined, health),
			health,
			composeWorkingDir: match.composeWorkingDir,
			composeFilePaths: match.composeFilePaths,
			ports: normalizeContainerPorts(container.Ports || [], inspect || undefined),
			mounts: normalizeContainerMounts(inspect?.Mounts || container.Mounts || []),
			labels,
			stats,
			samples,
			error: error || undefined,
		};
	}

	/** Calculates one resource sample and keeps enough history for charts. */
	private async getContainerResourceStats(containerId: string): Promise<DockerContainerResourceStats> {
		const nowMs = Date.now();
		const statsIntervalMs = this.getNumberSetting('docker.statsIntervalMs', 1000, 1000, 60000);
		const cached = this.statsCache.get(containerId);
		if (cached && nowMs - cached.updatedAtMs < statsIntervalMs) {
			return cached.stats;
		}

		const rawStats = await this.apiClient.getContainerStats(containerId);
		const stats = this.calculateResourceStats(containerId, rawStats);
		this.statsCache.set(containerId, { updatedAtMs: nowMs, stats });
		return stats;
	}

	/** Converts raw Docker stats into percentages and network rates. */
	private calculateResourceStats(containerId: string, rawStats: DockerEngineContainerStats): DockerContainerResourceStats {
		const readAt = normalizeDockerDate(rawStats.read) || new Date().toISOString();
		const readAtMs = Date.parse(readAt) || Date.now();
		const sampleGapResetThresholdMs = this.getContainerSampleGapResetThresholdMs();
		const cpuPercent = calculateCpuPercent(rawStats);
		const memoryUsageBytes = calculateMemoryUsageBytes(rawStats);
		const memoryLimitBytes = toFiniteNumber(rawStats.memory_stats?.limit);
		const memoryPercent = memoryLimitBytes > 0 ? clampPercent((memoryUsageBytes / memoryLimitBytes) * 100) : 0;
		const networkTotals = calculateNetworkTotals(rawStats);
		const previousNetworkTotals = this.networkTotalsByContainer.get(containerId);
		const hasFreshNetworkBaseline = previousNetworkTotals
			? (readAtMs - previousNetworkTotals.readAtMs) <= sampleGapResetThresholdMs
			: false;
		const elapsedSeconds = previousNetworkTotals && hasFreshNetworkBaseline
			? Math.max(0.001, (readAtMs - previousNetworkTotals.readAtMs) / 1000)
			: 0;
		const networkRxRateBytesPerSecond = previousNetworkTotals && hasFreshNetworkBaseline && elapsedSeconds > 0
			? Math.max(0, (networkTotals.rxBytes - previousNetworkTotals.rxBytes) / elapsedSeconds)
			: 0;
		const networkTxRateBytesPerSecond = previousNetworkTotals && hasFreshNetworkBaseline && elapsedSeconds > 0
			? Math.max(0, (networkTotals.txBytes - previousNetworkTotals.txBytes) / elapsedSeconds)
			: 0;
		this.networkTotalsByContainer.set(containerId, {
			readAtMs,
			rxBytes: networkTotals.rxBytes,
			txBytes: networkTotals.txBytes,
		});

		return {
			readAt,
			cpuPercent,
			memoryUsageBytes,
			memoryLimitBytes,
			memoryPercent,
			networkRxBytes: networkTotals.rxBytes,
			networkTxBytes: networkTotals.txBytes,
			networkRxRateBytesPerSecond,
			networkTxRateBytesPerSecond,
		};
	}

	/** Appends a compact sample and returns a copy of the current sample window. */
	private getSamplesForContainer(containerId: string, stats: DockerContainerResourceStats | undefined): DockerContainerResourceSample[] {
		const samples = this.samplesByContainer.get(containerId) || [];
		if (stats) {
			const readAtMs = Date.parse(stats.readAt) || Date.now();
			const cutoffMs = readAtMs - DOCKER_CONTAINER_SAMPLE_WINDOW_MS;
			const maxSamples = this.getMaxDockerContainerSampleCount();
			const sampleGapResetThresholdMs = this.getContainerSampleGapResetThresholdMs();
			const previousReadAtMs = Date.parse(samples[samples.length - 1]?.readAt || '');
			if (Number.isFinite(previousReadAtMs) && (readAtMs - previousReadAtMs) > sampleGapResetThresholdMs) {
				samples.length = 0;
			}
			samples.push({
				readAt: stats.readAt,
				cpuPercent: stats.cpuPercent,
				memoryPercent: stats.memoryPercent,
				memoryUsageBytes: stats.memoryUsageBytes,
				networkRxRateBytesPerSecond: stats.networkRxRateBytesPerSecond,
				networkTxRateBytesPerSecond: stats.networkTxRateBytesPerSecond,
			});
			while (samples.length > 0) {
				const oldestReadAtMs = Date.parse(samples[0]?.readAt || '');
				if (!Number.isFinite(oldestReadAtMs) || oldestReadAtMs >= cutoffMs) {
					break;
				}
				samples.shift();
			}
			while (samples.length > maxSamples) {
				samples.shift();
			}
			this.samplesByContainer.set(containerId, samples);
		}
		return [...samples];
	}

	/** Keeps the five-minute chart history bounded to the live Docker stats interval. */
	private getMaxDockerContainerSampleCount(): number {
		const statsIntervalMs = this.getNumberSetting('docker.statsIntervalMs', 1000, 1000, 60000);
		return Math.max(2, Math.ceil(DOCKER_CONTAINER_SAMPLE_WINDOW_MS / statsIntervalMs));
	}

	/** Resets chart continuity after long hidden-state pauses so resumed polling starts fresh. */
	private getContainerSampleGapResetThresholdMs(): number {
		const statsIntervalMs = this.getNumberSetting('docker.statsIntervalMs', 1000, 1000, 60000);
		return Math.max(15000, statsIntervalMs * 8);
	}

	/** Finds one dashboard-owned container from cached data or a forced refresh. */
	private async findWorkspaceContainer(containerId: string): Promise<DockerContainerSummary | null> {
		const normalizedId = containerId.trim();
		let data = await this.getDockerContainersData(false);
		let container = findContainerSummary(data, normalizedId);
		if (!container) {
			data = await this.getDockerContainersData(true);
			container = findContainerSummary(data, normalizedId);
		}
		return container;
	}

	/** Finds one dashboard-owned compose file from cached data or a forced refresh. */
	private async findWorkspaceComposeFile(projectPath: string, composeFilePath: string): Promise<{ project: DockerContainerProjectGroup; composeFile: DockerComposeFileReference } | null> {
		const normalizedPath = normalizeFsPath(projectPath);
		const normalizedComposePath = normalizeFsPath(composeFilePath);
		let data = await this.getDockerContainersData(false);
		let target = findComposeFileTarget(data, normalizedPath, normalizedComposePath);
		if (!target) {
			data = await this.getDockerContainersData(true);
			target = findComposeFileTarget(data, normalizedPath, normalizedComposePath);
		}
		return target;
	}

	/** Returns whether the Docker widget is enabled in settings. */
	private isEnabled(): boolean {
		return vscode.workspace
			.getConfiguration('promptManager')
			.get<boolean>('docker.enabled', true);
	}

	/** Resolves the configured default view mode with a stable fallback. */
	private getDefaultViewMode(): DockerContainersViewMode {
		const value = vscode.workspace
			.getConfiguration('promptManager')
			.get<string>('docker.defaultViewMode', 'tree');
		return value === 'cards' || value === 'table' || value === 'list' ? value : 'tree';
	}

	/** Reads bounded numeric Docker settings to keep refresh loops predictable. */
	private getNumberSetting(key: string, fallback: number, min: number, max: number): number {
		const value = vscode.workspace
			.getConfiguration('promptManager')
			.get<number>(key, fallback);
		if (!Number.isFinite(value)) {
			return fallback;
		}
		return Math.max(Math.max(min, DOCKER_CONFIG_MIN_MS), Math.min(max, value));
	}

	/** Creates an empty payload for disabled, unavailable or no-compose states. */
	private createEmptyData(input: { enabled: boolean; available: boolean; error?: string }): DockerContainersData {
		return {
			enabled: input.enabled,
			available: input.available,
			generatedAt: new Date().toISOString(),
			defaultViewMode: this.getDefaultViewMode(),
			composeFilePatterns: this.composeDiscoveryService.getComposeFilePatterns?.() || DEFAULT_DOCKER_COMPOSE_FILE_PATTERNS,
			projects: [],
			totalContainers: 0,
			runningContainers: 0,
			stoppedContainers: 0,
			warningContainers: 0,
			errorContainers: 0,
			error: input.error,
		};
	}

	/** Adds transient UI-only data without writing it into memory or disk caches. */
	private decorateData(data: DockerContainersData): DockerContainersData {
		return this.composeActionError
			? { ...data, composeActionError: this.composeActionError }
			: { ...data, composeActionError: undefined };
	}

	/** Starts one Docker event stream that invalidates the widget on lifecycle changes. */
	private ensureEventStream(): void {
		if (this.eventStreamStarted || this.eventSubscription || !this.isEnabled()) {
			return;
		}

		this.eventStreamStarted = true;
		void this.apiClient.streamContainerEvents((event) => {
			if (event.Type === 'container') {
				this.invalidate(true, 'container');
			}
		}).then((subscription) => {
			this.eventSubscription = subscription;
		}).catch((error) => {
			if (!(error instanceof DockerEngineApiError)) {
				console.warn('[prompt-manager] Docker event stream unavailable:', error);
			}
		});
	}
}

/** Builds a lookup index from normalized compose file paths. */
function buildComposeFileIndex(composeFiles: DockerComposeFileReference[]): Map<string, DockerComposeFileReference> {
	const index = new Map<string, DockerComposeFileReference>();
	for (const composeFile of composeFiles) {
		index.set(normalizeFsPath(composeFile.filePath), composeFile);
	}
	return index;
}

/** Hashes compose file paths and contents to decide whether cached Docker rows can be reused. */
async function buildComposeFilesFingerprint(composeFiles: DockerComposeFileReference[]): Promise<string> {
	const hash = createHash('sha256');
	hash.update(`compose-count:${composeFiles.length}\n`);
	for (const composeFile of [...composeFiles].sort((left, right) => left.filePath.localeCompare(right.filePath, 'ru'))) {
		hash.update(`file:${normalizeFsPath(composeFile.filePath)}\n`);
		try {
			hash.update(await readFile(composeFile.filePath));
		} catch (error) {
			hash.update(`read-error:${error instanceof Error ? error.message : String(error)}\n`);
		}
		hash.update('\n');
	}
	return hash.digest('hex');
}

/** Hashes compose files synchronously so prompt open can validate persisted Docker cache. */
function buildComposeFilesFingerprintSync(composeFiles: DockerComposeFileReference[]): string {
	const hash = createHash('sha256');
	hash.update(`compose-count:${composeFiles.length}\n`);
	for (const composeFile of [...composeFiles].sort((left, right) => left.filePath.localeCompare(right.filePath, 'ru'))) {
		hash.update(`file:${normalizeFsPath(composeFile.filePath)}\n`);
		try {
			hash.update(readFileSync(composeFile.filePath));
		} catch (error) {
			hash.update(`read-error:${error instanceof Error ? error.message : String(error)}\n`);
		}
		hash.update('\n');
	}
	return hash.digest('hex');
}

/** Reads declared Compose service names so removed containers still have visible service rows. */
async function readComposeServiceNamesByFile(composeFiles: DockerComposeFileReference[]): Promise<DockerComposeServiceNamesByFile> {
	const entries = await Promise.all(composeFiles.map(async (composeFile): Promise<[string, string[]]> => {
		try {
			const content = await readFile(composeFile.filePath, 'utf8');
			return [normalizeFsPath(composeFile.filePath), parseComposeServiceNames(content)];
		} catch {
			return [normalizeFsPath(composeFile.filePath), []];
		}
	}));
	return new Map(entries);
}

/** Extracts direct children of the root-level services block from a Compose YAML file. */
function parseComposeServiceNames(content: string): string[] {
	const services = new Set<string>();
	let servicesIndent = -1;
	let serviceIndent = -1;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.replace(/\t/g, '    ');
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		const indent = line.length - line.trimStart().length;
		if (servicesIndent < 0) {
			if (/^services\s*:\s*(?:#.*)?$/.test(trimmed)) {
				servicesIndent = indent;
			}
			continue;
		}
		if (indent <= servicesIndent) {
			break;
		}
		if (serviceIndent < 0) {
			serviceIndent = indent;
		}
		if (indent !== serviceIndent) {
			continue;
		}
		const serviceName = parseComposeServiceName(trimmed);
		if (serviceName && !serviceName.startsWith('x-')) {
			services.add(serviceName);
		}
	}
	return Array.from(services).sort((left, right) => left.localeCompare(right, 'ru'));
}

/** Parses one YAML mapping key used as a Compose service name. */
function parseComposeServiceName(trimmedLine: string): string {
	const quoted = trimmedLine.match(/^['"]([^'"]+)['"]\s*:/);
	if (quoted) {
		return quoted[1].trim();
	}
	const plain = trimmedLine.match(/^([A-Za-z0-9_.-]+)\s*:/);
	return plain ? plain[1].trim() : '';
}

/** Resolves the available Docker Compose command without opening an interactive terminal. */
async function resolveDockerComposeCommand(cwd: string | undefined): Promise<{ kind: 'docker' | 'docker-compose'; command: string }> {
	try {
		await execFileAsync('docker', ['compose', 'version'], { cwd, maxBuffer: 256 * 1024 });
		return { kind: 'docker', command: 'docker' };
	} catch {
		// Fall back to the legacy docker-compose binary below.
	}
	try {
		await execFileAsync('docker-compose', ['--version'], { cwd, maxBuffer: 256 * 1024 });
		return { kind: 'docker-compose', command: 'docker-compose' };
	} catch {
		throw new Error('Docker Compose CLI is not available.');
	}
}

/** Extracts the most useful stdout/stderr text from a failed compose command. */
function formatDockerComposeExecutionError(error: unknown): string {
	const record = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
	const output = [record.stderr, record.stdout]
		.map(value => String(value || '').trim())
		.filter(Boolean)
		.join('\n')
		.trim();
	return output || String(record.message || error || 'Docker Compose command failed.');
}

/** Matches Docker Compose labels to compose files discovered in the current workspace. */
function matchContainerToComposeFiles(
	container: DockerEngineContainerListItem,
	composeIndex: Map<string, DockerComposeFileReference>,
): DockerContainerComposeMatch | null {
	const labels = container.Labels || {};
	const workingDir = labels[DOCKER_COMPOSE_WORKING_DIR_LABEL] || '';
	const composeFilePaths = splitComposeConfigFiles(labels[DOCKER_COMPOSE_CONFIG_FILES_LABEL], workingDir);
	const matchedFiles = composeFilePaths
		.map(filePath => composeIndex.get(normalizeFsPath(filePath)))
		.filter((value): value is DockerComposeFileReference => Boolean(value));
	if (matchedFiles.length === 0) {
		return null;
	}

	return {
		composeFiles: matchedFiles,
		labels,
		composeWorkingDir: workingDir,
		composeFilePaths,
	};
}

/** Splits Docker's comma-separated compose config label and resolves relative paths. */
function splitComposeConfigFiles(value: string | undefined, workingDir: string): string[] {
	return String(value || '')
		.split(',')
		.map(item => item.trim())
		.filter(Boolean)
		.map(filePath => path.isAbsolute(filePath) ? filePath : path.resolve(workingDir || process.cwd(), filePath));
}

/** Groups container rows by workspace project and keeps empty compose projects visible. */
function buildDockerContainerProjectGroups(
	composeFiles: DockerComposeFileReference[],
	containers: DockerContainerSummary[],
	serviceNamesByComposeFile: DockerComposeServiceNamesByFile = new Map(),
): DockerContainerProjectGroup[] {
	const groups = new Map<string, DockerContainerProjectGroup>();
	for (const composeFile of composeFiles) {
		const key = composeFile.projectPath;
		if (!groups.has(key)) {
			groups.set(key, {
				project: composeFile.project,
				projectPath: composeFile.projectPath,
				composeFiles: [],
				composeFileGroups: [],
				containers: [],
				runningCount: 0,
				stoppedCount: 0,
				warningCount: 0,
				errorCount: 0,
			});
		}
		groups.get(key)?.composeFiles.push(composeFile);
	}

	for (const container of containers) {
		const composePath = container.composeFilePaths[0];
		const composeFile = composeFiles.find(item => normalizeFsPath(item.filePath) === normalizeFsPath(composePath));
		const key = composeFile?.projectPath || container.project;
		if (!groups.has(key)) {
			groups.set(key, {
				project: container.project,
				projectPath: composeFile?.projectPath || '',
				composeFiles: composeFile ? [composeFile] : [],
				composeFileGroups: [],
				containers: [],
				runningCount: 0,
				stoppedCount: 0,
				warningCount: 0,
				errorCount: 0,
			});
		}
		groups.get(key)?.containers.push(container);
	}

	for (const group of groups.values()) {
		group.composeFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'ru'));
		group.containers.sort(compareDockerContainers);
		group.composeFileGroups = buildDockerComposeFileContainerGroups(group.composeFiles, group.containers, serviceNamesByComposeFile);
		group.runningCount = group.containers.filter(container => container.status === 'running').length;
		group.stoppedCount = group.containers.filter(container => container.status === 'stopped').length;
		group.warningCount = group.containers.filter(container => container.statusTone === 'warning').length;
		group.errorCount = group.containers.filter(container => container.statusTone === 'error').length;
	}

	return Array.from(groups.values())
		.sort((left, right) => left.project.localeCompare(right.project, 'ru'));
}

/** Groups project containers under each discovered compose file. */
function buildDockerComposeFileContainerGroups(
	composeFiles: DockerComposeFileReference[],
	containers: DockerContainerSummary[],
	serviceNamesByComposeFile: DockerComposeServiceNamesByFile = new Map(),
): DockerComposeFileContainerGroup[] {
	return composeFiles.map(composeFile => {
		const composeFilePath = normalizeFsPath(composeFile.filePath);
		const serviceNames = serviceNamesByComposeFile.get(composeFilePath) || [];
		const composeContainers = containers
			.filter(container => container.composeFilePaths.some(filePath => normalizeFsPath(filePath) === composeFilePath))
			.sort(compareDockerContainers);
		const status = resolveDockerComposeFileStatus(composeContainers, serviceNames);
		return {
			composeFile,
			containers: composeContainers,
			serviceNames,
			status: status.status,
			statusTone: status.statusTone,
			statusText: status.statusText,
			runningCount: composeContainers.filter(container => container.status === 'running').length,
			stoppedCount: composeContainers.filter(container => container.status === 'stopped').length,
			warningCount: composeContainers.filter(container => container.statusTone === 'warning').length,
			errorCount: composeContainers.filter(container => container.statusTone === 'error').length,
		};
	});
}

/** Resolves a compose-file status badge from its containers and declared services. */
function resolveDockerComposeFileStatus(
	containers: DockerContainerSummary[],
	serviceNames: string[],
): { status: DockerContainerLifecycleStatus; statusTone: DockerContainerStatusTone; statusText: string } {
	const runningCount = containers.filter(container => container.status === 'running').length;
	const errorCount = containers.filter(container => container.statusTone === 'error').length;
	if (errorCount > 0) {
		return { status: 'error', statusTone: 'error', statusText: `Ошибки: ${errorCount}` };
	}
	if (runningCount > 0) {
		return {
			status: 'running',
			statusTone: 'ok',
			statusText: runningCount === containers.length
				? `Запущено ${runningCount}`
				: `Запущено ${runningCount}/${containers.length}`,
		};
	}
	if (containers.length > 0 || serviceNames.length > 0) {
		return { status: 'stopped', statusTone: 'neutral', statusText: 'Остановлен' };
	}
	return { status: 'unknown', statusTone: 'neutral', statusText: 'Сервисы не найдены' };
}

/** Sorts running containers first, then by project service/name. */
function compareDockerContainers(left: DockerContainerSummary, right: DockerContainerSummary): number {
	const statusPriority = (status: DockerContainerLifecycleStatus): number => status === 'running' ? 0 : status === 'stopped' ? 2 : 1;
	const byStatus = statusPriority(left.status) - statusPriority(right.status);
	if (byStatus !== 0) {
		return byStatus;
	}
	return `${left.service}:${left.name}`.localeCompare(`${right.service}:${right.name}`, 'ru');
}

/** Maps Docker state into the widget lifecycle status union. */
function resolveContainerLifecycleStatus(container: DockerEngineContainerListItem, inspect?: DockerEngineContainerInspect): DockerContainerLifecycleStatus {
	const state = inspect?.State;
	const rawState = String(state?.Status || container.State || '').toLowerCase();
	if (state?.Dead || state?.Error || rawState === 'dead') {
		return 'error';
	}
	if (state?.Restarting || rawState === 'restarting') {
		return 'restarting';
	}
	if (state?.Paused || rawState === 'paused') {
		return 'paused';
	}
	if (state?.Running || rawState === 'running') {
		return 'running';
	}
	if (rawState === 'created') {
		return 'starting';
	}
	if (rawState === 'exited' || rawState === 'removing') {
		return 'stopped';
	}
	return rawState ? 'unknown' : 'unknown';
}

/** Resolves a compact status tone for badges and project counters. */
function resolveContainerStatusTone(status: DockerContainerLifecycleStatus, health: string | undefined, error: string): DockerContainerStatusTone {
	if (error || status === 'error' || health === 'unhealthy') {
		return 'error';
	}
	if (status === 'restarting' || status === 'paused') {
		return 'warning';
	}
	if (status === 'starting') {
		return 'progress';
	}
	if (status === 'running') {
		return health === 'starting' ? 'progress' : 'ok';
	}
	return 'neutral';
}

/** Keeps Docker's human status text while appending health when present. */
function resolveContainerStatusText(container: DockerEngineContainerListItem, inspect?: DockerEngineContainerInspect, health?: string): string {
	const statusText = container.Status || inspect?.State?.Status || container.State || 'unknown';
	return health ? `${statusText} / ${health}` : statusText;
}

/** Merges list and inspect ports into a stable display list. */
function normalizeContainerPorts(
	ports: DockerEngineContainerPort[],
	inspect?: DockerEngineContainerInspect,
): DockerContainerPortMapping[] {
	const result = new Map<string, DockerContainerPortMapping>();
	for (const port of ports) {
		const privatePort = toFiniteNumber(port.PrivatePort);
		if (privatePort <= 0) {
			continue;
		}
		const mapping = createPortMapping(privatePort, port.Type || 'tcp', port.PublicPort, port.IP);
		result.set(mapping.label, mapping);
	}

	for (const [containerPort, bindings] of Object.entries(inspect?.NetworkSettings?.Ports || {})) {
		const [privatePortRaw, type = 'tcp'] = containerPort.split('/');
		const privatePort = Number.parseInt(privatePortRaw, 10);
		if (!Number.isFinite(privatePort)) {
			continue;
		}
		if (!bindings || bindings.length === 0) {
			const mapping = createPortMapping(privatePort, type);
			result.set(mapping.label, mapping);
			continue;
		}
		for (const binding of bindings) {
			const publicPort = Number.parseInt(binding.HostPort || '', 10);
			const mapping = createPortMapping(privatePort, type, publicPort, binding.HostIp);
			result.set(mapping.label, mapping);
		}
	}

	return Array.from(result.values()).sort((left, right) => left.privatePort - right.privatePort || left.label.localeCompare(right.label, 'ru'));
}

/** Creates one normalized port display object. */
function createPortMapping(privatePort: number, type: string, publicPort?: number, ip?: string): DockerContainerPortMapping {
	const normalizedPublicPort = typeof publicPort === 'number' && Number.isFinite(publicPort) && publicPort > 0 ? publicPort : undefined;
	const normalizedType = type || 'tcp';
	const host = normalizedPublicPort ? `${ip || '127.0.0.1'}:${normalizedPublicPort}->` : '';
	return {
		ip,
		privatePort,
		publicPort: normalizedPublicPort,
		type: normalizedType,
		label: `${host}${privatePort}/${normalizedType}`,
	};
}

/** Converts Docker mount entries into a UI-safe summary. */
function normalizeContainerMounts(mounts: DockerEngineContainerMount[]): DockerContainerMountSummary[] {
	return mounts.map(mount => ({
		type: mount.Type || '',
		source: mount.Source || mount.Name || '',
		destination: mount.Destination || '',
		mode: mount.Mode,
		name: mount.Name,
		readWrite: mount.RW,
	})).filter(mount => mount.destination || mount.source);
}

/** Calculates Docker-compatible CPU percentage from current and previous counters. */
function calculateCpuPercent(rawStats: DockerEngineContainerStats): number {
	const cpuTotal = toFiniteNumber(rawStats.cpu_stats?.cpu_usage?.total_usage);
	const previousCpuTotal = toFiniteNumber(rawStats.precpu_stats?.cpu_usage?.total_usage);
	const systemTotal = toFiniteNumber(rawStats.cpu_stats?.system_cpu_usage);
	const previousSystemTotal = toFiniteNumber(rawStats.precpu_stats?.system_cpu_usage);
	const cpuDelta = cpuTotal - previousCpuTotal;
	const systemDelta = systemTotal - previousSystemTotal;
	const onlineCpus = toFiniteNumber(rawStats.cpu_stats?.online_cpus)
		|| rawStats.cpu_stats?.cpu_usage?.percpu_usage?.length
		|| 1;
	if (cpuDelta <= 0 || systemDelta <= 0) {
		return 0;
	}
	return clampPercent((cpuDelta / systemDelta) * onlineCpus * 100);
}

/** Calculates memory usage similarly to Docker CLI by subtracting cache when available. */
function calculateMemoryUsageBytes(rawStats: DockerEngineContainerStats): number {
	const usage = toFiniteNumber(rawStats.memory_stats?.usage);
	const cache = toFiniteNumber(rawStats.memory_stats?.stats?.inactive_file || rawStats.memory_stats?.stats?.cache);
	return Math.max(0, usage - cache);
}

/** Sums RX/TX bytes across Docker networks. */
function calculateNetworkTotals(rawStats: DockerEngineContainerStats): { rxBytes: number; txBytes: number } {
	return Object.values(rawStats.networks || {}).reduce((totals, network) => ({
		rxBytes: totals.rxBytes + toFiniteNumber(network.rx_bytes),
		txBytes: totals.txBytes + toFiniteNumber(network.tx_bytes),
	}), { rxBytes: 0, txBytes: 0 });
}

/** Resolves a human-readable command from inspect config and list fallback. */
function resolveContainerCommand(container: DockerEngineContainerListItem, inspect?: DockerEngineContainerInspect): string {
	const entrypoint = inspect?.Config?.Entrypoint;
	const entrypointParts = Array.isArray(entrypoint) ? entrypoint : entrypoint ? [entrypoint] : [];
	const cmd = inspect?.Config?.Cmd || inspect?.Args || [];
	const parts = [...entrypointParts, ...cmd].filter(Boolean);
	return parts.length > 0 ? parts.join(' ') : container.Command || '';
}

/** Normalizes Docker container names by removing the leading slash. */
function normalizeContainerName(value: string): string {
	return value.replace(/^\/+/, '');
}

/** Converts Docker timestamps into ISO strings when possible. */
function normalizeDockerDate(value: string | undefined): string | undefined {
	if (!value || value.startsWith('0001-01-01')) {
		return undefined;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

/** Converts Docker `Created` fields from seconds or ISO strings into ISO strings. */
function normalizeDockerCreatedAt(value: string | number | undefined): string {
	if (typeof value === 'number') {
		return new Date(value * 1000).toISOString();
	}
	return normalizeDockerDate(value) || new Date().toISOString();
}

/** Finds a container by full or short ID in one widget payload. */
function findContainerSummary(data: DockerContainersData, containerId: string): DockerContainerSummary | null {
	for (const project of data.projects) {
		const container = project.containers.find(item => item.id === containerId || item.shortId === containerId || item.id.startsWith(containerId));
		if (container) {
			return container;
		}
	}
	return null;
}

/** Finds a compose file inside one workspace project group. */
function findComposeFileTarget(
	data: DockerContainersData,
	projectPath: string,
	composeFilePath: string,
): { project: DockerContainerProjectGroup; composeFile: DockerComposeFileReference } | null {
	for (const project of data.projects) {
		if (normalizeFsPath(project.projectPath) !== projectPath) {
			continue;
		}
		const composeFile = project.composeFiles.find(file => normalizeFsPath(file.filePath) === composeFilePath);
		if (composeFile) {
			return { project, composeFile };
		}
	}
	return null;
}

/** Returns unique project-level container rows so runtime refreshes do not duplicate stat requests. */
function getUniqueDockerContainers(data: DockerContainersData): DockerContainerSummary[] {
	const containersById = new Map<string, DockerContainerSummary>();
	for (const project of data.projects) {
		for (const container of project.containers) {
			if (!containersById.has(container.id)) {
				containersById.set(container.id, container);
			}
		}
	}
	return Array.from(containersById.values());
}

/** Recomputes runtime-only Docker fields without refetching the full compose topology. */
function rebuildDockerContainersDataRuntime(
	data: DockerContainersData,
	containersById: Map<string, DockerContainerSummary>,
	nowMs: number,
): DockerContainersData {
	const projects = data.projects.map(project => {
		const containers = project.containers.map(container => containersById.get(container.id) || container);
		const composeFileGroups = project.composeFileGroups.map(group => {
			const groupContainers = group.containers.map(container => containersById.get(container.id) || container);
			const status = resolveDockerComposeFileStatus(groupContainers, group.serviceNames || []);
			return {
				...group,
				containers: groupContainers,
				status: status.status,
				statusTone: status.statusTone,
				statusText: status.statusText,
				runningCount: groupContainers.filter(container => container.status === 'running').length,
				stoppedCount: groupContainers.filter(container => container.status === 'stopped').length,
				warningCount: groupContainers.filter(container => container.statusTone === 'warning').length,
				errorCount: groupContainers.filter(container => container.statusTone === 'error').length,
			};
		});
		return {
			...project,
			containers,
			composeFileGroups,
			runningCount: containers.filter(container => container.status === 'running').length,
			stoppedCount: containers.filter(container => container.status === 'stopped').length,
			warningCount: containers.filter(container => container.statusTone === 'warning').length,
			errorCount: containers.filter(container => container.statusTone === 'error').length,
		};
	});
	const allContainers = projects.flatMap(project => project.containers);
	return {
		...data,
		generatedAt: new Date(nowMs).toISOString(),
		projects,
		totalContainers: allContainers.length,
		runningContainers: allContainers.filter(container => container.status === 'running').length,
		stoppedContainers: allContainers.filter(container => container.status === 'stopped').length,
		warningContainers: allContainers.filter(container => container.statusTone === 'warning').length,
		errorContainers: allContainers.filter(container => container.statusTone === 'error').length,
	};
}

/** Recomputes uptime locally so running rows stay live between topology refreshes. */
function resolveRuntimeDockerContainerUptimeMs(
	container: Pick<DockerContainerSummary, 'status' | 'startedAt'>,
	nowMs: number,
): number {
	return container.status === 'running' && container.startedAt
		? Math.max(0, nowMs - Date.parse(container.startedAt))
		: 0;
}

/** Treats running, starting, restarting and paused containers as still active. */
function isDockerActiveLifecycleStatus(status: DockerContainerLifecycleStatus | null | undefined): boolean {
	return status === 'running' || status === 'starting' || status === 'restarting' || status === 'paused';
}

/** Detects transient lifecycle states that should settle before the dashboard unlocks. */
function isDockerTransitioningLifecycleStatus(status: DockerContainerLifecycleStatus | null | undefined): boolean {
	return status === 'starting' || status === 'restarting';
}

/** Checks whether one container action already reached its expected visible state. */
function isDockerContainerActionSettled(
	action: DockerContainerActionKind,
	status: DockerContainerLifecycleStatus | null,
): boolean {
	if (action === 'remove') {
		return status === null;
	}
	if (action === 'start' || action === 'restart') {
		return status === 'running';
	}
	return status !== null && !isDockerActiveLifecycleStatus(status);
}

/** Checks whether a compose file settled into a stable post-action state. */
function isDockerComposeActionSettled(
	action: DockerComposeProjectActionKind,
	group: DockerComposeFileContainerGroup | undefined,
): boolean {
	if (action === 'down') {
		return !group || group.containers.length === 0 || group.containers.every(container => !isDockerActiveLifecycleStatus(container.status));
	}
	if (!group || group.containers.length === 0) {
		return false;
	}
	return group.containers.every(container => !isDockerTransitioningLifecycleStatus(container.status))
		&& group.containers.some(container => isDockerActiveLifecycleStatus(container.status));
}

/** Waits between bounded Docker settle polls without blocking the extension host. */
function delay(valueMs: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, valueMs));
}

/** Normalizes filesystem paths for compose-label matching. */
function normalizeFsPath(value: string): string {
	return path.resolve(value).split(path.sep).join('/');
}

/** Converts unknown numeric values into finite positive numbers. */
function toFiniteNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Clamps a percentage without hiding high CPU values on multi-core hosts. */
function clampPercent(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.round(value * 10) / 10);
}

/** Maps with a small concurrency limit to avoid overwhelming Docker Engine. */
async function mapLimited<TInput, TOutput>(
	items: TInput[],
	limit: number,
	mapper: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
	const results: TOutput[] = [];
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await mapper(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

/** Quotes one argument for the local shell commands opened by the Docker widget. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}