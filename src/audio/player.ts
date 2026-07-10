import { AudioError } from '../utils/errors.js';
import { deferred } from '../utils/async.js';
import type { AudioFormat } from '../types/index.js';
import type { AudioSink } from './sink.js';

/** Minimal shape of the optional `speaker` native module. */
interface SpeakerModule {
  new (opts: { channels: number; bitDepth: number; sampleRate: number }): SpeakerInstance;
}
interface SpeakerInstance {
  write(chunk: Buffer, cb?: () => void): boolean;
  end(cb?: () => void): void;
  once(event: string, cb: () => void): void;
  removeAllListeners(): void;
  destroy(): void;
  on(event: string, cb: (err?: Error) => void): void;
}

let cachedSpeaker: SpeakerModule | null | undefined;

/**
 * Lazily load the native `speaker` module. It is an optional dependency because
 * it needs a native build toolchain; when absent we degrade gracefully instead
 * of failing at import time.
 */
async function loadSpeaker(): Promise<SpeakerModule | null> {
  if (cachedSpeaker !== undefined) return cachedSpeaker;
  try {
    const mod = (await import('speaker')) as unknown as { default: SpeakerModule };
    cachedSpeaker = mod.default;
  } catch {
    cachedSpeaker = null;
  }
  return cachedSpeaker;
}

/**
 * PCM audio player backed by the native `speaker` module.
 *
 * Each spoken sentence uses a fresh Speaker instance so that {@link stop} can
 * hard-cut playback (destroying the stream) for instant interruption without
 * leaking audio from the previous sentence.
 */
export class SpeakerPlayer implements AudioSink {
  private speaker: SpeakerInstance | null = null;
  private Speaker: SpeakerModule | null = null;
  private ended = false;

  /** Whether native playback is available on this system. */
  static async isAvailable(): Promise<boolean> {
    return (await loadSpeaker()) !== null;
  }

  async begin(format: AudioFormat): Promise<void> {
    this.Speaker ??= await loadSpeaker();
    if (!this.Speaker) {
      throw new AudioError(
        'Audio playback unavailable: the "speaker" module is not installed.',
        'Reinstall claude-voice or run `claude-voice doctor` for setup help.',
      );
    }
    this.ended = false;
    this.speaker = new this.Speaker({
      channels: format.channels,
      bitDepth: format.bitDepth,
      sampleRate: format.sampleRate,
    });
    // Swallow errors from an interrupted/destroyed stream.
    this.speaker.on('error', () => {});
  }

  write(chunk: Buffer): Promise<void> {
    const speaker = this.speaker;
    if (!speaker || this.ended) return Promise.resolve();
    return new Promise<void>((resolve) => {
      // Respect backpressure: resolve once this chunk is accepted.
      const ok = speaker.write(chunk, () => resolve());
      if (ok) resolve();
    });
  }

  async end(): Promise<void> {
    const speaker = this.speaker;
    if (!speaker || this.ended) return;
    this.ended = true;
    const done = deferred<void>();
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      done.resolve();
    };
    speaker.once('close', finish);
    speaker.once('finish', finish);
    speaker.end(finish);
    await done.promise;
    this.speaker = null;
  }

  stop(): void {
    const speaker = this.speaker;
    if (!speaker) return;
    this.ended = true;
    this.speaker = null;
    try {
      speaker.removeAllListeners();
      speaker.destroy();
    } catch {
      // ignore — the stream may already be torn down
    }
  }
}
