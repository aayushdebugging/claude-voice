/**
 * Public API for programmatic use of claude-voice.
 *
 * Import the pieces you need to embed voice conversations in your own tools, or
 * to build custom providers and plugins. The CLI (`claude-voice`) is a thin
 * layer over exactly these primitives.
 *
 * @example
 * ```ts
 * import { createSession, loadConfig } from 'claude-voice';
 * const config = await loadConfig();
 * const { conversation, bus } = createSession({ config });
 * bus.on('ClaudeToken', ({ text }) => process.stdout.write(text));
 * await conversation.start();
 * ```
 */

// Types
export type * from './types/index.js';

// Configuration
export {
  loadConfig,
  saveConfig,
  updateConfig,
  configExists,
  deepMerge,
  DEFAULT_CONFIG,
  CONFIG_DIR,
  CONFIG_PATH,
  getApiKey,
  requireApiKey,
  ENV_KEYS,
} from './config/index.js';
export type { PartialConfig, CredentialProvider } from './config/index.js';

// Events
export { TypedEventBus, VoiceEvent, createBus } from './events/index.js';
export type { VoiceBus, VoiceEventMap, VoiceEventName, Handler } from './events/index.js';

// Core
export { Conversation, createSession } from './core/index.js';
export type { ConversationDeps, Session, SessionOptions } from './core/index.js';

// Providers
export { createSttProvider, OpenAICompatibleStt, GroqStt, OpenAIStt } from './stt/index.js';
export { createTtsProvider, ElevenLabsTts, SarvamTts, SpeechQueue } from './tts/index.js';
export type { SpeechQueueOptions } from './tts/index.js';

// Audio
export {
  MicRecorder,
  SpeakerPlayer,
  FilePlayer,
  StreamingPlayer,
  resolveAudioSink,
} from './audio/index.js';
export type {
  AudioSink,
  RecordOptions,
  CaptureOptions,
  ManualRecording,
  SinkBackend,
  ResolvedSink,
  ResolveSinkOptions,
} from './audio/index.js';

// Claude
export { ClaudeClient, parseStreamJsonLine } from './claude/index.js';
export type {
  ClaudeClientOptions,
  AskOptions,
  AskResult,
  ClaudeStreamEvent,
} from './claude/index.js';

// Plugins
export { PluginManager, transcriptPlugin } from './plugins/index.js';
export type { Plugin, PluginContext } from './plugins/index.js';

// Utilities
export {
  SentenceParser,
  toSpeakable,
  encodeWav,
  isLikelySilent,
  VoiceError,
  DependencyError,
  CredentialError,
  ProviderError,
  ClaudeError,
  AudioError,
  describeError,
} from './utils/index.js';
export type { SentenceParserOptions, SpeakableResult } from './utils/index.js';
export { getVersion } from './utils/version.js';
