import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRecognizedPromptText, formatPromptVoiceDuration } from '../src/webview/editor/voice/promptVoiceUtils.js';
import {
  DEFAULT_PROMPT_VOICE_WAVE_BARS,
  blendPromptVoiceWaveLevels,
  createWaveLevelsFromPcm16,
  preparePromptVoiceSamplesForTranscription,
  shouldIgnoreStalePromptVoiceRecorderState,
} from '../src/shared/promptVoice.js';

const encodePcm16 = (samples: number[]): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 2);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    const signed = clamped < 0
      ? Math.round(clamped * 32768)
      : Math.round(clamped * 32767);
    const encoded = signed < 0 ? signed + 0x10000 : signed;
    bytes[index * 2] = encoded & 0xff;
    bytes[(index * 2) + 1] = (encoded >> 8) & 0xff;
  });
  return bytes;
};

test('appendRecognizedPromptText appends to empty prompt without extra newline', () => {
  assert.equal(appendRecognizedPromptText('', '  Привет мир  '), 'Привет мир');
});

test('appendRecognizedPromptText adds a single newline when prompt already has content', () => {
  assert.equal(
    appendRecognizedPromptText('Первая строка', 'Вторая строка'),
    'Первая строка\nВторая строка',
  );
});

test('appendRecognizedPromptText respects existing trailing newline', () => {
  assert.equal(
    appendRecognizedPromptText('Первая строка\n', 'Вторая строка'),
    'Первая строка\nВторая строка',
  );
});

test('formatPromptVoiceDuration formats minutes and seconds', () => {
  assert.equal(formatPromptVoiceDuration(0), '00:00');
  assert.equal(formatPromptVoiceDuration(61000), '01:01');
});

test('shouldIgnoreStalePromptVoiceRecorderState blocks recording after OK processing starts', () => {
  assert.equal(shouldIgnoreStalePromptVoiceRecorderState('processing', 'recording'), true);
  assert.equal(shouldIgnoreStalePromptVoiceRecorderState('processing', 'paused'), true);
  assert.equal(shouldIgnoreStalePromptVoiceRecorderState('recording', 'recording'), false);
  assert.equal(shouldIgnoreStalePromptVoiceRecorderState('hidden', 'recording'), false);
  assert.equal(shouldIgnoreStalePromptVoiceRecorderState('processing', 'error'), false);
});

test('createWaveLevelsFromPcm16 reacts to louder speech with a stronger wave', () => {
  const quiet = createWaveLevelsFromPcm16(encodePcm16(
    Array.from({ length: 480 }, (_, index) => Math.sin(index / 10) * 0.03),
  ));
  const loud = createWaveLevelsFromPcm16(encodePcm16(
    Array.from({ length: 480 }, (_, index) => Math.sin(index / 10) * 0.42),
  ));

  assert.equal(quiet.length, DEFAULT_PROMPT_VOICE_WAVE_BARS);
  assert.equal(loud.length, DEFAULT_PROMPT_VOICE_WAVE_BARS);
  assert.ok(Math.max(...loud) > Math.max(...quiet) + 0.25);
});

test('blendPromptVoiceWaveLevels uses faster attack than decay', () => {
  const previous = Array.from({ length: DEFAULT_PROMPT_VOICE_WAVE_BARS }, () => 0.12);
  const next = Array.from({ length: DEFAULT_PROMPT_VOICE_WAVE_BARS }, () => 0.88);

  const attacked = blendPromptVoiceWaveLevels(previous, next);
  const decayed = blendPromptVoiceWaveLevels(next, previous);

  assert.ok(attacked[0] > previous[0] && attacked[0] < next[0]);
  assert.ok(decayed[0] < next[0] && decayed[0] > previous[0]);
  assert.ok((attacked[0] - previous[0]) > (next[0] - decayed[0]));
});

test('preparePromptVoiceSamplesForTranscription removes DC offset and boosts quiet speech', () => {
  const source = new Float32Array(
    Array.from({ length: 320 }, (_, index) => 0.18 + (Math.sin(index / 6) * 0.03)),
  );

  const prepared = preparePromptVoiceSamplesForTranscription(source);
  const mean = prepared.reduce((sum, value) => sum + value, 0) / prepared.length;
  const inputPeak = source.reduce((max, value) => Math.max(max, Math.abs(value - 0.18)), 0);
  const outputPeak = prepared.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

  assert.ok(Math.abs(mean) < 0.001);
  assert.ok(outputPeak > inputPeak * 4);
});

test('preparePromptVoiceSamplesForTranscription boosts quiet speech more than surrounding silence', () => {
  const source = new Float32Array([
    ...Array.from({ length: 180 }, () => 0),
    ...Array.from({ length: 260 }, (_, index) => Math.sin(index / 5) * 0.018),
    ...Array.from({ length: 180 }, () => 0),
  ]);

  const prepared = preparePromptVoiceSamplesForTranscription(source);
  const speechPeak = prepared
    .slice(180, 440)
    .reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const silencePeak = Math.max(
    prepared.slice(0, 180).reduce((max, value) => Math.max(max, Math.abs(value)), 0),
    prepared.slice(440).reduce((max, value) => Math.max(max, Math.abs(value)), 0),
  );

  assert.ok(speechPeak > 0.18);
  assert.ok(speechPeak > silencePeak * 8);
});

test('preparePromptVoiceSamplesForTranscription gives extra gain to very quiet speech', () => {
  const source = new Float32Array([
    ...Array.from({ length: 120 }, () => 0),
    ...Array.from({ length: 360 }, (_, index) => Math.sin(index / 7) * 0.0065),
    ...Array.from({ length: 120 }, () => 0),
  ]);

  const prepared = preparePromptVoiceSamplesForTranscription(source);
  const speechPeak = prepared
    .slice(120, 480)
    .reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const silencePeak = Math.max(
    prepared.slice(0, 120).reduce((max, value) => Math.max(max, Math.abs(value)), 0),
    prepared.slice(480).reduce((max, value) => Math.max(max, Math.abs(value)), 0),
  );

  assert.ok(speechPeak > 0.13);
  assert.ok(speechPeak > silencePeak * 8);
});
