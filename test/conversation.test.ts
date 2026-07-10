import { describe, it, expect, beforeEach } from 'vitest';

import { Conversation, type ConversationDeps } from '../src/core/conversation.js';
import { SpeechQueue } from '../src/tts/speech-queue.js';
import { createBus, VoiceEvent } from '../src/events/index.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { AudioSink } from '../src/audio/sink.js';
import type {
  AskOptions,
  AskResult,
  SynthesisOptions,
  TtsProvider,
  VoiceConfig,
} from '../src/index.js';

/** Build a buffer of loud PCM so isLikelySilent() returns false. */
function loudAudio(bytes = 3200): Buffer {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i + 1 < bytes; i += 2) b.writeInt16LE(8000, i);
  return b;
}

class FakeTts implements TtsProvider {
  readonly name = 'fake';
  readonly sampleRate = 16000;
  readonly channels = 1;
  readonly bitDepth = 16;
  spoken: string[] = [];
  lastOptions: SynthesisOptions | null = null;
  async *synthesize(options: SynthesisOptions): AsyncIterable<Buffer> {
    this.spoken.push(options.text);
    this.lastOptions = options;
    if (options.signal?.aborted) return;
    yield Buffer.from([0, 0]);
  }
  async healthCheck() {
    return { ok: true, message: 'fake' };
  }
}

class NullSink implements AudioSink {
  begin() {}
  write() {}
  async end() {}
  stop() {}
}

class FakeRecorder {
  audio: Buffer;
  captureCalls = 0;
  constructor(audio: Buffer) {
    this.audio = audio;
  }
  async captureUntilSilence(opts: {
    signal?: AbortSignal;
    onSpeechStart?: () => void;
  }): Promise<Buffer> {
    this.captureCalls++;
    if (this.captureCalls === 1) {
      opts.onSpeechStart?.();
      return this.audio;
    }
    // Later calls block until the loop is torn down (abort).
    return new Promise((resolve) => {
      if (opts.signal?.aborted) return resolve(Buffer.alloc(0));
      opts.signal?.addEventListener('abort', () => resolve(Buffer.alloc(0)), { once: true });
    });
  }
  async startManual() {
    const audio = this.audio;
    return { stop: async () => audio };
  }
}

class FakeClaude {
  asked: string[] = [];
  async ask(prompt: string, opts: AskOptions = {}): Promise<AskResult> {
    this.asked.push(prompt);
    for (const chunk of ['Sure thing. ', 'All done now. ']) opts.onToken?.(chunk);
    return { text: 'Sure thing. All done now.', elapsedMs: 10, interrupted: false };
  }
  terminate(): void {}
  resetSession(): void {}
  setModel(): void {}
  get session(): string | undefined {
    return undefined;
  }
}

interface Harness {
  conv: Conversation;
  bus: ReturnType<typeof createBus>;
  tts: FakeTts;
  claude: FakeClaude;
  transcribeCalls: () => number;
}

function makeConversation(overrides: Partial<VoiceConfig> = {}, audio = loudAudio()): Harness {
  const config: VoiceConfig = { ...DEFAULT_CONFIG, pushToTalk: true, ...overrides };
  const bus = createBus();
  const tts = new FakeTts();
  const speech = new SpeechQueue({ provider: tts, sink: new NullSink(), bus });
  const claude = new FakeClaude();
  let transcribeCalls = 0;
  const stt = {
    name: 'fake',
    async transcribe() {
      transcribeCalls++;
      return { text: 'build a todo app', latencyMs: 5 };
    },
    async healthCheck() {
      return { ok: true, message: 'fake' };
    },
  };

  const deps: ConversationDeps = {
    config,
    bus,
    recorder: new FakeRecorder(audio) as unknown as ConversationDeps['recorder'],
    stt,
    claude: claude as unknown as ConversationDeps['claude'],
    speech,
  };
  return {
    conv: new Conversation(deps),
    bus,
    tts,
    claude,
    transcribeCalls: () => transcribeCalls,
  };
}

describe('Conversation', () => {
  let h: Harness;

  describe('push-to-talk turn', () => {
    beforeEach(() => {
      h = makeConversation({ pushToTalk: true });
    });

    it('runs the full pipeline and speaks each sentence', async () => {
      const recognized: string[] = [];
      const sentences: string[] = [];
      h.bus.on(VoiceEvent.SpeechRecognized, (r) => recognized.push(r.text));
      h.bus.on(VoiceEvent.SentenceCompleted, (s) => sentences.push(s.text));

      await h.conv.start();
      await h.conv.pushToTalkStart();
      await h.conv.pushToTalkStop();

      expect(recognized).toEqual(['build a todo app']);
      expect(h.claude.asked).toEqual(['build a todo app']);
      // Sentence events still fire per sentence (UI/plugins), but the whole
      // reply is synthesized and spoken as one continuous clip.
      expect(sentences).toEqual(['Sure thing.', 'All done now.']);
      expect(h.tts.spoken).toEqual(['Sure thing. All done now.']);
      expect(h.conv.currentState).toBe('idle');
    });

    it('ignores silent recordings without calling STT', async () => {
      h = makeConversation({ pushToTalk: true }, Buffer.alloc(3200));
      await h.conv.start();
      await h.conv.pushToTalkStart();
      await h.conv.pushToTalkStop();
      expect(h.transcribeCalls()).toBe(0);
      expect(h.claude.asked).toEqual([]);
    });
  });

  describe('streaming speech', () => {
    it('speaks in separate clips as generation streams', async () => {
      const bus = createBus();
      const tts = new FakeTts();
      const speech = new SpeechQueue({ provider: tts, sink: new NullSink(), bus });
      // A Claude that emits its two sentences with a gap between them, so the
      // first is spoken before the second arrives → two clips.
      const claude = {
        async ask(_prompt: string, opts: AskOptions = {}): Promise<AskResult> {
          opts.onToken?.('First sentence here. ');
          await new Promise((r) => setTimeout(r, 30));
          opts.onToken?.('Second sentence here. ');
          return {
            text: 'First sentence here. Second sentence here.',
            elapsedMs: 1,
            interrupted: false,
          };
        },
        terminate() {},
        resetSession() {},
        setModel() {},
        get session(): string | undefined {
          return undefined;
        },
      };
      const stt = {
        name: 'fake',
        async transcribe() {
          return { text: 'hi', latencyMs: 1 };
        },
        async healthCheck() {
          return { ok: true, message: 'fake' };
        },
      };
      const deps: ConversationDeps = {
        config: { ...DEFAULT_CONFIG, pushToTalk: true, streamSpeech: true },
        bus,
        recorder: new FakeRecorder(loudAudio()) as unknown as ConversationDeps['recorder'],
        stt,
        claude: claude as unknown as ConversationDeps['claude'],
        speech,
      };
      const conv = new Conversation(deps);
      await conv.onTalkKey();
      expect(tts.spoken).toEqual(['First sentence here.', 'Second sentence here.']);
    });

    it('falls back to one clip when streaming is disabled', async () => {
      h = makeConversation({ pushToTalk: true, streamSpeech: false });
      await h.conv.start();
      await h.conv.pushToTalkStart();
      await h.conv.pushToTalkStop();
      expect(h.tts.spoken).toEqual(['Sure thing. All done now.']);
    });
  });

  describe('autoSpeak disabled', () => {
    it('emits sentences but does not enqueue speech', async () => {
      h = makeConversation({ pushToTalk: true, autoSpeak: false });
      const sentences: string[] = [];
      h.bus.on(VoiceEvent.SentenceCompleted, (s) => sentences.push(s.text));

      await h.conv.start();
      await h.conv.pushToTalkStart();
      await h.conv.pushToTalkStop();

      expect(sentences).toEqual(['Sure thing.', 'All done now.']);
      expect(h.tts.spoken).toEqual([]);
    });
  });

  describe('continuous mode', () => {
    it('processes one utterance then stops cleanly', async () => {
      h = makeConversation({ pushToTalk: false });
      // Wait until the reply clip has finished playing.
      const finished = new Promise<void>((resolve) =>
        h.bus.on(VoiceEvent.SpeechFinished, () => resolve()),
      );
      const running = h.conv.start();
      await finished;
      await h.conv.stop();
      await running;

      expect(h.claude.asked).toEqual(['build a todo app']);
      expect(h.tts.spoken).toEqual(['Sure thing. All done now.']);
    });
  });

  describe('press-to-talk (onTalkKey)', () => {
    it('runs a full listen-once turn from idle', async () => {
      h = makeConversation({ pushToTalk: true });
      const recognized: string[] = [];
      h.bus.on(VoiceEvent.SpeechRecognized, (r) => recognized.push(r.text));

      await h.conv.onTalkKey(); // idle → capture (silence-endpointed) → process

      expect(recognized).toEqual(['build a todo app']);
      expect(h.claude.asked).toEqual(['build a todo app']);
      expect(h.tts.spoken).toEqual(['Sure thing. All done now.']);
      expect(h.conv.currentState).toBe('idle');
    });
  });

  it('interrupt is a no-op when idle', async () => {
    h = makeConversation();
    await expect(h.conv.interrupt()).resolves.toBeUndefined();
  });

  it('live setters update config without throwing', () => {
    h = makeConversation();
    expect(() => h.conv.setVoice('vidya')).not.toThrow();
    expect(() => h.conv.setModel('sonnet')).not.toThrow();
    expect(() => h.conv.setAutoSpeak(false)).not.toThrow();
    expect(() => h.conv.setSpeed(1.5)).not.toThrow();
    expect(() => h.conv.setLanguage('hi')).not.toThrow();
  });

  it('setSpeed / setLanguage are reflected on the next spoken reply', async () => {
    h = makeConversation({ pushToTalk: true });
    h.conv.setSpeed(1.5);
    h.conv.setLanguage('hi');
    await h.conv.onTalkKey();
    expect(h.tts.lastOptions?.speed).toBe(1.5);
    expect(h.tts.lastOptions?.language).toBe('hi');
  });
});
