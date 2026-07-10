import { describe, it, expect } from 'vitest';

import {
  encodeWav,
  extractPcmFromWav,
  isLikelySilent,
  peakAmplitude,
  normalizePcm,
} from '../src/utils/wav.js';
import { toSpeakable, chunkForSpeech } from '../src/utils/speakable.js';

describe('encodeWav', () => {
  it('prepends a valid 44-byte RIFF/WAVE header', () => {
    const pcm = Buffer.alloc(100, 1);
    const wav = encodeWav(pcm, { sampleRate: 16000, channels: 1, bitDepth: 16 });
    expect(wav.length).toBe(144);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(4)).toBe(36 + 100); // chunk size
    expect(wav.readUInt16LE(22)).toBe(1); // channels
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bit depth
    expect(wav.readUInt32LE(40)).toBe(100); // data size
  });
});

describe('extractPcmFromWav', () => {
  it('round-trips PCM through encode + extract', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = encodeWav(pcm, { sampleRate: 22050, channels: 1, bitDepth: 16 });
    expect(extractPcmFromWav(wav)).toEqual(pcm);
  });

  it('locates the data chunk even when other chunks precede it', () => {
    const pcm = Buffer.from([9, 9, 9, 9]);
    const body = encodeWav(pcm, { sampleRate: 16000, channels: 1, bitDepth: 16 });
    // Splice a bogus "LIST" chunk between fmt and data to exercise chunk-walking.
    const list = Buffer.concat([
      Buffer.from('LIST'),
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(4, 0);
        return b;
      })(),
      Buffer.from('INFO'),
    ]);
    const spliced = Buffer.concat([body.subarray(0, 36), list, body.subarray(36)]);
    expect(extractPcmFromWav(spliced)).toEqual(pcm);
  });

  it('passes non-WAV buffers through unchanged (already raw PCM)', () => {
    const raw = Buffer.from([1, 2, 3]);
    expect(extractPcmFromWav(raw)).toEqual(raw);
  });
});

describe('isLikelySilent', () => {
  it('reports silence for near-zero samples', () => {
    expect(isLikelySilent(Buffer.alloc(2000))).toBe(true);
  });

  it('reports non-silence for loud samples', () => {
    const pcm = Buffer.alloc(2000);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(8000, i);
    expect(isLikelySilent(pcm)).toBe(false);
  });

  it('treats empty buffers as silent', () => {
    expect(isLikelySilent(Buffer.alloc(0))).toBe(true);
  });
});

describe('peakAmplitude', () => {
  it('is ~0 for digital silence (no-permission signature)', () => {
    expect(peakAmplitude(Buffer.alloc(2000))).toBe(0);
  });

  it('reflects the loudest sample, catching a quiet-but-live mic', () => {
    // Mostly quiet with a couple of small blips — like ambient noise.
    const pcm = Buffer.alloc(2000);
    pcm.writeInt16LE(120, 10);
    pcm.writeInt16LE(-90, 40);
    expect(peakAmplitude(pcm)).toBe(120);
    // Average would look "silent", but peak reveals the mic is working.
    expect(isLikelySilent(pcm)).toBe(true);
    expect(peakAmplitude(pcm)).toBeGreaterThan(60);
  });
});

describe('normalizePcm', () => {
  const filled = (value: number, bytes = 1000): Buffer => {
    const b = Buffer.alloc(bytes);
    for (let i = 0; i + 1 < bytes; i += 2) b.writeInt16LE(value, i);
    return b;
  };

  it('boosts a quiet capture toward the target peak', () => {
    const out = normalizePcm(filled(300), 9000, 25); // gain 30 → capped at 25 → ~7500
    expect(peakAmplitude(out)).toBeGreaterThan(6000);
  });

  it('caps gain so near-silence is not blown up into noise', () => {
    const out = normalizePcm(filled(10), 10000, 25); // gain capped at 25 → ~250
    expect(peakAmplitude(out)).toBeLessThanOrEqual(260);
  });

  it('leaves already-loud audio unchanged', () => {
    const loud = filled(12000, 100);
    expect(normalizePcm(loud, 10000)).toEqual(loud);
  });
});

describe('toSpeakable', () => {
  it('strips fenced code blocks entirely', () => {
    const { text } = toSpeakable('Here is code:\n```js\nconst x = 1;\n```\nDone.');
    expect(text).toBe('Here is code: Done.');
  });

  it('keeps inline code contents without backticks', () => {
    expect(toSpeakable('Run `npm test` now').text).toBe('Run npm test now');
  });

  it('drops markdown emphasis and heading markers', () => {
    expect(toSpeakable('# Title\n\n**bold** and _italic_').text).toBe('Title bold and italic');
  });

  it('keeps link labels, drops URLs', () => {
    expect(toSpeakable('See [the docs](https://example.com) here').text).toBe('See the docs here');
  });

  it('flags empty results (e.g. a pure code block)', () => {
    expect(toSpeakable('```\ncode only\n```').empty).toBe(true);
  });
});

describe('chunkForSpeech', () => {
  it('keeps a short reply as a single chunk', () => {
    expect(chunkForSpeech('First sentence. Second one. Third.', 1000)).toEqual([
      'First sentence. Second one. Third.',
    ]);
  });

  it('splits long text into few chunks within the limit, at sentence bounds', () => {
    const sentence = 'This is a fairly long sentence used for testing chunking behavior. ';
    const text = sentence.repeat(20); // ~1340 chars
    const chunks = chunkForSpeech(text, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
    // No text is lost (ignoring whitespace differences).
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
  });

  it('hard-splits a single oversized segment', () => {
    const chunks = chunkForSpeech('x'.repeat(2500), 1000);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
  });

  it('returns [] for empty input', () => {
    expect(chunkForSpeech('   ')).toEqual([]);
  });
});
