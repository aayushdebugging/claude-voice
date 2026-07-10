import { logger } from '../utils/logger.js';
import { FilePlayer } from './file-player.js';
import { StreamingPlayer } from './streaming-player.js';
import { SpeakerPlayer } from './player.js';
import type { AudioSink } from './sink.js';

/** Human-readable name of the playback backend a sink uses. */
export type SinkBackend = 'streaming' | 'file' | 'speaker' | 'none';

export interface ResolvedSink {
  sink: AudioSink;
  backend: SinkBackend;
  /** Name of the underlying player, when known (e.g. "afplay"). */
  player?: string;
}

export interface ResolveSinkOptions {
  /**
   * Prefer a persistent streaming player (ffplay/aplay fed over stdin) so a
   * reply can be spoken gaplessly sentence-by-sentence. Falls back to batch file
   * playback when no such player is present.
   */
  preferStreaming?: boolean;
}

/**
 * Pick the best available audio output.
 *
 * With `preferStreaming`, prefers a {@link StreamingPlayer} (a persistent
 * ffplay/aplay reading stdin) so speech can stream gaplessly as Claude writes.
 * Otherwise — or when no streaming player exists — uses batch file playback
 * (afplay/ffplay/play/aplay), a single native process per clip, which needs no
 * native build. Falls back to the native `speaker` module, then a no-op sink
 * whose `begin()` surfaces a helpful error. (sox `play` is not used for
 * streaming: it truncates on any feed gap.)
 */
export async function resolveAudioSink(options: ResolveSinkOptions = {}): Promise<ResolvedSink> {
  if (options.preferStreaming && (await StreamingPlayer.isAvailable())) {
    const player = (await StreamingPlayer.playerName()) ?? undefined;
    logger.debug(`using streaming playback via ${player}`);
    return { sink: new StreamingPlayer(), backend: 'streaming', player };
  }
  if (await FilePlayer.isAvailable()) {
    const player = FilePlayer.playerName() ?? undefined;
    logger.debug(`using file playback via ${player}`);
    return { sink: new FilePlayer(), backend: 'file', player };
  }
  if (await SpeakerPlayer.isAvailable()) {
    return { sink: new SpeakerPlayer(), backend: 'speaker' };
  }
  return { sink: new SpeakerPlayer(), backend: 'none' };
}
