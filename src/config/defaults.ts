import type { VoiceConfig } from '../types/index.js';

/**
 * Default voice-friendly system prompt. Steers Claude to answer the way you'd
 * explain something out loud, which both sounds better and streams more
 * smoothly (clean sentence boundaries). Override or clear it via config.
 */
export const DEFAULT_VOICE_PROMPT =
  'Your reply will be read aloud by text-to-speech in a live voice conversation, ' +
  "so answer the way you'd explain it out loud to a colleague next to you. " +
  'Lead with the direct answer in the first sentence, then add only the explanation that helps. ' +
  'Use short, complete sentences with normal punctuation so each one reads well on its own and can be spoken as it streams. ' +
  'Keep it concise unless asked to go deeper. ' +
  'Avoid things that sound bad aloud: long code blocks, tables, ASCII art, file trees, URLs, and markdown symbols. ' +
  "If code is needed, keep it very short and tell the user it's on their screen rather than reading it out. " +
  "Never speak formatting out loud (no 'bullet', 'asterisk', or 'backtick').";

/**
 * Default configuration. These values are used when no config file exists and
 * as the base for merging a partial user config.
 */
export const DEFAULT_CONFIG: VoiceConfig = {
  stt: 'groq',
  tts: 'elevenlabs',
  voice: 'aria',
  model: 'opus',
  pushToTalk: false,
  autoSpeak: true,
  streamSpeech: true,
  voicePrompt: DEFAULT_VOICE_PROMPT,
  language: 'auto',
  speechRate: 1.0,
  silenceTimeoutMs: 1500,
  micSensitivity: 150,
  sampleRate: 16000,
  providers: {
    groq: {
      model: 'whisper-large-v3-turbo',
      baseUrl: 'https://api.groq.com/openai/v1',
    },
    openai: {
      model: 'whisper-1',
      baseUrl: 'https://api.openai.com/v1',
    },
    whispercpp: {
      baseUrl: 'http://127.0.0.1:8081',
      model: 'ggml-base.en.bin',
    },
    kokoro: {
      baseUrl: 'http://127.0.0.1:8880/v1',
      model: 'kokoro',
      voice: 'af_heart',
    },
    elevenlabs: {
      modelId: 'eleven_turbo_v2_5',
      // ElevenLabs "premade" voice ids. `aria` is the default.
      voices: {
        aria: '9BWtsMINqrJLrRacOk9x',
        roger: 'CwhRBWXzGAHq8TQ4Fs17',
        sarah: 'EXAVITQu4vr4xnSDxMaL',
        laura: 'FGY2WhTYpPnrIDTdsKH5',
        george: 'JBFqnCBsd6RMkjVDRZzb',
        river: 'SAz9YHcvj6GT2YYXdXww',
        will: 'bIHbv24MWmeRgasZH58o',
        jessica: 'cgSgspJ2msm6clMCkdW9',
        brian: 'nPczCjzI2devNBz1zQrb',
        charlie: 'IKne3meq5aSn9XLyUdCD',
      },
      stability: 0.5,
      similarityBoost: 0.75,
    },
    sarvam: {
      model: 'bulbul:v3', // latest: higher quality, 2500-char limit, more voices
      speaker: 'priya',
      targetLanguageCode: 'en-IN',
      sampleRate: 22050,
      pace: 1.15, // a touch faster than natural for snappier replies
      pitch: 0,
      loudness: 1.0,
      baseUrl: 'https://api.sarvam.ai',
    },
  },
};
