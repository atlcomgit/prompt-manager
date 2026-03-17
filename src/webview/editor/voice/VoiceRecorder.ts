import { DEFAULT_PROMPT_VOICE_WAVE_BARS, PROMPT_VOICE_TARGET_SAMPLE_RATE, createIdleWaveLevels } from './promptVoiceUtils';

export type VoiceRecordingResult = {
  durationMs: number;
  samples: Float32Array;
  sampleRate: number;
};

const getSupportedMimeType = (): string | undefined => {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }

  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];

  return candidates.find(type => MediaRecorder.isTypeSupported(type));
};

const buildMonoChannel = (buffer: AudioBuffer): Float32Array => {
  const channelCount = Math.max(1, buffer.numberOfChannels);
  if (channelCount === 1) {
    return new Float32Array(buffer.getChannelData(0));
  }

  const mono = new Float32Array(buffer.length);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channelData = buffer.getChannelData(channelIndex);
    for (let sampleIndex = 0; sampleIndex < channelData.length; sampleIndex += 1) {
      mono[sampleIndex] += channelData[sampleIndex] / channelCount;
    }
  }
  return mono;
};

const downsampleAudio = (input: Float32Array, sourceRate: number, targetRate: number): Float32Array => {
  if (sourceRate === targetRate) {
    return input;
  }

  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(input.length, Math.floor((outputIndex + 1) * ratio));
    if (end <= start) {
      output[outputIndex] = input[Math.min(start, input.length - 1)] || 0;
      continue;
    }

    let total = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      total += input[inputIndex];
    }
    output[outputIndex] = total / Math.max(1, end - start);
  }

  return output;
};

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: BlobPart[] = [];
  private readonly mimeType = getSupportedMimeType();
  private readonly frequencyData = new Uint8Array(128);

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('PROMPT_VOICE_MEDIA_DEVICES_UNAVAILABLE');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('PROMPT_VOICE_MEDIA_RECORDER_UNAVAILABLE');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioContext = new AudioContext();
    await this.audioContext.resume().catch(() => null);
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.75;
    source.connect(this.analyser);

    this.chunks = [];
    this.recorder = this.mimeType
      ? new MediaRecorder(this.stream, { mimeType: this.mimeType })
      : new MediaRecorder(this.stream);

    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };

    this.recorder.start(250);
  }

  pause(): void {
    if (this.recorder?.state === 'recording') {
      this.recorder.pause();
    }
  }

  resume(): void {
    if (this.recorder?.state === 'paused') {
      this.recorder.resume();
    }
  }

  getWaveLevels(barCount: number = DEFAULT_PROMPT_VOICE_WAVE_BARS): number[] {
    if (!this.analyser) {
      return createIdleWaveLevels(barCount);
    }

    const requiredLength = this.analyser.frequencyBinCount;
    const data = this.frequencyData.length === requiredLength
      ? this.frequencyData
      : new Uint8Array(requiredLength);
    this.analyser.getByteFrequencyData(data);

    const groupSize = Math.max(1, Math.floor(data.length / barCount));
    const levels: number[] = [];

    for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
      const start = barIndex * groupSize;
      const end = Math.min(data.length, start + groupSize);
      let total = 0;
      for (let dataIndex = start; dataIndex < end; dataIndex += 1) {
        total += data[dataIndex];
      }
      const average = total / Math.max(1, end - start);
      levels.push(Math.max(0.08, Math.min(1, average / 255)));
    }

    return levels;
  }

  async stop(durationMs: number): Promise<VoiceRecordingResult> {
    if (!this.recorder) {
      throw new Error('PROMPT_VOICE_NOT_STARTED');
    }

    const recorder = this.recorder;
    if (recorder.state !== 'inactive') {
      await new Promise<void>((resolve, reject) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.addEventListener('error', () => reject(new Error('PROMPT_VOICE_STOP_FAILED')), { once: true });
        recorder.stop();
      });
    }

    const blob = new Blob(this.chunks, { type: recorder.mimeType || this.mimeType || 'audio/webm' });
    const context = this.audioContext || new AudioContext();
    const buffer = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(buffer.slice(0));
    const mono = buildMonoChannel(audioBuffer);
    const samples = downsampleAudio(mono, audioBuffer.sampleRate, PROMPT_VOICE_TARGET_SAMPLE_RATE);

    await this.cleanup();

    return {
      durationMs,
      samples,
      sampleRate: PROMPT_VOICE_TARGET_SAMPLE_RATE,
    };
  }

  async cancel(): Promise<void> {
    this.chunks = [];
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        // ignore best-effort cleanup
      }
    }
    await this.cleanup();
  }

  async dispose(): Promise<void> {
    await this.cancel();
  }

  private async cleanup(): Promise<void> {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
    this.stream = null;
    this.recorder = null;
    this.analyser = null;
    this.chunks = [];

    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // ignore
      }
    }
    this.audioContext = null;
  }
}
