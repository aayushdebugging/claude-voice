/**
 * Event contracts for the claude-voice event bus.
 *
 * Modules communicate through these events rather than calling each other
 * directly. This keeps the audio, STT, Claude, and TTS layers decoupled and
 * makes the conversation loop observable (and testable) end to end.
 */

import type { ConversationState, Sentence, TranscriptionResult } from '../types/index.js';

/** The canonical set of event names emitted across the system. */
export const VoiceEvent = {
  /** The microphone detected the user starting to speak. */
  UserStartedSpeaking: 'UserStartedSpeaking',
  /** The user stopped speaking; an utterance is ready to transcribe. */
  UserStoppedSpeaking: 'UserStoppedSpeaking',
  /** Live microphone input level (0..1) while capturing, for a UI meter. */
  AudioLevel: 'AudioLevel',
  /** Speech was transcribed to text. */
  SpeechRecognized: 'SpeechRecognized',
  /** A Claude turn has started. */
  ClaudeStarted: 'ClaudeStarted',
  /** A token/text delta streamed from Claude. */
  ClaudeToken: 'ClaudeToken',
  /** Claude finished producing a response. */
  ClaudeFinished: 'ClaudeFinished',
  /** A complete sentence was parsed from the stream. */
  SentenceCompleted: 'SentenceCompleted',
  /** TTS began playing a sentence. */
  SpeechStarted: 'SpeechStarted',
  /** TTS finished playing a sentence. */
  SpeechFinished: 'SpeechFinished',
  /** The user interrupted playback/generation. */
  Interrupted: 'Interrupted',
  /** The conversation state machine changed state. */
  StateChanged: 'StateChanged',
  /** A recoverable error occurred somewhere in the pipeline. */
  Error: 'Error',
  /** The conversation loop ended. */
  ConversationEnded: 'ConversationEnded',
} as const;

export type VoiceEventName = (typeof VoiceEvent)[keyof typeof VoiceEvent];

/** Strongly-typed payloads for each event. */
export interface VoiceEventMap {
  [VoiceEvent.UserStartedSpeaking]: void;
  [VoiceEvent.UserStoppedSpeaking]: { durationMs: number };
  [VoiceEvent.AudioLevel]: { level: number };
  [VoiceEvent.SpeechRecognized]: TranscriptionResult;
  [VoiceEvent.ClaudeStarted]: { prompt: string };
  [VoiceEvent.ClaudeToken]: { text: string };
  [VoiceEvent.ClaudeFinished]: { text: string; elapsedMs: number };
  [VoiceEvent.SentenceCompleted]: Sentence;
  [VoiceEvent.SpeechStarted]: Sentence;
  [VoiceEvent.SpeechFinished]: Sentence;
  [VoiceEvent.Interrupted]: { reason: 'user' | 'signal' };
  [VoiceEvent.StateChanged]: { from: ConversationState; to: ConversationState };
  [VoiceEvent.Error]: { scope: string; error: Error };
  [VoiceEvent.ConversationEnded]: { reason: string };
}
