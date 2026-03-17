import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExtensionToWebviewMessage } from '../../../types/messages';
import {
  MAX_PROMPT_VOICE_RECORDING_MS,
  createIdleWaveLevels,
  createSilentWaveLevels,
  createWaveLevelsFromScalar,
  formatPromptVoiceDuration,
} from './promptVoiceUtils';
import { getVsCodeApi } from '../../shared/vscodeApi';

export type PromptVoiceStatus =
  | 'hidden'
  | 'recording'
  | 'paused'
  | 'preparing-model'
  | 'processing'
  | 'error';

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
  isVisible: boolean;
  canConfirm: boolean;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
};

const DEFAULT_WAVE = createIdleWaveLevels();
const MIN_UI_WAVE_LEVEL = 0.006;
const vscode = getVsCodeApi();

const createSessionId = (): string => `prompt-voice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const normalizeWaveLevels = (levels?: number[]): number[] | null => {
  if (!Array.isArray(levels) || levels.length === 0) {
    return null;
  }

  return levels.map(level => Math.max(MIN_UI_WAVE_LEVEL, Math.min(1, Number.isFinite(level) ? level : MIN_UI_WAVE_LEVEL)));
};

export const usePromptVoiceController = ({
  onTranscriptionReady,
  onOpen,
}: PromptVoiceControllerOptions): PromptVoiceControllerState & {
  startRecording: () => Promise<void>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  confirmRecording: () => Promise<void>;
  cancelRecording: () => Promise<void>;
} => {
  const activeSessionIdRef = useRef<string | null>(null);
  const statusRef = useRef<PromptVoiceStatus>('hidden');

  const [status, setStatus] = useState<PromptVoiceStatus>('hidden');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState<number[]>(DEFAULT_WAVE);
  const [progressMessage, setProgressMessage] = useState('');
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [errorBadge, setErrorBadge] = useState('');
  const [errorHint, setErrorHint] = useState('');

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

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

  const hideOverlay = useCallback(() => {
    activeSessionIdRef.current = null;
    resetTracking();
    setStatus('hidden');
  }, [resetTracking]);

  const startRecording = useCallback(async () => {
    const sessionId = activateNewSession();
    resetTracking();
    onOpen?.();
    setStatus('recording');
    vscode.postMessage({ type: 'startPromptVoiceRecording', sessionId });
  }, [activateNewSession, onOpen, resetTracking]);

  const pauseRecording = useCallback(() => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || statusRef.current !== 'recording') {
      return;
    }

    statusRef.current = 'paused';
    setStatus('paused');
    setLevels(createSilentWaveLevels());
    vscode.postMessage({ type: 'pausePromptVoiceRecording', sessionId });
  }, []);

  const resumeRecording = useCallback(() => {
    if (statusRef.current === 'error') {
      void startRecording();
      return;
    }

    const sessionId = activeSessionIdRef.current;
    if (!sessionId || statusRef.current !== 'paused') {
      return;
    }

    vscode.postMessage({ type: 'resumePromptVoiceRecording', sessionId });
  }, [startRecording]);

  const confirmRecording = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || (statusRef.current !== 'recording' && statusRef.current !== 'paused')) {
      return;
    }

    setStatus('processing');
    setProgressMessage('Обрабатывается');
    setProgressPercent(null);
    vscode.postMessage({ type: 'confirmPromptVoiceRecording', sessionId });
  }, []);

  const cancelRecording = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    hideOverlay();
    if (!sessionId) {
      return;
    }

    vscode.postMessage({ type: 'cancelPromptVoiceRecording', sessionId });
  }, [hideOverlay]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const msg = event.data;
      if (!msg || msg.type !== 'promptVoiceState') {
        return;
      }

      const activeSessionId = activeSessionIdRef.current;
      if (!activeSessionId || msg.sessionId !== activeSessionId) {
        return;
      }

      if (typeof msg.elapsedMs === 'number' && Number.isFinite(msg.elapsedMs)) {
        setElapsedMs(Math.max(0, Math.min(MAX_PROMPT_VOICE_RECORDING_MS, Math.floor(msg.elapsedMs))));
      }

      switch (msg.status) {
        case 'recording':
          setStatus('recording');
          setProgressMessage('');
          setProgressPercent(null);
          setErrorMessage('');
          setErrorBadge('');
          setErrorHint('');
          setLevels(normalizeWaveLevels(msg.levels) ?? createWaveLevelsFromScalar(msg.level ?? 0.08));
          break;

        case 'paused':
          setStatus('paused');
          setLevels(normalizeWaveLevels(msg.levels) ?? createSilentWaveLevels());
          break;

        case 'preparing-model':
        case 'processing':
          setStatus(msg.status);
          setProgressMessage(msg.message || (msg.status === 'processing' ? 'Обрабатывается' : 'Подготавливается модель'));
          setProgressPercent(typeof msg.progress === 'number' ? msg.progress : null);
          setLevels(DEFAULT_WAVE);
          break;

        case 'error':
          setStatus('error');
          setProgressMessage('');
          setProgressPercent(null);
          setErrorMessage(msg.message || 'Не удалось распознать речь. Попробуй ещё раз.');
          setErrorBadge(msg.errorBadge || 'Ошибка распознавания');
          setErrorHint(msg.errorHint || msg.message || '');
          setLevels(DEFAULT_WAVE);
          break;

        case 'cancelled':
          hideOverlay();
          break;

        case 'transcribed': {
          const text = (msg.text || '').trim();
          hideOverlay();
          if (text) {
            onTranscriptionReady(text);
          }
          break;
        }
      }
    };

    window.addEventListener('message', handleMessage as EventListener);
    return () => window.removeEventListener('message', handleMessage as EventListener);
  }, [hideOverlay, onTranscriptionReady]);

  useEffect(() => {
    if (status === 'hidden') {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (statusRef.current === 'recording' || statusRef.current === 'paused' || statusRef.current === 'error') {
          event.preventDefault();
          event.stopPropagation();
          void cancelRecording();
        }
      } else if (event.key === 'Enter') {
        if (statusRef.current === 'recording' || statusRef.current === 'paused') {
          event.preventDefault();
          event.stopPropagation();
          void confirmRecording();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [cancelRecording, confirmRecording, status]);

  useEffect(() => {
    return () => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) {
        return;
      }
      vscode.postMessage({ type: 'cancelPromptVoiceRecording', sessionId });
      activeSessionIdRef.current = null;
    };
  }, []);

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
    isVisible: status !== 'hidden',
    canConfirm: status === 'recording' || status === 'paused',
    canPause: status === 'recording',
    canResume: status === 'paused' || status === 'error',
    canCancel: status === 'recording' || status === 'paused' || status === 'error',
    startRecording,
    pauseRecording,
    resumeRecording,
    confirmRecording,
    cancelRecording,
  }), [
    cancelRecording,
    confirmRecording,
    elapsedMs,
    errorBadge,
    errorHint,
    errorMessage,
    levels,
    pauseRecording,
    progressMessage,
    progressPercent,
    resumeRecording,
    startRecording,
    status,
  ]);
};
