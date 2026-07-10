/**
 * Parser for the Claude CLI's `--output-format stream-json` protocol.
 *
 * The CLI emits newline-delimited JSON. With `--include-partial-messages` we
 * additionally get Anthropic streaming events carrying token-level text deltas.
 * This module isolates the (somewhat fiddly) event shapes behind one typed
 * function so the client and its tests share a single source of truth.
 */

export type ClaudeStreamEvent =
  | { kind: 'init'; sessionId?: string; model?: string }
  | { kind: 'delta'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'result';
      text: string;
      sessionId?: string;
      costUsd?: number;
      durationMs?: number;
      isError: boolean;
    }
  | { kind: 'other'; sessionId?: string };

interface RawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  message?: { content?: Array<{ type?: string; text?: string }>; model?: string };
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
    content_block?: { type?: string; text?: string };
  };
}

/** Extract the concatenated text from an assistant message's content blocks. */
function textFromMessage(message: RawEvent['message']): string {
  if (!message?.content) return '';
  return message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * Parse a single line of stream-json output. Returns `null` for blank lines or
 * lines that are not valid JSON (the CLI occasionally interleaves plain text).
 */
export function parseStreamJsonLine(line: string): ClaudeStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: RawEvent;
  try {
    raw = JSON.parse(trimmed) as RawEvent;
  } catch {
    return null;
  }

  switch (raw.type) {
    case 'system':
      if (raw.subtype === 'init') {
        return { kind: 'init', sessionId: raw.session_id, model: raw.model };
      }
      return { kind: 'other', sessionId: raw.session_id };

    case 'stream_event': {
      const ev = raw.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        return { kind: 'delta', text: ev.delta.text ?? '' };
      }
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') {
        return { kind: 'delta', text: ev.content_block.text ?? '' };
      }
      return { kind: 'other', sessionId: raw.session_id };
    }

    case 'assistant':
      return { kind: 'assistant', text: textFromMessage(raw.message) };

    case 'result':
      return {
        kind: 'result',
        text: raw.result ?? '',
        sessionId: raw.session_id,
        costUsd: raw.total_cost_usd,
        durationMs: raw.duration_ms,
        isError: raw.is_error === true || raw.subtype === 'error',
      };

    default:
      return { kind: 'other', sessionId: raw.session_id };
  }
}
