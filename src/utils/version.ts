import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/**
 * Read the package version from package.json at runtime. Both the compiled
 * (`dist/utils/`) and dev (`src/utils/`) locations sit two levels below the
 * package root, so the relative path is stable.
 */
export async function getVersion(): Promise<string> {
  if (cached) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, '..', '..', 'package.json'), 'utf-8');
    cached = (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
