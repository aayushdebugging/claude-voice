import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getApiKey, requireApiKey, needsApiKey } from '../src/config/credentials.js';
import { createSttProvider } from '../src/stt/factory.js';
import { createTtsProvider } from '../src/tts/factory.js';
import { GroqStt, OpenAIStt, WhisperCppStt } from '../src/stt/index.js';
import { ElevenLabsTts, SarvamTts, KokoroTts } from '../src/tts/index.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

describe('credentials', () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it('returns undefined when a key is unset', () => {
    expect(getApiKey('groq')).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    process.env.GROQ_API_KEY = '  abc  ';
    expect(getApiKey('groq')).toBe('abc');
  });

  it('treats a blank key as unset', () => {
    process.env.GROQ_API_KEY = '   ';
    expect(getApiKey('groq')).toBeUndefined();
  });

  it('requireApiKey throws a helpful error when missing', () => {
    expect(() => requireApiKey('elevenlabs')).toThrow(/ELEVENLABS_API_KEY/);
  });
});

describe('STT factory', () => {
  it('builds a Groq provider by default', () => {
    const provider = createSttProvider(DEFAULT_CONFIG);
    expect(provider).toBeInstanceOf(GroqStt);
    expect(provider.name).toBe('groq');
  });

  it('builds an OpenAI provider when configured', () => {
    const provider = createSttProvider({ ...DEFAULT_CONFIG, stt: 'openai' });
    expect(provider).toBeInstanceOf(OpenAIStt);
    expect(provider.name).toBe('openai');
  });

  it('health check reports missing key', async () => {
    delete process.env.GROQ_API_KEY;
    const result = await createSttProvider(DEFAULT_CONFIG).healthCheck();
    expect(result.ok).toBe(false);
    expect(result.hint).toMatch(/GROQ_API_KEY/);
  });
});

describe('TTS factory', () => {
  it('builds an ElevenLabs provider by default', () => {
    const provider = createTtsProvider(DEFAULT_CONFIG);
    expect(provider).toBeInstanceOf(ElevenLabsTts);
    expect(provider.name).toBe('elevenlabs');
    expect(provider.bitDepth).toBe(16);
    expect(provider.channels).toBe(1);
  });

  it('health check reports missing key without a network call', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const result = await createTtsProvider(DEFAULT_CONFIG).healthCheck();
    expect(result.ok).toBe(false);
    expect(result.hint).toMatch(/ELEVENLABS_API_KEY/);
  });

  it('builds a Sarvam provider when configured', () => {
    const provider = createTtsProvider({ ...DEFAULT_CONFIG, tts: 'sarvam' });
    expect(provider).toBeInstanceOf(SarvamTts);
    expect(provider.name).toBe('sarvam');
    expect(provider.sampleRate).toBe(22050);
  });

  it('sarvam health check reports missing key', async () => {
    delete process.env.SARVAM_API_KEY;
    const result = await createTtsProvider({ ...DEFAULT_CONFIG, tts: 'sarvam' }).healthCheck();
    expect(result.ok).toBe(false);
    expect(result.hint).toMatch(/SARVAM_API_KEY/);
  });
});

describe('local providers (whisper.cpp + Kokoro)', () => {
  it('builds a WhisperCpp STT provider', () => {
    const provider = createSttProvider({ ...DEFAULT_CONFIG, stt: 'whispercpp' });
    expect(provider).toBeInstanceOf(WhisperCppStt);
    expect(provider.name).toBe('whispercpp');
  });

  it('builds a Kokoro TTS provider at 24 kHz', () => {
    const provider = createTtsProvider({ ...DEFAULT_CONFIG, tts: 'kokoro' });
    expect(provider).toBeInstanceOf(KokoroTts);
    expect(provider.name).toBe('kokoro');
    expect(provider.sampleRate).toBe(24000);
  });

  it('needsApiKey: cloud providers yes, local providers no', () => {
    expect(needsApiKey('groq')).toBe(true);
    expect(needsApiKey('sarvam')).toBe(true);
    expect(needsApiKey('whispercpp')).toBe(false);
    expect(needsApiKey('kokoro')).toBe(false);
  });
});

describe('SarvamTts request body', () => {
  const realFetch = globalThis.fetch;
  let lastBody: Record<string, unknown>;

  beforeEach(() => {
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      lastBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ audios: ['AAA='] }), { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const opts = {
    apiKey: 'k',
    speaker: 'priya',
    targetLanguageCode: 'en-IN',
    sampleRate: 22050,
    pace: 1.1,
    pitch: 0,
    loudness: 1,
  };
  const drain = async (tts: SarvamTts): Promise<void> => {
    for await (const _chunk of tts.synthesize({ text: 'hi' })) {
      void _chunk; // consume the stream
    }
  };

  it('omits pitch/loudness for bulbul:v3 (the API rejects them)', async () => {
    await drain(new SarvamTts({ ...opts, model: 'bulbul:v3' }));
    expect(lastBody.model).toBe('bulbul:v3');
    expect(lastBody).not.toHaveProperty('pitch');
    expect(lastBody).not.toHaveProperty('loudness');
    expect(lastBody).toHaveProperty('pace');
  });

  it('includes pitch/loudness for bulbul:v2', async () => {
    await drain(new SarvamTts({ ...opts, speaker: 'anushka', model: 'bulbul:v2' }));
    expect(lastBody).toHaveProperty('pitch');
    expect(lastBody).toHaveProperty('loudness');
  });

  it('maps speed → pace and a short language → target_language_code', async () => {
    const tts = new SarvamTts({ ...opts, model: 'bulbul:v3' });
    for await (const _chunk of tts.synthesize({ text: 'hi', speed: 1.8, language: 'hi' })) {
      void _chunk;
    }
    expect(lastBody.pace).toBe(1.8);
    expect(lastBody.target_language_code).toBe('hi-IN');
  });

  it('keeps the configured language for "auto" and clamps out-of-range speed', async () => {
    const tts = new SarvamTts({ ...opts, model: 'bulbul:v3' });
    for await (const _chunk of tts.synthesize({ text: 'hi', speed: 99, language: 'auto' })) {
      void _chunk;
    }
    expect(lastBody.target_language_code).toBe('en-IN');
    expect(lastBody.pace).toBe(3); // clamped to SPEED_MAX
  });
});

describe('Kokoro/OpenAI-compatible request body', () => {
  const realFetch = globalThis.fetch;
  let lastBody: Record<string, unknown>;

  beforeEach(() => {
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      lastBody = JSON.parse(init.body);
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const make = (): KokoroTts =>
    new KokoroTts({ baseUrl: 'http://127.0.0.1:8880/v1', model: 'kokoro', voice: 'af_heart' });
  const drain = async (tts: KokoroTts, o: { text: string; speed?: number; language?: string }) => {
    for await (const _chunk of tts.synthesize(o)) void _chunk;
  };

  it('always sends a clamped speed and requests PCM', async () => {
    await drain(make(), { text: 'hi', speed: 2 });
    expect(lastBody.speed).toBe(2);
    expect(lastBody.response_format).toBe('pcm');
  });

  it('maps a short language to a kokoro lang (en → en-us)', async () => {
    await drain(make(), { text: 'hi', language: 'en' });
    expect(lastBody.lang).toBe('en-us');
  });

  it('omits lang for "auto" and defaults speed to 1', async () => {
    await drain(make(), { text: 'hi', language: 'auto' });
    expect(lastBody).not.toHaveProperty('lang');
    expect(lastBody.speed).toBe(1);
  });
});
