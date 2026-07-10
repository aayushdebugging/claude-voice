import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';

import { startRemoteServer, type RemoteHandle } from '../src/remote/server.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

// The self-signed cert isn't trusted by the test runtime; skip verification.
const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

describe('remote server', () => {
  let handle: RemoteHandle;

  beforeAll(async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    handle = await startRemoteServer({
      config: DEFAULT_CONFIG,
      token: 'secret-token',
      port: 0,
      host: '127.0.0.1',
    });
  });

  afterAll(async () => {
    await handle.close();
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
  });

  it('serves the web client over HTTPS', async () => {
    const html = await fetch(`https://127.0.0.1:${handle.port}/?t=secret-token`).then((r) =>
      r.text(),
    );
    expect(html).toContain('Claude Voice AI');
    expect(html).toContain('Hold to talk');
    // The Stop control and its cancel wiring must be present.
    expect(html).toContain('Stop');
    expect(html).toContain("type: 'cancel'");
    // The live waveform canvas + analyser wiring.
    expect(html).toContain('id="wave"');
    expect(html).toContain('createAnalyser');
  });

  it('rejects a WebSocket with the wrong token', async () => {
    const rejected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${handle.port}/ws?t=WRONG`, {
        rejectUnauthorized: false,
      });
      ws.on('open', () => {
        ws.close();
        resolve(false);
      });
      ws.on('error', () => resolve(true));
    });
    expect(rejected).toBe(true);
  });

  it('accepts a WebSocket with the right token and greets with idle state', async () => {
    const first = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${handle.port}/ws?t=secret-token`, {
        rejectUnauthorized: false,
      });
      const timer = setTimeout(() => reject(new Error('no message')), 5000);
      ws.on('message', (data: Buffer) => {
        clearTimeout(timer);
        ws.close();
        resolve(data.toString());
      });
      ws.on('error', reject);
    });
    expect(JSON.parse(first)).toEqual({ type: 'state', state: 'idle' });
  });
});
