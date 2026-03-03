import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';

type TimelinePoint = { date: string; used: number; limit: number };
type UsageViewModel = {
	used: number;
	limit: number;
	avgPerDay: number;
	periodStart: string;
	periodEnd: string;
	lastUpdated: string;
	authenticated: boolean;
	planType: string;
	source: 'api' | 'inferred' | 'local';
	lastSyncStatus?: string;
	percent: number;
	remaining: number;
	daysPassed: number;
	daysRemaining: number;
	recommendedPerDay: number;
	timeline: TimelinePoint[];
	debugLog?: string;
};

const vscode = getVsCodeApi();

function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('ru-RU');
}

function formatDateTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU');
}

function formatPercent(value: number): string {
	const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
	return `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(safe)}%`;
}

const getToneColor = (percent: number): string => {
	if (percent >= 91) return 'var(--vscode-errorForeground)';
	if (percent >= 76) return 'var(--vscode-charts-orange)';
	if (percent >= 51) return 'var(--vscode-editorWarning-foreground)';
	return 'var(--vscode-foreground)';
};

const MiniLineChart: React.FC<{ points: TimelinePoint[] }> = ({ points }) => {
	const { path, maxY } = useMemo(() => {
		if (points.length <= 1) {
			return { path: '', maxY: Math.max(points[0]?.used ?? 0, 1) };
		}
		const width = 100;
		const height = 32;
		const maxValue = Math.max(1, ...points.map(point => point.used));
		const commands = points.map((point, index) => {
			const x = (index / (points.length - 1)) * width;
			const y = height - (point.used / maxValue) * height;
			return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
		}).join(' ');
		return { path: commands, maxY: maxValue };
	}, [points]);

	if (points.length === 0) {
		return <div style={styles.emptyChart}>Нет данных для графика</div>;
	}

	return (
		<div style={styles.chartWrap}>
			<svg viewBox="0 0 100 32" preserveAspectRatio="none" style={styles.chartSvg}>
				<line x1="0" y1="31" x2="100" y2="31" stroke="var(--vscode-panel-border)" strokeWidth="1" />
				<path d={path} fill="none" stroke="var(--vscode-textLink-foreground)" strokeWidth="2" />
			</svg>
			<div style={styles.chartMeta}>
				<span>max: {maxY}</span>
				<span>{formatDate(points[0].date)} → {formatDate(points[points.length - 1].date)}</span>
			</div>
		</div>
	);
};

const DailyBars: React.FC<{ points: TimelinePoint[] }> = ({ points }) => {
	const bars = useMemo(() => {
		if (points.length === 0) return [] as Array<{ date: string; delta: number }>;
		const rows: Array<{ date: string; delta: number }> = [];
		for (let index = 0; index < points.length; index += 1) {
			const current = points[index];
			const previous = points[index - 1];
			const delta = previous ? Math.max(0, current.used - previous.used) : 0;
			rows.push({ date: current.date, delta });
		}
		return rows.slice(-14);
	}, [points]);

	const maxDelta = Math.max(1, ...bars.map(item => item.delta));

	if (bars.length === 0) {
		return <div style={styles.emptyChart}>Нет данных для дневной динамики</div>;
	}

	return (
		<div style={styles.barChart}>
			{bars.map(item => (
				<div key={item.date} style={styles.barItem} title={`${formatDate(item.date)}: +${item.delta}`}>
					<div
						style={{
							...styles.barValue,
							height: `${Math.max(8, (item.delta / maxDelta) * 100)}%`,
						}}
					/>
					<span style={styles.barLabel}>{new Date(item.date).getDate()}</span>
				</div>
			))}
		</div>
	);
};

export const CopilotUsageApp: React.FC = () => {
	const [data, setData] = useState<UsageViewModel | null>(null);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [refreshedAt, setRefreshedAt] = useState<string>('');

	const requestData = useCallback(() => {
		setIsRefreshing(true);
		vscode.postMessage({ type: 'copilotUsage.refresh' });
	}, []);

	useEffect(() => {
		vscode.postMessage({ type: 'copilotUsage.ready' });
	}, []);

	useMessageListener((msg: any) => {
		if (msg?.type === 'copilotUsage.data') {
			setData(msg.data as UsageViewModel);
			setIsRefreshing(false);
		}
		if (msg?.type === 'copilotUsage.refreshed') {
			setRefreshedAt(String(msg.at || ''));
			setIsRefreshing(false);
		}
	});

	if (!data) {
		return <div style={styles.loading}>Загрузка статистики Copilot Premium...</div>;
	}

	if (!data.authenticated) {
		return (
			<div style={styles.page}>
				<h2 style={styles.title}>Copilot Premium Usage</h2>
				<div style={styles.authCard}>
					<div style={styles.authTitle}>Авторизуйтесь для просмотра статистики</div>
					<div style={styles.authText}>Расширение не получило GitHub-сессию с нужными правами доступа.</div>
					<div style={styles.actionsRow}>
						<button style={styles.primaryButton} onClick={() => vscode.postMessage({ type: 'copilotUsage.auth' })}>Авторизоваться</button>
						<button style={styles.secondaryButton} onClick={() => vscode.postMessage({ type: 'copilotUsage.openGitHub' })}>Открыть GitHub Copilot</button>
					</div>
				</div>
			</div>
		);
	}

	const toneColor = getToneColor(data.percent);
	const percentText = formatPercent(data.percent);

	return (
		<div style={styles.page}>
			<div style={styles.headerRow}>
				<div>
					<h2 style={styles.title}>Copilot Premium Usage</h2>
					<div style={styles.subTitle}>Период: {formatDate(data.periodStart)} — {formatDate(data.periodEnd)}</div>
				</div>
				<div style={styles.actionsRow}>
					<button style={styles.secondaryButton} onClick={requestData}>{isRefreshing ? 'Обновление…' : 'Обновить'}</button>
					<button style={styles.secondaryButton} onClick={() => vscode.postMessage({ type: 'copilotUsage.openSettings' })}>Настройки</button>
					<button style={styles.secondaryButton} onClick={() => vscode.postMessage({ type: 'copilotUsage.openGitHub' })}>GitHub</button>
				</div>
			</div>

			<div style={styles.mainGrid}>
				<div style={styles.leftCol}>
					<div style={styles.cards}>
						<div style={styles.card}>
							<div style={{ ...styles.cardValue, color: toneColor }}>{data.used}/{data.limit}</div>
							<div style={styles.cardLabel}>Использовано</div>
						</div>
						<div style={styles.card}>
							<div style={styles.cardValue}>{percentText}</div>
							<div style={styles.cardLabel}>Заполнение лимита</div>
						</div>
						<div style={styles.card}>
							<div style={styles.cardValue}>{data.remaining}</div>
							<div style={styles.cardLabel}>Осталось запросов</div>
						</div>
						<div style={styles.card}>
							<div style={styles.cardValue}>{data.avgPerDay}</div>
							<div style={styles.cardLabel}>Среднее в день</div>
						</div>
					</div>

					<div style={styles.progressSection}>
						<div style={styles.progressHeader}>
							<span>Прогресс месяца</span>
							<span style={{ color: toneColor }}>{percentText}</span>
						</div>
						<div style={styles.progressTrack}>
							<div style={{ ...styles.progressFill, width: `${Math.min(100, data.percent)}%`, backgroundColor: toneColor }} />
						</div>
						<div style={styles.metaGrid}>
							<div>Подписка: <b>{data.planType}</b></div>
							<div>Осталось дней: <b>{data.daysRemaining}</b></div>
							<div>Реком. темп: <b>{data.recommendedPerDay}/день</b></div>
							<div>Источник: <b>{data.source}</b></div>
						</div>
					</div>

					<div style={styles.section}>
						<h3 style={styles.sectionTitle}>Тренд накопления usage</h3>
						<MiniLineChart points={data.timeline} />
					</div>
				</div>

				<div style={styles.rightCol}>
					<div style={styles.sectionTall}>
						<h3 style={styles.sectionTitle}>Запросы по дням (последние 14)</h3>
						<DailyBars points={data.timeline} />
					</div>
					<div style={styles.sectionInfo}>
						<h3 style={styles.sectionTitle}>Статус источника данных</h3>
						<div style={styles.infoText}>GitHub API usage может не возвращать данные из токена VS Code (ограничение scopes / endpoint-доступа).</div>
						<div style={styles.infoText}>Если API недоступен, используются локальные источники state.vscdb и кэш расширения.</div>
						<div style={styles.infoText}>Текущий источник: <b>{data.source}</b></div>
					</div>
					<div style={styles.footerInfo}>
						<div>Последнее обновление: {formatDateTime(data.lastUpdated)}</div>
						<div>Ручное обновление: {refreshedAt ? formatDateTime(refreshedAt) : '—'}</div>
						<div style={styles.debugLine}>Диагностика API: {data.lastSyncStatus || 'n/a'}</div>
						<div style={styles.debugHeaderRow}>
							<b>Debug log</b>
							<button
								style={styles.copyButton}
								onClick={() => {
									const text = data.debugLog || '';
									if (text) {
										navigator.clipboard?.writeText(text).catch(() => undefined);
									}
								}}
							>
								Копировать
							</button>
						</div>
						<pre style={styles.debugLogBlock}>{data.debugLog || 'no debug log'}</pre>
					</div>
				</div>
			</div>
		</div>
	);
};

const styles: Record<string, React.CSSProperties> = {
	page: {
		padding: '14px 16px',
		height: '100vh',
		minHeight: '100vh',
		overflowY: 'auto',
		color: 'var(--vscode-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		background: 'var(--vscode-editor-background)',
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
	},
	loading: {
		padding: '32px',
		color: 'var(--vscode-descriptionForeground)',
	},
	headerRow: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: '12px',
		padding: '8px 0 4px',
		flexWrap: 'wrap',
		position: 'sticky',
		top: 0,
		zIndex: 2,
		background: 'var(--vscode-editor-background)',
	},
	mainGrid: {
		display: 'grid',
		gridTemplateColumns: '2fr 1fr',
		gap: '12px',
		flex: 1,
		minHeight: 0,
	},
	leftCol: {
		display: 'grid',
		gap: '12px',
		alignContent: 'start',
		minHeight: 0,
	},
	rightCol: {
		display: 'grid',
		gridTemplateRows: '1fr auto',
		gap: '12px',
		minHeight: 0,
	},
	title: {
		margin: 0,
		fontSize: '20px',
		fontWeight: 700,
	},
	subTitle: {
		marginTop: '6px',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '12px',
	},
	actionsRow: {
		display: 'flex',
		gap: '8px',
		flexWrap: 'wrap',
	},
	primaryButton: {
		padding: '6px 12px',
		background: 'var(--vscode-button-background)',
		color: 'var(--vscode-button-foreground)',
		border: 'none',
		borderRadius: '6px',
		cursor: 'pointer',
		fontFamily: 'var(--vscode-font-family)',
	},
	secondaryButton: {
		padding: '6px 12px',
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		border: 'none',
		borderRadius: '6px',
		cursor: 'pointer',
		fontFamily: 'var(--vscode-font-family)',
	},
	cards: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
		gap: '12px',
		marginBottom: '16px',
	},
	card: {
		padding: '12px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
		background: 'var(--vscode-sideBar-background)',
	},
	cardValue: {
		fontSize: '24px',
		fontWeight: 700,
		lineHeight: 1.2,
	},
	cardLabel: {
		marginTop: '6px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
	},
	progressSection: {
		padding: '14px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
		marginBottom: '16px',
	},
	progressHeader: {
		display: 'flex',
		justifyContent: 'space-between',
		fontSize: '13px',
		marginBottom: '8px',
		fontWeight: 600,
	},
	progressTrack: {
		height: '10px',
		background: 'var(--vscode-editorWidget-border)',
		borderRadius: '999px',
		overflow: 'hidden',
	},
	progressFill: {
		height: '100%',
		borderRadius: '999px',
		transition: 'width .2s ease',
	},
	metaGrid: {
		marginTop: '10px',
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
		gap: '8px',
		fontSize: '12px',
	},
	section: {
		padding: '14px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
		background: 'var(--vscode-editor-background)',
	},
	sectionTall: {
		padding: '14px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
		background: 'var(--vscode-editor-background)',
		display: 'flex',
		flexDirection: 'column',
		minHeight: 0,
	},
	sectionInfo: {
		padding: '14px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
		background: 'var(--vscode-editor-background)',
		display: 'grid',
		gap: '6px',
	},
	infoText: {
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.35,
	},
	sectionTitle: {
		margin: '0 0 10px',
		fontSize: '14px',
		fontWeight: 700,
	},
	chartWrap: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
	},
	chartSvg: {
		width: '100%',
		height: '120px',
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '6px',
	},
	chartMeta: {
		display: 'flex',
		justifyContent: 'space-between',
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
	},
	barChart: {
		display: 'grid',
		gridTemplateColumns: 'repeat(14, minmax(12px, 1fr))',
		alignItems: 'end',
		gap: '6px',
		height: '220px',
		flex: 1,
		padding: '8px 0',
	},
	barItem: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		height: '100%',
		justifyContent: 'flex-end',
		gap: '4px',
	},
	barValue: {
		width: '100%',
		background: 'var(--vscode-textLink-foreground)',
		minHeight: '6px',
		borderRadius: '4px 4px 0 0',
	},
	barLabel: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
	},
	emptyChart: {
		padding: '12px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		border: '1px dashed var(--vscode-panel-border)',
		borderRadius: '6px',
	},
	authCard: {
		marginTop: '16px',
		padding: '16px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
		background: 'var(--vscode-sideBar-background)',
		display: 'grid',
		gap: '10px',
	},
	authTitle: {
		fontWeight: 700,
		fontSize: '16px',
	},
	authText: {
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '13px',
	},
	footerInfo: {
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		display: 'grid',
		gap: '4px',
		padding: '10px 12px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
		background: 'var(--vscode-editor-background)',
	},
	debugLine: {
		fontFamily: 'var(--vscode-editor-font-family, var(--vscode-font-family))',
		fontSize: '11px',
		wordBreak: 'break-all',
	},
	debugHeaderRow: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: '8px',
		marginTop: '4px',
	},
	copyButton: {
		padding: '2px 8px',
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		border: 'none',
		borderRadius: '4px',
		cursor: 'pointer',
		fontSize: '11px',
		fontFamily: 'var(--vscode-font-family)',
	},
	debugLogBlock: {
		margin: 0,
		padding: '8px',
		maxHeight: '220px',
		overflow: 'auto',
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '6px',
		fontSize: '11px',
		fontFamily: 'var(--vscode-editor-font-family, var(--vscode-font-family))',
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	},
};
