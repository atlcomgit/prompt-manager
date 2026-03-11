/**
 * MemoryApp — Root component for the Project Memory webview panel.
 * Provides tabbed navigation: Commits, Search, Knowledge Graph, Statistics, Settings.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';
import { useT } from '../shared/i18n';
import { CommitList } from './components/CommitList';
import { CommitDetail } from './components/CommitDetail';
import { SearchPanel } from './components/SearchPanel';
import { KnowledgeGraph } from './components/KnowledgeGraph';
import { StatisticsPanel } from './components/StatisticsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import type {
	MemoryCommit,
	MemoryFileChange,
	MemoryAnalysis,
	MemoryBugRelation,
	MemorySearchResult,
	MemoryStatistics,
	MemorySettings,
	KnowledgeGraphData,
	MemoryFilter,
	MemoryExtensionToWebviewMessage,
} from '../../types/memory';

const vscode = getVsCodeApi();

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

/** Available tabs */
type Tab = 'commits' | 'search' | 'graph' | 'statistics' | 'settings';

export const MemoryApp: React.FC = () => {
	const t = useT();
	const [activeTab, setActiveTab] = useState<Tab>('commits');

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

	// Analysis progress
	const [analysisProgress, setAnalysisProgress] = useState<{ current: number; total: number; message: string } | null>(null);

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
			case 'memoryStatistics':
				setStatistics(msg.statistics);
				break;
			case 'memoryKnowledgeGraph':
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
			case 'memoryAnalysisProgress':
				setAnalysisProgress({ current: msg.current, total: msg.total, message: msg.message });
				break;
			case 'memoryAnalysisComplete':
				setAnalysisProgress(null);
				setStatusMessage(t('memory.analysisComplete').replace('{count}', String(msg.count)));
				// Refresh data
				vscode.postMessage({ type: 'getMemoryCommits', filter });
				vscode.postMessage({ type: 'getMemoryStatistics' });
				break;
			case 'memoryError':
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
	}, [t, filter]);

	useMessageListener(handleMessage);

	// On mount, notify extension that webview is ready
	useEffect(() => {
		vscode.postMessage({ type: 'memoryReady' });
		vscode.postMessage({ type: 'getMemoryAuthors' });
		vscode.postMessage({ type: 'getMemoryBranches' });
		vscode.postMessage({ type: 'getMemoryCategories' });
		vscode.postMessage({ type: 'getMemoryRepositories' });
	}, []);

	// Request commits when filter changes
	useEffect(() => {
		vscode.postMessage({ type: 'getMemoryCommits', filter });
	}, [filter]);

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
	const onRunAnalysis = (limit: number) => {
		vscode.postMessage({ type: 'runManualAnalysis', limit });
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

	// Fetch tab-specific data on tab change
	useEffect(() => {
		switch (activeTab) {
			case 'graph':
				onRequestGraph();
				break;
			case 'statistics':
				onRequestStatistics();
				break;
			case 'settings':
				onRequestSettings();
				break;
		}
	}, [activeTab]);

	return (
		<div style={styles.container} className="pm-memory-root">
			<style>{MEMORY_APP_GLOBAL_STYLES}</style>
			{/* Header with tabs */}
			<div style={styles.header}>
				<div style={styles.tabs}>
					{(['commits', 'search', 'graph', 'statistics', 'settings'] as Tab[]).map(tab => (
						<button
							key={tab}
							style={{
								...styles.tab,
								...(activeTab === tab ? styles.tabActive : {}),
							}}
							onClick={() => setActiveTab(tab)}
						>
							{t(`memory.tab.${tab}`)}
						</button>
					))}
				</div>
				<div style={styles.headerActions}>
					<button
						style={styles.actionBtn}
						onClick={() => onRunAnalysis(50)}
						disabled={!!analysisProgress}
						title={t('memory.runAnalysis')}
					>
						{analysisProgress
							? `⏳ ${analysisProgress.current}/${analysisProgress.total}`
							: `▶ ${t('memory.runAnalysis')}`
						}
					</button>
					<button
						style={styles.actionBtn}
						onClick={() => onExport('json')}
						title={t('memory.export')}
					>
						📥 JSON
					</button>
					<button
						style={styles.actionBtn}
						onClick={() => onExport('csv')}
						title={t('memory.export')}
					>
						📥 CSV
					</button>
				</div>
			</div>

			{/* Status / error messages */}
			{statusMessage && <div style={styles.statusBar}>{statusMessage}</div>}
			{errorMessage && <div style={styles.errorBar}>{errorMessage}</div>}

			{/* Tab content */}
			<div style={styles.content}>
				{activeTab === 'commits' && (
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
				)}

				{activeTab === 'search' && (
					<SearchPanel
						results={searchResults}
						query={searchQuery}
						onSearch={onSearch}
						onSelectCommit={onSelectCommit}
						t={t}
					/>
				)}

				{activeTab === 'graph' && (
					<KnowledgeGraph
						data={graphData}
						repositories={availableRepositories}
						onRequestGraph={onRequestGraph}
						t={t}
					/>
				)}

				{activeTab === 'statistics' && (
					<StatisticsPanel
						statistics={statistics}
						onRefresh={onRequestStatistics}
						onClearAll={onClearAll}
						t={t}
					/>
				)}

				{activeTab === 'settings' && (
					<SettingsPanel
						settings={settings}
						onSave={onSaveSettings}
						onRefresh={onRequestSettings}
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
		gap: '4px',
	},
	tab: {
		background: 'transparent',
		border: '1px solid transparent',
		borderRadius: '4px',
		color: 'var(--vscode-foreground)',
		padding: '6px 12px',
		cursor: 'pointer',
		fontSize: '13px',
	},
	tabActive: {
		background: 'var(--vscode-button-secondaryBackground)',
		borderColor: 'var(--vscode-focusBorder)',
	},
	headerActions: {
		display: 'flex',
		gap: '4px',
	},
	actionBtn: {
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		border: 'none',
		borderRadius: '4px',
		padding: '4px 8px',
		cursor: 'pointer',
		fontSize: '12px',
	},
	statusBar: {
		padding: '4px 16px',
		background: 'var(--vscode-editorInfo-background)',
		color: 'var(--vscode-editorInfo-foreground)',
		fontSize: '12px',
	},
	errorBar: {
		padding: '4px 16px',
		background: 'var(--vscode-inputValidation-errorBackground)',
		color: 'var(--vscode-inputValidation-errorForeground)',
		fontSize: '12px',
	},
	content: {
		flex: 1,
		overflow: 'hidden',
	},
	splitView: {
		display: 'flex',
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
