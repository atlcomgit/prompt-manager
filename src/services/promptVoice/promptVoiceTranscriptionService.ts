import * as fs from 'fs';
import { preparePromptVoiceSamplesForTranscription } from '../../shared/promptVoice.js';

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

/** ID модели Whisper для распознавания на backend (onnx-community, квантизованная) */
const DEFAULT_WHISPER_MODEL_ID = 'onnx-community/whisper-small';
/** Длина чанка в секундах для потоковой обработки длинных аудио */
const DEFAULT_CHUNK_LENGTH_SECONDS = 20;
/** Перекрытие чанков в секундах для плавного склеивания */
const DEFAULT_STRIDE_SECONDS = 4;

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
  private pipelinePromise: Promise<AutomaticSpeechRecognitionPipelineType> | null = null;

  constructor(private readonly cacheDir: string) {
    fs.mkdirSync(cacheDir, { recursive: true });
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

    const transcriber = await this.ensurePipeline(onStateChange);
    onStateChange?.({
      stage: 'processing',
      message: 'Обрабатывается',
      progress: null,
    });

    const output = await transcriber(preparedSamples, {
      language: 'russian',
      task: 'transcribe',
      chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
      stride_length_s: DEFAULT_STRIDE_SECONDS,
      return_timestamps: false,
    });

    const result = Array.isArray(output) ? output[0]?.text || '' : output.text || '';
    return result.trim();
  }

  /** Ленивая инициализация ASR-pipeline с квантизацией q8 */
  private async ensurePipeline(
    onStateChange?: (state: PromptVoiceTranscriptionState) => void,
  ): Promise<AutomaticSpeechRecognitionPipelineType> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        const { env, pipeline } = await import('@huggingface/transformers');
        // Настройка среды: кэш в локальной директории, загрузка с HuggingFace Hub
        env.cacheDir = this.cacheDir;
        env.allowLocalModels = true;
        env.allowRemoteModels = true;

        return pipeline('automatic-speech-recognition', DEFAULT_WHISPER_MODEL_ID, {
          dtype: 'q8',
          progress_callback: (progress: { status?: string; file?: string; progress?: number }) => {
            onStateChange?.({
              stage: 'preparing-model',
              message: describeProgress(progress.status || 'initiate', progress.file),
              progress: typeof progress.progress === 'number' ? progress.progress : null,
            });
          },
        }) as unknown as Promise<AutomaticSpeechRecognitionPipelineType>;
      })().catch((error) => {
        this.pipelinePromise = null;
        throw error;
      });
    }

    return this.pipelinePromise;
  }
}
