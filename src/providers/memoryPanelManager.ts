/**
 * MemoryPanelManager — Opens a webview panel for managing project memory:
 * browsing commits, searching, viewing analysis, knowledge graph,
 * statistics, and settings.
 */

import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import type { MemoryDatabaseService } from '../services/memoryDatabaseService.js';
import type { MemoryContextService } from '../services/memoryContextService.js';
import type { MemoryEmbeddingService } from '../services/memoryEmbeddingService.js';
import type { MemoryAnalyzerService } from '../services/memoryAnalyzerService.js';
import type { MemoryGitHookService } from '../services/memoryGitHookService.js';
import type {
	MemoryWebviewToExtensionMessage,
	MemoryExtensionToWebviewMessage,
	MemorySettings,
	MemorySearchResult,
	DEFAULT_MEMORY_SETTINGS,
} from '../types/memory.js';

let currentPanel: vscode.WebviewPanel | undefined;

export class MemoryPanelManager {
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly db: MemoryDatabaseService,
		private readonly context: MemoryContextService,
		private readonly embedding: MemoryEmbeddingService,
		private readonly analyzer: MemoryAnalyzerService,
		private readonly gitHook: MemoryGitHookService,
	) { }

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
					await this.runManualAnalysis(panel, msg.limit || 50);
					break;
				}

				case 'getMemorySettings': {
					const config = vscode.workspace.getConfiguration('promptManager');
					const settings: MemorySettings = {
						enabled: config.get<boolean>('memory.enabled', true),
						aiModel: config.get<string>('memory.aiModel', 'gpt-4o'),
						analysisDepth: config.get<any>('memory.analysisDepth', 'standard'),
						diffLimit: config.get<number>('memory.diffLimit', 10000),
						maxRecords: config.get<number>('memory.maxRecords', 5000),
						retentionDays: config.get<number>('memory.retentionDays', 365),
						shortTermLimit: config.get<number>('memory.shortTermLimit', 50),
						autoCleanup: config.get<boolean>('memory.autoCleanup', true),
						notificationsEnabled: config.get<boolean>('memory.notifications.enabled', true),
						notificationType: config.get<any>('memory.notifications.type', 'statusbar'),
						embeddingsEnabled: config.get<boolean>('memory.embeddings.enabled', true),
						knowledgeGraphEnabled: config.get<boolean>('memory.knowledgeGraph.enabled', true),
						httpPort: config.get<number>('memory.httpPort', 0),
					};
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
					if (s.autoCleanup !== undefined) { await config.update('memory.autoCleanup', s.autoCleanup, true); }
					if (s.notificationsEnabled !== undefined) { await config.update('memory.notifications.enabled', s.notificationsEnabled, true); }
					if (s.notificationType !== undefined) { await config.update('memory.notifications.type', s.notificationType, true); }
					if (s.embeddingsEnabled !== undefined) { await config.update('memory.embeddings.enabled', s.embeddingsEnabled, true); }
					if (s.knowledgeGraphEnabled !== undefined) { await config.update('memory.knowledgeGraph.enabled', s.knowledgeGraphEnabled, true); }
					if (s.httpPort !== undefined) { await config.update('memory.httpPort', s.httpPort, true); }
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
					const graph = await this.db.getKnowledgeGraph(msg.repository);
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

				default:
					break;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
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
			type: 'memoryStatistics',
			statistics: stats,
		} as MemoryExtensionToWebviewMessage);

		const { commits, total } = await this.db.getCommits({ limit: 50 });
		panel.webview.postMessage({
			type: 'memoryCommits',
			commits,
			total,
		} as MemoryExtensionToWebviewMessage);
	}

	/** Run manual analysis of recent commits from git history */
	private async runManualAnalysis(
		panel: vscode.WebviewPanel,
		limit: number,
	): Promise<void> {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) { return; }

		const config = vscode.workspace.getConfiguration('promptManager');
		const depth = config.get<any>('memory.analysisDepth', 'standard');
		const diffLimit = config.get<number>('memory.diffLimit', 10000);

		let processed = 0;

		for (const folder of workspaceFolders) {
			const repoPath = folder.uri.fsPath;
			const shas = await this.gitHook.getCommitShas(repoPath, limit);
			const repoName = this.gitHook.getRepositoryName(repoPath);

			for (const sha of shas) {
				// Skip if already analysed
				const existing = await this.db.getCommit(sha);
				if (existing) { continue; }

				// Get commit data from git
				const commitData = await this.gitHook.getCommitData(repoPath, sha);
				if (!commitData) { continue; }

				processed++;
				panel.webview.postMessage({
					type: 'memoryAnalysisProgress',
					current: processed,
					total: shas.length,
					message: `Analyzing ${sha.substring(0, 7)}...`,
				} as MemoryExtensionToWebviewMessage);

				// Build payload
				const payload = {
					sha,
					author: commitData.author,
					email: commitData.email,
					date: commitData.date,
					branch: commitData.branch,
					repository: repoName,
					parentSha: commitData.parentSha,
					message: commitData.message,
					diff: commitData.diff,
					files: commitData.files,
				};

				// Classify commit type
				const commitType = this.analyzer.classifyCommitType(commitData.message);

				// Store commit
				await this.db.insertCommit({
					sha,
					author: commitData.author,
					email: commitData.email,
					date: commitData.date,
					branch: commitData.branch,
					repository: repoName,
					parentSha: commitData.parentSha,
					commitType,
					message: commitData.message,
				});

				// Run AI analysis
				try {
					const result = await this.analyzer.analyzeCommit(payload, depth, diffLimit);
					await this.db.insertAnalysis(result.analysis);
					await this.db.insertFileChanges(result.fileChanges);
					if (result.knowledgeNodes.length > 0) {
						await this.db.insertKnowledgeNodes(result.knowledgeNodes);
					}
					if (result.bugRelation) {
						await this.db.insertBugRelation(result.bugRelation);
					}

					// Generate embedding if available
					if (this.embedding.isReady()) {
						const text = `${commitData.message}\n${result.analysis.summary}\n${result.analysis.keywords.join(' ')}`;
						const vector = await this.embedding.generateEmbedding(text);
						if (vector) {
							await this.db.insertEmbedding({
								commitSha: sha,
								vector,
								text,
								createdAt: new Date().toISOString(),
							});
						}
					}
				} catch (err) {
					console.error(`[PromptManager/Memory] Analysis error for ${sha}:`, err);
				}
			}
		}

		panel.webview.postMessage({
			type: 'memoryAnalysisComplete',
			count: processed,
		} as MemoryExtensionToWebviewMessage);
	}

	dispose(): void {
		currentPanel?.dispose();
		currentPanel = undefined;
	}
}
