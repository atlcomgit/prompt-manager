import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import * as vscode from 'vscode';
import {
  DEFAULT_PROMPT_VOICE_WAVE_BARS,
  MAX_PROMPT_VOICE_RECORDING_BYTES,
  MAX_PROMPT_VOICE_RECORDING_MS,
  PROMPT_VOICE_BYTES_PER_SAMPLE,
  PROMPT_VOICE_TARGET_SAMPLE_RATE,
  blendPromptVoiceWaveLevels,
  createIdleWaveLevels,
  createWaveLevelsFromPcm16,
} from '../../shared/promptVoice.js';

export type PromptVoiceRecorderOptions = {
  onLevel?: (level: number, elapsedMs: number, levels: number[]) => void;
  onLimitReached?: () => void;
  onError?: (error: Error) => void;
  output?: vscode.OutputChannel;
};

type PromptVoiceRecorderBackend = {
  command: string;
  args: string[];
};

/** Запуск можно прервать до получения первого блока PCM. */
type RecorderState = 'idle' | 'starting' | 'recording' | 'paused';

const START_TIMEOUT_MS = 250;
const STOP_TIMEOUT_MS = 1200;
const LEVEL_THROTTLE_MS = 80;

/** Небольшие периоды ALSA уменьшают задержку первой порции PCM и индикации микрофона. */
const LINUX_BACKENDS: PromptVoiceRecorderBackend[] = [
  {
    command: 'arecord',
    args: ['-q', '-t', 'raw', '-f', 'S16_LE', '-c', '1', '-r', String(PROMPT_VOICE_TARGET_SAMPLE_RATE),
      '--period-time=20000', '--buffer-time=80000'],
  },
  {
    command: 'pw-record',
    args: ['--raw', '--format=s16', '--rate', String(PROMPT_VOICE_TARGET_SAMPLE_RATE), '--channels', '1', '-'],
  },
];

const bytesToMs = (byteLength: number): number => Math.min(
  MAX_PROMPT_VOICE_RECORDING_MS,
  Math.floor((byteLength / (PROMPT_VOICE_TARGET_SAMPLE_RATE * PROMPT_VOICE_BYTES_PER_SAMPLE)) * 1000),
);

const waveLevelsToScalar = (levels: number[]): number => {
  if (!levels.length) {
    return 0.06;
  }

  const total = levels.reduce((sum, value) => sum + value, 0);
  const average = total / levels.length;
  const peak = levels.reduce((max, value) => Math.max(max, value), 0.06);
  return Math.max(0.06, Math.min(1, (peak * 0.7) + (average * 0.3)));
};

const pcmToFloat32 = (buffer: Buffer): Float32Array => {
  const sampleCount = Math.floor(buffer.length / 2);
  const output = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    output[index] = buffer.readInt16LE(index * 2) / 32768;
  }

  return output;
};

const trimRecorderError = (value: string): string => value.replace(/\s+/g, ' ').trim();

export type PromptVoiceRecordingResult = {
  durationMs: number;
  samples: Float32Array;
};

export class PromptVoiceRecorder {
  private process: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private state: RecorderState = 'idle';
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private lastLevelEmitAt = 0;
  private stopPromise: Promise<void> | null = null;
  private limitReached = false;
  private lastWaveLevels = createIdleWaveLevels();

  constructor(private readonly options: PromptVoiceRecorderOptions = {}) { }

  getElapsedMs(): number {
    return bytesToMs(this.totalBytes);
  }

  /** Сбрасывает буферы новой записи и открывает устройство захвата. */
  async start(): Promise<void> {
    this.chunks = [];
    this.totalBytes = 0;
    this.limitReached = false;
    this.lastLevelEmitAt = 0;
    this.lastWaveLevels = createIdleWaveLevels();
    await this.startCapture();
  }

  /** Приостанавливает захват, включая запуск, и сохраняет собранный PCM. */
  async pause(): Promise<void> {
    if (this.state !== 'recording' && this.state !== 'starting') {
      return;
    }

    this.state = 'paused';
    await this.stopActiveProcess('pause');
  }

  /** Снова открывает устройство и продолжает заполнять буфер записи. */
  async resume(): Promise<void> {
    if (this.state !== 'paused') {
      return;
    }

    await this.stopPromise;
    if (this.state === 'paused') await this.startCapture();
  }

  /** Освобождает устройство даже при остановке до первого блока PCM. */
  async stop(): Promise<PromptVoiceRecordingResult> {
    this.state = 'idle';
    await this.stopActiveProcess('stop');
    const combined = Buffer.concat(this.chunks);
    const samples = pcmToFloat32(combined);
    this.chunks = [];

    return {
      durationMs: bytesToMs(this.totalBytes),
      samples,
    };
  }

  /** Прерывает инициализацию или захват и освобождает данные записи. */
  async cancel(): Promise<void> {
    this.state = 'idle';
    if (this.process) {
      await this.stopActiveProcess('cancel');
    }

    this.chunks = [];
    this.totalBytes = 0;
    this.limitReached = false;
    this.lastLevelEmitAt = 0;
    this.lastWaveLevels = createIdleWaveLevels();
  }

  async dispose(): Promise<void> {
    await this.cancel();
  }

  /** При отмене запуска резервное устройство открывать уже не нужно. */
  private async startCapture(): Promise<void> {
    this.state = 'starting';
    await this.spawnRecorder();
    if (this.state === 'starting') this.state = 'recording';
  }

  /** Пробует следующие системные команды только пока пользователь ожидает захват. */
  private async spawnRecorder(): Promise<void> {
    const backends = process.platform === 'linux' ? LINUX_BACKENDS : [];
    if (backends.length === 0) {
      throw new Error(`PROMPT_VOICE_OS_UNSUPPORTED:${process.platform}`);
    }

    let lastError: Error | null = null;
    for (const backend of backends) {
      if (this.state !== 'starting') return;
      try {
        await this.startBackend(backend);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.log(`Recorder backend "${backend.command}" failed: ${lastError.message}`);
      }
    }

    if (this.state === 'starting') throw lastError || new Error('PROMPT_VOICE_RECORDER_UNAVAILABLE');
  }

  /** Завершает ожидание сразу после прихода аудио, сохраняя время для ранних ошибок драйвера. */
  private async startBackend(backend: PromptVoiceRecorderBackend): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let stderr = '';
      const chunksBefore = this.chunks.length;
      const totalBytesBefore = this.totalBytes;
      const child = spawn(backend.command, backend.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.attachProcess(child);

      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        fn();
      };

      const startTimer = setTimeout(() => {
        settle(() => {
          resolve();
        });
      }, START_TIMEOUT_MS);

      child.stdout.once('data', () => {
        clearTimeout(startTimer);
        settle(resolve);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });

      child.once('error', (error) => {
        clearTimeout(startTimer);
        settle(() => {
          this.process = null;
          this.chunks.length = chunksBefore;
          this.totalBytes = totalBytesBefore;
          reject(error);
        });
      });

      child.once('close', (code, signal) => {
        clearTimeout(startTimer);
        if (!settled) {
          const details = trimRecorderError(stderr);
          const reason = details || `exit=${code ?? 'null'} signal=${signal ?? 'null'}`;
          settle(() => {
            this.process = null;
            this.chunks.length = chunksBefore;
            this.totalBytes = totalBytesBefore;
            reject(new Error(`PROMPT_VOICE_RECORDER_START_FAILED:${backend.command}:${reason}`));
          });
        }
      });
    });
  }

  private attachProcess(child: ChildProcessByStdio<null, Readable, Readable>): void {
    this.process = child;

    child.stdout.on('data', (chunk: Buffer) => {
      if (!chunk.length) {
        return;
      }

      const remainingBytes = Math.max(0, MAX_PROMPT_VOICE_RECORDING_BYTES - this.totalBytes);
      if (remainingBytes <= 0) {
        void this.handleLimitReached();
        return;
      }

      const safeChunk = chunk.length > remainingBytes
        ? chunk.subarray(0, remainingBytes)
        : chunk;

      this.chunks.push(Buffer.from(safeChunk));
      this.totalBytes += safeChunk.length;

      const now = Date.now();
      if (now - this.lastLevelEmitAt >= LEVEL_THROTTLE_MS) {
        this.lastLevelEmitAt = now;
        const waveLevels = blendPromptVoiceWaveLevels(
          this.lastWaveLevels,
          createWaveLevelsFromPcm16(safeChunk, DEFAULT_PROMPT_VOICE_WAVE_BARS),
          DEFAULT_PROMPT_VOICE_WAVE_BARS,
        );
        this.lastWaveLevels = waveLevels;
        this.options.onLevel?.(waveLevelsToScalar(waveLevels), this.getElapsedMs(), waveLevels);
      }

      if (this.totalBytes >= MAX_PROMPT_VOICE_RECORDING_BYTES) {
        void this.handleLimitReached();
      }
    });

    child.once('close', (_code, _signal) => {
      const stopPromise = this.stopPromise;
      this.process = null;
      if (stopPromise) {
        return;
      }

      if (this.state === 'recording' && !this.limitReached) {
        const error = new Error('PROMPT_VOICE_RECORDER_CLOSED_UNEXPECTEDLY');
        this.log('Recorder process closed unexpectedly.');
        this.options.onError?.(error);
      }
    });
  }

  private async stopActiveProcess(reason: 'pause' | 'stop' | 'cancel'): Promise<void> {
    if (!this.process) {
      return;
    }
    if (this.stopPromise) {
      return this.stopPromise;
    }

    const child = this.process;
    this.stopPromise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.stopPromise = null;
        resolve();
      };

      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, STOP_TIMEOUT_MS);

      child.once('close', () => {
        clearTimeout(killTimer);
        finish();
      });

      child.once('error', () => {
        clearTimeout(killTimer);
        finish();
      });

      try {
        child.kill('SIGINT');
      } catch {
        clearTimeout(killTimer);
        finish();
      }
    });

    await this.stopPromise;
  }

  private async handleLimitReached(): Promise<void> {
    if (this.limitReached) {
      return;
    }

    this.limitReached = true;
    if (this.state === 'recording') {
      await this.stopActiveProcess('stop');
      this.state = 'paused';
    }
    this.options.onLimitReached?.();
  }

  private log(message: string): void {
    this.options.output?.appendLine(`[prompt-voice/recorder] ${message}`);
  }
}
