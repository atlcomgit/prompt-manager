/**
 * MemoryPanelManager — Opens a webview panel for managing project memory:
 * browsing commits, searching, viewing analysis, knowledge graph,
 * statistics, and settings.
 */

import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import { normalizeHistoryAnalysisLimit } from '../utils/historyAnalysisLimit.js';
import {
	computeManualAnalysisEta,
	computeManualAnalysisThroughput,
	MANUAL_ANALYSIS_EVENT_LIMIT,
} from '../utils/manualAnalysisRuntime.js';
import { logMemoryGraphDebug, showMemoryGraphDebugChannel } from '../utils/memoryGraphDebug.js';
import type { AiService } from '../services/aiService.js';
import type { MemoryDatabaseService } from '../services/memoryDatabaseService.js';
import type { MemoryContextService } from '../services/memoryContextService.js';
import type { MemoryEmbeddingService } from '../services/memoryEmbeddingService.js';
import type { MemoryAnalyzerService } from '../services/memoryAnalyzerService.js';
import type { MemoryGitHookService } from '../services/memoryGitHookService.js';
import type { CodeMapAdminService } from '../codemap/codeMapAdminService.js';
import type {
	ManualAnalysisCommitRow,
	ManualAnalysisEventEntry,
	ManualAnalysisRepositoryProgress,
	ManualAnalysisRunStatus,
	ManualAnalysisSnapshot,
	MemoryAvailableModel,
	MemoryWebviewToExtensionMessage,
	MemoryExtensionToWebviewMessage,
	MemorySettings,
	MemorySearchResult,
} from '../types/memory.js';
import { DEFAULT_MEMORY_SETTINGS } from '../types/memory.js';
import { DEFAULT_COPILOT_MODEL_FAMILY } from '../constants/ai.js';

let currentPanel: vscode.WebviewPanel | undefined;

interface ManualAnalysisCommitRuntime extends ManualAnalysisCommitRow {
	repoPath: string;
}

interface ManualAnalysisSession {
	status: ManualAnalysisRunStatus;
	effectiveLimit: number;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
	commitRows: ManualAnalysisCommitRuntime[];
	recentEvents: ManualAnalysisEventEntry[];
	eventSequence: number;
}

export class MemoryPanelManager {
	private manualAnalysisSession: ManualAnalysisSession | null = null;

	private manualAnalysisLoopPromise: Promise<void> | null = null;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly db: MemoryDatabaseService,
		private readonly context: MemoryContextService,
		private readonly embedding: MemoryEmbeddingService,
		private readonly analyzer: MemoryAnalyzerService,
		private readonly gitHook: MemoryGitHookService,
		private readonly aiService?: AiService,
			private readonly codeMapAdmin?: CodeMapAdminService,
	) { }

	private isRussianLocale(): boolean {
		return vscode.env.language.toLowerCase().startsWith('ru');
	}

	private getManualAnalysisUiText(): {
		alreadyRunning: string;
		noWorkspaceFolders: string;
		noCommitsFound: string;
		noNewCommits: string;
		started: string;
		stopped: string;
	} {
		if (this.isRussianLocale()) {
			return {
				alreadyRunning: 'Анализ истории уже выполняется. Открыт актуальный прогресс.',
				noWorkspaceFolders: 'Не найдено открытых папок workspace для анализа истории',
				noCommitsFound: 'В выбранном диапазоне истории не найдено коммитов для анализа.',
				noNewCommits: 'Новых коммитов для анализа нет: все коммиты из выбранного диапазона уже сохранены в памяти.',
				started: 'Анализ истории запущен.',
				stopped: 'Анализ истории остановлен.',
			};
		}

		return {
			alreadyRunning: 'History analysis is already running. Showing the current progress.',
			noWorkspaceFolders: 'No workspace folders found for manual history analysis',
			noCommitsFound: 'No commits were found in the selected history range.',
			noNewCommits: 'No new commits to analyse: all commits in the selected range are already stored in memory.',
			started: 'History analysis started.',
			stopped: 'History analysis stopped.',
		};
	}

	/** Open or focus the memory panel */
	async show(): Promise<void> {
		if (currentPanel) {
			currentPanel.reveal();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'promptManager.memory',
			'🧠 Project Memory',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [this.extensionUri],
			},
		);

		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar-icon.svg');

		panel.webview.html = getWebviewHtml(
			panel.webview,
			this.extensionUri,
			'dist/webview/memory.js',
			'Project Memory',
			vscode.env.language,
			undefined,
			['node_modules/3d-force-graph/dist/3d-force-graph.min.js'],
		);

		currentPanel = panel;

		panel.onDidDispose(() => {
			currentPanel = undefined;
		});

		panel.webview.onDidReceiveMessage(async (msg: MemoryWebviewToExtensionMessage) => {
			await this.handleMessage(panel, msg);
		});
	}

	/** Post a message to the webview */
	postMessage(message: MemoryExtensionToWebviewMessage): void {
		currentPanel?.webview.postMessage(message);
	}

	/** Handle incoming messages from the webview */
	private async handleMessage(
		panel: vscode.WebviewPanel,
		msg: MemoryWebviewToExtensionMessage,
	): Promise<void> {
		try {
			switch (msg.type) {
				case 'memoryDebugLog':
					logMemoryGraphDebug(`webview:${msg.scope}`, msg.payload);
					break;

				case 'memoryReady':
					await this.sendInitialData(panel);
					break;

				case 'openMemoryFile': {
					await this.openMemoryFile(msg.repository, msg.filePath);
					break;
				}

				case 'getMemoryCommits': {
					const { commits, total } = await this.db.getCommits(msg.filter || {});
					panel.webview.postMessage({
						type: 'memoryCommits',
						commits,
						total,
						filter: msg.filter,
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'getMemoryCommitDetail': {
					const commit = await this.db.getCommit(msg.sha);
					if (!commit) {
						panel.webview.postMessage({
							type: 'memoryError',
							message: `Commit ${msg.sha} not found`,
						} as MemoryExtensionToWebviewMessage);
						break;
					}
					const fileChanges = await this.db.getFileChanges(msg.sha);
					const analysis = await this.db.getAnalysis(msg.sha);
					const bugRelations = await this.db.getBugRelations(msg.sha);
					panel.webview.postMessage({
						type: 'memoryCommitDetail',
						commit,
						fileChanges,
						analysis: analysis || undefined,
						bugRelations,
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'searchMemory': {
					const searchCommits = await this.db.searchByKeyword(msg.query);
					const results: MemorySearchResult[] = [];
					for (const commit of searchCommits) {
						const analysis = await this.db.getAnalysis(commit.sha);
						results.push({ commit, analysis: analysis || undefined, score: 1.0 });
					}
					panel.webview.postMessage({
						type: 'memorySearchResults',
						results,
						query: msg.query,
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'deleteMemoryCommit': {
					await this.db.deleteCommit(msg.sha);
					panel.webview.postMessage({
						type: 'memoryInfo',
						message: `Commit ${msg.sha.substring(0, 7)} deleted`,
					} as MemoryExtensionToWebviewMessage);
					// Refresh list
					const { commits: refreshedCommits, total: refreshedTotal } = await this.db.getCommits({});
					panel.webview.postMessage({
						type: 'memoryCommits',
						commits: refreshedCommits,
						total: refreshedTotal,
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'clearMemory': {
					// Confirm before clearing
					await this.db.clearAll();
					panel.webview.postMessage({
						type: 'memoryCleared',
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'runManualAnalysis': {
					await this.runManualAnalysis(panel, msg.limit);
					break;
				}

				case 'pauseManualAnalysis': {
					this.pauseManualAnalysis();
					break;
				}

				case 'resumeManualAnalysis': {
					this.resumeManualAnalysis();
					break;
				}

				case 'stopManualAnalysis': {
					this.stopManualAnalysis();
					break;
				}

				case 'requestManualAnalysisSnapshot': {
					this.postManualAnalysisSnapshot(panel);
					break;
				}

				case 'getMemorySettings': {
					const settings = this.getMemorySettings();
					panel.webview.postMessage({
						type: 'memoryAvailableModels',
						models: await this.getAvailableModels(),
					} as MemoryExtensionToWebviewMessage);
					panel.webview.postMessage({
						type: 'memorySettings',
						settings,
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'saveMemorySettings': {
					const config = vscode.workspace.getConfiguration('promptManager');
					const s = msg.settings;
					if (s.enabled !== undefined) { await config.update('memory.enabled', s.enabled, true); }
					if (s.aiModel !== undefined) { await config.update('memory.aiModel', s.aiModel, true); }
					if (s.analysisDepth !== undefined) { await config.update('memory.analysisDepth', s.analysisDepth, true); }
					if (s.diffLimit !== undefined) { await config.update('memory.diffLimit', s.diffLimit, true); }
					if (s.maxRecords !== undefined) { await config.update('memory.maxRecords', s.maxRecords, true); }
					if (s.retentionDays !== undefined) { await config.update('memory.retentionDays', s.retentionDays, true); }
					if (s.shortTermLimit !== undefined) { await config.update('memory.shortTermLimit', s.shortTermLimit, true); }
					if (s.historyAnalysisLimit !== undefined) { await config.update('memory.historyAnalysisLimit', s.historyAnalysisLimit, true); }
					if (s.autoCleanup !== undefined) { await config.update('memory.autoCleanup', s.autoCleanup, true); }
					if (s.notificationsEnabled !== undefined) { await config.update('memory.notifications.enabled', s.notificationsEnabled, true); }
					if (s.notificationType !== undefined) { await config.update('memory.notifications.type', s.notificationType, true); }
					if (s.embeddingsEnabled !== undefined) { await config.update('memory.embeddings.enabled', s.embeddingsEnabled, true); }
					if (s.knowledgeGraphEnabled !== undefined) { await config.update('memory.knowledgeGraph.enabled', s.knowledgeGraphEnabled, true); }
					if (s.httpPort !== undefined) { await config.update('memory.httpPort', s.httpPort, true); }
					const settings = this.getMemorySettings();
					this.analyzer.setModelFamily(settings.aiModel);
					panel.webview.postMessage({
						type: 'memorySettings',
						settings,
					} as MemoryExtensionToWebviewMessage);
					panel.webview.postMessage({
						type: 'memoryInfo',
						message: 'Settings saved',
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'exportMemoryData': {
					let data: string;
					if (msg.format === 'json') {
						data = await this.db.exportJson(msg.filter || {});
					} else {
						data = await this.db.exportCsv(msg.filter || {});
					}
					panel.webview.postMessage({
						type: 'memoryExportReady',
						format: msg.format,
						data,
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'getKnowledgeGraph': {
					showMemoryGraphDebugChannel(true);
					logMemoryGraphDebug('extension:getKnowledgeGraph:request', {
						repository: msg.repository || null,
					});
					const graph = await this.db.getKnowledgeGraph(msg.repository);
					logMemoryGraphDebug('extension:getKnowledgeGraph:response', {
						repository: msg.repository || null,
						nodes: graph.nodes.length,
						edges: graph.edges.length,
						summary: graph.summary,
						sampleNodeIds: graph.nodes.slice(0, 5).map(node => node.id),
						sampleEdgeIds: graph.edges.slice(0, 5).map(edge => edge.id),
					});
					panel.webview.postMessage({
						type: 'memoryKnowledgeGraph',
						data: graph,
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'getMemoryStatistics': {
					const statistics = await this.db.getStatistics();
					panel.webview.postMessage({
						type: 'memoryStatistics',
						statistics,
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'getMemoryCategories': {
					const catStats = await this.db.getStatistics();
					const categories = catStats.categoryDistribution.map(s => s.category);
					panel.webview.postMessage({
						type: 'memoryCategories',
						categories,
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'getMemoryAuthors': {
					const authorStats = await this.db.getStatistics();
					const authors = authorStats.topAuthors.map(a => a.author);
					panel.webview.postMessage({
						type: 'memoryAuthors',
						authors,
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'getMemoryBranches': {
					const branches = await this.db.getBranches();
					panel.webview.postMessage({
						type: 'memoryBranches',
						branches,
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'getMemoryRepositories': {
					const repositories = await this.db.getRepositories();
					panel.webview.postMessage({
						type: 'memoryRepositories',
						repositories,
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'getCodeMapInstructions': {
					panel.webview.postMessage({
						type: 'codeMapInstructions',
						instructions: this.codeMapAdmin ? await this.codeMapAdmin.getInstructions() : [],
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'getCodeMapInstructionDetail': {
					panel.webview.postMessage({
						type: 'codeMapInstructionDetail',
						detail: this.codeMapAdmin?.getInstructionDetail(msg.id) || null,
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'getCodeMapStatistics': {
					panel.webview.postMessage({
						type: 'codeMapStatistics',
						statistics: this.codeMapAdmin?.getStatistics() || this.getEmptyCodeMapStatistics(),
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'getCodeMapActivity': {
					panel.webview.postMessage({
						type: 'codeMapActivity',
						activity: this.codeMapAdmin?.getActivity() || this.getEmptyCodeMapActivity(),
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'deleteCodeMapInstruction': {
					const deleted = this.codeMapAdmin ? this.codeMapAdmin.deleteInstruction(msg.id) : false;
					panel.webview.postMessage({
						type: deleted ? 'memoryInfo' : 'memoryError',
						message: this.isRussianLocale()
							? (deleted ? 'Инструкция удалена' : 'Не удалось удалить инструкцию')
							: (deleted ? 'Instruction deleted' : 'Failed to delete instruction'),
					} as MemoryExtensionToWebviewMessage);
					panel.webview.postMessage({
						type: 'codeMapInstructions',
						instructions: this.codeMapAdmin ? await this.codeMapAdmin.getInstructions() : [],
					} as MemoryExtensionToWebviewMessage);
					panel.webview.postMessage({
						type: 'codeMapActivity',
						activity: this.codeMapAdmin?.getActivity() || this.getEmptyCodeMapActivity(),
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'deleteObsoleteCodeMapInstructions': {
					const deletedCount = this.codeMapAdmin ? await this.codeMapAdmin.deleteObsoleteInstructions() : 0;
					panel.webview.postMessage({
						type: 'memoryInfo',
						message: this.isRussianLocale()
							? `Удалено неактуальных инструкций: ${deletedCount}`
							: `Deleted obsolete instructions: ${deletedCount}`,
					} as MemoryExtensionToWebviewMessage);
					panel.webview.postMessage({
						type: 'codeMapInstructions',
						instructions: this.codeMapAdmin ? await this.codeMapAdmin.getInstructions() : [],
					} as MemoryExtensionToWebviewMessage);
					panel.webview.postMessage({
						type: 'codeMapActivity',
						activity: this.codeMapAdmin?.getActivity() || this.getEmptyCodeMapActivity(),
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'getCodeMapSettings': {
					panel.webview.postMessage({
						type: 'codeMapSettings',
						settings: this.codeMapAdmin?.getSettings() || {
							enabled: false,
							trackedBranches: [],
							autoUpdate: false,
							notificationsEnabled: false,
							aiModel: DEFAULT_COPILOT_MODEL_FAMILY,
							instructionMaxChars: 120000,
							blockDescriptionMode: 'medium',
							blockMaxChars: 2000,
							batchContextMaxChars: 24000,
							updatePriority: 'normal',
							aiDelayMs: 1000,
							startupDelayMs: 15000,
							maxVersionsPerInstruction: 3,
						},
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'saveCodeMapSettings': {
					const settings = this.codeMapAdmin
						? await this.codeMapAdmin.saveSettings(msg.settings)
						: {
							enabled: false,
							trackedBranches: [],
							autoUpdate: false,
							notificationsEnabled: false,
							aiModel: DEFAULT_COPILOT_MODEL_FAMILY,
							instructionMaxChars: 120000,
							blockDescriptionMode: 'medium' as const,
							blockMaxChars: 2000,
							batchContextMaxChars: 24000,
							updatePriority: 'normal' as const,
							aiDelayMs: 1000,
							startupDelayMs: 15000,
							maxVersionsPerInstruction: 3,
						};
					panel.webview.postMessage({
						type: 'codeMapSettings',
						settings,
					} as MemoryExtensionToWebviewMessage);
					panel.webview.postMessage({
						type: 'memoryInfo',
						message: this.isRussianLocale() ? 'Настройки инструкций сохранены' : 'Instruction settings saved',
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'refreshCodeMapWorkspace': {
					const queued = this.codeMapAdmin ? await this.codeMapAdmin.queueRefreshWorkspace() : 0;
					panel.webview.postMessage({
						type: 'memoryInfo',
						message: this.isRussianLocale()
							? `В очередь обновления инструкций добавлено: ${queued}`
							: `Queued instruction refresh jobs: ${queued}`,
					} as MemoryExtensionToWebviewMessage);
					panel.webview.postMessage({
						type: 'codeMapInstructions',
						instructions: this.codeMapAdmin ? await this.codeMapAdmin.getInstructions() : [],
					} as MemoryExtensionToWebviewMessage);
					panel.webview.postMessage({
						type: 'codeMapStatistics',
						statistics: this.codeMapAdmin?.getStatistics() || this.getEmptyCodeMapStatistics(),
					} as MemoryExtensionToWebviewMessage);
					panel.webview.postMessage({
						type: 'codeMapActivity',
						activity: this.codeMapAdmin?.getActivity() || this.getEmptyCodeMapActivity(),
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				case 'refreshCodeMapInstruction': {
					const queued = this.codeMapAdmin ? await this.codeMapAdmin.queueRefreshInstruction(msg.id) : false;
					panel.webview.postMessage({
						type: 'memoryInfo',
						message: this.isRussianLocale()
							? (queued ? 'Выбранная инструкция поставлена в очередь обновления' : 'Не удалось поставить инструкцию в очередь обновления')
							: (queued ? 'Selected instruction queued for refresh' : 'Failed to queue selected instruction'),
					} as MemoryExtensionToWebviewMessage);
					panel.webview.postMessage({
						type: 'codeMapStatistics',
						statistics: this.codeMapAdmin?.getStatistics() || this.getEmptyCodeMapStatistics(),
					} as MemoryExtensionToWebviewMessage);
					panel.webview.postMessage({
						type: 'codeMapActivity',
						activity: this.codeMapAdmin?.getActivity() || this.getEmptyCodeMapActivity(),
					} as MemoryExtensionToWebviewMessage);
					break;
				}

				default:
					break;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logMemoryGraphDebug('extension:handleMessage:error', {
				message,
				inputType: msg.type,
				stack: err instanceof Error ? err.stack : undefined,
			});
			panel.webview.postMessage({
				type: 'memoryError',
				message,
			} as MemoryExtensionToWebviewMessage);
		}
	}

	private async openMemoryFile(repository: string, filePath: string): Promise<void> {
		const targetFolder = this.findWorkspaceFolder(repository);
		if (!targetFolder) {
			throw new Error(`Workspace folder for repository ${repository} not found`);
		}

		const relativeParts = filePath.split(/[\\/]/).filter(Boolean);
		const fileUri = vscode.Uri.joinPath(targetFolder.uri, ...relativeParts);
		await vscode.workspace.fs.stat(fileUri);
		const document = await vscode.workspace.openTextDocument(fileUri);
		await vscode.window.showTextDocument(document, { preview: true });
	}

	private findWorkspaceFolder(repository: string): vscode.WorkspaceFolder | undefined {
		const workspaceFolders = vscode.workspace.workspaceFolders || [];
		return workspaceFolders.find(folder => folder.name === repository)
			|| workspaceFolders.find(folder => folder.uri.fsPath.endsWith(`/${repository}`))
			|| workspaceFolders[0];
	}

	/** Send initial data when webview becomes ready */
	private async sendInitialData(panel: vscode.WebviewPanel): Promise<void> {
		const stats = await this.db.getStatistics();
		panel.webview.postMessage({
			type: 'memoryAvailableModels',
			models: await this.getAvailableModels(),
		} as MemoryExtensionToWebviewMessage);
		panel.webview.postMessage({
			type: 'memoryStatistics',
			statistics: stats,
		} as MemoryExtensionToWebviewMessage);

		const { commits, total } = await this.db.getCommits({ limit: 50 });
		panel.webview.postMessage({
			type: 'memoryCommits',
			commits,
			total,
		} as MemoryExtensionToWebviewMessage);

		if (this.codeMapAdmin) {
			panel.webview.postMessage({
				type: 'codeMapInstructions',
				instructions: await this.codeMapAdmin.getInstructions(),
			} as MemoryExtensionToWebviewMessage);
			panel.webview.postMessage({
				type: 'codeMapStatistics',
				statistics: this.codeMapAdmin.getStatistics(),
			} as MemoryExtensionToWebviewMessage);
			panel.webview.postMessage({
				type: 'codeMapSettings',
				settings: this.codeMapAdmin.getSettings(),
			} as MemoryExtensionToWebviewMessage);
			panel.webview.postMessage({
				type: 'codeMapActivity',
				activity: this.codeMapAdmin.getActivity(),
			} as MemoryExtensionToWebviewMessage);
		}

		this.postManualAnalysisSnapshot(panel);
	}

	private getEmptyCodeMapStatistics(): import('../types/codemap.js').CodeMapStatistics {
		return {
			totalInstructions: 0,
			totalVersions: 0,
			totalJobs: 0,
			queuedJobs: 0,
			runningJobs: 0,
			completedJobs: 0,
			failedJobs: 0,
			dbSizeBytes: 0,
			repositories: [],
			branches: [],
			avgDurationMs: 0,
			avgGenerationDurationMs: 0,
			maxDurationMs: 0,
			peakHeapUsedBytes: 0,
			aiModels: [],
			triggerStats: [],
			repositoryStats: [],
		};
	}

	private getMemorySettings(): MemorySettings {
		const config = vscode.workspace.getConfiguration('promptManager');
		return {
			enabled: config.get<boolean>('memory.enabled', DEFAULT_MEMORY_SETTINGS.enabled),
			aiModel: config.get<string>('memory.aiModel', DEFAULT_MEMORY_SETTINGS.aiModel),
			analysisDepth: config.get<any>('memory.analysisDepth', DEFAULT_MEMORY_SETTINGS.analysisDepth),
			diffLimit: config.get<number>('memory.diffLimit', DEFAULT_MEMORY_SETTINGS.diffLimit),
			maxRecords: config.get<number>('memory.maxRecords', DEFAULT_MEMORY_SETTINGS.maxRecords),
			retentionDays: config.get<number>('memory.retentionDays', DEFAULT_MEMORY_SETTINGS.retentionDays),
			shortTermLimit: config.get<number>('memory.shortTermLimit', DEFAULT_MEMORY_SETTINGS.shortTermLimit),
			historyAnalysisLimit: config.get<number>('memory.historyAnalysisLimit', DEFAULT_MEMORY_SETTINGS.historyAnalysisLimit),
			autoCleanup: config.get<boolean>('memory.autoCleanup', DEFAULT_MEMORY_SETTINGS.autoCleanup),
			notificationsEnabled: config.get<boolean>('memory.notifications.enabled', DEFAULT_MEMORY_SETTINGS.notificationsEnabled),
			notificationType: config.get<any>('memory.notifications.type', DEFAULT_MEMORY_SETTINGS.notificationType),
			embeddingsEnabled: config.get<boolean>('memory.embeddings.enabled', DEFAULT_MEMORY_SETTINGS.embeddingsEnabled),
			knowledgeGraphEnabled: config.get<boolean>('memory.knowledgeGraph.enabled', DEFAULT_MEMORY_SETTINGS.knowledgeGraphEnabled),
			httpPort: config.get<number>('memory.httpPort', DEFAULT_MEMORY_SETTINGS.httpPort),
		};
	}

	private async getAvailableModels(): Promise<MemoryAvailableModel[]> {
		const configured = this.getMemorySettings().aiModel;
		const discovered = this.aiService ? await this.aiService.getAvailableModels() : [];
		const items = [...discovered];
		if (configured && !items.some(item => item.id === configured)) {
			items.unshift({ id: configured, name: configured });
		}

		const seen = new Set<string>();
		return items.filter(item => {
			const id = String(item.id || '').trim();
			if (!id || seen.has(id)) {
				return false;
			}
			seen.add(id);
			return true;
		});
	}

	private getEmptyCodeMapActivity(): import('../types/codemap.js').CodeMapActivity {
		return {
			statistics: this.getEmptyCodeMapStatistics(),
			runtime: {
				pendingCount: 0,
				queuedCount: 0,
				runningCount: 0,
				isProcessing: false,
				queuedTasks: [],
				recentEvents: [],
				cycle: {
					queuedTotal: 0,
					startedTotal: 0,
					completedTotal: 0,
					failedTotal: 0,
				},
			},
			recentJobs: [],
		};
	}

	/** Run manual analysis of recent commits from git history */
	private async runManualAnalysis(
		panel: vscode.WebviewPanel,
		limit?: number,
	): Promise<void> {
		const text = this.getManualAnalysisUiText();

		if (this.manualAnalysisSession && (
			this.manualAnalysisSession.status === 'running'
			|| this.manualAnalysisSession.status === 'pausing'
			|| this.manualAnalysisSession.status === 'paused'
			|| this.manualAnalysisSession.status === 'stopping'
		)) {
			panel.webview.postMessage({
				type: 'memoryInfo',
				message: text.alreadyRunning,
			} as MemoryExtensionToWebviewMessage);
			this.postManualAnalysisSnapshot(panel);
			return;
		}

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			panel.webview.postMessage({
				type: 'memoryError',
				message: text.noWorkspaceFolders,
			} as MemoryExtensionToWebviewMessage);
			return;
		}

		const config = vscode.workspace.getConfiguration('promptManager');
		const configuredLimit = config.get<number>('memory.historyAnalysisLimit', 500);
		const effectiveLimit = normalizeHistoryAnalysisLimit(limit, configuredLimit);
		const session = await this.createManualAnalysisSession(workspaceFolders, effectiveLimit);
		this.manualAnalysisSession = session;

		if (session.commitRows.length === 0) {
			this.pushManualAnalysisEvent(session, {
				kind: 'info',
				message: text.noCommitsFound,
			});
			panel.webview.postMessage({
				type: 'memoryInfo',
				message: text.noCommitsFound,
			} as MemoryExtensionToWebviewMessage);
			this.finishManualAnalysis('completed');
			return;
		}

		if (!session.commitRows.some((row) => row.status === 'queued')) {
			this.pushManualAnalysisEvent(session, {
				kind: 'info',
				message: text.noNewCommits,
			});
			panel.webview.postMessage({
				type: 'memoryInfo',
				message: text.noNewCommits,
			} as MemoryExtensionToWebviewMessage);
			this.finishManualAnalysis('completed');
			return;
		}

		session.status = 'running';
		session.updatedAt = new Date().toISOString();
		this.pushManualAnalysisEvent(session, {
			kind: 'state',
			message: `Manual analysis started with limit ${effectiveLimit}`,
		});
		panel.webview.postMessage({
			type: 'memoryInfo',
			message: text.started,
		} as MemoryExtensionToWebviewMessage);
		this.postManualAnalysisSnapshot(panel);

		const loopSession = session;
		this.manualAnalysisLoopPromise = this.processManualAnalysisQueue(loopSession)
			.catch((err) => {
				const activeSession = this.manualAnalysisSession;
				if (!activeSession || activeSession !== loopSession) {
					return;
				}

				this.pushManualAnalysisEvent(activeSession, {
					kind: 'error',
					message: err instanceof Error ? err.message : String(err),
				});
				this.finishManualAnalysis('stopped');
			})
			.finally(() => {
				if (this.manualAnalysisSession === loopSession) {
					this.manualAnalysisLoopPromise = null;
				}
			});
	}

	private pauseManualAnalysis(): void {
		if (!this.manualAnalysisSession || this.manualAnalysisSession.status !== 'running') {
			this.postManualAnalysisSnapshot();
			return;
		}

		this.manualAnalysisSession.status = 'pausing';
		this.manualAnalysisSession.updatedAt = new Date().toISOString();
		this.pushManualAnalysisEvent(this.manualAnalysisSession, {
			kind: 'state',
			message: 'Pause requested. Waiting for the current commit to finish.',
		});
		this.postManualAnalysisSnapshot();
	}

	private resumeManualAnalysis(): void {
		if (!this.manualAnalysisSession || this.manualAnalysisSession.status !== 'paused') {
			this.postManualAnalysisSnapshot();
			return;
		}

		this.manualAnalysisSession.status = 'running';
		this.manualAnalysisSession.updatedAt = new Date().toISOString();
		this.pushManualAnalysisEvent(this.manualAnalysisSession, {
			kind: 'state',
			message: 'Manual analysis resumed',
		});
		this.postManualAnalysisSnapshot();

		if (!this.manualAnalysisLoopPromise) {
			const loopSession = this.manualAnalysisSession;
			this.manualAnalysisLoopPromise = this.processManualAnalysisQueue(loopSession)
				.finally(() => {
					if (this.manualAnalysisSession === loopSession) {
						this.manualAnalysisLoopPromise = null;
					}
				});
		}
	}

	private stopManualAnalysis(): void {
		if (!this.manualAnalysisSession) {
			return;
		}

		if (this.manualAnalysisSession.status === 'paused') {
			this.pushManualAnalysisEvent(this.manualAnalysisSession, {
				kind: 'state',
				message: 'Manual analysis stopped',
			});
			this.finishManualAnalysis('stopped');
			return;
		}

		if (this.manualAnalysisSession.status !== 'running' && this.manualAnalysisSession.status !== 'pausing') {
			this.postManualAnalysisSnapshot();
			return;
		}

		this.manualAnalysisSession.status = 'stopping';
		this.manualAnalysisSession.updatedAt = new Date().toISOString();
		this.pushManualAnalysisEvent(this.manualAnalysisSession, {
			kind: 'state',
			message: 'Stop requested. Waiting for the current commit to finish.',
		});
		this.postManualAnalysisSnapshot();
	}

	private async createManualAnalysisSession(
		workspaceFolders: readonly vscode.WorkspaceFolder[],
		effectiveLimit: number,
	): Promise<ManualAnalysisSession> {
		const startedAt = new Date().toISOString();
		const commitRows: ManualAnalysisCommitRuntime[] = [];
		const session: ManualAnalysisSession = {
			status: 'idle',
			effectiveLimit,
			startedAt,
			updatedAt: startedAt,
			commitRows,
			recentEvents: [],
			eventSequence: 0,
		};

		let sequence = 0;

		for (const folder of workspaceFolders) {
			const repoPath = folder.uri.fsPath;
			const repository = this.gitHook.getRepositoryName(repoPath);
			const shas = await this.gitHook.getCommitShas(repoPath, effectiveLimit);

			let skippedExisting = 0;
			let queued = 0;

			for (const sha of shas) {
				sequence += 1;
				const existing = this.db.getCommit(sha);
				if (existing) {
					skippedExisting += 1;
					commitRows.push({
						id: `${repository}:${sha}`,
						sha,
						repository,
						repoPath,
						branch: existing.branch,
						message: this.getCommitHeadline(existing.message),
						status: 'skipped',
						reason: 'already-analyzed',
						fileCount: 0,
						diffBytes: 0,
						categories: [],
						isStored: true,
						sequence,
					});
					continue;
				}

				queued += 1;
				commitRows.push({
					id: `${repository}:${sha}`,
					sha,
					repository,
					repoPath,
					branch: '',
					message: '',
					status: 'queued',
					fileCount: 0,
					diffBytes: 0,
					categories: [],
					isStored: false,
					sequence,
				});
			}

			this.pushManualAnalysisEvent(session, {
				kind: 'info',
				repository,
				message: `${repository}: ${queued} queued, ${skippedExisting} already analysed, ${shas.length} total`,
			});
		}

		return session;
	}

	private async processManualAnalysisQueue(session: ManualAnalysisSession): Promise<void> {
		while (this.manualAnalysisSession === session) {
			const sessionStatus = session.status;
			if (sessionStatus === 'paused' || sessionStatus === 'completed' || sessionStatus === 'stopped') {
				return;
			}

			if (sessionStatus === 'pausing') {
				session.status = 'paused';
				session.updatedAt = new Date().toISOString();
				this.pushManualAnalysisEvent(session, {
					kind: 'state',
					message: 'Manual analysis paused',
				});
				this.postManualAnalysisSnapshot();
				return;
			}

			if (sessionStatus === 'stopping') {
				this.finishManualAnalysis('stopped');
				return;
			}

			const nextRow = session.commitRows
				.filter((row) => row.status === 'queued')
				.sort((left, right) => left.sequence - right.sequence)[0];

			if (!nextRow) {
				this.finishManualAnalysis('completed');
				return;
			}

			await this.processManualAnalysisRow(session, nextRow);

			const updatedStatus = session.status;
			if (updatedStatus === 'pausing') {
				session.status = 'paused';
				session.updatedAt = new Date().toISOString();
				this.pushManualAnalysisEvent(session, {
					kind: 'state',
					message: 'Manual analysis paused',
				});
				this.postManualAnalysisSnapshot();
				return;
			}

			if (updatedStatus === 'stopping') {
				this.finishManualAnalysis('stopped');
				return;
			}
		}
	}

	private async processManualAnalysisRow(
		session: ManualAnalysisSession,
		row: ManualAnalysisCommitRuntime,
	): Promise<void> {
		const config = vscode.workspace.getConfiguration('promptManager');
		const depth = config.get<any>('memory.analysisDepth', 'standard');
		const diffLimit = config.get<number>('memory.diffLimit', 10000);
		const aiModel = config.get<string>('memory.aiModel', DEFAULT_MEMORY_SETTINGS.aiModel);
		const startedAt = new Date().toISOString();

		row.status = 'running';
		row.startedAt = startedAt;
		row.finishedAt = undefined;
		row.durationMs = undefined;
		row.reason = undefined;
		session.updatedAt = startedAt;
		this.pushManualAnalysisEvent(session, {
			kind: 'state',
			repository: row.repository,
			sha: row.sha,
			message: `Analysing ${row.repository} ${row.sha.substring(0, 7)}`,
		});
		this.postManualAnalysisSnapshot();

		const commitData = await this.gitHook.getCommitData(row.repoPath, row.sha);
		if (!commitData) {
			this.completeManualAnalysisRow(session, row, 'skipped', 'no-commit-data');
			this.pushManualAnalysisEvent(session, {
				kind: 'skip',
				repository: row.repository,
				sha: row.sha,
				message: `Skipped ${row.repository} ${row.sha.substring(0, 7)}: commit metadata is unavailable`,
			});
			return;
		}

		row.branch = commitData.branch;
		row.message = this.getCommitHeadline(commitData.message);
		row.fileCount = commitData.files.length;
		row.diffBytes = Buffer.byteLength(commitData.diff || '', 'utf8');
		session.updatedAt = new Date().toISOString();
		this.postManualAnalysisSnapshot();

		const existing = this.db.getCommit(row.sha);
		if (existing) {
			row.branch = existing.branch;
			row.message = this.getCommitHeadline(existing.message);
			row.isStored = true;
			this.completeManualAnalysisRow(session, row, 'skipped', 'already-analyzed');
			this.pushManualAnalysisEvent(session, {
				kind: 'skip',
				repository: row.repository,
				sha: row.sha,
				message: `Skipped ${row.repository} ${row.sha.substring(0, 7)}: already analysed`,
			});
			return;
		}

		const payload = {
			sha: row.sha,
			author: commitData.author,
			email: commitData.email,
			date: commitData.date,
			branch: commitData.branch,
			repository: row.repository,
			parentSha: commitData.parentSha,
			message: commitData.message,
			diff: commitData.diff,
			files: commitData.files,
		};

		const commitType = this.analyzer.classifyCommitType(commitData.message);
		this.db.insertCommit({
			sha: row.sha,
			author: commitData.author,
			email: commitData.email,
			date: commitData.date,
			branch: commitData.branch,
			repository: row.repository,
			parentSha: commitData.parentSha,
			commitType,
			message: commitData.message,
		});
		row.isStored = true;

		try {
			this.analyzer.setModelFamily(aiModel);
			const result = await this.analyzer.analyzeCommit(payload, depth, diffLimit);
			this.db.insertAnalysis(result.analysis);
			this.db.insertFileChanges(result.fileChanges);
			if (result.knowledgeNodes.length > 0) {
				this.db.insertKnowledgeNodes(result.knowledgeNodes);
			}
			if (result.bugRelation) {
				this.db.insertBugRelation(result.bugRelation);
			}

			if (this.embedding.isReady()) {
				const text = `${commitData.message}\n${result.analysis.summary}\n${result.analysis.keywords.join(' ')}`;
				const vector = await this.embedding.generateEmbedding(text);
				if (vector) {
					this.db.insertEmbedding({
						commitSha: row.sha,
						vector,
						text,
						createdAt: new Date().toISOString(),
					});
				}
			}

			row.categories = result.analysis.categories;
			row.architectureImpactScore = result.analysis.architectureImpactScore;
			row.summary = result.analysis.summary;
			this.completeManualAnalysisRow(session, row, 'completed');
			this.pushManualAnalysisEvent(session, {
				kind: 'info',
				repository: row.repository,
				sha: row.sha,
				message: `Completed ${row.repository} ${row.sha.substring(0, 7)}`,
			});
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(`[PromptManager/Memory] Analysis error for ${row.sha}:`, err);
			this.completeManualAnalysisRow(session, row, 'error', reason);
			this.pushManualAnalysisEvent(session, {
				kind: 'error',
				repository: row.repository,
				sha: row.sha,
				message: `Failed ${row.repository} ${row.sha.substring(0, 7)}: ${reason}`,
			});
		}
	}

	private completeManualAnalysisRow(
		session: ManualAnalysisSession,
		row: ManualAnalysisCommitRuntime,
		status: ManualAnalysisCommitRow['status'],
		reason?: string,
	): void {
		const finishedAt = new Date().toISOString();
		const startedAt = row.startedAt ? new Date(row.startedAt).getTime() : new Date(finishedAt).getTime();
		const finishedAtMs = new Date(finishedAt).getTime();

		row.status = status;
		row.finishedAt = finishedAt;
		row.durationMs = Math.max(0, finishedAtMs - startedAt);
		row.reason = reason;
		session.updatedAt = finishedAt;
		this.postManualAnalysisSnapshot();
	}

	private buildManualAnalysisSnapshot(session: ManualAnalysisSession): ManualAnalysisSnapshot {
		const repositoryOrder: string[] = [];
		const repositoryMap = new Map<string, ManualAnalysisRepositoryProgress>();

		let total = 0;
		let queued = 0;
		let running = 0;
		let completed = 0;
		let skipped = 0;
		let skippedExisting = 0;
		let error = 0;
		let currentRepository: string | undefined;
		let currentSha: string | undefined;
		let currentMessage: string | undefined;

		for (const row of session.commitRows.slice().sort((left, right) => left.sequence - right.sequence)) {
			total += 1;
			if (!repositoryMap.has(row.repository)) {
				repositoryOrder.push(row.repository);
				repositoryMap.set(row.repository, {
					repository: row.repository,
					total: 0,
					planned: 0,
					skippedExisting: 0,
					queued: 0,
					running: 0,
					completed: 0,
					skipped: 0,
					error: 0,
					processed: 0,
					remaining: 0,
				});
			}

			const repository = repositoryMap.get(row.repository)!;
			repository.total += 1;

			switch (row.status) {
				case 'queued':
					queued += 1;
					repository.queued += 1;
					break;
				case 'running':
					running += 1;
					repository.running += 1;
					repository.currentSha = row.sha;
					repository.currentMessage = row.message;
					currentRepository = row.repository;
					currentSha = row.sha;
					currentMessage = row.message;
					break;
				case 'completed':
					completed += 1;
					repository.completed += 1;
					break;
				case 'skipped':
					skipped += 1;
					repository.skipped += 1;
					if (row.reason === 'already-analyzed') {
						skippedExisting += 1;
						repository.skippedExisting += 1;
					}
					break;
				case 'error':
					error += 1;
					repository.error += 1;
					break;
			}
		}

		for (const repository of repositoryMap.values()) {
			repository.planned = repository.total - repository.skippedExisting;
			repository.processed = repository.completed + repository.skipped + repository.error;
			repository.remaining = repository.total - repository.processed;
		}

		const planned = total - skippedExisting;
		const processed = completed + skipped + error;
		const remaining = total - processed;
		const runtimeHandled = completed + error + (skipped - skippedExisting);
		const endReference = session.finishedAt ? new Date(session.finishedAt).getTime() : Date.now();
		const elapsedMs = Math.max(0, endReference - new Date(session.startedAt).getTime());
		const throughputPerMinute = computeManualAnalysisThroughput(runtimeHandled, elapsedMs);
		const etaMs = computeManualAnalysisEta(queued + running, throughputPerMinute);

		return {
			status: session.status,
			effectiveLimit: session.effectiveLimit,
			startedAt: session.startedAt,
			updatedAt: session.updatedAt,
			finishedAt: session.finishedAt,
			total,
			planned,
			skippedExisting,
			queued,
			running,
			completed,
			skipped,
			error,
			processed,
			remaining,
			elapsedMs,
			throughputPerMinute,
			etaMs,
			currentRepository,
			currentSha,
			currentMessage,
			repositories: repositoryOrder.map((repository) => repositoryMap.get(repository)!),
			commitRows: session.commitRows
				.slice()
				.sort((left, right) => left.sequence - right.sequence)
				.map(({ repoPath, ...row }) => row),
			recentEvents: session.recentEvents.slice(-MANUAL_ANALYSIS_EVENT_LIMIT),
		};
	}

	private postManualAnalysisSnapshot(targetPanel?: vscode.WebviewPanel): void {
		if (!this.manualAnalysisSession) {
			return;
		}

		const snapshot = this.buildManualAnalysisSnapshot(this.manualAnalysisSession);
		const message: MemoryExtensionToWebviewMessage = {
			type: 'memoryAnalysisSnapshot',
			snapshot,
		};

		if (targetPanel) {
			targetPanel.webview.postMessage(message);
			return;
		}

		this.postMessage(message);
	}

	private finishManualAnalysis(status: Extract<ManualAnalysisRunStatus, 'completed' | 'stopped'>): void {
		if (!this.manualAnalysisSession) {
			return;
		}

		this.manualAnalysisSession.status = status;
		this.manualAnalysisSession.finishedAt = new Date().toISOString();
		this.manualAnalysisSession.updatedAt = this.manualAnalysisSession.finishedAt;
		this.pushManualAnalysisEvent(this.manualAnalysisSession, {
			kind: 'state',
			message: status === 'completed' ? 'Manual analysis completed' : 'Manual analysis stopped',
		});
		this.postManualAnalysisSnapshot();

		const runtimeCount = this.manualAnalysisSession.commitRows.filter((row) => row.reason !== 'already-analyzed' && row.status !== 'queued' && row.status !== 'running').length;
		if (status === 'completed') {
			this.postMessage({
				type: 'memoryAnalysisComplete',
				count: runtimeCount,
			});
			return;
		}

		this.postMessage({
			type: 'memoryInfo',
			message: this.getManualAnalysisUiText().stopped,
		});
	}

	private pushManualAnalysisEvent(
		session: ManualAnalysisSession,
		event: Omit<ManualAnalysisEventEntry, 'id' | 'timestamp'>,
	): void {
		session.eventSequence += 1;
		session.recentEvents.push({
			id: `event-${session.eventSequence}`,
			timestamp: new Date().toISOString(),
			...event,
		});

		if (session.recentEvents.length > MANUAL_ANALYSIS_EVENT_LIMIT) {
			session.recentEvents = session.recentEvents.slice(-MANUAL_ANALYSIS_EVENT_LIMIT);
		}
	}

	private getCommitHeadline(message: string): string {
		return message.split('\n')[0] || message;
		let processed = 0;
	}
}
