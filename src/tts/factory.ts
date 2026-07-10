import type { TtsProvider, VoiceConfig } from '../types/index.js';
import { getApiKey } from '../config/credentials.js';
import { ElevenLabsTts } from './elevenlabs.js';
import { SarvamTts } from './sarvam.js';
import { KokoroTts } from './kokoro.js';

/**
 * Construct the configured text-to-speech provider. Add new providers here;
 * callers depend only on the {@link TtsProvider} interface.
 */
export function createTtsProvider(config: VoiceConfig): TtsProvider {
  switch (config.tts) {
    case 'elevenlabs': {
      const el = config.providers.elevenlabs;
      return new ElevenLabsTts({
        apiKey: getApiKey('elevenlabs') ?? '',
        modelId: el.modelId,
        voices: el.voices,
        defaultVoice: config.voice,
        stability: el.stability,
        similarityBoost: el.similarityBoost,
      });
    }
    case 'sarvam': {
      const sv = config.providers.sarvam;
      return new SarvamTts({
        apiKey: getApiKey('sarvam') ?? '',
        model: sv.model,
        speaker: sv.speaker,
        targetLanguageCode: sv.targetLanguageCode,
        sampleRate: sv.sampleRate,
        pace: sv.pace,
        pitch: sv.pitch,
        loudness: sv.loudness,
        baseUrl: sv.baseUrl,
      });
    }
    case 'kokoro': {
      const kk = config.providers.kokoro;
      return new KokoroTts({
        baseUrl: kk.baseUrl,
        model: kk.model,
        voice: kk.voice,
      });
    }
    default: {
      const exhaustive: never = config.tts;
      throw new Error(`Unknown TTS provider: ${String(exhaustive)}`);
    }
  }
}
