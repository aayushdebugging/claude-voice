import { ProviderError } from '../utils/errors.js';
import { withRetry } from '../utils/async.js';
import type {
  SttProvider,
  TranscriptionOptions,
  TranscriptionResult,
  HealthResult,
} from '../types/index.js';

export interface OpenAICompatibleOptions {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Header name for the health-check hint (e.g. GROQ_API_KEY). */
  envKeyName: string;
}

/**
 * Base speech-to-text client for any OpenAI-compatible `/audio/transcriptions`
 * endpoint. Groq and OpenAI both implement this contract, differing only in
 * base URL, model, and credentials — so they share this implementation.
 */
export class OpenAICompatibleStt implements SttProvider {
  readonly name: string;
  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  protected readonly model: string;
  protected readonly envKeyName: string;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.envKeyName = options.envKeyName;
  }

  async transcribe(options: TranscriptionOptions): Promise<TranscriptionResult> {
    const start = performance.now();
    const result = await withRetry(() => this.request(options), {
      retries: 2,
      shouldRetry: (err) =>
        err instanceof ProviderError && (err.status === undefined || err.status >= 500),
    });
    return { ...result, latencyMs: Math.round(performance.now() - start) };
  }

  private async request(
    options: TranscriptionOptions,
  ): Promise<Omit<TranscriptionResult, 'latencyMs'>> {
    const form = new FormData();
    const filename = options.filename ?? 'speech.wav';
    const type = filename.endsWith('.webm')
      ? 'audio/webm'
      : filename.endsWith('.ogg')
        ? 'audio/ogg'
        : filename.endsWith('.mp4') || filename.endsWith('.m4a')
          ? 'audio/mp4'
          : 'audio/wav';
    const blob = new Blob([options.audio as unknown as ArrayBuffer], { type });
    form.append('file', blob, filename);
    form.append('model', this.model);
    form.append('response_format', 'json');
    if (options.language && options.language !== 'auto') {
      form.append('language', options.language);
    }
    if (options.prompt) form.append('prompt', options.prompt);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
    } catch (err) {
      throw new ProviderError(
        `${this.name} request failed: ${(err as Error).message}`,
        undefined,
        'Check your internet connection.',
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(
        `${this.name} transcription failed (${response.status}): ${truncate(body)}`,
        response.status,
        response.status === 401 ? `Verify ${this.envKeyName} is correct.` : undefined,
      );
    }

    const data = (await response.json()) as { text?: string; language?: string };
    return { text: (data.text ?? '').trim(), language: data.language };
  }

  async healthCheck(): Promise<HealthResult> {
    if (!this.apiKey) {
      return {
        ok: false,
        message: `${this.name}: no API key`,
        hint: `Set ${this.envKeyName} in your environment.`,
      };
    }
    return { ok: true, message: `${this.name} configured (model: ${this.model})` };
  }
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
