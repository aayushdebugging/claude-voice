import { ProviderError } from '../utils/errors.js';
import type { TtsProvider, SynthesisOptions, HealthResult } from '../types/index.js';

export interface ElevenLabsOptions {
  apiKey: string;
  modelId: string;
  /** Named voice -> ElevenLabs voice id. */
  voices: Record<string, string>;
  /** Default named voice. */
  defaultVoice: string;
  stability: number;
  similarityBoost: number;
  /** PCM sample rate to request. ElevenLabs supports 16000/22050/24000/44100. */
  sampleRate?: 16000 | 22050 | 24000 | 44100;
  baseUrl?: string;
}

/**
 * ElevenLabs text-to-speech.
 *
 * Requests the raw-PCM streaming endpoint so audio chunks can be piped to the
 * speaker as they arrive, keeping perceived latency low. Playback begins while
 * synthesis is still in flight.
 */
export class ElevenLabsTts implements TtsProvider {
  readonly name = 'elevenlabs';
  readonly channels = 1;
  readonly bitDepth = 16;
  readonly sampleRate: number;

  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly voices: Record<string, string>;
  private readonly defaultVoice: string;
  private readonly stability: number;
  private readonly similarityBoost: number;
  private readonly baseUrl: string;

  constructor(options: ElevenLabsOptions) {
    this.apiKey = options.apiKey;
    this.modelId = options.modelId;
    this.voices = options.voices;
    this.defaultVoice = options.defaultVoice;
    this.stability = options.stability;
    this.similarityBoost = options.similarityBoost;
    this.sampleRate = options.sampleRate ?? 24000;
    this.baseUrl = (options.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/$/, '');
  }

  /** Resolve a named voice to an ElevenLabs voice id (falls back to the name). */
  private resolveVoiceId(voice?: string): string {
    const name = voice ?? this.defaultVoice;
    return this.voices[name] ?? name;
  }

  async *synthesize(options: SynthesisOptions): AsyncIterable<Buffer> {
    const voiceId = this.resolveVoiceId(options.voice);
    const url =
      `${this.baseUrl}/v1/text-to-speech/${voiceId}/stream` +
      `?output_format=pcm_${this.sampleRate}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/pcm',
        },
        body: JSON.stringify({
          text: options.text,
          model_id: this.modelId,
          voice_settings: {
            stability: this.stability,
            similarity_boost: this.similarityBoost,
            // ElevenLabs supports a narrow speed range (0.7–1.2). Only send it
            // when the user asked for non-default so we never regress a model
            // that doesn't accept the field.
            ...(options.speed !== undefined && options.speed !== 1
              ? { speed: Math.min(1.2, Math.max(0.7, options.speed)) }
              : {}),
          },
        }),
        signal: options.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw new ProviderError(
        `ElevenLabs request failed: ${(err as Error).message}`,
        undefined,
        'Check your internet connection.',
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(
        `ElevenLabs synthesis failed (${response.status}): ${truncate(body)}`,
        response.status,
        elevenLabsHint(response.status, body),
      );
    }

    if (!response.body) {
      throw new ProviderError('ElevenLabs returned an empty audio stream.');
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
      // Best-effort cancel so an interrupted request doesn't keep streaming.
      reader.cancel().catch(() => {});
    }
  }

  async healthCheck(): Promise<HealthResult> {
    if (!this.apiKey) {
      return {
        ok: false,
        message: 'elevenlabs: no API key',
        hint: 'Set ELEVENLABS_API_KEY in your environment.',
      };
    }
    try {
      const res = await fetch(`${this.baseUrl}/v1/user`, {
        headers: { 'xi-api-key': this.apiKey },
      });
      if (res.status === 401) {
        return {
          ok: false,
          message: 'elevenlabs: API key rejected',
          hint: 'Verify ELEVENLABS_API_KEY is correct.',
        };
      }
      if (!res.ok) {
        return { ok: false, message: `elevenlabs: unexpected status ${res.status}` };
      }
      return { ok: true, message: `elevenlabs configured (model: ${this.modelId})` };
    } catch (err) {
      return {
        ok: false,
        message: `elevenlabs: ${(err as Error).message}`,
        hint: 'Check your internet connection.',
      };
    }
  }
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Choose the most actionable hint for a failed ElevenLabs request. A 401 can
 * mean a bad key *or* a billing problem (ElevenLabs returns `payment_required`
 * with a 401), so the body is inspected before blaming the key.
 */
function elevenLabsHint(status: number, body: string): string | undefined {
  const lower = body.toLowerCase();
  if (lower.includes('payment') || lower.includes('invoice') || lower.includes('quota')) {
    return 'Your ElevenLabs account has a billing/quota issue — settle the invoice or check your plan at https://elevenlabs.io/app/subscription.';
  }
  if (lower.includes('detected_unusual_activity') || lower.includes('free tier')) {
    return 'ElevenLabs flagged the request (often free-tier limits) — check your account status.';
  }
  if (status === 401) return 'Verify ELEVENLABS_API_KEY is correct.';
  if (status === 429) return 'Rate limited — slow down or upgrade your ElevenLabs plan.';
  return undefined;
}
