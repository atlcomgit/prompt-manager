import React, { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { BashScriptEntry, BashScriptRun } from '../../../../types/bashScripts.js';
import { QuickNoteIcon } from '../quickNotes/QuickNoteIcon';

const startTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
const fullDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'medium' });
const seconds = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const COMPLETION_HOLD_MS = 1000;
const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Закрытие терминала не определяет момент окончания команды. Прежний числовой код подтверждает финиш. */
function durationMs(run: BashScriptRun, now?: number): number | undefined {
	let end = now;
	if (run.finishedAt) {
		if (run.endedBy === 'terminal' || (run.endedBy !== 'shell' && typeof run.exitCode !== 'number')) return;
		end = Date.parse(run.finishedAt);
	}
	if (end === undefined) return;
	const delta = end - Date.parse(run.startedAt);
	return Number.isFinite(delta) && delta >= 0 ? delta : undefined;
}

/** Use the same outcome for the duration, timeline marker and bar. */
function outcome(run?: BashScriptRun) {
	if (!run?.finishedAt || run.endedBy === 'terminal' || run.exitCode === undefined) return;
	return run.exitCode === 0 ? 'success' : 'error';
}

/** Короткая запись времени выполнения для строки и подписи шкалы. */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms} мс`;
	if (ms < 60_000) return `${seconds.format(Math.floor(ms / 100) / 10)} с`;
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes} мин ${Math.floor(ms / 1000) % 60} с`;
	return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

/** Narrow rows abbreviate minutes before switching to the unambiguous mm:ss or h:mm:ss form. */
function RowDuration({ ms, label }: { ms?: number; label: string }) {
	if (ms === undefined || ms < 60_000) return <span>{label}</span>;
	const minutes = Math.floor(ms / 60_000);
	const parts = [String(minutes % 60).padStart(2, '0'), String(Math.floor(ms / 1000) % 60).padStart(2, '0')];
	if (minutes >= 60) parts.unshift(String(Math.floor(minutes / 60)));
	return <span aria-hidden="true">
		<span className="pm-bs-duration-full">{label}</span>
		<span className="pm-bs-duration-short">{label.replace('мин', 'м')}</span>
		<span className="pm-bs-duration-clock">{parts.join(':')}</span>
	</span>;
}

/** Время начала в локальном часовом поясе пользователя. */
function RunTime({ value }: { value: string }) {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return <span>Время запуска неизвестно</span>;
	return <time dateTime={value} title={fullDate.format(date)}>{startTime.format(date)}</time>;
}

/** Для старой записи без кода и источника завершения результат остаётся неизвестным. */
function runStatus(run: BashScriptRun, active: boolean) {
	if (active) return 'Выполняется';
	if (run.endedBy === 'terminal') return 'Терминал закрыт';
	if (!run.finishedAt) return 'Запуск зарегистрирован';
	if (run.exitCode !== undefined) return run.exitCode === 0 ? 'Успешно' : `Код ${run.exitCode}`;
	return run.endedBy === 'shell' ? 'Завершён без кода' : 'Результат неизвестен';
}

/** История идёт от новых запусков к старым. Перекрывающиеся запуски не меняют шкалу на ходу. */
function previousDuration(history: BashScriptRun[], run: BashScriptRun): number | undefined {
	const started = Date.parse(run.startedAt);
	for (const previous of history) {
		if (!previous.finishedAt || Date.parse(previous.finishedAt) > started) continue;
		const duration = durationMs(previous);
		if (duration !== undefined && duration > 0) return duration;
	}
	return undefined;
}

/** Hold newly confirmed completions, including scripts that finish between two catalog snapshots. */
function useFinishingRun(history: BashScriptRun[], running: boolean) {
	const previousHistory = useRef(history);
	const [finishing, setFinishing] = useState<BashScriptRun>();
	useClientLayoutEffect(() => {
		const previous = previousHistory.current;
		previousHistory.current = history;
		if (running) {
			setFinishing(undefined);
		} else if (history !== previous) {
			const alreadyFinished = new Set(previous.filter(run => run.finishedAt).map(run => run.id));
			const finished = history.find(run => run.finishedAt && !alreadyFinished.has(run.id) && durationMs(run) !== undefined);
			if (finished || history[0]?.id !== previous[0]?.id) setFinishing(finished);
		}
	}, [history, running]);
	useEffect(() => {
		if (!finishing) return;
		const timer = window.setTimeout(() => setFinishing(undefined), COMPLETION_HOLD_MS);
		return () => window.clearTimeout(timer);
	}, [finishing]);
	return finishing;
}

/** The estimate uses the previous run while active; a confirmed finish always fills the track. */
function RunProgress({ history, run, elapsed }: { history: BashScriptRun[]; run: BashScriptRun; elapsed: number }) {
	let percent: number | undefined = 100;
	let hint = `100%. ${runStatus(run, false)}`;
	if (!run.finishedAt) {
		const baseline = previousDuration(history, run);
		percent = baseline === undefined ? undefined : Math.min(100, elapsed / baseline * 100);
		hint = baseline === undefined ? 'Нет предыдущего запуска с измеренной длительностью'
			: `Предыдущий запуск длился ${formatDuration(baseline)}`;
	}
	return <span className="pm-bs-track pm-bs-live" role="progressbar" aria-label="Время выполнения скрипта"
		aria-valuenow={percent === undefined ? undefined : Math.round(percent)} aria-valuetext={`${formatDuration(elapsed)}. ${hint}`} title={hint}>
		<span className="pm-bs-bar" style={percent === undefined ? undefined : { width: `${percent}%` }} />
	</span>;
}

/** Завершённые запуски сравниваются с самым долгим измеренным запуском скрипта. */
function RunHistory({ history, activeRunIds, now }: { history: BashScriptRun[]; activeRunIds?: string[]; now: number }) {
	if (!history.length) return <span>Запусков пока нет.</span>;
	const runs = history.map(run => {
		const active = !run.finishedAt && !!activeRunIds?.includes(run.id);
		return { run, active, duration: durationMs(run, active ? now : undefined) };
	});
	const longest = Math.max(0, ...runs.map(({ active, duration }) => active ? 0 : duration ?? 0));
	return <ol>{runs.map(({ run, duration, active }) => <li key={run.id} data-outcome={active ? 'running' : outcome(run)}>
		<div className="pm-bs-event-heading"><RunTime value={run.startedAt} /><span className="pm-bs-event-status">{runStatus(run, active)}</span></div>
		{duration === undefined ? <span className="pm-bs-unknown">Длительность неизвестна</span> :
			<div className="pm-bs-measure">{active ? <RunProgress history={history} run={run} elapsed={duration} /> : <span className="pm-bs-track" aria-hidden="true">
				<span className="pm-bs-bar" style={{ width: `${longest ? duration / longest * 100 : 0}%` }} />
			</span>}<span className="pm-bs-duration">{formatDuration(duration)}</span></div>}
	</li>)}</ol>;
}

interface RowProps {
	entry: BashScriptEntry;
	displayPath?: string;
	favorite: boolean;
	onToggleFavorite(): void;
	rowOrderActions?: React.ReactNode;
	dragHandle?: React.ReactNode;
	dropPlacement?: 'before' | 'after';
	onDragOver?: React.DragEventHandler<HTMLDivElement>;
	onDragLeave?: React.DragEventHandler<HTMLDivElement>;
	onDrop?: React.DragEventHandler<HTMLDivElement>;
	busy: boolean;
	launching?: boolean;
	historyOpen: boolean;
	hideTarget: BashScriptEntry | null;
	onRun(): void;
	/** Открывает панель с терминалом указанного запуска. */
	onShowTerminal(runId: string): void;
	onEdit(opener: HTMLButtonElement): void;
	onHistory(): void;
	onHide(target: BashScriptEntry | null): void;
	confirmHide(target: BashScriptEntry): void;
}

/** The row shows live elapsed time or the newest measured run. History keeps each run's own duration. */
export function BashScriptRow({ entry, displayPath, favorite, onToggleFavorite, rowOrderActions, dragHandle,
	dropPlacement, onDragOver, onDragLeave, onDrop,
	busy, launching, historyOpen, hideTarget, onRun, onShowTerminal, onEdit, onHistory, onHide, confirmHide }: RowProps) {
	const historyId = useId();
	const hideId = useId();
	const active = entry.activeRunIds?.length
		? entry.history.find(run => !run.finishedAt && entry.activeRunIds?.includes(run.id)) : undefined;
	const running = !!active;
	const finishing = useFinishingRun(entry.history, running);
	const [, tick] = useReducer((value: number) => value + 1, 0);
	useEffect(() => {
		if (!running) return;
		const timer = window.setInterval(tick, 1000);
		return () => window.clearInterval(timer);
	}, [running]);
	const now = Date.now();
	const latest = entry.history[0];
	const displayedRun = active ?? entry.history.find(run => durationMs(run) !== undefined) ?? latest;
	const duration = displayedRun && durationMs(displayedRun, running ? now : undefined);
	const progressRun = active ?? finishing;
	const progressElapsed = active ? duration : finishing && durationMs(finishing);
	const durationLabel = duration === undefined ? '—' : formatDuration(duration);
	const timingHint = displayedRun
		? `${runStatus(displayedRun, running)} · ${duration === undefined ? 'Длительность неизвестна' : durationLabel}`
		: 'Не запускался';
	const historyHint = !running && displayedRun && displayedRun !== latest
		? `Последний запуск — ${runStatus(latest, false)}. Последнее измерение — ${durationLabel} (${runStatus(displayedRun, false)})`
		: timingHint;
	const disabled = !entry.available || busy || running;
	const relativePath = displayPath ?? entry.project?.relativePath ?? entry.path;
	const runLabel = running ? `Выполняется ${entry.name}` : launching ? `Запуск ${entry.name}` : `Запустить ${entry.name}`;
	const runHint = entry.available ? `Запустить в отдельном терминале нижней панели\n${entry.absolutePath}` : 'Файл недоступен';
	// Терминал остаётся доступным и после окончания команды, пока пользователь его не закроет.
	const terminalRunId = entry.terminalRunIds?.[0];
	const terminalHint = running ? 'Показать терминал выполняющегося запуска' : 'Показать терминал последнего запуска';
	return <li className="pm-bs-entry">
		<div className="pm-bs-row" data-runnable={!disabled || undefined} data-drop={dropPlacement}
			onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onDoubleClick={event => {
			if (!disabled && event.target instanceof Element && !event.target.closest('button')) onRun();
		}}>
			<button type="button" className="pm-qn-icon-btn pm-bs-play" aria-label={runLabel} aria-busy={running || launching || undefined}
				title={running || launching ? runLabel : runHint} disabled={disabled} onClick={onRun}>
				{running || launching ? <QuickNoteIcon name="loading" size={13} className="pm-qn-spin" /> : <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5a.7.7 0 0 1 1-.6l6.6 4.5a.7.7 0 0 1 0 1.2L6 13.1a.7.7 0 0 1-1-.6Z" fill="currentColor" /></svg>}
			</button>
			<div className="pm-bs-details">
				<span className="pm-bs-name-cell">
					{progressRun && progressElapsed !== undefined && <RunProgress history={entry.history} run={progressRun} elapsed={progressElapsed} />}
					<span className="pm-bs-name" data-favorite={favorite || undefined} title={entry.name}>{entry.name}</span>
					<button type="button" className="pm-qn-icon-btn pm-bs-favorite" aria-pressed={favorite}
						aria-label={`Избранное · ${entry.name}`} title={favorite ? 'Убрать из избранного' : 'Добавить в избранное'}
						onClick={onToggleFavorite}>
						<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"
							fill={favorite ? 'currentColor' : 'none'} stroke="currentColor" strokeLinejoin="round">
							<path d="m8 1.5 2 4.2 4.6.7-3.3 3.2.8 4.6L8 12l-4.1 2.2.8-4.6-3.3-3.2 4.6-.7Z" />
						</svg>
					</button>
				</span>
				<span className="pm-bs-path-hint" title={entry.absolutePath}><bdi>{relativePath}</bdi></span>
			</div>
			<span className="pm-bs-flags">
				{!entry.available && <span className="pm-bs-availability" title="Недоступен"><QuickNoteIcon name="info" size={13} /><span>Недоступен</span></span>}
				{entry.scope === 'global' && entry.project && <span className="pm-bs-global" role="img" aria-label="Глобальный скрипт" title="Глобальный скрипт"><QuickNoteIcon name="globe" size={12} /></span>}
			</span>
			<button type="button" className="pm-bs-last-run" data-outcome={running ? 'running' : outcome(displayedRun)}
				aria-label={`История запусков ${entry.name}`} aria-description={historyHint}
				aria-expanded={historyOpen} aria-controls={historyOpen ? historyId : undefined} title={`История запусков · ${historyHint}`} onClick={onHistory}>
				<RowDuration ms={duration} label={durationLabel} />
				<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><circle cx="8" cy="8" r="5.4" /><path d="M8 4.5V8l2.4 1.5" /></svg>
			</button>
			<div className="pm-bs-tools">
				{dragHandle}
				{rowOrderActions ?? <>
					{terminalRunId ? <button type="button" className="pm-qn-icon-btn" aria-label={`Показать терминал ${entry.name}`}
						title={terminalHint} onClick={() => onShowTerminal(terminalRunId)}><QuickNoteIcon name="terminal" size={14} /></button>
						: <span className="pm-bs-terminal-slot" aria-hidden="true" />}
					<button type="button" className="pm-qn-icon-btn" data-pm-bash-editor-opener={entry.scope + ':' + entry.id} aria-label={`Редактировать ${entry.name}`} title="Редактировать скрипт"
						onClick={e => onEdit(e.currentTarget)}><QuickNoteIcon name="file-code" size={14} /></button>
					<button type="button" className="pm-qn-icon-btn" aria-label={`Убрать ${entry.name} из виджета`} title="Убрать из виджета"
						aria-controls={hideTarget ? hideId : undefined} aria-expanded={!!hideTarget} onClick={() => onHide(hideTarget ? null : entry)}><QuickNoteIcon name="eye-closed" size={13} /></button>
				</>}
			</div>
		</div>
		{historyOpen && <div className="pm-bs-history" id={historyId} role="region" aria-label={`История запусков ${entry.name}`}>
			<RunHistory history={entry.history} activeRunIds={entry.activeRunIds} now={now} />
		</div>}
		{hideTarget && <div className="pm-bs-hide" id={hideId} role="group" aria-label="Подтверждение скрытия скрипта">
			<span>Убрать <code title={hideTarget.absolutePath}>{hideTarget.path}</code> из виджета? Файл останется на диске.</span>
			<button type="button" className="pm-qn-btn is-small is-secondary" onClick={() => onHide(null)}>Отмена</button>
			<button type="button" className="pm-qn-btn is-small is-danger" disabled={busy} onClick={() => confirmHide(hideTarget)}>Убрать</button>
		</div>}
	</li>;
}
