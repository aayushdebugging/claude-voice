import type { AudioSink } from '../audio/sink.js';
import type { VoiceBus } from '../events/index.js';
import { VoiceEvent } from '../events/index.js';
import { chunkForSpeech } from '../utils/speakable.js';
import { deferred, type Deferred } from '../utils/async.js';
import type { AudioFormat, SynthesisOptions, TtsProvider } from '../types/index.js';

export interface SpeechQueueOptions {
  provider: TtsProvider;
  sink: AudioSink;
  /** Named voice to use; falls back to the provider default. */
  voice?: string;
  /** Speech rate multiplier (1 = natural). */
  speed?: number;
  /** Output language hint passed to the provider. */
  language?: string;
  /** Optional event bus for lifecycle notifications. */
  bus?: VoiceBus;
  /** Max characters per synthesis request (provider limit). */
  maxChunkChars?: number;
}

/**
 * Text-to-speech playback, in two modes:
 *
 * - **Batch** ({@link speak}): synthesize a whole reply, then play it as one
 *   continuous clip. Used when streaming is disabled.
 * - **Streaming** ({@link beginStream}/{@link push}/{@link endStream}): speak a
 *   reply *as it is generated*. Sentences are pushed as Claude writes them; a
 *   synthesis loop batches whatever text is available and renders it **ahead**
 *   of playback, and a playback loop plays those clips back-to-back. So audio
 *   starts right after the first sentence, and because synthesis runs ahead the
 *   only seam between clips is the player's (~0.1s) warm restart — never a
 *   cut-off. Each clip is a complete file played by the robust file player, so
 *   there's no fragile stdin-streaming to break mid-reply.
 *
 * {@link interrupt} tears down either mode: it aborts synthesis and hard-cuts
 * playback.
 */
export class SpeechQueue {
  private readonly provider: TtsProvider;
  private readonly sink: AudioSink;
  private voice?: string;
  private speed?: number;
  private language?: string;
  private readonly bus?: VoiceBus;
  private readonly maxChunkChars: number;

  private controller: AbortController | null = null;
  private speaking = false;

  // ---- streaming state ----
  private streaming = false;
  private pendingText: string[] = []; // sentences awaiting synthesis
  private readyClips: Buffer[] = []; // synthesized PCM awaiting playback
  private streamDone = false; // no more text will be pushed
  private synthDone = false; // synthesis loop has finished
  private startedEmitted = false;
  private synthLoop: Promise<void> | null = null;
  private playLoop: Promise<void> | null = null;
  private wakeText: Deferred<void> = deferred<void>();
  private wakeClip: Deferred<void> = deferred<void>();

  constructor(options: SpeechQueueOptions) {
    this.provider = options.provider;
    this.sink = options.sink;
    this.voice = options.voice;
    this.speed = options.speed;
    this.language = options.language;
    this.bus = options.bus;
    this.maxChunkChars = options.maxChunkChars ?? 1400;
  }

  /** True while audio is being synthesized or played. */
  get isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * True when streaming playback is supported. Streaming is layered on top of
   * ordinary clip playback, so it works with any real sink.
   */
  get canStream(): boolean {
    return true;
  }

  private get format(): AudioFormat {
    return {
      sampleRate: this.provider.sampleRate,
      channels: this.provider.channels,
      bitDepth: this.provider.bitDepth,
    };
  }

  private synthOptions(text: string, signal: AbortSignal): SynthesisOptions {
    return { text, voice: this.voice, speed: this.speed, language: this.language, signal };
  }

  /** Change the voice used for subsequent speech. */
  setVoice(voice?: string): void {
    this.voice = voice;
  }

  /** Change the speech rate used for subsequent speech (1 = natural). */
  setSpeed(speed?: number): void {
    this.speed = speed;
  }

  /** Change the output language used for subsequent speech. */
  setLanguage(language?: string): void {
    this.language = language;
  }

  /** Synthesize `text` to a single concatenated PCM buffer (respects abort). */
  private async render(text: string, signal: AbortSignal): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (const chunk of chunkForSpeech(text, this.maxChunkChars)) {
      if (signal.aborted) break;
      for await (const buf of this.provider.synthesize(this.synthOptions(chunk, signal))) {
        if (signal.aborted) break;
        if (buf.length > 0) parts.push(buf);
      }
    }
    return Buffer.concat(parts);
  }

  /**
   * Synthesize `text` in full and play it as one continuous clip. Resolves when
   * playback finishes or is interrupted. Only one `speak` runs at a time.
   */
  async speak(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    // A new speak supersedes any in-flight one.
    if (this.speaking) await this.interrupt();

    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    this.speaking = true;
    const marker = { text: clean, index: 0 };

    try {
      const pcm = await this.render(clean, signal);
      if (pcm.length === 0 || signal.aborted) return;

      this.bus?.emit(VoiceEvent.SpeechStarted, marker);
      await this.sink.begin(this.format);
      await this.sink.write(pcm);
      if (!signal.aborted) {
        await this.sink.end();
        this.bus?.emit(VoiceEvent.SpeechFinished, marker);
      }
    } catch (err) {
      if (!signal.aborted) this.bus?.emit(VoiceEvent.Error, { scope: 'tts', error: err as Error });
    } finally {
      this.speaking = false;
      if (this.controller === controller) this.controller = null;
    }
  }

  // ---- Streaming API ------------------------------------------------------

  /**
   * Open a streaming session. Push sentences with {@link push} as they're
   * generated; they're synthesized ahead and played back-to-back. Call
   * {@link endStream} when the reply is complete. Supersedes in-flight speech.
   */
  async beginStream(): Promise<void> {
    if (this.speaking) await this.interrupt();
    const controller = new AbortController();
    this.controller = controller;
    // Initialize + start both loops synchronously so a push()/endStream() that
    // races this never sees a half-open stream or missing loops.
    this.speaking = true;
    this.streaming = true;
    this.pendingText = [];
    this.readyClips = [];
    this.streamDone = false;
    this.synthDone = false;
    this.startedEmitted = false;
    this.wakeText = deferred<void>();
    this.wakeClip = deferred<void>();
    this.synthLoop = this.runSynthLoop(controller.signal);
    this.playLoop = this.runPlayLoop(controller.signal);
  }

  /** Queue a sentence to be spoken in the current stream (no-op if not streaming). */
  push(text: string): void {
    if (!this.streaming) return;
    const clean = text.trim();
    if (!clean) return;
    this.pendingText.push(clean);
    this.wake('text');
  }

  /** Signal end-of-reply and wait for all queued audio to finish playing. */
  async endStream(): Promise<void> {
    if (!this.streaming) return;
    const controller = this.controller;
    this.streamDone = true;
    this.wake('text');
    await this.synthLoop?.catch(() => {});
    await this.playLoop?.catch(() => {});
    this.synthLoop = null;
    this.playLoop = null;
    const aborted = controller?.signal.aborted ?? true;
    if (!aborted && this.startedEmitted) {
      this.bus?.emit(VoiceEvent.SpeechFinished, { text: '', index: 0 });
    }
    this.streaming = false;
    this.speaking = false;
    if (this.controller === controller) this.controller = null;
  }

  /** Resolve one of the wake promises and arm a fresh one (condition-variable). */
  private wake(which: 'text' | 'clip'): void {
    if (which === 'text') {
      const w = this.wakeText;
      this.wakeText = deferred<void>();
      w.resolve();
    } else {
      const w = this.wakeClip;
      this.wakeClip = deferred<void>();
      w.resolve();
    }
  }

  /**
   * Synthesis loop: greedily batch all currently-pending sentences into one
   * clip and render it ahead of playback, so the player rarely waits. Batching
   * also keeps the number of clips (and thus inter-clip seams) low.
   */
  private async runSynthLoop(signal: AbortSignal): Promise<void> {
    try {
      for (;;) {
        if (signal.aborted) return;
        const wake = this.wakeText;
        if (this.pendingText.length === 0) {
          if (this.streamDone) return;
          await wake.promise;
          continue;
        }
        const batch = this.pendingText.splice(0, this.pendingText.length).join(' ');
        const pcm = await this.render(batch, signal);
        if (signal.aborted) return;
        if (pcm.length > 0) {
          this.readyClips.push(pcm);
          this.wake('clip');
        }
      }
    } catch (err) {
      if (!signal.aborted) this.bus?.emit(VoiceEvent.Error, { scope: 'tts', error: err as Error });
    } finally {
      this.synthDone = true;
      this.wake('clip'); // let the play loop notice there's no more coming
    }
  }

  /**
   * Playback loop: play ready clips back-to-back through the sink.
   *
   * A **persistent** sink (`sink.streaming`) is opened once and each clip is
   * written into the same continuous stream — gapless, and the player waits
   * during gaps instead of reopening the device. A **batch** sink plays each
   * clip as its own `begin`…`end` (a separate process), which has a small seam
   * between clips but works without a streaming-capable player.
   */
  private async runPlayLoop(signal: AbortSignal): Promise<void> {
    const marker = { text: '', index: 0 };
    const persistent = this.sink.streaming === true;
    // Build a *small* lead of audio before playback starts — just enough to
    // avoid an immediate underrun, but small so speech starts fast (clause
    // chunks refill it quickly and the persistent stream rides out jitter).
    // ~0.25s; short replies skip it entirely (synthDone fires first).
    const prebufferBytes = Math.round(
      0.25 * this.provider.sampleRate * this.provider.channels * (this.provider.bitDepth / 8),
    );
    const readyBytes = (): number => this.readyClips.reduce((sum, b) => sum + b.length, 0);
    let opened = false;
    try {
      for (;;) {
        if (signal.aborted) return;
        const wake = this.wakeClip;
        // Prebuffer only until the first clip plays; afterwards keep flowing.
        if (!this.startedEmitted && !this.synthDone && readyBytes() < prebufferBytes) {
          await wake.promise;
          continue;
        }
        const clip = this.readyClips.shift();
        if (!clip) {
          if (this.synthDone) return;
          await wake.promise;
          continue;
        }
        try {
          if (!this.startedEmitted) {
            this.startedEmitted = true;
            this.bus?.emit(VoiceEvent.SpeechStarted, marker);
          }
          if (persistent) {
            if (!opened) {
              await this.sink.begin(this.format);
              opened = true;
              if (signal.aborted) return;
            }
            await this.sink.write(clip);
          } else {
            await this.sink.begin(this.format);
            if (signal.aborted) return;
            await this.sink.write(clip);
            if (signal.aborted) return;
            await this.sink.end();
          }
        } catch (err) {
          // One clip failing must not tear down the rest of the reply.
          if (!signal.aborted) {
            this.bus?.emit(VoiceEvent.Error, { scope: 'tts', error: err as Error });
          }
        }
      }
    } finally {
      // Close the single persistent stream once, letting it drain (unless we
      // were interrupted, in which case stop() already hard-cut it).
      if (persistent && opened && !signal.aborted) {
        await this.sink.end().catch(() => {});
      }
    }
  }

  /** Abort in-flight synthesis and cut playback immediately (batch or stream). */
  async interrupt(): Promise<void> {
    const wasActive = this.speaking;
    this.controller?.abort();
    // Hard-cut audio first so barge-in is instant, then unwind the loops.
    await this.sink.stop();
    if (this.streaming) {
      this.streaming = false;
      this.streamDone = true;
      this.synthDone = true;
      this.pendingText = [];
      this.readyClips = [];
      this.wake('text');
      this.wake('clip');
      const synth = this.synthLoop;
      const play = this.playLoop;
      this.synthLoop = null;
      this.playLoop = null;
      await synth?.catch(() => {});
      await play?.catch(() => {});
    }
    this.speaking = false;
    if (wasActive) this.bus?.emit(VoiceEvent.Interrupted, { reason: 'user' });
  }
}
