import { describe, it, expect, afterEach } from 'vitest';

import { updateCommand } from '../src/commands/update.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('updateCommand', () => {
  it('checks the scoped package (not the unscoped one that belongs to someone else)', async () => {
    let queried = '';
    globalThis.fetch = (async (url: string) => {
      queried = String(url);
      return new Response(JSON.stringify({ 'dist-tags': { latest: '9.9.9' } }), { status: 200 });
    }) as unknown as typeof fetch;

    const code = await updateCommand({ check: true });

    expect(code).toBe(0);
    expect(queried).toContain('aayushdebugging');
    expect(queried).toContain('claude-voice');
    // Must NOT hit the bare, unrelated `claude-voice` package.
    expect(queried).not.toMatch(/registry\.npmjs\.org\/claude-voice(\/|$)/);
  });
});
