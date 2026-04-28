export {
  MAX_PROMPT_VOICE_RECORDING_MS,
  DEFAULT_PROMPT_VOICE_WAVE_BARS,
  PROMPT_VOICE_TARGET_SAMPLE_RATE,
  appendRecognizedPromptText,
  formatPromptVoiceDuration,
  createIdleWaveLevels,
  createSilentWaveLevels,
  createWaveLevelsFromScalar,
  shouldIgnoreStalePromptVoiceRecorderState,
} from '../../../shared/promptVoice';
