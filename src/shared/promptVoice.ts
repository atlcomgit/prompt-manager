/** Максимальная длительность записи голоса (5 минут) */
export const MAX_PROMPT_VOICE_RECORDING_MS = 5 * 60 * 1000;
/** Количество баров визуализации волны по умолчанию */
export const DEFAULT_PROMPT_VOICE_WAVE_BARS = 24;
/** Целевая частота дискретизации для Whisper (16 кГц) */
export const PROMPT_VOICE_TARGET_SAMPLE_RATE = 16000;
/** Количество каналов аудио (моно) */
export const PROMPT_VOICE_CHANNELS = 1;
/** Байт на сэмпл для PCM16 */
export const PROMPT_VOICE_BYTES_PER_SAMPLE = 2;
/** Максимальный размер записи в байтах */
export const MAX_PROMPT_VOICE_RECORDING_BYTES = Math.floor(
  (PROMPT_VOICE_TARGET_SAMPLE_RATE * PROMPT_VOICE_CHANNELS * PROMPT_VOICE_BYTES_PER_SAMPLE * MAX_PROMPT_VOICE_RECORDING_MS) / 1000,
);

/** Допустимые размеры модели Whisper для настройки */
export type WhisperModelSize = 'tiny' | 'base' | 'small';

/** UI statuses where recorder updates are stale after OK was already pressed. */
export type PromptVoiceBusyUiStatus = 'preparing-model' | 'processing' | 'correcting';

/** Recorder statuses that can arrive late from already buffered recording events. */
export type PromptVoiceRecorderUiStatus = 'recording' | 'paused';

/** Маппинг размера модели на ONNX-оптимизированный ID для HuggingFace Hub */
export const WHISPER_MODEL_MAP: Record<WhisperModelSize, string> = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
} as const;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const softClip = (value: number, drive: number): number => Math.tanh(value * drive) / Math.tanh(drive);

const readPcm16Sample = (bytes: ArrayLike<number>, byteOffset: number): number => {
  const low = bytes[byteOffset] ?? 0;
  const high = bytes[byteOffset + 1] ?? 0;
  let value = (high << 8) | low;
  if (value >= 0x8000) {
    value -= 0x10000;
  }
  return value / 32768;
};

const mapAmplitudeToWaveLevel = (peak: number, rms: number): number => {
  const weighted = Math.max(rms * 4.6, peak * 2.4);
  return clamp(Math.pow(clamp(weighted, 0, 1), 0.58), 0.04, 1);
};

export const appendRecognizedPromptText = (existing: string, recognized: string): string => {
  const nextChunk = recognized.trim();
  if (!nextChunk) {
    return existing;
  }

  if (!existing.trim()) {
    return nextChunk;
  }

  const separator = existing.endsWith('\n')
    ? ''
    : '\n';

  return `${existing}${separator}${nextChunk}`;
};

export const shouldIgnoreStalePromptVoiceRecorderState = (
  currentStatus: string,
  incomingStatus: string,
): boolean => {
  const isBusy = currentStatus === 'preparing-model' || currentStatus === 'processing' || currentStatus === 'correcting';
  const isRecorderState = incomingStatus === 'recording' || incomingStatus === 'paused';
  return isBusy && isRecorderState;
};

export const formatPromptVoiceDuration = (valueMs: number): string => {
  const safeMs = Math.max(0, Math.floor(valueMs));
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

export const createIdleWaveLevels = (barCount: number = DEFAULT_PROMPT_VOICE_WAVE_BARS): number[] => (
  Array.from({ length: barCount }, (_, index) => {
    const pattern = [0.12, 0.18, 0.28, 0.42, 0.58, 0.74, 0.58, 0.42, 0.28, 0.18];
    return pattern[index % pattern.length];
  })
);

export const createSilentWaveLevels = (barCount: number = DEFAULT_PROMPT_VOICE_WAVE_BARS): number[] => (
  Array.from({ length: barCount }, () => 0.006)
);

export const createWaveLevelsFromScalar = (
  inputLevel: number,
  barCount: number = DEFAULT_PROMPT_VOICE_WAVE_BARS,
): number[] => {
  const safeLevel = clamp(Number.isFinite(inputLevel) ? inputLevel : 0, 0, 1);
  const center = (barCount - 1) / 2;

  return Array.from({ length: barCount }, (_, index) => {
    const distance = Math.abs(index - center) / Math.max(1, center);
    const envelope = 1 - Math.min(1, distance * 0.92);
    const ripple = 0.78 + (Math.abs(Math.sin((index / Math.max(1, barCount - 1)) * Math.PI * 3.5)) * 0.26);
    const level = 0.1 + (safeLevel * envelope * ripple);
    return clamp(level, 0.06, 1);
  });
};

export const createWaveLevelsFromPcm16 = (
  bytes: ArrayLike<number>,
  barCount: number = DEFAULT_PROMPT_VOICE_WAVE_BARS,
): number[] => {
  const sampleCount = Math.floor((bytes.length || 0) / 2);
  if (sampleCount <= 0) {
    return createIdleWaveLevels(barCount);
  }

  const samplesPerBar = Math.max(1, Math.floor(sampleCount / barCount));
  return Array.from({ length: barCount }, (_, barIndex) => {
    const startSample = Math.min(sampleCount - 1, barIndex * samplesPerBar);
    const endSample = barIndex === barCount - 1
      ? sampleCount
      : Math.min(sampleCount, startSample + samplesPerBar);

    let peak = 0;
    let sumSquares = 0;
    let segmentSamples = 0;

    for (let sampleIndex = startSample; sampleIndex < endSample; sampleIndex += 1) {
      const sample = readPcm16Sample(bytes, sampleIndex * 2);
      const absolute = Math.abs(sample);
      peak = Math.max(peak, absolute);
      sumSquares += sample * sample;
      segmentSamples += 1;
    }

    if (segmentSamples === 0) {
      return 0.04;
    }

    const rms = Math.sqrt(sumSquares / segmentSamples);
    return mapAmplitudeToWaveLevel(peak, rms);
  });
};

export const blendPromptVoiceWaveLevels = (
  previous: number[],
  next: number[],
  barCount: number = DEFAULT_PROMPT_VOICE_WAVE_BARS,
): number[] => (
  Array.from({ length: barCount }, (_, index) => {
    const previousValue = previous[index] ?? 0;
    const nextValue = next[index] ?? 0;
    const mix = nextValue >= previousValue ? 0.84 : 0.46;
    return clamp(previousValue + ((nextValue - previousValue) * mix), 0.04, 1);
  })
);

export const preparePromptVoiceSamplesForTranscription = (samples: Float32Array): Float32Array => {
  if (!samples.length) {
    return samples;
  }

  let mean = 0;
  for (let index = 0; index < samples.length; index += 1) {
    mean += samples[index];
  }
  mean /= samples.length;

  const centered = new Float32Array(samples.length);
  let peak = 0;
  let sumSquares = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] - mean;
    centered[index] = value;
    const absolute = Math.abs(value);
    peak = Math.max(peak, absolute);
    sumSquares += value * value;
  }

  if (peak < 1e-4) {
    return centered;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  const activityThreshold = clamp(Math.max(rms * 0.75, peak * 0.12), 0.003, 0.03);
  let activeSumSquares = 0;
  let activeCount = 0;

  for (let index = 0; index < centered.length; index += 1) {
    const absolute = Math.abs(centered[index]);
    if (absolute < activityThreshold) {
      continue;
    }

    activeSumSquares += centered[index] * centered[index];
    activeCount += 1;
  }

  const activeRms = activeCount > 0 ? Math.sqrt(activeSumSquares / activeCount) : rms;
  const peakGain = 0.96 / peak;
  const isVeryQuiet = activeRms < 0.035 && peak < 0.08;
  const isQuiet = activeRms < 0.07 && peak < 0.16;
  const rmsTarget = isVeryQuiet ? 0.34 : (isQuiet ? 0.28 : 0.22);
  const activeTarget = isVeryQuiet ? 0.52 : (isQuiet ? 0.42 : 0.34);
  const maxGain = isVeryQuiet ? 22 : (isQuiet ? 16 : 10);
  const rmsGain = rms > 1e-5 ? rmsTarget / rms : peakGain;
  const activeGain = activeRms > 1e-5 ? activeTarget / activeRms : rmsGain;
  const gain = clamp(Math.min(peakGain, Math.max(rmsGain, activeGain)), 0.85, maxGain);
  const noiseFloor = clamp(activityThreshold * 0.52, 0.0018, 0.012);

  const normalized = new Float32Array(centered.length);
  let normalizedMean = 0;
  for (let index = 0; index < centered.length; index += 1) {
    const value = centered[index];
    const absolute = Math.abs(value);
    let gate = 1;

    if (absolute <= noiseFloor) {
      gate = 0.16;
    } else if (absolute < activityThreshold) {
      gate = 0.16 + (((absolute - noiseFloor) / Math.max(1e-5, activityThreshold - noiseFloor)) * 0.84);
    }

    const drive = isQuiet ? 1.42 : 1.6;
    const nextValue = clamp(softClip(value * gain * gate, drive), -1, 1);
    normalized[index] = nextValue;
    normalizedMean += nextValue;
  }

  normalizedMean /= normalized.length;
  if (Math.abs(normalizedMean) > 1e-5) {
    for (let index = 0; index < normalized.length; index += 1) {
      normalized[index] = clamp(normalized[index] - normalizedMean, -1, 1);
    }
  }

  return normalized;
};
