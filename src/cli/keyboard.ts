import readline from 'node:readline';

import { logger } from '../utils/logger.js';

/**
 * Raw-mode keyboard control for the plain (non-Ink) fallback UI.
 *
 * SPACE is a single state-aware key — the Conversation decides whether it
 * starts a listen, sends, or interrupts. (Terminals can't report key-release,
 * so there's no true "hold to talk".)
 *
 * Robustness matters here: real terminals emit control/escape sequences at
 * startup (focus reports, cursor queries, bracketed-paste markers) and may have
 * bytes buffered from the shell. Those must never be misread as a command — so
 * we ignore input during a brief startup grace period, skip multi-byte escape
 * sequences entirely, and only quit on unambiguous keys (`q`, Ctrl-C, Ctrl-D).
 */
export interface KeyHandlers {
  /** SPACE pressed — the Conversation decides what it means for the state. */
  onSpace?: () => void;
  onQuit?: () => void;
}

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  sequence?: string;
}

/** ms to ignore input after startup, to swallow terminal handshake bytes. */
const STARTUP_GRACE_MS = 300;

/**
 * Install keyboard handling. Returns a cleanup function that restores the
 * terminal. A no-op when stdin is not a TTY.
 */
export function setupKeyboard(handlers: KeyHandlers): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return () => {};
  }

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  let ready = false;
  const readyTimer = setTimeout(() => {
    ready = true;
  }, STARTUP_GRACE_MS);
  // Don't let the grace timer keep the process alive on its own.
  readyTimer.unref?.();

  const onKeypress = (_str: string | undefined, key: Key | undefined): void => {
    if (!key) return;
    logger.debug(
      'keypress',
      JSON.stringify({ name: key.name, ctrl: key.ctrl, seq: key.sequence, ready }),
    );

    // Ignore anything the terminal sends during the startup handshake window.
    if (!ready) return;

    // Ignore multi-byte escape/control sequences (arrow keys, focus events,
    // cursor-position replies, paste markers). These start with ESC (0x1b).
    if (key.sequence && key.sequence.length > 1 && key.sequence.charCodeAt(0) === 0x1b) {
      return;
    }

    // Quit only on unambiguous keys.
    if ((key.ctrl && (key.name === 'c' || key.name === 'd')) || key.name === 'q') {
      handlers.onQuit?.();
      return;
    }

    if (key.name === 'space') {
      handlers.onSpace?.();
    }
  };

  stdin.on('keypress', onKeypress);

  return () => {
    clearTimeout(readyTimer);
    stdin.off('keypress', onKeypress);
    try {
      stdin.setRawMode(false);
    } catch {
      // ignore
    }
    stdin.pause();
  };
}
