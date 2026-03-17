import { DEFAULT_PROMPT_VOICE_WAVE_BARS, createIdleWaveLevels } from './promptVoiceUtils';

type SpeechRecognitionCtor = new () => {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: {
    resultIndex: number;
    results: ArrayLike<ArrayLike<{ transcript: string; confidence?: number }> & { isFinal?: boolean }>;
  }) => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

const getSpeechRecognitionCtor = (): SpeechRecognitionCtor | null => {
  const maybeCtor = (window as typeof window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }).SpeechRecognition
    || (window as typeof window & { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition;

  return maybeCtor || null;
};

const createSyntheticWaveLevels = (barCount: number = DEFAULT_PROMPT_VOICE_WAVE_BARS): number[] => {
  const idle = createIdleWaveLevels(barCount);
  return idle.map(base => {
    const jitter = (Math.random() * 0.5) - 0.12;
    return Math.max(0.12, Math.min(1, base + jitter));
  });
};

export type BrowserSpeechRecognitionStopResult = {
  durationMs: number;
  text: string;
};

export class BrowserSpeechRecognitionSession {
  private recognition: InstanceType<SpeechRecognitionCtor> | null = null;
  private finalTranscript = '';
  private interimTranscript = '';
  private active = false;
  private shouldRestart = false;
  private resolveStop: ((result: BrowserSpeechRecognitionStopResult) => void) | null = null;
  private rejectStop: ((error: Error) => void) | null = null;

  static isSupported(): boolean {
    return Boolean(getSpeechRecognitionCtor());
  }

  async start(): Promise<void> {
    const ctor = getSpeechRecognitionCtor();
    if (!ctor) {
      throw new Error('PROMPT_VOICE_SPEECH_RECOGNITION_UNAVAILABLE');
    }

    this.finalTranscript = '';
    this.interimTranscript = '';
    this.active = true;
    this.shouldRestart = true;

    const recognition = new ctor();
    this.recognition = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'ru-RU';
    recognition.onresult = (event) => {
      let nextFinal = '';
      let nextInterim = '';

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript || '';
        if ((result as { isFinal?: boolean }).isFinal) {
          nextFinal += transcript;
        } else {
          nextInterim += transcript;
        }
      }

      this.finalTranscript = `${this.finalTranscript}${nextFinal}`;
      this.interimTranscript = nextInterim;
    };
    recognition.onerror = (event) => {
      const rawError = event.error || event.message || 'speech-recognition-error';
      if (this.rejectStop) {
        const reject = this.rejectStop;
        this.clearStopHandlers();
        reject(new Error(`PROMPT_VOICE_SPEECH_RECOGNITION_ERROR:${rawError}`));
      }
    };
    recognition.onend = () => {
      if (this.shouldRestart && this.active) {
        try {
          recognition.start();
          return;
        } catch {
          // let stop flow handle it below
        }
      }

      if (this.resolveStop) {
        const resolve = this.resolveStop;
        this.clearStopHandlers();
        resolve({
          durationMs: 0,
          text: this.getTranscript(),
        });
      }
    };

    recognition.start();
  }

  pause(): void {
    if (!this.recognition) {
      return;
    }
    this.shouldRestart = false;
    try {
      this.recognition.stop();
    } catch {
      // ignore
    }
  }

  resume(): void {
    if (!this.recognition) {
      return;
    }
    this.shouldRestart = true;
    try {
      this.recognition.start();
    } catch {
      // ignore repeated starts
    }
  }

  async stop(durationMs: number): Promise<BrowserSpeechRecognitionStopResult> {
    if (!this.recognition) {
      throw new Error('PROMPT_VOICE_SPEECH_RECOGNITION_NOT_STARTED');
    }

    this.active = false;
    this.shouldRestart = false;

    return new Promise<BrowserSpeechRecognitionStopResult>((resolve, reject) => {
      this.resolveStop = (result) => resolve({ ...result, durationMs });
      this.rejectStop = reject;
      try {
        this.recognition?.stop();
      } catch (error) {
        this.clearStopHandlers();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async cancel(): Promise<void> {
    this.active = false;
    this.shouldRestart = false;
    this.clearStopHandlers();
    try {
      this.recognition?.abort();
    } catch {
      // ignore
    }
    this.recognition = null;
    this.finalTranscript = '';
    this.interimTranscript = '';
  }

  async dispose(): Promise<void> {
    await this.cancel();
  }

  getWaveLevels(barCount: number = DEFAULT_PROMPT_VOICE_WAVE_BARS): number[] {
    return createSyntheticWaveLevels(barCount);
  }

  private getTranscript(): string {
    return `${this.finalTranscript}${this.interimTranscript}`.trim();
  }

  private clearStopHandlers(): void {
    this.resolveStop = null;
    this.rejectStop = null;
  }
}
