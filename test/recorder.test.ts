import { describe, it, expect } from 'vitest';

import { MicRecorder } from '../src/audio/recorder.js';

describe('MicRecorder.programAvailable', () => {
  it('returns true for a binary that is on PATH (node)', async () => {
    expect(await MicRecorder.programAvailable('node')).toBe(true);
  });

  it('returns false for a missing binary — so we never spawn it and crash', async () => {
    expect(await MicRecorder.programAvailable('cv-definitely-not-a-real-binary-xyz')).toBe(false);
  });
});
