export { SentenceParser } from './sentence-parser.js';
export type { SentenceParserOptions } from './sentence-parser.js';
export { toSpeakable, chunkForSpeech } from './speakable.js';
export type { SpeakableResult } from './speakable.js';
export {
  encodeWav,
  extractPcmFromWav,
  isLikelySilent,
  averageAmplitude,
  peakAmplitude,
  normalizePcm,
} from './wav.js';
export { clampSpeed, parseSpeed, SPEED_MIN, SPEED_MAX } from './rate.js';
export { downloadFile } from './download.js';
export type { DownloadOptions } from './download.js';
export { sleep, deferred, withRetry } from './async.js';
export { serverReachable } from './net.js';
export type { Deferred } from './async.js';
export { logger, setLogLevel } from './logger.js';
export type { LogLevel } from './logger.js';
export {
  VoiceError,
  DependencyError,
  CredentialError,
  ProviderError,
  ClaudeError,
  AudioError,
  describeError,
} from './errors.js';
