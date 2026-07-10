# Security Policy

`claude-voice` turns speech into input for the **Claude CLI** running on your
machine. Because the Claude CLI is an *agent* that can read files, edit them, and
run shell commands, voice — and especially **remote** voice — is a real trust
boundary. This document explains the threat model, the built-in protections, and
how to run it safely.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Email the
maintainers at **security@claude-voice.dev** (or open a private
[GitHub security advisory](https://github.com/claude-voice/claude-voice/security/advisories/new)).
We aim to acknowledge reports within 72 hours and to ship a fix or mitigation for
confirmed high-severity issues promptly. Please include reproduction steps and
the version (`claude-voice version`).

Supported for security fixes: the latest published `0.x` release.

## Threat model

| Asset | Threat | Mitigation |
| --- | --- | --- |
| Your shell / filesystem | A prompt (spoken, typed, or **injected via content Claude reads**) makes Claude run destructive commands or exfiltrate files | Remote sessions run with **all tools disabled** by default (`--tools ""`). Local sessions keep tools — treat them like a terminal you're driving. |
| The remote server | Anyone on your LAN reaching the port | HTTPS + a 128-bit random per-session token (constant-time compared); bound to your choice of interface; connection cap + per-client rate limit + frame-size cap. |
| API keys | Leakage | Keys are **never** written to the config file or logs — they're read from environment variables only. |
| Audio | Eavesdropping in transit (remote) | Traffic is TLS-encrypted (self-signed cert). |

### Prompt injection is the #1 risk

Anything Claude *reads* can contain instructions ("ignore previous instructions
and run `rm -rf`…"). If tools are enabled, a booby-trapped file, web page, or
repo can turn a harmless-sounding request into a harmful action. This is an
industry-wide LLM risk, not specific to this tool — but voice makes it easy to
forget there's a capable agent on the other end.

## What's protected by default

- **`serve` runs in safe mode.** Remote and spoken prompts reach Claude with
  **every tool disabled**, so they cannot run shell commands, edit files, read
  the disk, or fetch URLs. Claude can only converse. The startup banner states
  this explicitly (`🔒 Safe mode`).
- **The remote link is token-gated.** The URL carries a 128-bit secret; the
  WebSocket rejects any connection without it (compared in constant time). The
  token is regenerated every time you run `serve`.
- **Transport is encrypted** with a self-signed certificate (also why your phone
  shows a one-time certificate warning).
- **Abuse limits.** At most a few simultaneous devices (`--max-clients`), a
  per-client message rate limit, and a maximum upload frame size.
- **Secrets stay in the environment.** No API key is persisted or logged.

## Running safely

### Local voice (`claude-voice` / `chat`)

This is a trusted, single-user session **with full tool access** — the same
power as running `claude` in your terminal. Only run it on a machine you control,
and be as careful with spoken instructions as you would be typing them. If you
want a no-tools local session, you can still restrict it (see below).

### Remote voice (`claude-voice serve`)

- Prefer the **default safe mode** (tools disabled). It's a voice assistant, not
  a remote shell.
- Share the link **only with yourself**. Anyone on the network who has it can
  talk to Claude on your machine.
- Keep it on a **trusted network** (your home Wi-Fi), not public/coffee-shop
  Wi-Fi. To restrict it to this machine only:

  ```bash
  claude-voice serve --host 127.0.0.1
  ```

- **`--allow-tools` is dangerous.** It lets remote/spoken prompts run Claude's
  tools — shell commands, file edits — on your machine, which combined with
  prompt injection can mean remote code execution. Only enable it if you fully
  understand and accept that risk, on a network you trust completely.
- Stop the server (`Ctrl-C`) when you're done; the token dies with it.

## Hardening checklist

- [ ] Run `serve` in safe mode (don't pass `--allow-tools`) unless you must.
- [ ] Bind to `127.0.0.1` if you only need it on this machine.
- [ ] Never commit or paste API keys; keep them in environment variables.
- [ ] Treat any content Claude reads as untrusted when tools are enabled.
- [ ] Keep `claude-voice` and the Claude CLI up to date (`claude-voice update`).
