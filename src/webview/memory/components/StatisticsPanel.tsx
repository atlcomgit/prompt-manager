/**
 * StatisticsPanel — Shows aggregated memory statistics:
 * totals, category distribution, top authors, hot files, commits per day.
 */

import React from 'react';
import type { MemoryStatistics } from '../../../types/memory';
import { memoryButtonStyles } from './buttonStyles';

interface Props {
	statistics: MemoryStatistics | null;
	onRefresh: () => void;
	onClearAll: () => void;
	t: (key: string) => string;
}

/** Format bytes to human-readable */
function formatBytes(bytes: number): string {
	if (bytes < 1024) { return `${bytes} B`; }
	if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const StatisticsPanel: React.FC<Props> = ({ statistics, onRefresh, onClearAll, t }) => {
	if (!statistics) {
		return <div style={styles.loading}>{t('memory.loading')}</div>;
	}

	return (
		<div style={styles.container}>
			{/* Action bar */}
			<div style={styles.actions}>
				<button style={memoryButtonStyles.secondary} onClick={onRefresh}>
					↻ {t('memory.refresh')}
				</button>
				<button style={memoryButtonStyles.danger} onClick={onClearAll}>
					🗑 {t('memory.clearAll')}
				</button>
			</div>

			{/* Summary cards */}
			<div style={styles.cards}>
				<div style={styles.card}>
					<div style={styles.cardValue}>{statistics.totalCommits}</div>
					<div style={styles.cardLabel}>{t('memory.totalCommits')}</div>
				</div>
				<div style={styles.card}>
					<div style={styles.cardValue}>{statistics.totalAnalyses}</div>
					<div style={styles.cardLabel}>{t('memory.totalAnalyses')}</div>
				</div>
				<div style={styles.card}>
					<div style={styles.cardValue}>{statistics.totalEmbeddings}</div>
					<div style={styles.cardLabel}>{t('memory.totalEmbeddings')}</div>
				</div>
				<div style={styles.card}>
					<div style={styles.cardValue}>{formatBytes(statistics.dbSizeBytes)}</div>
					<div style={styles.cardLabel}>{t('memory.dbSize')}</div>
				</div>
			</div>

			{/* Category distribution */}
			{statistics.categoryDistribution.length > 0 && (
				<div style={styles.section}>
					<h4 style={styles.sectionTitle}>{t('memory.categoryDistribution')}</h4>
					<div style={styles.barChart}>
						{statistics.categoryDistribution.map(item => {
							const maxCount = Math.max(...statistics.categoryDistribution.map(d => d.count));
							const width = maxCount > 0 ? (item.count / maxCount) * 100 : 0;
							return (
								<div key={item.category} style={styles.barRow}>
									<span style={styles.barLabel}>{item.category}</span>
									<div style={styles.barTrack}>
										<div style={{ ...styles.barFill, width: `${width}%` }} />
									</div>
									<span style={styles.barValue}>{item.count}</span>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Top authors */}
			{statistics.topAuthors.length > 0 && (
				<div style={styles.section}>
					<h4 style={styles.sectionTitle}>{t('memory.topAuthors')}</h4>
					<table style={styles.table}>
						<tbody>
							{statistics.topAuthors.map(a => (
								<tr key={a.author}>
									<td style={styles.td}>{a.author}</td>
									<td style={styles.tdNum}>{a.count}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{/* Hot files */}
			{statistics.hotFiles.length > 0 && (
				<div style={styles.section}>
					<h4 style={styles.sectionTitle}>{t('memory.hotFiles')}</h4>
					<table style={styles.table}>
						<tbody>
							{statistics.hotFiles.map(f => (
								<tr key={f.filePath}>
									<td style={{ ...styles.td, fontFamily: 'var(--vscode-editor-font-family)' }}>
										{f.filePath}
									</td>
									<td style={styles.tdNum}>{f.count}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{/* Commits per day (simple text list) */}
			{statistics.commitsPerDay.length > 0 && (
				<div style={styles.section}>
					<h4 style={styles.sectionTitle}>{t('memory.commitsPerDay')}</h4>
					<div style={styles.barChart}>
						{statistics.commitsPerDay.map(d => {
							const maxCount = Math.max(...statistics.commitsPerDay.map(x => x.count));
							const width = maxCount > 0 ? (d.count / maxCount) * 100 : 0;
							return (
								<div key={d.date} style={styles.barRow}>
									<span style={styles.barLabel}>{d.date}</span>
									<div style={styles.barTrack}>
										<div style={{ ...styles.barFill, width: `${width}%` }} />
									</div>
									<span style={styles.barValue}>{d.count}</span>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
};

const styles: Record<string, React.CSSProperties> = {
	container: { padding: '16px', overflow: 'auto', height: '100%' },
	loading: {
		display: 'flex', alignItems: 'center', justifyContent: 'center',
		height: '100%', color: 'var(--vscode-descriptionForeground)',
	},
	actions: { display: 'flex', gap: '8px', marginBottom: '16px' },
	cards: { display: 'flex', gap: '12px', flexWrap: 'wrap' as const, marginBottom: '16px' },
	card: {
		flex: '1 1 120px', padding: '12px', textAlign: 'center' as const,
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)', borderRadius: '4px',
	},
	cardValue: { fontSize: '24px', fontWeight: 700, color: 'var(--vscode-foreground)' },
	cardLabel: { fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginTop: '4px' },
	section: {
		marginBottom: '16px', padding: '12px',
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)', borderRadius: '4px',
	},
	sectionTitle: { margin: '0 0 8px 0', fontSize: '13px' },
	barChart: { display: 'flex', flexDirection: 'column' as const, gap: '4px' },
	barRow: { display: 'flex', alignItems: 'center', gap: '8px' },
	barLabel: { width: '120px', fontSize: '11px', textAlign: 'right' as const, flexShrink: 0 },
	barTrack: {
		flex: 1, height: '14px', background: 'var(--vscode-input-background)',
		borderRadius: '3px', overflow: 'hidden',
	},
	barFill: {
		height: '100%', background: 'var(--vscode-button-background)',
		borderRadius: '3px', transition: 'width 0.3s',
	},
	barValue: { width: '40px', fontSize: '11px', textAlign: 'left' as const },
	table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '12px' },
	td: { padding: '4px 8px', borderBottom: '1px solid var(--vscode-panel-border)' },
	tdNum: {
		padding: '4px 8px', borderBottom: '1px solid var(--vscode-panel-border)',
		textAlign: 'right' as const, fontWeight: 600,
	},
};
