# Architecture

`claude-voice` is built as a set of small, single-responsibility modules that
communicate through a **typed event bus**. Nothing in the core pipeline imports
the terminal UI, and providers depend only on interfaces — so a piece can be
swapped, tested, or observed without touching the rest.

## The conversation loop

```
                    ┌───────────────────────────────────────────────┐
                    │                 Event Bus                      │
                    │  (UserStartedSpeaking, SpeechRecognized,       │
                    │   ClaudeToken, SentenceCompleted, Speech*, …)  │
                    └───────────────────────────────────────────────┘
                        ▲        ▲          ▲            ▲       ▲
                        │        │          │            │      │
   ┌──────────┐   ┌───────────┐   ┌─────────────┐   ┌──────────────┐
   │  Mic     │──▶│    STT    │──▶│  Claude CLI │──▶│  Sentence    │
   │ Recorder │   │ (Whisper) │   │ (stream-json)│  │  Parser      │
   └──────────┘   └───────────┘   └─────────────┘   └──────────────┘
        ▲                                                  │
        │ barge-in                              ┌──────────┴───────────┐
        │ (interrupt)                           ▼                      ▼
   ┌──────────┐   ┌───────────┐   ┌──────────────┐         ┌───────────────┐
   │ Speakers │◀──│  Speaker  │◀──│ Speech Queue │         │  Terminal UI  │
   │          │   │  (PCM)    │   │ (interruptible) ◀── TTS │ (live tokens) │
   └──────────┘   └───────────┘   └──────────────┘         └───────────────┘
```

1. **Mic Recorder** (`src/audio/recorder.ts`) captures 16-bit PCM. In continuous
   mode it waits for speech, then records until a silence gap; in push-to-talk
   mode it records between key presses.
2. **STT** (`src/stt/`) wraps the audio in WAV and posts it to an
   OpenAI-compatible transcription endpoint (Groq by default).
3. **Claude CLI** (`src/claude/`) spawns `claude -p --output-format stream-json
   --include-partial-messages` and parses the newline-delimited events, emitting
   `ClaudeToken` deltas as they stream. The session id is captured and resumed
   for multi-turn continuity.
4. **Sentence Parser** (`src/utils/sentence-parser.ts`) accumulates tokens and
   emits a `SentenceCompleted` the moment a sentence boundary is confirmed.
5. **Terminal UI** (`src/cli/ui.ts`) prints tokens live and renders phase
   spinners — it only *listens* to the bus.
6. **Speech Queue** (`src/tts/speech-queue.ts`) synthesizes each sentence via
   TTS and plays it through the **Speaker**, one at a time. It is fully
   interruptible.
7. **Barge-in** — when the user talks (or presses SPACE), the `Conversation`
   aborts the in-flight Claude process and the speech queue, then resumes
   listening.

## Module map

```
src/
├── cli/         # Terminal presentation: commander entry, UI, keyboard
├── commands/    # One file per CLI command (run, doctor, config, update, version)
├── core/        # Conversation state machine + session composition root
├── audio/       # Microphone capture, speaker playback, sink interface
├── stt/         # Speech-to-text providers (Groq, OpenAI) + factory
├── tts/         # Text-to-speech (ElevenLabs) + interruptible speech queue
├── claude/      # Claude CLI process wrapper + stream-json parser
├── config/      # Load/save/merge config; path + credential resolution
├── events/      # Typed event bus + event contracts
├── plugins/     # Plugin manager + example transcript plugin
├── utils/       # Sentence parser, WAV, speakable text, errors, logger, async
└── types/       # Shared interfaces (the module contracts)
```

## Design principles

**Event-driven, not call-driven.** Modules emit and subscribe to events on a
`TypedEventBus`. The core never calls the UI; the UI never drives the core. This
makes the pipeline observable (great for testing) and pluggable.

**Providers are interfaces.** `SttProvider` and `TtsProvider` are small
contracts. A factory (`createSttProvider` / `createTtsProvider`) is the only
place that knows concrete provider names, so adding one is a local change.

**Streaming everywhere.** Nothing waits for a whole response. Tokens stream from
Claude, sentences stream to TTS, PCM chunks stream to the speaker. Perceived
latency is the time to the *first sentence*, not the last.

**Fail soft.** Optional native modules (`speaker`, `node-record-lpcm16`) are
lazy-loaded and degrade gracefully. Provider and CLI errors are typed
(`VoiceError` and subclasses) and surfaced as `Error` events — the process
never crashes on a recoverable failure.

**Composition root.** `createSession()` (`src/core/session.ts`) is the single
place that wires concrete implementations together. Everything else receives its
dependencies, which is what makes the unit tests possible.

## Interruption model

Each conversational turn owns an `AbortController`. Interrupting:

1. aborts the turn signal (stops `captureUntilSilence` / the Claude `ask`),
2. terminates the Claude child process (`SIGTERM`, then `SIGKILL`),
3. aborts the current TTS request and clears the speech queue,
4. destroys the active speaker stream for an instant audio cut.

In continuous mode the listen loop then starts a fresh turn automatically.

## Extending

- **Add an STT/TTS provider:** implement the interface in `src/types/`, register
  it in the relevant factory, and add its name to the union type.
- **Add a plugin:** implement `Plugin` and register it with the `PluginManager`.
  Plugins get the bus (to react) and the conversation (to act).

See [API.md](./API.md) for concrete examples.
