# Installation guide

`claude-voice` needs four things on your machine:

1. **Node.js ≥ 18**
2. **The Claude CLI** (`claude`) — it is the conversational backend.
3. **A microphone recorder backend** (SoX / ALSA) for capturing audio.
4. **Provider API keys** for speech-to-text and text-to-speech.

This guide walks through each.

---

## 1. Node.js

Install Node 18 or newer from <https://nodejs.org> (or via `nvm`, `fnm`,
`volta`, etc.). Verify:

```bash
node --version   # v18.0.0 or higher
```

## 2. Claude CLI

`claude-voice` does **not** use the Claude API. It wraps the Claude CLI, so you
authenticate once with `claude` and `claude-voice` reuses that session.

```bash
# Install from https://claude.com/claude-code, then:
claude --version
```

If `claude` lives at a non-standard path, point `claude-voice` at it:

```bash
export CLAUDE_VOICE_CLI="/full/path/to/claude"
```

## 3. Audio backends

### Recording (microphone)

`claude-voice` records via [`node-record-lpcm16`](https://www.npmjs.com/package/node-record-lpcm16),
which shells out to a recorder program:

| Platform | Recommended | Install |
| --- | --- | --- |
| macOS | SoX | `brew install sox` |
| Debian / Ubuntu | ALSA + SoX | `sudo apt-get install sox libsox-fmt-all alsa-utils` |
| Fedora | SoX | `sudo dnf install sox` |
| Windows | SoX | [Download](https://sourceforge.net/projects/sox/), add to `PATH` |

On Linux the default backend is `arecord` (from `alsa-utils`); on macOS/Windows
it is `sox`. Override with:

```bash
export CLAUDE_VOICE_RECORDER=sox   # or "rec" / "arecord"
```

### Playback (speaker)

`claude-voice` plays audio through one of two backends, chosen automatically at
startup:

1. The native [`speaker`](https://www.npmjs.com/package/speaker) module (lowest
   latency). It is an **optional dependency** that compiles on install.
2. **A `sox` fallback** — if the native module isn't available, `claude-voice`
   pipes audio to sox's `play` command instead. Since you already install sox
   for the microphone, **playback works with no native compilation required.**

So in practice: **install sox and you have both recording and playback.** If you
also want the native `speaker` backend, ensure a working build toolchain:

| Platform | Requirement |
| --- | --- |
| macOS | Xcode Command Line Tools: `xcode-select --install` |
| Debian / Ubuntu | `sudo apt-get install build-essential libasound2-dev` |
| Windows | [`windows-build-tools`](https://github.com/nodejs/node-gyp#on-windows) |

> **Note:** native builds go through `node-gyp`, which needs a working Python.
> A broken Homebrew Python (e.g. a `pyexpat` import error) will fail the
> `speaker` build — in that case just rely on the sox fallback, or repair the
> toolchain with `brew reinstall expat` and a Python that loads `pyexpat`.

If neither backend is available, `claude-voice` prints a warning and continues
in text-only mode. `--no-speak` disables spoken output explicitly.

You can force a specific playback binary with `CLAUDE_VOICE_PLAYER` (default
`play`).

### macOS microphone permission

The first time you record, macOS asks for microphone access for your terminal
app. If you denied it, enable it under **System Settings → Privacy & Security →
Microphone**.

## 4. Provider API keys

Keys are read from the environment (never written to disk):

```bash
# Speech-to-text (choose one)
export GROQ_API_KEY="…"      # default; get one at https://console.groq.com
export OPENAI_API_KEY="…"    # if using --stt openai

# Text-to-speech
export ELEVENLABS_API_KEY="…"  # get one at https://elevenlabs.io
```

Add these to your shell profile (`~/.zshrc`, `~/.bashrc`) to persist them.

## 5. Install claude-voice

```bash
npm install -g @aayushdebugging/claude-voice
```

## 6. Verify

```bash
claude-voice doctor
```

You should see green checks for Node, Claude CLI, microphone, speaker, keys, and
internet. Fix anything red (each failure prints a hint), then:

```bash
claude-voice
```

---

## Installing from source

```bash
git clone https://github.com/claude-voice/claude-voice.git
cd claude-voice
npm install
npm run build
npm link          # makes `claude-voice` available globally
```

During development you can run without building:

```bash
npm run dev -- doctor
```
