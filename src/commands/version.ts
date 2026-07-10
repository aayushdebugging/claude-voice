import chalk from 'chalk';

import { getVersion } from '../utils/version.js';

/** `claude-voice version` — print the installed version. */
export async function versionCommand(): Promise<number> {
  const version = await getVersion();
  process.stdout.write(`${chalk.bold('claude-voice')} v${version}\n`);
  return 0;
}
