import type { MicRecorder, ManualRecording } from '../audio/index.js';
import type { ClaudeClient } from '../claude/index.js';
import type { SpeechQueue } from '../tts/index.js';
import type { VoiceBus } from '../events/index.js';
import { VoiceEvent } from '../events/index.js';
import { SentenceParser } from '../utils/sentence-parser.js';
import { toSpeakable } from '../utils/speakable.js';
import { encodeWav, peakAmplitude, normalizePcm } from '../utils/wav.js';
import { AudioError, describeError } from '../utils/errors.js';
import type { ConversationState, SttProvider, VoiceConfig } from '../types/index.js';

export interface ConversationDeps {
  config: VoiceConfig;
  bus: VoiceBus;
  recorder: MicRecorder;
  stt: SttProvider;
  claude: ClaudeClient;
  speech: SpeechQueue;
}

/**
 * The conversation state machine and pipeline orchestrator.
 *
 * It owns the loop:
 *   microphone → STT → Claude CLI → sentence parser → terminal + TTS.
 *
 * Everything is wired through the event bus so the UI, logger, and plugins can
 * observe without the core depending on them. It supports continuous
 * (silence-endpointed) and push-to-talk capture, and full barge-in: an
 * {@link interrupt} tears down in-flight generation and playback so the user
 * can cut in at any time.
 */
export class Conversation {
  private readonly deps: ConversationDeps;
  private readonly parser: SentenceParser;

  private state: ConversationState = 'idle';
  private stopped = false;
  /** Controls the processing phase (transcribe → think → speak). */
  private turn: AbortController | null = null;
  /** Controls the current listening capture (continuous mode). */
  private capture: AbortController | null = null;
  /** Set when the user manually ends a capture (process it, don't discard). */
  private forceProcess = false;
  private manual: ManualRecording | null = null;
  private loopDone: Promise<void> | null = null;
  private warnedNoAudio = false;
  /** When true, the continuous listen loop waits instead of capturing. */
  private paused = false;
  private resumeWaiters: Array<() => void> = [];

  constructor(deps: ConversationDeps) {
    this.deps = deps;
    // Default: chunk at *sentence* boundaries and let the TTS engine handle
    // internal punctuation (commas, dashes, colons) with its own natural
    // prosody. Clause-level splitting makes engines like Kokoro pad every
    // fragment with ~180ms of trailing silence — an audible stop at each comma
    // or dash. `fastSpeech` opts into clause chunking for the lowest first-word
    // latency, accepting choppier speech.
    this.parser = new SentenceParser(
      deps.config.fastSpeech
        ? { minLength: 2, softBoundaries: true, softMinLength: 18, maxLength: 180 }
        : { minLength: 2, softBoundaries: false, maxLength: 400 },
    );
  }

  get currentState(): ConversationState {
    return this.state;
  }

  /** Toggle spoken responses at runtime. Muting also stops current playback. */
  setAutoSpeak(on: boolean): void {
    this.deps.config.autoSpeak = on;
    if (!on) void this.deps.speech.interrupt();
  }

  /** Change the TTS voice at runtime (applies to the next spoken sentence). */
  setVoice(name: string): void {
    this.deps.config.voice = name;
    this.deps.speech.setVoice(name);
  }

  /** Change the Claude model at runtime (applies to the next turn). */
  setModel(name: string): void {
    this.deps.config.model = name;
    this.deps.claude.setModel(name);
  }

  /** Change the speech rate at runtime (applies to the next spoken reply). */
  setSpeed(rate: number): void {
    this.deps.config.speechRate = rate;
    this.deps.speech.setSpeed(rate);
  }

  /**
   * Toggle streaming speech at runtime. When on (and the sink supports it),
   * replies are spoken as they're generated; when off, the whole reply is
   * spoken once it completes. Applies from the next reply.
   */
  setStreamSpeech(on: boolean): void {
    this.deps.config.streamSpeech = on;
  }

  /**
   * Change the language at runtime. Affects both transcription (STT reads
   * `config.language` each turn) and the spoken reply (voice/language mapping in
   * the TTS provider). Applies from the next turn.
   */
  setLanguage(code: string): void {
    this.deps.config.language = code;
    this.deps.speech.setLanguage(code);
  }

  /**
   * The single press-to-talk key. Behavior depends on the authoritative current
   * state (not UI state), so rapid presses never desync:
   *   - idle → start a listen (records until you stop speaking),
   *   - listening → stop now and transcribe,
   *   - thinking/speaking → interrupt.
   */
  async onTalkKey(): Promise<void> {
    switch (this.state) {
      case 'idle':
        await this.listenOnce();
        break;
      case 'listening':
        this.forceProcess = true;
        this.capture?.abort();
        break;
      case 'thinking':
      case 'speaking':
        await this.interrupt();
        break;
      default:
        break;
    }
  }

  /**
   * Capture one utterance (ending on silence, or when the user taps to send)
   * and run it through the pipeline. Used by press-to-talk.
   */
  async listenOnce(): Promise<void> {
    if (this.state !== 'idle') return;
    const capture = new AbortController();
    this.capture = capture;
    this.forceProcess = false;
    this.setState('listening');
    let audio: Buffer;
    try {
      audio = await this.deps.recorder.captureUntilSilence({
        sampleRate: this.deps.config.sampleRate,
        device: this.deps.config.device,
        silenceTimeoutMs: this.deps.config.silenceTimeoutMs,
        silenceThreshold: this.deps.config.micSensitivity,
        signal: capture.signal,
        onSpeechStart: () => this.deps.bus.emit(VoiceEvent.UserStartedSpeaking),
        onLevel: (level) => this.deps.bus.emit(VoiceEvent.AudioLevel, { level }),
        onNoAudio: () => this.warnNoAudio(),
      });
    } catch (err) {
      this.reportError('recorder', err);
      this.setState('idle');
      return;
    }
    this.capture = null;
    if (capture.signal.aborted && !this.forceProcess) {
      this.setState('idle');
      return;
    }
    this.deps.bus.emit(VoiceEvent.UserStoppedSpeaking, { durationMs: 0 });
    this.turn = new AbortController();
    await this.handleUtterance(audio, this.turn.signal);
  }

  /**
   * Start the conversation. In continuous mode this runs an auto-listen loop
   * until {@link stop} is called. In push-to-talk mode it stays idle and waits
   * for {@link pushToTalkStart}/{@link pushToTalkStop} from the UI layer.
   */
  async start(): Promise<void> {
    this.stopped = false;
    if (this.deps.config.pushToTalk) {
      this.setState('idle');
      return;
    }
    this.loopDone = this.runContinuous();
    await this.loopDone;
  }

  /** Stop the conversation and tear down any in-flight work. */
  async stop(reason = 'user'): Promise<void> {
    this.stopped = true;
    this.resume(); // release the loop if parked in the pause gate
    this.capture?.abort();
    this.turn?.abort();
    this.deps.claude.terminate();
    await this.deps.speech.interrupt().catch(() => {});
    if (this.manual) {
      await this.manual.stop().catch(() => Buffer.alloc(0));
      this.manual = null;
    }
    this.setState('idle');
    this.deps.bus.emit(VoiceEvent.ConversationEnded, { reason });
    if (this.loopDone) await this.loopDone.catch(() => {});
  }

  /**
   * Barge-in: abort the current turn (generation + playback) so the user can
   * take over. In continuous mode the listen loop resumes automatically.
   */
  async interrupt(): Promise<void> {
    if (this.state !== 'thinking' && this.state !== 'speaking') return;
    this.turn?.abort();
    this.deps.claude.terminate();
    await this.deps.speech.interrupt().catch(() => {});
  }

  /**
   * The primary control key (SPACE). Context-sensitive:
   *  - while listening → stop capturing now and process what was said,
   *  - while thinking/speaking → barge-in / interrupt.
   * This gives the user manual endpointing so they never get stuck waiting on
   * silence detection.
   */
  async handleSpace(): Promise<void> {
    if (this.state === 'listening') {
      this.forceProcess = true;
      this.capture?.abort();
      return;
    }
    await this.interrupt();
  }

  // ---- Push-to-talk control (driven by the UI layer) --------------------

  /** Begin capturing a push-to-talk utterance. */
  async pushToTalkStart(): Promise<void> {
    if (this.state === 'listening' || this.manual) return;
    // Cutting in while Claude is talking counts as an interruption.
    await this.interrupt();
    this.setState('listening');
    this.deps.bus.emit(VoiceEvent.UserStartedSpeaking);
    try {
      this.manual = await this.deps.recorder.startManual({
        sampleRate: this.deps.config.sampleRate,
        device: this.deps.config.device,
      });
    } catch (err) {
      this.reportError('recorder', err);
      this.setState('idle');
    }
  }

  /** Finish the push-to-talk utterance and process it. */
  async pushToTalkStop(): Promise<void> {
    const manual = this.manual;
    if (!manual) return;
    this.manual = null;
    this.deps.bus.emit(VoiceEvent.UserStoppedSpeaking, { durationMs: 0 });
    let audio: Buffer;
    try {
      audio = await manual.stop();
    } catch (err) {
      this.reportError('recorder', err);
      this.setState('idle');
      return;
    }
    this.turn = new AbortController();
    await this.handleUtterance(audio, this.turn.signal);
  }

  // ---- Continuous loop --------------------------------------------------

  /** Release the listen loop if it's parked in the pause gate. */
  private resume(): void {
    this.paused = false;
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const w of waiters) w();
  }

  /** Park the loop while paused (e.g. during a typed turn); resolves on resume. */
  private waitWhilePaused(): Promise<void> {
    if (!this.paused || this.stopped) return Promise.resolve();
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  private async runContinuous(): Promise<void> {
    while (!this.stopped) {
      await this.waitWhilePaused();
      if (this.stopped) break;
      const capture = new AbortController();
      this.capture = capture;
      this.forceProcess = false;
      this.setState('listening');
      let audio: Buffer;
      try {
        audio = await this.deps.recorder.captureUntilSilence({
          sampleRate: this.deps.config.sampleRate,
          device: this.deps.config.device,
          silenceTimeoutMs: this.deps.config.silenceTimeoutMs,
          signal: capture.signal,
          onSpeechStart: () => this.deps.bus.emit(VoiceEvent.UserStartedSpeaking),
          onNoAudio: () => this.warnNoAudio(),
        });
      } catch (err) {
        this.reportError('recorder', err);
        // Avoid a hot error loop if the mic is unavailable.
        if (this.stopped) break;
        await this.stop('recorder-error');
        break;
      }
      this.capture = null;
      if (this.stopped) break;
      // Aborted without a manual "process now" means an interrupt → discard.
      if (capture.signal.aborted && !this.forceProcess) continue;
      this.deps.bus.emit(VoiceEvent.UserStoppedSpeaking, { durationMs: 0 });
      // Fresh signal for the processing phase so a manual end-of-capture (which
      // aborted the capture signal) doesn't cancel transcription/generation.
      this.turn = new AbortController();
      await this.handleUtterance(audio, this.turn.signal);
    }
  }

  // ---- Shared turn handling ---------------------------------------------

  private async handleUtterance(audio: Buffer, signal?: AbortSignal): Promise<void> {
    // No real signal at all → permission/hardware. (Capture only returns audio
    // once speech crossed the adaptive threshold, so anything non-empty here is
    // genuine speech — even if quiet; normalization + Whisper handle the rest,
    // and a truly unintelligible clip falls through to the "didn't catch" path.)
    if (audio.length === 0 || peakAmplitude(audio) < 60) {
      this.warnNoAudio();
      this.setState('idle');
      return;
    }

    // 1. Transcribe.
    this.setState('transcribing');
    let text: string;
    try {
      // Boost quiet captures so Whisper gets a usable signal level.
      const wav = encodeWav(normalizePcm(audio), {
        sampleRate: this.deps.config.sampleRate,
        channels: 1,
        bitDepth: 16,
      });
      const result = await this.deps.stt.transcribe({
        audio: wav,
        language: this.deps.config.language,
      });
      this.deps.bus.emit(VoiceEvent.SpeechRecognized, result);
      text = result.text;
    } catch (err) {
      this.reportError('stt', err);
      this.setState('idle');
      return;
    }
    if (!text) {
      // Audio had sound but nothing was recognized — let the user know.
      this.deps.bus.emit(VoiceEvent.Error, {
        scope: 'stt',
        error: new Error("Didn't catch that — try speaking a bit louder or closer to the mic."),
      });
      this.setState('idle');
      return;
    }
    if (signal?.aborted) {
      this.setState('idle');
      return;
    }

    // 2. Hand the recognized text to Claude and speak the reply.
    await this.think(text, signal);
  }

  /**
   * Send a typed message to Claude directly (bypassing speech-to-text). Used by
   * the UI's type-to-chat mode. Interrupts anything in flight and, in
   * continuous mode, pauses the listen loop for the duration of the turn.
   */
  async sendText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.paused = true;
    this.capture?.abort();
    await this.interrupt();
    this.turn = new AbortController();
    try {
      await this.think(trimmed, this.turn.signal);
    } finally {
      this.resume();
    }
  }

  /**
   * Run the Claude → TTS pipeline for a piece of text.
   *
   * When streaming is on and the sink supports it, each completed sentence is
   * spoken *as Claude generates it* (see {@link SpeechQueue.beginStream}), so
   * audio starts after the first sentence rather than after the whole reply.
   * Otherwise it falls back to speaking the full reply as one clip once
   * generation finishes ({@link SpeechQueue.speak}) — robust everywhere. Either
   * way, sentence events fire during generation for the UI/plugins.
   */
  private async think(text: string, signal?: AbortSignal): Promise<void> {
    this.setState('thinking');
    this.parser.reset();
    let reply = '';

    // Stream speech only when enabled AND the sink can play as it's written.
    // (At this point nothing is speaking, so beginStream sets up synchronously
    // and never drops the first pushed sentence.)
    const useStream =
      this.deps.config.autoSpeak && this.deps.config.streamSpeech && this.deps.speech.canStream;
    let streamOpen = false;

    const speakSentence = (raw: string): void => {
      const { text: spoken } = toSpeakable(raw);
      if (!spoken) return; // skip code-only / symbol-only sentences
      if (!streamOpen) {
        streamOpen = true;
        void this.deps.speech.beginStream();
      }
      this.deps.speech.push(spoken);
    };

    try {
      const result = await this.deps.claude.ask(text, {
        signal,
        onToken: (token) => {
          for (const sentence of this.parser.push(token)) {
            this.deps.bus.emit(VoiceEvent.SentenceCompleted, sentence);
            if (useStream) speakSentence(sentence.text);
          }
        },
      });
      const tail = this.parser.flush();
      if (tail) {
        this.deps.bus.emit(VoiceEvent.SentenceCompleted, tail);
        if (useStream) speakSentence(tail.text);
      }
      reply = result.text;
      if (result.interrupted || signal?.aborted) {
        if (streamOpen) await this.deps.speech.interrupt().catch(() => {});
        this.setState('idle');
        return;
      }
    } catch (err) {
      if (streamOpen) await this.deps.speech.interrupt().catch(() => {});
      this.reportError('claude', err);
      this.setState('idle');
      return;
    }

    if (streamOpen) {
      // Speech has been playing while Claude wrote; wait for it to drain.
      await this.deps.speech.endStream();
      this.setState('idle');
      return;
    }

    // Batch fallback: streaming off/unavailable, or nothing streamable was said
    // (e.g. a code-only reply). Speak the whole reply as one clip.
    if (this.deps.config.autoSpeak && reply.trim() && !signal?.aborted) {
      const { text: speakable, empty } = toSpeakable(reply);
      // Code-only replies strip to nothing — say a short note instead of silence.
      const spoken = empty ? 'Done — the response is on your screen.' : speakable;
      this.setState('speaking');
      await this.deps.speech.speak(spoken);
    }
    this.setState('idle');
  }

  private setState(next: ConversationState): void {
    if (this.state === next) return;
    const from = this.state;
    this.state = next;
    this.deps.bus.emit(VoiceEvent.StateChanged, { from, to: next });
  }

  private reportError(scope: string, err: unknown): void {
    const error = err instanceof Error ? err : new Error(describeError(err));
    this.deps.bus.emit(VoiceEvent.Error, { scope, error });
  }

  /** Warn (once) that the microphone is producing no audio — usually permission. */
  private warnNoAudio(): void {
    if (this.warnedNoAudio) return;
    this.warnedNoAudio = true;
    const hint =
      process.platform === 'darwin'
        ? 'Grant microphone access to your terminal: System Settings → Privacy & Security → Microphone, then restart it.'
        : 'Check that your microphone is connected and your terminal has permission to use it.';
    this.deps.bus.emit(VoiceEvent.Error, {
      scope: 'microphone',
      error: new AudioError('No microphone audio detected (the mic is producing silence).', hint),
    });
  }
}
