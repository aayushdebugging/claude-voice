import { spawn } from 'node:child_process';

import chalk from 'chalk';
import ora from 'ora';

import { getVersion, getPackageName } from '../utils/version.js';

export interface UpdateCommandOptions {
  /** Only report whether an update is available; don't install. */
  check?: boolean;
}

/** Fetch the latest published version of `pkg` from the npm registry. */
async function fetchLatest(pkg: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    // Scoped names need the `/` encoded; read `dist-tags.latest` from the
    // packument (works for both scoped and unscoped packages).
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { 'dist-tags'?: { latest?: string } };
    return data['dist-tags']?.latest ?? null;
  } catch {
    return null;
  }
}

/** Naive semver comparison: returns true when `a` is strictly greater than `b`. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** `claude-voice update` — check for and install the latest version. */
export async function updateCommand(options: UpdateCommandOptions = {}): Promise<number> {
  const current = await getVersion();
  const pkg = await getPackageName();
  const spinner = ora({ text: 'Checking for updates…', stream: process.stdout }).start();
  const latest = await fetchLatest(pkg);
  spinner.stop();

  if (!latest) {
    process.stderr.write(`${chalk.yellow('⚠')} Could not reach the npm registry.\n`);
    return 1;
  }

  process.stdout.write(
    `Current: ${chalk.dim(`v${current}`)}   Latest: ${chalk.cyan(`v${latest}`)}\n`,
  );

  if (!isNewer(latest, current)) {
    process.stdout.write(`${chalk.green('✔')} You're on the latest version.\n`);
    return 0;
  }

  if (options.check) {
    process.stdout.write(
      `${chalk.yellow('⬆')} Update available. Run ${chalk.cyan('claude-voice update')} to install.\n`,
    );
    return 0;
  }

  process.stdout.write(`Installing ${chalk.cyan(`${pkg}@${latest}`)}…\n`);
  const code = await new Promise<number>((resolve) => {
    const child = spawn('npm', ['install', '-g', `${pkg}@latest`], { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (c) => resolve(c ?? 0));
  });

  if (code === 0) {
    process.stdout.write(`${chalk.green('✔')} Updated to v${latest}.\n`);
  } else {
    process.stderr.write(
      `${chalk.red('✖')} Update failed. Try manually: ${chalk.cyan(`npm install -g ${pkg}@latest`)}\n`,
    );
  }
  return code;
}
