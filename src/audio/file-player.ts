import { spawn, type ChildProcess } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { accessSync, constants, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AudioError } from '../utils/errors.js';
import { encodeWav } from '../utils/wav.js';
import { deferred } from '../utils/async.js';
import type { AudioFormat } from '../types/index.js';
import type { AudioSink } from './sink.js';

/** A system audio player that plays a file path (not a stdin stream). */
interface PlayerCmd {
  cmd: string;
  flags: string[];
}

let cachedPlayer: PlayerCmd | null | undefined;
let fileCounter = 0;

function hasBinary(name: string): boolean {
  if (name.includes('/')) {
    try {
      accessSync(name, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const dirs = (process.env.PATH ?? '').split(':');
  return dirs.some((d) => {
    try {
      accessSync(join(d, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Resolve a system command that plays a WAV/audio *file*. File playback via a
 * single native player is far more robust than streaming raw PCM into a
 * process's stdin — no per-chunk pipe races, no device open/close churn.
 * Order: env override → macOS `afplay` → `ffplay` → sox `play` → ALSA `aplay`.
 */
function resolvePlayer(): PlayerCmd | null {
  if (cachedPlayer !== undefined) return cachedPlayer;
  const override = process.env.CLAUDE_VOICE_PLAYER;
  const candidates: PlayerCmd[] = override
    ? [{ cmd: override, flags: [] }]
    : [
        { cmd: 'afplay', flags: [] },
        { cmd: 'ffplay', flags: ['-nodisp', '-autoexit', '-loglevel', 'quiet'] },
        { cmd: 'play', flags: ['-q'] },
        { cmd: 'aplay', flags: ['-q'] },
      ];
  cachedPlayer = candidates.find((c) => hasBinary(c.cmd)) ?? null;
  return cachedPlayer;
}

/**
 * Audio sink that buffers a segment's PCM, writes it to a temp WAV, and plays
 * the whole file with one native player process. This is the reliable path for
 * "speak the full response at once": one file, one process, gapless — nothing
 * to break between sentences. Interruption kills the single process.
 */
export class FilePlayer implements AudioSink {
  private chunks: Buffer[] = [];
  private fmt: AudioFormat | null = null;
  private child: ChildProcess | null = null;
  private tmpFile: string | null = null;

  /** Whether a file player is available on this system. */
  static isAvailable(): Promise<boolean> {
    return Promise.resolve(resolvePlayer() !== null);
  }

  /** Name of the resolved player (for diagnostics). */
  static playerName(): string | null {
    return resolvePlayer()?.cmd ?? null;
  }

  begin(format: AudioFormat): void {
    this.chunks = [];
    this.fmt = format;
  }

  write(chunk: Buffer): void {
    if (chunk.length > 0) this.chunks.push(chunk);
  }

  async end(): Promise<void> {
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    if (pcm.length === 0 || !this.fmt) return;

    const player = resolvePlayer();
    if (!player) {
      throw new AudioError(
        'No audio player found (afplay/ffplay/play/aplay).',
        'On macOS afplay is built in; on Linux install one (e.g. `sudo apt-get install alsa-utils`).',
      );
    }

    const file = join(tmpdir(), `claude-voice-${process.pid}-${fileCounter++}.wav`);
    this.tmpFile = file;
    await writeFile(file, encodeWav(pcm, this.fmt));

    const done = deferred<void>();
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      done.resolve();
    };
    let child: ChildProcess;
    try {
      child = spawn(player.cmd, [...player.flags, file], { stdio: 'ignore' });
    } catch (err) {
      await unlink(file).catch(() => {});
      this.tmpFile = null;
      throw new AudioError(`Failed to start audio player: ${(err as Error).message}`);
    }
    this.child = child;
    child.on('error', finish);
    child.on('close', finish);
    await done.promise;

    if (this.child === child) this.child = null;
    await unlink(file).catch(() => {});
    if (this.tmpFile === file) this.tmpFile = null;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.chunks = [];
    if (child) {
      // Don't removeAllListeners — end() awaits this process's 'close', which
      // the kill triggers, letting the in-flight end() resolve cleanly.
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    if (this.tmpFile) {
      try {
        unlinkSync(this.tmpFile);
      } catch {
        // best effort
      }
      this.tmpFile = null;
    }
  }
}
