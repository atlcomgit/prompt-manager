import type { AutomaticSpeechRecognitionPipelineType } from '@xenova/transformers';

export type PromptVoicePreparationState = {
  stage: 'preparing-model' | 'processing';
  message: string;
  progress?: number | null;
};

export interface PromptVoiceSttProvider {
  transcribe(
    samples: Float32Array,
    onStateChange?: (state: PromptVoicePreparationState) => void,
  ): Promise<string>;
}

const DEFAULT_WHISPER_MODEL_ID = 'Xenova/whisper-tiny';
const DEFAULT_CHUNK_LENGTH_SECONDS = 20;
const DEFAULT_STRIDE_SECONDS = 4;

let pipelinePromise: Promise<AutomaticSpeechRecognitionPipelineType> | null = null;

const describeProgress = (status: string, file?: string): string => {
  const prettyFile = file ? ` ${file.split('/').pop()}` : '';
  switch (status) {
    case 'initiate':
      return 'Подготавливается модель';
    case 'download':
      return `Загружается${prettyFile}`;
    case 'progress':
      return `Загружается${prettyFile}`;
    case 'done':
      return 'Модель готова';
    default:
      return 'Подготавливается модель';
  }
};

const ensurePipeline = async (
  onStateChange?: (state: PromptVoicePreparationState) => void,
): Promise<AutomaticSpeechRecognitionPipelineType> => {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { env, pipeline } = await import('@xenova/transformers');
      env.allowRemoteModels = true;
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
      }

      return pipeline('automatic-speech-recognition', DEFAULT_WHISPER_MODEL_ID, {
        quantized: true,
        progress_callback: (progress: { status?: string; file?: string; progress?: number }) => {
          const status = progress.status || 'initiate';
          onStateChange?.({
            stage: 'preparing-model',
            message: describeProgress(status, progress.file),
            progress: typeof progress.progress === 'number' ? progress.progress : null,
          });
        },
      }) as Promise<AutomaticSpeechRecognitionPipelineType>;
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
