import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { StreamingPlayer } from '../src/audio/streaming-player.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-play.mjs');
const FORMAT = { sampleRate: 24000, channels: 1, bitDepth: 16 };

// Point the streaming player at our fake stdin player (trusted as-is, no
// version check) before detection is cached.
beforeAll(() => {
  process.env.CLAUDE_VOICE_STREAM_PLAYER = FIXTURE;
});

describe('StreamingPlayer (integration with a fake stdin player)', () => {
  it('reports itself as a streaming sink', () => {
    expect(new StreamingPlayer().streaming).toBe(true);
  });

  it('detects availability from the configured binary', async () => {
    expect(await StreamingPlayer.isAvailable()).toBe(true);
  });

  it('streams many writes through one persistent process', async () => {
    const player = new StreamingPlayer();
    await player.begin(FORMAT);
    // Several sentence-sized writes into the SAME process (no per-write spawn).
    for (let i = 0; i < 5; i++) await player.write(Buffer.alloc(2048, i + 1));
    await expect(player.end()).resolves.toBeUndefined();
  });

  it('stop() hard-cuts without throwing and later writes are no-ops', async () => {
    const player = new StreamingPlayer();
    await player.begin(FORMAT);
    await player.write(Buffer.alloc(1024, 1));
    expect(() => player.stop()).not.toThrow();
    await expect(player.write(Buffer.alloc(16))).resolves.toBeUndefined();
  });

  it('write before begin is a no-op', async () => {
    const player = new StreamingPlayer();
    await expect(player.write(Buffer.alloc(16))).resolves.toBeUndefined();
  });
});
