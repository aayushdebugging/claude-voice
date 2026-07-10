import { spawn } from 'node:child_process';

import chalk from 'chalk';

import {
  configFilePath,
  DEFAULT_CONFIG,
  configExists,
  loadConfig,
  saveConfig,
} from '../config/index.js';
import type { VoiceConfig } from '../types/index.js';

const CONFIG_PATH = configFilePath();

export interface ConfigCommandOptions {
  edit?: boolean;
  reset?: boolean;
  path?: boolean;
  get?: string;
  set?: string[];
}

/** Coerce a string CLI value into a boolean/number/string. */
function coerce(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

/** Read a nested value by dot path (e.g. `providers.groq.model`). */
function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/** Set a nested value by dot path, creating intermediate objects as needed. */
function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]!] = value;
}

/** Open the config file in the user's editor. */
function openEditor(): Promise<number> {
  const editor =
    process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'nano');
  return new Promise((resolve) => {
    const child = spawn(editor, [CONFIG_PATH], { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

/**
 * `claude-voice config` — view or modify the persisted configuration at
 * `~/.claude-voice/config.json`.
 */
export async function configCommand(options: ConfigCommandOptions = {}): Promise<number> {
  if (options.path) {
    process.stdout.write(`${CONFIG_PATH}\n`);
    return 0;
  }

  if (options.reset) {
    await saveConfig(DEFAULT_CONFIG);
    process.stdout.write(
      `${chalk.green('✔')} Reset configuration to defaults at ${chalk.dim(CONFIG_PATH)}\n`,
    );
    return 0;
  }

  // Ensure a file exists so editing/reading is predictable.
  if (!(await configExists())) {
    await saveConfig(DEFAULT_CONFIG);
  }

  if (options.get) {
    const config = await loadConfig();
    const value = getByPath(config, options.get);
    if (value === undefined) {
      process.stderr.write(`${chalk.red('✖')} Unknown config key: ${options.get}\n`);
      return 1;
    }
    process.stdout.write(
      `${typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}\n`,
    );
    return 0;
  }

  if (options.set && options.set.length > 0) {
    const config = (await loadConfig()) as unknown as Record<string, unknown>;
    for (const pair of options.set) {
      const eq = pair.indexOf('=');
      if (eq === -1) {
        process.stderr.write(`${chalk.red('✖')} Invalid --set "${pair}" (expected key=value)\n`);
        return 1;
      }
      const key = pair.slice(0, eq).trim();
      const value = coerce(pair.slice(eq + 1).trim());
      setByPath(config, key, value);
      process.stdout.write(`${chalk.green('✔')} ${key} = ${chalk.cyan(JSON.stringify(value))}\n`);
    }
    await saveConfig(config as unknown as VoiceConfig);
    return 0;
  }

  if (options.edit) {
    return openEditor();
  }

  // Default: print the current config and where it lives.
  const config = await loadConfig();
  process.stdout.write(`\n${chalk.bold('Configuration')} ${chalk.dim(`(${CONFIG_PATH})`)}\n\n`);
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n\n`);
  process.stdout.write(
    chalk.dim(
      'Edit with `claude-voice config --edit`, or set a value with\n' +
        '`claude-voice config --set voice=river --set model=sonnet`.\n',
    ),
  );
  return 0;
}
