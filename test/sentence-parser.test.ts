import { describe, it, expect } from 'vitest';

import { SentenceParser } from '../src/utils/sentence-parser.js';

/** Feed text one character at a time to simulate token streaming. */
function streamByChar(parser: SentenceParser, text: string): string[] {
  const out: string[] = [];
  for (const ch of text) out.push(...parser.push(ch).map((s) => s.text));
  const tail = parser.flush();
  if (tail) out.push(tail.text);
  return out;
}

describe('SentenceParser', () => {
  it('emits a sentence only once its terminator is confirmed by trailing space', () => {
    const parser = new SentenceParser();
    expect(parser.push('Hello there')).toEqual([]);
    expect(parser.push('.')).toEqual([]); // terminator at tail — not yet confirmed
    const emitted = parser.push(' Next one');
    expect(emitted.map((s) => s.text)).toEqual(['Hello there.']);
  });

  it('splits on ., ?, and !', () => {
    const parser = new SentenceParser();
    const result = streamByChar(parser, 'One. Two? Three! Four');
    expect(result).toEqual(['One.', 'Two?', 'Three!', 'Four']);
  });

  it('assigns monotonic indices', () => {
    const parser = new SentenceParser();
    const first = parser.push('A. ');
    const second = parser.push('B. ');
    expect(first[0]?.index).toBe(0);
    expect(second[0]?.index).toBe(1);
  });

  it('treats a paragraph break as a boundary even without punctuation', () => {
    const parser = new SentenceParser();
    const emitted = parser.push('A heading\n\nThe body continues');
    expect(emitted.map((s) => s.text)).toEqual(['A heading']);
  });

  it('does not split inside decimal numbers', () => {
    const parser = new SentenceParser();
    const result = streamByChar(parser, 'Pi is 3.14 exactly. Done');
    expect(result).toEqual(['Pi is 3.14 exactly.', 'Done']);
  });

  it('does not split on common abbreviations', () => {
    const parser = new SentenceParser();
    const result = streamByChar(parser, 'See e.g. the docs, Dr. Smith said. Ok');
    expect(result).toEqual(['See e.g. the docs, Dr. Smith said.', 'Ok']);
  });

  it('handles multiple terminators and closing quotes', () => {
    const parser = new SentenceParser();
    const result = streamByChar(parser, 'Really?! "Yes." And more');
    expect(result).toEqual(['Really?!', '"Yes."', 'And more']);
  });

  it('flush returns the trailing buffer', () => {
    const parser = new SentenceParser();
    parser.push('Incomplete sentence with no terminator');
    const tail = parser.flush();
    expect(tail?.text).toBe('Incomplete sentence with no terminator');
  });

  it('flush returns null when nothing is buffered', () => {
    const parser = new SentenceParser();
    parser.push('Done. ');
    expect(parser.flush()).toBeNull();
  });

  it('merges fragments shorter than minLength forward', () => {
    const parser = new SentenceParser({ minLength: 5 });
    // "Hi." is shorter than 5 chars, so it should merge with the next chunk.
    const emitted = parser.push('Hi. This is longer. ');
    expect(emitted.map((s) => s.text)).toEqual(['Hi. This is longer.']);
  });

  it('produces identical output whether streamed or pushed whole', () => {
    const text = 'First sentence. Second one? Third! Trailing bit';
    const streamed = streamByChar(new SentenceParser(), text);

    const whole = new SentenceParser();
    const bulk = whole.push(text).map((s) => s.text);
    const tail = whole.flush();
    if (tail) bulk.push(tail.text);

    expect(streamed).toEqual(bulk);
  });

  it('reset clears buffer and index', () => {
    const parser = new SentenceParser();
    parser.push('A. ');
    parser.reset();
    expect(parser.pending).toBe('');
    const emitted = parser.push('B. ');
    expect(emitted[0]?.index).toBe(0);
  });
});
