import { OpenAICompatibleStt } from './openai-compatible.js';

export interface OpenAISttOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/**
 * OpenAI Whisper speech-to-text. Uses the same OpenAI-compatible contract; this
 * class exists to bind OpenAI's defaults and credentials.
 */
export class OpenAIStt extends OpenAICompatibleStt {
  constructor(options: OpenAISttOptions) {
    super({
      name: 'openai',
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model,
      envKeyName: 'OPENAI_API_KEY',
    });
  }
}
