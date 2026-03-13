import React, { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import {
	filterManualAnalysisRows,
	isManualAnalysisBusy,
	isManualAnalysisTerminal,
} from '../../../utils/manualAnalysisRuntime';
import type {
	ManualAnalysisCommitStatus,
	ManualAnalysisSnapshot,
} from '../../../types/memory';
import { memoryButtonStyles } from './buttonStyles';

interface Props {
	open: boolean;
	snapshot: ManualAnalysisSnapshot | null;
	selectedCommitSha?: string | null;
	onClose: () => void;
	onStart: () => void;
	onPause: () => void;
	onResume: () => void;
	onStop: () => void;
	onOpenCommit: (sha: string) => void;
	t: (key: string) => string;
}

type RowFilter = ManualAnalysisCommitStatus | 'all';

export const AnalysisProgressOverlay: React.FC<Props> = ({
	open,
	snapshot,
	selectedCommitSha,
	onClose,
	onStart,
	onPause,
	onResume,
	onStop,
	onOpenCommit,
	t,
}) => {
	const [statusFilter, setStatusFilter] = useState<RowFilter>('all');
	const [repositoryFilter, setRepositoryFilter] = useState('all');
	const logListRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open || !logListRef.current) {
			return;
		}

		logListRef.current.scrollTop = logListRef.current.scrollHeight;
	}, [open, snapshot?.recentEvents.length, snapshot?.updatedAt]);

	if (!open) {
		return null;
	}

	const rows = snapshot ? filterManualAnalysisRows(snapshot.commitRows, statusFilter, repositoryFilter) : [];
	const repositories = snapshot?.repositories.map((repository) => repository.repository) || [];
	const progressPercent = snapshot?.total ? Math.min(100, Math.round((snapshot.processed / snapshot.total) * 100)) : 0;
	const canStart = !snapshot || isManualAnalysisTerminal(snapshot.status);
	const canPause = snapshot?.status === 'running';
	const canResume = snapshot?.status === 'paused';
	const canStop = Boolean(snapshot && (snapshot.status === 'running' || snapshot.status === 'pausing' || snapshot.status === 'paused' || snapshot.status === 'stopping'));

	return (
		<div style={styles.backdrop}>
			<div style={styles.overlay}>
				<div style={styles.header}>
					<div>
						<h3 style={styles.title}>{t('memory.analysisOverlayTitle')}</h3>
						<div style={styles.subtitle}>{snapshot ? formatRunState(snapshot.status, t) : t('memory.analysisNoActive')}</div>
					</div>
					<div style={styles.headerActions}>
						<button
							style={{
								...memoryButtonStyles.primary,
								...(canStart ? {} : memoryButtonStyles.disabled),
							}}
							onClick={onStart}
							disabled={!canStart}
						>
							{t('memory.analysisStart')}
						</button>
						<button
							style={{
								...memoryButtonStyles.secondary,
								...(canPause ? {} : memoryButtonStyles.disabled),
							}}
							onClick={onPause}
							disabled={!canPause}
						>
							{t('memory.analysisPause')}
						</button>
						<button
							style={{
								...memoryButtonStyles.secondary,
								...(canResume ? {} : memoryButtonStyles.disabled),
							}}
							onClick={onResume}
							disabled={!canResume}
						>
							{t('memory.analysisResume')}
						</button>
						<button
							style={{
								...memoryButtonStyles.danger,
								...(canStop ? {} : memoryButtonStyles.disabled),
							}}
							onClick={onStop}
							disabled={!canStop}
						>
							{t('memory.analysisStop')}
						</button>
						<button style={memoryButtonStyles.secondary} onClick={onClose}>
							{t('common.close')}
						</button>
					</div>
				</div>

				{snapshot ? (
					<>
						<div style={styles.summarySection}>
							<div style={styles.progressRow}>
								<div style={styles.progressMeta}>
									<span>{t('memory.analysisProcessed')}: {snapshot.processed}/{snapshot.total}</span>
									<span>{t('memory.analysisRemaining')}: {snapshot.remaining}</span>
									{snapshot.currentRepository && snapshot.currentSha && (
										<span>{t('memory.analysisCurrent')}: {snapshot.currentRepository} {snapshot.currentSha.substring(0, 7)}</span>
									)}
								</div>
								<div style={styles.progressTrack}>
									<div style={{ ...styles.progressFill, width: `${progressPercent}%` }} />
								</div>
							</div>

							<div style={styles.metricsGrid}>
								<MetricCard label={t('memory.analysisStatus')} value={formatRunState(snapshot.status, t)} />
								<MetricCard label={t('memory.analysisElapsed')} value={formatDuration(snapshot.elapsedMs)} />
								<MetricCard label={t('memory.analysisEta')} value={snapshot.etaMs ? formatDuration(snapshot.etaMs) : t('memory.analysisUnknown')} />
								<MetricCard label={t('memory.analysisThroughput')} value={`${snapshot.throughputPerMinute}/min`} />
								<MetricCard label={t('memory.analysisPlanned')} value={String(snapshot.planned)} />
								<MetricCard label={t('memory.analysisSkippedExisting')} value={String(snapshot.skippedExisting)} />
							</div>
						</div>

						<div style={styles.section}>
							<div style={styles.sectionHeader}>{t('memory.analysisRepositories')}</div>
							<div style={styles.tableScroll}>
								<table style={styles.tableFixed}>
									<thead>
										<tr>
											<th style={styles.tableHead}>{t('memory.repository')}</th>
											<th style={styles.tableHead}>{t('memory.analysisTotal')}</th>
											<th style={styles.tableHead}>{t('memory.analysisPlanned')}</th>
											<th style={styles.tableHead}>{t('memory.analysisSkippedExisting')}</th>
											<th style={styles.tableHead}>{t('memory.analysisStatusQueued')}</th>
											<th style={styles.tableHead}>{t('memory.analysisStatusRunning')}</th>
											<th style={styles.tableHead}>{t('memory.analysisStatusCompleted')}</th>
											<th style={styles.tableHead}>{t('memory.analysisStatusSkipped')}</th>
											<th style={styles.tableHead}>{t('memory.analysisStatusError')}</th>
											<th style={styles.tableHeadCurrent}>{t('memory.analysisCurrent')}</th>
										</tr>
									</thead>
									<tbody>
										{snapshot.repositories.map((repository) => {
											const currentLabel = repository.currentSha
												? [repository.currentSha.substring(0, 7), repository.currentMessage || ''].filter(Boolean).join(' ')
												: '—';

											return (
											<tr key={repository.repository}>
												<td style={styles.tableCellStrong}>{repository.repository}</td>
												<td style={styles.tableCell}>{repository.total}</td>
												<td style={styles.tableCell}>{repository.planned}</td>
												<td style={styles.tableCell}>{repository.skippedExisting}</td>
												<td style={styles.tableCell}>{repository.queued}</td>
												<td style={styles.tableCell}>{repository.running}</td>
												<td style={styles.tableCell}>{repository.completed}</td>
												<td style={styles.tableCell}>{repository.skipped}</td>
												<td style={styles.tableCell}>{repository.error}</td>
												<td style={styles.tableCellCurrent} title={currentLabel}>
													<div style={styles.ellipsisText}>{currentLabel}</div>
												</td>
											</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						</div>

						<div style={styles.eventsSection}>
							<div style={styles.sectionHeaderRow}>
								<div style={styles.sectionHeader}>{t('memory.analysisEvents')}</div>
								<div style={styles.filtersRow}>
									<select
										style={styles.filterSelect}
										value={statusFilter}
										onChange={(event) => setStatusFilter(event.target.value as RowFilter)}
									>
										<option value="all">{t('memory.analysisStatusAll')}</option>
										<option value="queued">{t('memory.analysisStatusQueued')}</option>
										<option value="running">{t('memory.analysisStatusRunning')}</option>
										<option value="completed">{t('memory.analysisStatusCompleted')}</option>
										<option value="skipped">{t('memory.analysisStatusSkipped')}</option>
										<option value="error">{t('memory.analysisStatusError')}</option>
									</select>
									<select
										style={styles.filterSelect}
										value={repositoryFilter}
										onChange={(event) => setRepositoryFilter(event.target.value)}
									>
										<option value="all">{t('memory.allRepositories')}</option>
										{repositories.map((repository) => (
											<option key={repository} value={repository}>{repository}</option>
										))}
									</select>
								</div>
							</div>
							<div style={styles.tableScrollLarge}>
								<table style={styles.table}>
									<thead>
										<tr>
											<th style={styles.tableHead}>SHA</th>
											<th style={styles.tableHead}>{t('memory.repository')}</th>
											<th style={styles.tableHead}>{t('memory.branch')}</th>
											<th style={styles.tableHead}>{t('memory.analysisMessage')}</th>
											<th style={styles.tableHead}>{t('memory.analysisStatus')}</th>
											<th style={styles.tableHead}>{t('memory.analysisReason')}</th>
											<th style={styles.tableHead}>{t('memory.analysisFiles')}</th>
											<th style={styles.tableHead}>{t('memory.analysisDiff')}</th>
											<th style={styles.tableHead}>{t('memory.analysisDuration')}</th>
											<th style={styles.tableHead}>{t('memory.categoriesLabel')}</th>
											<th style={styles.tableHead}>Impact</th>
											<th style={styles.tableHead}>{t('memory.analysisOpenDetails')}</th>
										</tr>
									</thead>
									<tbody>
										{rows.length === 0 ? (
											<tr>
												<td style={styles.emptyCell} colSpan={12}>{t('memory.analysisNoRows')}</td>
											</tr>
										) : rows.map((row) => (
											<tr key={row.id} style={row.sha === selectedCommitSha ? styles.selectedRow : undefined}>
												<td style={styles.tableCellMono}>{row.sha.substring(0, 7)}</td>
												<td style={styles.tableCell}>{row.repository}</td>
												<td style={styles.tableCell}>{row.branch || '—'}</td>
												<td style={styles.tableCellWide}>{row.message || t('memory.analysisUnknown')}</td>
												<td style={styles.tableCell}><span style={statusBadgeStyles(row.status)}>{formatCommitStatus(row.status, t)}</span></td>
												<td style={styles.tableCell}>{row.reason || '—'}</td>
												<td style={styles.tableCell}>{row.fileCount || '—'}</td>
												<td style={styles.tableCell}>{row.diffBytes ? formatBytes(row.diffBytes) : '—'}</td>
												<td style={styles.tableCell}>{row.durationMs ? formatDuration(row.durationMs) : '—'}</td>
												<td style={styles.tableCell}>{row.categories.join(', ') || '—'}</td>
												<td style={styles.tableCell}>{row.architectureImpactScore ?? '—'}</td>
												<td style={styles.tableCell}>
													<button
														style={{
															...memoryButtonStyles.link,
															...(row.isStored ? {} : memoryButtonStyles.disabled),
														}}
														onClick={() => onOpenCommit(row.sha)}
														disabled={!row.isStored}
													>
														{t('memory.analysisOpenDetails')}
													</button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>

						<div style={styles.footerSection}>
							<div style={styles.sectionHeader}>{t('memory.analysisRecentEvents')}</div>
							<div ref={logListRef} style={styles.logList}>
								{snapshot.recentEvents.length === 0 ? (
									<div style={styles.logEmpty}>{t('memory.analysisNoEvents')}</div>
								) : snapshot.recentEvents.map((event) => (
									<div key={event.id} style={styles.logItem}>
										<span style={styles.logTime}>{formatClock(event.timestamp)}</span>
										<span style={eventKindStyles(event.kind)}>{event.kind}</span>
										<span>{event.message}</span>
									</div>
								))}
							</div>
						</div>
					</>
				) : (
					<div style={styles.emptyState}>
						<div style={styles.emptyTitle}>{t('memory.analysisNoActive')}</div>
						<div style={styles.emptyText}>{t('memory.analysisEmptyDescription')}</div>
						<button style={memoryButtonStyles.primary} onClick={onStart}>{t('memory.analysisStart')}</button>
					</div>
				)}
			</div>
		</div>
	);
};

const MetricCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
	<div style={styles.metricCard}>
		<div style={styles.metricLabel}>{label}</div>
		<div style={styles.metricValue}>{value}</div>
	</div>
);

function formatDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m ${seconds}s`;
	}

	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}

	return `${seconds}s`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}

	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}

	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatClock(timestamp: string): string {
	const date = new Date(timestamp);
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatRunState(status: ManualAnalysisSnapshot['status'], t: Props['t']): string {
	const keyMap: Record<ManualAnalysisSnapshot['status'], string> = {
		idle: 'memory.analysisUnknown',
		running: 'memory.analysisRunStateRunning',
		pausing: 'memory.analysisRunStatePausing',
		paused: 'memory.analysisRunStatePaused',
		stopping: 'memory.analysisRunStateStopping',
		stopped: 'memory.analysisRunStateStopped',
		completed: 'memory.analysisRunStateCompleted',
	};

	return t(keyMap[status]);
}

function formatCommitStatus(status: ManualAnalysisCommitStatus, t: Props['t']): string {
	const keyMap: Record<ManualAnalysisCommitStatus, string> = {
		queued: 'memory.analysisStatusQueued',
		running: 'memory.analysisStatusRunning',
		completed: 'memory.analysisStatusCompleted',
		skipped: 'memory.analysisStatusSkipped',
		error: 'memory.analysisStatusError',
	};

	return t(keyMap[status]);
}

function statusBadgeStyles(status: ManualAnalysisCommitStatus): CSSProperties {
	const palette: Record<ManualAnalysisCommitStatus, { background: string; color: string }> = {
		queued: { background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)' },
		running: { background: 'var(--vscode-textLink-foreground)', color: 'var(--vscode-editor-background)' },
		completed: { background: 'var(--vscode-testing-iconPassed)', color: 'var(--vscode-editor-background)' },
		skipped: { background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)' },
		error: { background: 'var(--vscode-errorForeground)', color: 'var(--vscode-editor-background)' },
	};

	return {
		padding: '2px 8px',
		borderRadius: '999px',
		fontSize: '11px',
		fontWeight: 600,
		...palette[status],
	};
}

function eventKindStyles(kind: 'state' | 'info' | 'skip' | 'error'): CSSProperties {
	const palette: Record<'state' | 'info' | 'skip' | 'error', CSSProperties> = {
		state: { color: 'var(--vscode-textLink-foreground)' },
		info: { color: 'var(--vscode-descriptionForeground)' },
		skip: { color: 'var(--vscode-editorWarning-foreground)' },
		error: { color: 'var(--vscode-errorForeground)' },
	};

	return {
		fontSize: '11px',
		fontWeight: 700,
		textTransform: 'uppercase',
		minWidth: '42px',
		...palette[kind],
	};
}

const styles: Record<string, CSSProperties> = {
	backdrop: {
		position: 'absolute',
		inset: 0,
		background: 'color-mix(in srgb, var(--vscode-editor-background) 86%, transparent)',
		backdropFilter: 'blur(2px)',
		zIndex: 50,
		padding: '20px',
		display: 'flex',
		alignItems: 'stretch',
		justifyContent: 'center',
	},
	overlay: {
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '10px',
		boxShadow: '0 18px 50px rgba(0, 0, 0, 0.28)',
		width: 'min(1400px, 100%)',
		height: '100%',
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
	},
	header: {
		display: 'flex',
		justifyContent: 'space-between',
		gap: '16px',
		padding: '18px 20px 14px',
		borderBottom: '1px solid var(--vscode-panel-border)',
	},
	title: {
		margin: 0,
		fontSize: '18px',
	},
	subtitle: {
		marginTop: '6px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
	},
	headerActions: {
		display: 'flex',
		gap: '8px',
		alignItems: 'flex-start',
		flexWrap: 'wrap',
		justifyContent: 'flex-end',
	},
	summarySection: {
		padding: '16px 20px',
		borderBottom: '1px solid var(--vscode-panel-border)',
		display: 'flex',
		flexDirection: 'column',
		gap: '14px',
	},
	progressRow: {
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
	},
	progressMeta: {
		display: 'flex',
		gap: '16px',
		flexWrap: 'wrap',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
	},
	progressTrack: {
		height: '12px',
		borderRadius: '999px',
		background: 'var(--vscode-editorWidget-background)',
		overflow: 'hidden',
	},
	progressFill: {
		height: '100%',
		background: 'linear-gradient(90deg, var(--vscode-textLink-foreground), color-mix(in srgb, var(--vscode-textLink-foreground) 55%, var(--vscode-testing-iconPassed)))',
	},
	metricsGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
		gap: '10px',
	},
	metricCard: {
		padding: '12px',
		borderRadius: '8px',
		background: 'var(--vscode-editorWidget-background)',
		border: '1px solid var(--vscode-panel-border)',
	},
	metricLabel: {
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
		marginBottom: '6px',
	},
	metricValue: {
		fontSize: '15px',
		fontWeight: 700,
	},
	section: {
		padding: '16px 20px',
		borderBottom: '1px solid var(--vscode-panel-border)',
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
	},
	eventsSection: {
		padding: '16px 20px',
		borderBottom: '1px solid var(--vscode-panel-border)',
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
		flex: 1,
		minHeight: 0,
	},
	footerSection: {
		padding: '12px 20px 16px',
		borderTop: '1px solid var(--vscode-panel-border)',
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		background: 'color-mix(in srgb, var(--vscode-editorWidget-background) 55%, var(--vscode-editor-background))',
		flexShrink: 0,
	},
	sectionHeader: {
		fontSize: '13px',
		fontWeight: 700,
	},
	sectionHeaderRow: {
		display: 'flex',
		justifyContent: 'space-between',
		gap: '12px',
		alignItems: 'center',
		flexWrap: 'wrap',
	},
	filtersRow: {
		display: 'flex',
		gap: '8px',
		alignItems: 'center',
		flexWrap: 'wrap',
	},
	filterSelect: {
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)',
		borderRadius: '4px',
		padding: '4px 8px',
		fontSize: '12px',
	},
	tableScroll: {
		overflowX: 'auto',
	},
	tableScrollLarge: {
		overflow: 'auto',
		flex: 1,
		minHeight: 0,
	},
	table: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: '12px',
	},
	tableFixed: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: '12px',
		tableLayout: 'fixed',
	},
	tableHead: {
		position: 'sticky',
		top: 0,
		background: 'var(--vscode-editor-background)',
		textAlign: 'left',
		padding: '8px',
		borderBottom: '1px solid var(--vscode-panel-border)',
		fontWeight: 700,
		whiteSpace: 'nowrap',
	},
	tableHeadCurrent: {
		position: 'sticky',
		top: 0,
		background: 'var(--vscode-editor-background)',
		textAlign: 'left',
		padding: '8px',
		borderBottom: '1px solid var(--vscode-panel-border)',
		fontWeight: 700,
		whiteSpace: 'nowrap',
		width: '280px',
		minWidth: '280px',
		maxWidth: '280px',
	},
	tableCell: {
		padding: '8px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)',
		verticalAlign: 'top',
	},
	tableCellStrong: {
		padding: '8px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)',
		fontWeight: 700,
		verticalAlign: 'top',
	},
	tableCellWide: {
		padding: '8px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)',
		minWidth: '240px',
		maxWidth: '380px',
		verticalAlign: 'top',
	},
	tableCellCurrent: {
		padding: '8px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)',
		verticalAlign: 'top',
		width: '280px',
		minWidth: '280px',
		maxWidth: '280px',
	},
	tableCellMono: {
		padding: '8px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)',
		fontFamily: 'var(--vscode-editor-font-family)',
		verticalAlign: 'top',
	},
	selectedRow: {
		background: 'color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 40%, transparent)',
	},
	emptyCell: {
		padding: '20px',
		textAlign: 'center',
		color: 'var(--vscode-descriptionForeground)',
	},
	logList: {
		display: 'flex',
		flexDirection: 'column',
		justifyContent: 'flex-end',
		gap: '8px',
		maxHeight: '150px',
		overflow: 'auto',
	},
	ellipsisText: {
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	logItem: {
		display: 'flex',
		gap: '10px',
		fontSize: '12px',
		padding: '8px 10px',
		borderRadius: '6px',
		background: 'var(--vscode-editorWidget-background)',
		alignItems: 'baseline',
	},
	logTime: {
		color: 'var(--vscode-descriptionForeground)',
		minWidth: '66px',
		fontFamily: 'var(--vscode-editor-font-family)',
	},
	logEmpty: {
		padding: '10px 0',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '12px',
	},
	emptyState: {
		flex: 1,
		display: 'flex',
		flexDirection: 'column',
		justifyContent: 'center',
		alignItems: 'center',
		gap: '12px',
		padding: '24px',
	},
	emptyTitle: {
		fontSize: '16px',
		fontWeight: 700,
	},
	emptyText: {
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '12px',
		textAlign: 'center',
		maxWidth: '520px',
	},
};