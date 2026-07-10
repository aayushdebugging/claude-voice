import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { ClaudeError } from '../utils/errors.js';
import { VoiceEvent, type VoiceBus } from '../events/index.js';
import type { ClaudeOptions } from '../types/index.js';
import { parseStreamJsonLine } from './stream-parser.js';

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
  /** Abort to interrupt generation; the process is terminated. */
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

/**
 * Wraps the Claude CLI as a streaming conversational backend.
 *
 * Rather than the Claude API, each turn spawns `claude -p` with stream-json
 * output and reads tokens off stdout as they arrive. Conversation continuity is
 * preserved by capturing the CLI's `session_id` and resuming it on later turns.
 * A crashed or missing CLI surfaces a typed {@link ClaudeError} instead of
 * taking the process down.
 */
export class ClaudeClient {
  private readonly bin: string;
  private readonly options: ClaudeClientOptions;
  private readonly bus?: VoiceBus;
  private sessionId?: string;
  private child: ChildProcessWithoutNullStreams | null = null;

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
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    if (this.options.model) args.push('--model', this.options.model);
    if (this.options.appendSystemPrompt) {
      args.push('--append-system-prompt', this.options.appendSystemPrompt);
    }
    // Resume the existing conversation for multi-turn continuity.
    if (this.sessionId) args.push('--resume', this.sessionId);
    if (this.options.extraArgs) args.push(...this.options.extraArgs);
    // Tool restriction goes last: `--tools` is variadic, so keeping it at the
    // end avoids it swallowing any later flags. `[]` → `--tools ""` disables all
    // tools; a non-empty list restricts to exactly those.
    if (this.options.tools) {
      args.push('--tools', this.options.tools.join(','));
    }
    return args;
  }

  /**
   * Send a prompt to Claude and stream the response. Resolves with the full
   * text once the turn completes (or is interrupted).
   */
  ask(prompt: string, opts: AskOptions = {}): Promise<AskResult> {
    return new Promise<AskResult>((resolve, reject) => {
      const start = performance.now();
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.bin, this.buildArgs(), {
          cwd: this.options.cwd ?? process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(this.spawnError(err));
        return;
      }
      this.child = child;

      let streamed = '';
      let resultText: string | null = null;
      let costUsd: number | undefined;
      let sawDelta = false;
      let interrupted = false;
      let stderr = '';
      let settled = false;
      let stdoutBuffer = '';

      const emitText = (text: string): void => {
        if (!text) return;
        streamed += text;
        opts.onToken?.(text);
        this.bus?.emit(VoiceEvent.ClaudeToken, { text });
      };

      const onAbort = (): void => {
        interrupted = true;
        this.terminate();
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          interrupted = true;
        } else {
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      const finalize = (err?: Error): void => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener('abort', onAbort);
        this.child = null;
        const elapsedMs = Math.round(performance.now() - start);
        if (err) {
          reject(err);
          return;
        }
        const text = (resultText ?? streamed).trim();
        this.bus?.emit(VoiceEvent.ClaudeFinished, { text, elapsedMs });
        resolve({ text, elapsedMs, costUsd, interrupted });
      };

      const handleLine = (line: string): void => {
        const event = parseStreamJsonLine(line);
        if (!event) return;
        switch (event.kind) {
          case 'init':
            if (event.sessionId) this.sessionId = event.sessionId;
            break;
          case 'delta':
            sawDelta = true;
            emitText(event.text);
            break;
          case 'assistant':
            // Only used as a fallback when token deltas are unavailable.
            if (!sawDelta) emitText(event.text);
            break;
          case 'result':
            if (event.sessionId) this.sessionId = event.sessionId;
            costUsd = event.costUsd;
            resultText = event.text || streamed;
            break;
          case 'other':
            if (event.sessionId) this.sessionId = event.sessionId;
            break;
        }
      };

      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (data: string) => {
        stdoutBuffer += data;
        let newline = stdoutBuffer.indexOf('\n');
        while (newline !== -1) {
          handleLine(stdoutBuffer.slice(0, newline));
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          newline = stdoutBuffer.indexOf('\n');
        }
      });

      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (data: string) => {
        stderr += data;
      });

      child.on('error', (err) => finalize(this.spawnError(err)));

      child.on('close', (code) => {
        if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
        if (interrupted) {
          finalize();
          return;
        }
        if (code !== 0 && resultText === null && streamed.length === 0) {
          finalize(
            new ClaudeError(
              `Claude CLI exited with code ${code ?? 'unknown'}.` +
                (stderr ? `\n${stderr.trim()}` : ''),
              'Run `claude-voice doctor` to verify the Claude CLI is working.',
            ),
          );
          return;
        }
        finalize();
      });

      // Deliver the prompt over stdin, then close it to signal end of input.
      this.bus?.emit(VoiceEvent.ClaudeStarted, { prompt });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  /** Terminate the running Claude process, if any (used for interruption). */
  terminate(): void {
    const child = this.child;
    if (!child) return;
    try {
      child.kill('SIGTERM');
      // Escalate if it ignores the polite signal.
      setTimeout(() => {
        if (this.child === child) child.kill('SIGKILL');
      }, 1500).unref?.();
    } catch {
      // already gone
    }
  }

  /** Forget the current session so the next ask starts a fresh conversation. */
  resetSession(): void {
    this.sessionId = undefined;
  }

  /** Change the model used for subsequent turns. */
  setModel(model: string): void {
    this.options.model = model;
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
