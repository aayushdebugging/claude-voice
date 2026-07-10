import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedVersion: string | null = null;
let cachedName: string | null = null;

/** Read and cache the package.json next to the installed package. */
async function readPackageJson(): Promise<{ version?: string; name?: string }> {
  // Both the compiled (`dist/utils/`) and dev (`src/utils/`) locations sit two
  // levels below the package root, so the relative path is stable.
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = await readFile(join(here, '..', '..', 'package.json'), 'utf-8');
  return JSON.parse(raw) as { version?: string; name?: string };
}

/** The package version, read from package.json at runtime. */
export async function getVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = (await readPackageJson()).version ?? '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

/** The package name, read from package.json (so it's correct after any rename). */
export async function getPackageName(): Promise<string> {
  if (cachedName) return cachedName;
  try {
    cachedName = (await readPackageJson()).name ?? '@aayushdebugging/claude-voice';
  } catch {
    cachedName = '@aayushdebugging/claude-voice';
  }
  return cachedName;
}
