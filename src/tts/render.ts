import { chunkForSpeech } from '../utils/speakable.js';
import { encodeWav } from '../utils/wav.js';
import type { TtsProvider } from '../types/index.js';

export interface RenderOptions {
  voice?: string;
  /** Speech rate multiplier (1 = natural). */
  speed?: number;
  /** Output language hint passed to the provider. */
  language?: string;
  /** Max characters per synthesis request (provider limit). */
  maxChunkChars?: number;
  signal?: AbortSignal;
}

/**
 * Synthesize `text` in full and return it as a single WAV buffer.
 *
 * Unlike the {@link SpeechQueue} (which plays locally), this returns the audio
 * bytes so they can be sent elsewhere — e.g. streamed to a remote browser
 * client. Long text is split to the provider's limit and the PCM concatenated
 * before wrapping in one WAV.
 */
export async function renderSpeechWav(
  provider: TtsProvider,
  text: string,
  options: RenderOptions = {},
): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const chunk of chunkForSpeech(text, options.maxChunkChars ?? 1400)) {
    if (options.signal?.aborted) break;
    for await (const buf of provider.synthesize({
      text: chunk,
      voice: options.voice,
      speed: options.speed,
      language: options.language,
      signal: options.signal,
    })) {
      if (options.signal?.aborted) break;
      if (buf.length > 0) parts.push(buf);
    }
  }
  const pcm = Buffer.concat(parts);
  return encodeWav(pcm, {
    sampleRate: provider.sampleRate,
    channels: provider.channels,
    bitDepth: provider.bitDepth,
  });
}
