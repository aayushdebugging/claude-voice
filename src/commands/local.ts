import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import chalk from 'chalk';

import { loadConfig, CONFIG_DIR } from '../config/index.js';
import { serverReachable } from '../utils/net.js';
import { downloadFile } from '../utils/download.js';
import { KOKORO_SERVER_PY } from './kokoro-server-source.js';

export interface LocalCommandOptions {
  /** Auto-download missing models (default true). `false` prints commands instead. */
  download?: boolean;
}

/** Download a model file to disk, rendering a throttled progress bar. */
async function downloadWithProgress(url: string, dest: string): Promise<void> {
  let lastPct = -1;
  await downloadFile(url, dest, {
    onProgress: (received, total) => {
      if (!total) return;
      const pct = Math.floor((received / total) * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      const w = 22;
      const filled = Math.round((pct / 100) * w);
      process.stdout.write(
        `\r    ${chalk.magentaBright(`▕${'█'.repeat(filled)}${'·'.repeat(w - filled)}▏`)} ` +
          `${pct}%  ${(received / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB   `,
      );
    },
  });
  process.stdout.write('\n');
}

function hasBinary(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(process.platform === 'win32' ? 'where' : 'which', [name]);
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

const ok = (s: string): string => `${chalk.green('✔')} ${s}`;
const no = (s: string): string => `${chalk.red('✖')} ${s}`;
const cmd = (s: string): string => `    ${chalk.cyan(s)}`;

/**
 * `claude-voice local` — status + setup guide for the fully-local, $0 stack
 * (whisper.cpp STT + Kokoro TTS). It reports what's installed/running and
 * prints the exact commands to start whatever's missing.
 */
export async function localCommand(options: LocalCommandOptions = {}): Promise<number> {
  const config = await loadConfig();
  const modelsDir = join(CONFIG_DIR, 'models');
  const whModel = config.providers.whispercpp.model;
  const whModelPath = join(modelsDir, whModel);
  const whPort = new URL(config.providers.whispercpp.baseUrl).port || '8081';
  const koPort = new URL(config.providers.kokoro.baseUrl).port || '8880';

  process.stdout.write(
    `\n${chalk.bold.magentaBright('claude-voice')} ${chalk.dim('· local models')}\n\n`,
  );

  // ---- STT: whisper.cpp ----
  process.stdout.write(`${chalk.bold('Speech-to-text — whisper.cpp')}\n`);
  const whInstalled = await hasBinary('whisper-server');
  const whModelExists = existsSync(whModelPath);
  const whUp = await serverReachable(config.providers.whispercpp.baseUrl);
  process.stdout.write(`  ${whInstalled ? ok('installed') : no('not installed')}\n`);
  if (!whInstalled) process.stdout.write(cmd('brew install whisper-cpp') + '\n');
  const whModelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${whModel}`;
  const printCurl = (): void => {
    process.stdout.write(
      cmd(`mkdir -p "${modelsDir}" && curl -fSL -o "${whModelPath}" \\`) +
        `\n    ${chalk.cyan(whModelUrl)}\n`,
    );
  };
  if (whModelExists) {
    process.stdout.write(`  ${ok(`model ${whModel}`)}\n`);
  } else if (options.download === false) {
    process.stdout.write(`  ${no(`model ${whModel} missing`)}\n`);
    printCurl();
  } else {
    // Auto-fetch the model (matches Kokoro, which self-downloads on first run).
    process.stdout.write(
      `  ${chalk.cyan('↓')} downloading ${whModel} ${chalk.dim('(~150 MB, one time)')}…\n`,
    );
    try {
      await downloadWithProgress(whModelUrl, whModelPath);
      process.stdout.write(`  ${ok(`downloaded ${whModel}`)}\n`);
    } catch (err) {
      process.stdout.write(`  ${no(`download failed: ${(err as Error).message}`)}\n`);
      printCurl();
    }
  }
  process.stdout.write(
    `  ${whUp ? ok(`server running (${config.providers.whispercpp.baseUrl})`) : no('server not running')}\n`,
  );
  if (!whUp && whInstalled) {
    process.stdout.write(
      cmd(`whisper-server -m "${whModelPath}" --host 127.0.0.1 --port ${whPort}`) + '\n',
    );
  }

  // ---- TTS: Kokoro (via uv — no Docker/PyTorch needed) ----
  process.stdout.write(`\n${chalk.bold('Text-to-speech — Kokoro')}\n`);
  const koUp = await serverReachable(config.providers.kokoro.baseUrl);
  const hasUv = await hasBinary('uv');
  // Ship the tiny kokoro-onnx server so the user just runs one command.
  const scriptPath = join(CONFIG_DIR, 'kokoro-server.py');
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(scriptPath, KOKORO_SERVER_PY);
  } catch {
    // best effort
  }
  process.stdout.write(
    `  ${koUp ? ok(`server running (${config.providers.kokoro.baseUrl})`) : no('server not running')}\n`,
  );
  if (!koUp) {
    process.stdout.write(`  ${hasUv ? ok('uv installed') : no('uv not installed')}\n`);
    if (!hasUv) process.stdout.write(cmd('brew install uv') + '\n');
    process.stdout.write(
      `  ${chalk.dim('Start it (auto-downloads the ~340MB model on first run):')}\n`,
    );
    process.stdout.write(
      cmd(`uv run --with kokoro-onnx --with numpy python "${scriptPath}" --port ${koPort}`) + '\n',
    );
  }

  // ---- how to use ----
  const ready = whUp && koUp;
  process.stdout.write(`\n${chalk.bold('Use it')}\n`);
  if (ready) {
    process.stdout.write(`  ${ok('Both servers are up.')} Switch to the local stack:\n`);
  } else {
    process.stdout.write(`  ${chalk.dim('Once both servers are running:')}\n`);
  }
  process.stdout.write(cmd('claude-voice --stt whispercpp --tts kokoro') + '\n');
  process.stdout.write(
    `  ${chalk.dim('…or make it the default:')} ${chalk.cyan('claude-voice config --set stt=whispercpp --set tts=kokoro --set voice=af_heart')}\n\n`,
  );
  return ready ? 0 : 1;
}
