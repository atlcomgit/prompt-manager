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
import { InstructionsPanel } from './components/InstructionsPanel';
import { memoryButtonStyles } from './components/buttonStyles';
import { MemoryDashboard } from './components/MemoryDashboard';
import { MemorySettingsWorkspace, type MemorySettingsWorkspaceTab } from './components/MemorySettingsWorkspace';
import { MemorySegmentedTabs } from './components/memoryUi';
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

	/* Hover для элементов списков коммитов и инструкций */
	.pm-memory-root [style*="cursor: pointer"]:hover {
		filter: brightness(0.97);
	}

	/* Плавный скроллбар */
	.pm-memory-root ::-webkit-scrollbar {
		width: 6px;
		height: 6px;
	}
	.pm-memory-root ::-webkit-scrollbar-track {
		background: transparent;
	}
	.pm-memory-root ::-webkit-scrollbar-thumb {
		background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
		border-radius: 999px;
	}
	.pm-memory-root ::-webkit-scrollbar-thumb:hover {
		background: color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
	}
`;

type Section = 'dashboard' | 'histories' | 'instructions' | 'settings';
type HistoryTab = 'commits' | 'search' | 'graph' | 'statistics';

const MEMORY_SECTIONS: Section[] = ['dashboard', 'histories', 'instructions', 'settings'];
const MEMORY_HISTORY_TABS: HistoryTab[] = ['commits', 'search', 'graph', 'statistics'];

const CODEMAP_BUSY_POLL_INTERVAL_MS = 1500;
const CODEMAP_IDLE_POLL_INTERVAL_MS = 5000;

export const MemoryApp: React.FC = () => {
	const t = useT();
	const [activeSection, setActiveSection] = useState<Section>('dashboard');
	const [activeHistoryTab, setActiveHistoryTab] = useState<HistoryTab>('commits');
	const [activeSettingsTab, setActiveSettingsTab] = useState<MemorySettingsWorkspaceTab>('history');

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

	const onRefreshDashboard = () => {
		vscode.postMessage({ type: 'getMemoryCommits', filter: { ...filter, limit: 50 } });
		vscode.postMessage({ type: 'requestManualAnalysisSnapshot' });
		onRequestStatistics();
		onRequestCodeMapInstructions();
		onRequestCodeMapStatistics();
		onRequestCodeMapActivity();
	};

	const onOpenHistories = (tab: HistoryTab = 'commits') => {
		setActiveSection('histories');
		setActiveHistoryTab(tab);
	};

	const onOpenInstructions = () => {
		setActiveSection('instructions');
	};

	const onOpenSettings = (tab: MemorySettingsWorkspaceTab = 'history') => {
		setActiveSection('settings');
		setActiveSettingsTab(tab);
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
		}
	}, [activeHistoryTab, activeSection]);

	useEffect(() => {
		if (activeSection !== 'instructions' && activeSection !== 'dashboard') {
			return;
		}

		onRequestCodeMapInstructions();
		onRequestCodeMapStatistics();
		onRequestCodeMapActivity();
	}, [activeSection]);

	useEffect(() => {
		if (activeSection !== 'dashboard') {
			return;
		}

		onRequestStatistics();
		vscode.postMessage({ type: 'requestManualAnalysisSnapshot' });
	}, [activeSection]);

	useEffect(() => {
		if (activeSection !== 'settings') {
			return;
		}

		onRequestSettings();
		onRequestCodeMapSettings();
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
		if (activeSection !== 'instructions' && activeSection !== 'dashboard') {
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
			<div style={styles.header}>
				<div style={styles.headerCard}>
					<div style={styles.headerCopy}>
						<div style={styles.headerEyebrow}>{t('memory.title')}</div>
						<h1 style={styles.headerTitle}>{t('memory.headline')}</h1>
						<div style={styles.headerDescription}>{t('memory.subtitle')}</div>
					</div>
					<div style={styles.headerTabs}>
						<MemorySegmentedTabs
							ariaLabel={t('memory.sections')}
							items={MEMORY_SECTIONS.map(section => ({ value: section, label: t(`memory.section.${section}`) }))}
							activeValue={activeSection}
							onChange={setActiveSection}
						/>
					</div>
				</div>
			</div>

			<div style={styles.messageHost}>
				{errorMessage ? (
					<div style={styles.errorBar}>{errorMessage}</div>
				) : statusMessage ? (
					<div style={styles.statusBar}>{statusMessage}</div>
				) : (
					<div style={styles.messagePlaceholder} />
				)}
			</div>

			<div style={styles.content}>
				{activeSection === 'dashboard' && (
					<MemoryDashboard
						statistics={statistics}
						recentCommits={commits}
						codeMapStatistics={codeMapStatistics}
						codeMapActivity={codeMapActivity}
						analysisSnapshot={analysisSnapshot}
						onOpenHistories={() => onOpenHistories('commits')}
						onOpenInstructions={onOpenInstructions}
						onOpenSettings={() => onOpenSettings('history')}
						onRunAnalysis={onRunAnalysis}
						onRefresh={onRefreshDashboard}
						t={t}
					/>
				)}

				{activeSection === 'histories' && (
					<div style={styles.sectionLayout}>
						<div style={styles.sectionCard}>
							<div style={styles.sectionHeader}>
								<div style={styles.sectionHeaderCopy}>
									<div style={styles.sectionEyebrow}>{t('memory.section.histories')}</div>
									<div style={styles.sectionTitle}>{t('memory.historiesHeadline')}</div>
								</div>
								<div style={styles.sectionHeaderControls}>
									<MemorySegmentedTabs
										ariaLabel={t('memory.historiesTabs')}
										items={MEMORY_HISTORY_TABS.map(tab => ({ value: tab, label: t(`memory.tab.${tab}`) }))}
										activeValue={activeHistoryTab}
										onChange={setActiveHistoryTab}
									/>
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
												onSearch={onSearch}
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
							</div>
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
						availableModels={availableModels}
						onSelectInstruction={onSelectCodeMapInstruction}
						onRefreshInstructions={onRequestCodeMapInstructions}
						onRefreshWorkspace={onRefreshCodeMapWorkspace}
						onRefreshInstruction={onRefreshCodeMapInstruction}
						onRefreshStatistics={onRequestCodeMapStatistics}
						onRefreshActivity={onRequestCodeMapActivity}
						onDeleteInstruction={onDeleteCodeMapInstruction}
						onDeleteObsolete={onDeleteObsoleteCodeMapInstructions}
						isRefreshing={codeMapIsBusy}
						t={t}
					/>
				)}

				{activeSection === 'settings' && (
					<MemorySettingsWorkspace
						activeTab={activeSettingsTab}
						onTabChange={setActiveSettingsTab}
						memorySettings={settings}
						codeMapSettings={codeMapSettings}
						availableModels={availableModels}
						onSaveMemorySettings={onSaveSettings}
						onRefreshMemorySettings={onRequestSettings}
						onSaveInstructionSettings={onSaveCodeMapSettings}
						onRefreshInstructionSettings={onRequestCodeMapSettings}
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
		background: 'var(--vscode-editor-background)',
	},
	// Контейнер шапки — фиксированный, без визуального шума.
	header: {
		padding: '20px 20px 12px',
		flexShrink: 0,
	},
	// Карточка шапки — плоская, акцент-полоска слева, градиент к акценту.
	headerCard: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: '20px',
		padding: '22px 24px',
		borderRadius: '14px',
		borderLeft: '4px solid var(--vscode-button-background)',
		border: '1px solid color-mix(in srgb, var(--vscode-foreground) 30%, transparent)',
		borderLeftWidth: '4px',
		borderLeftColor: 'var(--vscode-button-background)',
		background: 'linear-gradient(100deg, color-mix(in srgb, var(--vscode-button-background) 5%, var(--vscode-editor-background)), var(--vscode-editor-background) 60%)',
		boxShadow: '0 1px 4px 0 color-mix(in srgb, var(--vscode-foreground) 10%, transparent)',
		flexWrap: 'wrap',
	},
	headerCopy: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		minWidth: 0,
	},
	// Мелкий uppercase-лейбл над заголовком.
	headerEyebrow: {
		fontSize: '10px',
		textTransform: 'uppercase',
		letterSpacing: '0.1em',
		color: 'var(--vscode-button-background)',
		fontWeight: 700,
	},
	headerTitle: {
		margin: 0,
		fontSize: '24px',
		fontWeight: 800,
		lineHeight: 1.15,
		letterSpacing: '-0.02em',
		color: 'var(--vscode-foreground)',
	},
	headerDescription: {
		fontSize: '12px',
		lineHeight: 1.55,
		color: 'var(--vscode-descriptionForeground)',
		maxWidth: '60ch',
	},
	headerTabs: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		flexWrap: 'wrap',
		minWidth: 0,
	},
	headerActions: {
		display: 'flex',
		gap: '8px',
		flexWrap: 'wrap',
	},
	messageHost: {
		minHeight: '38px',
		padding: '0 20px 8px',
		flexShrink: 0,
	},
	statusBar: {
		padding: '8px 14px',
		background: 'color-mix(in srgb, var(--vscode-editorInfo-background) 84%, var(--vscode-editor-background) 16%)',
		color: 'var(--vscode-editorInfo-foreground)',
		borderRadius: '12px',
		border: '1px solid color-mix(in srgb, var(--vscode-editorInfo-foreground) 16%, transparent)',
		fontSize: '12px',
		height: '100%',
		boxSizing: 'border-box',
	},
	errorBar: {
		padding: '8px 14px',
		background: 'color-mix(in srgb, var(--vscode-inputValidation-errorBackground) 84%, var(--vscode-editor-background) 16%)',
		color: 'var(--vscode-inputValidation-errorForeground)',
		borderRadius: '12px',
		border: '1px solid color-mix(in srgb, var(--vscode-inputValidation-errorForeground) 16%, transparent)',
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
		minHeight: 0,
	},
	sectionLayout: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		padding: '20px',
		boxSizing: 'border-box',
	},
	// Карточка секции — тонкая рамка, лёгкая тень.
	sectionCard: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
		borderRadius: '14px',
		border: '1px solid color-mix(in srgb, var(--vscode-foreground) 30%, transparent)',
		boxShadow: '0 1px 4px 0 color-mix(in srgb, var(--vscode-foreground) 10%, transparent)',
		background: 'var(--vscode-editor-background)',
		overflow: 'hidden',
	},
	sectionHeader: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'flex-start',
		gap: '16px',
		padding: '16px 20px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent)',
		flexShrink: 0,
		flexWrap: 'wrap',
	},
	sectionHeaderCopy: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		minWidth: 0,
	},
	sectionEyebrow: {
		fontSize: '11px',
		textTransform: 'uppercase',
		letterSpacing: '0.08em',
		color: 'var(--vscode-descriptionForeground)',
	},
	sectionTitle: {
		fontSize: '18px',
		fontWeight: 700,
		lineHeight: 1.2,
	},
	sectionHeaderControls: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: '12px',
		flexWrap: 'wrap',
		minWidth: 0,
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
		borderRight: '1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent)',
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
