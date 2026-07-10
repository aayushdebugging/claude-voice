import { ProviderError } from '../utils/errors.js';
import { serverReachable } from '../utils/net.js';
import { clampSpeed } from '../utils/rate.js';
import type { TtsProvider, SynthesisOptions, HealthResult } from '../types/index.js';

export interface OpenAICompatibleTtsOptions {
  name: string;
  /** Base URL including the version segment, e.g. http://127.0.0.1:8880/v1 */
  baseUrl: string;
  /** Optional bearer token (local servers usually need none). */
  apiKey?: string;
  model: string;
  defaultVoice: string;
  sampleRate: number;
  channels?: number;
  bitDepth?: number;
  /** Response format to request; `pcm` yields raw 16-bit PCM we can play. */
  responseFormat?: string;
  /** Whether a requested voice name is valid for this provider. */
  isKnownVoice?: (voice: string) => boolean;
  /**
   * Map a language hint (ISO-639-1 short or full code) to a value the server
   * understands, sent as `lang` in the request body. Return `undefined` to omit
   * it (keeping the server's default). Only used when a language is requested.
   */
  mapLanguage?: (code: string) => string | undefined;
  /** Hint shown when the server can't be reached. */
  offlineHint?: string;
}

/**
 * Text-to-speech for any server implementing OpenAI's `/v1/audio/speech`
 * (e.g. Kokoro's `kokoro-fastapi`, `openedai-speech`). Requests raw PCM and
 * streams it so playback can begin as chunks arrive.
 */
export class OpenAICompatibleTts implements TtsProvider {
  readonly name: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitDepth: number;

  protected readonly baseUrl: string;
  protected readonly apiKey?: string;
  protected readonly model: string;
  protected readonly defaultVoice: string;
  protected readonly responseFormat: string;
  private readonly isKnownVoice?: (voice: string) => boolean;
  private readonly mapLanguage?: (code: string) => string | undefined;
  private readonly offlineHint?: string;

  constructor(options: OpenAICompatibleTtsOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.defaultVoice = options.defaultVoice;
    this.sampleRate = options.sampleRate;
    this.channels = options.channels ?? 1;
    this.bitDepth = options.bitDepth ?? 16;
    this.responseFormat = options.responseFormat ?? 'pcm';
    this.isKnownVoice = options.isKnownVoice;
    this.mapLanguage = options.mapLanguage;
    this.offlineHint = options.offlineHint;
  }

  private resolveVoice(voice?: string): string {
    if (voice && (!this.isKnownVoice || this.isKnownVoice(voice))) return voice;
    return this.defaultVoice;
  }

  /** Resolve the `lang` body field, or undefined to keep the server default. */
  private resolveLanguage(language?: string): string | undefined {
    if (!language || language === 'auto' || !this.mapLanguage) return undefined;
    return this.mapLanguage(language);
  }

  async *synthesize(options: SynthesisOptions): AsyncIterable<Buffer> {
    if (options.signal?.aborted) return;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const body: Record<string, unknown> = {
      model: this.model,
      input: options.text,
      voice: this.resolveVoice(options.voice),
      response_format: this.responseFormat,
      speed: clampSpeed(options.speed),
    };
    const lang = this.resolveLanguage(options.language);
    if (lang) body.lang = lang;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/audio/speech`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw new ProviderError(
        `${this.name} request failed: ${(err as Error).message}`,
        undefined,
        this.offlineHint,
      );
    }

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(
        `${this.name} synthesis failed (${response.status}): ${body.slice(0, 160)}`,
      );
    }

    const reader = response.body.getReader();
    try {
      for (;;) {
        if (options.signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) yield Buffer.from(value);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async healthCheck(): Promise<HealthResult> {
    return (await serverReachable(this.baseUrl))
      ? { ok: true, message: `${this.name} reachable at ${this.baseUrl} (model: ${this.model})` }
      : {
          ok: false,
          message: `${this.name} server not reachable at ${this.baseUrl}`,
          hint: this.offlineHint,
        };
  }
}
