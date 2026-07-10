import type { SttProvider, VoiceConfig } from '../types/index.js';
import { getApiKey } from '../config/credentials.js';
import { GroqStt } from './groq.js';
import { OpenAIStt } from './openai.js';
import { WhisperCppStt } from './whispercpp.js';

/**
 * Construct the configured speech-to-text provider.
 *
 * New providers are added here (and to the {@link SttProviderName} union). The
 * rest of the app only depends on the {@link SttProvider} interface, so callers
 * never change when a provider is added.
 */
export function createSttProvider(config: VoiceConfig): SttProvider {
  switch (config.stt) {
    case 'groq':
      return new GroqStt({
        apiKey: getApiKey('groq') ?? '',
        model: config.providers.groq.model,
        baseUrl: config.providers.groq.baseUrl,
      });
    case 'openai':
      return new OpenAIStt({
        apiKey: getApiKey('openai') ?? '',
        model: config.providers.openai.model,
        baseUrl: config.providers.openai.baseUrl,
      });
    case 'whispercpp':
      return new WhisperCppStt({ baseUrl: config.providers.whispercpp.baseUrl });
    default: {
      const exhaustive: never = config.stt;
      throw new Error(`Unknown STT provider: ${String(exhaustive)}`);
    }
  }
}
