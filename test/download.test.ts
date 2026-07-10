import { describe, it, expect, afterEach } from 'vitest';
import { readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { downloadFile } from '../src/utils/download.js';

const realFetch = globalThis.fetch;
const dest = join(tmpdir(), `cv-dl-test-${process.pid}.bin`);

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(dest, { force: true }).catch(() => {});
  await rm(`${dest}.part`, { force: true }).catch(() => {});
});

describe('downloadFile', () => {
  it('streams the body to disk and reports progress', async () => {
    const data = Buffer.from('hello world '.repeat(1000));
    globalThis.fetch = (async () =>
      new Response(data, {
        headers: { 'content-length': String(data.length) },
      })) as unknown as typeof fetch;

    let received = 0;
    let total = 0;
    await downloadFile('http://example/model.bin', dest, {
      onProgress: (r, t) => {
        received = r;
        total = t;
      },
    });

    expect((await readFile(dest)).equals(data)).toBe(true);
    expect(received).toBe(data.length);
    expect(total).toBe(data.length);
  });

  it('throws on an HTTP error and leaves no partial file behind', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 404 })) as unknown as typeof fetch;

    await expect(downloadFile('http://example/missing', dest)).rejects.toThrow(/404/);
    await expect(access(dest)).rejects.toThrow();
    await expect(access(`${dest}.part`)).rejects.toThrow();
  });
});
