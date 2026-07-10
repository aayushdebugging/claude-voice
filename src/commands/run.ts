import chalk from 'chalk';

import {
  loadConfig,
  type PartialConfig,
  ENV_KEYS,
  getApiKey,
  needsApiKey,
} from '../config/index.js';
import { createBus, VoiceEvent, type VoiceBus } from '../events/index.js';
import { createSession, type Session } from '../core/index.js';
import { resolveAudioSink } from '../audio/index.js';
import { PluginManager, transcriptPlugin } from '../plugins/index.js';
import { TerminalUI, printBanner } from '../cli/ui.js';
import { setupKeyboard } from '../cli/keyboard.js';
import { runInkSession } from '../cli/ink/app.js';
import { deferred } from '../utils/async.js';
import { describeError } from '../utils/errors.js';
import type { VoiceConfig } from '../types/index.js';

/** Return human-readable descriptions of any blocking setup problems. */
function preflight(config: VoiceConfig): string[] {
  const problems: string[] = [];
  // Local providers (whisper.cpp, Kokoro) need no key — only cloud ones do.
  if (needsApiKey(config.stt) && !getApiKey(config.stt)) {
    problems.push(
      `Speech-to-text (${config.stt}) needs ${ENV_KEYS[config.stt]}. ` +
        `Run: export ${ENV_KEYS[config.stt]}="…"`,
    );
  }
  if (config.autoSpeak && needsApiKey(config.tts) && !getApiKey(config.tts)) {
    problems.push(
      `Text-to-speech (${config.tts}) needs ${ENV_KEYS[config.tts]}. ` +
        `Run: export ${ENV_KEYS[config.tts]}="…" (or disable speech with --no-speak).`,
    );
  }
  return problems;
}

function printInstructions(pushToTalk: boolean): void {
  const tips = pushToTalk
    ? `${chalk.bold('SPACE')} start/stop talking · ${chalk.bold('q')} quit`
    : `Just start talking · ${chalk.bold('SPACE')} send now / interrupt · ${chalk.bold('q')} quit`;
  process.stdout.write(`${chalk.dim(tips)}\n`);
}

/**
 * `claude-voice` / `claude-voice chat` — start a live voice conversation.
 *
 * Wires the UI, plugins, and keyboard control around a {@link createSession}
 * pipeline, then runs until the user quits. Any fatal setup issue is reported
 * with actionable guidance instead of a stack trace.
 */
export async function runCommand(overrides: PartialConfig = {}): Promise<number> {
  const config = await loadConfig(overrides);

  const problems = preflight(config);
  if (problems.length > 0) {
    process.stderr.write(`\n${chalk.red.bold('Cannot start:')}\n`);
    for (const p of problems) process.stderr.write(`  ${chalk.red('•')} ${p}\n`);
    process.stderr.write(`\nRun ${chalk.cyan('claude-voice doctor')} for a full check.\n\n`);
    return 1;
  }

  const bus = createBus();

  // Pick the playback backend up front. Skipped when spoken output is disabled
  // so text-only mode needs no audio output at all. Prefer a persistent
  // streaming player when streaming speech is on, for gapless as-it-writes audio.
  const resolved = config.autoSpeak
    ? await resolveAudioSink({ preferStreaming: config.streamSpeech })
    : { sink: undefined, backend: 'none' as const, player: undefined };
  const { sink, backend } = resolved;

  const session = createSession({ config, bus, sink });
  const plugins = new PluginManager().register(transcriptPlugin());
  await plugins.setupAll({ bus, config, conversation: session.conversation });

  const output = !config.autoSpeak ? 'text-only' : `${config.tts}:${config.voice}`;
  const subtitle = `${config.stt} → claude(${config.model}) → ${output}`;
  const notices: string[] = [];
  if (config.autoSpeak && backend === 'none') {
    notices.push(
      'No audio output found — responses will be text-only. Install sox: brew install sox',
    );
  }

  const ctx: RunContext = { config, bus, session, plugins, subtitle, notices };

  // Rich Ink UI on a real terminal; plain streaming UI otherwise (pipes/CI).
  const useInk = Boolean(process.stdout.isTTY) && process.env.CLAUDE_VOICE_PLAIN !== '1';
  return useInk ? runWithInk(ctx) : runPlain(ctx);
}

interface RunContext {
  config: VoiceConfig;
  bus: VoiceBus;
  session: Session;
  plugins: PluginManager;
  subtitle: string;
  notices: string[];
}

/** Interactive session rendered with the Ink terminal UI. */
async function runWithInk(ctx: RunContext): Promise<number> {
  const { bus, session, plugins } = ctx;
  let loop: Promise<void> = Promise.resolve();
  let exitCode = 0;

  await runInkSession({
    config: ctx.config,
    bus,
    conversation: session.conversation,
    subtitle: ctx.subtitle,
    notices: ctx.notices,
    // Start the pipeline only once the UI is listening on the bus.
    onReady: () => {
      loop = session.conversation.start().catch((err) => {
        exitCode = 1;
        bus.emit(VoiceEvent.Error, {
          scope: 'session',
          error: err instanceof Error ? err : new Error(describeError(err)),
        });
        void session.conversation.stop('error');
      });
    },
  });

  await session.conversation.stop('quit').catch(() => {});
  await loop.catch(() => {});
  await plugins.teardownAll();
  return exitCode;
}

/** Fallback UI: ora spinners + raw keyboard, for non-TTY or CLAUDE_VOICE_PLAIN=1. */
async function runPlain(ctx: RunContext): Promise<number> {
  const { bus, session, plugins, config, subtitle, notices } = ctx;
  const ui = new TerminalUI();
  ui.attach(bus);
  for (const n of notices) process.stderr.write(`${chalk.yellow('⚠')} ${n}\n`);
  printBanner(subtitle);
  printInstructions(config.pushToTalk);

  const quit = deferred<void>();
  let quitting = false;
  const doQuit = (): void => {
    if (quitting) return;
    quitting = true;
    quit.resolve();
  };

  const cleanupKeys = setupKeyboard({
    onSpace: () =>
      void (config.pushToTalk
        ? session.conversation.onTalkKey()
        : session.conversation.handleSpace()),
    onQuit: doQuit,
  });

  const onSigint = (): void => doQuit();
  process.on('SIGINT', onSigint);

  let exitCode = 0;
  try {
    const loop = session.conversation.start().catch((err) => {
      process.stderr.write(`\n${chalk.red('✖')} ${describeError(err)}\n`);
      exitCode = 1;
      doQuit();
    });
    await Promise.race([quit.promise, loop]);
  } finally {
    await session.conversation.stop('quit').catch(() => {});
    await plugins.teardownAll();
    cleanupKeys();
    ui.detach();
    process.off('SIGINT', onSigint);
  }

  process.stdout.write(`\n${chalk.magentaBright('👋 Goodbye.')}\n`);
  return exitCode;
}
