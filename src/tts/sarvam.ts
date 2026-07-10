import { ProviderError } from '../utils/errors.js';
import { extractPcmFromWav } from '../utils/wav.js';
import { withRetry } from '../utils/async.js';
import { clampSpeed } from '../utils/rate.js';
import type { TtsProvider, SynthesisOptions, HealthResult } from '../types/index.js';

export interface SarvamOptions {
  apiKey: string;
  model: string;
  speaker: string;
  targetLanguageCode: string;
  sampleRate: number;
  pace: number;
  pitch: number;
  loudness: number;
  baseUrl?: string;
}

/** Speakers valid for the bulbul:v2 model. */
const V2_SPEAKERS = new Set(['anushka', 'abhilash', 'manisha', 'vidya', 'arya', 'karun', 'hitesh']);
/** Speakers valid for the bulbul:v3 model. */
const V3_SPEAKERS = new Set([
  'aditya',
  'ritu',
  'priya',
  'neha',
  'rahul',
  'pooja',
  'rohan',
  'simran',
  'kavya',
  'amit',
  'dev',
  'ishita',
  'shreya',
  'ratan',
  'varun',
  'manan',
  'sumit',
  'roopa',
  'kabir',
  'aayan',
  'shubh',
  'ashutosh',
  'advait',
  'anand',
  'tanya',
  'tarun',
  'sunny',
  'mani',
  'gokul',
  'vijay',
  'shruti',
  'suhani',
  'mohit',
  'kavitha',
  'rehan',
  'soham',
  'rupali',
]);
const V2_DEFAULT = 'anushka';
const V3_DEFAULT = 'priya';

/** Short ISO-639-1 → Sarvam `target_language_code` (Sarvam is India-focused). */
const LANGUAGE_CODES: Record<string, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  bn: 'bn-IN',
  gu: 'gu-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  mr: 'mr-IN',
  od: 'od-IN',
  or: 'od-IN',
  pa: 'pa-IN',
  ta: 'ta-IN',
  te: 'te-IN',
};

/** Sarvam caps input length per request; v3 allows 2500, v2 1500. */
const MAX_CHARS = 2500;

/**
 * Sarvam AI text-to-speech (the `bulbul` models).
 *
 * Unlike ElevenLabs, Sarvam is request/response rather than streaming: it
 * returns a base64-encoded WAV in JSON. We decode it, strip the WAV header to
 * raw PCM, and yield it as a single chunk — playback still begins as soon as
 * the sentence's audio arrives. Good for Indian-language and en-IN voices.
 */
export class SarvamTts implements TtsProvider {
  readonly name = 'sarvam';
  readonly channels = 1;
  readonly bitDepth = 16;
  readonly sampleRate: number;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly speaker: string;
  private readonly targetLanguageCode: string;
  private readonly pace: number;
  private readonly pitch: number;
  private readonly loudness: number;
  private readonly baseUrl: string;

  constructor(options: SarvamOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.speaker = options.speaker;
    this.targetLanguageCode = options.targetLanguageCode;
    this.sampleRate = options.sampleRate;
    this.pace = options.pace;
    this.pitch = options.pitch;
    this.loudness = options.loudness;
    this.baseUrl = (options.baseUrl ?? 'https://api.sarvam.ai').replace(/\/$/, '');
  }

  /**
   * Resolve a speaker valid for the configured model, so a voice meant for a
   * different model (or provider) never triggers a 400. Prefers the requested
   * voice, then the configured speaker, then the model's default.
   */
  private resolveSpeaker(voice?: string): string {
    const valid = this.model.startsWith('bulbul:v3') ? V3_SPEAKERS : V2_SPEAKERS;
    const fallback = this.model.startsWith('bulbul:v3') ? V3_DEFAULT : V2_DEFAULT;
    const requested = voice?.toLowerCase();
    if (requested && valid.has(requested)) return requested;
    const configured = this.speaker.toLowerCase();
    if (valid.has(configured)) return configured;
    return fallback;
  }

  /**
   * Resolve the target language for a request. A full code (`hi-IN`) is used
   * as-is; a short code (`hi`) is mapped to Sarvam's `xx-IN` form; `auto` or an
   * unknown value keeps the configured default.
   */
  private resolveLanguage(language?: string): string {
    if (!language || language === 'auto') return this.targetLanguageCode;
    if (language.includes('-')) return language;
    return LANGUAGE_CODES[language.toLowerCase()] ?? this.targetLanguageCode;
  }

  async *synthesize(options: SynthesisOptions): AsyncIterable<Buffer> {
    if (options.signal?.aborted) return;
    // Retry transient failures so a single hiccup doesn't drop part of a reply.
    const pcm = await withRetry(() => this.request(options), {
      retries: 2,
      signal: options.signal,
      shouldRetry: (err) =>
        err instanceof ProviderError &&
        (err.status === undefined || err.status >= 500 || err.status === 429),
    });
    if (pcm && !options.signal?.aborted) yield pcm;
  }

  private async request(options: SynthesisOptions): Promise<Buffer | null> {
    const text = options.text.slice(0, MAX_CHARS);
    // bulbul:v3 supports `pace` only; `pitch`/`loudness` are rejected (400).
    const isV3 = this.model.startsWith('bulbul:v3');
    const body: Record<string, unknown> = {
      text,
      target_language_code: this.resolveLanguage(options.language),
      speaker: this.resolveSpeaker(options.voice),
      model: this.model,
      pace: clampSpeed(options.speed ?? this.pace),
      speech_sample_rate: this.sampleRate,
      enable_preprocessing: true,
    };
    if (!isV3) {
      body.pitch = this.pitch;
      body.loudness = this.loudness;
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/text-to-speech`, {
        method: 'POST',
        headers: {
          'api-subscription-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null;
      throw new ProviderError(
        `Sarvam request failed: ${(err as Error).message}`,
        undefined,
        'Check your internet connection.',
      );
    }

    if (options.signal?.aborted) return null;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(
        `Sarvam synthesis failed (${response.status}): ${truncate(body)}`,
        response.status,
        response.status === 401 || response.status === 403
          ? 'Verify SARVAM_API_KEY is correct and active.'
          : undefined,
      );
    }

    const data = (await response.json()) as { audios?: string[]; audio?: string };
    const b64 = data.audios?.[0] ?? data.audio;
    if (!b64) throw new ProviderError('Sarvam returned no audio.');
    return extractPcmFromWav(Buffer.from(b64, 'base64'));
  }

  async healthCheck(): Promise<HealthResult> {
    if (!this.apiKey) {
      return {
        ok: false,
        message: 'sarvam: no API key',
        hint: 'Set SARVAM_API_KEY in your environment.',
      };
    }
    return {
      ok: true,
      message: `sarvam configured (model: ${this.model}, speaker: ${this.speaker})`,
    };
  }
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
