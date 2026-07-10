import { describe, it, expect } from 'vitest';

import { parseStreamJsonLine } from '../src/claude/stream-parser.js';

describe('parseStreamJsonLine', () => {
  it('parses the init event and captures the session id', () => {
    const event = parseStreamJsonLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc', model: 'opus' }),
    );
    expect(event).toEqual({ kind: 'init', sessionId: 'abc', model: 'opus' });
  });

  it('parses a text delta from a partial stream event', () => {
    const event = parseStreamJsonLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
      }),
    );
    expect(event).toEqual({ kind: 'delta', text: 'Hi' });
  });

  it('parses a full assistant message', () => {
    const event = parseStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'there' },
          ],
        },
      }),
    );
    expect(event).toEqual({ kind: 'assistant', text: 'Hello there' });
  });

  it('ignores non-text content blocks in assistant messages', () => {
    const event = parseStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'x' },
            { type: 'text', text: 'kept' },
          ],
        },
      }),
    );
    expect(event).toEqual({ kind: 'assistant', text: 'kept' });
  });

  it('parses a successful result with cost and session id', () => {
    const event = parseStreamJsonLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Final answer.',
        session_id: 'xyz',
        total_cost_usd: 0.0123,
        duration_ms: 900,
      }),
    );
    expect(event).toMatchObject({
      kind: 'result',
      text: 'Final answer.',
      sessionId: 'xyz',
      costUsd: 0.0123,
      isError: false,
    });
  });

  it('flags error results', () => {
    const event = parseStreamJsonLine(
      JSON.stringify({ type: 'result', subtype: 'error', result: 'boom' }),
    );
    expect(event).toMatchObject({ kind: 'result', isError: true });
  });

  it('returns null for blank lines and non-JSON', () => {
    expect(parseStreamJsonLine('')).toBeNull();
    expect(parseStreamJsonLine('   ')).toBeNull();
    expect(parseStreamJsonLine('not json at all')).toBeNull();
  });

  it('classifies unknown event types as other', () => {
    const event = parseStreamJsonLine(JSON.stringify({ type: 'user', session_id: 's' }));
    expect(event).toEqual({ kind: 'other', sessionId: 's' });
  });
});
