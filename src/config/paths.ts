import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the claude-voice home directory at call time.
 *
 * Reading `CLAUDE_VOICE_HOME` lazily (rather than caching it in a constant)
 * keeps the path overridable — used for isolated homes in tests and for users
 * who relocate their data dir.
 */
export function configDir(): string {
  return process.env.CLAUDE_VOICE_HOME ?? join(homedir(), '.claude-voice');
}

/** Absolute path to the config JSON file, resolved at call time. */
export function configFilePath(): string {
  return join(configDir(), 'config.json');
}

/**
 * Convenience constants evaluated once at load. Suitable for display; runtime
 * file access should prefer {@link configFilePath} so env overrides always win.
 */
export const CONFIG_DIR = configDir();
export const CONFIG_PATH = configFilePath();
