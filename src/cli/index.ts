#!/usr/bin/env node
import { Command, Option } from 'commander';

import {
  configCommand,
  doctorCommand,
  localCommand,
  runCommand,
  sayCommand,
  serveCommand,
  updateCommand,
  versionCommand,
} from '../commands/index.js';
import type { PartialConfig } from '../config/index.js';
import { setLogLevel, type LogLevel } from '../utils/logger.js';
import { describeError } from '../utils/errors.js';
import { getVersion } from '../utils/version.js';

interface GlobalOptions {
  model?: string;
  voice?: string;
  stt?: 'groq' | 'openai' | 'whispercpp';
  tts?: 'elevenlabs' | 'sarvam' | 'kokoro';
  language?: string;
  speed?: string;
  local?: boolean;
  device?: string;
  pushToTalk?: boolean;
  continuous?: boolean;
  speak?: boolean;
  stream?: boolean;
  fastSpeech?: boolean;
  logLevel?: LogLevel;
}

/** Translate parsed CLI flags into a partial config override. */
function toOverrides(opts: GlobalOptions): PartialConfig {
  if (opts.logLevel) setLogLevel(opts.logLevel);
  const overrides: PartialConfig = {};
  if (opts.model) overrides.model = opts.model;
  if (opts.voice) overrides.voice = opts.voice;
  // `--local` is shorthand for the fully-local stack; explicit --stt/--tts win.
  if (opts.local) {
    overrides.stt = 'whispercpp';
    overrides.tts = 'kokoro';
  }
  if (opts.stt) overrides.stt = opts.stt;
  if (opts.tts) overrides.tts = opts.tts;
  if (opts.language) overrides.language = opts.language;
  if (opts.speed !== undefined) {
    const rate = parseFloat(opts.speed);
    if (Number.isFinite(rate)) overrides.speechRate = rate;
  }
  if (opts.device) overrides.device = opts.device;
  if (opts.pushToTalk) overrides.pushToTalk = true;
  if (opts.continuous) overrides.pushToTalk = false;
  if (opts.speak === false) overrides.autoSpeak = false;
  // `--no-stream` disables streaming speech (speak the whole reply at once).
  if (opts.stream === false) overrides.streamSpeech = false;
  // `--fast-speech` chunks at clause boundaries for the lowest latency, at the
  // cost of choppier prosody (see Config.fastSpeech).
  if (opts.fastSpeech) overrides.fastSpeech = true;
  return overrides;
}

/** Attach the shared voice options to a command. */
function withVoiceOptions(command: Command): Command {
  return command
    .option('--model <model>', 'Claude model alias (opus, sonnet, fable)')
    .option('--voice <name>', 'TTS voice name (e.g. aria, river, brian)')
    .addOption(
      new Option('--stt <provider>', 'speech-to-text provider').choices([
        'groq',
        'openai',
        'whispercpp',
      ]),
    )
    .addOption(
      new Option('--tts <provider>', 'text-to-speech provider').choices([
        'elevenlabs',
        'sarvam',
        'kokoro',
      ]),
    )
    .option('--language <code>', 'STT + TTS language (ISO-639-1, e.g. hi) or "auto"')
    .option('--speed <rate>', 'speech rate multiplier, 0.5–3.0 (1 = natural)')
    .option('--local', 'use the fully-local, free stack (whisper.cpp + Kokoro)')
    .option('--device <device>', 'microphone device name/index')
    .option('--push-to-talk', 'push-to-talk mode (SPACE to talk) instead of continuous')
    .option('--continuous', 'continuous listening mode (default)')
    .option('--no-speak', 'disable spoken responses (text only)')
    .option('--no-stream', 'speak the whole reply at once instead of as it streams')
    .option(
      '--fast-speech',
      'lowest-latency speech (start after the first clause; may sound choppier)',
    )
    .addOption(
      new Option('--log-level <level>', 'log verbosity').choices([
        'debug',
        'info',
        'warn',
        'error',
      ]),
    );
}

async function main(): Promise<void> {
  const version = await getVersion();
  const program = new Command();

  program
    .name('claude-voice')
    .description('Real-time voice conversations for the Claude CLI.')
    .version(version, '-v, --version', 'output the version number')
    .showHelpAfterError();

  // The shared voice options are global (defined on the program) so that bare
  // `claude-voice --model opus` works AND subcommands can read them via
  // `optsWithGlobals()`. Defining them on both the program and a subcommand
  // makes the global consume the flag and leaves the subcommand's opts empty,
  // so they live in exactly one place.
  withVoiceOptions(program).action(async (_opts, command: Command) => {
    process.exitCode = await runCommand(toOverrides(command.optsWithGlobals() as GlobalOptions));
  });

  // Explicit `chat` alias for the default behavior.
  program
    .command('chat')
    .description('start a live voice conversation (default command)')
    .action(async (_opts, command: Command) => {
      process.exitCode = await runCommand(toOverrides(command.optsWithGlobals() as GlobalOptions));
    });

  program
    .command('say <text...>')
    .description('speak a phrase aloud with the configured voice (no mic needed)')
    .action(async (text: string[], _opts, command: Command) => {
      process.exitCode = await sayCommand(
        text.join(' '),
        toOverrides(command.optsWithGlobals() as GlobalOptions),
      );
    });

  program
    .command('serve')
    .description('host a remote voice client on your local network (open the link on your phone)')
    .option('--port <port>', 'port to listen on', (v) => parseInt(v, 10), 4123)
    .option('--host <host>', 'bind address (use 127.0.0.1 to keep it on this machine only)')
    .option(
      '--allow-tools',
      'DANGER: let remote/spoken prompts run Claude tools (shell, file edits). Off by default.',
    )
    .option('--max-clients <n>', 'maximum simultaneous devices', (v) => parseInt(v, 10))
    .action(
      async (
        opts: { port?: number; host?: string; allowTools?: boolean; maxClients?: number },
        command: Command,
      ) => {
        process.exitCode = await serveCommand(
          toOverrides(command.optsWithGlobals() as GlobalOptions),
          {
            port: opts.port,
            host: opts.host,
            allowTools: opts.allowTools,
            maxClients: opts.maxClients,
          },
        );
      },
    );

  program
    .command('local')
    .description('set up / check the fully-local, free stack (whisper.cpp + Kokoro)')
    .option('--no-download', 'do not auto-download missing models (print commands instead)')
    .action(async (opts: { download?: boolean }) => {
      process.exitCode = await localCommand({ download: opts.download });
    });

  program
    .command('doctor')
    .description('diagnose your setup (Claude CLI, keys, mic, speaker, network)')
    .action(async (_opts, command: Command) => {
      process.exitCode = await doctorCommand(
        toOverrides(command.optsWithGlobals() as GlobalOptions),
      );
    });

  program
    .command('config')
    .description('view or edit configuration (~/.claude-voice/config.json)')
    .option('--edit', 'open the config file in your $EDITOR')
    .option('--reset', 'reset configuration to defaults')
    .option('--path', 'print the config file path')
    .option('--get <key>', 'print a value by dot-path (e.g. providers.groq.model)')
    .option('--set <key=value...>', 'set one or more values by dot-path')
    .action(async (opts) => {
      process.exitCode = await configCommand(opts);
    });

  program
    .command('update')
    .description('check for and install the latest version')
    .option('--check', 'only check; do not install')
    .action(async (opts) => {
      process.exitCode = await updateCommand(opts);
    });

  program
    .command('version')
    .description('print the installed version')
    .action(async () => {
      process.exitCode = await versionCommand();
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  process.stderr.write(`\n${describeError(err)}\n`);
  process.exit(1);
});
