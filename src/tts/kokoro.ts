import { OpenAICompatibleTts } from './openai-compatible.js';

export interface KokoroOptions {
  baseUrl: string;
  model: string;
  voice: string;
}

/** Kokoro voice ids look like `af_heart`, `am_adam`, `bf_emma` … */
function isKokoroVoice(voice: string): boolean {
  return /^[a-z][fm]_[a-z]/i.test(voice);
}

/** Short ISO-639-1 → the `lang` codes kokoro-onnx understands. */
const KOKORO_LANGS: Record<string, string> = {
  en: 'en-us',
  fr: 'fr-fr',
  it: 'it',
  ja: 'ja',
  zh: 'cmn',
  es: 'es',
  pt: 'pt-br',
  hi: 'hi',
};

/** Map a language hint to a kokoro-onnx `lang`, or undefined to keep default. */
function mapKokoroLanguage(code: string): string | undefined {
  const lower = code.toLowerCase();
  return KOKORO_LANGS[lower] ?? (Object.values(KOKORO_LANGS).includes(lower) ? lower : undefined);
}

/**
 * Local Kokoro text-to-speech via `kokoro-fastapi` (OpenAI-compatible). Free,
 * offline, Apache-2.0. Outputs 24 kHz mono PCM.
 */
export class KokoroTts extends OpenAICompatibleTts {
  constructor(options: KokoroOptions) {
    super({
      name: 'kokoro',
      baseUrl: options.baseUrl,
      model: options.model,
      defaultVoice: options.voice,
      sampleRate: 24000,
      channels: 1,
      bitDepth: 16,
      responseFormat: 'pcm',
      isKnownVoice: isKokoroVoice,
      mapLanguage: mapKokoroLanguage,
      offlineHint:
        'Start the Kokoro server (`claude-voice local`), or run kokoro-fastapi on port 8880.',
    });
  }
}
