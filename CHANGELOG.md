# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **`serve` runs in safe mode by default.** A network-exposed voice session now
  reaches Claude with **all tools disabled** (`--tools ""`), so a remote or
  spoken prompt can no longer run shell commands, edit files, read the disk, or
  fetch URLs — it can only converse. Opt back in with `--allow-tools` (clearly
  flagged as dangerous). The startup banner states the current tool mode.
- **Remote hardening.** The WebSocket token is now compared in constant time; the
  server caps simultaneous devices (`--max-clients`), rate-limits messages per
  client, bounds the maximum frame size, and accepts `--host` (e.g.
  `127.0.0.1`) to keep the server on this machine only.
- Added **`SECURITY.md`** with the threat model (prompt injection as the #1
  risk), the built-in protections, and a safe-use checklist, plus a Security
  section in the README and a vulnerability-reporting process.

### Added

- **`claude-voice local` auto-downloads the whisper model.** The whisper.cpp
  model (~150 MB) is now fetched for you with a progress bar (matching Kokoro,
  which self-downloads), streamed to disk via a `.part` file + atomic rename so
  an interrupted download never leaves a broken model. `--no-download` opts out
  and prints the `curl` command instead. New `downloadFile` utility.
- **Startup boot animation.** A quick animated boot sequence — a shimmering
  `✦ Claude Voice AI ✦` logo with system checks (STT/TTS/Claude/audio) lighting
  up one-by-one — plays before the live UI, then hands off and starts the
  pipeline. Any key skips it.
- **The phone (`serve`) client got the treatment.** Rebranded as **Claude Voice
  AI** with the same gradient palette, a **live waveform** (Web Audio
  AnalyserNode → canvas) that reacts to your mic while recording and to the
  reply while it plays, a gradient hold-to-talk button, and a pulsing
  connection-status dot.
- **Rebranded, animated "Claude Voice AI" TUI.** A gradient-branded header
  (amber→pink→violet→blue) with provider **chips** (`groq ▸ claude(opus) ▸
  sarvam:priya`), a live **audio waveform** that reacts to your mic while
  listening and dances while speaking, a spinner that shimmers through the brand
  palette, and a **flowing-gradient `✦ Claude Voice AI ✦` watermark** that
  animates while active (static when idle). Brighter role labels (`❯ You`,
  `✦ Claude`); the plain fallback UI is brand-colored too.
- **Speak as Claude writes (streaming speech).** Replies are now spoken
  sentence-by-sentence *as they generate* instead of only after the whole reply
  finishes, so audio starts right after the first sentence — a big latency win on
  long answers. A synthesis loop renders sentences *ahead* of a playback loop
  (`SpeechQueue.beginStream`/`push`/`endStream`). With `ffmpeg` installed, the
  audio is fed into a **single persistent stream** (`ffplay`, new
  `StreamingPlayer`) that waits during pauses instead of reopening the device —
  so playback is **gapless**. Without a streaming player it falls back to a few
  back-to-back `afplay` clips (a small inter-clip seam), and `--no-stream` speaks
  the whole reply at once. sox `play` is deliberately not used for streaming: it
  truncates on the first feed gap (the real cause of the earlier breakage).
  Toggle with `--no-stream` / `/stream` / `streamSpeech`
  (`Conversation.setStreamSpeech`).
- **Voice-friendly answers.** A default system prompt (`voicePrompt`, appended
  via the CLI's `--append-system-prompt`) steers Claude to answer the way you'd
  explain something out loud — lead with the answer, short spoken sentences, no
  code blocks/tables/markdown read aloud — which both sounds better and streams
  more smoothly. Set `voicePrompt` to `""` to disable.
- **Live speech-rate control.** New `/speed <0.5–3.0>` command, `--speed` flag,
  and `speechRate` config set how fast replies are spoken (`Conversation.setSpeed`).
  Mapped to each backend — Sarvam `pace`, OpenAI/Kokoro `speed` — and the bundled
  local Kokoro server now honours `speed` (previously hard-coded to 1.0).
- **Language switching.** New `/lang <code>` command and `Conversation.setLanguage`
  change the language for **both** transcription and speech on the fly; `--language`
  now drives TTS too. Sarvam maps short codes to its `xx-IN` form, Kokoro receives
  a `lang` (previously hard-coded to `en-us`). Switching to a non-English language
  on the English-only local whisper model prints a hint to use a multilingual one.
- **`--local` shortcut** for `--stt whispercpp --tts kokoro`.
- **Remote Stop button.** The phone client can now cut off a reply: it stops local
  playback and sends a `cancel` message that aborts generation/synthesis on the
  server. Starting to talk also barges in on the current reply.
- **Fully-local, $0 provider stack** — run offline with no API keys: `whispercpp` STT (a running `whisper.cpp` server; new `WhisperCppStt`) and `kokoro` TTS (any OpenAI-compatible `/v1/audio/speech` server like `kokoro-fastapi`; new `OpenAICompatibleTts` + `KokoroTts`). `claude-voice local` reports status and prints exact setup/run commands; `doctor` and preflight no longer require keys for local providers (`needsApiKey`). Switch with `--stt whispercpp --tts kokoro`.
- **Remote voice client (`claude-voice serve`)** — host a token-protected voice session on your local network and open the printed link (or scan the QR) on your phone. Hold-to-talk from the phone; your speech is transcribed here, sent to Claude, and the reply streams back as text and plays aloud through the phone. Served over HTTPS (self-signed) so mobile browsers grant mic access on the LAN; each connection gets its own Claude session. New `src/remote/` module and `renderSpeechWav` helper.
- **Rich Ink terminal UI** (like Claude Code): boxed header, `<Static>` scrollback transcript, live token streaming, and a status bar with a spinner and elapsed timer. Falls back to a plain streaming UI for non-TTY output or `CLAUDE_VOICE_PLAIN=1`.
- **Type-to-chat**: press `t` in a session to type a message instead of speaking (`Conversation.sendText`). Works even without a microphone.
- **Command palette**: press `/` for `/help`, `/clear`, `/mute`, `/speak`, `/voice <name>`, `/quit` — with live suggestions. Voice and mute changes apply mid-session (`Conversation.setVoice` / `setAutoSpeak`, `SpeechQueue.setVoice`).
- **Live throughput**: the status bar shows word count and words/sec while Claude streams, and each reply is tagged with its duration and length.
- **Live mic-level meter**: while listening, the status bar shows a VU-style bar (green when it hears you, empty when silent) via a new `AudioLevel` event — so you can see the mic is working.
- **`say` command**: `claude-voice say "…"` speaks a phrase aloud with the configured voice — handy for testing output without the mic.
- **`FilePlayer`** — robust playback that renders the reply to a temp WAV and plays it with one native player (`afplay`/`ffplay`/`play`/`aplay`). No native build, no per-sentence process churn. Now the default output.
- Sarvam AI text-to-speech provider (`--tts sarvam`); default upgraded to **`bulbul:v3`** (higher quality, 2500-char limit, 35+ voices). Speaker resolution is model-aware, so a voice from the wrong model can never 400.
- `sox` playback fallback (`SoxPlayer`) and a `speaker`-module sink remain available.
- Microphone no-audio detection: the app (and `doctor`) now detect a silent mic (missing permission) and explain how to fix it instead of hanging.
- Manual endpointing: SPACE ends the current capture and sends immediately.
- `extractPcmFromWav` / `averageAmplitude` audio utilities.

### Fixed

- **No longer crashes when the microphone backend (`sox`) is missing.** A missing
  `sox` used to emit an unhandled `ENOENT` on the recorder's child process and
  take the whole app down. The backend binary is now checked before spawning, so
  you get a friendly "install sox" message (plus a startup notice) instead of a
  stack trace.
- **Streaming speech no longer gaps at paragraph breaks.** A short playback
  prebuffer (~0.8s of audio) is built before speech starts, so a brief pause in
  generation at a blank-line/paragraph boundary doesn't drain the stream and
  open an audible silence.
- **Speech no longer breaks mid-reply.** Replaced the fragile design (a new `sox` process per sentence, streaming raw PCM over stdin) that caused dropouts and cut-offs. The full reply is now synthesized (chunked to the provider limit and concatenated) and played as **one continuous clip via a single file player** (`afplay` et al.) after generation completes — robust, gapless, and it always speaks the whole response.
- **Quiet microphones now work.** Speech detection adapts to the room's noise floor (with a configurable `micSensitivity` floor, default 150, down from a fixed 350), and captured audio is auto-gained (`normalizePcm`) before transcription so a low-level mic still produces a signal Whisper can read. Removed a redundant second silence gate that discarded quiet-but-real speech.
- **False "no microphone audio" warnings.** Silence was detected by average loudness, which is low both for a permission-denied mic and for a working mic during a quiet pause — so the app nagged users to grant permission they'd already granted. Detection now uses peak amplitude (`peakAmplitude`): a working mic always has ambient peaks well above zero, while a denied mic is digital silence (~0). The permission hint now only appears when the mic truly produces no signal.

### Changed

- **Press-to-talk**: SPACE is now a single state-aware key — tap to start talking, and it auto-stops on silence and transcribes (tap again to send early or to interrupt). Replaces the fragile start/stop toggle (`Conversation.onTalkKey` / `listenOnce`).
- **Speak the whole reply, once.** Generation and speech are now sequential phases: Claude's answer streams to the screen, and once complete it's read aloud as one clip. (Low-latency parallel speaking was tried but proved fragile; batch playback is reliable.) Sarvam requests retry transient failures; code-only replies get a short spoken note.
- Added `/model <name>` command and ↑/↓ prompt history for typed input.
- Default TTS pace is slightly faster (Sarvam `pace: 1.15`).
- Keyboard handling is hardened against terminal escape sequences (no more accidental quit on startup); quit is `q` / Ctrl-C / Ctrl-D.
- ElevenLabs error hints now distinguish billing/quota problems from bad keys.
- `doctor` records a short sample to verify the mic actually produces audio, and reports which playback backend is active (native speaker vs sox fallback).

## [0.1.0] - 2026-07-08

### Added

- Initial release. 🎉
- Real-time voice conversations with the Claude CLI.
- Continuous listening with silence detection and push-to-talk mode.
- Groq Whisper (default) and OpenAI-compatible speech-to-text providers.
- ElevenLabs streaming text-to-speech with an interruptible speech queue.
- Streaming sentence parser that speaks responses as they are generated.
- Full barge-in: interrupt playback and generation and start listening again.
- Typed, event-driven core with a plugin API for extensibility.
- Polished terminal UI with phase spinners, live token streaming, and timings.
- `config`, `doctor`, `update`, `chat`, and `version` commands.
- Programmatic library API for embedding voice in other tools.

[Unreleased]: https://github.com/claude-voice/claude-voice/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/claude-voice/claude-voice/releases/tag/v0.1.0
