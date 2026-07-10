import chalk from 'chalk';

/**
 * Minimal leveled logger with colored output.
 *
 * Kept deliberately small — the rich conversational UI lives in the CLI layer.
 * This is for diagnostics, warnings, and errors that can happen anywhere.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = (process.env.CLAUDE_VOICE_LOG as LogLevel) ?? 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

export const logger = {
  debug(...args: unknown[]): void {
    if (enabled('debug')) process.stderr.write(`${chalk.gray('debug')} ${format(args)}\n`);
  },
  info(...args: unknown[]): void {
    if (enabled('info')) process.stderr.write(`${format(args)}\n`);
  },
  warn(...args: unknown[]): void {
    if (enabled('warn')) process.stderr.write(`${chalk.yellow('⚠')}  ${format(args)}\n`);
  },
  error(...args: unknown[]): void {
    if (enabled('error')) process.stderr.write(`${chalk.red('✖')}  ${format(args)}\n`);
  },
};

function format(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(' ');
}
