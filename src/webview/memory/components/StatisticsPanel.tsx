/**
 * StatisticsPanel — Shows aggregated memory statistics:
 * totals, category distribution, top authors, hot files, commits per day.
 */

import React from 'react';
import type { MemoryAvailableModel, MemoryStatistics } from '../../../types/memory';
import { memoryButtonStyles } from './buttonStyles';
import { formatMemoryBytes, MemoryMetricCard, MemoryPanel, memoryUiStyles } from './memoryUi';

interface Props {
	statistics: MemoryStatistics | null;
	availableModels: MemoryAvailableModel[];
	onRefresh: () => void;
	onClearAll: () => void;
	t: (key: string) => string;
}


export const StatisticsPanel: React.FC<Props> = ({ statistics, availableModels, onRefresh, onClearAll, t }) => {
	if (!statistics) {
		return <div style={styles.loading}>{t('memory.loading')}</div>;
	}

	const resolveModelName = (modelId: string): string => availableModels.find(item => item.id === modelId)?.name || modelId;

	return (
		<div style={styles.container}>
			<div style={styles.actions}>
				<button style={memoryButtonStyles.secondary} onClick={onRefresh}>
					↻ {t('memory.refresh')}
				</button>
				<button style={memoryButtonStyles.danger} onClick={onClearAll}>
					🗑 {t('memory.clearAll')}
				</button>
			</div>

			<div style={memoryUiStyles.pageStack}>
				<div style={memoryUiStyles.metricGrid}>
					<MemoryMetricCard label={t('memory.totalCommits')} value={String(statistics.totalCommits)} secondary={t('memory.dashboard.metric.commitsHelp')} accent="var(--vscode-progressBar-background)" />
					<MemoryMetricCard label={t('memory.totalAnalyses')} value={String(statistics.totalAnalyses)} secondary={t('memory.dashboard.metric.analysedHelp')} accent="var(--vscode-testing-iconPassed)" />
					<MemoryMetricCard label={t('memory.totalEmbeddings')} value={String(statistics.totalEmbeddings)} secondary={t('memory.dashboard.metric.embeddingsHelp')} accent="var(--vscode-terminal-ansiYellow)" />
					<MemoryMetricCard label={t('memory.dbSize')} value={formatMemoryBytes(statistics.dbSizeBytes)} secondary={t('memory.dashboard.metric.databaseHelp')} compact accent="var(--vscode-terminal-ansiBlue)" />
				</div>

				<div style={memoryUiStyles.twoColumnGrid}>
					{statistics.categoryDistribution.length > 0 && (
						<MemoryPanel title={t('memory.categoryDistribution')}>
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
						</MemoryPanel>
					)}

					{statistics.analysisModels.length > 0 && (
						<MemoryPanel title={t('memory.analysisModels')}>
							<div style={styles.barChart}>
						{statistics.analysisModels.map(item => {
							const maxCount = Math.max(...statistics.analysisModels.map(model => model.count));
							const width = maxCount > 0 ? (item.count / maxCount) * 100 : 0;
							return (
								<div key={item.model} style={styles.barRow}>
									<span style={styles.barLabel}>{resolveModelName(item.model)}</span>
									<div style={styles.barTrack}>
										<div style={{ ...styles.barFill, width: `${width}%` }} />
									</div>
									<span style={styles.barValue}>{item.count}</span>
								</div>
							);
						})}
					</div>
						</MemoryPanel>
					)}
				</div>

				<div style={memoryUiStyles.twoColumnGrid}>
					{statistics.topAuthors.length > 0 && (
						<MemoryPanel title={t('memory.topAuthors')}>
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
						</MemoryPanel>
					)}

					{statistics.hotFiles.length > 0 && (
						<MemoryPanel title={t('memory.hotFiles')}>
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
						</MemoryPanel>
					)}
				</div>

				{statistics.commitsPerDay.length > 0 && (
					<MemoryPanel title={t('memory.commitsPerDay')}>
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
					</MemoryPanel>
				)}
			</div>
		</div>
	);
};

// Стили панели статистики — плоский дизайн, тонкие бары, чистые таблицы.
const styles: Record<string, React.CSSProperties> = {
	container: {
		padding: '24px',
		overflow: 'auto',
		height: '100%',
		boxSizing: 'border-box',
	},
	loading: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		height: '100%',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '12px',
	},
	actions: {
		display: 'flex',
		gap: '8px',
		marginBottom: '20px',
		flexWrap: 'wrap',
	},
	barChart: {
		display: 'flex',
		flexDirection: 'column' as const,
		gap: '10px',
	},
	barRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '10px',
	},
	barLabel: {
		width: '110px',
		fontSize: '11px',
		fontWeight: 600,
		textAlign: 'right' as const,
		flexShrink: 0,
		color: 'var(--vscode-descriptionForeground)',
	},
	// Трек бара — тонкий (6px), без градиента.
	barTrack: {
		flex: 1,
		height: '6px',
		background: 'color-mix(in srgb, var(--vscode-foreground) 8%, transparent)',
		borderRadius: '999px',
		overflow: 'hidden',
	},
	// Заливка бара — плоский цвет.
	barFill: {
		height: '100%',
		background: 'var(--vscode-progressBar-background)',
		borderRadius: '999px',
		transition: 'width 0.4s ease',
	},
	barValue: {
		width: '40px',
		fontSize: '11px',
		fontWeight: 700,
		textAlign: 'left' as const,
		fontVariantNumeric: 'tabular-nums',
	},
	// Таблица — без бордеров ячеек, чистая.
	table: {
		width: '100%',
		borderCollapse: 'collapse' as const,
		fontSize: '12px',
	},
	td: {
		padding: '10px 12px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-foreground) 5%, transparent)',
		lineHeight: 1.45,
	},
	tdNum: {
		padding: '10px 12px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-foreground) 5%, transparent)',
		textAlign: 'right' as const,
		fontWeight: 700,
		fontVariantNumeric: 'tabular-nums',
	},
};
