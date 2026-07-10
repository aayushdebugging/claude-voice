import chalk from 'chalk';

import {
  loadConfig,
  type PartialConfig,
  ENV_KEYS,
  getApiKey,
  needsApiKey,
} from '../config/index.js';
import { createTtsProvider, SpeechQueue } from '../tts/index.js';
import { resolveAudioSink } from '../audio/index.js';
import { toSpeakable } from '../utils/speakable.js';
import { describeError } from '../utils/errors.js';

/**
 * `claude-voice say <text>` — speak a phrase aloud with the configured TTS.
 *
 * Handy for checking the voice, speaker, and pace without going through the
 * microphone — playback needs no mic permission, so it works even while mic
 * access is still being sorted out.
 */
export async function sayCommand(text: string, overrides: PartialConfig = {}): Promise<number> {
  const config = await loadConfig(overrides);

  if (needsApiKey(config.tts) && !getApiKey(config.tts)) {
    process.stderr.write(
      `${chalk.red('✖')} ${config.tts} needs ${ENV_KEYS[config.tts]}. ` +
        `Run: export ${ENV_KEYS[config.tts]}="…"\n`,
    );
    return 1;
  }

  const { sink, backend } = await resolveAudioSink();
  if (backend === 'none') {
    process.stderr.write(
      `${chalk.red('✖')} No audio output available. Install sox: ${chalk.cyan('brew install sox')}\n`,
    );
    return 1;
  }

  const provider = createTtsProvider(config);
  const queue = new SpeechQueue({
    provider,
    sink,
    voice: config.voice,
    speed: config.speechRate,
    language: config.language,
  });

  const { text: speakable, empty } = toSpeakable(text);
  if (empty) {
    process.stderr.write(`${chalk.yellow('⚠')} Nothing speakable in that text.\n`);
    return 1;
  }

  process.stdout.write(
    `${chalk.magenta('🔊')} ${config.tts}:${config.voice} — ${chalk.dim(text)}\n`,
  );
  try {
    await queue.speak(speakable);
    return 0;
  } catch (err) {
    process.stderr.write(`${chalk.red('✖')} ${describeError(err)}\n`);
    return 1;
  }
}
