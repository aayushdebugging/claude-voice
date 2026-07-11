import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { ClaudeError } from '../utils/errors.js';
import { VoiceEvent, type VoiceBus } from '../events/index.js';
import type { ClaudeOptions } from '../types/index.js';
import { parseStreamJsonLine, type ClaudeStreamEvent } from './stream-parser.js';

export interface ClaudeClientOptions extends ClaudeOptions {
  /** Executable to invoke. Defaults to `claude` (or `$CLAUDE_VOICE_CLI`). */
  bin?: string;
  bus?: VoiceBus;
  /**
   * Restrict the tools available to Claude for this session (forwarded to the
   * CLI's `--tools`). An empty array disables ALL tools — the safe mode used for
   * network-exposed (`serve`) sessions so a spoken/remote prompt can never make
   * Claude run a shell command, edit files, or read the disk. Omit to leave the
   * full tool set available (default; used for local, trusted sessions).
   */
  tools?: string[];
  /**
   * Extra system prompt appended to Claude's default (via
   * `--append-system-prompt`). Used to steer replies to be voice-friendly.
   */
  appendSystemPrompt?: string;
}

export interface AskOptions {
  /** Abort to interrupt generation; the process is killed and respawned next turn. */
  signal?: AbortSignal;
  /** Called for each streamed text delta. */
  onToken?: (text: string) => void;
}

export interface AskResult {
  text: string;
  elapsedMs: number;
  costUsd?: number;
  /** True when generation was interrupted before completing. */
  interrupted: boolean;
}

/** Callbacks the persistent stdout reader drives for the one in-flight turn. */
interface ActiveTurn {
  onEvent(event: ClaudeStreamEvent): void;
  onExit(code: number | null, err?: Error): void;
}

/**
 * Wraps the Claude CLI as a streaming conversational backend.
 *
 * A single long-lived `claude` process is kept alive across turns via the CLI's
 * streaming-input mode (`--input-format stream-json`). The process — and the
 * project context it loads at startup — is paid for once; each turn is then just
 * a JSON message written to its stdin, so follow-up turns begin speaking in about
 * a second instead of re-paying several seconds of CLI startup + context loading
 * on every message (the dominant source of first-word latency).
 *
 * Barge-in kills the process; the next turn respawns it with `--resume` so the
 * conversation continues seamlessly. A crashed or missing CLI surfaces a typed
 * {@link ClaudeError} instead of taking the app down.
 */
export class ClaudeClient {
  private readonly bin: string;
  private readonly options: ClaudeClientOptions;
  private readonly bus?: VoiceBus;
  private sessionId?: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private turnProc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private stderrTail = '';
  private turn: ActiveTurn | null = null;
  private disposed = false;

  constructor(options: ClaudeClientOptions = {}) {
    this.bin = options.bin ?? process.env.CLAUDE_VOICE_CLI ?? 'claude';
    this.options = options;
    this.bus = options.bus;
  }

  /** The Claude session id captured from the CLI (undefined before first ask). */
  get session(): string | undefined {
    return this.sessionId;
  }

  private buildArgs(): string[] {
    const args = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    if (this.options.model) args.push('--model', this.options.model);
    if (this.options.appendSystemPrompt) {
      args.push('--append-system-prompt', this.options.appendSystemPrompt);
    }
    // After a respawn (e.g. following a barge-in), resume the prior conversation
    // so continuity survives even though the previous process was killed.
    if (this.sessionId) args.push('--resume', this.sessionId);
    if (this.options.extraArgs) args.push(...this.options.extraArgs);
    // Tool restriction goes last: `--tools` is variadic, so keeping it at the
    // end avoids it swallowing later flags. `[]` → `--tools ""` disables all
    // tools; a non-empty list restricts to exactly those.
    if (this.options.tools) args.push('--tools', this.options.tools.join(','));
    return args;
  }

  /** Spawn the persistent process if it isn't already running. */
  private ensureProc(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const child = spawn(this.bin, this.buildArgs(), {
      cwd: this.options.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = child;
    this.stdoutBuffer = '';
    this.stderrTail = '';

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (data: string) => this.readStdout(data));
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (data: string) => {
      this.stderrTail = (this.stderrTail + data).slice(-2000);
    });
    // A broken pipe (killed mid-turn) must never crash the app.
    child.stdin.on('error', () => {});
    child.on('error', (err) => this.handleProcEnd(child, null, this.spawnError(err)));
    child.on('close', (code) => this.handleProcEnd(child, code));
    return child;
  }

  /** Parse the persistent process's newline-delimited output and route events. */
  private readStdout(data: string): void {
    this.stdoutBuffer += data;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      newline = this.stdoutBuffer.indexOf('\n');
      const event = parseStreamJsonLine(line);
      if (!event) continue;
      // Capture the session id from any event that carries one, so a respawn can
      // `--resume` the conversation.
      const sid = (event as { sessionId?: string }).sessionId;
      if (sid) this.sessionId = sid;
      this.turn?.onEvent(event);
    }
  }

  private handleProcEnd(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    err?: Error,
  ): void {
    if (this.proc === child) this.proc = null;
    // Only finalize the turn if it belongs to the process that just ended — a
    // stale kill (barge-in, then a new process already spawned) must not touch
    // the new turn.
    if (this.turnProc === child) {
      const turn = this.turn;
      this.turn = null;
      this.turnProc = null;
      turn?.onExit(code, err);
    }
  }

  /**
   * Send a prompt to Claude and stream the response. Resolves with the full text
   * once the turn completes (or is interrupted).
   */
  ask(prompt: string, opts: AskOptions = {}): Promise<AskResult> {
    return new Promise<AskResult>((resolve, reject) => {
      if (this.disposed) {
        reject(new ClaudeError('Claude client has been disposed.'));
        return;
      }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.ensureProc();
      } catch (err) {
        reject(this.spawnError(err));
        return;
      }

      const start = performance.now();
      let streamed = '';
      let resultText: string | null = null;
      let costUsd: number | undefined;
      let sawDelta = false;
      let interrupted = false;
      let settled = false;

      const emitText = (text: string): void => {
        if (!text) return;
        streamed += text;
        opts.onToken?.(text);
        this.bus?.emit(VoiceEvent.ClaudeToken, { text });
      };

      const finalize = (err?: Error): void => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener('abort', onAbort);
        if (this.turn === thisTurn) {
          this.turn = null;
          this.turnProc = null;
        }
        const elapsedMs = Math.round(performance.now() - start);
        if (err) {
          reject(err);
          return;
        }
        const text = (resultText ?? streamed).trim();
        this.bus?.emit(VoiceEvent.ClaudeFinished, { text, elapsedMs });
        resolve({ text, elapsedMs, costUsd, interrupted });
      };

      const onAbort = (): void => {
        interrupted = true;
        this.terminate();
        // Resolve immediately as interrupted; don't wait for the process to die.
        finalize();
      };

      const thisTurn: ActiveTurn = {
        onEvent: (event) => {
          switch (event.kind) {
            case 'delta':
              sawDelta = true;
              emitText(event.text);
              break;
            case 'assistant':
              // Only a fallback when token deltas are unavailable.
              if (!sawDelta) emitText(event.text);
              break;
            case 'result':
              costUsd = event.costUsd;
              resultText = event.text || streamed;
              finalize();
              break;
            // init / other: session id already captured by the reader.
          }
        },
        onExit: (code, err) => {
          if (interrupted) {
            finalize();
            return;
          }
          if (err) {
            finalize(err);
            return;
          }
          // The process died mid-turn. If we got nothing, surface an error;
          // otherwise resolve with the partial text we did receive.
          if (code !== 0 && resultText === null && streamed.length === 0) {
            finalize(
              new ClaudeError(
                `Claude CLI exited with code ${code ?? 'unknown'}.` +
                  (this.stderrTail ? `\n${this.stderrTail.trim()}` : ''),
                'Run `claude-voice doctor` to verify the Claude CLI is working.',
              ),
            );
            return;
          }
          finalize();
        },
      };
      this.turn = thisTurn;
      this.turnProc = child;

      if (opts.signal) {
        if (opts.signal.aborted) {
          interrupted = true;
        } else {
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      this.bus?.emit(VoiceEvent.ClaudeStarted, { prompt });
      const message = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      });
      try {
        child.stdin.write(`${message}\n`);
      } catch {
        // stdin may already be closing if the process just died; the close/error
        // handler finalizes the turn.
      }
      // Aborted before we could even write → tear down now.
      if (interrupted) onAbort();
    });
  }

  /**
   * Kill the running process (used for barge-in). The next {@link ask} respawns
   * it with `--resume`, so the conversation continues from where it left off.
   */
  terminate(): void {
    const child = this.proc;
    if (!child) return;
    this.proc = null;
    try {
      child.kill('SIGTERM');
      // Escalate if it ignores the polite signal.
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 1500).unref?.();
    } catch {
      // already gone
    }
  }

  /** Forget the session and drop the process so the next ask starts fresh. */
  resetSession(): void {
    this.sessionId = undefined;
    this.terminate();
  }

  /** Change the model used for subsequent turns (respawns the process). */
  setModel(model: string): void {
    this.options.model = model;
    this.terminate();
  }

  /**
   * Pre-spawn the process so the first turn doesn't pay startup + context-load
   * latency. Safe to call once when the session starts; a no-op if already up.
   */
  warmUp(): void {
    if (this.disposed || this.proc) return;
    try {
      this.ensureProc();
    } catch {
      // A warm-up failure is non-fatal; the first ask surfaces the real error.
    }
  }

  /** Permanently shut the client and its process down. */
  dispose(): void {
    this.disposed = true;
    this.terminate();
  }

  private spawnError(err: unknown): ClaudeError {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return new ClaudeError(
        `Claude CLI not found (tried "${this.bin}").`,
        'Install it from https://claude.com/claude-code and ensure it is on your PATH.',
      );
    }
    return new ClaudeError(`Failed to start Claude CLI: ${(err as Error).message}`);
  }
}
