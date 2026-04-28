import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  WHISPER_MODEL_MAP,
  preparePromptVoiceSamplesForTranscription,
  type WhisperModelSize,
} from '../../shared/promptVoice.js';

/** Вызываемый тип ASR-pipeline (результат pipeline()) */
type AutomaticSpeechRecognitionPipelineType = (
  samples: Float32Array,
  options: {
    language: string;
    task: 'transcribe';
    chunk_length_s: number;
    stride_length_s: number;
    return_timestamps: boolean;
  },
) => Promise<{ text?: string } | Array<{ text?: string }>>;

/** Состояние подготовки модели или обработки аудио */
export type PromptVoiceTranscriptionState = {
  stage: 'preparing-model' | 'processing';
  message: string;
  progress?: number | null;
};

/** Длина чанка в секундах для потоковой обработки длинных аудио */
const DEFAULT_CHUNK_LENGTH_SECONDS = 20;
/** Перекрытие чанков в секундах для плавного склеивания */
const DEFAULT_STRIDE_SECONDS = 4;
/** Модель Whisper по умолчанию из пользовательских настроек */
const DEFAULT_WHISPER_MODEL_SIZE: WhisperModelSize = 'small';
/** Язык распознавания по умолчанию */
const DEFAULT_WHISPER_LANGUAGE = 'russian';

/** Настройки текущего запуска транскрипции */
type PromptVoiceTranscriptionSettings = {
  modelId: string;
  language: string;
};

/** Кэшированная модель ASR для выбранного размера Whisper */
type PromptVoicePipelineCache = {
  modelId: string;
  promise: Promise<AutomaticSpeechRecognitionPipelineType>;
};

/** Описание прогресса загрузки модели для UI */
const describeProgress = (status: string, file?: string): string => {
  const prettyFile = file ? ` ${file.split('/').pop()}` : '';
  switch (status) {
    case 'initiate':
      return 'Подготавливается модель';
    case 'download':
    case 'progress':
      return `Загружается${prettyFile}`;
    case 'done':
      return 'Модель готова';
    default:
      return 'Подготавливается модель';
  }
};

/** Сервис транскрипции речи на стороне extension host (Node.js) */
export class PromptVoiceTranscriptionService {
  /** Кэшированный promise для ленивой инициализации pipeline */
  private pipelineCache: PromptVoicePipelineCache | null = null;
  /** Слушатели прогресса загрузки модели для активных задач */
  private readonly stateListeners = new Set<(state: PromptVoiceTranscriptionState) => void>();

  constructor(private readonly cacheDir: string) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  /** Подготавливает модель заранее, пока пользователь еще записывает голос */
  async preload(onStateChange?: (state: PromptVoiceTranscriptionState) => void): Promise<void> {
    const settings = this.resolveSettings();
    await this.withStateListener(onStateChange, async () => {
      await this.ensurePipeline(settings.modelId);
    });
  }

  /** Транскрибирует PCM-сэмплы в текст через Whisper */
  async transcribe(
    samples: Float32Array,
    onStateChange?: (state: PromptVoiceTranscriptionState) => void,
  ): Promise<string> {
    if (!samples.length) {
      return '';
    }

    // Препроцессинг аудио: нормализация, шумоподавление
    const preparedSamples = preparePromptVoiceSamplesForTranscription(samples);

    const settings = this.resolveSettings();
    const transcriber = await this.withStateListener(onStateChange, () => this.ensurePipeline(settings.modelId));
    onStateChange?.({
      stage: 'processing',
      message: 'Обрабатывается',
      progress: null,
    });

    const output = await transcriber(preparedSamples, {
      language: settings.language,
      task: 'transcribe',
      chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
      stride_length_s: DEFAULT_STRIDE_SECONDS,
      return_timestamps: false,
    });

    const result = Array.isArray(output) ? output[0]?.text || '' : output.text || '';
    return result.trim();
  }

  /** Ленивая инициализация ASR-pipeline с квантизацией q8 */
  private async ensurePipeline(modelId: string): Promise<AutomaticSpeechRecognitionPipelineType> {
    if (!this.pipelineCache || this.pipelineCache.modelId !== modelId) {
      const promise = (async () => {
        const { env, pipeline } = await import('@huggingface/transformers');
        // Настройка среды: кэш в локальной директории, загрузка с HuggingFace Hub
        env.cacheDir = this.cacheDir;
        env.allowLocalModels = true;
        env.allowRemoteModels = true;

        return pipeline('automatic-speech-recognition', modelId, {
          dtype: 'q8',
          progress_callback: (progress: { status?: string; file?: string; progress?: number }) => {
            this.emitState({
              stage: 'preparing-model',
              message: describeProgress(progress.status || 'initiate', progress.file),
              progress: typeof progress.progress === 'number' ? progress.progress : null,
            });
          },
        }) as unknown as Promise<AutomaticSpeechRecognitionPipelineType>;
      })().catch((error) => {
        if (this.pipelineCache?.promise === promise) {
          this.pipelineCache = null;
        }
        throw error;
      });
      this.pipelineCache = { modelId, promise };
    }

    return this.pipelineCache.promise;
  }

  /** Безопасно добавляет временного слушателя прогресса на время операции */
  private async withStateListener<T>(
    onStateChange: ((state: PromptVoiceTranscriptionState) => void) | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!onStateChange) {
      return action();
    }

    this.stateListeners.add(onStateChange);
    try {
      return await action();
    } finally {
      this.stateListeners.delete(onStateChange);
    }
  }

  /** Отправляет состояние подготовки модели всем активным слушателям */
  private emitState(state: PromptVoiceTranscriptionState): void {
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  /** Читает пользовательские настройки модели и языка распознавания */
  private resolveSettings(): PromptVoiceTranscriptionSettings {
    const config = vscode.workspace.getConfiguration('promptManager');
    const modelSize = this.normalizeModelSize(config.get<string>('voice.whisperModel', DEFAULT_WHISPER_MODEL_SIZE));
    const language = String(config.get<string>('voice.language', DEFAULT_WHISPER_LANGUAGE) || DEFAULT_WHISPER_LANGUAGE).trim()
      || DEFAULT_WHISPER_LANGUAGE;
    return {
      modelId: WHISPER_MODEL_MAP[modelSize],
      language,
    };
  }

  /** Нормализует неизвестное значение настройки к поддерживаемому размеру Whisper */
  private normalizeModelSize(value: string | undefined): WhisperModelSize {
    if (value === 'tiny' || value === 'base' || value === 'small') {
      return value;
    }
    return DEFAULT_WHISPER_MODEL_SIZE;
  }
}
