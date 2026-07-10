import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deepMerge, loadConfig, saveConfig } from '../src/config/config.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

describe('deepMerge', () => {
  it('overrides scalars but preserves untouched keys', () => {
    const merged = deepMerge(DEFAULT_CONFIG, { voice: 'river', model: 'sonnet' });
    expect(merged.voice).toBe('river');
    expect(merged.model).toBe('sonnet');
    expect(merged.stt).toBe(DEFAULT_CONFIG.stt);
  });

  it('deep-merges nested provider objects', () => {
    const merged = deepMerge(DEFAULT_CONFIG, {
      providers: { groq: { model: 'whisper-large-v3' } },
    });
    expect(merged.providers.groq.model).toBe('whisper-large-v3');
    // Sibling keys survive.
    expect(merged.providers.groq.baseUrl).toBe(DEFAULT_CONFIG.providers.groq.baseUrl);
    expect(merged.providers.elevenlabs.modelId).toBe(DEFAULT_CONFIG.providers.elevenlabs.modelId);
  });

  it('ignores undefined override values', () => {
    const merged = deepMerge(DEFAULT_CONFIG, { voice: undefined });
    expect(merged.voice).toBe(DEFAULT_CONFIG.voice);
  });

  it('does not mutate the base object', () => {
    const snapshot = JSON.stringify(DEFAULT_CONFIG);
    deepMerge(DEFAULT_CONFIG, { voice: 'brian' });
    expect(JSON.stringify(DEFAULT_CONFIG)).toBe(snapshot);
  });
});

describe('config persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cv-config-'));
    process.env.CLAUDE_VOICE_HOME = join(dir, '.claude-voice');
  });

  afterEach(() => {
    delete process.env.CLAUDE_VOICE_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns defaults when no file exists', async () => {
    const config = await loadConfig();
    expect(config.stt).toBe('groq');
    expect(config.voice).toBe('aria');
  });

  it('round-trips a saved config with overrides applied', async () => {
    await saveConfig({ ...DEFAULT_CONFIG, voice: 'sarah' });
    const loaded = await loadConfig({ model: 'fable' });
    expect(loaded.voice).toBe('sarah'); // from file
    expect(loaded.model).toBe('fable'); // from override
  });
});
