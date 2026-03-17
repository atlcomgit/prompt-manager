/**
 * MemoryApp — Root component for the Project Memory webview panel.
 * Provides sectioned navigation for histories and instructions.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';
import { useT } from '../shared/i18n';
import { CommitList } from './components/CommitList';
import { CommitDetail } from './components/CommitDetail';
import { AnalysisProgressOverlay } from './components/AnalysisProgressOverlay';
import { CommitDetailDialog } from './components/CommitDetailDialog';
import { SearchPanel } from './components/SearchPanel';
import { KnowledgeGraph } from './components/KnowledgeGraph';
import { StatisticsPanel } from './components/StatisticsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { InstructionsPanel } from './components/InstructionsPanel';
import { memoryButtonStyles } from './components/buttonStyles';
import { isManualAnalysisBusy, isManualAnalysisTerminal } from '../../utils/manualAnalysisRuntime';
import type {
	ManualAnalysisSnapshot,
	ManualAnalysisRunStatus,
	MemoryCommit,
	MemoryFileChange,
	MemoryAnalysis,
	MemoryAvailableModel,
	MemoryBugRelation,
	MemorySearchResult,
	MemoryStatistics,
	MemorySettings,
	KnowledgeGraphData,
	MemoryFilter,
	MemoryExtensionToWebviewMessage,
} from '../../types/memory';
import type {
	CodeMapActivity,
	CodeMapInstructionDetail,
	CodeMapInstructionListItem,
	CodeMapSettings,
	CodeMapStatistics,
} from '../../types/codemap';

const vscode = getVsCodeApi();

function sendMemoryDebugLog(scope: string, payload?: unknown): void {
	console.log(`[PromptManager/MemoryGraph/Webview] ${scope}`, payload ?? '');
	vscode.postMessage({ type: 'memoryDebugLog', scope, payload });
}

const MEMORY_APP_GLOBAL_STYLES = `
	.pm-memory-root button {
		appearance: none;
		-webkit-appearance: none;
		-webkit-text-fill-color: currentColor;
	}

	.pm-memory-root button:active,
	.pm-memory-root button:focus,
	.pm-memory-root button:focus-visible {
		-webkit-text-fill-color: currentColor;
		color: inherit;
	}

	.pm-memory-root button:active {
		filter: brightness(0.96);
	}
`;

type Section = 'histories' | 'instructions';
type HistoryTab = 'commits' | 'search' | 'graph' | 'statistics' | 'settings';

const CODEMAP_BUSY_POLL_INTERVAL_MS = 1500;
const CODEMAP_IDLE_POLL_INTERVAL_MS = 5000;

export const MemoryApp: React.FC = () => {
	const t = useT();
	const [activeSection, setActiveSection] = useState<Section>('histories');
	const [activeHistoryTab, setActiveHistoryTab] = useState<HistoryTab>('commits');

	// Commits state
	const [commits, setCommits] = useState<MemoryCommit[]>([]);
	const [totalCommits, setTotalCommits] = useState(0);
	const [selectedCommit, setSelectedCommit] = useState<MemoryCommit | null>(null);
	const [commitFileChanges, setCommitFileChanges] = useState<MemoryFileChange[]>([]);
	const [commitAnalysis, setCommitAnalysis] = useState<MemoryAnalysis | undefined>();
	const [commitBugRelations, setCommitBugRelations] = useState<MemoryBugRelation[]>([]);
	const [filter, setFilter] = useState<MemoryFilter>({});

	// Search state
	const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([]);
	const [searchQuery, setSearchQuery] = useState('');

	// Knowledge graph state
	const [graphData, setGraphData] = useState<KnowledgeGraphData | null>(null);

	// Statistics state
	const [statistics, setStatistics] = useState<MemoryStatistics | null>(null);

	// Settings state
	const [settings, setSettings] = useState<MemorySettings | null>(null);
	const [availableModels, setAvailableModels] = useState<MemoryAvailableModel[]>([]);
	const [codeMapInstructions, setCodeMapInstructions] = useState<CodeMapInstructionListItem[]>([]);
	const [selectedCodeMapInstructionId, setSelectedCodeMapInstructionId] = useState<number | null>(null);
	const [codeMapInstructionDetail, setCodeMapInstructionDetail] = useState<CodeMapInstructionDetail | null>(null);
	const [codeMapStatistics, setCodeMapStatistics] = useState<CodeMapStatistics | null>(null);
	const [codeMapSettings, setCodeMapSettings] = useState<CodeMapSettings | null>(null);
	const [codeMapActivity, setCodeMapActivity] = useState<CodeMapActivity | null>(null);
	const [shouldPollCodeMapActivity, setShouldPollCodeMapActivity] = useState(false);

	// Analysis runtime state
	const [analysisSnapshot, setAnalysisSnapshot] = useState<ManualAnalysisSnapshot | null>(null);
	const [isAnalysisOverlayOpen, setIsAnalysisOverlayOpen] = useState(false);
	const [analysisViewedCommitSha, setAnalysisViewedCommitSha] = useState<string | null>(null);
	const [isAnalysisDetailDialogOpen, setIsAnalysisDetailDialogOpen] = useState(false);
	const previousAnalysisStatusRef = useRef<ManualAnalysisRunStatus | null>(null);

	// Status messages
	const [statusMessage, setStatusMessage] = useState('');
	const [errorMessage, setErrorMessage] = useState('');

	// Filter options
	const [availableAuthors, setAvailableAuthors] = useState<string[]>([]);
	const [availableBranches, setAvailableBranches] = useState<string[]>([]);
	const [availableCategories, setAvailableCategories] = useState<string[]>([]);
	const [availableRepositories, setAvailableRepositories] = useState<string[]>([]);

	// Handle incoming messages from extension
	const handleMessage = useCallback((msg: MemoryExtensionToWebviewMessage) => {
		switch (msg.type) {
			case 'memoryCommits':
				setCommits(msg.commits);
				setTotalCommits(msg.total);
				break;
			case 'memoryCommitDetail':
				setSelectedCommit(msg.commit);
				setCommitFileChanges(msg.fileChanges);
				setCommitAnalysis(msg.analysis);
				setCommitBugRelations(msg.bugRelations || []);
				break;
			case 'memorySearchResults':
				setSearchResults(msg.results);
				setSearchQuery(msg.query);
				break;
			case 'memorySettings':
				setSettings(msg.settings);
				break;
			case 'memoryAvailableModels':
				setAvailableModels(msg.models);
				break;
			case 'codeMapInstructions':
				setCodeMapInstructions(msg.instructions);
				if (msg.instructions.length === 0) {
					setSelectedCodeMapInstructionId(null);
					setCodeMapInstructionDetail(null);
					break;
				}
				if (!selectedCodeMapInstructionId || !msg.instructions.some(item => item.id === selectedCodeMapInstructionId)) {
					setSelectedCodeMapInstructionId(msg.instructions[0].id);
					setCodeMapInstructionDetail(null);
				}
				break;
			case 'codeMapInstructionDetail':
				setCodeMapInstructionDetail(msg.detail);
				break;
			case 'codeMapStatistics':
				setCodeMapStatistics(msg.statistics);
				break;
			case 'codeMapSettings':
				setCodeMapSettings(msg.settings);
				break;
			case 'codeMapActivity':
				setCodeMapActivity(msg.activity);
				break;
			case 'memoryStatistics':
				setStatistics(msg.statistics);
				break;
			case 'memoryKnowledgeGraph':
				sendMemoryDebugLog('memoryApp:receivedKnowledgeGraph', {
					nodes: msg.data.nodes.length,
					edges: msg.data.edges.length,
					summary: msg.data.summary,
					sampleNodeIds: msg.data.nodes.slice(0, 5).map(node => node.id),
				});
				setGraphData(msg.data);
				break;
			case 'memoryCategories':
				setAvailableCategories(msg.categories);
				break;
			case 'memoryAuthors':
				setAvailableAuthors(msg.authors);
				break;
			case 'memoryBranches':
				setAvailableBranches(msg.branches);
				break;
			case 'memoryRepositories':
				setAvailableRepositories(msg.repositories);
				break;
			case 'memoryExportReady':
				downloadExport(msg.format, msg.data);
				break;
			case 'memoryAnalysisSnapshot':
				setAnalysisSnapshot(msg.snapshot);
				if (!previousAnalysisStatusRef.current && (isManualAnalysisBusy(msg.snapshot.status) || msg.snapshot.status === 'paused')) {
					setIsAnalysisOverlayOpen(true);
				}
				break;
			case 'memoryAnalysisComplete':
				setStatusMessage(t('memory.analysisComplete').replace('{count}', String(msg.count)));
				break;
			case 'memoryError':
				sendMemoryDebugLog('memoryApp:error', { activeSection, activeHistoryTab, message: msg.message });
				setErrorMessage(msg.message);
				setTimeout(() => setErrorMessage(''), 5000);
				break;
			case 'memoryInfo':
				setStatusMessage(msg.message);
				setTimeout(() => setStatusMessage(''), 3000);
				break;
			case 'memoryCleared':
				setCommits([]);
				setTotalCommits(0);
				setSelectedCommit(null);
				setSearchResults([]);
				setGraphData(null);
				setStatistics(null);
				setStatusMessage(t('memory.cleared'));
				break;
		}
	}, [activeHistoryTab, activeSection, selectedCodeMapInstructionId, t]);

	useMessageListener(handleMessage);

	// On mount, notify extension that webview is ready
	useEffect(() => {
		sendMemoryDebugLog('memoryApp:ready', { userAgent: navigator.userAgent });
		vscode.postMessage({ type: 'memoryReady' });
		vscode.postMessage({ type: 'requestManualAnalysisSnapshot' });
		vscode.postMessage({ type: 'getMemoryAuthors' });
		vscode.postMessage({ type: 'getMemoryBranches' });
		vscode.postMessage({ type: 'getMemoryCategories' });
		vscode.postMessage({ type: 'getMemoryRepositories' });
		vscode.postMessage({ type: 'getCodeMapInstructions' });
		vscode.postMessage({ type: 'getCodeMapStatistics' });
		vscode.postMessage({ type: 'getCodeMapSettings' });
		vscode.postMessage({ type: 'getCodeMapActivity' });
	}, []);

	// Request commits when filter changes
	useEffect(() => {
		vscode.postMessage({ type: 'getMemoryCommits', filter });
	}, [filter]);

	useEffect(() => {
		const previousStatus = previousAnalysisStatusRef.current;
		const nextStatus = analysisSnapshot?.status ?? null;

		if (previousStatus && nextStatus && previousStatus !== nextStatus && isManualAnalysisTerminal(nextStatus)) {
			vscode.postMessage({ type: 'getMemoryCommits', filter });
			vscode.postMessage({ type: 'getMemoryStatistics' });
		}

		previousAnalysisStatusRef.current = nextStatus;
	}, [analysisSnapshot?.status, filter]);

	/** Trigger file download for exported data */
	const downloadExport = (format: string, data: string) => {
		const blob = new Blob([data], { type: format === 'json' ? 'application/json' : 'text/csv' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `project-memory.${format}`;
		a.click();
		URL.revokeObjectURL(url);
	};

	/** Handle commit selection */
	const onSelectCommit = (sha: string) => {
		vscode.postMessage({ type: 'getMemoryCommitDetail', sha });
	};

	/** Open file from commit tree */
	const onOpenCommitFile = (repository: string, filePath: string) => {
		vscode.postMessage({ type: 'openMemoryFile', repository, filePath });
	};

	/** Handle search */
	const onSearch = (query: string) => {
		vscode.postMessage({ type: 'searchMemory', query, filter });
	};

	/** Handle commit deletion */
	const onDeleteCommit = (sha: string) => {
		vscode.postMessage({ type: 'deleteMemoryCommit', sha });
		if (selectedCommit?.sha === sha) {
			setSelectedCommit(null);
		}
	};

	/** Handle clear all */
	const onClearAll = () => {
		vscode.postMessage({ type: 'clearMemory' });
	};

	/** Handle manual analysis */
	const onRunAnalysis = () => {
		setIsAnalysisOverlayOpen(true);
		vscode.postMessage({ type: 'requestManualAnalysisSnapshot' });
	};

	const onPauseAnalysis = () => {
		vscode.postMessage({ type: 'pauseManualAnalysis' });
	};

	const onResumeAnalysis = () => {
		vscode.postMessage({ type: 'resumeManualAnalysis' });
	};

	const onStopAnalysis = () => {
		vscode.postMessage({ type: 'stopManualAnalysis' });
	};

	/** Handle export */
	const onExport = (format: 'csv' | 'json') => {
		vscode.postMessage({ type: 'exportMemoryData', format, filter });
	};

	/** Handle settings save */
	const onSaveSettings = (newSettings: Partial<MemorySettings>) => {
		vscode.postMessage({ type: 'saveMemorySettings', settings: newSettings });
	};

	/** Request knowledge graph */
	const onRequestGraph = (repository?: string) => {
		sendMemoryDebugLog('memoryApp:requestGraph', {
			activeTab: activeHistoryTab,
			repository: repository || null,
		});
		vscode.postMessage({ type: 'getKnowledgeGraph', repository });
	};

	/** Request statistics */
	const onRequestStatistics = () => {
		vscode.postMessage({ type: 'getMemoryStatistics' });
	};

	/** Request settings */
	const onRequestSettings = () => {
		vscode.postMessage({ type: 'getMemorySettings' });
	};

	const onRequestCodeMapInstructions = () => {
		vscode.postMessage({ type: 'getCodeMapInstructions' });
	};

	const onRequestCodeMapDetail = (id: number) => {
		setSelectedCodeMapInstructionId(id);
		vscode.postMessage({ type: 'getCodeMapInstructionDetail', id });
	};

	const onRequestCodeMapStatistics = () => {
		vscode.postMessage({ type: 'getCodeMapStatistics' });
	};

	const onRequestCodeMapActivity = () => {
		vscode.postMessage({ type: 'getCodeMapActivity' });
	};

	const onRequestCodeMapSettings = () => {
		vscode.postMessage({ type: 'getCodeMapSettings' });
	};

	const onSelectCodeMapInstruction = (id: number) => {
		setSelectedCodeMapInstructionId(id);
	};

	const onSaveCodeMapSettings = (newSettings: Partial<CodeMapSettings>) => {
		vscode.postMessage({ type: 'saveCodeMapSettings', settings: newSettings });
	};

	const onRefreshCodeMapWorkspace = () => {
		setShouldPollCodeMapActivity(true);
		vscode.postMessage({ type: 'refreshCodeMapWorkspace' });
	};

	const onRefreshCodeMapInstruction = (id: number) => {
		setShouldPollCodeMapActivity(true);
		vscode.postMessage({ type: 'refreshCodeMapInstruction', id });
	};

	const onDeleteCodeMapInstruction = (id: number) => {
		if (selectedCodeMapInstructionId === id) {
			setSelectedCodeMapInstructionId(null);
			setCodeMapInstructionDetail(null);
		}
		vscode.postMessage({ type: 'deleteCodeMapInstruction', id });
	};

	const onDeleteObsoleteCodeMapInstructions = () => {
		if (selectedCodeMapInstructionId && codeMapInstructions.some(item => item.id === selectedCodeMapInstructionId && item.isObsolete)) {
			setSelectedCodeMapInstructionId(null);
			setCodeMapInstructionDetail(null);
		}
		vscode.postMessage({ type: 'deleteObsoleteCodeMapInstructions' });
	};

	const codeMapIsBusy = Boolean(
		codeMapActivity && (
			codeMapActivity.runtime.isProcessing
			|| codeMapActivity.runtime.pendingCount > 0
			|| codeMapActivity.runtime.queuedCount > 0
			|| codeMapActivity.runtime.runningCount > 0
		),
	);

	const analysisButtonLabel = (() => {
		if (!analysisSnapshot) {
			return `▶ ${t('memory.runAnalysis')}`;
		}

		if (analysisSnapshot.status === 'paused') {
			return `⏸ ${analysisSnapshot.processed}/${analysisSnapshot.total}`;
		}

		if (isManualAnalysisBusy(analysisSnapshot.status)) {
			return `⏳ ${analysisSnapshot.processed}/${analysisSnapshot.total}`;
		}

		return `▶ ${t('memory.runAnalysis')}`;
	})();

	const analysisDetailCommit = analysisViewedCommitSha && selectedCommit?.sha === analysisViewedCommitSha
		? selectedCommit
		: null;

	// Fetch tab-specific data on tab change
	useEffect(() => {
		if (activeSection !== 'histories') {
			return;
		}

		switch (activeHistoryTab) {
			case 'graph':
				sendMemoryDebugLog('memoryApp:tabChanged', { activeTab: activeHistoryTab });
				onRequestGraph();
				break;
			case 'statistics':
				onRequestStatistics();
				break;
			case 'settings':
				onRequestSettings();
				break;
		}
	}, [activeHistoryTab, activeSection]);

	useEffect(() => {
		if (activeSection !== 'instructions') {
			return;
		}

		onRequestCodeMapInstructions();
		onRequestCodeMapStatistics();
		onRequestCodeMapSettings();
		onRequestCodeMapActivity();
	}, [activeSection]);

	useEffect(() => {
		if (selectedCodeMapInstructionId) {
			vscode.postMessage({ type: 'getCodeMapInstructionDetail', id: selectedCodeMapInstructionId });
		}
	}, [selectedCodeMapInstructionId]);

	useEffect(() => {
		if (!codeMapIsBusy) {
			const timeout = window.setTimeout(() => {
				setShouldPollCodeMapActivity(false);
			}, shouldPollCodeMapActivity ? 2000 : 0);
			return () => window.clearTimeout(timeout);
		}

		setShouldPollCodeMapActivity(true);
		return undefined;
	}, [codeMapIsBusy, shouldPollCodeMapActivity]);

	useEffect(() => {
		if (activeSection !== 'instructions') {
			return;
		}

		const tick = () => {
			onRequestCodeMapActivity();
			onRequestCodeMapStatistics();
			onRequestCodeMapInstructions();
			if (selectedCodeMapInstructionId) {
				vscode.postMessage({ type: 'getCodeMapInstructionDetail', id: selectedCodeMapInstructionId });
			}
		};

		tick();
		const interval = window.setInterval(
			tick,
			shouldPollCodeMapActivity ? CODEMAP_BUSY_POLL_INTERVAL_MS : CODEMAP_IDLE_POLL_INTERVAL_MS,
		);
		return () => window.clearInterval(interval);
	}, [activeSection, selectedCodeMapInstructionId, shouldPollCodeMapActivity]);

	return (
		<div style={styles.container} className="pm-memory-root">
			<style>{MEMORY_APP_GLOBAL_STYLES}</style>
			{/* Header with sections */}
			<div style={styles.header}>
				<div style={styles.tabs}>
					{(['histories', 'instructions'] as Section[]).map(section => (
						<button
							key={section}
							style={{
								...memoryButtonStyles.tab,
								...(activeSection === section ? memoryButtonStyles.tabActive : {}),
							}}
							onClick={() => setActiveSection(section)}
						>
							{t(`memory.section.${section}`)}
						</button>
					))}
				</div>
			</div>

			{/* Status / error messages */}
			<div style={styles.messageHost}>
				{errorMessage ? (
					<div style={styles.errorBar}>{errorMessage}</div>
				) : statusMessage ? (
					<div style={styles.statusBar}>{statusMessage}</div>
				) : (
					<div style={styles.messagePlaceholder} />
				)}
			</div>

			{/* Tab content */}
			<div style={styles.content}>
				{activeSection === 'histories' && (
					<div style={styles.sectionLayout}>
						<div style={styles.sectionHeader}>
							<div style={styles.tabs}>
								{(['commits', 'search', 'graph', 'statistics', 'settings'] as HistoryTab[]).map(tab => (
									<button
										key={tab}
										style={{
											...memoryButtonStyles.tab,
											...(activeHistoryTab === tab ? memoryButtonStyles.tabActive : {}),
										}}
										onClick={() => setActiveHistoryTab(tab)}
									>
										{t(`memory.tab.${tab}`)}
									</button>
								))}
							</div>
							<div style={styles.headerActions}>
								<button
									style={memoryButtonStyles.secondary}
									onClick={onRunAnalysis}
									title={t('memory.runAnalysis')}
								>
									{analysisButtonLabel}
								</button>
								<button
									style={memoryButtonStyles.secondary}
									onClick={() => onExport('json')}
									title={t('memory.export')}
								>
									📥 JSON
								</button>
								<button
									style={memoryButtonStyles.secondary}
									onClick={() => onExport('csv')}
									title={t('memory.export')}
								>
									📥 CSV
								</button>
							</div>
						</div>
						<div style={styles.sectionContent}>
							{activeHistoryTab === 'commits' && (
								<div style={styles.splitViewContainer}>
									<div style={styles.splitView}>
										<div style={styles.listPane}>
											<CommitList
												commits={commits}
												total={totalCommits}
												filter={filter}
												onFilterChange={setFilter}
												onSelectCommit={onSelectCommit}
												onDeleteCommit={onDeleteCommit}
												selectedSha={selectedCommit?.sha}
												authors={availableAuthors}
												branches={availableBranches}
												categories={availableCategories}
												repositories={availableRepositories}
												t={t}
											/>
										</div>
										<div style={styles.detailPane}>
											{selectedCommit ? (
												<CommitDetail
													commit={selectedCommit}
													fileChanges={commitFileChanges}
													analysis={commitAnalysis}
													bugRelations={commitBugRelations}
													t={t}
													onOpenFile={onOpenCommitFile}
												/>
											) : (
												<div style={styles.placeholder}>{t('memory.selectCommit')}</div>
											)}
										</div>
									</div>
									<AnalysisProgressOverlay
										open={isAnalysisOverlayOpen}
										snapshot={analysisSnapshot}
										selectedCommitSha={analysisViewedCommitSha}
										onClose={() => setIsAnalysisOverlayOpen(false)}
										onStart={() => {
											setIsAnalysisOverlayOpen(true);
											vscode.postMessage({ type: 'runManualAnalysis' });
										}}
										onPause={onPauseAnalysis}
										onResume={onResumeAnalysis}
										onStop={onStopAnalysis}
										onOpenCommit={(sha) => {
											setAnalysisViewedCommitSha(sha);
											setIsAnalysisDetailDialogOpen(true);
											onSelectCommit(sha);
										}}
										t={t}
									/>
									<CommitDetailDialog
										open={isAnalysisDetailDialogOpen}
										title={t('memory.analysisOpenDetails')}
										loading={Boolean(analysisViewedCommitSha) && !analysisDetailCommit}
										commit={analysisDetailCommit}
										fileChanges={analysisDetailCommit ? commitFileChanges : []}
										analysis={analysisDetailCommit ? commitAnalysis : undefined}
										bugRelations={analysisDetailCommit ? commitBugRelations : []}
										onClose={() => setIsAnalysisDetailDialogOpen(false)}
										onOpenFile={onOpenCommitFile}
										t={t}
									/>
								</div>
							)}

							{activeHistoryTab === 'search' && (
								<SearchPanel
									results={searchResults}
									query={searchQuery}
									onSearch={onSearch}
									onSelectCommit={onSelectCommit}
									t={t}
								/>
							)}

							{activeHistoryTab === 'graph' && (
								<KnowledgeGraph
									data={graphData}
									repositories={availableRepositories}
									onRequestGraph={onRequestGraph}
									t={t}
								/>
							)}

							{activeHistoryTab === 'statistics' && (
								<StatisticsPanel
									statistics={statistics}
									availableModels={availableModels}
									onRefresh={onRequestStatistics}
									onClearAll={onClearAll}
									t={t}
								/>
							)}

							{activeHistoryTab === 'settings' && (
								<SettingsPanel
									settings={settings}
									availableModels={availableModels}
									onSave={onSaveSettings}
									onRefresh={onRequestSettings}
									t={t}
								/>
							)}
						</div>
					</div>
				)}

				{activeSection === 'instructions' && (
					<InstructionsPanel
						instructions={codeMapInstructions}
						selectedInstructionId={selectedCodeMapInstructionId}
						detail={codeMapInstructionDetail}
						statistics={codeMapStatistics}
						activity={codeMapActivity}
						settings={codeMapSettings}
						availableModels={availableModels}
						onSelectInstruction={onSelectCodeMapInstruction}
						onRefreshInstructions={onRequestCodeMapInstructions}
						onRefreshWorkspace={onRefreshCodeMapWorkspace}
						onRefreshInstruction={onRefreshCodeMapInstruction}
						onRefreshStatistics={onRequestCodeMapStatistics}
						onRefreshActivity={onRequestCodeMapActivity}
						onRefreshSettings={onRequestCodeMapSettings}
						onSaveSettings={onSaveCodeMapSettings}
						onDeleteInstruction={onDeleteCodeMapInstruction}
						onDeleteObsolete={onDeleteObsoleteCodeMapInstructions}
						isRefreshing={codeMapIsBusy}
						t={t}
					/>
				)}
			</div>
		</div>
	);
};

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		height: '100vh',
		color: 'var(--vscode-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: 'var(--vscode-font-size)',
	},
	header: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		padding: '8px 16px',
		borderBottom: '1px solid var(--vscode-panel-border)',
		flexShrink: 0,
	},
	tabs: {
		display: 'flex',
		gap: '8px',
		flexWrap: 'wrap',
	},
	headerActions: {
		display: 'flex',
		gap: '8px',
	},
	messageHost: {
		minHeight: '28px',
		flexShrink: 0,
	},
	statusBar: {
		padding: '4px 16px',
		background: 'var(--vscode-editorInfo-background)',
		color: 'var(--vscode-editorInfo-foreground)',
		fontSize: '12px',
		height: '100%',
		boxSizing: 'border-box',
	},
	errorBar: {
		padding: '4px 16px',
		background: 'var(--vscode-inputValidation-errorBackground)',
		color: 'var(--vscode-inputValidation-errorForeground)',
		fontSize: '12px',
		height: '100%',
		boxSizing: 'border-box',
	},
	messagePlaceholder: {
		height: '100%',
	},
	content: {
		flex: 1,
		overflow: 'hidden',
	},
	sectionLayout: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
	},
	sectionHeader: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: '12px',
		padding: '8px 16px',
		borderBottom: '1px solid var(--vscode-panel-border)',
		flexShrink: 0,
	},
	sectionContent: {
		flex: 1,
		overflow: 'hidden',
	},
	splitView: {
		display: 'flex',
		height: '100%',
	},
	splitViewContainer: {
		position: 'relative',
		height: '100%',
	},
	listPane: {
		width: '40%',
		minWidth: '280px',
		borderRight: '1px solid var(--vscode-panel-border)',
		overflow: 'auto',
	},
	detailPane: {
		flex: 1,
		overflow: 'auto',
	},
	placeholder: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		height: '100%',
		color: 'var(--vscode-descriptionForeground)',
	},
};
