import * as vscode from 'vscode';
import type { AiService } from './aiService.js';
import type { GitService } from './gitService.js';
import type { StorageService } from './storageService.js';
import type { WorkspaceService } from './workspaceService.js';
import type { Prompt, PromptConfig } from '../types/prompt.js';
import type { GitOverlayProjectSnapshot } from '../types/git.js';
import type {
	PromptDashboardAnalysisState,
	PromptDashboardPromptActivityData,
	PromptDashboardPromptActivityItem,
	PromptDashboardProjectsData,
	PromptDashboardProjectSummary,
	PromptDashboardScope,
	PromptDashboardSnapshot,
	PromptDashboardStatusData,
	PromptDashboardWidgetKind,
	PromptDashboardWidgetSnapshot,
} from '../types/promptDashboard.js';
import {
	buildPromptDashboardAnalysisFingerprint,
	buildPromptDashboardBranchActions,
	buildPromptDashboardScopeKey,
	buildPromptDashboardWidgetCacheKey,
	createPromptDashboardWidgetSnapshot,
	flattenPromptDashboardChangeFiles,
	getPromptDashboardStatusProgress,
	PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS,
	PROMPT_DASHBOARD_WARM_INTERVAL_MS,
	resolvePromptDashboardCacheState,
	splitPromptDashboardActivityByDay,
} from '../utils/promptDashboard.js';
import { appendPromptManagerLog } from '../utils/promptManagerOutput.js';
import { resolveEffectiveProjectNames } from '../utils/projectScope.js';

interface DashboardCacheEntry<TData> {
	data: TData;
	updatedAtMs: number;
	error?: string;
}

type PromptDashboardProjectsRefreshMode = 'display' | 'details' | 'analysis' | 'reactive-branches';

type DashboardPostMessage = (message: unknown) => void;

/** Signals that background widget work no longer matches the active prompt scope. */
class PromptDashboardStaleScopeError extends Error {
	constructor() {
		super('Prompt dashboard scope is stale.');
		this.name = 'PromptDashboardStaleScopeError';
	}
}

export class PromptDashboardService implements vscode.Disposable {
	private static readonly CACHE_TTL_MS = PROMPT_DASHBOARD_WARM_INTERVAL_MS;
	private static readonly PROJECT_CONCURRENCY = 1;
	private static readonly AUTO_REFRESH_DELAY_MS = 1200;
	/** Show a local review preview before a slow LM response leaves the widget blank for too long. */
	private static readonly ANALYSIS_PREVIEW_DELAY_MS = 4000;
	private static readonly RECENT_COMMIT_LIMIT = 2;
	private static readonly PARALLEL_BRANCH_LIMIT = 8;

	private readonly cache = new Map<string, DashboardCacheEntry<unknown>>();
	private readonly sharedProjectsCache = new Map<string, DashboardCacheEntry<PromptDashboardProjectsData>>();
	private readonly inFlight = new Map<string, Promise<unknown>>();
	private readonly sharedAnalysisCache = new Map<string, DashboardCacheEntry<PromptDashboardAnalysisState>>();
	private readonly analysisInFlight = new Map<string, Promise<PromptDashboardAnalysisState>>();
	private activeScope: PromptDashboardScope | null = null;
	private warmTimer: NodeJS.Timeout | null = null;
	private autoRefreshTimer: NodeJS.Timeout | null = null;
	private autoRefreshGeneration = 0;

	constructor(
		private readonly storageService: StorageService,
		private readonly workspaceService: WorkspaceService,
		private readonly gitService: GitService,
		private readonly aiService: AiService,
	) {
		this.warmTimer = setInterval(() => {
			const scope = this.activeScope;
			if (!scope) {
				return;
			}
			void this.refreshScope(scope, undefined, { force: false, includeAiAnalysis: true });
		}, PROMPT_DASHBOARD_WARM_INTERVAL_MS);
		this.warmTimer.unref?.();
	}

	dispose(): void {
		if (this.warmTimer) {
			clearInterval(this.warmTimer);
			this.warmTimer = null;
		}
		if (this.autoRefreshTimer) {
			clearTimeout(this.autoRefreshTimer);
			this.autoRefreshTimer = null;
		}
		this.inFlight.clear();
		this.sharedProjectsCache.clear();
		this.sharedAnalysisCache.clear();
		this.analysisInFlight.clear();
	}

	getSnapshot(prompt: Prompt, postMessage?: DashboardPostMessage, requestId?: string, forceRefresh = false): PromptDashboardSnapshot {
		const scope = this.createScope(prompt);
		this.activeScope = scope;
		const snapshot = this.buildSnapshotFromCache(scope, prompt);
		// Initial open should avoid auto-running AI review on the prompt-open critical path.
		this.scheduleAutoRefresh(scope, postMessage, {
			force: forceRefresh,
			requestId,
			prompt,
			includeAiAnalysis: false,
			ensureBackgroundAiAnalysis: true,
			analysisReason: 'initial-auto-refresh',
			projectsMode: 'display',
		});
		return snapshot;
	}

	async refreshPrompt(prompt: Prompt, postMessage?: DashboardPostMessage, requestId?: string): Promise<PromptDashboardSnapshot> {
		const scope = this.createScope(prompt);
		this.activeScope = scope;
		this.cancelScheduledAutoRefresh('manual-refresh', scope, requestId);
		await this.refreshScope(scope, postMessage, {
			force: true,
			requestId,
			prompt,
			includeAiAnalysis: true,
			projectsMode: 'analysis',
		});
		return this.buildSnapshotFromCache(scope, prompt);
	}

	/** Refreshes visible dashboard widgets without blocking on the follow-up AI review pass. */
	async refreshPromptSnapshot(prompt: Prompt, postMessage?: DashboardPostMessage, requestId?: string): Promise<PromptDashboardSnapshot> {
		const scope = this.createScope(prompt);
		this.activeScope = scope;
		this.cancelScheduledAutoRefresh('manual-refresh-snapshot', scope, requestId);
		await this.refreshScope(scope, postMessage, {
			force: true,
			requestId,
			prompt,
			includeAiAnalysis: false,
			projectsMode: 'display',
		});
		return this.buildSnapshotFromCache(scope, prompt);
	}

	/** Refreshes only Git-backed project widgets after external repo changes. */
	async refreshProjectsWidget(
		prompt: Prompt,
		postMessage?: DashboardPostMessage,
		requestId?: string,
		mode: PromptDashboardProjectsRefreshMode = 'display',
	): Promise<PromptDashboardWidgetSnapshot<PromptDashboardProjectsData>> {
		const scope = this.createScope(prompt);
		this.activeScope = scope;
		await this.refreshWidget(scope, 'projects', postMessage, { force: true, requestId, prompt, projectsMode: mode });
		return this.buildProjectsWidgetFromCache(scope);
	}

	async switchProjectBranch(prompt: Prompt, project: string, branch: string): Promise<{ success: boolean; errors: string[] }> {
		return this.switchProjectBranches(prompt, { [project]: branch });
	}

	async switchProjectBranches(prompt: Prompt, branchesByProject: Record<string, string>): Promise<{ success: boolean; errors: string[] }> {
		const entries = Object.entries(branchesByProject || {})
			.map(([project, branch]) => [project.trim(), String(branch || '').trim()] as const)
			.filter(([project, branch]) => Boolean(project && branch));
		if (entries.length === 0) {
			return { success: false, errors: ['Не выбраны ветки для переключения.'] };
		}

		const paths = this.workspaceService.getWorkspaceFolderPaths();
		const targetBranches = entries.map(([, branch]) => branch);
		const promptBranch = (prompt.branch || '').trim();
		const allowedBranches = Array.from(new Set([
			...this.getAllowedBranches(),
			promptBranch,
			...targetBranches,
		].filter(Boolean)));
		const directEntries = entries.filter(([, branch]) => !promptBranch || branch !== promptBranch);
		const promptBranchEntries = entries.filter(([, branch]) => Boolean(promptBranch) && branch === promptBranch);
		const projectsByBranch = directEntries.reduce<Record<string, string[]>>((groups, [project, branch]) => {
			groups[branch] = [...(groups[branch] || []), project];
			return groups;
		}, {});
		const errors: string[] = [];
		if (promptBranchEntries.length > 0 && promptBranch) {
			const targetProjects = promptBranchEntries.map(([project]) => project);
			const sourceBranchesByProject = Object.fromEntries(
				targetProjects.map((project) => [project, this.resolveTrackedBranchForSwitch(prompt, project)]),
			);
			const targetBranchesByProject = Object.fromEntries(promptBranchEntries);
			const result = await this.gitService.applyBranchTargetsByProject(
				paths,
				targetProjects,
				promptBranch,
				sourceBranchesByProject,
				targetBranchesByProject,
				allowedBranches,
			);
			errors.push(...result.errors);
		}
		for (const [branch, projects] of Object.entries(projectsByBranch)) {
			const result = await this.gitService.switchBranch(paths, projects, branch, allowedBranches);
			errors.push(...result.errors);
		}
		const scope = this.createScope(prompt);
		this.cancelScheduledAutoRefresh('branch-switch', scope);
		this.invalidateScope(scope);
		return { success: errors.length === 0, errors };
	}

	/** Pauses the current dashboard scope as soon as the editor starts switching prompts. */
	pauseActiveScope(reason: string, options?: { nextPromptId?: string; requestVersion?: number }): void {
		const scope = this.activeScope;
		if (!scope) {
			return;
		}

		this.cancelScheduledAutoRefresh(reason, scope);
		this.activeScope = null;
		this.logDashboardPerf('scope.paused', {
			reason,
			promptId: scope.promptId,
			scopeKey: buildPromptDashboardScopeKey(scope),
			nextPromptId: options?.nextPromptId || '',
			requestVersion: options?.requestVersion ?? 0,
		});
	}

	async analyzeParallelReview(prompt: Prompt, postMessage?: DashboardPostMessage, requestId?: string): Promise<PromptDashboardAnalysisState> {
		const scope = this.createScope(prompt);
		this.activeScope = scope;
		// Keep the visible projects widget stable while AI refreshes deeper Git context in the background.
		await this.refreshWidget(scope, 'projects', undefined, {
			force: true,
			requestId,
			prompt,
			projectsMode: 'analysis',
		});
		return this.refreshAnalysis(scope, prompt, postMessage, requestId, true);
	}

	private startBackgroundAnalysisIfNeeded(
		scope: PromptDashboardScope,
		prompt: Prompt,
		postMessage?: DashboardPostMessage,
		requestId?: string,
		reason: string = 'auto-refresh',
	): void {
		const scopeKey = buildPromptDashboardScopeKey(scope);
		if (!this.isScopeActive(scope)) {
			this.logDashboardPerf('analysis.autostart.skipped', {
				promptId: scope.promptId,
				requestId: requestId || '',
				scopeKey,
				reason,
				skipReason: 'inactive-scope',
			});
			return;
		}

		const projectsData = this.getProjectsDataForScope(scope);
		const projectMetrics = this.summarizeAnalysisProjects(projectsData.projects);
		const cached = this.getCachedData<PromptDashboardAnalysisState | null>(scope, 'aiAnalysis');
		const inputFingerprint = buildPromptDashboardAnalysisFingerprint({
			promptTitle: prompt.title,
			promptContent: prompt.content || '',
			promptBranch: scope.promptBranch,
			projects: projectsData.projects,
		});
		const shared = this.getSharedAnalysis(inputFingerprint);
		const cachedStatus = cached?.status || 'none';
		const sharedStatus = shared?.status || 'none';
		if (projectsData.projects.length === 0) {
			this.logDashboardPerf('analysis.autostart.skipped', {
				promptId: scope.promptId,
				requestId: requestId || '',
				scopeKey,
				reason,
				skipReason: 'no-projects',
				cachedStatus,
				sharedStatus,
				inputFingerprint,
				...projectMetrics,
			});
			return;
		}

		if ((cached && cached.status !== 'idle') || (shared && shared.status !== 'idle')) {
			this.logDashboardPerf('analysis.autostart.skipped', {
				promptId: scope.promptId,
				requestId: requestId || '',
				scopeKey,
				reason,
				skipReason: 'already-available',
				cachedStatus,
				sharedStatus,
				inputFingerprint,
				...projectMetrics,
			});
			return;
		}

		const startedAtMs = Date.now();
		this.logDashboardPerf('analysis.autostart.queued', {
			promptId: scope.promptId,
			requestId: requestId || '',
			scopeKey,
			reason,
			cachedStatus,
			sharedStatus,
			inputFingerprint,
			...projectMetrics,
		});
		void this.analyzeParallelReview(prompt, postMessage, requestId)
			.then((result) => {
				this.logDashboardPerf('analysis.autostart.completed', {
					promptId: scope.promptId,
					requestId: requestId || '',
					scopeKey,
					reason,
					status: result.status,
					durationMs: Date.now() - startedAtMs,
				});
			})
			.catch((error) => {
				this.logDashboardPerf('analysis.autostart.failed', {
					promptId: scope.promptId,
					requestId: requestId || '',
					scopeKey,
					reason,
					durationMs: Date.now() - startedAtMs,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	private async refreshAnalysis(
		scope: PromptDashboardScope,
		prompt: Prompt,
		postMessage?: DashboardPostMessage,
		requestId?: string,
		force = false,
	): Promise<PromptDashboardAnalysisState> {
		const scopeKey = buildPromptDashboardScopeKey(scope);
		const idleState: PromptDashboardAnalysisState = {
			status: 'idle',
			model: prompt.model || scope.model,
			content: '',
			updatedAt: new Date().toISOString(),
		};
		if (!this.isScopeActive(scope)) {
			this.logDashboardPerf('analysis.skipped-stale', {
				promptId: scope.promptId,
				requestId: requestId || '',
				scopeKey,
				reason: 'inactive-before-start',
			});
			return this.getCachedData<PromptDashboardAnalysisState | null>(scope, 'aiAnalysis') || idleState;
		}

		const projectsData = this.getProjectsDataForScope(scope);
		const projectMetrics = this.summarizeAnalysisProjects(projectsData.projects);
		const inputFingerprint = buildPromptDashboardAnalysisFingerprint({
			promptTitle: prompt.title,
			promptContent: prompt.content || '',
			promptBranch: scope.promptBranch,
			projects: projectsData.projects,
		});
		const cached = this.getCachedData<PromptDashboardAnalysisState | null>(scope, 'aiAnalysis');
		const sharedCached = this.getSharedAnalysis(inputFingerprint);
		this.logDashboardPerf('analysis.requested', {
			promptId: scope.promptId,
			requestId: requestId || '',
			scopeKey,
			force,
			inputFingerprint,
			cachedStatus: cached?.status || 'none',
			sharedStatus: sharedCached?.status || 'none',
			...projectMetrics,
		});
		if (!force && cached?.inputFingerprint === inputFingerprint && cached.status !== 'idle') {
			this.logDashboardPerf('analysis.reused-scope-cache', {
				promptId: scope.promptId,
				requestId: requestId || '',
				scopeKey,
				inputFingerprint,
				status: cached.status,
			});
			return cached;
		}

		if (!force && sharedCached && sharedCached.status !== 'idle') {
			this.logDashboardPerf('analysis.reused-shared-cache', {
				promptId: scope.promptId,
				requestId: requestId || '',
				scopeKey,
				inputFingerprint,
				status: sharedCached.status,
			});
			this.setCache(scope, 'aiAnalysis', sharedCached, sharedCached.status === 'error' ? sharedCached.error : undefined);
			this.postAnalysis(postMessage, prompt, sharedCached, requestId);
			return sharedCached;
		}

		const analysisKey = inputFingerprint;
		const existing = this.analysisInFlight.get(analysisKey);
		if (existing) {
			this.logDashboardPerf('analysis.waiting-in-flight', {
				promptId: scope.promptId,
				requestId: requestId || '',
				scopeKey,
				inputFingerprint,
			});
			return existing;
		}

		const loading: PromptDashboardAnalysisState = {
			status: 'running',
			model: prompt.model || scope.model,
			content: '',
			updatedAt: new Date().toISOString(),
			inputFingerprint,
		};
		this.setCache(scope, 'aiAnalysis', loading);
		this.setSharedAnalysis(inputFingerprint, loading);
		this.postAnalysis(postMessage, prompt, loading, requestId);
		const analysisStartedAtMs = Date.now();
		const previewContent = this.buildPromptDashboardAnalysisPreview(projectsData.projects);
		let previewTimer: NodeJS.Timeout | null = null;
		if (postMessage && previewContent) {
			previewTimer = setTimeout(() => {
				if (!this.isScopeActive(scope)) {
					return;
				}
				const current = this.getCachedData<PromptDashboardAnalysisState | null>(scope, 'aiAnalysis');
				if (!current || current.status !== 'running' || current.inputFingerprint !== inputFingerprint || current.content.trim()) {
					return;
				}
				const previewState: PromptDashboardAnalysisState = {
					...current,
					content: previewContent,
					updatedAt: new Date().toISOString(),
				};
				this.setCache(scope, 'aiAnalysis', previewState);
				this.setSharedAnalysis(inputFingerprint, previewState);
				this.postAnalysis(postMessage, prompt, previewState, requestId);
				this.logDashboardPerf('analysis.preview-posted', {
					promptId: scope.promptId,
					requestId: requestId || '',
					scopeKey,
					inputFingerprint,
					delayMs: this.resolvePromptDashboardAnalysisPreviewDelayMs(),
					contentLength: previewContent.length,
				});
			}, this.resolvePromptDashboardAnalysisPreviewDelayMs());
			previewTimer.unref?.();
		}
		this.logDashboardPerf('analysis.started', {
			promptId: scope.promptId,
			requestId: requestId || '',
			scopeKey,
			force,
			inputFingerprint,
			...projectMetrics,
		});

		const task = (async () => {
			try {
				this.ensureScopeActive(scope);
				const content = await this.aiService.analyzePromptDashboardReview({
					promptTitle: prompt.title,
					promptContent: prompt.content || '',
					projects: projectsData.projects,
				});
				const completed: PromptDashboardAnalysisState = {
					status: 'completed',
					model: prompt.model || scope.model,
					content,
					updatedAt: new Date().toISOString(),
					inputFingerprint,
				};
				this.setSharedAnalysis(inputFingerprint, completed);
				if (!this.isScopeActive(scope)) {
					this.logDashboardPerf('analysis.completed-stale', {
						promptId: scope.promptId,
						requestId: requestId || '',
						scopeKey,
						durationMs: Date.now() - analysisStartedAtMs,
					});
					return completed;
				}
				this.setCache(scope, 'aiAnalysis', completed);
				this.postAnalysis(postMessage, prompt, completed, requestId);
				this.logDashboardPerf('analysis.completed', {
					promptId: scope.promptId,
					requestId: requestId || '',
					scopeKey,
					inputFingerprint,
					durationMs: Date.now() - analysisStartedAtMs,
					contentLength: content.length,
				});
				return completed;
			} catch (error) {
				if (error instanceof PromptDashboardStaleScopeError) {
					this.logDashboardPerf('analysis.skipped-stale', {
						promptId: scope.promptId,
						requestId: requestId || '',
						scopeKey,
						reason: 'inactive-during-run',
						durationMs: Date.now() - analysisStartedAtMs,
					});
					return loading;
				}

				const failed: PromptDashboardAnalysisState = {
					status: 'error',
					model: prompt.model || scope.model,
					content: '',
					updatedAt: new Date().toISOString(),
					inputFingerprint,
					error: error instanceof Error ? error.message : String(error),
				};
				if (!this.isScopeActive(scope)) {
					this.logDashboardPerf('analysis.failed-stale', {
						promptId: scope.promptId,
						requestId: requestId || '',
						scopeKey,
						durationMs: Date.now() - analysisStartedAtMs,
						error: failed.error,
					});
					return loading;
				}
				this.setCache(scope, 'aiAnalysis', failed);
				this.setSharedAnalysis(inputFingerprint, failed, failed.error);
				this.postAnalysis(postMessage, prompt, failed, requestId);
				this.logDashboardPerf('analysis.failed', {
					promptId: scope.promptId,
					requestId: requestId || '',
					scopeKey,
					inputFingerprint,
					durationMs: Date.now() - analysisStartedAtMs,
					error: failed.error,
				});
				return failed;
			}
		})();
		this.analysisInFlight.set(analysisKey, task);
		try {
			return await task;
		} finally {
			if (previewTimer) {
				clearTimeout(previewTimer);
			}
			this.analysisInFlight.delete(analysisKey);
		}
	}

	private createScope(prompt: Prompt): PromptDashboardScope {
		const workspaceProjectNames = this.workspaceService.getWorkspaceFolders();
		const projectNames = resolveEffectiveProjectNames(prompt.projects || [], workspaceProjectNames);
		const trackedBranchesByProject = Object.fromEntries(
			Object.entries(prompt.trackedBranchesByProject || {})
				.map(([project, branch]) => [project.trim(), String(branch || '').trim()] as const)
				.filter(([project, branch]) => Boolean(project && branch && projectNames.includes(project))),
		);
		return {
			promptId: (prompt.id || '__new__').trim() || '__new__',
			promptUuid: (prompt.promptUuid || '').trim(),
			projectNames,
			promptBranch: (prompt.branch || '').trim(),
			trackedBranch: (prompt.trackedBranch || '').trim(),
			trackedBranchesByProject,
			model: (prompt.model || '').trim(),
		};
	}

	private buildSnapshotFromCache(scope: PromptDashboardScope, prompt: Prompt): PromptDashboardSnapshot {
		const projects = this.buildProjectsWidgetFromCache(scope);
		const analysis = this.buildAnalysisWidgetFromCache(scope, prompt, projects.data);
		return {
			promptId: scope.promptId,
			promptUuid: scope.promptUuid,
			generatedAt: new Date().toISOString(),
			scopeKey: buildPromptDashboardScopeKey(scope),
			activity: this.buildWidgetFromCache(scope, 'activity', this.emptyActivity()),
			status: this.buildStatusWidgetFromPrompt(scope, prompt),
			projects,
			aiAnalysis: analysis,
		};
	}

	/** Keeps the status widget data tied to the live prompt while reusing cache metadata. */
	private buildStatusWidgetFromPrompt(
		scope: PromptDashboardScope,
		prompt: Prompt,
	): PromptDashboardWidgetSnapshot<PromptDashboardStatusData> {
		const cached = this.getCachedEntry<PromptDashboardStatusData>(scope, 'status');
		const data = this.statusFromPrompt(prompt);
		if (!cached) {
			return createPromptDashboardWidgetSnapshot('status', data);
		}
		const cache = cached.error
			? { ...resolvePromptDashboardCacheState(cached.updatedAtMs, PromptDashboardService.CACHE_TTL_MS), status: 'error' as const, error: cached.error }
			: resolvePromptDashboardCacheState(cached.updatedAtMs, PromptDashboardService.CACHE_TTL_MS);
		return createPromptDashboardWidgetSnapshot('status', data, cache);
	}

	private buildProjectsWidgetFromCache(scope: PromptDashboardScope): PromptDashboardWidgetSnapshot<PromptDashboardProjectsData> {
		const cached = this.getCachedEntry<PromptDashboardProjectsData>(scope, 'projects');
		if (cached) {
			return this.buildWidgetFromCache(scope, 'projects', { projects: [] });
		}
		const shared = this.getSharedProjects(scope);
		if (!shared) {
			return createPromptDashboardWidgetSnapshot('projects', { projects: [] });
		}
		const cache = shared.error
			? { ...resolvePromptDashboardCacheState(shared.updatedAtMs, PromptDashboardService.CACHE_TTL_MS), status: 'error' as const, error: shared.error }
			: resolvePromptDashboardCacheState(shared.updatedAtMs, PromptDashboardService.CACHE_TTL_MS);
		return createPromptDashboardWidgetSnapshot('projects', shared.data, cache);
	}

	private buildAnalysisWidgetFromCache(
		scope: PromptDashboardScope,
		prompt: Prompt,
		projectsData: PromptDashboardProjectsData,
	): PromptDashboardWidgetSnapshot<PromptDashboardAnalysisState | null> {
		const cached = this.getCachedEntry<PromptDashboardAnalysisState | null>(scope, 'aiAnalysis');
		if (cached) {
			return this.buildWidgetFromCache(scope, 'aiAnalysis', null);
		}
		const inputFingerprint = buildPromptDashboardAnalysisFingerprint({
			promptTitle: prompt.title,
			promptContent: prompt.content || '',
			promptBranch: scope.promptBranch,
			projects: projectsData.projects,
		});
		const shared = this.sharedAnalysisCache.get(inputFingerprint);
		if (!shared) {
			return createPromptDashboardWidgetSnapshot('aiAnalysis', null);
		}
		const cache = shared.error
			? { ...resolvePromptDashboardCacheState(shared.updatedAtMs, PromptDashboardService.CACHE_TTL_MS), status: 'error' as const, error: shared.error }
			: resolvePromptDashboardCacheState(shared.updatedAtMs, PromptDashboardService.CACHE_TTL_MS);
		return createPromptDashboardWidgetSnapshot('aiAnalysis', shared.data, cache);
	}

	private buildWidgetFromCache<TData>(
		scope: PromptDashboardScope,
		widget: PromptDashboardWidgetKind,
		placeholder: TData,
	): PromptDashboardWidgetSnapshot<TData> {
		const cacheKey = buildPromptDashboardWidgetCacheKey(scope, widget);
		const cached = this.cache.get(cacheKey) as DashboardCacheEntry<TData> | undefined;
		if (!cached) {
			return createPromptDashboardWidgetSnapshot(widget, placeholder);
		}
		const cache = cached.error
			? { ...resolvePromptDashboardCacheState(cached.updatedAtMs, PromptDashboardService.CACHE_TTL_MS), status: 'error' as const, error: cached.error }
			: resolvePromptDashboardCacheState(cached.updatedAtMs, PromptDashboardService.CACHE_TTL_MS);
		return createPromptDashboardWidgetSnapshot(widget, cached.data, cache);
	}

	private getCachedEntry<TData>(scope: PromptDashboardScope, widget: PromptDashboardWidgetKind): DashboardCacheEntry<TData> | undefined {
		return this.cache.get(buildPromptDashboardWidgetCacheKey(scope, widget)) as DashboardCacheEntry<TData> | undefined;
	}

	private getCachedData<TData>(scope: PromptDashboardScope, widget: PromptDashboardWidgetKind): TData | null {
		const cached = this.getCachedEntry<TData>(scope, widget);
		return cached?.data ?? null;
	}

	private getProjectsDataForScope(scope: PromptDashboardScope): PromptDashboardProjectsData {
		return this.getCachedData<PromptDashboardProjectsData>(scope, 'projects')
			|| this.getSharedProjects(scope)?.data
			|| { projects: [] };
	}

	private getProjectScopeKey(scope: PromptDashboardScope): string {
		const projects = [...scope.projectNames].map(item => item.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru')).join('|');
		const trackedByProject = Object.entries(scope.trackedBranchesByProject || {})
			.map(([project, branch]) => `${project.trim()}:${String(branch || '').trim()}`)
			.filter(item => item !== ':')
			.sort((a, b) => a.localeCompare(b, 'ru'))
			.join('|');
		return [projects, scope.promptBranch.trim(), scope.trackedBranch.trim(), trackedByProject].join('::');
	}

	private getSharedProjects(scope: PromptDashboardScope): DashboardCacheEntry<PromptDashboardProjectsData> | undefined {
		return this.sharedProjectsCache.get(this.getProjectScopeKey(scope));
	}

	private getSharedAnalysis(inputFingerprint: string): PromptDashboardAnalysisState | null {
		return this.sharedAnalysisCache.get(inputFingerprint)?.data ?? null;
	}

	private setCache<TData>(scope: PromptDashboardScope, widget: PromptDashboardWidgetKind, data: TData, error?: string): void {
		const entry = {
			data,
			updatedAtMs: Date.now(),
			error,
		};
		this.cache.set(buildPromptDashboardWidgetCacheKey(scope, widget), entry);
		if (widget === 'projects') {
			this.sharedProjectsCache.set(this.getProjectScopeKey(scope), entry as DashboardCacheEntry<PromptDashboardProjectsData>);
		}
	}

	private setSharedAnalysis(inputFingerprint: string, data: PromptDashboardAnalysisState, error?: string): void {
		this.sharedAnalysisCache.set(inputFingerprint, {
			data,
			updatedAtMs: Date.now(),
			error,
		});
	}

	private invalidateScope(scope: PromptDashboardScope): void {
		const prefix = `${buildPromptDashboardScopeKey(scope)}::`;
		for (const key of this.cache.keys()) {
			if (key.startsWith(prefix)) {
				this.cache.delete(key);
			}
		}
		this.sharedProjectsCache.delete(this.getProjectScopeKey(scope));
	}

	/** Schedule automatic dashboard refreshes away from the prompt-switch critical path. */
	private scheduleAutoRefresh(
		scope: PromptDashboardScope,
		postMessage?: DashboardPostMessage,
		options?: {
			force?: boolean;
			requestId?: string;
			prompt?: Prompt;
			includeAiAnalysis?: boolean;
			ensureBackgroundAiAnalysis?: boolean;
			analysisReason?: string;
			projectsMode?: PromptDashboardProjectsRefreshMode;
		},
	): void {
		const scopeKey = buildPromptDashboardScopeKey(scope);
		const delayMs = options?.force ? 0 : PromptDashboardService.AUTO_REFRESH_DELAY_MS;
		const generation = ++this.autoRefreshGeneration;
		if (this.autoRefreshTimer) {
			clearTimeout(this.autoRefreshTimer);
			this.autoRefreshTimer = null;
			this.logDashboardPerf('auto-refresh.rescheduled', {
				promptId: scope.promptId,
				requestId: options?.requestId || '',
				scopeKey,
				delayMs,
			});
		}
		const queuedAtMs = Date.now();
		this.logDashboardPerf('auto-refresh.queued', {
			promptId: scope.promptId,
			requestId: options?.requestId || '',
			scopeKey,
			delayMs,
			projectCount: scope.projectNames.length,
		});
		this.autoRefreshTimer = setTimeout(() => {
			this.autoRefreshTimer = null;
			if (generation !== this.autoRefreshGeneration) {
				this.logDashboardPerf('auto-refresh.skipped-stale-generation', {
					promptId: scope.promptId,
					requestId: options?.requestId || '',
					scopeKey,
				});
				return;
			}
			if (!this.activeScope || buildPromptDashboardScopeKey(this.activeScope) !== scopeKey) {
				this.logDashboardPerf('auto-refresh.skipped-inactive-scope', {
					promptId: scope.promptId,
					requestId: options?.requestId || '',
					scopeKey,
				});
				return;
			}
			const startedAtMs = Date.now();
			this.logDashboardPerf('auto-refresh.started', {
				promptId: scope.promptId,
				requestId: options?.requestId || '',
				scopeKey,
				queuedMs: startedAtMs - queuedAtMs,
			});
			void this.refreshScope(scope, postMessage, options)
				.then(() => {
					this.logDashboardPerf('auto-refresh.completed', {
						promptId: scope.promptId,
						requestId: options?.requestId || '',
						scopeKey,
						durationMs: Date.now() - startedAtMs,
					});
				})
				.catch((error) => {
					this.logDashboardPerf('auto-refresh.failed', {
						promptId: scope.promptId,
						requestId: options?.requestId || '',
						scopeKey,
						durationMs: Date.now() - startedAtMs,
						error: error instanceof Error ? error.message : String(error),
					});
				});
		}, delayMs);
		this.autoRefreshTimer.unref?.();
	}

	/** Cancel any queued automatic refresh that no longer matches the active prompt scope. */
	private cancelScheduledAutoRefresh(reason: string, scope?: PromptDashboardScope, requestId?: string): void {
		this.autoRefreshGeneration += 1;
		if (!this.autoRefreshTimer) {
			return;
		}
		clearTimeout(this.autoRefreshTimer);
		this.autoRefreshTimer = null;
		this.logDashboardPerf('auto-refresh.cancelled', {
			reason,
			promptId: scope?.promptId || '',
			requestId: requestId || '',
			scopeKey: scope ? buildPromptDashboardScopeKey(scope) : '',
		});
	}

	/** Write dashboard performance diagnostics into the shared Prompt Manager output channel. */
	private logDashboardPerf(event: string, payload?: Record<string, unknown>): void {
		const serializedPayload = payload ? ` ${JSON.stringify(payload)}` : '';
		appendPromptManagerLog(`[${new Date().toISOString()}] [dashboard-perf] ${event}${serializedPayload}`);
	}

	/** Checks whether a background task still belongs to the active dashboard scope. */
	private isScopeActive(scope: PromptDashboardScope): boolean {
		const activeScope = this.activeScope;
		if (!activeScope) {
			return false;
		}

		return buildPromptDashboardScopeKey(activeScope) === buildPromptDashboardScopeKey(scope);
	}

	/** Stops stale widget work once the editor switched to another prompt scope. */
	private ensureScopeActive(scope: PromptDashboardScope): void {
		if (!this.isScopeActive(scope)) {
			throw new PromptDashboardStaleScopeError();
		}
	}

	private async refreshScope(
		scope: PromptDashboardScope,
		postMessage?: DashboardPostMessage,
		options?: {
			force?: boolean;
			requestId?: string;
			prompt?: Prompt;
			includeAiAnalysis?: boolean;
			ensureBackgroundAiAnalysis?: boolean;
			analysisReason?: string;
			projectsMode?: PromptDashboardProjectsRefreshMode;
		},
	): Promise<void> {
		const scopeKey = buildPromptDashboardScopeKey(scope);
		const widgets: PromptDashboardWidgetKind[] = ['activity', 'status', 'projects'];
		await Promise.all(widgets.map(widget => this.refreshWidget(scope, widget, postMessage, options)));
		if (!this.isScopeActive(scope)) {
			this.logDashboardPerf('scope.refresh.aborted-stale', {
				promptId: scope.promptId,
				requestId: options?.requestId || '',
				scopeKey,
			});
			return;
		}
		if (options?.includeAiAnalysis && options.prompt) {
			await this.refreshAnalysis(scope, options.prompt, postMessage, options.requestId, false);
			return;
		}
		if (options?.ensureBackgroundAiAnalysis && options.prompt) {
			this.startBackgroundAnalysisIfNeeded(
				scope,
				options.prompt,
				postMessage,
				options.requestId,
				options.analysisReason || 'auto-refresh',
			);
		}
	}

	private async refreshWidget(
		scope: PromptDashboardScope,
		widget: PromptDashboardWidgetKind,
		postMessage?: DashboardPostMessage,
		options?: { force?: boolean; requestId?: string; prompt?: Prompt; projectsMode?: PromptDashboardProjectsRefreshMode },
	): Promise<void> {
		const widgetStartedAtMs = Date.now();
		const cacheKey = buildPromptDashboardWidgetCacheKey(scope, widget);
		const scopeKey = buildPromptDashboardScopeKey(scope);
		const cached = this.cache.get(cacheKey);
		if (!options?.force && widget === 'projects' && !cached) {
			const shared = this.getSharedProjects(scope);
			if (shared && Date.now() - shared.updatedAtMs < PromptDashboardService.CACHE_TTL_MS) {
				this.cache.set(cacheKey, shared);
				this.logDashboardPerf('widget.reused-shared-projects', {
					widget,
					promptId: scope.promptId,
					requestId: options?.requestId || '',
				});
				return;
			}
		}
		if (!options?.force && widget !== 'status' && cached && Date.now() - cached.updatedAtMs < PromptDashboardService.CACHE_TTL_MS) {
			this.logDashboardPerf('widget.skipped-fresh-cache', {
				widget,
				promptId: scope.promptId,
				requestId: options?.requestId || '',
			});
			return;
		}
		if (postMessage) {
			this.postWidget(postMessage, scope, this.buildLoadingWidgetSnapshot(scope, widget, options?.prompt), options?.requestId);
		}

		// A force refresh after branch switching must outlive any stale in-flight snapshot work.
		while (true) {
			const existing = this.inFlight.get(cacheKey);
			if (!existing) {
				break;
			}
			this.logDashboardPerf('widget.waiting-in-flight', {
				widget,
				promptId: scope.promptId,
				requestId: options?.requestId || '',
			});
			await existing;
			if (!options?.force) {
				return;
			}
		}
		this.ensureScopeActive(scope);
		this.logDashboardPerf('widget.started', {
			widget,
			promptId: scope.promptId,
			requestId: options?.requestId || '',
			force: options?.force === true,
		});

		const task = (async () => {
			try {
				const data = await this.loadWidgetData(scope, widget, options?.prompt, options?.projectsMode);
				this.ensureScopeActive(scope);
				this.setCache(scope, widget, data);
				const snapshot = this.buildWidgetFromCache(scope, widget, data);
				this.postWidget(postMessage, scope, snapshot, options?.requestId);
				this.logDashboardPerf('widget.completed', {
					widget,
					promptId: scope.promptId,
					requestId: options?.requestId || '',
					durationMs: Date.now() - widgetStartedAtMs,
				});
			} catch (error) {
				if (error instanceof PromptDashboardStaleScopeError) {
					this.logDashboardPerf('widget.aborted-stale', {
						widget,
						promptId: scope.promptId,
						requestId: options?.requestId || '',
						scopeKey,
						durationMs: Date.now() - widgetStartedAtMs,
					});
					return;
				}
				const fallback = this.getCachedData(scope, widget) || this.placeholderForWidget(widget, options?.prompt);
				this.setCache(scope, widget, fallback, error instanceof Error ? error.message : String(error));
				const snapshot = this.buildWidgetFromCache(scope, widget, fallback);
				this.postWidget(postMessage, scope, snapshot, options?.requestId);
				this.logDashboardPerf('widget.failed', {
					widget,
					promptId: scope.promptId,
					requestId: options?.requestId || '',
					durationMs: Date.now() - widgetStartedAtMs,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		})();
		this.inFlight.set(cacheKey, task);
		try {
			await task;
		} finally {
			this.inFlight.delete(cacheKey);
		}
	}

	private buildLoadingWidgetSnapshot(
		scope: PromptDashboardScope,
		widget: PromptDashboardWidgetKind,
		prompt?: Prompt,
	): PromptDashboardWidgetSnapshot<unknown> {
		const baseSnapshot = widget === 'projects'
			? this.buildProjectsWidgetFromCache(scope)
			: this.buildWidgetFromCache(scope, widget, this.placeholderForWidget(widget, prompt));
		return createPromptDashboardWidgetSnapshot(widget, baseSnapshot.data, {
			...baseSnapshot.cache,
			status: 'loading',
			source: 'refresh',
			updatedAt: new Date().toISOString(),
			error: undefined,
		});
	}

	private async loadWidgetData(
		scope: PromptDashboardScope,
		widget: PromptDashboardWidgetKind,
		prompt?: Prompt,
		projectsMode: PromptDashboardProjectsRefreshMode = 'display',
	): Promise<unknown> {
		switch (widget) {
			case 'activity': return this.loadActivityData();
			case 'status': return this.loadStatusData(scope, prompt);
			case 'projects': return this.loadProjectsData(scope, projectsMode);
			case 'aiAnalysis': return this.getCachedData<PromptDashboardAnalysisState | null>(scope, 'aiAnalysis');
			default: return null;
		}
	}

	private placeholderForWidget(widget: PromptDashboardWidgetKind, prompt?: Prompt): unknown {
		switch (widget) {
			case 'activity': return this.emptyActivity();
			case 'status': return prompt ? this.statusFromPrompt(prompt) : this.emptyStatus();
			case 'projects': return { projects: [] };
			case 'aiAnalysis': return null;
			default: return null;
		}
	}

	private emptyActivity(): PromptDashboardPromptActivityData {
		return {
			thresholdMs: PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS,
			today: [],
			yesterday: [],
			yesterdayLabel: 'Вчера',
		};
	}

	private emptyStatus(): PromptDashboardStatusData {
		return { status: 'draft', progress: 10, totalTimeMs: 0, updatedAt: new Date().toISOString() };
	}

	private statusFromPrompt(prompt: Prompt): PromptDashboardStatusData {
		const progress = getPromptDashboardStatusProgress(prompt.status, prompt.progress);
		return {
			status: prompt.status,
			progress,
			totalTimeMs: this.getPromptTotalTime(prompt),
			updatedAt: prompt.updatedAt || new Date().toISOString(),
		};
	}

	private async loadStatusData(scope: PromptDashboardScope, prompt?: Prompt): Promise<PromptDashboardStatusData> {
		if (!prompt) {
			return this.emptyStatus();
		}
		const progressFromAgent = scope.promptId && scope.promptId !== '__new__'
			? await this.storageService.readAgentProgress(scope.promptId)
			: undefined;
		return {
			status: prompt.status,
			progress: getPromptDashboardStatusProgress(prompt.status, progressFromAgent ?? prompt.progress),
			totalTimeMs: this.getPromptTotalTime(prompt),
			updatedAt: prompt.updatedAt || new Date().toISOString(),
		};
	}

	private async loadActivityData(): Promise<PromptDashboardPromptActivityData> {
		const prompts = await this.storageService.listPrompts({ includeArchived: true });
		const today = new Date();
		const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
		const todayKey = today.toISOString().slice(0, 10);
		const yesterdayKey = yesterday.toISOString().slice(0, 10);
		const promptDailyData = await Promise.all(prompts.map(async (prompt) => ({
			prompt,
			dailyData: await this.storageService.getDailyTime(prompt.id),
		})));
		const previousDayKey = this.resolvePreviousActivityDayKey(promptDailyData.map(item => item.dailyData), todayKey, yesterdayKey);
		const items: PromptDashboardPromptActivityItem[] = [];

		for (const { prompt, dailyData } of promptDailyData) {
			for (const [day, key] of [['today', todayKey], ['yesterday', previousDayKey]] as const) {
				if (!key) {
					continue;
				}
				const totalMs = this.storageService.getDailyTimeTotalInRange(dailyData, key, key);
				if (totalMs < PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS) {
					continue;
				}
				items.push({
					id: prompt.id,
					promptUuid: prompt.promptUuid,
					taskNumber: prompt.taskNumber || '',
					title: prompt.title || prompt.id,
					status: prompt.status,
					day,
					totalMs,
					updatedAt: prompt.updatedAt,
					progress: prompt.progress,
				});
			}
		}

		return {
			thresholdMs: PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS,
			yesterdayLabel: this.formatPreviousActivityDayLabel(previousDayKey, yesterdayKey),
			...splitPromptDashboardActivityByDay(items),
		};
	}

	/** Resolves the previous activity day, falling back from yesterday to the latest earlier active day. */
	private resolvePreviousActivityDayKey(
		dailyTimeEntries: Array<Record<string, { writing?: number; implementing?: number; onTask?: number; untracked?: number }>>,
		todayKey: string,
		yesterdayKey: string,
	): string | null {
		const activeDayKeys = new Set<string>();
		for (const dailyData of dailyTimeEntries) {
			for (const [dayKey, entry] of Object.entries(dailyData || {})) {
				if (dayKey >= todayKey) {
					continue;
				}
				const totalMs = (entry.writing || 0) + (entry.implementing || 0) + (entry.onTask || 0) + (entry.untracked || 0);
				if (totalMs >= PROMPT_DASHBOARD_ACTIVITY_THRESHOLD_MS) {
					activeDayKeys.add(dayKey);
				}
			}
		}
		if (activeDayKeys.has(yesterdayKey)) {
			return yesterdayKey;
		}
		return Array.from(activeDayKeys)
			.filter(dayKey => dayKey < yesterdayKey)
			.sort((left, right) => right.localeCompare(left, 'ru'))[0] || null;
	}

	/** Formats the previous activity bucket label shown in the widget header. */
	private formatPreviousActivityDayLabel(previousDayKey: string | null, yesterdayKey: string): string {
		if (!previousDayKey || previousDayKey === yesterdayKey) {
			return 'Вчера';
		}
		return `${previousDayKey.slice(8, 10)}.${previousDayKey.slice(5, 7)}`;
	}

	private async loadProjectsData(
		scope: PromptDashboardScope,
		mode: PromptDashboardProjectsRefreshMode = 'display',
	): Promise<PromptDashboardProjectsData> {
		const paths = this.workspaceService.getWorkspaceFolderPaths();
		const projectNames = resolveEffectiveProjectNames(scope.projectNames, Array.from(paths.keys()));
		const trackedBranches = this.resolveTrackedBranches(scope, projectNames);
		const lightReactiveRefresh = mode === 'reactive-branches';
		const includeExpandedDetails = mode === 'analysis' || mode === 'details';
		const includePipeline = mode === 'analysis';
		const cachedProjectsByName = new Map(
			this.getProjectsDataForScope(scope).projects.map(project => [project.project, project] as const),
		);
		this.ensureScopeActive(scope);
		const snapshot = await this.gitService.getGitOverlaySnapshot(
			paths,
			projectNames,
			scope.promptBranch,
			trackedBranches,
			{
				detailLevel: 'full',
				// Dashboard widgets only need dirty/conflict membership, not per-file diff enrichment.
				includeChangeDetails: false,
				includeBranchDetails: true,
				includeReviewState: !lightReactiveRefresh,
				includeRecentCommits: !lightReactiveRefresh,
				recentCommitsLimit: 2,
			},
		);
		this.ensureScopeActive(scope);

		const projects = await this.mapLimited(snapshot.projects, PromptDashboardService.PROJECT_CONCURRENCY, async (project) => {
			this.ensureScopeActive(scope);
			const trackedBranch = this.resolveTrackedBranchForProject(scope, project.project, snapshot.trackedBranches);
			const cachedProject = cachedProjectsByName.get(project.project);
			if (lightReactiveRefresh) {
				return this.buildReactiveProjectSummary(scope, project, snapshot.trackedBranches, cachedProject);
			}
			const canReuseCachedDetails = this.canReuseProjectDetails(project, trackedBranch, cachedProject);
			const branchForRemote = project.currentBranch || project.promptBranch || scope.promptBranch;
			// Keep pipeline CLI work off the normal dashboard-open path because only AI review consumes it.
			const pipeline = includePipeline && branchForRemote
				? await this.gitService.getGitOverlayProjectPipelineStatus(paths, project.project, branchForRemote).catch(() => null)
				: null;
			this.ensureScopeActive(scope);
			const recentCommits = includeExpandedDetails
				? await this.loadDetailedRecentCommits(project)
				: canReuseCachedDetails
					? cachedProject?.recentCommits || []
					: this.buildDisplayRecentCommits(project);
			this.ensureScopeActive(scope);
			const parallelBranches = includeExpandedDetails
				? (await this.gitService.getGitOverlayParallelBranchSummaries(
					paths,
					project.project,
					scope.promptBranch || trackedBranch || project.currentBranch,
					trackedBranches,
					PromptDashboardService.PARALLEL_BRANCH_LIMIT,
				).catch(() => [])).map(branch => ({ ...branch, detailsHydrated: true }))
				: canReuseCachedDetails
					? cachedProject?.parallelBranches || []
					: this.buildDisplayParallelBranches(scope, project, trackedBranch);
			this.ensureScopeActive(scope);
			const conflictFiles = flattenPromptDashboardChangeFiles([project.changeGroups.merge]);
			return {
				project: project.project,
				repositoryPath: project.repositoryPath,
				available: project.available,
				error: project.error,
				currentBranch: project.currentBranch,
				promptBranch: project.promptBranch,
				trackedBranch,
				dirty: project.dirty,
				hasConflicts: project.hasConflicts,
				ahead: project.ahead,
				behind: project.behind,
				branches: project.branches,
				branchActions: buildPromptDashboardBranchActions({
					promptBranch: project.promptBranch,
					trackedBranch,
					branches: project.branches,
				}),
				recentCommits,
				review: project.review,
				pipeline,
				parallelBranches,
				conflictFiles,
			} satisfies PromptDashboardProjectSummary;
		});
		this.ensureScopeActive(scope);

		return { projects };
	}

	/** Reuses already hydrated project details only while the branch context is unchanged. */
	private canReuseProjectDetails(
		project: GitOverlayProjectSnapshot,
		trackedBranch: string,
		cachedProject?: PromptDashboardProjectSummary,
	): boolean {
		if (!cachedProject || !project.available || Boolean(project.error)) {
			return false;
		}

		return cachedProject.currentBranch === project.currentBranch
			&& cachedProject.promptBranch === project.promptBranch
			&& cachedProject.trackedBranch === trackedBranch
			&& this.hasHydratedProjectDetails(cachedProject);
	}

	/** Detects whether the cached commit and branch details are already fully hydrated. */
	private hasHydratedProjectDetails(project: PromptDashboardProjectSummary): boolean {
		return project.recentCommits.every(commit => commit.changedFilesHydrated !== false)
			&& project.parallelBranches.every(branch => branch.detailsHydrated !== false);
	}

	/** Builds lightweight recent-commit summaries for the first dashboard paint. */
	private buildDisplayRecentCommits(project: GitOverlayProjectSnapshot): PromptDashboardProjectSummary['recentCommits'] {
		return (project.recentCommits || [])
			.slice(0, PromptDashboardService.RECENT_COMMIT_LIMIT)
			.map(commit => ({
				...commit,
				changedFiles: [],
				changedFilesHydrated: false,
			}));
	}

	/** Loads full commit file details only for manual refreshes or explicit hydration requests. */
	private async loadDetailedRecentCommits(project: GitOverlayProjectSnapshot): Promise<PromptDashboardProjectSummary['recentCommits']> {
		const recentCommits = [] as PromptDashboardProjectSummary['recentCommits'];
		for (const commit of (project.recentCommits || []).slice(0, PromptDashboardService.RECENT_COMMIT_LIMIT)) {
			recentCommits.push({
				...commit,
				changedFiles: await this.gitService.getCommitChangedFiles(project.repositoryPath, commit.sha).catch(() => []),
				changedFilesHydrated: true,
			});
		}
		return recentCommits;
	}

	/** Builds lightweight parallel-branch rows from the fast branch snapshot without diff hydration. */
	private buildDisplayParallelBranches(
		scope: PromptDashboardScope,
		project: GitOverlayProjectSnapshot,
		trackedBranch: string,
	): PromptDashboardProjectSummary['parallelBranches'] {
		const baseBranch = scope.promptBranch || trackedBranch || project.currentBranch;
		return [...(project.cleanupBranches || [])]
			.sort((left, right) => {
				if ((right.ahead || 0) !== (left.ahead || 0)) {
					return (right.ahead || 0) - (left.ahead || 0);
				}
				const committedAtSort = String(right.lastCommit?.committedAt || '').localeCompare(String(left.lastCommit?.committedAt || ''));
				if (committedAtSort !== 0) {
					return committedAtSort;
				}
				return left.name.localeCompare(right.name, 'ru', { sensitivity: 'base' });
			})
			.slice(0, PromptDashboardService.PARALLEL_BRANCH_LIMIT)
			.map(branch => ({
				name: branch.name,
				baseBranch,
				ahead: branch.ahead,
				behind: branch.behind,
				lastCommit: branch.lastCommit,
				affectedFiles: [],
				potentialConflicts: [],
				detailsHydrated: false,
			}));
	}

	/** Keeps expensive sections cached during lightweight git-reactive branch refreshes. */
	private buildReactiveProjectSummary(
		scope: PromptDashboardScope,
		project: GitOverlayProjectSnapshot,
		snapshotTrackedBranches: string[],
		cachedProject?: PromptDashboardProjectSummary,
	): PromptDashboardProjectSummary {
		const trackedBranch = this.resolveTrackedBranchForProject(scope, project.project, snapshotTrackedBranches);
		const reusableCachedProject = cachedProject && project.available && !project.error
			? cachedProject
			: null;
		const canReuseHeavySections = reusableCachedProject !== null
			&& reusableCachedProject.currentBranch === project.currentBranch
			&& reusableCachedProject.promptBranch === project.promptBranch
			&& reusableCachedProject.trackedBranch === trackedBranch;
		const conflictFiles = flattenPromptDashboardChangeFiles([project.changeGroups.merge]);
		return {
			project: project.project,
			repositoryPath: project.repositoryPath,
			available: project.available,
			error: project.error,
			currentBranch: project.currentBranch,
			promptBranch: project.promptBranch,
			trackedBranch,
			dirty: project.dirty,
			hasConflicts: project.hasConflicts,
			ahead: project.ahead,
			behind: project.behind,
			branches: project.branches,
			branchActions: buildPromptDashboardBranchActions({
				promptBranch: project.promptBranch,
				trackedBranch,
				branches: project.branches,
			}),
			recentCommits: canReuseHeavySections ? (reusableCachedProject?.recentCommits || []) : [],
			review: canReuseHeavySections && reusableCachedProject ? reusableCachedProject.review : project.review,
			pipeline: canReuseHeavySections && reusableCachedProject ? reusableCachedProject.pipeline : null,
			parallelBranches: canReuseHeavySections ? (reusableCachedProject?.parallelBranches || []) : [],
			conflictFiles,
		};
	}

	private resolveTrackedBranches(scope: PromptDashboardScope, projectNames: string[]): string[] {
		const configured = this.getAllowedBranches();
		const selected = [
			scope.trackedBranch,
			...projectNames.map(project => scope.trackedBranchesByProject[project] || ''),
		].map(branch => branch.trim()).filter(Boolean);
		return Array.from(new Set([...selected, ...configured]));
	}

	private resolveTrackedBranchForProject(scope: PromptDashboardScope, projectName: string, snapshotTrackedBranches: string[]): string {
		return (scope.trackedBranchesByProject[projectName] || scope.trackedBranch || snapshotTrackedBranches[0] || '').trim();
	}

	private resolveTrackedBranchForSwitch(prompt: Prompt, projectName: string): string {
		return String(prompt.trackedBranchesByProject?.[projectName] || prompt.trackedBranch || '').trim();
	}

	private getAllowedBranches(): string[] {
		const configured = vscode.workspace
			.getConfiguration('promptManager')
			.get<string[]>('allowedBranches', []);
		const normalized = (Array.isArray(configured) ? configured : [])
			.map(branch => branch.trim())
			.filter(Boolean);
		return normalized.length > 0 ? normalized : ['master', 'main', 'prod', 'develop', 'dev'];
	}

	private getPromptTotalTime(prompt: PromptConfig): number {
		return Math.max(0,
			(prompt.timeSpentWriting || 0)
			+ (prompt.timeSpentImplementing || 0)
			+ (prompt.timeSpentOnTask || 0)
			+ (prompt.timeSpentUntracked || 0),
		);
	}

	private summarizeAnalysisProjects(projects: PromptDashboardProjectSummary[]): Record<string, number> {
		return {
			projectCount: projects.length,
			availableProjectCount: projects.filter(project => project.available && !project.error).length,
			pipelineProjectCount: projects.filter(project => Boolean(project.pipeline)).length,
			recentCommitCount: projects.reduce((total, project) => total + project.recentCommits.length, 0),
			parallelBranchCount: projects.reduce((total, project) => total + project.parallelBranches.length, 0),
			conflictProjectCount: projects.filter(project => project.hasConflicts || project.conflictFiles.length > 0).length,
		};
	}

	private resolvePromptDashboardAnalysisPreviewDelayMs(): number {
		/** Keep the preview delay centralized so tests can override it cheaply. */
		return PromptDashboardService.ANALYSIS_PREVIEW_DELAY_MS;
	}

	private buildPromptDashboardAnalysisPreview(projects: PromptDashboardProjectSummary[]): string {
		/** Summarize the already loaded Git facts while the full AI review is still pending. */
		const availableProjects = projects.filter(project => project.available && !project.error);
		if (availableProjects.length === 0) {
			return '';
		}

		const dirtyProjects = availableProjects.filter(project => project.dirty);
		const conflictProjects = availableProjects.filter(project => project.hasConflicts || project.conflictFiles.length > 0);
		const failedPipelines = availableProjects.filter(project => ['failed', 'cancelled'].includes(String(project.pipeline?.state || '').toLowerCase()));
		const runningPipelines = availableProjects.filter(project => ['running', 'pending'].includes(String(project.pipeline?.state || '').toLowerCase()));
		const unavailableReviewProjects = availableProjects.filter(project => Boolean(project.review.unsupportedReason || project.review.error));
		const parallelProjects = availableProjects.filter(project => project.parallelBranches.length > 0);

		const summaryLines = [
			'### Что происходит',
			`- Быстрый локальный вывод уже готов по ${availableProjects.length} проектам. Полный AI review ещё уточняется.`,
			dirtyProjects.length > 0
				? `- Локальные изменения есть в: ${this.formatPromptDashboardProjectList(dirtyProjects)}.`
				: '- Незакоммиченных изменений по выбранным проектам не видно.',
			'### На что обратить внимание',
			conflictProjects.length > 0
				? `- Есть конфликты или конфликтующие файлы в: ${this.formatPromptDashboardProjectList(conflictProjects)}.`
				: failedPipelines.length > 0
					? `- Упали или были отменены проверки в: ${this.formatPromptDashboardProjectList(failedPipelines)}.`
					: runningPipelines.length > 0
						? `- Проверки ещё выполняются в: ${this.formatPromptDashboardProjectList(runningPipelines)}.`
						: '- По текущим Git-данным критичных блокеров пока не видно.',
			unavailableReviewProjects.length > 0
				? `- MR/PR-статус автоматически не определился для: ${this.formatPromptDashboardProjectList(unavailableReviewProjects)}.`
				: '',
			parallelProjects.length > 0
				? `- Параллельные ветки найдены в: ${this.formatPromptDashboardProjectList(parallelProjects)}.`
				: '',
			'### Что сделать дальше',
			conflictProjects.length > 0
				? `- Сначала проверьте конфликтующие изменения в ${this.formatPromptDashboardProjectList(conflictProjects, 2)}.`
				: dirtyProjects.length > 0
					? `- Просмотрите локальные изменения в ${this.formatPromptDashboardProjectList(dirtyProjects, 2)} перед merge или публикацией.`
					: '- Можно продолжать по текущим веткам и ориентироваться на Git-виджеты.',
			runningPipelines.length > 0
				? `- Дождитесь завершения проверок для ${this.formatPromptDashboardProjectList(runningPipelines, 2)}.`
				: failedPipelines.length > 0
					? `- Откройте Pipelines и проверьте причину падения для ${this.formatPromptDashboardProjectList(failedPipelines, 2)}.`
					: '- Финальный AI review заменит этот быстрый вывод, когда модель ответит.',
		].filter(Boolean);

		return summaryLines.join('\n');
	}

	private formatPromptDashboardProjectList(projects: PromptDashboardProjectSummary[], maxItems: number = 3): string {
		/** Keep preview sentences compact when a scope contains many repositories. */
		const names = projects
			.map(project => project.project.trim())
			.filter(Boolean);
		const visibleNames = names.slice(0, maxItems);
		const remaining = Math.max(0, names.length - visibleNames.length);
		if (visibleNames.length === 0) {
			return 'выбранных проектах';
		}
		return remaining > 0 ? `${visibleNames.join(', ')} и ещё ${remaining}` : visibleNames.join(', ');
	}

	private postWidget<TData>(
		postMessage: DashboardPostMessage | undefined,
		scope: PromptDashboardScope,
		widget: PromptDashboardWidgetSnapshot<TData>,
		requestId?: string,
	): void {
		postMessage?.({
			type: 'promptDashboardWidgetSnapshot',
			promptId: scope.promptId,
			promptUuid: scope.promptUuid,
			widget,
			requestId,
		});
	}

	private postAnalysis(
		postMessage: DashboardPostMessage | undefined,
		prompt: Prompt,
		analysis: PromptDashboardAnalysisState,
		requestId?: string,
	): void {
		postMessage?.({
			type: 'promptDashboardAnalysis',
			promptId: prompt.id,
			promptUuid: prompt.promptUuid,
			analysis,
			requestId,
		});
	}

	private async mapLimited<TInput, TOutput>(
		items: TInput[],
		limit: number,
		mapper: (item: TInput, index: number) => Promise<TOutput>,
	): Promise<TOutput[]> {
		const output: TOutput[] = new Array(items.length);
		let nextIndex = 0;
		const workerCount = Math.min(Math.max(1, limit), items.length || 1);
		const workers = Array.from({ length: workerCount }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex;
				nextIndex++;
				output[index] = await mapper(items[index], index);
			}
		});
		await Promise.all(workers);
		return output;
	}
}
