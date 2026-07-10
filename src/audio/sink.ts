import type { AudioFormat } from '../types/index.js';

/**
 * An audio output destination for PCM playback.
 *
 * Abstracting the sink lets the {@link SpeechQueue} be unit-tested with an
 * in-memory fake while production uses the native speaker. A "segment" is one
 * spoken sentence: `begin` -> many `write`s -> `end`.
 */
export interface AudioSink {
  /**
   * True when this sink plays audio as it is written through one persistent
   * device (so a reply can be streamed sentence-by-sentence, gaplessly). When
   * absent/false the sink is batch: each `begin`…`end` is a separate player
   * process, so streaming across sentences would reopen the device each time.
   */
  readonly streaming?: boolean;
  /** Start a new playback segment with the given PCM format. */
  begin(format: AudioFormat): Promise<void> | void;
  /** Append a PCM chunk to the current segment. */
  write(chunk: Buffer): Promise<void> | void;
  /** Finish the segment; resolves once buffered audio has drained. */
  end(): Promise<void>;
  /** Immediately stop and discard buffered audio (used for interruption). */
  stop(): Promise<void> | void;
}
