/** Состояние подготовки модели или обработки аудио */
export type PromptVoicePreparationState = {
  stage: 'preparing-model' | 'processing';
  message: string;
  progress?: number | null;
};

/** Интерфейс провайдера распознавания речи */
export interface PromptVoiceSttProvider {
  transcribe(
    samples: Float32Array,
    onStateChange?: (state: PromptVoicePreparationState) => void,
  ): Promise<string>;
}

/** Вызываемый тип ASR-pipeline (результат pipeline()) */
type AsrPipelineCallable = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text?: string } | Array<{ text?: string }>>;

/** ID модели Whisper для распознавания в webview (onnx-community, квантизованная) */
const DEFAULT_WHISPER_MODEL_ID = 'onnx-community/whisper-small';
/** Длина чанка в секундах для потоковой обработки длинных аудио */
const DEFAULT_CHUNK_LENGTH_SECONDS = 20;
/** Перекрытие чанков в секундах для плавного склеивания */
const DEFAULT_STRIDE_SECONDS = 4;

/** Кэшированный promise для ленивой инициализации pipeline */
let pipelinePromise: Promise<AsrPipelineCallable> | null = null;

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

/** Ленивая инициализация ASR-pipeline с квантизацией q8 */
const ensurePipeline = async (
  onStateChange?: (state: PromptVoicePreparationState) => void,
): Promise<AsrPipelineCallable> => {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { env, pipeline } = await import('@huggingface/transformers');
      // Настройка среды: загрузка с HuggingFace Hub, кэш в браузере
      env.allowRemoteModels = true;
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      // Ограничение WASM-потоков для стабильности в webview
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
      }

      return pipeline('automatic-speech-recognition', DEFAULT_WHISPER_MODEL_ID, {
        dtype: 'q8',
        progress_callback: (progress: { status?: string; file?: string; progress?: number }) => {
          const status = progress.status || 'initiate';
          onStateChange?.({
            stage: 'preparing-model',
            message: describeProgress(status, progress.file),
            progress: typeof progress.progress === 'number' ? progress.progress : null,
          });
        },
      }) as unknown as AsrPipelineCallable;
    })().catch((error) => {
      pipelinePromise = null;
      throw error;
    });
  }

  return pipelinePromise;
};

export class TransformersWhisperSttProvider implements PromptVoiceSttProvider {
  async transcribe(
    samples: Float32Array,
    onStateChange?: (state: PromptVoicePreparationState) => void,
  ): Promise<string> {
    if (!samples || samples.length === 0) {
      return '';
    }

    const transcriber = await ensurePipeline(onStateChange);
    onStateChange?.({
      stage: 'processing',
      message: 'Обрабатывается',
      progress: null,
    });

    const output = await transcriber(samples, {
      language: 'russian',
      task: 'transcribe',
      chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
      stride_length_s: DEFAULT_STRIDE_SECONDS,
      return_timestamps: false,
    });

    const result = Array.isArray(output) ? output[0]?.text || '' : output.text || '';
    return result.trim();
  }
}
