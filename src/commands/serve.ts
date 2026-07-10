import { randomBytes } from 'node:crypto';

import chalk from 'chalk';
import qrcode from 'qrcode-terminal';

import {
  loadConfig,
  type PartialConfig,
  ENV_KEYS,
  getApiKey,
  needsApiKey,
} from '../config/index.js';
import { startRemoteServer } from '../remote/index.js';
import { deferred } from '../utils/async.js';
import { describeError } from '../utils/errors.js';
import type { VoiceConfig } from '../types/index.js';

export interface ServeCommandOptions {
  port?: number;
  /** Bind address (e.g. 127.0.0.1 to keep it local-only). */
  host?: string;
  /** DANGER: allow remote/spoken prompts to run Claude tools. */
  allowTools?: boolean;
  /** Maximum simultaneous client devices. */
  maxClients?: number;
}

/** Blocking setup problems for the remote server. */
function preflight(config: VoiceConfig): string[] {
  const problems: string[] = [];
  if (needsApiKey(config.stt) && !getApiKey(config.stt)) {
    problems.push(`Speech-to-text (${config.stt}) needs ${ENV_KEYS[config.stt]}.`);
  }
  if (config.autoSpeak && needsApiKey(config.tts) && !getApiKey(config.tts)) {
    problems.push(`Text-to-speech (${config.tts}) needs ${ENV_KEYS[config.tts]}.`);
  }
  return problems;
}

/**
 * `claude-voice serve` — host a remote voice client on the local network.
 *
 * Prints a link (and QR code) to open on a phone on the same Wi-Fi: hold to
 * talk, and Claude's reply streams back and plays aloud. Protected by a
 * one-time secret token embedded in the link.
 */
export async function serveCommand(
  overrides: PartialConfig = {},
  options: ServeCommandOptions = {},
): Promise<number> {
  const config = await loadConfig(overrides);

  const problems = preflight(config);
  if (problems.length > 0) {
    process.stderr.write(`\n${chalk.red.bold('Cannot start remote server:')}\n`);
    for (const p of problems) process.stderr.write(`  ${chalk.red('•')} ${p}\n`);
    process.stderr.write(`\nRun ${chalk.cyan('claude-voice doctor')} for a full check.\n\n`);
    return 1;
  }

  const token = randomBytes(16).toString('hex');
  let handle;
  try {
    handle = await startRemoteServer({
      config,
      token,
      port: options.port ?? 4123,
      host: options.host,
      allowTools: options.allowTools,
      maxClients: options.maxClients,
    });
  } catch (err) {
    process.stderr.write(`\n${chalk.red('✖')} Could not start server: ${describeError(err)}\n`);
    return 1;
  }

  if (handle.urls.length === 0) {
    process.stderr.write(
      `${chalk.yellow('⚠')} No LAN network found. Are you connected to Wi-Fi?\n`,
    );
  }

  process.stdout.write(
    `\n${chalk.bold.magentaBright('claude-voice')} ${chalk.dim('· remote (local network)')}\n`,
  );
  process.stdout.write(
    `${chalk.dim(`${config.stt} → claude(${config.model}) → ${config.autoSpeak ? `${config.tts}:${config.voice}` : 'text-only'}`)}\n\n`,
  );
  process.stdout.write(`Open on your phone (same Wi-Fi):\n`);
  for (const url of handle.urls) process.stdout.write(`  ${chalk.cyan(url)}\n`);
  process.stdout.write('\n');
  if (handle.urls[0]) {
    qrcode.generate(handle.urls[0], { small: true }, (qr: string) =>
      process.stdout.write(`${qr}\n`),
    );
  }
  // Make the security posture unmissable — this session is on the network.
  const toolLine = options.allowTools
    ? `${chalk.red.bold('⚠ TOOLS ENABLED:')} ${chalk.red('remote/spoken prompts can run shell commands and edit files on THIS machine.')}`
    : `${chalk.green('🔒 Safe mode:')} ${chalk.dim("Claude's tools are disabled — it can only talk. Use --allow-tools to change (dangerous).")}`;
  process.stdout.write(`${toolLine}\n`);
  process.stdout.write(
    chalk.dim(
      'On first open you\'ll see a certificate warning (self-signed) — tap "proceed"/"visit",\n' +
        'then allow microphone access. Hold the button to talk; replies play aloud.\n' +
        `${chalk.yellow('Note:')} anyone on this network with the link can talk to Claude here — share it only with yourself.\n` +
        `Press ${chalk.bold('Ctrl-C')} to stop.\n\n`,
    ),
  );

  const quit = deferred<void>();
  const onSigint = (): void => quit.resolve();
  process.on('SIGINT', onSigint);
  await quit.promise;
  process.off('SIGINT', onSigint);

  await handle.close();
  process.stdout.write(`\n${chalk.magentaBright('👋 Remote server stopped.')}\n`);
  return 0;
}
