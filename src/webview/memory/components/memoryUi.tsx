import React from 'react';

// Нормализует процент для безопасного использования в прогресс-индикаторах.
export function clampPercent(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}

	return Math.max(0, Math.min(100, value));
}

// Форматирует байты в компактную человекочитаемую строку.
export function formatMemoryBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '0 B';
	}

	if (bytes < 1024) {
		return `${bytes} B`;
	}

	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}

	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Форматирует дату с учетом локали браузера webview.
export function formatMemoryDate(value?: string): string {
	if (!value) {
		return '—';
	}

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return date.toLocaleString();
}

// Форматирует длительность для runtime и статистики.
export function formatMemoryDuration(ms?: number): string {
	if (!ms || ms <= 0) {
		return '—';
	}

	if (ms < 1000) {
		return `${Math.round(ms)} ms`;
	}

	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)} s`;
	}

	return `${(ms / 60_000).toFixed(1)} min`;
}

// Форматирует процент для лейблов и круговых индикаторов.
export function formatMemoryPercent(value: number): string {
	return `${Math.round(clampPercent(value))}%`;
}

// Описывает одну вкладку сегментированного переключателя.
export interface MemorySegmentedTab<Value extends string> {
	value: Value;
	label: string;
	badge?: string | number;
}

interface MemorySegmentedTabsProps<Value extends string> {
	ariaLabel: string;
	items: ReadonlyArray<MemorySegmentedTab<Value>>;
	activeValue: Value;
	onChange: (value: Value) => void;
	stretch?: boolean;
}

// Рендерит общий сегментированный переключатель разделов и вкладок.
export function MemorySegmentedTabs<Value extends string>({
	ariaLabel,
	items,
	activeValue,
	onChange,
	stretch = false,
}: MemorySegmentedTabsProps<Value>): React.ReactElement {
	return (
		<div
			role="tablist"
			aria-label={ariaLabel}
			style={{
				...styles.segmentedShell,
				...(stretch ? styles.segmentedShellStretch : {}),
			}}
		>
			{items.map(item => {
				const isActive = item.value === activeValue;
				return (
					<button
						key={item.value}
						type="button"
						role="tab"
						aria-selected={isActive}
						style={{
							...styles.segmentedButton,
							...(stretch ? styles.segmentedButtonStretch : {}),
							...(isActive ? styles.segmentedButtonActive : {}),
						}}
						onClick={() => onChange(item.value)}
					>
						<span>{item.label}</span>
						{item.badge !== undefined ? (
							<span style={isActive ? styles.segmentedBadgeActive : styles.segmentedBadge}>
								{item.badge}
							</span>
						) : null}
					</button>
				);
			})}
		</div>
	);
}

interface MemoryPanelProps {
	title?: string;
	description?: string;
	actions?: React.ReactNode;
	children: React.ReactNode;
	style?: React.CSSProperties;
	bodyStyle?: React.CSSProperties;
}

// Рендерит общий контейнер карточки или панели для Memory UI.
export const MemoryPanel: React.FC<MemoryPanelProps> = ({
	title,
	description,
	actions,
	children,
	style,
	bodyStyle,
}) => (
	<div style={{ ...styles.panel, ...style }}>
		{title || description || actions ? (
			<div style={styles.panelHeader}>
				<div style={styles.panelHeaderText}>
					{title ? <h3 style={styles.panelTitle}>{title}</h3> : null}
					{description ? <div style={styles.panelDescription}>{description}</div> : null}
				</div>
				{actions ? <div style={styles.panelActions}>{actions}</div> : null}
			</div>
		) : null}
		<div style={{ ...styles.panelBody, ...bodyStyle }}>{children}</div>
	</div>
);

interface MemoryMetricCardProps {
	label: string;
	value: string;
	secondary?: string;
	accent?: string;
	compact?: boolean;
}

// Рендерит компактную карточку с ключевой метрикой и верхним акцентом.
export const MemoryMetricCard: React.FC<MemoryMetricCardProps> = ({
	label,
	value,
	secondary,
	accent,
	compact = false,
}) => (
	<div
		style={{
			...styles.metricCard,
			...(accent ? { borderTopColor: accent, borderTopWidth: '3px' } : {}),
		}}
	>
		<div style={styles.metricLabel}>{label}</div>
		<div style={compact ? styles.metricValueCompact : styles.metricValue}>{value}</div>
		{secondary ? <div style={styles.metricSecondary}>{secondary}</div> : null}
	</div>
);

// Группирует style-константы: плоский дизайн без теней, тонкие рамки, акцентные линии.
const styles: Record<string, React.CSSProperties> = {
	pageStack: {
		display: 'flex',
		flexDirection: 'column',
		gap: '20px',
	},
	metricGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
		gap: '14px',
	},
	twoColumnGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
		gap: '20px',
	},
	// Контейнер сегментированного переключателя — полупрозрачная подложка.
	segmentedShell: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '2px',
		padding: '3px',
		borderRadius: '10px',
		background: 'color-mix(in srgb, var(--vscode-foreground) 6%, transparent)',
		border: 'none',
		flexWrap: 'wrap',
	},
	segmentedShellStretch: {
		display: 'flex',
		width: '100%',
		minWidth: 0,
		justifyContent: 'stretch',
	},
	// Неактивная кнопка-сегмент — читаемый цвет текста.
	segmentedButton: {
		appearance: 'none',
		WebkitAppearance: 'none',
		border: 'none',
		background: 'transparent',
		color: 'color-mix(in srgb, var(--vscode-foreground) 60%, transparent)',
		padding: '8px 18px',
		minHeight: '36px',
		borderRadius: '8px',
		cursor: 'pointer',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '12px',
		fontWeight: 600,
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		gap: '8px',
		lineHeight: 1.2,
		letterSpacing: '0.01em',
		transition: 'background-color 160ms ease, color 160ms ease',
	},
	segmentedButtonStretch: {
		flex: 1,
		minWidth: 0,
	},
	// Активная кнопка — контрастный фон, жирный текст, легкая тень для подъема.
	segmentedButtonActive: {
		background: 'var(--vscode-editor-background)',
		color: 'var(--vscode-foreground)',
		fontWeight: 700,
		boxShadow: '0 1px 3px color-mix(in srgb, var(--vscode-foreground) 8%, transparent)',
	},
	// Бейдж счётчика в неактивном сегменте.
	segmentedBadge: {
		padding: '1px 7px',
		borderRadius: '6px',
		background: 'color-mix(in srgb, var(--vscode-foreground) 8%, transparent)',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '10px',
		fontWeight: 700,
	},
	// Бейдж счётчика в активном сегменте.
	segmentedBadgeActive: {
		padding: '1px 7px',
		borderRadius: '6px',
		background: 'color-mix(in srgb, var(--vscode-button-background) 16%, transparent)',
		color: 'var(--vscode-foreground)',
		fontSize: '10px',
		fontWeight: 700,
	},
	// Панель-карточка — плоская, без тени, тонкая рамка.
	panel: {
		display: 'flex',
		flexDirection: 'column',
		gap: '16px',
		padding: '20px',
		borderRadius: '12px',
		border: '1px solid color-mix(in srgb, var(--vscode-foreground) 38%, transparent)',
		boxShadow: '0 1px 4px 0 color-mix(in srgb, var(--vscode-foreground) 10%, transparent)',
		background: 'var(--vscode-editor-background)',
	},
	panelHeader: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'flex-start',
		gap: '14px',
		flexWrap: 'wrap',
	},
	panelHeaderText: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		minWidth: 0,
	},
	// Заголовок панели — uppercase, приглушённый цвет, мелкий шрифт.
	panelTitle: {
		margin: 0,
		fontSize: '11px',
		fontWeight: 700,
		lineHeight: 1.35,
		letterSpacing: '0.06em',
		textTransform: 'uppercase',
		color: 'var(--vscode-descriptionForeground)',
	},
	panelDescription: {
		fontSize: '12px',
		lineHeight: 1.55,
		color: 'color-mix(in srgb, var(--vscode-foreground) 65%, transparent)',
		maxWidth: '72ch',
	},
	panelActions: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		flexWrap: 'wrap',
	},
	panelBody: {
		display: 'flex',
		flexDirection: 'column',
		gap: '14px',
		minWidth: 0,
	},
	// Карточка метрики — акцентный верхний бордер 3px, легкая подложка.
	metricCard: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		padding: '16px 18px',
		borderRadius: '12px',
		border: '1px solid color-mix(in srgb, var(--vscode-foreground) 30%, transparent)',
		boxShadow: '0 1px 4px 0 color-mix(in srgb, var(--vscode-foreground) 10%, transparent)',
		background: 'color-mix(in srgb, var(--vscode-foreground) 2%, var(--vscode-editor-background))',
		position: 'relative',
		overflow: 'hidden',
	},
	metricLabel: {
		fontSize: '11px',
		letterSpacing: '0.04em',
		textTransform: 'uppercase',
		color: 'var(--vscode-descriptionForeground)',
	},
	// Крупная метрика — выделяется размером и весом шрифта.
	metricValue: {
		fontSize: '32px',
		fontWeight: 800,
		lineHeight: 1.05,
		color: 'var(--vscode-foreground)',
		letterSpacing: '-0.02em',
	},
	metricValueCompact: {
		fontSize: '16px',
		fontWeight: 700,
		lineHeight: 1.35,
		wordBreak: 'break-word',
		color: 'var(--vscode-foreground)',
	},
	metricSecondary: {
		fontSize: '11px',
		lineHeight: 1.45,
		color: 'color-mix(in srgb, var(--vscode-foreground) 60%, transparent)',
	},
	listStack: {
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
	},
	emptyState: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		minHeight: '160px',
		padding: '24px',
		textAlign: 'center',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '12px',
		lineHeight: 1.6,
	},
	emptyInline: {
		fontSize: '12px',
		lineHeight: 1.5,
		color: 'var(--vscode-descriptionForeground)',
	},
	monoText: {
		fontFamily: 'var(--vscode-editor-font-family)',
	},
};

// Общие стили для Memory Dashboard, Settings и статистики.
export const memoryUiStyles = {
	pageStack: styles.pageStack,
	metricGrid: styles.metricGrid,
	twoColumnGrid: styles.twoColumnGrid,
	listStack: styles.listStack,
	emptyState: styles.emptyState,
	emptyInline: styles.emptyInline,
	monoText: styles.monoText,
} satisfies Record<string, React.CSSProperties>;