/**
 * Convert Claude's markdown-flavored output into text suited for speech.
 *
 * Reading raw markdown aloud ("asterisk asterisk bold") is jarring, and code
 * blocks are noise over audio. This strips structural markup while preserving
 * the words, and reports when a chunk is entirely non-speakable (e.g. a fenced
 * code block) so the caller can skip synthesis for it.
 */

export interface SpeakableResult {
  /** Cleaned text safe to send to a TTS provider. */
  text: string;
  /** True when there is nothing meaningful to speak. */
  empty: boolean;
}

export function toSpeakable(input: string): SpeakableResult {
  let text = input;

  // Remove fenced code blocks entirely.
  text = text.replace(/```[\s\S]*?```/g, ' ');
  // Inline code -> keep the contents, drop the backticks.
  text = text.replace(/`([^`]+)`/g, '$1');
  // Images: drop entirely.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  // Links: keep the visible label.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Headings / list bullets / blockquotes at line start.
  text = text.replace(/^\s{0,3}(#{1,6}|[-*+]|>|\d+\.)\s+/gm, '');
  // Bold / italic / strikethrough markers.
  text = text.replace(/(\*\*|\*|__|_|~~)/g, '');
  // Table pipes and separator rows.
  text = text.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ');
  text = text.replace(/\|/g, ' ');
  // Collapse whitespace.
  text = text.replace(/\s+/g, ' ').trim();

  return { text, empty: text.length === 0 };
}

/**
 * Split speakable text into as few chunks as possible, each within `maxLen`,
 * breaking on sentence boundaries where it can. Speaking a whole reply as one
 * (or a couple of) large chunk(s) avoids the choppy "hopping" of synthesizing
 * every short sentence separately, while still respecting provider length
 * limits (e.g. Sarvam's per-request cap).
 */
export function chunkForSpeech(input: string, maxLen = 1000): string[] {
  const text = input.trim();
  if (!text) return [];
  // Sentence-ish segments (keep terminal punctuation).
  const segments = text.match(/[^.!?\n]+[.!?]*\s*|\S+/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  const flush = (): void => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = '';
  };
  for (const seg of segments) {
    if (current && current.length + seg.length > maxLen) flush();
    current += seg;
    // A single oversized segment: hard-split it.
    while (current.length > maxLen) {
      chunks.push(current.slice(0, maxLen).trim());
      current = current.slice(maxLen);
    }
  }
  flush();
  return chunks;
}
