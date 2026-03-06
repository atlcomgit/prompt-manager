/**
 * DateRangeCalendar — custom date range picker for VS Code webview.
 * Opens a single calendar where user picks "from" and "to" dates.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';

/** Props for DateRangeCalendar */
interface DateRangeCalendarProps {
	/** Start of selected range (YYYY-MM-DD) or null */
	dateFrom: string | null;
	/** End of selected range (YYYY-MM-DD) or null */
	dateTo: string | null;
	/** Called when range changes */
	onChange: (from: string | null, to: string | null) => void;
	/** Placeholder text */
	placeholder?: string;
}

/** Weekday short names */
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Month names */
const MONTHS = [
	'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
	'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

/** Format date to YYYY-MM-DD */
function toDateStr(year: number, month: number, day: number): string {
	return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Format YYYY-MM-DD for display as DD.MM.YYYY */
function formatDisplay(dateStr: string): string {
	const [y, m, d] = dateStr.split('-');
	return `${d}.${m}.${y}`;
}

/** Get days in month */
function getDaysInMonth(year: number, month: number): number {
	return new Date(year, month + 1, 0).getDate();
}

/** Get day of week (0=Mon, 6=Sun) for first day of month */
function getFirstDayOfWeek(year: number, month: number): number {
	const day = new Date(year, month, 1).getDay();
	return day === 0 ? 6 : day - 1; // Convert Sun=0 to Mon-based
}

export const DateRangeCalendar: React.FC<DateRangeCalendarProps> = ({
	dateFrom,
	dateTo,
	onChange,
	placeholder = 'Выберите период',
}) => {
	const [open, setOpen] = useState(false);
	const now = new Date();
	const [viewYear, setViewYear] = useState(now.getFullYear());
	const [viewMonth, setViewMonth] = useState(now.getMonth());
	/** Selection phase: 'from' = picking start, 'to' = picking end */
	const [phase, setPhase] = useState<'from' | 'to'>('from');
	/** Temporary "from" while selecting range */
	const [tempFrom, setTempFrom] = useState<string | null>(dateFrom);
	/** Hovered date for visual range preview */
	const [hoverDate, setHoverDate] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	// Close on outside click
	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [open]);

	// Sync tempFrom when props change
	useEffect(() => {
		setTempFrom(dateFrom);
	}, [dateFrom]);

	/** Navigate month */
	const prevMonth = useCallback(() => {
		if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
		else { setViewMonth(m => m - 1); }
	}, [viewMonth]);

	const nextMonth = useCallback(() => {
		if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
		else { setViewMonth(m => m + 1); }
	}, [viewMonth]);

	/** Handle day click */
	const handleDayClick = useCallback((dateStr: string) => {
		if (phase === 'from') {
			// Start new selection
			setTempFrom(dateStr);
			setPhase('to');
		} else {
			// Complete selection
			if (tempFrom && dateStr < tempFrom) {
				// Clicked before "from" — swap
				onChange(dateStr, tempFrom);
			} else {
				onChange(tempFrom, dateStr);
			}
			setPhase('from');
			setOpen(false);
		}
	}, [phase, tempFrom, onChange]);

	/** Build calendar grid for current month */
	const daysInMonth = getDaysInMonth(viewYear, viewMonth);
	const firstDow = getFirstDayOfWeek(viewYear, viewMonth);

	// Determine visual range for highlighting
	const rangeStart = phase === 'to' ? tempFrom : dateFrom;
	const rangeEnd = phase === 'to' ? (hoverDate || tempFrom) : dateTo;
	const effectiveFrom = rangeStart && rangeEnd && rangeStart <= rangeEnd ? rangeStart : rangeEnd;
	const effectiveTo = rangeStart && rangeEnd && rangeStart <= rangeEnd ? rangeEnd : rangeStart;

	/** Display text */
	const displayText = dateFrom && dateTo
		? `${formatDisplay(dateFrom)} — ${formatDisplay(dateTo)}`
		: placeholder;

	return (
		<div ref={containerRef} style={styles.wrapper}>
			{/* Trigger button */}
			<button
				style={{
					...styles.trigger,
					color: dateFrom && dateTo
						? 'var(--vscode-input-foreground)'
						: 'var(--vscode-descriptionForeground)',
				}}
				onClick={() => {
					setOpen(!open);
					if (!open) {
						setPhase('from');
						// Navigate to dateFrom month or current
						if (dateFrom) {
							const [y, m] = dateFrom.split('-').map(Number);
							setViewYear(y);
							setViewMonth(m - 1);
						}
					}
				}}
			>
				📅 {displayText}
			</button>

			{/* Calendar dropdown */}
			{open && (
				<div style={styles.dropdown}>
					{/* Header with navigation */}
					<div style={styles.header}>
						<button style={styles.navBtn} onClick={prevMonth}>◀</button>
						<span style={styles.monthLabel}>{MONTHS[viewMonth]} {viewYear}</span>
						<button style={styles.navBtn} onClick={nextMonth}>▶</button>
					</div>

					{/* Phase indicator */}
					<div style={styles.phaseHint}>
						{phase === 'from' ? '← Выберите начало' : '→ Выберите конец'}
					</div>

					{/* Weekday headers */}
					<div style={styles.weekdayRow}>
						{WEEKDAYS.map(wd => (
							<div key={wd} style={styles.weekdayCell}>{wd}</div>
						))}
					</div>

					{/* Day grid */}
					<div style={styles.dayGrid}>
						{/* Empty cells for offset */}
						{Array.from({ length: firstDow }, (_, i) => (
							<div key={`empty-${i}`} style={styles.dayCell} />
						))}
						{/* Day cells */}
						{Array.from({ length: daysInMonth }, (_, i) => {
							const day = i + 1;
							const dateStr = toDateStr(viewYear, viewMonth, day);
							const isFrom = dateStr === (phase === 'to' ? tempFrom : dateFrom);
							const isTo = dateStr === (phase === 'to' ? null : dateTo);
							const isInRange = effectiveFrom && effectiveTo
								&& dateStr >= effectiveFrom && dateStr <= effectiveTo;
							const isToday = dateStr === now.toISOString().slice(0, 10);

							return (
								<div
									key={day}
									style={{
										...styles.dayCell,
										...(isInRange ? styles.inRange : {}),
										...(isFrom || isTo ? styles.rangeEnd : {}),
										...(isToday && !isFrom && !isTo ? styles.today : {}),
									}}
									onClick={() => handleDayClick(dateStr)}
									onMouseEnter={() => { if (phase === 'to') setHoverDate(dateStr); }}
									onMouseLeave={() => setHoverDate(null)}
								>
									{day}
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
};

/** Component styles */
const styles: Record<string, React.CSSProperties> = {
	wrapper: {
		position: 'relative',
		display: 'inline-block',
	},
	trigger: {
		padding: '4px 10px',
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border, transparent)',
		borderRadius: '4px',
		fontSize: '12px',
		fontFamily: 'var(--vscode-font-family)',
		cursor: 'pointer',
		whiteSpace: 'nowrap',
	},
	dropdown: {
		position: 'absolute',
		top: '100%',
		left: 0,
		marginTop: '4px',
		padding: '8px',
		background: 'var(--vscode-editorWidget-background)',
		border: '1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border))',
		borderRadius: '6px',
		boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
		zIndex: 1000,
		width: '260px',
		userSelect: 'none',
	},
	header: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginBottom: '4px',
	},
	navBtn: {
		background: 'transparent',
		border: 'none',
		color: 'var(--vscode-foreground)',
		cursor: 'pointer',
		fontSize: '14px',
		padding: '4px 8px',
		borderRadius: '4px',
	},
	monthLabel: {
		fontSize: '13px',
		fontWeight: 600,
		color: 'var(--vscode-foreground)',
	},
	phaseHint: {
		textAlign: 'center',
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
		marginBottom: '6px',
	},
	weekdayRow: {
		display: 'grid',
		gridTemplateColumns: 'repeat(7, 1fr)',
		gap: '1px',
		marginBottom: '2px',
	},
	weekdayCell: {
		textAlign: 'center',
		fontSize: '10px',
		fontWeight: 600,
		color: 'var(--vscode-descriptionForeground)',
		padding: '2px 0',
	},
	dayGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(7, 1fr)',
		gap: '1px',
	},
	dayCell: {
		textAlign: 'center',
		fontSize: '12px',
		padding: '5px 0',
		borderRadius: '3px',
		cursor: 'pointer',
		color: 'var(--vscode-foreground)',
		transition: 'background 0.1s',
	},
	inRange: {
		background: 'var(--vscode-editor-selectionBackground)',
		borderRadius: '0',
	},
	rangeEnd: {
		background: 'var(--vscode-button-background)',
		color: 'var(--vscode-button-foreground)',
		borderRadius: '3px',
		fontWeight: 600,
	},
	today: {
		outline: '1px solid var(--vscode-focusBorder)',
		borderRadius: '3px',
	},
};
