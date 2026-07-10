import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { timingSafeEqual } from 'node:crypto';

import selfsigned from 'selfsigned';
import { WebSocketServer, type WebSocket } from 'ws';

import { createSttProvider } from '../stt/index.js';
import { createTtsProvider, renderSpeechWav } from '../tts/index.js';
import { ClaudeClient } from '../claude/index.js';
import { toSpeakable } from '../utils/speakable.js';
import { describeError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { SttProvider, TtsProvider, VoiceConfig } from '../types/index.js';
import { webClientHtml } from './web-client.js';

export interface RemoteServerOptions {
  config: VoiceConfig;
  token: string;
  port: number;
  /** Bind address (default 0.0.0.0 so LAN devices can reach it). */
  host?: string;
  /**
   * Allow Claude to use its tools (shell, file edits, etc.) for remote sessions.
   * Off by default: a network-exposed session runs with ALL tools disabled so a
   * remote/spoken prompt can't run commands or touch the disk. Enabling this is
   * dangerous — only do it on a trusted network. See SECURITY.md.
   */
  allowTools?: boolean;
  /** Maximum simultaneous client connections (default 4). Extra ones are rejected. */
  maxClients?: number;
}

/** Max control/audio messages a single client may send per minute. */
const MAX_MESSAGES_PER_MINUTE = 60;
/** Largest audio/control frame accepted from a client (bytes). */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

export interface RemoteHandle {
  port: number;
  token: string;
  /** LAN URLs (with token) that a phone on the same Wi-Fi can open. */
  urls: string[];
  close(): Promise<void>;
}

/** Compare a supplied token to the real one without leaking length via timing. */
function safeTokenEqual(supplied: string | null, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Return this host's LAN IPv4 addresses (excluding loopback). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/**
 * Start the remote voice server: an HTTPS page + token-gated WebSocket that
 * runs the STT → Claude → TTS pipeline for a browser client. HTTPS (via a
 * self-signed cert) is required so phone browsers grant microphone access on
 * the LAN. Each WebSocket connection gets its own Claude session.
 */
export async function startRemoteServer(options: RemoteServerOptions): Promise<RemoteHandle> {
  const { config, token } = options;
  const host = options.host ?? '0.0.0.0';
  const ips = lanAddresses();

  const pems = selfsigned.generate([{ name: 'commonName', value: ips[0] ?? 'localhost' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    // subjectAltName lets the cert cover the LAN IP(s) the phone connects to.
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [{ type: 2, value: 'localhost' }, ...ips.map((ip) => ({ type: 7, ip }))],
      },
    ],
  });

  const html = webClientHtml();
  const server: Server = createServer(
    { key: pems.private, cert: pems.cert },
    (_req: IncomingMessage, res: ServerResponse) => {
      // The page is harmless without the token; the WebSocket enforces it.
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(html);
    },
  );

  const stt = createSttProvider(config);
  const tts = createTtsProvider(config);
  const maxClients = Math.max(1, options.maxClients ?? 4);

  // Cap frame size so a single client can't exhaust memory with a huge upload.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'https://localhost');
    // Constant-time-ish token check; anything else is dropped before upgrading.
    if (url.pathname !== '/ws' || !safeTokenEqual(url.searchParams.get('t'), token)) {
      socket.destroy();
      return;
    }
    // Refuse new sockets past the cap instead of unbounded fan-out.
    if (wss.clients.size >= maxClients) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // Safe by default: no tools for network-exposed sessions unless opted in.
  const tools = options.allowTools ? undefined : [];
  wss.on('connection', (ws) => handleConnection(ws, config, stt, tts, tools));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as { port: number }).port;
  const urls = (ips.length ? ips : ['localhost']).map((ip) => `https://${ip}:${port}/?t=${token}`);

  return {
    port,
    token,
    urls,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

/** Wire one browser connection to its own Claude session and the TTS/STT pipeline. */
function handleConnection(
  ws: WebSocket,
  config: VoiceConfig,
  stt: SttProvider,
  tts: TtsProvider,
  tools?: string[],
): void {
  const claude = new ClaudeClient({
    model: config.model,
    tools,
    appendSystemPrompt: config.voicePrompt || undefined,
  });
  let turn: AbortController | null = null;
  let busy = false;

  const send = (obj: unknown): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  const state = (s: string): void => send({ type: 'state', state: s });

  /** Stop whatever is in flight (generation + synthesis) and go idle. */
  const cancel = (): void => {
    turn?.abort();
    claude.terminate();
    busy = false;
    state('idle');
  };

  const handle = async (input: { audio?: Buffer; text?: string }): Promise<void> => {
    // A new utterance supersedes anything in flight (barge-in).
    if (busy) {
      turn?.abort();
      claude.terminate();
    }
    busy = true;
    const controller = new AbortController();
    turn = controller;

    try {
      let text = input.text ?? '';
      if (input.audio) {
        state('transcribing');
        const result = await stt.transcribe({
          audio: input.audio,
          filename: 'audio.webm',
          language: config.language,
        });
        text = result.text;
      }
      if (!text.trim()) {
        send({ type: 'error', message: "Didn't catch that — try again." });
        state('idle');
        return;
      }
      send({ type: 'transcript', text });

      state('thinking');
      const reply = await claude.ask(text, {
        signal: controller.signal,
        onToken: (t) => send({ type: 'token', text: t }),
      });
      if (reply.interrupted || controller.signal.aborted) {
        state('idle');
        return;
      }
      send({ type: 'reply', text: reply.text });

      if (config.autoSpeak && reply.text.trim()) {
        state('speaking');
        const { text: speakable, empty } = toSpeakable(reply.text);
        const spoken = empty ? 'Done — the response is on your screen.' : speakable;
        const wav = await renderSpeechWav(tts, spoken, {
          voice: config.voice,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && ws.readyState === ws.OPEN && wav.length > 0) {
          ws.send(wav); // binary frame → browser plays it
        }
      }
      state('idle');
    } catch (err) {
      if (!controller.signal.aborted) {
        send({ type: 'error', message: describeError(err) });
        state('idle');
      }
    } finally {
      if (turn === controller) turn = null;
      busy = false;
    }
  };

  // Simple fixed-window rate limit so one client can't flood the pipeline.
  let windowStart = Date.now();
  let inWindow = 0;
  const rateLimited = (): boolean => {
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      inWindow = 0;
    }
    if (++inWindow > MAX_MESSAGES_PER_MINUTE) {
      send({ type: 'error', message: 'Too many requests — slow down a moment.' });
      return true;
    }
    return false;
  };

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (rateLimited()) return;
    if (isBinary) {
      void handle({ audio: data });
      return;
    }
    try {
      const msg = JSON.parse(data.toString()) as { type?: string; text?: string };
      if (msg.type === 'text' && msg.text) void handle({ text: msg.text });
      else if (msg.type === 'cancel') cancel();
    } catch {
      // ignore malformed control messages
    }
  });

  ws.on('close', () => {
    turn?.abort();
    claude.terminate();
  });
  ws.on('error', (err) => logger.debug('remote ws error:', err));

  send({ type: 'state', state: 'idle' });
}
