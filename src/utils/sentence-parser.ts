import type { Sentence } from '../types/index.js';

/**
 * Streaming sentence segmenter.
 *
 * Claude streams text token-by-token. We want to speak whole sentences, so this
 * parser accumulates incoming chunks and emits a {@link Sentence} only once a
 * complete sentence boundary is observed. Boundaries are:
 *
 *   - terminal punctuation (`.`, `?`, `!`) followed by whitespace,
 *   - a paragraph break (a blank line / double newline),
 *   - anything left over at end-of-stream via {@link flush}.
 *
 * A terminator at the very end of the buffer is *not* emitted yet: more text
 * (or more punctuation, e.g. `...`) may still be streaming. This avoids cutting
 * a sentence off prematurely. The parser also avoids false splits inside
 * decimal numbers (`3.14`) and common abbreviations (`e.g.`, `Dr.`). Fragments
 * shorter than `minLength` are merged into the following sentence so playback
 * isn't choppy.
 */

const TERMINATORS = new Set(['.', '?', '!']);
/** Closing characters that may follow a terminator and still belong to it. */
const CLOSERS = new Set(['"', "'", ')', ']', '}', '”', '’', '»']);
/** Lowercased abbreviations (dots stripped) that should not end a sentence. */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'eg',
  'ie',
  'no',
  'vol',
  'fig',
  'approx',
  'inc',
  'ltd',
  'co',
  'dept',
]);

export interface SentenceParserOptions {
  /**
   * Minimum length (after trimming) for an emitted sentence. Shorter fragments
   * are held and merged with the following text to avoid choppy playback.
   */
  minLength?: number;
}

export class SentenceParser {
  private buffer = '';
  private index = 0;
  private readonly minLength: number;

  constructor(options: SentenceParserOptions = {}) {
    this.minLength = Math.max(1, options.minLength ?? 1);
  }

  /** Feed a chunk of streamed text; returns any newly completed sentences. */
  push(chunk: string): Sentence[] {
    this.buffer += chunk;
    const out: Sentence[] = [];
    let boundary = this.findBoundary();
    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary);
      const text = raw.trim();
      if (text.length > 0) out.push({ text, index: this.index++ });
      boundary = this.findBoundary();
    }
    return out;
  }

  /** Emit any buffered remainder as a final sentence (call at end of stream). */
  flush(): Sentence | null {
    const text = this.buffer.trim();
    this.buffer = '';
    if (text.length === 0) return null;
    return { text, index: this.index++ };
  }

  /** Reset all state for a new response. */
  reset(): void {
    this.buffer = '';
    this.index = 0;
  }

  /** Text currently buffered but not yet emitted. */
  get pending(): string {
    return this.buffer;
  }

  /**
   * Return the exclusive end index of the first complete sentence in the
   * buffer, or -1 if none is complete yet. A candidate boundary is only
   * accepted once the sentence it would produce reaches `minLength`, which is
   * how short fragments merge forward.
   */
  private findBoundary(): number {
    const buf = this.buffer;
    const paraMatch = buf.match(/\n[ \t]*\n/);
    const paraIndex = paraMatch?.index ?? -1;

    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i]!;
      if (!TERMINATORS.has(ch)) continue;
      if (this.isFalseTerminator(buf, i)) continue;

      // Consume a run of terminators ("?!", "...") then trailing closers.
      let end = i;
      while (end + 1 < buf.length && TERMINATORS.has(buf[end + 1]!)) end++;
      while (end + 1 < buf.length && CLOSERS.has(buf[end + 1]!)) end++;

      const next = buf[end + 1];
      if (next === undefined) break; // terminator at tail — wait for more input
      if (/\s/.test(next)) {
        // Prefer an earlier paragraph break if one precedes this terminator.
        if (paraIndex !== -1 && paraIndex < i) break;
        const candidate = end + 1;
        if (buf.slice(0, candidate).trim().length >= this.minLength) return candidate;
        // Too short: skip this boundary and keep scanning to merge forward.
        i = end;
      }
    }

    if (paraIndex !== -1) {
      const candidate = paraIndex + 1;
      if (buf.slice(0, candidate).trim().length >= this.minLength) return candidate;
    }
    return -1;
  }

  /** True when a `.` at index `i` is a decimal point or part of an abbreviation. */
  private isFalseTerminator(buf: string, i: number): boolean {
    if (buf[i] !== '.') return false;

    // Decimal number: digit before and after (e.g. "3.14").
    const prev = buf[i - 1];
    const next = buf[i + 1];
    if (prev && next && /\d/.test(prev) && /\d/.test(next)) return true;

    // Abbreviation: grab the preceding run of letters/dots so multi-dot forms
    // like "e.g." and "i.e." are recognized, then compare with dots stripped.
    let start = i - 1;
    while (start >= 0 && /[A-Za-z.]/.test(buf[start]!)) start--;
    const word = buf
      .slice(start + 1, i)
      .replace(/\./g, '')
      .toLowerCase();
    return word.length > 0 && ABBREVIATIONS.has(word);
  }
}
