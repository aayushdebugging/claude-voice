import { OpenAICompatibleStt } from './openai-compatible.js';

export interface GroqSttOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/**
 * Groq speech-to-text. Groq hosts Whisper models behind an OpenAI-compatible
 * API and is the default STT provider for its very low latency.
 */
export class GroqStt extends OpenAICompatibleStt {
  constructor(options: GroqSttOptions) {
    super({
      name: 'groq',
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model,
      envKeyName: 'GROQ_API_KEY',
    });
  }
}
