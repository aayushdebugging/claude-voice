/**
 * Shared type definitions for claude-voice.
 *
 * These types form the contract between modules. Keeping them centralized and
 * free of runtime imports lets any module depend on the shapes without creating
 * import cycles.
 */

export type SttProviderName = 'groq' | 'openai' | 'whispercpp';

export type TtsProviderName = 'elevenlabs' | 'sarvam' | 'kokoro';

/** Claude model aliases accepted by the Claude CLI. */
export type ModelAlias = 'opus' | 'sonnet' | 'fable' | (string & {});

/**
 * Persisted user configuration. Mirrors the JSON stored at
 * `~/.claude-voice/config.json`.
 */
export interface VoiceConfig {
  /** Active speech-to-text provider. */
  stt: SttProviderName;
  /** Active text-to-speech provider. */
  tts: TtsProviderName;
  /** Human-friendly voice name (mapped to a provider voice id). */
  voice: string;
  /** Claude model alias forwarded to the Claude CLI. */
  model: ModelAlias;
  /** When true, the user must hold a key to talk instead of continuous mode. */
  pushToTalk: boolean;
  /** When true, Claude's responses are spoken aloud. */
  autoSpeak: boolean;
  /**
   * When true, speak the reply sentence-by-sentence as Claude generates it
   * (low latency), provided the audio backend can stream. When false, speak the
   * whole reply once it completes (batch).
   */
  streamSpeech: boolean;
  /**
   * When true, chunk speech at *clause* boundaries (commas, dashes, colons) for
   * the lowest first-word latency. Off by default: replies are chunked at
   * *sentence* boundaries so the TTS engine handles internal punctuation with
   * its own natural prosody. Clause-splitting makes engines like Kokoro pad each
   * fragment with ~180ms of trailing silence — an audible stop at every comma or
   * dash — so it trades quality for latency.
   */
  fastSpeech: boolean;
  /**
   * System prompt appended to Claude (via `--append-system-prompt`) that steers
   * replies to be voice-friendly — spoken like an explanation, not a document.
   * Empty string disables it.
   */
  voicePrompt: string;
  /** Input language hint passed to the STT provider (ISO-639-1) or `auto`. */
  language: string;
  /**
   * Speech rate multiplier for spoken responses (1 = natural). Mapped to each
   * provider's own control (Sarvam `pace`, OpenAI/Kokoro `speed`). Clamped to a
   * safe range at synthesis time.
   */
  speechRate: number;
  /** Silence duration (ms) that ends an utterance in continuous mode. */
  silenceTimeoutMs: number;
  /**
   * Minimum average amplitude counted as speech (the noise-floor "floor").
   * Lower = more sensitive (picks up quieter mics), higher = ignores more
   * background noise. Actual detection adapts upward from measured ambient.
   */
  micSensitivity: number;
  /** Recording sample rate in Hz. */
  sampleRate: number;
  /** Optional name/index of the recording device. */
  device?: string;
  /**
   * Working directory the Claude CLI runs in. Defaults to the directory you
   * launched claude-voice from, so Claude is aware of the project you're working
   * in. Set this to point Claude at a different project directory instead.
   */
  workdir?: string;
  /** Provider-specific overrides. */
  providers: ProviderConfig;
}

/** Provider-specific configuration blocks. */
export interface ProviderConfig {
  groq: {
    model: string;
    baseUrl: string;
  };
  openai: {
    model: string;
    baseUrl: string;
  };
  /** Local whisper.cpp server (its own /inference API). No API key needed. */
  whispercpp: {
    baseUrl: string;
    /** ggml model the server should have loaded (informational / setup). */
    model: string;
  };
  /** Local Kokoro server (OpenAI-compatible /v1/audio/speech). No API key needed. */
  kokoro: {
    baseUrl: string;
    model: string;
    voice: string;
  };
  elevenlabs: {
    modelId: string;
    /** Named voice -> ElevenLabs voice id map. */
    voices: Record<string, string>;
    stability: number;
    similarityBoost: number;
  };
  sarvam: {
    model: string;
    /** Sarvam speaker name (e.g. anushka, abhilash, vidya). */
    speaker: string;
    /** Target language code, e.g. `en-IN`, `hi-IN`. */
    targetLanguageCode: string;
    /** Output PCM sample rate (8000 | 16000 | 22050 | 24000). */
    sampleRate: number;
    pace: number;
    pitch: number;
    loudness: number;
    baseUrl: string;
  };
}

/** Result returned by a speech-to-text provider. */
export interface TranscriptionResult {
  /** Recognized text (trimmed). */
  text: string;
  /** Detected/assumed language, when the provider reports one. */
  language?: string;
  /** Wall-clock latency of the request in milliseconds. */
  latencyMs: number;
}

/** Options for a transcription request. */
export interface TranscriptionOptions {
  /** Encoded audio buffer (WAV by default; any Whisper-supported format). */
  audio: Buffer;
  /** Upload filename; its extension tells the API the format (e.g. `audio.webm`). */
  filename?: string;
  /** Language hint (ISO-639-1) or `auto`. */
  language?: string;
  /** Optional prompt to bias recognition. */
  prompt?: string;
}

/** Contract every speech-to-text provider implements. */
export interface SttProvider {
  readonly name: string;
  /** Transcribe a WAV audio buffer to text. */
  transcribe(options: TranscriptionOptions): Promise<TranscriptionResult>;
  /** Verify credentials / connectivity. Used by `doctor`. */
  healthCheck(): Promise<HealthResult>;
}

/** Options for a synthesis request. */
export interface SynthesisOptions {
  text: string;
  /** Named voice to use (overrides config default). */
  voice?: string;
  /**
   * Speech rate multiplier (1 = natural). Providers map it to their own control
   * and clamp it to their supported range.
   */
  speed?: number;
  /**
   * Output language hint (ISO-639-1 short code like `hi`, or a full code like
   * `hi-IN`). Providers map/ignore it as appropriate; `auto`/unset keeps the
   * provider's configured default.
   */
  language?: string;
  /** Abort signal to cancel an in-flight request. */
  signal?: AbortSignal;
}

/**
 * A text-to-speech provider streams raw PCM audio chunks so playback can begin
 * before synthesis finishes.
 */
export interface TtsProvider {
  readonly name: string;
  /** Sample rate (Hz) of the PCM stream this provider produces. */
  readonly sampleRate: number;
  /** Number of channels of the PCM stream. */
  readonly channels: number;
  /** Bit depth of the PCM stream. */
  readonly bitDepth: number;
  /**
   * Synthesize speech, yielding raw PCM chunks as they arrive. Implementations
   * must respect `options.signal` and stop promptly when aborted.
   */
  synthesize(options: SynthesisOptions): AsyncIterable<Buffer>;
  /** Verify credentials / connectivity. Used by `doctor`. */
  healthCheck(): Promise<HealthResult>;
}

/** Format of a PCM audio stream. */
export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

/** Outcome of a single diagnostic check. */
export interface HealthResult {
  ok: boolean;
  /** Short human-readable status. */
  message: string;
  /** Optional remediation hint shown when `ok` is false. */
  hint?: string;
}

/** A named diagnostic check for the `doctor` command. */
export interface DiagnosticCheck {
  name: string;
  run(): Promise<HealthResult>;
}

/** A parsed, speakable sentence emitted by the sentence parser. */
export interface Sentence {
  /** The sentence text including terminal punctuation. */
  text: string;
  /** Monotonic index within the current response. */
  index: number;
}

/** Options controlling how Claude is invoked. */
export interface ClaudeOptions {
  model?: ModelAlias;
  /** Extra CLI args appended verbatim. */
  extraArgs?: string[];
  /** Working directory for the Claude process. */
  cwd?: string;
}

/** Lifecycle status of the conversation state machine. */
export type ConversationState =
  'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error';
