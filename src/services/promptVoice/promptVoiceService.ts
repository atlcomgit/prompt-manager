import type { ExtensionToWebviewMessage } from '../../types/messages.js';
import { createIdleWaveLevels, createSilentWaveLevels } from '../../shared/promptVoice.js';
import { getPromptManagerOutputChannel } from '../../utils/promptManagerOutput.js';
import { PromptVoiceRecorder } from './promptVoiceRecorder.js';
import { PromptVoiceTranscriptionService } from './promptVoiceTranscriptionService.js';

type PostMessage = (message: ExtensionToWebviewMessage) => void;

type PromptVoiceSessionEntry = {
  sessionId: string;
  postMessage: PostMessage;
  recorder: PromptVoiceRecorder;
  isProcessing: boolean;
};

type PromptVoiceErrorMeta = {
  message: string;
  badge: string;
  hint: string;
};

const normalizeErrorText = (value: unknown): string => {
  if (value instanceof Error) {
    return value.message;
  }
  return String(value || '').trim();
};

const getErrorMeta = (error: unknown): PromptVoiceErrorMeta => {
  const raw = normalizeErrorText(error);
  if (!raw) {
    return {
      message: 'Не удалось распознать речь. Попробуй ещё раз.',
      badge: 'Ошибка распознавания',
      hint: 'Открой Prompt Manager Output, если ошибка повторяется.',
    };
  }

  if (raw.includes('PROMPT_VOICE_OS_UNSUPPORTED')) {
    return {
      message: 'Локальная запись звука пока не поддерживается в этой системе.',
      badge: 'Система не поддерживается',
      hint: 'Сейчас extension-side запись реализована для Linux.',
    };
  }

  if (raw.includes('PROMPT_VOICE_RECORDER_START_FAILED:arecord:audio open error: Device or resource busy')) {
    return {
      message: 'Микрофон уже занят другим приложением.',
      badge: 'Микрофон занят',
      hint: 'Закрой другое приложение, которое сейчас использует микрофон, и попробуй ещё раз.',
    };
  }

  if (raw.includes('PROMPT_VOICE_RECORDER_START_FAILED:arecord:audio open error: No such file or directory')) {
    return {
      message: 'Не удалось найти устройство записи.',
      badge: 'Микрофон не найден',
      hint: 'Проверь настройки аудиовхода в системе.',
    };
  }

  if (
    raw.includes('PROMPT_VOICE_RECORDER_START_FAILED')
    || raw.includes('spawn arecord ENOENT')
    || raw.includes('spawn pw-record ENOENT')
  ) {
    return {
      message: 'Не удалось открыть локальную запись звука.',
      badge: 'Ошибка записи',
      hint: 'Нужен рабочий системный аудиовход. Для Linux используются `arecord` или `pw-record`.',
    };
  }

  if (raw.includes('PROMPT_VOICE_EMPTY_TRANSCRIPTION')) {
    return {
      message: 'Распознавание завершилось без текста.',
      badge: 'Пустой результат',
      hint: 'Попробуй говорить чуть громче или сделать запись короче.',
    };
  }

  if (raw.includes('fetch failed') || raw.includes('Failed to fetch') || raw.includes('NetworkError')) {
    return {
      message: 'Не удалось загрузить модель распознавания.',
      badge: 'Не загрузилась модель STT',
      hint: 'Проверь сеть и попробуй ещё раз.',
    };
  }

  return {
    message: 'Не удалось распознать речь. Попробуй ещё раз.',
    badge: 'Ошибка распознавания',
    hint: raw,
  };
};

export class PromptVoiceService {
  private readonly sessions = new Map<string, PromptVoiceSessionEntry>();
  private readonly output = getPromptManagerOutputChannel();
  private readonly transcriptionService: PromptVoiceTranscriptionService;

  constructor(cacheDir: string) {
    this.transcriptionService = new PromptVoiceTranscriptionService(cacheDir);
  }

  async start(panelKey: string, sessionId: string, postMessage: PostMessage): Promise<void> {
    await this.cancel(panelKey);

    const recorder = new PromptVoiceRecorder({
      output: this.output,
      onLevel: (level, elapsedMs, levels) => {
        const session = this.sessions.get(panelKey);
        if (!session || session.sessionId !== sessionId || session.isProcessing) {
          return;
        }

        session.postMessage({
          type: 'promptVoiceState',
          sessionId,
          status: 'recording',
          elapsedMs,
          level,
          levels,
        });
      },
      onLimitReached: () => {
        void this.confirm(panelKey, sessionId);
      },
      onError: (error) => {
        const session = this.getSession(panelKey, sessionId);
        if (!session) {
          return;
        }
        session.isProcessing = false;
        this.postError(session.postMessage, sessionId, error);
      },
    });

    this.sessions.set(panelKey, {
      sessionId,
      postMessage,
      recorder,
      isProcessing: false,
    });

    try {
      await recorder.start();
      const session = this.sessions.get(panelKey);
      if (!session || session.sessionId !== sessionId) {
        return;
      }

      session.postMessage({
        type: 'promptVoiceState',
        sessionId,
        status: 'recording',
        elapsedMs: 0,
        level: 0.08,
        levels: createIdleWaveLevels(),
      });
    } catch (error) {
      await recorder.dispose().catch(() => null);
      const session = this.sessions.get(panelKey);
      if (session?.sessionId === sessionId) {
        this.sessions.delete(panelKey);
      }
      this.postError(postMessage, sessionId, error);
    }
  }

  async pause(panelKey: string, sessionId: string): Promise<void> {
    const session = this.getSession(panelKey, sessionId);
    if (!session || session.isProcessing) {
      return;
    }

    try {
      await session.recorder.pause();
      session.postMessage({
        type: 'promptVoiceState',
        sessionId,
        status: 'paused',
        elapsedMs: session.recorder.getElapsedMs(),
        levels: createSilentWaveLevels(),
      });
    } catch (error) {
      this.postError(session.postMessage, sessionId, error);
    }
  }

  async resume(panelKey: string, sessionId: string): Promise<void> {
    const session = this.getSession(panelKey, sessionId);
    if (!session || session.isProcessing) {
      return;
    }

    try {
      await session.recorder.resume();
      session.postMessage({
        type: 'promptVoiceState',
        sessionId,
        status: 'recording',
        elapsedMs: session.recorder.getElapsedMs(),
        level: 0.08,
        levels: createIdleWaveLevels(),
      });
    } catch (error) {
      this.postError(session.postMessage, sessionId, error);
    }
  }

  async confirm(panelKey: string, sessionId: string): Promise<void> {
    const session = this.getSession(panelKey, sessionId);
    if (!session || session.isProcessing) {
      return;
    }

    session.isProcessing = true;
    const elapsedBeforeProcessing = session.recorder.getElapsedMs();
    session.postMessage({
      type: 'promptVoiceState',
      sessionId,
      status: 'processing',
      elapsedMs: elapsedBeforeProcessing,
      message: 'Обрабатывается',
      progress: null,
    });

    try {
      const result = await session.recorder.stop();
      const text = await this.transcriptionService.transcribe(result.samples, (state) => {
        const activeSession = this.getSession(panelKey, sessionId);
        if (!activeSession) {
          return;
        }

        activeSession.postMessage({
          type: 'promptVoiceState',
          sessionId,
          status: state.stage,
          elapsedMs: result.durationMs,
          message: state.message,
          progress: typeof state.progress === 'number' ? state.progress : null,
        });
      });

      if (!text.trim()) {
        throw new Error('PROMPT_VOICE_EMPTY_TRANSCRIPTION');
      }

      const activeSession = this.getSession(panelKey, sessionId);
      if (!activeSession) {
        return;
      }

      activeSession.postMessage({
        type: 'promptVoiceState',
        sessionId,
        status: 'transcribed',
        text,
      });
      this.sessions.delete(panelKey);
    } catch (error) {
      const activeSession = this.getSession(panelKey, sessionId);
      if (activeSession) {
        activeSession.isProcessing = false;
        this.postError(activeSession.postMessage, sessionId, error);
      }
    } finally {
      const activeSession = this.sessions.get(panelKey);
      if (!activeSession || activeSession.sessionId !== sessionId) {
        await session.recorder.dispose().catch(() => null);
      }
    }
  }

  async cancel(panelKey: string, sessionId?: string): Promise<void> {
    const session = this.sessions.get(panelKey);
    if (!session) {
      return;
    }
    if (sessionId && session.sessionId !== sessionId) {
      return;
    }

    this.sessions.delete(panelKey);
    await session.recorder.cancel().catch(() => null);
    session.postMessage({
      type: 'promptVoiceState',
      sessionId: session.sessionId,
      status: 'cancelled',
    });
  }

  async dispose(): Promise<void> {
    const panelKeys = Array.from(this.sessions.keys());
    for (const panelKey of panelKeys) {
      await this.cancel(panelKey);
    }
  }

  private getSession(panelKey: string, sessionId: string): PromptVoiceSessionEntry | null {
    const session = this.sessions.get(panelKey);
    if (!session || session.sessionId !== sessionId) {
      return null;
    }
    return session;
  }

  private postError(postMessage: PostMessage, sessionId: string, error: unknown): void {
    const raw = normalizeErrorText(error);
    if (raw) {
      this.output.appendLine(`[prompt-voice] ${raw}`);
    }
    const meta = getErrorMeta(error);
    postMessage({
      type: 'promptVoiceState',
      sessionId,
      status: 'error',
      message: meta.message,
      errorBadge: meta.badge,
      errorHint: meta.hint,
    });
  }
}
