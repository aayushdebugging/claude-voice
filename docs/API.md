# API documentation

`claude-voice` ships as an ES module with full TypeScript types. Everything the
CLI uses is exported from the package root.

```ts
import {
  createSession,
  loadConfig,
  VoiceEvent,
  SentenceParser,
  ClaudeClient,
} from '@aayushdebugging/claude-voice';
```

## Quick start

```ts
import { createSession, loadConfig } from '@aayushdebugging/claude-voice';

const config = await loadConfig({ model: 'opus', voice: 'river' });
const { conversation, bus } = createSession({ config });

bus.on(VoiceEvent.SpeechRecognized, ({ text }) => console.log('You:', text));
bus.on(VoiceEvent.ClaudeToken, ({ text }) => process.stdout.write(text));

await conversation.start();
```

## Configuration

```ts
loadConfig(overrides?: PartialConfig): Promise<VoiceConfig>
saveConfig(config: VoiceConfig): Promise<void>
updateConfig(mutate: (c: VoiceConfig) => void): Promise<VoiceConfig>
getApiKey(provider: 'groq' | 'openai' | 'elevenlabs'): string | undefined
```

`loadConfig` merges defaults ← `~/.claude-voice/config.json` ← `overrides`.

## Sessions

```ts
createSession(options: {
  config: VoiceConfig;
  bus?: VoiceBus;      // supply your own to attach listeners before start()
  sink?: AudioSink;    // override audio output (e.g. for tests)
}): { conversation: Conversation; bus: VoiceBus; deps: ConversationDeps }
```

### `Conversation`

```ts
conversation.start(): Promise<void>        // run until stop() (continuous)
conversation.stop(reason?): Promise<void>  // tear down everything
conversation.interrupt(): Promise<void>    // barge-in: abort turn + playback
conversation.pushToTalkStart(): Promise<void>
conversation.pushToTalkStop(): Promise<void>
conversation.currentState: ConversationState
```

## Events

Subscribe with the typed bus. `on` returns an unsubscribe function.

```ts
const off = bus.on(VoiceEvent.ClaudeToken, ({ text }) => { /* … */ });
off();
```

| Event | Payload |
| --- | --- |
| `UserStartedSpeaking` | — |
| `UserStoppedSpeaking` | `{ durationMs }` |
| `SpeechRecognized` | `{ text, language?, latencyMs }` |
| `ClaudeStarted` | `{ prompt }` |
| `ClaudeToken` | `{ text }` |
| `ClaudeFinished` | `{ text, elapsedMs }` |
| `SentenceCompleted` | `{ text, index }` |
| `SpeechStarted` / `SpeechFinished` | `{ text, index }` |
| `Interrupted` | `{ reason }` |
| `StateChanged` | `{ from, to }` |
| `Error` | `{ scope, error }` |
| `ConversationEnded` | `{ reason }` |

## The Claude client

Use it standalone to stream from the Claude CLI:

```ts
import { ClaudeClient } from '@aayushdebugging/claude-voice';

const claude = new ClaudeClient({ model: 'sonnet' });
const { text, elapsedMs } = await claude.ask('Explain WeakMap', {
  onToken: (t) => process.stdout.write(t),
});
```

`ClaudeClient` captures the CLI `session_id` and resumes it on subsequent
`ask()` calls, so multi-turn context is preserved. `terminate()` kills the
process for interruption.

## The sentence parser

```ts
import { SentenceParser } from '@aayushdebugging/claude-voice';

const parser = new SentenceParser({ minLength: 2 });
for (const s of parser.push('Hello. How are ')) console.log(s.text); // "Hello."
const tail = parser.flush(); // remaining buffered text
```

## Writing a custom STT provider

Implement `SttProvider`:

```ts
import type { SttProvider, TranscriptionOptions, TranscriptionResult } from '@aayushdebugging/claude-voice';

export class MyStt implements SttProvider {
  readonly name = 'mystt';
  async transcribe(opts: TranscriptionOptions): Promise<TranscriptionResult> {
    const text = await myApi(opts.audio); // opts.audio is a WAV Buffer
    return { text, latencyMs: 0 };
  }
  async healthCheck() {
    return { ok: true, message: 'mystt ready' };
  }
}
```

For OpenAI-compatible endpoints, extend `OpenAICompatibleStt` instead — you only
supply a base URL, model, and key.

## Writing a custom TTS provider

Implement `TtsProvider`. `synthesize` is an async generator yielding raw PCM
chunks so playback can start before synthesis finishes:

```ts
import type { TtsProvider, SynthesisOptions } from '@aayushdebugging/claude-voice';

export class MyTts implements TtsProvider {
  readonly name = 'mytts';
  readonly sampleRate = 24000;
  readonly channels = 1;
  readonly bitDepth = 16;

  async *synthesize(opts: SynthesisOptions): AsyncIterable<Buffer> {
    for await (const chunk of myStreamingApi(opts.text, opts.signal)) {
      yield chunk; // 16-bit little-endian PCM at `sampleRate`
    }
  }
  async healthCheck() {
    return { ok: true, message: 'mytts ready' };
  }
}
```

## Writing a plugin

```ts
import { PluginManager, VoiceEvent, type Plugin } from '@aayushdebugging/claude-voice';

function notifyPlugin(): Plugin {
  let off: (() => void) | undefined;
  return {
    name: 'notify',
    setup(ctx) {
      off = ctx.bus.on(VoiceEvent.ClaudeFinished, ({ text }) => {
        // e.g. send a desktop notification
        console.error('Claude replied:', text.slice(0, 40));
      });
    },
    teardown() {
      off?.();
    },
  };
}

const plugins = new PluginManager().register(notifyPlugin());
await plugins.setupAll({ bus, config, conversation });
```

Plugins receive the event bus (to react) and the conversation (to act, e.g.
`conversation.interrupt()`), enabling wake-words, clipboard sync, memory,
notifications, MCP bridges, and more — without modifying the core.
