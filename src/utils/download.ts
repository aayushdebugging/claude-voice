import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DownloadOptions {
  /** Called as bytes arrive. `total` is 0 when the server sends no length. */
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

/**
 * Download `url` to `dest`, streaming to disk (so large model files don't sit in
 * memory) with progress callbacks. The bytes are written to a `<dest>.part` file
 * and renamed into place only on success, so an interrupted download never
 * leaves a truncated file that looks complete.
 */
export async function downloadFile(
  url: string,
  dest: string,
  options: DownloadOptions = {},
): Promise<void> {
  const res = await fetch(url, { signal: options.signal, redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  await mkdir(dirname(dest), { recursive: true });

  const tmp = `${dest}.part`;
  const out = createWriteStream(tmp);
  const finished = new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.once('finish', resolve);
  });

  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      if (options.signal?.aborted) throw new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        received += value.length;
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => out.once('drain', resolve));
        }
        options.onProgress?.(received, total);
      }
    }
    out.end();
    await finished;
    await rename(tmp, dest);
  } catch (err) {
    out.destroy();
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
