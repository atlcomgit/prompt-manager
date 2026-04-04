import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

export type ProgressLinePhase = 'idle' | 'expanding' | 'running' | 'collapsing';

export type ProgressLineMode =
	| 'idle'
	| 'loading'
	| 'auto'
	| 'sync'
	| 'fetch'
	| 'local'
	| 'saving'
	| 'ai'
	| 'processing';

export type EditorProgressFlags = {
	isSaving: boolean;
	isStartingChat: boolean;
	isImprovingPromptText: boolean;
	isGeneratingReport: boolean;
	isGeneratingTitle: boolean;
	isGeneratingDescription: boolean;
	isSuggestionLoading: boolean;
	isRecalculating: boolean;
	isLoadingGlobalContext: boolean;
};

const PROGRESS_EXPAND_MS = 220;
const PROGRESS_COLLAPSE_MS = 220;
const PROGRESS_RUN_MS = 1150;
const PROGRESS_WIDTH_RATIO = 0.38;
const PROGRESS_MIN_WIDTH_PX = 120;

const baseTrackStyle: CSSProperties = {
	position: 'relative',
	height: '3px',
	width: '100%',
	overflow: 'hidden',
	background: 'color-mix(in srgb, var(--vscode-descriptionForeground) 26%, transparent)',
};

const baseLineStyle: CSSProperties = {
	position: 'absolute',
	top: 0,
	bottom: 0,
	left: 0,
	width: 0,
	background: 'linear-gradient(90deg, transparent 0%, var(--vscode-focusBorder, var(--vscode-progressBar-background)) 20%, var(--vscode-progressBar-background, var(--vscode-focusBorder)) 50%, transparent 100%)',
	borderRadius: '999px',
	pointerEvents: 'none',
	willChange: 'transform, width, opacity',
};

export function resolveEditorProgressMode(flags: EditorProgressFlags): ProgressLineMode {
	if (flags.isSaving) {
		return 'saving';
	}

	if (
		flags.isImprovingPromptText
		|| flags.isGeneratingReport
		|| flags.isGeneratingTitle
		|| flags.isGeneratingDescription
	) {
		return 'ai';
	}

	if (
		flags.isStartingChat
		|| flags.isSuggestionLoading
		|| flags.isRecalculating
		|| flags.isLoadingGlobalContext
	) {
		return 'processing';
	}

	return 'idle';
}

type Props = {
	mode: ProgressLineMode;
	modeAttributeName?: string;
	phaseAttributeName?: string;
	trackStyle?: CSSProperties;
	lineStyle?: CSSProperties;
};

export const ProgressLine: React.FC<Props> = ({
	mode,
	modeAttributeName = 'data-pm-progress',
	phaseAttributeName = 'data-pm-progress-phase',
	trackStyle,
	lineStyle,
}) => {
	const trackRef = useRef<HTMLDivElement>(null);
	const frameRef = useRef<number | null>(null);
	const phaseRef = useRef<ProgressLinePhase>('idle');
	const transitionStartTimeRef = useRef(0);
	const transitionFromWidthRef = useRef(0);
	const transitionToWidthRef = useRef(0);
	const currentWidthRef = useRef(0);
	const currentLeftRef = useRef(0);
	const runLeftRef = useRef(0);
	const lastFrameTimeRef = useRef(0);
	const stopRequestedRef = useRef(false);
	const [phase, setPhase] = useState<ProgressLinePhase>('idle');
	const [trackWidth, setTrackWidth] = useState(0);
	const [lineVisual, setLineVisual] = useState({ leftPx: 0, widthPx: 0 });

	const active = mode !== 'idle';
	const segmentWidth = trackWidth > 0
		? Math.max(PROGRESS_MIN_WIDTH_PX, trackWidth * PROGRESS_WIDTH_RATIO)
		: PROGRESS_MIN_WIDTH_PX;
	const centeredLeft = (trackWidth - segmentWidth) / 2;

	const updateVisual = useCallback((widthPx: number, leftPx: number) => {
		currentWidthRef.current = widthPx;
		currentLeftRef.current = leftPx;
		setLineVisual((prev) => {
			if (Math.abs(prev.widthPx - widthPx) < 0.5 && Math.abs(prev.leftPx - leftPx) < 0.5) {
				return prev;
			}

			return { widthPx, leftPx };
		});
	}, []);

	const cancelFrame = useCallback(() => {
		if (typeof window === 'undefined' || frameRef.current === null) {
			return;
		}

		window.cancelAnimationFrame(frameRef.current);
		frameRef.current = null;
	}, []);

	const startExpand = useCallback((fromWidth: number = currentWidthRef.current) => {
		phaseRef.current = 'expanding';
		setPhase('expanding');
		transitionStartTimeRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
		transitionFromWidthRef.current = Math.max(0, fromWidth);
		transitionToWidthRef.current = segmentWidth;
		lastFrameTimeRef.current = 0;
		stopRequestedRef.current = false;
		updateVisual(transitionFromWidthRef.current, (trackWidth - transitionFromWidthRef.current) / 2);
	}, [segmentWidth, trackWidth, updateVisual]);

	const startCollapse = useCallback((fromWidth: number = currentWidthRef.current) => {
		phaseRef.current = 'collapsing';
		setPhase('collapsing');
		transitionStartTimeRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
		transitionFromWidthRef.current = Math.max(0, fromWidth);
		transitionToWidthRef.current = 0;
		lastFrameTimeRef.current = 0;
		updateVisual(transitionFromWidthRef.current, (trackWidth - transitionFromWidthRef.current) / 2);
	}, [trackWidth, updateVisual]);

	const startRunning = useCallback((fromLeft: number = centeredLeft) => {
		phaseRef.current = 'running';
		setPhase('running');
		stopRequestedRef.current = false;
		runLeftRef.current = fromLeft;
		lastFrameTimeRef.current = 0;
		updateVisual(segmentWidth, fromLeft);
	}, [centeredLeft, segmentWidth, updateVisual]);

	useEffect(() => {
		if (typeof window === 'undefined') {
			return;
		}

		const updateTrackWidth = () => {
			setTrackWidth(trackRef.current?.clientWidth || 0);
		};

		updateTrackWidth();

		if (typeof ResizeObserver !== 'undefined') {
			const observer = new ResizeObserver(() => {
				updateTrackWidth();
			});

			if (trackRef.current) {
				observer.observe(trackRef.current);
			}

			return () => observer.disconnect();
		}

		window.addEventListener('resize', updateTrackWidth);
		return () => window.removeEventListener('resize', updateTrackWidth);
	}, []);

	useEffect(() => {
		if (!trackWidth) {
			updateVisual(0, 0);
			return;
		}

		if (active) {
			if (phaseRef.current === 'idle') {
				startExpand(0);
				return;
			}

			if (phaseRef.current === 'collapsing') {
				startExpand(currentWidthRef.current);
				return;
			}

			stopRequestedRef.current = false;
			return;
		}

		if (phaseRef.current === 'running') {
			stopRequestedRef.current = true;
			return;
		}

		if (phaseRef.current === 'expanding') {
			startCollapse(currentWidthRef.current);
		}
	}, [active, startCollapse, startExpand, trackWidth, updateVisual]);

	useEffect(() => {
		if (typeof window === 'undefined' || !trackWidth || phase === 'idle') {
			if (phase === 'idle') {
				cancelFrame();
			}
			return;
		}

		const tick = (timestamp: number) => {
			frameRef.current = null;

			if (phaseRef.current === 'expanding') {
				const elapsed = timestamp - transitionStartTimeRef.current;
				const progress = Math.min(1, elapsed / PROGRESS_EXPAND_MS);
				const widthPx = transitionFromWidthRef.current
					+ (transitionToWidthRef.current - transitionFromWidthRef.current) * progress;
				updateVisual(widthPx, (trackWidth - widthPx) / 2);

				if (progress >= 1) {
					if (active) {
						startRunning(centeredLeft);
					} else {
						startCollapse(widthPx);
					}
				}
			}

			if (phaseRef.current === 'running') {
				if (lastFrameTimeRef.current === 0) {
					lastFrameTimeRef.current = timestamp;
					updateVisual(segmentWidth, runLeftRef.current);
				} else {
					const delta = timestamp - lastFrameTimeRef.current;
					lastFrameTimeRef.current = timestamp;
					const speed = (trackWidth + segmentWidth) / PROGRESS_RUN_MS;
					let nextLeft = runLeftRef.current + delta * speed;

					if (stopRequestedRef.current && runLeftRef.current <= centeredLeft && nextLeft >= centeredLeft) {
						runLeftRef.current = centeredLeft;
						updateVisual(segmentWidth, centeredLeft);
						startCollapse(segmentWidth);
					} else {
						while (nextLeft > trackWidth) {
							nextLeft = -segmentWidth + (nextLeft - trackWidth);
						}

						runLeftRef.current = nextLeft;
						updateVisual(segmentWidth, nextLeft);
					}
				}
			}

			if (phaseRef.current === 'collapsing') {
				const elapsed = timestamp - transitionStartTimeRef.current;
				const progress = Math.min(1, elapsed / PROGRESS_COLLAPSE_MS);
				const widthPx = transitionFromWidthRef.current
					+ (transitionToWidthRef.current - transitionFromWidthRef.current) * progress;
				updateVisual(widthPx, (trackWidth - widthPx) / 2);

				if (progress >= 1) {
					phaseRef.current = 'idle';
					setPhase('idle');
					stopRequestedRef.current = false;
					lastFrameTimeRef.current = 0;
					updateVisual(0, trackWidth / 2);
				}
			}

			if (phaseRef.current !== 'idle') {
				frameRef.current = window.requestAnimationFrame(tick);
			}
		};

		frameRef.current = window.requestAnimationFrame(tick);
		return () => cancelFrame();
	}, [active, cancelFrame, centeredLeft, phase, segmentWidth, startCollapse, startRunning, trackWidth, updateVisual]);

	useEffect(() => () => cancelFrame(), [cancelFrame]);

	const trackDataAttributes = {
		[modeAttributeName]: mode,
		[phaseAttributeName]: phase,
	} as Record<string, string>;

	return (
		<div
			ref={trackRef}
			{...trackDataAttributes}
			style={{
				...baseTrackStyle,
				...(trackStyle || {}),
			}}
		>
			<div
				style={{
					...baseLineStyle,
					...(lineStyle || {}),
					width: `${Math.max(0, lineVisual.widthPx)}px`,
					transform: `translateX(${lineVisual.leftPx}px)`,
					opacity: lineVisual.widthPx > 0 ? 1 : 0,
				}}
			/>
		</div>
	);
};