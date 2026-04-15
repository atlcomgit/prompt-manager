import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';

/** Точка timeline: дата + кумулятивное использование + лимит */
type TimelinePoint = { date: string; used: number; limit: number };

/** Состояние переключения аккаунта */
type AccountSwitchState = {
	isSwitching: boolean;
	phase: 'idle' | 'detected' | 'syncing-extension' | 'awaiting-session' | 'refreshing-usage' | 'completed' | 'error';
	message: string;
	accountLabel: string | null;
	startedAt: string | null;
	updatedAt: string;
};

/** View-модель данных, получаемая из extension host */
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
	copilotPreferredGitHubLabel?: string | null;
	promptManagerPreferredGitHubLabel?: string | null;
	activeGithubSessionAccountLabel?: string | null;
	githubSessionIssue?: string | null;
	availableGitHubAccounts?: Array<{ id: string; label: string }>;
	accountSwitchState?: AccountSwitchState;
};

const vscode = getVsCodeApi();

/** Форматирует ISO-дату в локализованный формат дд.мм.гггг */
function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('ru-RU');
}

/** Форматирует ISO-дату+время в локализованный формат */
function formatDateTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU');
}

/** Форматирует число как процент с 2 знаками */
function formatPercent(value: number): string {
	const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
	return `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(safe)}%`;
}

/** Форматирует число с заданной точностью */
function formatNumber(value: number, maximumFractionDigits = 1): string {
	const safe = Number.isFinite(value) ? value : 0;
	return new Intl.NumberFormat('ru-RU', {
		minimumFractionDigits: 0,
		maximumFractionDigits,
	}).format(safe);
}

/** Форматирует дату в короткий вид дд.мм */
function formatShortDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const d = String(date.getDate()).padStart(2, '0');
	const m = String(date.getMonth() + 1).padStart(2, '0');
	return `${d}.${m}`;
}

/** Возвращает цвет тона в зависимости от процента использования */
const getToneColor = (percent: number): string => {
	if (percent >= 91) return 'var(--vscode-errorForeground)';
	if (percent >= 76) return 'var(--vscode-charts-orange)';
	if (percent >= 51) return 'var(--vscode-editorWarning-foreground)';
	return 'var(--vscode-foreground)';
};

/** Возвращает цвет бара в зависимости от delta и рекомендованного значения */
function getBarColor(delta: number, recommended: number): string {
	if (recommended <= 0) return 'var(--vscode-textLink-foreground)';
	if (delta > recommended * 2) return 'var(--vscode-errorForeground)';
	if (delta > recommended) return 'var(--vscode-charts-orange)';
	return 'var(--vscode-testing-iconPassed)';
}

/** Заголовок для оверлея переключения аккаунта */
function getAccountSwitchTitle(state: AccountSwitchState | null): string {
	switch (state?.phase) {
		case 'syncing-extension':
			return 'Синхронизируем Prompt Manager';
		case 'awaiting-session':
			return 'Ждём GitHub-сессию';
		case 'refreshing-usage':
			return 'Обновляем Copilot Premium Usage';
		case 'completed':
			return 'Аккаунт обновлён';
		case 'error':
			return 'Ошибка смены аккаунта';
		case 'detected':
		default:
			return 'Переключение аккаунта';
	}
}

/**
 * Генерирует Catmull-Rom сплайн через точки — возвращает SVG path data.
 * Даёт плавную кривую, проходящую через все точки.
 */
function catmullRomPath(
	points: Array<{ x: number; y: number }>,
	tension = 0.3,
): string {
	if (points.length < 2) return '';
	if (points.length === 2) {
		return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)} L ${points[1].x.toFixed(2)} ${points[1].y.toFixed(2)}`;
	}

	const segments: string[] = [`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`];

	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[Math.max(0, i - 1)];
		const p1 = points[i];
		const p2 = points[i + 1];
		const p3 = points[Math.min(points.length - 1, i + 2)];

		/** Контрольные точки по Catmull-Rom */
		const cp1x = p1.x + (p2.x - p0.x) * tension / 3;
		const cp1y = p1.y + (p2.y - p0.y) * tension / 3;
		const cp2x = p2.x - (p3.x - p1.x) * tension / 3;
		const cp2y = p2.y - (p3.y - p1.y) * tension / 3;

		segments.push(`C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`);
	}

	return segments.join(' ');
}

// ---------------------------------------------------------------------------
//  TrendAreaChart — SVG area chart с градиентом, сеткой и линией лимита
// ---------------------------------------------------------------------------

/** Area chart с Catmull-Rom сглаживанием, градиентом и линией лимита */
const TrendAreaChart: React.FC<{ points: TimelinePoint[]; limit: number }> = ({ points, limit }) => {
	const chartId = useMemo(() => `trend-${Date.now()}`, []);

	const { linePath, areaPath, maxY, yTicks, xLabels, limitY, hoverPoints } = useMemo(() => {
		if (points.length === 0) {
			return { linePath: '', areaPath: '', maxY: 1, yTicks: [] as number[], xLabels: [] as Array<{ x: number; label: string }>, limitY: 0, hoverPoints: [] as Array<{ cx: number; cy: number; label: string; used: number }> };
		}

		/** Настройки размеров SVG viewBox */
		const W = 600;
		const H = 200;
		const padL = 48;
		const padR = 12;
		const padT = 16;
		const padB = 28;
		const chartW = W - padL - padR;
		const chartH = H - padT - padB;

		/** Определяем максимум оси Y: максимум из used и limit */
		const maxUsed = Math.max(1, ...points.map(p => p.used));
		const rawMax = Math.max(maxUsed, limit > 0 ? limit : 0);
		/** Округление вверх до ближайших 50 */
		const maxVal = Math.ceil(rawMax / 50) * 50 || rawMax;

		/** Горизонтальные линии сетки: 0, 25%, 50%, 75%, 100% от maxVal */
		const ticks = [0, 0.25, 0.5, 0.75, 1].map(frac => Math.round(frac * maxVal));

		/** Преобразование точек в координаты SVG */
		const svgPoints = points.map((p, i) => ({
			x: padL + (points.length > 1 ? (i / (points.length - 1)) * chartW : chartW / 2),
			y: padT + chartH - (p.used / maxVal) * chartH,
		}));

		/** Подписи оси X — прореживаем, показываем не более 8 */
		const maxXLabels = 8;
		const step = Math.max(1, Math.floor(points.length / maxXLabels));
		const xLbls: Array<{ x: number; label: string }> = [];
		for (let i = 0; i < points.length; i += step) {
			xLbls.push({ x: svgPoints[i].x, label: formatShortDate(points[i].date) });
		}
		/** Всегда добавляем последнюю точку если не уже включена */
		const lastIdx = points.length - 1;
		if (lastIdx % step !== 0) {
			xLbls.push({ x: svgPoints[lastIdx].x, label: formatShortDate(points[lastIdx].date) });
		}

		/** SVG path для сглаженной линии */
		const line = catmullRomPath(svgPoints);

		/** SVG path для области под линией (закрашенный градиент) */
		const area = svgPoints.length > 0
			? `${line} L ${svgPoints[svgPoints.length - 1].x.toFixed(2)} ${padT + chartH} L ${svgPoints[0].x.toFixed(2)} ${padT + chartH} Z`
			: '';

		/** Координата Y для горизонтальной линии лимита */
		const limY = limit > 0 ? padT + chartH - (limit / maxVal) * chartH : -10;

		/** Точки для hover-эффекта */
		const hPts = svgPoints.map((pt, i) => ({
			cx: pt.x,
			cy: pt.y,
			label: formatShortDate(points[i].date),
			used: points[i].used,
		}));

		return { linePath: line, areaPath: area, maxY: maxVal, yTicks: ticks, xLabels: xLbls, limitY: limY, hoverPoints: hPts };
	}, [points, limit, chartId]);

	if (points.length === 0) {
		return <div style={styles.emptyChart}>Нет данных для графика</div>;
	}

	return (
		<div style={styles.chartWrap}>
			<svg viewBox="0 0 600 200" preserveAspectRatio="xMidYMid meet" style={styles.chartSvg}>
				<defs>
					{/* Вертикальный градиент: от полупрозрачного цвета линии до прозрачного */}
					<linearGradient id={`${chartId}-grad`} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor="var(--vscode-textLink-foreground)" stopOpacity="0.35" />
						<stop offset="100%" stopColor="var(--vscode-textLink-foreground)" stopOpacity="0.03" />
					</linearGradient>
				</defs>

				{/* Горизонтальные grid-линии + подписи оси Y */}
				{yTicks.map((tick, i) => {
					const y = 16 + (200 - 16 - 28) - (tick / maxY) * (200 - 16 - 28);
					return (
						<g key={`ytick-${i}`}>
							<line x1="48" y1={y} x2="588" y2={y} stroke="var(--vscode-panel-border)" strokeWidth="0.5" strokeDasharray={i > 0 ? '4,3' : undefined} />
							<text x="44" y={y + 3} textAnchor="end" fill="var(--vscode-descriptionForeground)" fontSize="9" fontFamily="var(--vscode-font-family)">{tick}</text>
						</g>
					);
				})}

				{/* Подписи оси X */}
				{xLabels.map((lbl, i) => (
					<text key={`xlabel-${i}`} x={lbl.x} y={196} textAnchor="middle" fill="var(--vscode-descriptionForeground)" fontSize="9" fontFamily="var(--vscode-font-family)">{lbl.label}</text>
				))}

				{/* Закрашенная область под линией */}
				{areaPath && <path d={areaPath} fill={`url(#${chartId}-grad)`} />}

				{/* Основная линия тренда */}
				<path d={linePath} fill="none" stroke="var(--vscode-textLink-foreground)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

				{/* Пунктирная линия лимита */}
				{limit > 0 && limitY >= 0 && limitY <= 200 && (
					<>
						<line x1="48" y1={limitY} x2="588" y2={limitY} stroke="var(--vscode-errorForeground)" strokeWidth="1" strokeDasharray="6,4" opacity="0.6" />
						<text x="588" y={limitY - 4} textAnchor="end" fill="var(--vscode-errorForeground)" fontSize="9" opacity="0.7" fontFamily="var(--vscode-font-family)">лимит: {limit}</text>
					</>
				)}

				{/* Hover-точки */}
				{hoverPoints.map((pt, i) => (
					<circle key={`pt-${i}`} cx={pt.cx} cy={pt.cy} r="3" fill="var(--vscode-textLink-foreground)" opacity="0" stroke="none">
						<title>{`${pt.label}: ${pt.used}`}</title>
						<set attributeName="opacity" to="1" begin="mouseover" end="mouseout" />
					</circle>
				))}
			</svg>

			{/* Мета-подписи под графиком */}
			<div style={styles.chartMeta}>
				<span>{formatDate(points[0].date)} → {formatDate(points[points.length - 1].date)}</span>
				<span>max: {Math.max(...points.map(p => p.used))}</span>
			</div>
		</div>
	);
};

// ---------------------------------------------------------------------------
//  DailyBars — столбчатая диаграмма запросов по дням
// ---------------------------------------------------------------------------

/** Столбчатая диаграмма дневных приростов с цветовым кодированием */
const DailyBars: React.FC<{ points: TimelinePoint[]; recommendedPerDay: number }> = ({ points, recommendedPerDay }) => {
	const bars = useMemo(() => {
		if (points.length === 0) return [] as Array<{ date: string; delta: number }>;
		const rows: Array<{ date: string; delta: number }> = [];
		for (let index = 0; index < points.length; index += 1) {
			const current = points[index];
			const previous = points[index - 1];
			/** Delta = прирост использования за день */
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
			{bars.map(item => {
				/** Цвет бара зависит от delta относительно рекомендованного значения */
				const barColor = getBarColor(item.delta, recommendedPerDay);
				return (
					<div key={item.date} style={styles.barItem} title={`${formatShortDate(item.date)}: +${item.delta}`}>
						{/* Значение delta над баром */}
						<span style={styles.barDeltaLabel}>{item.delta > 0 ? `+${item.delta}` : ''}</span>
						<div
							style={{
								...styles.barValue,
								height: `${Math.max(4, (item.delta / maxDelta) * 100)}%`,
								background: barColor,
							}}
						/>
						{/* Подпись даты дд.мм */}
						<span style={styles.barLabel}>{formatShortDate(item.date)}</span>
					</div>
				);
			})}
		</div>
	);
};

// ---------------------------------------------------------------------------
//  CopilotUsageApp — корневой компонент страницы
// ---------------------------------------------------------------------------

export const CopilotUsageApp: React.FC = () => {
	const [data, setData] = useState<UsageViewModel | null>(null);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [accountSwitchState, setAccountSwitchState] = useState<AccountSwitchState | null>(null);
	const [refreshedAt, setRefreshedAt] = useState<string>('');
	const [accountSwitchMessage, setAccountSwitchMessage] = useState<string>('');
	/** Видимость debug-лога (аккордеон) */
	const [debugOpen, setDebugOpen] = useState(false);
	const isSwitchingAccount = Boolean(accountSwitchState?.isSwitching);

	/** Запрос принудительного обновления данных */
	const requestData = useCallback(() => {
		setIsRefreshing(true);
		vscode.postMessage({ type: 'copilotUsage.refresh' });
	}, []);

	/** Запрос смены аккаунта */
	const switchAccount = useCallback(() => {
		setAccountSwitchMessage('');
		vscode.postMessage({ type: 'copilotUsage.switchAccount' });
	}, []);

	/** Сигнализируем extension-host о готовности webview */
	useEffect(() => {
		vscode.postMessage({ type: 'copilotUsage.ready' });
	}, []);

	/** Обработка входящих сообщений от extension host */
	useMessageListener((msg: any) => {
		if (msg?.type === 'copilotUsage.data') {
			const nextData = msg.data as UsageViewModel;
			setData(nextData);
			setAccountSwitchState(nextData.accountSwitchState || null);
			setIsRefreshing(false);
		}
		if (msg?.type === 'copilotUsage.refreshed') {
			setRefreshedAt(String(msg.at || ''));
			setIsRefreshing(false);
		}
		if (msg?.type === 'copilotUsage.accountSwitching') {
			const nextState = (msg.state || null) as AccountSwitchState | null;
			setAccountSwitchState(nextState);
			if (nextState?.isSwitching) {
				setAccountSwitchMessage('');
			}
		}
		if (msg?.type === 'copilotUsage.accountSwitchResult') {
			setAccountSwitchMessage(String(msg.result?.message || ''));
		}
	});

	/** Состояние загрузки */
	if (!data) {
		return <div style={styles.loading}>Загрузка статистики Copilot Premium...</div>;
	}

	/** Оверлей переключения аккаунта */
	const switchingOverlay = isSwitchingAccount ? (
		<div style={styles.switchingOverlay}>
			<style>{`@keyframes copilot-spin { to { transform: rotate(360deg); } }`}</style>
			<div style={styles.switchingCard}>
				<div style={{ fontSize: '28px', lineHeight: 1, animation: 'copilot-spin 1s linear infinite', display: 'inline-block' }}>&#x21BB;</div>
				<div style={styles.switchingTitle}>{getAccountSwitchTitle(accountSwitchState)}</div>
				<div style={styles.switchingText}>{accountSwitchState?.message || 'Обновляются данные расширения и статус-бар'}</div>
				{accountSwitchState?.accountLabel ? <div style={styles.switchingText}>Аккаунт: {accountSwitchState.accountLabel}</div> : null}
			</div>
		</div>
	) : null;

	/** Экран авторизации */
	if (!data.authenticated) {
		return (
			<div style={styles.page}>
				{switchingOverlay}
				<h2 style={styles.title}>Copilot Premium Usage</h2>
				<div style={styles.authCard}>
					<div style={styles.authTitle}>Авторизуйтесь для просмотра статистики</div>
					<div style={styles.authText}>Расширение не получило GitHub-сессию с нужными правами доступа.</div>
					<div style={styles.authText}>Copilot Chat: <b>{data.copilotPreferredGitHubLabel || 'не определён'}</b></div>
					<div style={styles.authText}>Prompt Manager session: <b>{data.activeGithubSessionAccountLabel || 'недоступна'}</b></div>
					{data.githubSessionIssue ? <div style={styles.warningBox}>{data.githubSessionIssue}</div> : null}
					{accountSwitchMessage ? <div style={styles.infoBox}>{accountSwitchMessage}</div> : null}
					<div style={styles.actionsRow}>
						<button style={styles.primaryButton} onClick={() => vscode.postMessage({ type: 'copilotUsage.auth' })}>Авторизоваться</button>
						<button style={styles.secondaryButton} onClick={switchAccount} disabled={isSwitchingAccount}>{isSwitchingAccount ? 'Переключение…' : 'Сменить аккаунт'}</button>
						<button style={styles.secondaryButton} onClick={() => vscode.postMessage({ type: 'copilotUsage.openGitHub' })}>Открыть GitHub Copilot</button>
					</div>
				</div>
			</div>
		);
	}

	/** Вычисление прогноза расхода */
	const toneColor = getToneColor(data.percent);
	const percentText = formatPercent(data.percent);
	const forecast = (() => {
		const dailyDeltas = data.timeline.reduce<Array<{ date: string; delta: number }>>((rows, point, index) => {
			const previous = data.timeline[index - 1];
			const delta = previous ? Math.max(0, point.used - previous.used) : 0;
			rows.push({ date: point.date, delta });
			return rows;
		}, []);

		const recentWindow = dailyDeltas.slice(-7).filter(item => item.delta > 0);
		const windowForAverage = recentWindow.length > 0 ? recentWindow : dailyDeltas.slice(-7);
		const recentAverage = windowForAverage.length > 0
			? windowForAverage.reduce((sum, item) => sum + item.delta, 0) / windowForAverage.length
			: data.avgPerDay;
		const projectedAdditional = Math.max(0, recentAverage) * Math.max(0, data.daysRemaining);
		const projectedUsed = data.used + projectedAdditional;
		const projectedRemaining = data.limit - projectedUsed;
		const safeDailyBudget = data.daysRemaining > 0 ? data.remaining / data.daysRemaining : data.remaining;
		const daysUntilLimit = recentAverage > 0 ? data.remaining / recentAverage : Number.POSITIVE_INFINITY;
		const fitsMonth = projectedUsed <= data.limit;
		const recommendation = recentAverage <= 0
			? `Расход почти не наблюдается. Можно держать темп до ${formatNumber(data.recommendedPerDay)} запросов в день.`
			: fitsMonth
				? recentAverage <= data.recommendedPerDay
					? `Темп комфортный. Можно держаться около ${formatNumber(recentAverage)} в день, лимита должно хватить.`
					: `Лимита пока хватит, но темп выше рекомендованного. Лучше снизиться ближе к ${formatNumber(data.recommendedPerDay)} в день.`
				: `При текущем темпе лимит закончится раньше конца месяца. Целевой темп: не выше ${formatNumber(data.recommendedPerDay)} в день.`;

		return {
			recentAverage,
			projectedUsed,
			projectedRemaining,
			safeDailyBudget,
			daysUntilLimit,
			fitsMonth,
			recommendation,
		};
	})();

	return (
		<div style={styles.page}>
			{switchingOverlay}

			{/* ─── Шапка ─── */}
			<div style={styles.headerRow}>
				<div>
					<h2 style={styles.title}>Copilot Premium Usage</h2>
					<div style={styles.subTitle}>Период: {formatDate(data.periodStart)} — {formatDate(data.periodEnd)}</div>
					<div style={styles.subTitle}>Copilot Chat: {data.copilotPreferredGitHubLabel || 'не определён'} · Session: {data.activeGithubSessionAccountLabel || 'недоступна'}</div>
				</div>
				<div style={styles.actionsRow}>
					<button style={styles.secondaryButton} onClick={requestData} disabled={isSwitchingAccount}>{isRefreshing ? 'Обновление…' : 'Обновить'}</button>
					<button style={styles.secondaryButton} onClick={switchAccount} disabled={isSwitchingAccount}>{isSwitchingAccount ? 'Переключение…' : 'Сменить аккаунт'}</button>
					<button style={styles.secondaryButton} onClick={() => vscode.postMessage({ type: 'copilotUsage.openSettings' })}>Настройки</button>
					<button style={styles.secondaryButton} onClick={() => vscode.postMessage({ type: 'copilotUsage.openGitHub' })}>GitHub</button>
				</div>
			</div>

			{accountSwitchMessage ? <div style={styles.infoBox}>{accountSwitchMessage}</div> : null}
			{data.githubSessionIssue ? <div style={styles.warningBox}>{data.githubSessionIssue}</div> : null}

			{/* ─── Карточки основных метрик ─── */}
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

			{/* ─── Прогресс-бар месяца ─── */}
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

			{/* ─── Прогноз расхода ─── */}
			<div style={styles.forecastSection}>
				<h3 style={styles.sectionTitle}>Прогноз расхода и остатка</h3>
				<div style={styles.forecastGrid}>
					<div style={styles.forecastCard}>
						<div style={styles.forecastValue}>{formatNumber(forecast.projectedUsed)}</div>
						<div style={styles.cardLabel}>Прогноз usage к концу месяца</div>
					</div>
					<div style={styles.forecastCard}>
						<div style={{ ...styles.forecastValue, color: forecast.projectedRemaining < 0 ? 'var(--vscode-errorForeground)' : 'var(--vscode-foreground)' }}>
							{formatNumber(forecast.projectedRemaining)}
						</div>
						<div style={styles.cardLabel}>Прогноз остатка к концу месяца</div>
					</div>
					<div style={styles.forecastCard}>
						<div style={{ ...styles.forecastValue, color: forecast.fitsMonth ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-errorForeground)' }}>
							{forecast.fitsMonth ? 'Хватит' : 'Не хватит'}
						</div>
						<div style={styles.cardLabel}>Лимит при текущем темпе</div>
					</div>
				</div>
				<div style={styles.forecastMetaGrid}>
					<div>Текущий темп: <b>{formatNumber(forecast.recentAverage)} / день</b></div>
					<div>Безопасный темп: <b>{formatNumber(forecast.safeDailyBudget)} / день</b></div>
					<div>До исчерпания: <b>{Number.isFinite(forecast.daysUntilLimit) ? `${formatNumber(forecast.daysUntilLimit)} дн.` : 'запас большой'}</b></div>
				</div>
				<div style={styles.recommendationBox}>{forecast.recommendation}</div>
			</div>

			{/* ─── Запросы по дням (полная ширина) ─── */}
			<div style={styles.section}>
				<h3 style={styles.sectionTitle}>Запросы по дням (последние 14)</h3>
				<DailyBars points={data.timeline} recommendedPerDay={data.recommendedPerDay} />
			</div>

			{/* ─── Тренд накопления (полная ширина) ─── */}
			<div style={styles.section}>
				<h3 style={styles.sectionTitle}>Тренд накопления usage</h3>
				<TrendAreaChart points={data.timeline} limit={data.limit} />
			</div>

			{/* ─── Статус + Обновление + Debug (объединённый footer) ─── */}
			<div style={styles.statusFooter}>
				<div style={styles.statusRow}>
					<span>Источник: <b>{data.source}</b></span>
					<span>Copilot Chat: <b>{data.copilotPreferredGitHubLabel || 'не определён'}</b></span>
					<span>Session: <b>{data.activeGithubSessionAccountLabel || 'недоступна'}</b></span>
					<span>GitHub-аккаунтов: <b>{data.availableGitHubAccounts?.length || 0}</b></span>
				</div>
				<div style={styles.statusRow}>
					<span>Последнее обновление: {formatDateTime(data.lastUpdated)}</span>
					<span>Ручное обновление: {refreshedAt ? formatDateTime(refreshedAt) : '—'}</span>
					<span style={styles.debugLine}>API: {data.lastSyncStatus || 'n/a'}</span>
				</div>
				{/* Debug log — аккордеон */}
				<div style={styles.debugAccordion}>
					<button style={styles.debugToggle} onClick={() => setDebugOpen(prev => !prev)}>
						{debugOpen ? '▾' : '▸'} Debug log
					</button>
					{debugOpen && (
						<>
							<button
								style={styles.copyButton}
								onClick={() => {
									const text = data.debugLog || '';
									if (text) navigator.clipboard?.writeText(text).catch(() => undefined);
								}}
							>
								Копировать
							</button>
							<pre style={styles.debugLogBlock}>{data.debugLog || 'no debug log'}</pre>
						</>
					)}
				</div>
			</div>
		</div>
	);
};

// ---------------------------------------------------------------------------
//  Стили
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
	/** Корневая обёртка страницы */
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
	/** Индикатор загрузки */
	loading: {
		padding: '32px',
		color: 'var(--vscode-descriptionForeground)',
	},
	/** Шапка с заголовком и кнопками */
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
	/** Заголовок страницы */
	title: {
		margin: 0,
		fontSize: '20px',
		fontWeight: 700,
	},
	/** Подзаголовок */
	subTitle: {
		marginTop: '6px',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '12px',
	},
	/** Строка с кнопками действий */
	actionsRow: {
		display: 'flex',
		gap: '8px',
		flexWrap: 'wrap',
	},
	/** Основная кнопка */
	primaryButton: {
		padding: '6px 12px',
		background: 'var(--vscode-button-background)',
		color: 'var(--vscode-button-foreground)',
		border: 'none',
		borderRadius: '6px',
		cursor: 'pointer',
		fontFamily: 'var(--vscode-font-family)',
	},
	/** Вторичная кнопка */
	secondaryButton: {
		padding: '6px 12px',
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		border: 'none',
		borderRadius: '6px',
		cursor: 'pointer',
		fontFamily: 'var(--vscode-font-family)',
	},
	/** Сетка карточек метрик */
	cards: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
		gap: '12px',
	},
	/** Карточка метрики */
	card: {
		padding: '12px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
		background: 'var(--vscode-sideBar-background)',
	},
	/** Значение в карточке */
	cardValue: {
		fontSize: '24px',
		fontWeight: 700,
		lineHeight: 1.2,
	},
	/** Подпись в карточке */
	cardLabel: {
		marginTop: '6px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
	},
	/** Секция прогресс-бара */
	progressSection: {
		padding: '14px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
	},
	/** Заголовок прогресса с процентом */
	progressHeader: {
		display: 'flex',
		justifyContent: 'space-between',
		fontSize: '13px',
		marginBottom: '8px',
		fontWeight: 600,
	},
	/** Трек прогресс-бара */
	progressTrack: {
		height: '10px',
		background: 'var(--vscode-editorWidget-border)',
		borderRadius: '999px',
		overflow: 'hidden',
	},
	/** Заполнение прогресс-бара */
	progressFill: {
		height: '100%',
		borderRadius: '999px',
		transition: 'width .2s ease',
	},
	/** Сетка мета-информации */
	metaGrid: {
		marginTop: '10px',
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
		gap: '8px',
		fontSize: '12px',
	},
	/** Секция прогноза */
	forecastSection: {
		padding: '14px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
		background: 'var(--vscode-editor-background)',
		display: 'grid',
		gap: '12px',
	},
	/** Сетка карточек прогноза */
	forecastGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
		gap: '12px',
	},
	/** Карточка прогноза */
	forecastCard: {
		padding: '12px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
		background: 'var(--vscode-sideBar-background)',
	},
	/** Значение прогноза */
	forecastValue: {
		fontSize: '22px',
		fontWeight: 700,
		lineHeight: 1.2,
	},
	/** Мета-сетка прогноза */
	forecastMetaGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
		gap: '8px',
		fontSize: '12px',
	},
	/** Блок рекомендации */
	recommendationBox: {
		padding: '10px 12px',
		borderRadius: '8px',
		border: '1px solid var(--vscode-panel-border)',
		background: 'var(--vscode-sideBar-background)',
		fontSize: '12px',
		lineHeight: 1.45,
		color: 'var(--vscode-foreground)',
	},
	/** Универсальная секция */
	section: {
		padding: '14px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
		background: 'var(--vscode-editor-background)',
	},
	/** Заголовок секции */
	sectionTitle: {
		margin: '0 0 10px',
		fontSize: '14px',
		fontWeight: 700,
	},
	/** Обёртка графика тренда */
	chartWrap: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
	},
	/** SVG-элемент графика */
	chartSvg: {
		width: '100%',
		height: '220px',
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '6px',
	},
	/** Мета-подписи под графиком */
	chartMeta: {
		display: 'flex',
		justifyContent: 'space-between',
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
	},
	/** Сетка столбцов дневных запросов */
	barChart: {
		display: 'grid',
		gridTemplateColumns: 'repeat(14, minmax(12px, 1fr))',
		alignItems: 'end',
		gap: '6px',
		height: '220px',
		padding: '8px 0',
	},
	/**单 столбец бара */
	barItem: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		height: '100%',
		justifyContent: 'flex-end',
		gap: '2px',
	},
	/** Значение delta над баром */
	barDeltaLabel: {
		fontSize: '9px',
		color: 'var(--vscode-descriptionForeground)',
		fontWeight: 600,
		minHeight: '12px',
	},
	/** Тело бара */
	barValue: {
		width: '100%',
		minHeight: '4px',
		borderRadius: '4px 4px 0 0',
		transition: 'height 0.15s ease',
	},
	/** Подпись даты под баром */
	barLabel: {
		fontSize: '9px',
		color: 'var(--vscode-descriptionForeground)',
	},
	/** Пустой график */
	emptyChart: {
		padding: '12px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		border: '1px dashed var(--vscode-panel-border)',
		borderRadius: '6px',
	},
	/** Карточка авторизации */
	authCard: {
		marginTop: '16px',
		padding: '16px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
		background: 'var(--vscode-sideBar-background)',
		display: 'grid',
		gap: '10px',
	},
	/** Заголовок авторизации */
	authTitle: {
		fontWeight: 700,
		fontSize: '16px',
	},
	/** Текст авторизации */
	authText: {
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '13px',
	},
	/** Информационный блок */
	infoBox: {
		padding: '10px 12px',
		borderRadius: '8px',
		border: '1px solid var(--vscode-textLink-foreground)',
		background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 10%, transparent)',
		fontSize: '12px',
		lineHeight: 1.45,
	},
	/** Предупреждение */
	warningBox: {
		padding: '10px 12px',
		borderRadius: '8px',
		border: '1px solid var(--vscode-editorWarning-foreground)',
		background: 'color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, transparent)',
		fontSize: '12px',
		lineHeight: 1.45,
	},
	/** Футер со статусом и debug */
	statusFooter: {
		padding: '12px 14px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '8px',
		background: 'var(--vscode-sideBar-background)',
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
	},
	/** Строка статуса */
	statusRow: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: '12px',
	},
	/** Моноширинная строка диагностики */
	debugLine: {
		fontFamily: 'var(--vscode-editor-font-family, var(--vscode-font-family))',
		fontSize: '11px',
		wordBreak: 'break-all',
	},
	/** Аккордеон debug-лога */
	debugAccordion: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
	},
	/** Кнопка переключения debug-лога */
	debugToggle: {
		background: 'none',
		border: 'none',
		color: 'var(--vscode-descriptionForeground)',
		cursor: 'pointer',
		fontSize: '11px',
		padding: '2px 0',
		textAlign: 'left',
		fontFamily: 'var(--vscode-font-family)',
	},
	/** Кнопка копирования */
	copyButton: {
		padding: '2px 8px',
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		border: 'none',
		borderRadius: '4px',
		cursor: 'pointer',
		fontSize: '11px',
		fontFamily: 'var(--vscode-font-family)',
		alignSelf: 'flex-start',
	},
	/** Блок debug-лога */
	debugLogBlock: {
		margin: 0,
		padding: '8px',
		maxHeight: '180px',
		overflow: 'auto',
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '6px',
		fontSize: '11px',
		fontFamily: 'var(--vscode-editor-font-family, var(--vscode-font-family))',
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	},
	/** Оверлей переключения аккаунта */
	switchingOverlay: {
		position: 'fixed',
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		background: 'color-mix(in srgb, var(--vscode-editor-background) 85%, transparent)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		zIndex: 100,
		backdropFilter: 'blur(2px)',
	},
	/** Карточка переключения */
	switchingCard: {
		padding: '24px 32px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '12px',
		background: 'var(--vscode-sideBar-background)',
		textAlign: 'center' as const,
		display: 'flex',
		flexDirection: 'column' as const,
		alignItems: 'center',
		gap: '8px',
	},
	/** Заголовок оверлея */
	switchingTitle: {
		fontSize: '16px',
		fontWeight: 700,
	},
	/** Текст оверлея */
	switchingText: {
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
	},
};
