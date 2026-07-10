import { ProviderError } from '../utils/errors.js';
import { withRetry } from '../utils/async.js';
import { serverReachable } from '../utils/net.js';
import type {
  SttProvider,
  TranscriptionOptions,
  TranscriptionResult,
  HealthResult,
} from '../types/index.js';

export interface WhisperCppOptions {
  baseUrl: string;
}

/**
 * Local speech-to-text via a running `whisper.cpp` server (`whisper-server`).
 *
 * whisper.cpp exposes its own `/inference` endpoint (not the OpenAI shape), so
 * this small provider targets it directly. Fully offline and free; the server
 * loads one ggml model at startup.
 */
export class WhisperCppStt implements SttProvider {
  readonly name = 'whispercpp';
  private readonly baseUrl: string;

  constructor(options: WhisperCppOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  async transcribe(options: TranscriptionOptions): Promise<TranscriptionResult> {
    const start = performance.now();
    const text = await withRetry(() => this.request(options), {
      retries: 1,
      shouldRetry: (err) => err instanceof ProviderError && err.status === undefined,
    });
    return { text, latencyMs: Math.round(performance.now() - start) };
  }

  private async request(options: TranscriptionOptions): Promise<string> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([options.audio as unknown as ArrayBuffer], { type: 'audio/wav' }),
      'speech.wav',
    );
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (options.language && options.language !== 'auto') form.append('language', options.language);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/inference`, { method: 'POST', body: form });
    } catch (err) {
      throw new ProviderError(
        `whisper.cpp request failed: ${(err as Error).message}`,
        undefined,
        `Is the server running? Start it with: claude-voice local (or whisper-server -m <model> --port 8081)`,
      );
    }
    if (!response.ok) {
      throw new ProviderError(`whisper.cpp failed (${response.status})`, response.status);
    }
    const body = await response.text();
    try {
      return ((JSON.parse(body) as { text?: string }).text ?? '').trim();
    } catch {
      return body.trim();
    }
  }

  async healthCheck(): Promise<HealthResult> {
    return (await serverReachable(this.baseUrl))
      ? { ok: true, message: `whisper.cpp reachable at ${this.baseUrl}` }
      : {
          ok: false,
          message: `whisper.cpp server not reachable at ${this.baseUrl}`,
          hint: 'Start it: `claude-voice local` (or `brew install whisper-cpp` then run whisper-server).',
        };
  }
}
