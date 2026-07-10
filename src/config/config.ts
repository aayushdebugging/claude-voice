import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { VoiceConfig } from '../types/index.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { configFilePath } from './paths.js';

/** A partial, possibly-invalid config as read from disk or CLI overrides. */
export type PartialConfig = DeepPartial<VoiceConfig>;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `override` onto `base`, returning a new object. Arrays and
 * primitives from `override` replace the base value entirely.
 */
export function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override as T) ?? base;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const baseValue = (base as Record<string, unknown>)[key];
    if (isPlainObject(baseValue) && isPlainObject(value)) {
      result[key] = deepMerge(baseValue, value as DeepPartial<unknown>);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

/**
 * Load the effective configuration: defaults merged with the on-disk config and
 * then with any runtime overrides (e.g. CLI flags). Missing/corrupt files fall
 * back to defaults rather than throwing, so the tool always starts.
 */
export async function loadConfig(overrides: PartialConfig = {}): Promise<VoiceConfig> {
  const path = configFilePath();
  let fileConfig: PartialConfig = {};
  try {
    const raw = await readFile(path, 'utf-8');
    fileConfig = JSON.parse(raw) as PartialConfig;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') {
      // File exists but is unreadable/invalid — warn but continue on defaults.
      process.stderr.write(
        `warning: could not read ${path} (${(err as Error).message}); using defaults\n`,
      );
    }
  }
  const withFile = deepMerge(DEFAULT_CONFIG, fileConfig);
  return deepMerge(withFile, overrides);
}

/** Persist the full configuration to disk, creating the directory if needed. */
export async function saveConfig(config: VoiceConfig): Promise<void> {
  const path = configFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

/** Load the config, apply a mutation, and save it back. Returns the new config. */
export async function updateConfig(mutate: (config: VoiceConfig) => void): Promise<VoiceConfig> {
  const config = await loadConfig();
  mutate(config);
  await saveConfig(config);
  return config;
}

/** True when a config file already exists on disk. */
export async function configExists(): Promise<boolean> {
  try {
    await readFile(configFilePath(), 'utf-8');
    return true;
  } catch {
    return false;
  }
}
