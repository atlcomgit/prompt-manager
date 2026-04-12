import * as fs from 'fs';
import { preparePromptVoiceSamplesForTranscription } from '../../shared/promptVoice.js';

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

export type PromptVoiceTranscriptionState = {
  stage: 'preparing-model' | 'processing';
  message: string;
  progress?: number | null;
};

const DEFAULT_WHISPER_MODEL_ID = 'Xenova/whisper-base';
const DEFAULT_CHUNK_LENGTH_SECONDS = 20;
const DEFAULT_STRIDE_SECONDS = 4;

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

export class PromptVoiceTranscriptionService {
  private pipelinePromise: Promise<AutomaticSpeechRecognitionPipelineType> | null = null;

  constructor(private readonly cacheDir: string) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  async transcribe(
    samples: Float32Array,
    onStateChange?: (state: PromptVoiceTranscriptionState) => void,
  ): Promise<string> {
    if (!samples.length) {
      return '';
    }

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

  private async ensurePipeline(
    onStateChange?: (state: PromptVoiceTranscriptionState) => void,
  ): Promise<AutomaticSpeechRecognitionPipelineType> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        const { env, pipeline } = await import('@xenova/transformers');
        env.cacheDir = this.cacheDir;
        env.allowLocalModels = true;
        env.allowRemoteModels = true;

        return pipeline('automatic-speech-recognition', DEFAULT_WHISPER_MODEL_ID, {
          quantized: true,
          progress_callback: (progress: { status?: string; file?: string; progress?: number }) => {
            onStateChange?.({
              stage: 'preparing-model',
              message: describeProgress(progress.status || 'initiate', progress.file),
              progress: typeof progress.progress === 'number' ? progress.progress : null,
            });
          },
        }) as Promise<AutomaticSpeechRecognitionPipelineType>;
      })().catch((error) => {
        this.pipelinePromise = null;
        throw error;
      });
    }

    return this.pipelinePromise;
  }
}
