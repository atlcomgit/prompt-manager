import * as vscode from 'vscode';
import type { AiService } from './aiService.js';
import type { GitService } from './gitService.js';
import type { StorageService } from './storageService.js';
import type { WorkspaceService } from './workspaceService.js';
import type { Prompt, PromptConfig } from '../types/prompt.js';
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
	private static readonly PROJECT_CONCURRENCY = 3;
	private static readonly AUTO_REFRESH_DELAY_MS = 650;

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
		this.scheduleAutoRefresh(scope, postMessage, { force: forceRefresh, requestId, prompt, includeAiAnalysis: true });
		return snapshot;
	}

	async refreshPrompt(prompt: Prompt, postMessage?: DashboardPostMessage, requestId?: string): Promise<PromptDashboardSnapshot> {
		const scope = this.createScope(prompt);
		this.activeScope = scope;
		this.cancelScheduledAutoRefresh('manual-refresh', scope, requestId);
		await this.refreshScope(scope, postMessage, { force: true, requestId, prompt, includeAiAnalysis: true });
		return this.buildSnapshotFromCache(scope, prompt);
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
		await this.refreshWidget(scope, 'projects', postMessage, { force: false, requestId, prompt });
		return this.refreshAnalysis(scope, prompt, postMessage, requestId, true);
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
		const inputFingerprint = buildPromptDashboardAnalysisFingerprint({
			promptTitle: prompt.title,
			promptContent: prompt.content || '',
			promptBranch: scope.promptBranch,
			projects: projectsData.projects,
		});
		const cached = this.getCachedData<PromptDashboardAnalysisState | null>(scope, 'aiAnalysis');
		if (!force && cached?.inputFingerprint === inputFingerprint && cached.status !== 'idle') {
			return cached;
		}

		const sharedCached = this.getSharedAnalysis(inputFingerprint);
		if (!force && sharedCached && sharedCached.status !== 'idle') {
			this.setCache(scope, 'aiAnalysis', sharedCached, sharedCached.status === 'error' ? sharedCached.error : undefined);
			this.postAnalysis(postMessage, prompt, sharedCached, requestId);
			return sharedCached;
		}

		const analysisKey = inputFingerprint;
		const existing = this.analysisInFlight.get(analysisKey);
		if (existing) {
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
				return failed;
			}
		})();
		this.analysisInFlight.set(analysisKey, task);
		try {
			return await task;
		} finally {
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
			status: this.buildWidgetFromCache(scope, 'status', this.statusFromPrompt(prompt)),
			projects,
			aiAnalysis: analysis,
		};
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
		options?: { force?: boolean; requestId?: string; prompt?: Prompt; includeAiAnalysis?: boolean },
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
		options?: { force?: boolean; requestId?: string; prompt?: Prompt; includeAiAnalysis?: boolean },
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
		}
	}

	private async refreshWidget(
		scope: PromptDashboardScope,
		widget: PromptDashboardWidgetKind,
		postMessage?: DashboardPostMessage,
		options?: { force?: boolean; requestId?: string; prompt?: Prompt },
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
		if (!options?.force && cached && Date.now() - cached.updatedAtMs < PromptDashboardService.CACHE_TTL_MS) {
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
				const data = await this.loadWidgetData(scope, widget, options?.prompt);
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

	private async loadWidgetData(scope: PromptDashboardScope, widget: PromptDashboardWidgetKind, prompt?: Prompt): Promise<unknown> {
		switch (widget) {
			case 'activity': return this.loadActivityData();
			case 'status': return this.loadStatusData(scope, prompt);
			case 'projects': return this.loadProjectsData(scope);
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

	private async loadProjectsData(scope: PromptDashboardScope): Promise<PromptDashboardProjectsData> {
		const paths = this.workspaceService.getWorkspaceFolderPaths();
		const projectNames = resolveEffectiveProjectNames(scope.projectNames, Array.from(paths.keys()));
		const trackedBranches = this.resolveTrackedBranches(scope, projectNames);
		this.ensureScopeActive(scope);
		const snapshot = await this.gitService.getGitOverlaySnapshot(
			paths,
			projectNames,
			scope.promptBranch,
			trackedBranches,
			{
				detailLevel: 'full',
				includeChangeDetails: true,
				includeBranchDetails: true,
				includeReviewState: true,
				includeRecentCommits: true,
				recentCommitsLimit: 2,
			},
		);
		this.ensureScopeActive(scope);

		const projects = await this.mapLimited(snapshot.projects, PromptDashboardService.PROJECT_CONCURRENCY, async (project) => {
			this.ensureScopeActive(scope);
			const trackedBranch = this.resolveTrackedBranchForProject(scope, project.project, snapshot.trackedBranches);
			const branchForRemote = project.currentBranch || project.promptBranch || scope.promptBranch;
			const [pipeline, parallelBranches, recentCommits] = await Promise.all([
				this.gitService.getGitOverlayProjectPipelineStatus(paths, project.project, branchForRemote).catch(() => null),
				this.gitService.getGitOverlayParallelBranchSummaries(
					paths,
					project.project,
					scope.promptBranch || trackedBranch || project.currentBranch,
					trackedBranches,
				).catch(() => []),
				Promise.all((project.recentCommits || []).slice(0, 2).map(async (commit) => ({
					...commit,
					changedFiles: await this.gitService.getCommitChangedFiles(project.repositoryPath, commit.sha).catch(() => []),
				}))),
			]);
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
