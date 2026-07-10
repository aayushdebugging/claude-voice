import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { configDir } from '../config/paths.js';
import { VoiceEvent } from '../events/index.js';
import type { Plugin, PluginContext } from './types.js';

/**
 * Example plugin: append every recognized user utterance and Claude reply to a
 * plain-text transcript under `~/.claude-voice/transcripts/`.
 *
 * It demonstrates the plugin contract end to end — subscribe on `setup`, clean
 * up on `teardown` — and doubles as a genuinely useful feature.
 */
export function transcriptPlugin(): Plugin {
  const unsubscribers: Array<() => void> = [];
  const dir = join(configDir(), 'transcripts');
  const file = join(dir, 'session.log');

  const write = async (line: string): Promise<void> => {
    try {
      await mkdir(dir, { recursive: true });
      await appendFile(file, `${line}\n`, 'utf-8');
    } catch {
      // Transcript logging is best-effort; never disrupt the conversation.
    }
  };

  return {
    name: 'transcript',
    setup(ctx: PluginContext): void {
      unsubscribers.push(
        ctx.bus.on(VoiceEvent.SpeechRecognized, (r) => void write(`You: ${r.text}`)),
        ctx.bus.on(VoiceEvent.ClaudeFinished, (r) => void write(`Claude: ${r.text}\n`)),
      );
    },
    teardown(): void {
      for (const off of unsubscribers) off();
      unsubscribers.length = 0;
    },
  };
}
