import React from 'react';
import { isManualAnalysisBusy } from '../../../utils/manualAnalysisRuntime';
import type { CodeMapActivity, CodeMapStatistics } from '../../../types/codemap';
import type { ManualAnalysisSnapshot, MemoryCommit, MemoryStatistics } from '../../../types/memory';
import { memoryButtonStyles } from './buttonStyles';
import {
	clampPercent,
	formatMemoryBytes,
	formatMemoryDate,
	formatMemoryPercent,
	MemoryMetricCard,
	MemoryPanel,
	memoryUiStyles,
} from './memoryUi';

interface Props {
	statistics: MemoryStatistics | null;
	recentCommits: MemoryCommit[];
	codeMapStatistics: CodeMapStatistics | null;
	codeMapActivity: CodeMapActivity | null;
	analysisSnapshot: ManualAnalysisSnapshot | null;
	onOpenHistories: () => void;
	onOpenInstructions: () => void;
	onOpenSettings: () => void;
	onRunAnalysis: () => void;
	onRefresh: () => void;
	t: (key: string) => string;
}

const CATEGORY_COLORS = [
	'var(--vscode-progressBar-background)',
	'var(--vscode-testing-iconPassed)',
	'var(--vscode-terminal-ansiYellow)',
	'var(--vscode-terminal-ansiBlue)',
	'var(--vscode-terminal-ansiGreen)',
	'var(--vscode-testing-iconFailed)',
	'var(--vscode-terminal-ansiCyan)',
	'var(--vscode-terminal-ansiMagenta)',
];

type ActivityPoint = {
	date: string;
	count: number;
};

// Формирует компактный относительный timestamp для карточки истории.
function formatRelativeDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	const diffMs = Date.now() - date.getTime();
	const diffMinutes = Math.round(diffMs / 60_000);
	if (Math.abs(diffMinutes) < 60) {
		return `${Math.max(diffMinutes, 0)} мин назад`;
	}

	const diffHours = Math.round(diffMinutes / 60);
	if (Math.abs(diffHours) < 24) {
		return `${Math.max(diffHours, 0)} ч назад`;
	}

	const diffDays = Math.round(diffHours / 24);
	if (Math.abs(diffDays) < 30) {
		return `${Math.max(diffDays, 0)} дн назад`;
	}

	return date.toLocaleDateString();
}

// Сокращает дату до компактного лейбла под графиком активности.
function formatChartDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Строит SVG-путь line/area chart для активности по дням.
function buildActivityPaths(points: ActivityPoint[], width: number, height: number): { linePath: string; areaPath: string } {
	if (points.length === 0) {
		return { linePath: '', areaPath: '' };
	}

	const padX = 14;
	const padY = 18;
	const usableWidth = width - padX * 2;
	const usableHeight = height - padY * 2;
	const maxCount = Math.max(...points.map(item => item.count), 1);
	const step = points.length === 1 ? 0 : usableWidth / (points.length - 1);
	const normalized = points.map((point, index) => {
		const x = padX + step * index;
		const y = height - padY - (point.count / maxCount) * usableHeight;
		return { x, y };
	});
	const linePath = normalized.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
	const lastPoint = normalized[normalized.length - 1]!;
	const firstPoint = normalized[0]!;
	const areaPath = `${linePath} L ${lastPoint.x} ${height - padY} L ${firstPoint.x} ${height - padY} Z`;

	return { linePath, areaPath };
}

// Собирает conic-gradient для donut-графика категорий.
function buildCategoryGradient(items: Array<{ count: number }>): string {
	if (items.length === 0) {
		return 'transparent';
	}

	const total = items.reduce((sum, item) => sum + item.count, 0) || 1;
	let currentOffset = 0;
	const parts = items.map((item, index) => {
		const start = currentOffset;
		const size = (item.count / total) * 100;
		currentOffset += size;
		const end = currentOffset;
		return `${CATEGORY_COLORS[index % CATEGORY_COLORS.length]} ${start}% ${end}%`;
	});

	return `conic-gradient(${parts.join(', ')})`;
}

// Рендерит строку рейтинга с прогресс-баром и значением справа.
const RankingList: React.FC<{
	items: Array<{ label: string; value: number; secondary?: string }>;
	mono?: boolean;
	t: (key: string) => string;
}> = ({ items, mono, t }) => {
	if (items.length === 0) {
		return <div style={memoryUiStyles.emptyInline}>{t('memory.dashboard.emptyRanking')}</div>;
	}

	const maxValue = Math.max(...items.map(item => item.value), 1);
	return (
		<div style={memoryUiStyles.listStack}>
			{items.map(item => {
				const width = (item.value / maxValue) * 100;
				return (
					<div key={`${item.label}-${item.value}`} style={styles.rankingRow}>
						<div style={styles.rankingText}>
							<div style={{ ...styles.rankingLabel, ...(mono ? memoryUiStyles.monoText : {}) }}>{item.label}</div>
							{item.secondary ? <div style={styles.rankingSecondary}>{item.secondary}</div> : null}
						</div>
						<div style={styles.rankingTrack}>
							<div style={{ ...styles.rankingFill, width: `${width}%` }} />
						</div>
						<div style={styles.rankingValue}>{item.value}</div>
					</div>
				);
			})}
		</div>
	);
};

// Рендерит стартовый Dashboard со сводкой по памяти, активности и последним историям.
export const MemoryDashboard: React.FC<Props> = ({
	statistics,
	recentCommits,
	codeMapStatistics,
	codeMapActivity,
	analysisSnapshot,
	onOpenHistories,
	onOpenInstructions,
	onOpenSettings,
	onRunAnalysis,
	onRefresh,
	t,
}) => {
	if (!statistics) {
		return <div style={styles.loading}>{t('memory.loading')}</div>;
	}

	const totalCommits = statistics.totalCommits;
	const totalAnalyses = statistics.totalAnalyses;
	const totalEmbeddings = statistics.totalEmbeddings;
	const coveragePercent = totalCommits > 0 ? (totalAnalyses / totalCommits) * 100 : 0;
	const totalMemoryBytes = statistics.dbSizeBytes + (codeMapStatistics?.dbSizeBytes || 0);
	const instructionsCount = codeMapStatistics?.totalInstructions || 0;
	const liveBacklog = (codeMapActivity?.runtime.queuedCount || 0) + (codeMapActivity?.runtime.runningCount || 0);
	const activityPoints = statistics.commitsPerDay.slice(-14);
	const { linePath, areaPath } = buildActivityPaths(activityPoints, 360, 160);
	const categoryTotal = statistics.categoryDistribution.reduce((sum, item) => sum + item.count, 0);
	const categoryGradient = buildCategoryGradient(statistics.categoryDistribution);
	const recentCards = recentCommits.slice(0, 4);
	const analysisIsBusy = Boolean(analysisSnapshot && (isManualAnalysisBusy(analysisSnapshot.status) || analysisSnapshot.status === 'paused'));
	const activityStatus = analysisIsBusy
		? t('memory.dashboard.status.analysisRunning')
		: liveBacklog > 0
			? t('memory.dashboard.status.instructionsRunning')
			: t('memory.dashboard.status.idle');
	const coverageRingAngle = clampPercent(coveragePercent);
	const topAuthors = statistics.topAuthors.slice(0, 5).map(item => ({
		label: item.author,
		value: item.count,
		secondary: t('memory.dashboard.commitsSuffix'),
	}));
	const hotFiles = statistics.hotFiles.slice(0, 5).map(item => ({
		label: item.filePath,
		value: item.count,
		secondary: t('memory.dashboard.changesSuffix'),
	}));
	const heroSummary = `${totalAnalyses}/${Math.max(totalCommits, 1)} · ${t('memory.dashboard.coverageSummary')}`;

	return (
		<div style={styles.container}>
			<div style={memoryUiStyles.pageStack}>
				<div style={styles.heroGrid}>
					<MemoryPanel style={styles.heroPanel}>
						<div style={styles.heroLayout}>
							<div style={styles.heroCopy}>
								<div style={styles.heroEyebrow}>{t('memory.dashboard.heroEyebrow')}</div>
								<h2 style={styles.heroTitle}>{t('memory.dashboard.heroTitle')}</h2>
								<div style={styles.heroDescription}>{t('memory.dashboard.heroDescription')}</div>
								<div style={styles.heroActions}>
									<button style={memoryButtonStyles.primary} onClick={onRunAnalysis}>
										▶ {t('memory.runAnalysis')}
									</button>
									<button style={memoryButtonStyles.secondary} onClick={onOpenHistories}>
										↗ {t('memory.dashboard.openHistories')}
									</button>
									<button style={memoryButtonStyles.secondary} onClick={onOpenSettings}>
										⚙ {t('memory.dashboard.openSettings')}
									</button>
								</div>
							</div>
							<div style={styles.heroAside}>
								<div style={styles.statusPill}>{activityStatus}</div>
								<div style={styles.heroStatGrid}>
									<div style={styles.heroStatCard}>
										<div style={styles.heroStatLabel}>{t('memory.dashboard.instructionsCount')}</div>
										<div style={styles.heroStatValue}>{instructionsCount}</div>
									</div>
									<div style={styles.heroStatCard}>
										<div style={styles.heroStatLabel}>{t('memory.dashboard.liveBacklog')}</div>
										<div style={styles.heroStatValue}>{liveBacklog}</div>
									</div>
									<div style={styles.heroStatCard}>
										<div style={styles.heroStatLabel}>{t('memory.dashboard.totalMemory')}</div>
										<div style={styles.heroStatValueCompact}>{formatMemoryBytes(totalMemoryBytes)}</div>
									</div>
								</div>
								<div style={styles.heroQuickActions}>
									<button style={memoryButtonStyles.secondary} onClick={onOpenInstructions}>
										↗ {t('memory.dashboard.openInstructions')}
									</button>
									<button style={memoryButtonStyles.secondary} onClick={onRefresh}>
										↻ {t('memory.refresh')}
									</button>
								</div>
							</div>
						</div>
					</MemoryPanel>

					<MemoryPanel title={t('memory.dashboard.coverage')} description={heroSummary} style={styles.coveragePanel}>
						<div style={styles.coverageCard}>
							<div style={{ ...styles.coverageRing, background: `conic-gradient(var(--vscode-progressBar-background) 0 ${coverageRingAngle}%, color-mix(in srgb, var(--vscode-panel-border) 70%, transparent) ${coverageRingAngle}% 100%)` }}>
								<div style={styles.coverageRingInner}>
									<div style={styles.coverageValue}>{formatMemoryPercent(coveragePercent)}</div>
									<div style={styles.coverageLabel}>{t('memory.dashboard.coverage')}</div>
								</div>
							</div>
							<div style={styles.coverageMeta}>{t('memory.dashboard.coverageFormula').replace('{analysed}', String(totalAnalyses)).replace('{total}', String(totalCommits))}</div>
						</div>
					</MemoryPanel>
				</div>

				<div style={memoryUiStyles.metricGrid}>
					<MemoryMetricCard label={t('memory.dashboard.metric.commits')} value={String(totalCommits)} secondary={t('memory.dashboard.metric.commitsHelp')} accent="var(--vscode-progressBar-background)" />
					<MemoryMetricCard label={t('memory.dashboard.metric.analysed')} value={String(totalAnalyses)} secondary={t('memory.dashboard.metric.analysedHelp')} accent="var(--vscode-testing-iconPassed)" />
					<MemoryMetricCard label={t('memory.dashboard.metric.embeddings')} value={String(totalEmbeddings)} secondary={t('memory.dashboard.metric.embeddingsHelp')} accent="var(--vscode-terminal-ansiYellow)" />
					<MemoryMetricCard label={t('memory.dashboard.metric.database')} value={formatMemoryBytes(statistics.dbSizeBytes)} secondary={t('memory.dashboard.metric.databaseHelp')} compact accent="var(--vscode-terminal-ansiBlue)" />
					<MemoryMetricCard label={t('memory.dashboard.metric.totalMemory')} value={formatMemoryBytes(totalMemoryBytes)} secondary={t('memory.dashboard.metric.totalMemoryHelp')} compact accent="var(--vscode-terminal-ansiGreen)" />
				</div>

				<div style={memoryUiStyles.twoColumnGrid}>
					<MemoryPanel title={t('memory.dashboard.activityTitle')} description={t('memory.dashboard.activityDescription')}>
						{activityPoints.length > 0 ? (
							<div style={styles.activityWrap}>
								<svg viewBox="0 0 360 160" preserveAspectRatio="none" style={styles.activityChart}>
									<defs>
										<linearGradient id="memory-dashboard-activity" x1="0" x2="0" y1="0" y2="1">
											<stop offset="0%" stopColor="var(--vscode-progressBar-background)" stopOpacity="0.38" />
											<stop offset="100%" stopColor="var(--vscode-progressBar-background)" stopOpacity="0.03" />
										</linearGradient>
									</defs>
									<path d={areaPath} fill="url(#memory-dashboard-activity)" />
									<path d={linePath} fill="none" stroke="var(--vscode-progressBar-background)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
								</svg>
								<div style={styles.activityFooter}>
									<span>{formatChartDate(activityPoints[0]!.date)}</span>
									<span>{formatChartDate(activityPoints[activityPoints.length - 1]!.date)}</span>
								</div>
							</div>
						) : (
							<div style={memoryUiStyles.emptyState}>{t('memory.dashboard.emptyActivity')}</div>
						)}
					</MemoryPanel>

					<MemoryPanel title={t('memory.dashboard.categoriesTitle')} description={t('memory.dashboard.categoriesDescription')}>
						{statistics.categoryDistribution.length > 0 ? (
							<div style={styles.categoryLayout}>
								<div style={{ ...styles.categoryDonut, background: categoryGradient }}>
									<div style={styles.categoryDonutInner}>
										<div style={styles.categoryTotalValue}>{categoryTotal}</div>
										<div style={styles.categoryTotalLabel}>{t('memory.dashboard.categoriesTotal')}</div>
									</div>
								</div>
								<div style={memoryUiStyles.listStack}>
									{statistics.categoryDistribution.map((item, index) => (
										<div key={item.category} style={styles.categoryRow}>
											<div style={styles.categoryLabelWrap}>
												<span style={{ ...styles.categorySwatch, background: CATEGORY_COLORS[index % CATEGORY_COLORS.length] }} />
												<span style={styles.categoryLabel}>{item.category}</span>
											</div>
											<div style={styles.categoryValue}>{item.count}</div>
										</div>
									))}
								</div>
							</div>
						) : (
							<div style={memoryUiStyles.emptyState}>{t('memory.dashboard.emptyCategories')}</div>
						)}
					</MemoryPanel>
				</div>

				<div style={memoryUiStyles.twoColumnGrid}>
					<MemoryPanel title={t('memory.dashboard.topAuthorsTitle')} description={t('memory.dashboard.topAuthorsDescription')}>
						<RankingList items={topAuthors} t={t} />
					</MemoryPanel>

					<MemoryPanel title={t('memory.dashboard.hotFilesTitle')} description={t('memory.dashboard.hotFilesDescription')}>
						<RankingList items={hotFiles} mono t={t} />
					</MemoryPanel>
				</div>

				<MemoryPanel
					title={t('memory.dashboard.recentTitle')}
					description={t('memory.dashboard.recentDescription')}
					actions={(
						<button style={memoryButtonStyles.secondary} onClick={onOpenHistories}>
							↗ {t('memory.dashboard.openHistories')}
						</button>
					)}
				>
					{recentCards.length > 0 ? (
						<div style={styles.recentGrid}>
							{recentCards.map(commit => (
								<button key={commit.sha} type="button" style={styles.recentCard} onClick={onOpenHistories}>
									<div style={styles.recentHeader}>
										<span style={styles.recentBadge}>{commit.commitType}</span>
										<span style={styles.recentSha}>{commit.sha.slice(0, 7)}</span>
										<span style={styles.recentDate}>{formatRelativeDate(commit.date)}</span>
									</div>
									<div style={styles.recentMessage}>{commit.message.split('\n')[0]}</div>
									<div style={styles.recentMeta}>{commit.author} · {commit.repository} · {commit.branch}</div>
									<div style={styles.recentSubtle}>{formatMemoryDate(commit.date)}</div>
								</button>
							))}
						</div>
					) : (
						<div style={memoryUiStyles.emptyState}>{t('memory.dashboard.emptyRecent')}</div>
					)}
				</MemoryPanel>
			</div>
		</div>
	);
};

// Описывает визуальную композицию Dashboard — плоский дизайн, акцентные линии, нет теней.
const styles: Record<string, React.CSSProperties> = {
	container: {
		height: '100%',
		overflow: 'auto',
		padding: '24px',
		boxSizing: 'border-box',
	},
	loading: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		height: '100%',
		color: 'var(--vscode-descriptionForeground)',
	},
	// Сетка hero-секции: широкая панель + узкий coverage.
	heroGrid: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 2.2fr) minmax(260px, 0.9fr)',
		gap: '20px',
	},
	// Hero-панель — акцентная полоска слева, легкий градиент к акценту.
	herePanel: {
		borderLeft: '4px solid var(--vscode-button-background)',
		background: 'linear-gradient(100deg, color-mix(in srgb, var(--vscode-button-background) 4%, var(--vscode-editor-background)), var(--vscode-editor-background) 50%)',
	},
	coveragePanel: {
		justifyContent: 'center',
	},
	heroLayout: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1.6fr) minmax(240px, 0.9fr)',
		gap: '24px',
		alignItems: 'stretch',
	},
	heroCopy: {
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
		minWidth: 0,
	},
	// Верхний мелкий лейбл — uppercase, приглушённый.
	heroEyebrow: {
		fontSize: '10px',
		textTransform: 'uppercase',
		letterSpacing: '0.1em',
		color: 'var(--vscode-descriptionForeground)',
		fontWeight: 700,
	},
	// Крупный заголовок Dashboard.
	heroTitle: {
		margin: 0,
		fontSize: '28px',
		fontWeight: 800,
		lineHeight: 1.1,
		letterSpacing: '-0.02em',
		color: 'var(--vscode-foreground)',
	},
	heroDescription: {
		fontSize: '13px',
		lineHeight: 1.6,
		color: 'var(--vscode-descriptionForeground)',
		maxWidth: '52ch',
	},
	heroActions: {
		display: 'flex',
		gap: '8px',
		flexWrap: 'wrap',
		marginTop: '4px',
	},
	// Боковая колонка hero — тонкая рамка, плоский фон.
	heroAside: {
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
		padding: '16px',
		borderRadius: '10px',
		background: 'color-mix(in srgb, var(--vscode-foreground) 3%, transparent)',
		border: '1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent)',
		alignSelf: 'stretch',
	},
	// Пилл-статус — мягкий фон, без теней.
	statusPill: {
		display: 'inline-flex',
		alignItems: 'center',
		alignSelf: 'flex-start',
		padding: '4px 12px',
		borderRadius: '6px',
		background: 'color-mix(in srgb, var(--vscode-button-background) 10%, transparent)',
		color: 'var(--vscode-foreground)',
		fontSize: '11px',
		fontWeight: 700,
	},
	heroStatGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
		gap: '8px',
	},
	// Мини-карточка метрики в hero-блоке.
	heroStatCard: {
		padding: '12px',
		borderRadius: '8px',
		background: 'var(--vscode-editor-background)',
		border: '1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent)',
		boxShadow: '0 1px 3px 0 color-mix(in srgb, var(--vscode-foreground) 4%, transparent)',
	},
	heroStatLabel: {
		fontSize: '10px',
		lineHeight: 1.45,
		color: 'var(--vscode-descriptionForeground)',
		textTransform: 'uppercase',
		letterSpacing: '0.04em',
	},
	heroStatValue: {
		marginTop: '6px',
		fontSize: '22px',
		fontWeight: 800,
		lineHeight: 1.05,
		letterSpacing: '-0.01em',
	},
	heroStatValueCompact: {
		marginTop: '6px',
		fontSize: '14px',
		fontWeight: 700,
		lineHeight: 1.35,
	},
	heroQuickActions: {
		display: 'flex',
		gap: '8px',
		flexWrap: 'wrap',
	},
	// Карточка coverage — вертикальная, центрированная.
	coverageCard: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		gap: '12px',
		justifyContent: 'center',
	},
	// Кольцо прогресса — тоньше, чище.
	coverageRing: {
		width: '130px',
		height: '130px',
		borderRadius: '999px',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	},
	coverageRingInner: {
		width: '100px',
		height: '100px',
		borderRadius: '999px',
		background: 'var(--vscode-editor-background)',
		border: '1px solid color-mix(in srgb, var(--vscode-foreground) 8%, transparent)',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		gap: '2px',
	},
	coverageValue: {
		fontSize: '24px',
		fontWeight: 800,
		letterSpacing: '-0.02em',
	},
	coverageLabel: {
		fontSize: '10px',
		letterSpacing: '0.06em',
		textTransform: 'uppercase',
		color: 'var(--vscode-descriptionForeground)',
	},
	coverageMeta: {
		fontSize: '11px',
		lineHeight: 1.5,
		color: 'var(--vscode-descriptionForeground)',
		textAlign: 'center',
		maxWidth: '26ch',
	},
	activityWrap: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
	},
	activityChart: {
		width: '100%',
		height: '140px',
		display: 'block',
	},
	activityFooter: {
		display: 'flex',
		justifyContent: 'space-between',
		gap: '12px',
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
		letterSpacing: '0.02em',
	},
	// Сетка категорий: donut + список.
	categoryLayout: {
		display: 'grid',
		gridTemplateColumns: '140px minmax(0, 1fr)',
		gap: '20px',
		alignItems: 'center',
	},
	categoryDonut: {
		width: '140px',
		height: '140px',
		borderRadius: '999px',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		margin: '0 auto',
	},
	categoryDonutInner: {
		width: '88px',
		height: '88px',
		borderRadius: '999px',
		background: 'var(--vscode-editor-background)',
		border: '1px solid color-mix(in srgb, var(--vscode-foreground) 8%, transparent)',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		gap: '2px',
	},
	categoryTotalValue: {
		fontSize: '20px',
		fontWeight: 800,
		letterSpacing: '-0.02em',
	},
	categoryTotalLabel: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
		textTransform: 'uppercase',
		letterSpacing: '0.04em',
	},
	// Строка категории — разделитель снизу, без фона.
	categoryRow: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '12px',
		paddingBottom: '8px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent)',
	},
	categoryLabelWrap: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
	},
	// Цветная точка-индикатор категории.
	categorySwatch: {
		width: '8px',
		height: '8px',
		borderRadius: '999px',
		flex: '0 0 auto',
	},
	categoryLabel: {
		fontSize: '12px',
		fontWeight: 600,
	},
	categoryValue: {
		fontSize: '12px',
		fontWeight: 700,
		fontVariantNumeric: 'tabular-nums',
	},
	// Рейтинг-строка: label + трек + число.
	rankingRow: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1.2fr) minmax(100px, 1fr) auto',
		gap: '12px',
		alignItems: 'center',
	},
	rankingText: {
		display: 'flex',
		flexDirection: 'column',
		gap: '2px',
		minWidth: 0,
	},
	rankingLabel: {
		fontSize: '12px',
		fontWeight: 600,
		wordBreak: 'break-word',
	},
	rankingSecondary: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
	},
	// Трек прогресс-бара — тонкий (6px), скруглённый.
	rankingTrack: {
		height: '6px',
		borderRadius: '999px',
		overflow: 'hidden',
		background: 'color-mix(in srgb, var(--vscode-foreground) 8%, transparent)',
	},
	rankingFill: {
		height: '100%',
		borderRadius: '999px',
		background: 'var(--vscode-progressBar-background)',
	},
	rankingValue: {
		fontSize: '12px',
		fontWeight: 700,
		fontVariantNumeric: 'tabular-nums',
	},
	// Сетка карточек последних коммитов.
	recentGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
		gap: '14px',
	},
	// Карточка коммита — тонкая рамка, hover через CSS global.
	recentCard: {
		appearance: 'none',
		WebkitAppearance: 'none',
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		padding: '14px 16px',
		borderRadius: '10px',
		border: '1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent)',
		boxShadow: '0 1px 4px 0 color-mix(in srgb, var(--vscode-foreground) 5%, transparent)',
		background: 'var(--vscode-editor-background)',
		color: 'var(--vscode-foreground)',
		cursor: 'pointer',
		textAlign: 'left',
		fontFamily: 'var(--vscode-font-family)',
		transition: 'border-color 160ms ease',
	},
	recentHeader: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		flexWrap: 'wrap',
	},
	// Бейдж типа коммита — плоский, мягкий фон.
	recentBadge: {
		padding: '2px 8px',
		borderRadius: '6px',
		background: 'color-mix(in srgb, var(--vscode-button-background) 12%, transparent)',
		fontSize: '10px',
		fontWeight: 700,
		textTransform: 'uppercase',
		letterSpacing: '0.04em',
	},
	recentSha: {
		fontSize: '11px',
		fontFamily: 'var(--vscode-editor-font-family)',
		color: 'var(--vscode-textLink-foreground)',
	},
	recentDate: {
		marginLeft: 'auto',
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
	},
	recentMessage: {
		fontSize: '12px',
		fontWeight: 700,
		lineHeight: 1.45,
	},
	recentMeta: {
		fontSize: '11px',
		lineHeight: 1.5,
		color: 'var(--vscode-descriptionForeground)',
	},
	recentSubtle: {
		fontSize: '10px',
		lineHeight: 1.5,
		color: 'var(--vscode-descriptionForeground)',
	},
};