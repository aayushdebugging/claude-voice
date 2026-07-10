import { MicRecorder, SpeakerPlayer } from '../audio/index.js';
import { ClaudeClient } from '../claude/index.js';
import { createSttProvider } from '../stt/index.js';
import { createTtsProvider, SpeechQueue } from '../tts/index.js';
import { createBus, type VoiceBus } from '../events/index.js';
import type { AudioSink } from '../audio/index.js';
import type { VoiceConfig } from '../types/index.js';
import { Conversation, type ConversationDeps } from './conversation.js';

export interface SessionOptions {
  config: VoiceConfig;
  /** Reuse an existing bus (e.g. to attach the UI before start). */
  bus?: VoiceBus;
  /** Override the audio sink (used in tests). */
  sink?: AudioSink;
}

export interface Session {
  conversation: Conversation;
  bus: VoiceBus;
  deps: ConversationDeps;
}

/**
 * Build a fully-wired conversation session from configuration. This is the
 * single composition root: it resolves the configured providers, constructs the
 * audio + Claude layers, and hands back a ready {@link Conversation}.
 */
export function createSession(options: SessionOptions): Session {
  const { config } = options;
  const bus = options.bus ?? createBus();

  const stt = createSttProvider(config);
  const tts = createTtsProvider(config);
  const recorder = new MicRecorder();
  const sink = options.sink ?? new SpeakerPlayer();
  const speech = new SpeechQueue({
    provider: tts,
    sink,
    voice: config.voice,
    speed: config.speechRate,
    language: config.language,
    bus,
  });
  const claude = new ClaudeClient({
    model: config.model,
    bus,
    appendSystemPrompt: config.voicePrompt || undefined,
  });

  const deps: ConversationDeps = { config, bus, recorder, stt, claude, speech };
  const conversation = new Conversation(deps);

  return { conversation, bus, deps };
}
