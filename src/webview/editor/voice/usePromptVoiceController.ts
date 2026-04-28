import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExtensionToWebviewMessage, PromptVoiceDebugDetails } from '../../../types/messages';
import {
	MAX_PROMPT_VOICE_RECORDING_MS,
	createIdleWaveLevels,
	createSilentWaveLevels,
	createWaveLevelsFromScalar,
	formatPromptVoiceDuration,
	shouldIgnoreStalePromptVoiceRecorderState,
} from './promptVoiceUtils';
import { getVsCodeApi } from '../../shared/vscodeApi';

export type PromptVoiceStatus =
	| 'hidden'
	| 'recording'
	| 'paused'
	| 'preparing-model'
	| 'processing'
	| 'correcting'
	| 'error';

type PromptVoiceQueueMessage = Extract<ExtensionToWebviewMessage, { type: 'promptVoiceQueueState' }>;

export type PromptVoiceQueueItem = {
	sessionId: string;
	status: PromptVoiceQueueMessage['status'];
	elapsedMs: number;
	elapsedLabel: string;
	message: string;
	progressPercent: number | null;
	errorBadge: string;
	errorHint: string;
	autoRestart: boolean;
};

type PromptVoiceControllerOptions = {
	onTranscriptionReady: (text: string) => void;
	onOpen?: () => void;
};

type PromptVoiceControllerState = {
	status: PromptVoiceStatus;
	elapsedLabel: string;
	maxDurationLabel: string;
	elapsedMs: number;
	maxDurationMs: number;
	levels: number[];
	progressMessage: string;
	progressPercent: number | null;
	errorMessage: string;
	errorBadge: string;
	errorHint: string;
	queueItems: PromptVoiceQueueItem[];
	isVisible: boolean;
	canConfirm: boolean;
	canPause: boolean;
	canResume: boolean;
	canCancel: boolean;
};

type PromptVoiceStartSource = 'manual' | 'autoRestart' | 'resume-error';

const DEFAULT_WAVE = createIdleWaveLevels();
const MIN_UI_WAVE_LEVEL = 0.006;
const COMPLETED_ITEM_VISIBLE_MS = 1200;
const vscode = getVsCodeApi();

const createSessionId = (): string => `prompt-voice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const normalizeWaveLevels = (levels?: number[]): number[] | null => {
	if (!Array.isArray(levels) || levels.length === 0) {
		return null;
	}

	return levels.map(level => Math.max(MIN_UI_WAVE_LEVEL, Math.min(1, Number.isFinite(level) ? level : MIN_UI_WAVE_LEVEL)));
};

const normalizeProgress = (value: unknown): number | null => {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return null;
	}
	return Math.max(0, Math.min(100, value));
};

const createQueueItemFromMessage = (msg: PromptVoiceQueueMessage): PromptVoiceQueueItem => {
	const elapsedMs = typeof msg.elapsedMs === 'number' && Number.isFinite(msg.elapsedMs)
		? Math.max(0, Math.floor(msg.elapsedMs))
		: 0;
	return {
		sessionId: msg.sessionId,
		status: msg.status,
		elapsedMs,
		elapsedLabel: formatPromptVoiceDuration(elapsedMs),
		message: msg.message || '',
		progressPercent: normalizeProgress(msg.progress),
		errorBadge: msg.errorBadge || '',
		errorHint: msg.errorHint || '',
		autoRestart: Boolean(msg.autoRestart),
	};
};

export const usePromptVoiceController = ({
	onTranscriptionReady,
	onOpen,
}: PromptVoiceControllerOptions): PromptVoiceControllerState & {
	startRecording: (source?: PromptVoiceStartSource) => Promise<void>;
	pauseRecording: () => void;
	resumeRecording: () => void;
	markConfirmIntent: () => void;
	confirmRecording: () => Promise<void>;
	cancelRecording: () => Promise<void>;
	dismissQueueItem: (sessionId: string) => void;
} => {
	const activeSessionIdRef = useRef<string | null>(null);
	const statusRef = useRef<PromptVoiceStatus>('hidden');
	const completionTimersRef = useRef<Map<string, number>>(new Map());
	const manualConfirmSessionIdsRef = useRef<Set<string>>(new Set());

	const [status, setStatus] = useState<PromptVoiceStatus>('hidden');
	const [elapsedMs, setElapsedMs] = useState(0);
	const [levels, setLevels] = useState<number[]>(DEFAULT_WAVE);
	const [progressMessage, setProgressMessage] = useState('');
	const [progressPercent, setProgressPercent] = useState<number | null>(null);
	const [errorMessage, setErrorMessage] = useState('');
	const [errorBadge, setErrorBadge] = useState('');
	const [errorHint, setErrorHint] = useState('');
	const [queueItems, setQueueItems] = useState<PromptVoiceQueueItem[]>([]);

	/** Sends compact voice UI trace events to the extension output channel. */
	const trace = useCallback((event: string, details: PromptVoiceDebugDetails = {}) => {
		vscode.postMessage({
			type: 'promptVoiceDebugEvent',
			sessionId: activeSessionIdRef.current ?? undefined,
			event,
			status: statusRef.current,
			details,
		});
	}, []);

	useEffect(() => {
		statusRef.current = status;
	}, [status]);

	const setVoiceStatus = useCallback((nextStatus: PromptVoiceStatus) => {
		statusRef.current = nextStatus;
		setStatus(nextStatus);
	}, []);

	const resetTracking = useCallback(() => {
		setElapsedMs(0);
		setLevels(DEFAULT_WAVE);
		setProgressMessage('');
		setProgressPercent(null);
		setErrorMessage('');
		setErrorBadge('');
		setErrorHint('');
	}, []);

	const activateNewSession = useCallback((): string => {
		const sessionId = createSessionId();
		activeSessionIdRef.current = sessionId;
		return sessionId;
	}, []);

	const hideOverlay = useCallback((source: string = 'unknown') => {
		trace('hideOverlay', {
			source,
			previousSessionId: activeSessionIdRef.current ?? null,
			previousStatus: statusRef.current,
		});
		activeSessionIdRef.current = null;
		resetTracking();
		setVoiceStatus('hidden');
	}, [resetTracking, setVoiceStatus, trace]);

	const dismissQueueItem = useCallback((sessionId: string) => {
		const timer = completionTimersRef.current.get(sessionId);
		if (timer) {
			window.clearTimeout(timer);
			completionTimersRef.current.delete(sessionId);
		}
		setQueueItems(prev => prev.filter(item => item.sessionId !== sessionId));
	}, []);

	const scheduleQueueItemRemoval = useCallback((sessionId: string) => {
		const existingTimer = completionTimersRef.current.get(sessionId);
		if (existingTimer) {
			window.clearTimeout(existingTimer);
		}
		const timer = window.setTimeout(() => dismissQueueItem(sessionId), COMPLETED_ITEM_VISIBLE_MS);
		completionTimersRef.current.set(sessionId, timer);
	}, [dismissQueueItem]);

	const upsertQueueItem = useCallback((msg: PromptVoiceQueueMessage) => {
		const nextItem = createQueueItemFromMessage(msg);
		setQueueItems(prev => {
			const existingIndex = prev.findIndex(item => item.sessionId === msg.sessionId);
			if (existingIndex < 0) {
				return [...prev, nextItem];
			}

			const nextItems = [...prev];
			nextItems[existingIndex] = {
				...nextItems[existingIndex],
				...nextItem,
				autoRestart: nextItem.autoRestart || nextItems[existingIndex].autoRestart,
			};
			return nextItems;
		});
	}, []);

	const startRecording = useCallback(async (source: PromptVoiceStartSource = 'manual') => {
		trace('startRecording.request', {
			source,
			previousSessionId: activeSessionIdRef.current ?? null,
			previousStatus: statusRef.current,
		});
		const sessionId = activateNewSession();
		resetTracking();
		onOpen?.();
		setVoiceStatus('recording');
		trace('startRecording.postMessage', { source, newSessionId: sessionId });
		vscode.postMessage({ type: 'startPromptVoiceRecording', sessionId });
	}, [activateNewSession, onOpen, resetTracking, setVoiceStatus, trace]);

	const pauseRecording = useCallback(() => {
		const sessionId = activeSessionIdRef.current;
		if (!sessionId || statusRef.current !== 'recording') {
			trace('pauseRecording.skip', { reason: sessionId ? 'not-recording' : 'missing-session' });
			return;
		}

		trace('pauseRecording.postMessage', { sessionId });
		setVoiceStatus('paused');
		setLevels(createSilentWaveLevels());
		vscode.postMessage({ type: 'pausePromptVoiceRecording', sessionId });
	}, [setVoiceStatus, trace]);

	const resumeRecording = useCallback(() => {
		if (statusRef.current === 'error') {
			trace('resumeRecording.restartAfterError');
			void startRecording('resume-error');
			return;
		}

		const sessionId = activeSessionIdRef.current;
		if (!sessionId || statusRef.current !== 'paused') {
			trace('resumeRecording.skip', { reason: sessionId ? 'not-paused' : 'missing-session' });
			return;
		}

		trace('resumeRecording.postMessage', { sessionId });
		vscode.postMessage({ type: 'resumePromptVoiceRecording', sessionId });
	}, [startRecording, trace]);

	/** Marks OK intent before click can race with limit auto-restart. */
	const markConfirmIntent = useCallback(() => {
		const sessionId = activeSessionIdRef.current;
		if (!sessionId || (statusRef.current !== 'recording' && statusRef.current !== 'paused' && statusRef.current !== 'processing')) {
			trace('markConfirmIntent.skip', { reason: sessionId ? 'invalid-status' : 'missing-session' });
			return;
		}

		if (!manualConfirmSessionIdsRef.current.has(sessionId)) {
			manualConfirmSessionIdsRef.current.add(sessionId);
			trace('markConfirmIntent.postMessage', { sessionId });
			vscode.postMessage({ type: 'markPromptVoiceManualConfirmIntent', sessionId });
			return;
		}

		trace('markConfirmIntent.duplicate', { sessionId });
	}, [trace]);

	const confirmRecording = useCallback(async () => {
		const sessionId = activeSessionIdRef.current;
		if (!sessionId || (statusRef.current !== 'recording' && statusRef.current !== 'paused')) {
			trace('confirmRecording.skip', { reason: sessionId ? 'invalid-status' : 'missing-session' });
			return;
		}

		trace('confirmRecording.request', { sessionId });
		markConfirmIntent();
		setVoiceStatus('processing');
		setProgressMessage('Ставится в очередь');
		setProgressPercent(null);
		trace('confirmRecording.postMessage', { sessionId });
		vscode.postMessage({ type: 'confirmPromptVoiceRecording', sessionId });
	}, [markConfirmIntent, setVoiceStatus, trace]);

	const cancelRecording = useCallback(async () => {
		const sessionId = activeSessionIdRef.current;
		trace('cancelRecording.request', { sessionId: sessionId ?? null });
		hideOverlay('cancelRecording');
		if (!sessionId) {
			return;
		}

		trace('cancelRecording.postMessage', { sessionId });
		vscode.postMessage({ type: 'cancelPromptVoiceRecording', sessionId });
	}, [hideOverlay, trace]);

	useEffect(() => {
		const handleQueueMessage = (msg: PromptVoiceQueueMessage) => {
			const activeSessionId = activeSessionIdRef.current;
			const isManualConfirm = manualConfirmSessionIdsRef.current.has(msg.sessionId);
			const isActiveQueuedSession = activeSessionId === msg.sessionId && msg.status === 'queued';
			const willAutoRestart = Boolean(msg.autoRestart) && !isManualConfirm && isActiveQueuedSession;
			trace('queue.message', {
				msgSessionId: msg.sessionId,
				queueStatus: msg.status,
				autoRestart: Boolean(msg.autoRestart),
				isActiveSession: activeSessionId === msg.sessionId,
				isManualConfirm,
				willAutoRestart,
			});
			upsertQueueItem(msg);

			if (activeSessionIdRef.current === msg.sessionId && msg.status === 'queued') {
				hideOverlay('queue.queued');
				if (willAutoRestart) {
					trace('queue.autoRestart.startRecording', { msgSessionId: msg.sessionId });
					void startRecording('autoRestart');
				}
				manualConfirmSessionIdsRef.current.delete(msg.sessionId);
			}

			if (msg.status === 'completed') {
				const text = (msg.text || '').trim();
				if (text) {
					trace('queue.completed.transcriptionReady', { msgSessionId: msg.sessionId, textLength: text.length });
					onTranscriptionReady(text);
				}
				manualConfirmSessionIdsRef.current.delete(msg.sessionId);
				scheduleQueueItemRemoval(msg.sessionId);
			}

			if (msg.status === 'error') {
				trace('queue.error', { msgSessionId: msg.sessionId, message: msg.message ?? null });
				manualConfirmSessionIdsRef.current.delete(msg.sessionId);
			}
		};

		const handleMessage = (event: MessageEvent<ExtensionToWebviewMessage>) => {
			const msg = event.data;
			if (!msg) {
				return;
			}

			if (msg.type === 'promptVoiceQueueState') {
				handleQueueMessage(msg);
				return;
			}

			if (msg.type !== 'promptVoiceState') {
				return;
			}

			const activeSessionId = activeSessionIdRef.current;
			if (!activeSessionId || msg.sessionId !== activeSessionId) {
				if (msg.status !== 'recording') {
					trace('state.ignored', {
						msgSessionId: msg.sessionId,
						msgStatus: msg.status,
						activeSessionId: activeSessionId ?? null,
					});
				}
				return;
			}

			if (shouldIgnoreStalePromptVoiceRecorderState(statusRef.current, msg.status)) {
				trace('state.ignored.stale-recorder-state', {
					msgSessionId: msg.sessionId,
					msgStatus: msg.status,
					currentStatus: statusRef.current,
					elapsedMs: msg.elapsedMs ?? null,
				});
				return;
			}

			if (typeof msg.elapsedMs === 'number' && Number.isFinite(msg.elapsedMs)) {
				setElapsedMs(Math.max(0, Math.min(MAX_PROMPT_VOICE_RECORDING_MS, Math.floor(msg.elapsedMs))));
			}

			switch (msg.status) {
				case 'recording':
					if (statusRef.current !== 'recording') {
						trace('state.apply', { msgStatus: 'recording', elapsedMs: msg.elapsedMs ?? null });
					}
					setVoiceStatus('recording');
					setProgressMessage('');
					setProgressPercent(null);
					setErrorMessage('');
					setErrorBadge('');
					setErrorHint('');
					setLevels(normalizeWaveLevels(msg.levels) ?? createWaveLevelsFromScalar(msg.level ?? 0.08));
					break;

				case 'paused':
					trace('state.apply', { msgStatus: 'paused', elapsedMs: msg.elapsedMs ?? null });
					setVoiceStatus('paused');
					setLevels(normalizeWaveLevels(msg.levels) ?? createSilentWaveLevels());
					break;

				case 'preparing-model':
				case 'processing':
				case 'correcting':
					trace('state.apply', { msgStatus: msg.status, progress: msg.progress ?? null });
					setVoiceStatus(msg.status);
					setProgressMessage(msg.message || (
						msg.status === 'correcting'
							? 'AI коррекция'
							: msg.status === 'processing'
								? 'Обрабатывается'
								: 'Подготавливается модель'
					));
					setProgressPercent(typeof msg.progress === 'number' ? msg.progress : null);
					setLevels(DEFAULT_WAVE);
					break;

				case 'error':
					trace('state.apply', { msgStatus: 'error', message: msg.message ?? null });
					setVoiceStatus('error');
					setProgressMessage('');
					setProgressPercent(null);
					setErrorMessage(msg.message || 'Не удалось распознать речь. Попробуй ещё раз.');
					setErrorBadge(msg.errorBadge || 'Ошибка распознавания');
					setErrorHint(msg.errorHint || msg.message || '');
					setLevels(DEFAULT_WAVE);
					break;

				case 'cancelled':
					trace('state.apply', { msgStatus: 'cancelled' });
					hideOverlay('state.cancelled');
					break;

				case 'transcribed': {
					const text = (msg.text || '').trim();
					trace('state.apply', { msgStatus: 'transcribed', textLength: text.length });
					hideOverlay('state.transcribed');
					if (text) {
						onTranscriptionReady(text);
					}
					break;
				}
			}
		};

		window.addEventListener('message', handleMessage as EventListener);
		return () => window.removeEventListener('message', handleMessage as EventListener);
	}, [hideOverlay, onTranscriptionReady, scheduleQueueItemRemoval, setVoiceStatus, startRecording, trace, upsertQueueItem]);

	useEffect(() => {
		if (status === 'hidden') {
			return;
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				if (statusRef.current === 'recording' || statusRef.current === 'paused' || statusRef.current === 'error') {
					trace('key.cancel', { key: event.key });
					event.preventDefault();
					event.stopPropagation();
					void cancelRecording();
				}
			} else if (event.key === 'Enter') {
				if (statusRef.current === 'recording' || statusRef.current === 'paused') {
					trace('key.confirm', { key: event.key });
					event.preventDefault();
					event.stopPropagation();
					void confirmRecording();
				}
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [cancelRecording, confirmRecording, status, trace]);

	useEffect(() => {
		return () => {
			const sessionId = activeSessionIdRef.current;
			if (sessionId) {
				trace('unmount.cancelActive', { sessionId });
				vscode.postMessage({ type: 'cancelPromptVoiceRecording', sessionId });
				activeSessionIdRef.current = null;
			}

			for (const timer of completionTimersRef.current.values()) {
				window.clearTimeout(timer);
			}
			completionTimersRef.current.clear();
			manualConfirmSessionIdsRef.current.clear();
		};
	}, [trace]);

	return useMemo(() => ({
		status,
		elapsedMs,
		elapsedLabel: formatPromptVoiceDuration(elapsedMs),
		maxDurationLabel: formatPromptVoiceDuration(MAX_PROMPT_VOICE_RECORDING_MS),
		maxDurationMs: MAX_PROMPT_VOICE_RECORDING_MS,
		levels,
		progressMessage,
		progressPercent,
		errorMessage,
		errorBadge,
		errorHint,
		queueItems,
		isVisible: status !== 'hidden',
		canConfirm: status === 'recording' || status === 'paused',
		canPause: status === 'recording',
		canResume: status === 'paused' || status === 'error',
		canCancel: status === 'recording' || status === 'paused' || status === 'error',
		startRecording,
		pauseRecording,
		resumeRecording,
		markConfirmIntent,
		confirmRecording,
		cancelRecording,
		dismissQueueItem,
	}), [
		cancelRecording,
		confirmRecording,
		dismissQueueItem,
		elapsedMs,
		errorBadge,
		errorHint,
		errorMessage,
		levels,
		markConfirmIntent,
		pauseRecording,
		progressMessage,
		progressPercent,
		queueItems,
		resumeRecording,
		startRecording,
		status,
	]);
};