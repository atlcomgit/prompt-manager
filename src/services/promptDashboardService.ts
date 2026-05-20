import * as vscode from 'vscode';
import type { AiService } from './aiService.js';
import type { GitService } from './gitService.js';
import type { StorageService } from './storageService.js';
import type { WorkspaceService } from './workspaceService.js';
import { getCodeMapSettings } from '../codemap/codeMapConfig.js';
import { shouldIgnoreRealtimeRefreshPath } from '../codemap/codeMapRealtimeRefresh.js';
import type { Prompt, PromptConfig } from '../types/prompt.js';
import type { GitOverlayChangeFile, GitOverlayCommitChangedFile, GitOverlayProjectSnapshot } from '../types/git.js';
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
	buildPromptDashboardActivityFingerprint,
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
import { normalizeGitOverlayOtherProjectsExcludedPaths } from '../utils/gitOverlay.js';
import { appendPromptManagerLog } from '../utils/promptManagerOutput.js';
import { resolveEffectiveProjectNames } from '../utils/projectScope.js';

interface DashboardCacheEntry<TData> {
	data: TData;
	updatedAtMs: number;
	error?: string;
}

/** Stores branch-switch completion details used by the projects widget. */
interface PromptDashboardBranchSwitchResult {
	success: boolean;
	errors: string[];
	projectErrors: Record<string, string>;
}

type PromptDashboardProjectsRefreshMode = 'display' | 'details' | 'dirty-details' | 'analysis' | 'reactive-branches';

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
	/** Stores project-scoped pull errors shown inline in the branches widget. */
	private readonly pullErrorsByScope = new Map<string, Record<string, string>>();
	private readonly branchSwitchErrorsByScope = new Map<string, Record<string, string>>();
	private readonly activityFingerprintByScope = new Map<string, string>();
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
		this.pullErrorsByScope.clear();
		this.branchSwitchErrorsByScope.clear();
		this.activityFingerprintByScope.clear();
	}

	/** Resolve visible projects through the workspace service or the legacy test stub surface. */
	private resolveVisibleProjectNames(
		requestedProjectNames: string[],
		fallbackToWorkspaceWhenSelectionInvalid = true,
	): string[] {
		if (typeof this.workspaceService.resolveEffectiveProjectNames === 'function') {
			return this.workspaceService.resolveEffectiveProjectNames(requestedProjectNames, {
				fallbackToWorkspaceWhenSelectionInvalid,
			});
		}

		return resolveEffectiveProjectNames(
			requestedProjectNames,
			this.workspaceService.getWorkspaceFolders(),
			{ fallbackToWorkspaceWhenSelectionInvalid },
		);
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
		projectNames?: string[],
	): Promise<PromptDashboardWidgetSnapshot<PromptDashboardProjectsData>> {
		const scope = this.createScope(prompt);
		this.activeScope = scope;
		const targetProjects = this.resolveProjectsRefreshTargets(scope, projectNames);
		if ((mode === 'details' || mode === 'dirty-details') && targetProjects.length > 0 && targetProjects.length < scope.projectNames.length) {
			await this.refreshProjectsWidgetSubset(scope, prompt, postMessage, requestId, mode, targetProjects);
			return this.buildProjectsWidgetFromCache(scope);
		}
		await this.refreshWidget(scope, 'projects', postMessage, { force: true, requestId, prompt, projectsMode: mode });
		return this.buildProjectsWidgetFromCache(scope);
	}

	/** Refreshes one visible widget without rebuilding the entire dashboard snapshot. */
	async refreshWidgetSnapshot(
		prompt: Prompt,
		widget: PromptDashboardWidgetKind,
		postMessage?: DashboardPostMessage,
		requestId?: string,
	): Promise<PromptDashboardWidgetSnapshot<unknown>> {
		const scope = this.createScope(prompt);
		this.activeScope = scope;
		this.cancelScheduledAutoRefresh(`manual-widget-refresh:${widget}`, scope, requestId);
		if (widget === 'projects') {
			return this.refreshProjectsWidget(prompt, postMessage, requestId, 'display');
		}
		if (widget === 'aiAnalysis') {
			await this.analyzeParallelReview(prompt, postMessage, requestId);
			return this.buildWidgetFromCache(
				scope,
				'aiAnalysis',
				this.getCachedData<PromptDashboardAnalysisState | null>(scope, 'aiAnalysis'),
			);
		}
		await this.refreshWidget(scope, widget, postMessage, {
			force: true,
			requestId,
			prompt,
		});
		return this.buildWidgetFromCache(scope, widget, this.getCachedData(scope, widget) || this.placeholderForWidget(widget, prompt));
	}

	async switchProjectBranch(prompt: Prompt, project: string, branch: string): Promise<PromptDashboardBranchSwitchResult> {
		return this.switchProjectBranches(prompt, { [project]: branch });
	}

	async pullProject(prompt: Prompt, project: string): Promise<PromptDashboardBranchSwitchResult> {
		const normalizedProject = String(project || '').trim();
		if (!normalizedProject) {
			return { success: false, errors: ['Не выбран проект для получения изменений.'], projectErrors: {} };
		}

		const paths = this.workspaceService.getWorkspaceFolderPaths();
		const result = await this.gitService.syncProjects(paths, [normalizedProject]);
		const scope = this.createScope(prompt);
		const pullResult = this.buildBranchSwitchResult([normalizedProject], result.errors || []);
		this.updateScopedProjectErrors(this.pullErrorsByScope, scope, [normalizedProject], pullResult.projectErrors);
		this.cancelScheduledAutoRefresh('pull-project', scope);
		this.invalidateScope(scope);
		return pullResult;
	}

	async switchProjectBranches(prompt: Prompt, branchesByProject: Record<string, string>): Promise<PromptDashboardBranchSwitchResult> {
		const entries = Object.entries(branchesByProject || {})
			.map(([project, branch]) => [project.trim(), String(branch || '').trim()] as const)
			.filter(([project, branch]) => Boolean(project && branch));
		if (entries.length === 0) {
			return { success: false, errors: ['Не выбраны ветки для переключения.'], projectErrors: {} };
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
		// Route tracked targets through the dedicated no-create Git switch path.
		const trackedEntries = directEntries.filter(([project, branch]) => {
			const trackedBranch = this.resolveTrackedBranchForSwitch(prompt, project);
			return Boolean(trackedBranch) && branch === trackedBranch;
		});
		const promptBranchEntries = entries.filter(([, branch]) => Boolean(promptBranch) && branch === promptBranch);
		const standardEntries = directEntries.filter(([project, branch]) => {
			const trackedBranch = this.resolveTrackedBranchForSwitch(prompt, project);
			return !trackedBranch || branch !== trackedBranch;
		});
		const projectsByBranch = standardEntries.reduce<Record<string, string[]>>((groups, [project, branch]) => {
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
		if (trackedEntries.length > 0) {
			const trackedProjects = trackedEntries.map(([project]) => project);
			const trackedBranchesByProject = Object.fromEntries(trackedEntries);
			const result = await this.gitService.switchBranchesByProject(
				paths,
				trackedProjects,
				'',
				trackedBranchesByProject,
				allowedBranches,
			);
			errors.push(...result.errors);
		}
		for (const [branch, projects] of Object.entries(projectsByBranch)) {
			const result = await this.gitService.switchBranch(paths, projects, branch, allowedBranches);
			errors.push(...result.errors);
		}
		const scope = this.createScope(prompt);
		const branchSwitchResult = this.buildBranchSwitchResult(entries.map(([project]) => project), errors);
		this.updateScopedProjectErrors(
			this.branchSwitchErrorsByScope,
			scope,
			entries.map(([project]) => project),
			branchSwitchResult.projectErrors,
		);
		this.cancelScheduledAutoRefresh('branch-switch', scope);
		this.invalidateScope(scope);
		return branchSwitchResult;
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
		const requestedProjectNames = Array.from(new Set((prompt.projects || [])
			.map(project => project.trim())
			.filter(Boolean)));
		const selectedProjectNames = requestedProjectNames.length > 0
			? this.resolveVisibleProjectNames(requestedProjectNames, false)
			: [];
		const projectNames = this.resolveVisibleProjectNames(requestedProjectNames);
		const trackedBranchesByProject = Object.fromEntries(
			Object.entries(prompt.trackedBranchesByProject || {})
				.map(([project, branch]) => [project.trim(), String(branch || '').trim()] as const)
				.filter(([project, branch]) => Boolean(project && branch && projectNames.includes(project))),
		);
		return {
			promptId: (prompt.id || '__new__').trim() || '__new__',
			promptUuid: (prompt.promptUuid || '').trim(),
			projectNames,
			selectedProjectNames,
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
			const cache = cached.error
				? { ...resolvePromptDashboardCacheState(cached.updatedAtMs, PromptDashboardService.CACHE_TTL_MS), status: 'error' as const, error: cached.error }
				: resolvePromptDashboardCacheState(cached.updatedAtMs, PromptDashboardService.CACHE_TTL_MS);
			return createPromptDashboardWidgetSnapshot('projects', this.decorateProjectsData(scope, cached.data), cache);
		}
		const shared = this.getSharedProjects(scope);
		if (!shared) {
			return createPromptDashboardWidgetSnapshot('projects', { projects: [] });
		}
		const cache = shared.error
			? { ...resolvePromptDashboardCacheState(shared.updatedAtMs, PromptDashboardService.CACHE_TTL_MS), status: 'error' as const, error: shared.error }
			: resolvePromptDashboardCacheState(shared.updatedAtMs, PromptDashboardService.CACHE_TTL_MS);
		return createPromptDashboardWidgetSnapshot('projects', this.decorateProjectsData(scope, shared.data), cache);
	}

	/** Applies scope-local branch-switch errors without polluting the shared projects cache. */
	private decorateProjectsData(
		scope: PromptDashboardScope,
		data: PromptDashboardProjectsData,
	): PromptDashboardProjectsData {
		const scopeKey = buildPromptDashboardScopeKey(scope);
		const branchSwitchErrors = this.branchSwitchErrorsByScope.get(scopeKey);
		const pullErrors = this.pullErrorsByScope.get(scopeKey);
		let changed = false;
		const decorateProjectList = (projects: PromptDashboardProjectSummary[]): PromptDashboardProjectSummary[] => projects.map(project => {
			const branchSwitchError = branchSwitchErrors?.[project.project] || '';
			const pullError = pullErrors?.[project.project] || '';
			if ((project.branchSwitchError || '') === branchSwitchError && (project.pullError || '') === pullError) {
				return project;
			}
			changed = true;
			return {
				...project,
				branchSwitchError,
				pullError,
			};
		});
		const projects = decorateProjectList(data.projects);
		const branchProjects = data.branchProjects
			? decorateProjectList(data.branchProjects)
			: data.branchProjects;
		return changed
			? {
				projects,
				...(branchProjects ? { branchProjects } : {}),
			}
			: data;
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
		const selectedProjects = [...scope.selectedProjectNames].map(item => item.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru')).join('|');
		const trackedByProject = Object.entries(scope.trackedBranchesByProject || {})
			.map(([project, branch]) => `${project.trim()}:${String(branch || '').trim()}`)
			.filter(item => item !== ':')
			.sort((a, b) => a.localeCompare(b, 'ru'))
			.join('|');
		return [projects, selectedProjects, scope.promptBranch.trim(), scope.trackedBranch.trim(), trackedByProject].join('::');
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

	/** Restricts a details refresh to projects that are already visible in the current dashboard scope. */
	private resolveProjectsRefreshTargets(scope: PromptDashboardScope, projectNames?: string[]): string[] {
		const scopeProjects = new Set(scope.projectNames.map(project => project.trim()).filter(Boolean));
		return Array.from(new Set((projectNames || [])
			.map(project => String(project || '').trim())
			.filter(project => scopeProjects.has(project))));
	}

	/** Merges a partial projects refresh back into the full widget snapshot without blanking other rows. */
	private mergeProjectsData(
		currentData: PromptDashboardProjectsData,
		nextData: PromptDashboardProjectsData,
	): PromptDashboardProjectsData {
		if (currentData.projects.length === 0) {
			return nextData;
		}

		const nextProjectsByName = new Map(nextData.projects.map(project => [project.project, project] as const));
		const mergedProjects = currentData.projects.map(project => nextProjectsByName.get(project.project) || project);
		for (const project of nextData.projects) {
			if (!mergedProjects.some(existing => existing.project === project.project)) {
				mergedProjects.push(project);
			}
		}

		return {
			projects: mergedProjects,
			...(nextData.branchProjects !== undefined
				? { branchProjects: nextData.branchProjects }
				: (currentData.branchProjects !== undefined ? { branchProjects: currentData.branchProjects } : {})),
		};
	}

	/** Keeps branch-widget workspace scope stable without widening the other dashboard widgets. */
	private hasSameProjectNameSet(left: string[], right: string[]): boolean {
		if (left.length !== right.length) {
			return false;
		}

		const leftSet = new Set(left.map(project => project.trim()).filter(Boolean));
		return right.every(project => leftSet.has(project.trim()));
	}

	/** Reads the Git Overlay excluded-path prefixes that the branch widget should ignore. */
	private getPromptDashboardExcludedPaths(): string[] {
		return normalizeGitOverlayOtherProjectsExcludedPaths(
			vscode.workspace
				.getConfiguration('promptManager.gitOverlay')
				.get<string[]>('otherProjectsExcludedPaths', []) ?? [],
		);
	}

	/** Refreshes detailed file data only for selected projects instead of refetching every dashboard row. */
	private async refreshProjectsWidgetSubset(
		scope: PromptDashboardScope,
		prompt: Prompt,
		postMessage: DashboardPostMessage | undefined,
		requestId: string | undefined,
		mode: Extract<PromptDashboardProjectsRefreshMode, 'details' | 'dirty-details'>,
		targetProjects: string[],
	): Promise<void> {
		const widgetStartedAtMs = Date.now();
		const cacheKey = buildPromptDashboardWidgetCacheKey(scope, 'projects');
		const scopeKey = buildPromptDashboardScopeKey(scope);
		if (postMessage) {
			this.postWidget(postMessage, scope, this.buildLoadingWidgetSnapshot(scope, 'projects', prompt), requestId);
		}

		while (true) {
			const existing = this.inFlight.get(cacheKey);
			if (!existing) {
				break;
			}
			this.logDashboardPerf('widget.waiting-in-flight', {
				widget: 'projects',
				promptId: scope.promptId,
				requestId: requestId || '',
				partial: true,
				targetProjectCount: targetProjects.length,
			});
			await existing;
		}

		this.ensureScopeActive(scope);
		this.logDashboardPerf('widget.started', {
			widget: 'projects',
			promptId: scope.promptId,
			requestId: requestId || '',
			force: true,
			partial: true,
			targetProjectCount: targetProjects.length,
		});

		const task = (async () => {
			try {
				const partialData = await this.loadProjectsData(scope, mode, targetProjects);
				this.ensureScopeActive(scope);
				const mergedData = this.mergeProjectsData(this.getProjectsDataForScope(scope), partialData);
				this.setCache(scope, 'projects', mergedData);
				const snapshot = this.buildProjectsWidgetFromCache(scope);
				this.postWidget(postMessage, scope, snapshot, requestId);
				this.logDashboardPerf('widget.completed', {
					widget: 'projects',
					promptId: scope.promptId,
					requestId: requestId || '',
					partial: true,
					targetProjectCount: targetProjects.length,
					durationMs: Date.now() - widgetStartedAtMs,
				});
			} catch (error) {
				if (error instanceof PromptDashboardStaleScopeError) {
					this.logDashboardPerf('widget.aborted-stale', {
						widget: 'projects',
						promptId: scope.promptId,
						requestId: requestId || '',
						scopeKey,
						partial: true,
						targetProjectCount: targetProjects.length,
						durationMs: Date.now() - widgetStartedAtMs,
					});
					return;
				}
				const fallback = this.getProjectsDataForScope(scope);
				this.setCache(scope, 'projects', fallback, error instanceof Error ? error.message : String(error));
				const snapshot = this.buildProjectsWidgetFromCache(scope);
				this.postWidget(postMessage, scope, snapshot, requestId);
				this.logDashboardPerf('widget.failed', {
					widget: 'projects',
					promptId: scope.promptId,
					requestId: requestId || '',
					partial: true,
					targetProjectCount: targetProjects.length,
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
		const nextActivityFingerprint = widget === 'activity' && options?.prompt
			? buildPromptDashboardActivityFingerprint(options.prompt)
			: '';
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
			if (
				widget === 'activity'
				&& nextActivityFingerprint
				&& this.activityFingerprintByScope.get(scopeKey) !== nextActivityFingerprint
			) {
				// Refresh the activity widget when the current prompt changed fields that affect activity visibility.
			} else {
				this.logDashboardPerf('widget.skipped-fresh-cache', {
					widget,
					promptId: scope.promptId,
					requestId: options?.requestId || '',
				});
				return;
			}
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
				if (widget === 'activity' && nextActivityFingerprint) {
					this.activityFingerprintByScope.set(scopeKey, nextActivityFingerprint);
				}
				const snapshot = widget === 'projects'
					? this.buildProjectsWidgetFromCache(scope)
					: this.buildWidgetFromCache(scope, widget, data);
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
				const snapshot = widget === 'projects'
					? this.buildProjectsWidgetFromCache(scope)
					: this.buildWidgetFromCache(scope, widget, fallback);
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
			if (prompt.status === 'closed') {
				continue;
			}

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
		projectNamesOverride?: string[],
	): Promise<PromptDashboardProjectsData> {
		const paths = this.workspaceService.getWorkspaceFolderPaths();
		const workspaceProjectNames = Array.from(paths.keys());
		const requestedProjectNames = projectNamesOverride && projectNamesOverride.length > 0
			? projectNamesOverride
			: scope.projectNames;
		const projectNames = projectNamesOverride && projectNamesOverride.length > 0
			? this.resolveVisibleProjectNames(requestedProjectNames, false)
			: scope.projectNames;
		const trackedBranches = this.resolveTrackedBranches(scope, projectNames);
		const excludedPaths = this.getPromptDashboardExcludedPaths();
		const lightReactiveRefresh = mode === 'reactive-branches';
		const dirtyOnlyDetailsRefresh = mode === 'dirty-details';
		// Keep AI follow-up refreshes light and reuse cached trees until explicit details hydration runs.
		const includeExpandedDetails = mode === 'details';
		const includePipeline = mode === 'analysis';
		const cachedProjectsByName = new Map(
			this.getProjectsDataForScope(scope).projects.map(project => [project.project, project] as const),
		);
		const prefetchedReviewStatesByProject = mode === 'analysis'
			? this.buildPrefetchedReviewStatesByProject(cachedProjectsByName)
			: undefined;
		this.ensureScopeActive(scope);
		const snapshot = dirtyOnlyDetailsRefresh
			? {
				trackedBranches,
				projects: (await this.mapLimited(projectNames, PromptDashboardService.PROJECT_CONCURRENCY, async (projectName) => {
					this.ensureScopeActive(scope);
					return this.gitService.getGitOverlayProjectSnapshot(
						paths,
						projectName,
						scope.promptBranch,
						trackedBranches,
						{
							includeChangeDetails: true,
							includeBranchDetails: false,
							includeReviewState: false,
							includeRecentCommits: false,
						},
					);
				})).filter((project): project is NonNullable<typeof project> => Boolean(project)),
			}
			: await this.gitService.getGitOverlaySnapshot(
				paths,
				projectNames,
				scope.promptBranch,
				trackedBranches,
				{
					detailLevel: 'full',
					// Keep the normal projects refresh light; per-file dirty line stats hydrate only on explicit details refresh.
					includeChangeDetails: mode === 'details',
					includeBranchDetails: true,
					includeReviewState: mode !== 'reactive-branches' && mode !== 'details',
					includeRecentCommits: !lightReactiveRefresh,
					recentCommitsLimit: 2,
					prefetchedReviewStatesByProject,
				},
			);
		this.ensureScopeActive(scope);

		const projects = await this.mapLimited(snapshot.projects, PromptDashboardService.PROJECT_CONCURRENCY, async (project) => {
			this.ensureScopeActive(scope);
			const trackedBranch = this.resolveTrackedBranchForProject(scope, project, snapshot.trackedBranches);
			const cachedProject = cachedProjectsByName.get(project.project);
			const incomingSummary = dirtyOnlyDetailsRefresh || includeExpandedDetails
				? {
					incomingFiles: cachedProject?.incomingFiles || [],
					incomingAuthors: cachedProject?.incomingAuthors || [],
				}
				: await this.loadIncomingSummaryForProject(project, cachedProject);
			const { incomingFiles, incomingAuthors } = incomingSummary;
			const parallelBaseBranch = this.resolveParallelBranchBase(scope, project, trackedBranch);
			const displayParallelBranches = await this.resolveDisplayParallelBranches(scope, project, trackedBranch, cachedProject);
			const uncommittedFiles = mode === 'analysis'
				? this.mergeCachedUncommittedFileDetails(
					project,
					trackedBranch,
					this.collectProjectUncommittedFiles(project, excludedPaths),
					cachedProject,
				)
				: this.collectProjectUncommittedFiles(project, excludedPaths);
			if (lightReactiveRefresh) {
				return this.buildReactiveProjectSummary(
					scope,
					project,
					snapshot.trackedBranches,
					cachedProject,
					excludedPaths,
					incomingFiles,
					incomingAuthors,
				);
			}
			if (dirtyOnlyDetailsRefresh) {
				return this.buildDirtyDetailsProjectSummary(scope, project, trackedBranch, uncommittedFiles, cachedProject);
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
					: await this.buildDisplayRecentCommits(scope, project);
			this.ensureScopeActive(scope);
			const parallelBranches = includeExpandedDetails
				? this.mergeParallelBranchDetails(
					displayParallelBranches,
					(await this.gitService.getGitOverlayParallelBranchSummaries(
						paths,
						project.project,
						parallelBaseBranch,
						trackedBranches,
						PromptDashboardService.PARALLEL_BRANCH_LIMIT,
						displayParallelBranches.map(branch => branch.ref || branch.name),
					).catch(() => [])).map(branch => ({ ...branch, detailsHydrated: true })),
				)
				: displayParallelBranches;
			this.ensureScopeActive(scope);
			const conflictFiles = flattenPromptDashboardChangeFiles([project.changeGroups.merge]);
			const hasPromptBranchMismatch = this.hasPromptBranchMismatch(scope, project);
			return {
				project: project.project,
				repositoryPath: project.repositoryPath,
				available: project.available,
				error: project.error,
				branchSwitchError: '',
				pullError: '',
				hasPromptBranchMismatch,
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
				incomingFiles,
				incomingAuthors,
				uncommittedFiles,
			} satisfies PromptDashboardProjectSummary;
		});
		this.ensureScopeActive(scope);

		const branchProjects = projectNamesOverride && projectNamesOverride.length > 0
			? undefined
			: (this.hasSameProjectNameSet(projectNames, workspaceProjectNames)
				? projects
				: await this.loadBranchWidgetProjectsData(scope, paths, workspaceProjectNames, excludedPaths));

		return branchProjects !== undefined
			? { projects, branchProjects }
			: { projects };
	}

	/** Loads lightweight branch-widget rows for every workspace project without widening the rest of the dashboard. */
	private async loadBranchWidgetProjectsData(
		scope: PromptDashboardScope,
		paths: Map<string, string>,
		projectNames: string[],
		excludedPaths: string[],
	): Promise<PromptDashboardProjectSummary[]> {
		if (projectNames.length === 0) {
			return [];
		}

		const trackedBranches = this.resolveTrackedBranches(scope, projectNames);
		const snapshot = await this.gitService.getGitOverlaySnapshot(
			paths,
			projectNames,
			scope.promptBranch,
			trackedBranches,
			{
				detailLevel: 'full',
				includeChangeDetails: true,
				includeBranchDetails: true,
				includeReviewState: false,
				includeRecentCommits: false,
			},
		);
		this.ensureScopeActive(scope);

		return this.mapLimited(snapshot.projects, PromptDashboardService.PROJECT_CONCURRENCY, async (project) => {
			const trackedBranch = this.resolveTrackedBranchForProject(scope, project, snapshot.trackedBranches);
			const conflictFiles = flattenPromptDashboardChangeFiles([project.changeGroups.merge]);
			const { incomingFiles, incomingAuthors } = await this.loadIncomingSummaryForProject(project);
			const hasPromptBranchMismatch = this.hasPromptBranchMismatch(scope, project);
			return {
				project: project.project,
				repositoryPath: project.repositoryPath,
				available: project.available,
				error: project.error,
				branchSwitchError: '',
				pullError: '',
				hasPromptBranchMismatch,
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
				recentCommits: [],
				review: project.review,
				pipeline: null,
				parallelBranches: [],
				conflictFiles,
				incomingFiles,
				incomingAuthors,
				uncommittedFiles: this.collectProjectUncommittedFiles(project, excludedPaths),
			} satisfies PromptDashboardProjectSummary;
		});
	}

	/** Refresh only dirty-file counters for an expanded project row and preserve other cached widget sections. */
	private buildDirtyDetailsProjectSummary(
		scope: PromptDashboardScope,
		project: GitOverlayProjectSnapshot,
		trackedBranch: string,
		uncommittedFiles: GitOverlayChangeFile[],
		cachedProject?: PromptDashboardProjectSummary,
	): PromptDashboardProjectSummary {
		const conflictFiles = flattenPromptDashboardChangeFiles([project.changeGroups.merge]);
		const hasPromptBranchMismatch = this.hasPromptBranchMismatch(scope, project);
		const preservedRecentCommits = cachedProject ? cachedProject.recentCommits : this.buildPlaceholderRecentCommits(project);
		const preservedReview = cachedProject ? cachedProject.review : project.review;
		const preservedPipeline = cachedProject ? cachedProject.pipeline : null;
		const preservedIncomingFiles = cachedProject ? cachedProject.incomingFiles : [];
		const preservedIncomingAuthors = cachedProject ? (cachedProject.incomingAuthors || []) : [];
		const preservedParallelBranches = cachedProject
			? cachedProject.parallelBranches
			: this.buildPlaceholderParallelBranches(scope, project, trackedBranch);
		if (!cachedProject || !this.hasSameProjectBranchContext(project, trackedBranch, cachedProject)) {
			return {
				project: project.project,
				repositoryPath: project.repositoryPath,
				available: project.available,
				error: project.error,
				branchSwitchError: '',
				pullError: '',
				hasPromptBranchMismatch,
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
				recentCommits: preservedRecentCommits,
				review: preservedReview,
				pipeline: preservedPipeline,
				parallelBranches: preservedParallelBranches,
				conflictFiles,
				incomingFiles: preservedIncomingFiles,
				incomingAuthors: preservedIncomingAuthors,
				uncommittedFiles,
			};
		}

		return {
			...cachedProject,
			available: project.available,
			error: project.error,
			hasPromptBranchMismatch,
			currentBranch: project.currentBranch || cachedProject.currentBranch,
			promptBranch: project.promptBranch || cachedProject.promptBranch,
			trackedBranch,
			dirty: project.dirty,
			hasConflicts: project.hasConflicts,
			conflictFiles,
			incomingFiles: cachedProject.incomingFiles,
			incomingAuthors: cachedProject.incomingAuthors,
			uncommittedFiles,
		};
	}

	/** Loads incoming upstream files and unique authors only for pull-eligible current branch rows. */
	private async loadIncomingSummaryForProject(
		project: Pick<GitOverlayProjectSnapshot, 'repositoryPath' | 'currentBranch' | 'behind' | 'branches'>,
		cachedProject?: PromptDashboardProjectSummary,
	): Promise<{ incomingFiles: GitOverlayCommitChangedFile[]; incomingAuthors: string[] }> {
		const currentBranch = String(project.currentBranch || '').trim();
		const currentBranchInfo = (project.branches || []).find(branch => branch.current || branch.name === currentBranch);
		if (!currentBranch || project.behind <= 0 || !currentBranchInfo?.upstream || currentBranchInfo.stale) {
			return { incomingFiles: [], incomingAuthors: [] };
		}

		try {
			const [incomingFiles, incomingAuthors] = await Promise.all([
				this.gitService.getIncomingBranchChangedFiles(project.repositoryPath),
				this.gitService.getIncomingBranchAuthors(project.repositoryPath),
			]);
			return { incomingFiles, incomingAuthors };
		} catch {
			return cachedProject?.currentBranch === currentBranch
				? {
					incomingFiles: cachedProject.incomingFiles,
					incomingAuthors: cachedProject.incomingAuthors || [],
				}
				: { incomingFiles: [], incomingAuthors: [] };
		}
	}

	/** Reuse fully resolved review states during the immediate follow-up analysis pass. */
	private buildPrefetchedReviewStatesByProject(
		cachedProjectsByName: Map<string, PromptDashboardProjectSummary>,
	): Record<string, PromptDashboardProjectSummary['review']> | undefined {
		const prefetchedReviewStatesByProject = Object.fromEntries(
			Array.from(cachedProjectsByName.entries())
				.filter(([, project]) => Boolean(
					project.review.remote
					|| project.review.request
					|| project.review.error
					|| project.review.setupAction
					|| project.review.unsupportedReason,
				))
				.map(([projectName, project]) => [projectName, project.review]),
		);

		return Object.keys(prefetchedReviewStatesByProject).length > 0
			? prefetchedReviewStatesByProject
			: undefined;
	}

	/** Reuses already hydrated project details only while the branch context is unchanged. */
	private canReuseProjectDetails(
		project: GitOverlayProjectSnapshot,
		trackedBranch: string,
		cachedProject?: PromptDashboardProjectSummary,
	): boolean {
		if (!this.hasSameProjectBranchContext(project, trackedBranch, cachedProject)) {
			return false;
		}

		return this.hasHydratedProjectDetails(cachedProject);
	}

	/** Reuse dirty-file stats during the background AI refresh so expanded counters do not disappear again. */
	private mergeCachedUncommittedFileDetails(
		project: GitOverlayProjectSnapshot,
		trackedBranch: string,
		nextFiles: GitOverlayChangeFile[],
		cachedProject?: PromptDashboardProjectSummary,
	): GitOverlayChangeFile[] {
		if (!this.hasSameProjectBranchContext(project, trackedBranch, cachedProject) || !cachedProject) {
			return nextFiles;
		}

		const cachedFilesByKey = new Map(
			cachedProject.uncommittedFiles
				.filter(file => this.hasDetailedUncommittedFileData(file))
				.map(file => [this.buildUncommittedFileCacheKey(file), file] as const),
		);
		if (cachedFilesByKey.size === 0) {
			return nextFiles;
		}

		return nextFiles.map(file => {
			const cachedFile = cachedFilesByKey.get(this.buildUncommittedFileCacheKey(file));
			if (!cachedFile) {
				return file;
			}

			return {
				...file,
				fileSizeBytes: cachedFile.fileSizeBytes,
				additions: cachedFile.additions,
				deletions: cachedFile.deletions,
				isBinary: cachedFile.isBinary,
			};
		});
	}

	/** Detect whether a cached dirty-file row already carries resolved numstat or binary metadata. */
	private hasDetailedUncommittedFileData(
		file: Pick<GitOverlayChangeFile, 'fileSizeBytes' | 'additions' | 'deletions' | 'isBinary'>,
	): boolean {
		return file.fileSizeBytes > 0
			|| typeof file.additions === 'number'
			|| typeof file.deletions === 'number'
			|| file.isBinary === true;
	}

	/** Build a stable dirty-file cache key without relying on transient per-refresh ordering. */
	private buildUncommittedFileCacheKey(
		file: Pick<GitOverlayChangeFile, 'group' | 'status' | 'path' | 'previousPath' | 'conflicted' | 'staged'>,
	): string {
		return [
			file.group,
			file.status,
			file.path,
			file.previousPath || '',
			file.conflicted ? '1' : '0',
			file.staged ? '1' : '0',
		].join(':');
	}

	/** Guard cache reuse so project-scoped details survive only while the branch context stays unchanged. */
	private hasSameProjectBranchContext(
		project: GitOverlayProjectSnapshot,
		trackedBranch: string,
		cachedProject?: PromptDashboardProjectSummary,
	): cachedProject is PromptDashboardProjectSummary {
		if (!cachedProject || !project.available || Boolean(project.error)) {
			return false;
		}

		return cachedProject.currentBranch === project.currentBranch
			&& cachedProject.promptBranch === project.promptBranch
			&& cachedProject.trackedBranch === trackedBranch;
	}

	/** Detects whether the cached commit and branch details are already fully hydrated. */
	private hasHydratedProjectDetails(project: PromptDashboardProjectSummary): boolean {
		return project.recentCommits.every(commit => commit.changedFilesHydrated !== false)
			&& project.parallelBranches.every(branch => branch.detailsHydrated !== false);
	}

	/** Builds placeholder recent-commit summaries for the first dashboard paint. */
	private buildPlaceholderRecentCommits(project: GitOverlayProjectSnapshot): PromptDashboardProjectSummary['recentCommits'] {
		return (project.recentCommits || [])
			.slice(0, PromptDashboardService.RECENT_COMMIT_LIMIT)
			.map(commit => ({
				...commit,
				changedFiles: [],
				changedFilesHydrated: false,
			}));
	}

	/** Adds lightweight changed-file counts to visible commit rows without hydrating file details. */
	private async buildDisplayRecentCommits(
		scope: PromptDashboardScope,
		project: GitOverlayProjectSnapshot,
	): Promise<PromptDashboardProjectSummary['recentCommits']> {
		const visibleCommits = this.buildPlaceholderRecentCommits(project);
		if (visibleCommits.length === 0 || !project.available || Boolean(project.error) || !project.repositoryPath) {
			return visibleCommits;
		}

		const getChangedFileCount = this.gitService.getCommitChangedFileCount;
		if (typeof getChangedFileCount !== 'function') {
			return visibleCommits;
		}

		const countEntries = await Promise.all(visibleCommits.map(async (commit) => ([
			commit.sha,
			await getChangedFileCount.call(this.gitService, project.repositoryPath, commit.sha),
		] as const)));
		this.ensureScopeActive(scope);

		const countByCommit = new Map(countEntries);
		return visibleCommits.map((commit) => {
			const changedFileCount = countByCommit.get(commit.sha);
			return changedFileCount === null || changedFileCount === undefined
				? commit
				: { ...commit, changedFileCount };
		});
	}

	/** Loads full commit file details only for manual refreshes or explicit hydration requests. */
	private async loadDetailedRecentCommits(project: GitOverlayProjectSnapshot): Promise<PromptDashboardProjectSummary['recentCommits']> {
		const recentCommits = [] as PromptDashboardProjectSummary['recentCommits'];
		for (const commit of (project.recentCommits || []).slice(0, PromptDashboardService.RECENT_COMMIT_LIMIT)) {
			const changedFiles = await this.gitService.getCommitChangedFiles(project.repositoryPath, commit.sha).catch(() => []);
			recentCommits.push({
				...commit,
				changedFiles,
				changedFileCount: changedFiles.length,
				changedFilesHydrated: true,
			});
		}
		return recentCommits;
	}

	/** Builds placeholder parallel-branch rows from the fast branch snapshot without diff hydration. */
	private buildPlaceholderParallelBranches(
		scope: PromptDashboardScope,
		project: GitOverlayProjectSnapshot,
		trackedBranch: string,
	): PromptDashboardProjectSummary['parallelBranches'] {
		const baseBranch = this.resolveParallelBranchBase(scope, project, trackedBranch);
		const candidateBranches = project.parallelBranchCandidates?.length
			? project.parallelBranchCandidates
			: (project.cleanupBranches || []).map(branch => ({
				name: branch.name,
				ref: branch.name,
				kind: 'local' as const,
				ahead: branch.ahead,
				behind: branch.behind,
				lastCommit: branch.lastCommit,
			}));
		return [...candidateBranches]
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
				ref: branch.ref,
				kind: branch.kind,
				baseBranch,
				ahead: branch.ahead,
				behind: branch.behind,
				lastCommit: branch.lastCommit,
				affectedFiles: [],
				potentialConflicts: [],
				detailsHydrated: false,
			}));
	}

	/** Adds lightweight file counts to visible placeholder rows without hydrating the file list. */
	private async buildDisplayParallelBranches(
		scope: PromptDashboardScope,
		project: GitOverlayProjectSnapshot,
		trackedBranch: string,
	): Promise<PromptDashboardProjectSummary['parallelBranches']> {
		const visibleBranches = this.buildPlaceholderParallelBranches(scope, project, trackedBranch);
		if (visibleBranches.length === 0 || !project.available || Boolean(project.error) || !project.repositoryPath) {
			return visibleBranches;
		}

		const baseBranch = visibleBranches[0]?.baseBranch || this.resolveParallelBranchBase(scope, project, trackedBranch);
		if (!baseBranch) {
			return visibleBranches;
		}

		const getAffectedFileCount = this.gitService.getGitOverlayParallelBranchAffectedFileCount;
		const getRevisionCounts = this.gitService.getGitOverlayParallelBranchRevisionCounts;
		if (typeof getAffectedFileCount !== 'function' && typeof getRevisionCounts !== 'function') {
			return visibleBranches;
		}

		const metricEntries = await Promise.all(visibleBranches.map(async (branch) => {
			const branchRef = branch.ref || branch.name;
			const [affectedFileCount, revisionCounts] = await Promise.all([
				typeof getAffectedFileCount === 'function'
					? getAffectedFileCount.call(this.gitService, project.repositoryPath, baseBranch, branchRef)
					: Promise.resolve<number | null>(null),
				typeof getRevisionCounts === 'function'
					? getRevisionCounts.call(this.gitService, project.repositoryPath, baseBranch, branchRef)
					: Promise.resolve<{ ahead: number; behind: number } | null>(null),
			]);
			return [branch.name, { affectedFileCount, revisionCounts }] as const;
		}));
		this.ensureScopeActive(scope);

		const metricsByBranch = new Map(metricEntries);
		return visibleBranches.flatMap((branch) => {
			const metrics = metricsByBranch.get(branch.name);
			const affectedFileCount = metrics?.affectedFileCount;
			if (affectedFileCount === 0) {
				return [];
			}

			const nextBranch = metrics?.revisionCounts
				? {
					...branch,
					ahead: metrics.revisionCounts.ahead,
					behind: metrics.revisionCounts.behind,
				}
				: branch;

			return [
				affectedFileCount === null || affectedFileCount === undefined
					? nextBranch
					: { ...nextBranch, affectedFileCount },
			];
		});
	}

	/** Reuse the already visible placeholder branch rows so details hydration cannot blank the widget. */
	private async resolveDisplayParallelBranches(
		scope: PromptDashboardScope,
		project: GitOverlayProjectSnapshot,
		trackedBranch: string,
		cachedProject?: PromptDashboardProjectSummary,
	): Promise<PromptDashboardProjectSummary['parallelBranches']> {
		return cachedProject?.parallelBranches?.length
			? cachedProject.parallelBranches
			: this.buildDisplayParallelBranches(scope, project, trackedBranch);
	}

	/** Flag only selected prompt projects whose current branch differs from the prompt branch. */
	private hasPromptBranchMismatch(
		scope: PromptDashboardScope,
		project: Pick<GitOverlayProjectSnapshot, 'project' | 'currentBranch' | 'available'>,
	): boolean {
		const promptBranch = scope.promptBranch.trim();
		if (!promptBranch || !project.available || scope.selectedProjectNames.length === 0) {
			return false;
		}

		const projectName = project.project.trim();
		if (!projectName || !scope.selectedProjectNames.includes(projectName)) {
			return false;
		}

		return project.currentBranch.trim() !== promptBranch;
	}

	/** Merge hydrated branch details back into the visible placeholder rows by branch name. */
	private mergeParallelBranchDetails(
		visibleBranches: PromptDashboardProjectSummary['parallelBranches'],
		hydratedBranches: PromptDashboardProjectSummary['parallelBranches'],
	): PromptDashboardProjectSummary['parallelBranches'] {
		if (visibleBranches.length === 0) {
			return hydratedBranches;
		}

		const hydratedByName = new Map(hydratedBranches.map(branch => [branch.name, branch] as const));
		const mergedBranches = visibleBranches.flatMap((branch) => {
			const hydratedBranch = hydratedByName.get(branch.name);
			if (hydratedBranch) {
				return [{
					...branch,
					...hydratedBranch,
					detailsHydrated: true,
					detailsMissing: false,
				}];
			}

			return [{
				...branch,
				affectedFiles: [],
				potentialConflicts: [],
				affectedFileCount: typeof branch.affectedFileCount === 'number' ? branch.affectedFileCount : 0,
				detailsHydrated: true,
				detailsMissing: true,
			}];
		});

		for (const hydratedBranch of hydratedBranches) {
			if (!mergedBranches.some(branch => branch.name === hydratedBranch.name)) {
				mergedBranches.push({
					...hydratedBranch,
					detailsHydrated: true,
					detailsMissing: false,
				});
			}
		}

		return mergedBranches;
	}

	/** Prefer a branch that actually exists in the project before hydrating parallel-branch diffs. */
	private resolveParallelBranchBase(
		scope: PromptDashboardScope,
		project: Pick<GitOverlayProjectSnapshot, 'currentBranch' | 'promptBranch' | 'branches'>,
		trackedBranch: string,
	): string {
		const availableBranches = new Set([
			project.currentBranch,
			...(project.branches || []).map(branch => branch.name),
		].map(branch => String(branch || '').trim()).filter(Boolean));
		const preferredBranches = [scope.promptBranch, trackedBranch, project.currentBranch]
			.map(branch => String(branch || '').trim())
			.filter(Boolean);

		return preferredBranches.find(branch => availableBranches.has(branch))
			|| preferredBranches[0]
			|| '';
	}

	/** Keeps expensive sections cached during lightweight git-reactive branch refreshes. */
	private buildReactiveProjectSummary(
		scope: PromptDashboardScope,
		project: GitOverlayProjectSnapshot,
		snapshotTrackedBranches: string[],
		cachedProject?: PromptDashboardProjectSummary,
		excludedPaths: string[] = [],
		incomingFiles: GitOverlayCommitChangedFile[] = [],
		incomingAuthors: string[] = [],
	): PromptDashboardProjectSummary {
		const trackedBranch = this.resolveTrackedBranchForProject(scope, project, snapshotTrackedBranches);
		const uncommittedFiles = this.collectProjectUncommittedFiles(project, excludedPaths);
		const hasPromptBranchMismatch = this.hasPromptBranchMismatch(scope, project);
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
			branchSwitchError: '',
			pullError: '',
			hasPromptBranchMismatch,
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
			incomingFiles,
			incomingAuthors,
			uncommittedFiles,
		};
	}

	/** Collects all not-yet-committed project files for the branches widget notice. */
	private collectProjectUncommittedFiles(project: GitOverlayProjectSnapshot, excludedPaths: string[] = []): GitOverlayChangeFile[] {
		return [
			...(project.changeGroups.merge || []),
			...(project.changeGroups.staged || []),
			...(project.changeGroups.workingTree || []),
			...(project.changeGroups.untracked || []),
		]
			.filter(file => Boolean(String(file.path || '').trim()))
			.filter(file => excludedPaths.length === 0 || !shouldIgnoreRealtimeRefreshPath(file.path, excludedPaths));
	}

	/** Maps git-operation errors back to the project rows that triggered the branch switch. */
	private buildBranchSwitchResult(
		targetProjects: string[],
		errors: string[],
	): PromptDashboardBranchSwitchResult {
		const normalizedProjects = Array.from(new Set(targetProjects.map(project => project.trim()).filter(Boolean)));
		const projectsSet = new Set(normalizedProjects);
		const projectErrors: Record<string, string> = {};
		const genericErrors: string[] = [];
		const appendProjectError = (project: string, message: string): void => {
			const normalizedProject = project.trim();
			const normalizedMessage = message.trim();
			if (!normalizedProject || !normalizedMessage) {
				return;
			}
			projectErrors[normalizedProject] = projectErrors[normalizedProject]
				? `${projectErrors[normalizedProject]}\n${normalizedMessage}`
				: normalizedMessage;
		};

		for (const rawError of errors) {
			const normalizedError = String(rawError || '').trim();
			if (!normalizedError) {
				continue;
			}
			const separatorIndex = normalizedError.indexOf(':');
			if (separatorIndex > 0) {
				const project = normalizedError.slice(0, separatorIndex).trim();
				const message = normalizedError.slice(separatorIndex + 1).trim();
				if (projectsSet.has(project) && message) {
					appendProjectError(project, message);
					continue;
				}
			}
			genericErrors.push(normalizedError);
		}

		if (genericErrors.length > 0) {
			const genericMessage = genericErrors.join('\n');
			for (const project of normalizedProjects) {
				appendProjectError(project, genericMessage);
			}
		}

		return {
			success: errors.length === 0,
			errors,
			projectErrors,
		};
	}

	/** Keeps only the latest inline action error state for the affected project rows. */
	private updateScopedProjectErrors(
		errorStore: Map<string, Record<string, string>>,
		scope: PromptDashboardScope,
		targetProjects: string[],
		projectErrors: Record<string, string>,
	): void {
		const scopeKey = buildPromptDashboardScopeKey(scope);
		const currentErrors = { ...(errorStore.get(scopeKey) || {}) };
		for (const project of Array.from(new Set(targetProjects.map(item => item.trim()).filter(Boolean)))) {
			const nextError = String(projectErrors[project] || '').trim();
			if (nextError) {
				currentErrors[project] = nextError;
				continue;
			}
			delete currentErrors[project];
		}
		if (Object.keys(currentErrors).length > 0) {
			errorStore.set(scopeKey, currentErrors);
			return;
		}
		errorStore.delete(scopeKey);
	}

	private resolveTrackedBranches(scope: PromptDashboardScope, projectNames: string[]): string[] {
		const configured = this.getConfiguredTrackedBranches();
		const selected = [
			scope.trackedBranch,
			...projectNames.map(project => scope.trackedBranchesByProject[project] || ''),
		].map(branch => branch.trim()).filter(Boolean);
		return Array.from(new Set([...selected, ...configured]));
	}

	/** Prefer an explicit tracked selection, otherwise reuse the current branch when it is already tracked. */
	private resolveTrackedBranchForProject(
		scope: PromptDashboardScope,
		project: Pick<GitOverlayProjectSnapshot, 'project' | 'currentBranch'>,
		snapshotTrackedBranches: string[],
	): string {
		const explicitTrackedBranch = (scope.trackedBranchesByProject[project.project] || scope.trackedBranch || '').trim();
		if (explicitTrackedBranch) {
			return explicitTrackedBranch;
		}

		const normalizedCurrentBranch = (project.currentBranch || '').trim();
		const normalizedTrackedBranches = snapshotTrackedBranches
			.map(branch => branch.trim())
			.filter(Boolean);
		if (normalizedCurrentBranch && normalizedTrackedBranches.includes(normalizedCurrentBranch)) {
			return normalizedCurrentBranch;
		}

		return normalizedTrackedBranches[0] || '';
	}

	private resolveTrackedBranchForSwitch(prompt: Prompt, projectName: string): string {
		return String(prompt.trackedBranchesByProject?.[projectName] || prompt.trackedBranch || '').trim();
	}

	/** Keep dashboard tracked-branch defaults aligned with the Codemap tracked-branches setting. */
	private getConfiguredTrackedBranches(): string[] {
		const trackedBranches = getCodeMapSettings().trackedBranches
			.map(branch => branch.trim())
			.filter(Boolean);

		if (trackedBranches.length > 0) {
			return Array.from(new Set(trackedBranches));
		}

		return this.getAllowedBranches();
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
