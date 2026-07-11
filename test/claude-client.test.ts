import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ClaudeClient, type ClaudeClientOptions } from '../src/claude/client.js';
import { createBus, VoiceEvent } from '../src/events/index.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

// The client keeps a persistent CLI process alive across turns, so track every
// client we spawn and dispose them after each test to avoid leaking processes.
const clients: ClaudeClient[] = [];
function makeClient(opts: Partial<ClaudeClientOptions> = {}) {
  const client = new ClaudeClient({ bin: FIXTURE, ...opts });
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients) client.dispose();
  clients.length = 0;
});

describe('ClaudeClient (integration with a fake CLI)', () => {
  it('streams tokens and resolves with the final text', async () => {
    const tokens: string[] = [];
    const result = await makeClient().ask('say hi', {
      onToken: (t) => tokens.push(t),
    });
    expect(tokens.join('')).toBe('Hello there, friend.');
    expect(result.text).toBe('Hello there, friend.');
    expect(result.interrupted).toBe(false);
    expect(result.costUsd).toBeCloseTo(0.001);
  });

  it('captures the session id for continuity', async () => {
    const client = makeClient();
    await client.ask('first');
    expect(client.session).toBe('test-session');
  });

  it('emits lifecycle events on the bus', async () => {
    const bus = createBus();
    const seen: string[] = [];
    bus.on(VoiceEvent.ClaudeStarted, () => seen.push('started'));
    bus.on(VoiceEvent.ClaudeToken, () => seen.push('token'));
    bus.on(VoiceEvent.ClaudeFinished, () => seen.push('finished'));

    await makeClient({ bus }).ask('go');

    expect(seen[0]).toBe('started');
    expect(seen).toContain('token');
    expect(seen[seen.length - 1]).toBe('finished');
  });

  it('rejects with a typed error when the CLI exits non-zero', async () => {
    await expect(makeClient().ask('please FAIL')).rejects.toThrow(/exited with code 2/);
  });

  it('disables all tools (safe mode) when tools is an empty array', async () => {
    const client = makeClient({ tools: [] });
    const result = await client.ask('ARGS');
    // `--tools ""` is the CLI's documented "disable all tools".
    expect(result.text).toContain('--tools');
  });

  it('does not pass --tools when unrestricted (local sessions keep tools)', async () => {
    const result = await makeClient().ask('ARGS');
    expect(result.text).not.toContain('--tools');
  });

  it('restricts to a named tool list when provided', async () => {
    const result = await makeClient({ tools: ['Read', 'Glob'] }).ask('ARGS');
    expect(result.text).toContain('--tools Read,Glob');
  });

  it('appends a voice system prompt when set', async () => {
    const result = await makeClient({ appendSystemPrompt: 'BE BRIEF' }).ask('ARGS');
    expect(result.text).toContain('--append-system-prompt');
    expect(result.text).toContain('BE BRIEF');
  });

  it('interrupts a hanging generation via the abort signal', async () => {
    const controller = new AbortController();
    const client = makeClient();
    const promise = client.ask('HANG please', { signal: controller.signal });
    // Give it enough time to spawn and emit the partial token, even under load.
    await new Promise((r) => setTimeout(r, 500));
    controller.abort();
    const result = await promise;
    expect(result.interrupted).toBe(true);
    expect(result.text).toBe('partial');
  });
});
