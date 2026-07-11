import { describe, it, expect, beforeEach } from 'vitest';

import { SpeechQueue } from '../src/tts/speech-queue.js';
import { createBus, VoiceEvent } from '../src/events/index.js';
import type { AudioSink } from '../src/audio/sink.js';
import type { SynthesisOptions, TtsProvider } from '../src/types/index.js';

/** A fake TTS provider that yields PCM chunks with cooperative aborts. */
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
    for (let i = 0; i < 3; i++) {
      if (options.signal?.aborted) return;
      await new Promise((r) => setTimeout(r, 1)); // let interrupts land mid-stream
      yield Buffer.from([i, i]);
    }
  }

  async healthCheck() {
    return { ok: true, message: 'fake' };
  }
}

/** A fake sink that records the lifecycle calls it receives. */
class FakeSink implements AudioSink {
  events: string[] = [];
  writtenBytes = 0;
  begin() {
    this.events.push('begin');
  }
  write(chunk: Buffer) {
    this.writtenBytes += chunk.length;
  }
  async end() {
    this.events.push('end');
  }
  stop() {
    this.events.push('stop');
  }
}

/** A persistent (streaming) fake sink: plays as written, one device. */
class StreamingFakeSink extends FakeSink {
  readonly streaming = true;
}

describe('SpeechQueue (batch speak)', () => {
  let tts: FakeTts;
  let sink: FakeSink;
  let bus: ReturnType<typeof createBus>;
  let queue: SpeechQueue;

  beforeEach(() => {
    tts = new FakeTts();
    sink = new FakeSink();
    bus = createBus();
    queue = new SpeechQueue({ provider: tts, sink, bus });
  });

  it('synthesizes text and plays it as one clip', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    bus.on(VoiceEvent.SpeechStarted, (s) => started.push(s.index));
    bus.on(VoiceEvent.SpeechFinished, (s) => finished.push(s.index));

    await queue.speak('Hello there.');

    expect(tts.spoken).toEqual(['Hello there.']);
    expect(started).toEqual([0]);
    expect(finished).toEqual([0]);
    // One playback segment (one begin, one end) — not one per sentence.
    expect(sink.events).toEqual(['begin', 'end']);
    expect(queue.isSpeaking).toBe(false);
  });

  it('chunks long text but plays a single continuous clip', async () => {
    const q = new SpeechQueue({ provider: tts, sink, bus, maxChunkChars: 20 });
    await q.speak('First sentence here. Second sentence here. Third one here.');
    // Multiple synth requests (chunked)…
    expect(tts.spoken.length).toBeGreaterThan(1);
    // …but still exactly one playback segment.
    expect(sink.events).toEqual(['begin', 'end']);
  });

  it('interrupt aborts synthesis and cuts playback', async () => {
    let interrupted = false;
    bus.on(VoiceEvent.Interrupted, () => (interrupted = true));

    const speaking = queue.speak('A long thing to say.');
    await new Promise((r) => setTimeout(r, 1)); // let synthesis start
    await queue.interrupt();
    await speaking;

    expect(interrupted).toBe(true);
    expect(sink.events).toContain('stop');
    expect(queue.isSpeaking).toBe(false);
  });

  it('empty / whitespace text is a no-op', async () => {
    await queue.speak('   ');
    expect(tts.spoken).toEqual([]);
    expect(sink.events).toEqual([]);
  });

  it('threads voice, speed, and language into synthesis', async () => {
    const q = new SpeechQueue({
      provider: tts,
      sink,
      bus,
      voice: 'priya',
      speed: 1.25,
      language: 'hi',
    });
    await q.speak('Hello.');
    expect(tts.lastOptions?.voice).toBe('priya');
    expect(tts.lastOptions?.speed).toBe(1.25);
    expect(tts.lastOptions?.language).toBe('hi');
  });

  it('setSpeed / setLanguage apply to the next utterance', async () => {
    queue.setSpeed(2);
    queue.setLanguage('es');
    await queue.speak('Hola.');
    expect(tts.lastOptions?.speed).toBe(2);
    expect(tts.lastOptions?.language).toBe('es');
  });

  it('interrupt is safe when idle', async () => {
    await expect(queue.interrupt()).resolves.toBeUndefined();
  });
});

describe('SpeechQueue (streaming)', () => {
  let tts: FakeTts;
  let bus: ReturnType<typeof createBus>;

  beforeEach(() => {
    tts = new FakeTts();
    bus = createBus();
  });

  it('canStream is supported (streaming layers over clip playback)', () => {
    expect(new SpeechQueue({ provider: tts, sink: new FakeSink(), bus }).canStream).toBe(true);
  });

  it('renders one clause at a time even when several are already queued (no greedy batch)', async () => {
    const sink = new FakeSink();
    const q = new SpeechQueue({ provider: tts, sink, bus });
    let started = 0;
    let finished = 0;
    bus.on(VoiceEvent.SpeechStarted, () => started++);
    bus.on(VoiceEvent.SpeechFinished, () => finished++);

    await q.beginStream();
    q.push('One.');
    q.push('Two.');
    await q.endStream();

    // Both clauses were queued before synthesis ran, but they must NOT collapse
    // into a single clip — each renders on its own so the first plays as early as
    // possible. (Greedy batching here was the cause of speech only starting once
    // the whole reply had finished synthesizing.)
    expect(tts.spoken).toEqual(['One.', 'Two.']);
    expect(sink.events).toEqual(['begin', 'end', 'begin', 'end']);
    // Start/finish still bracket the whole stream exactly once.
    expect(started).toBe(1);
    expect(finished).toBe(1);
    expect(q.isSpeaking).toBe(false);
  });

  it('plays sentences as separate clips when they arrive spread out', async () => {
    const sink = new FakeSink();
    const q = new SpeechQueue({ provider: tts, sink, bus });

    await q.beginStream();
    q.push('One.');
    await new Promise((r) => setTimeout(r, 20)); // let the first clip synth + play
    q.push('Two.');
    await q.endStream();

    // First was spoken before the second arrived → two clips, in order.
    expect(tts.spoken).toEqual(['One.', 'Two.']);
    expect(sink.events).toEqual(['begin', 'end', 'begin', 'end']);
  });

  it('a persistent sink plays the whole reply as ONE open device (gapless)', async () => {
    const sink = new StreamingFakeSink();
    const q = new SpeechQueue({ provider: tts, sink, bus });

    await q.beginStream();
    q.push('One.');
    await new Promise((r) => setTimeout(r, 20)); // first clip streams in
    q.push('Two.');
    await q.endStream();

    // Two sentences synthesized as they arrive…
    expect(tts.spoken).toEqual(['One.', 'Two.']);
    // …but written into a SINGLE begin…end stream (no per-clip reopen).
    expect(sink.events).toEqual(['begin', 'end']);
    expect(sink.writtenBytes).toBeGreaterThan(0);
  });

  it('interrupt during streaming cuts playback and emits Interrupted', async () => {
    const sink = new FakeSink();
    const q = new SpeechQueue({ provider: tts, sink, bus });
    let interrupted = false;
    bus.on(VoiceEvent.Interrupted, () => (interrupted = true));

    await q.beginStream();
    q.push('A long thing to say.');
    await new Promise((r) => setTimeout(r, 1)); // let synthesis start
    await q.interrupt();

    expect(interrupted).toBe(true);
    expect(sink.events).toContain('stop');
    expect(q.isSpeaking).toBe(false);
  });

  it('push after the stream ends is a no-op', async () => {
    const sink = new FakeSink();
    const q = new SpeechQueue({ provider: tts, sink, bus });
    await q.beginStream();
    await q.endStream();
    q.push('too late');
    expect(tts.spoken).toEqual([]);
  });
});
