import chalk from 'chalk';
import ora from 'ora';

import { loadConfig } from '../config/index.js';
import type { PartialConfig } from '../config/index.js';
import { buildChecks } from './diagnostics.js';

/**
 * `claude-voice doctor` — verify the environment: Claude CLI, API keys,
 * microphone, speaker, internet, and permissions. Returns a non-zero exit code
 * when any check fails so it is usable in scripts/CI.
 */
export async function doctorCommand(overrides: PartialConfig = {}): Promise<number> {
  const config = await loadConfig(overrides);
  const checks = buildChecks(config);

  process.stdout.write(`\n${chalk.bold('claude-voice doctor')}\n\n`);

  let failures = 0;
  for (const check of checks) {
    const spinner = ora({ text: check.name, stream: process.stdout }).start();
    let result;
    try {
      result = await check.run();
    } catch (err) {
      result = { ok: false, message: (err as Error).message };
    }
    const label = chalk.bold(check.name.padEnd(18));
    if (result.ok) {
      spinner.stopAndPersist({
        symbol: chalk.green('✔'),
        text: `${label} ${chalk.dim(result.message)}`,
      });
    } else {
      failures++;
      spinner.stopAndPersist({ symbol: chalk.red('✖'), text: `${label} ${result.message}` });
      if (result.hint) process.stdout.write(`  ${chalk.yellow('→')} ${chalk.dim(result.hint)}\n`);
    }
  }

  process.stdout.write('\n');
  if (failures === 0) {
    process.stdout.write(
      `${chalk.green.bold('All checks passed.')} You're ready to talk to Claude.\n\n`,
    );
    return 0;
  }
  process.stdout.write(
    `${chalk.red.bold(`${failures} check${failures > 1 ? 's' : ''} failed.`)} ` +
      `Fix the items above, then re-run ${chalk.cyan('claude-voice doctor')}.\n\n`,
  );
  return 1;
}
