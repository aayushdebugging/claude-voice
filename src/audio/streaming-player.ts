import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

import { AudioError } from '../utils/errors.js';
import { deferred } from '../utils/async.js';
import type { AudioFormat } from '../types/index.js';
import type { AudioSink } from './sink.js';

/** A player that reads raw PCM from stdin and plays it as a continuous stream. */
interface StreamCmd {
  cmd: string;
  args(format: AudioFormat): string[];
}

function ffplayArgs(f: AudioFormat): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'quiet',
    '-nodisp',
    '-autoexit',
    '-f',
    's16le',
    '-ar',
    String(f.sampleRate),
    '-ch_layout',
    f.channels === 1 ? 'mono' : 'stereo',
    '-i',
    'pipe:0',
  ];
}

function aplayArgs(f: AudioFormat): string[] {
  return ['-q', '-f', 'S16_LE', '-c', String(f.channels), '-r', String(f.sampleRate)];
}

function onPath(name: string): boolean {
  if (name.includes('/')) {
    try {
      accessSync(name, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return (process.env.PATH ?? '').split(':').some((d) => {
    try {
      accessSync(join(d, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Verify a binary actually runs (guards against e.g. a broken ffplay install). */
function runsOk(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, ['-version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

let cached: StreamCmd | null | undefined;

/**
 * Resolve a player that can play a *continuous* PCM stream from stdin — one that
 * blocks and waits when the pipe is momentarily empty (so gaps between sentences
 * don't end playback). `ffplay` does this; sox `play` does NOT (it treats an
 * empty read as end-of-stream), so it's deliberately excluded here. An explicit
 * `CLAUDE_VOICE_STREAM_PLAYER` override is trusted as-is.
 */
async function resolve(): Promise<StreamCmd | null> {
  if (cached !== undefined) return cached;
  const override = process.env.CLAUDE_VOICE_STREAM_PLAYER;
  if (override) {
    cached = { cmd: override, args: ffplayArgs };
    return cached;
  }
  if (onPath('ffplay') && (await runsOk('ffplay'))) {
    cached = { cmd: 'ffplay', args: ffplayArgs };
  } else if (onPath('aplay')) {
    cached = { cmd: 'aplay', args: aplayArgs };
  } else {
    cached = null;
  }
  return cached;
}

/**
 * Streaming PCM sink: one long-lived player process for the whole reply, fed
 * incrementally over stdin. Because the audio device is opened once and each
 * sentence's PCM is appended to the same stream — and the player waits during
 * gaps rather than exiting — playback is gapless across sentences. This is what
 * makes "speak as Claude writes" seamless. {@link stop} hard-cuts by killing it.
 */
export class StreamingPlayer implements AudioSink {
  readonly streaming = true;
  private child: ChildProcessByStdio<Writable, null, null> | null = null;
  private ended = false;

  /** Whether a streaming-capable player is available (and actually runs). */
  static async isAvailable(): Promise<boolean> {
    return (await resolve()) !== null;
  }

  static async playerName(): Promise<string | null> {
    return (await resolve())?.cmd ?? null;
  }

  async begin(format: AudioFormat): Promise<void> {
    const player = await resolve();
    if (!player) {
      throw new AudioError(
        'No streaming audio player found (ffplay/aplay).',
        'Install ffmpeg (`brew install ffmpeg`) for gapless streaming, or use `--no-stream`.',
      );
    }
    this.ended = false;
    let child: ChildProcessByStdio<Writable, null, null>;
    try {
      child = spawn(player.cmd, player.args(format), { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (err) {
      throw new AudioError(`Failed to start audio player: ${(err as Error).message}`);
    }
    // A broken pipe (killed mid-reply) must never crash the app.
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    this.child = child;
  }

  write(chunk: Buffer): Promise<void> {
    const child = this.child;
    if (!child || this.ended || chunk.length === 0) return Promise.resolve();
    // Resolve when the chunk is flushed (respects backpressure, pacing to
    // playback). The callback also fires with an error if the stream is
    // destroyed (barge-in kill), so this never hangs.
    return new Promise<void>((resolve) => {
      const ok = child.stdin.write(chunk, () => resolve());
      if (ok) resolve();
    });
  }

  async end(): Promise<void> {
    const child = this.child;
    if (!child || this.ended) return;
    this.ended = true;
    const done = deferred<void>();
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      done.resolve();
    };
    child.once('close', finish);
    child.once('error', finish);
    child.stdin.end();
    await done.promise;
    if (this.child === child) this.child = null;
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.ended = true;
    this.child = null;
    try {
      child.removeAllListeners();
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}
