import chalk from 'chalk';
import ora, { type Ora } from 'ora';

import { VoiceEvent, type VoiceBus } from '../events/index.js';
import { describeError } from '../utils/errors.js';

/**
 * The interactive terminal presentation layer.
 *
 * It is a pure consumer of bus events — it renders spinners for each phase
 * (listening / transcribing / thinking / speaking), streams Claude's tokens
 * live, and prints timings. Because it only listens, the core pipeline has no
 * dependency on it and can run headless (tests, future GUIs).
 */
export class TerminalUI {
  private spinner: Ora;
  private streaming = false;
  private readonly offs: Array<() => void> = [];

  constructor() {
    this.spinner = ora({ spinner: 'dots', stream: process.stdout });
  }

  attach(bus: VoiceBus): void {
    this.offs.push(
      bus.on(VoiceEvent.StateChanged, ({ to }) => {
        switch (to) {
          case 'listening':
            this.setSpinner(chalk.green('🎤 Listening…'));
            break;
          case 'transcribing':
            this.setSpinner(chalk.blue('📝 Transcribing…'));
            break;
          case 'thinking':
            this.setSpinner(chalk.magenta('🧠 Thinking…'));
            break;
          case 'idle':
            if (!this.streaming) this.spinner.stop();
            break;
        }
      }),

      bus.on(VoiceEvent.UserStartedSpeaking, () => {
        this.setSpinner(chalk.green('🎤 Listening… (speech detected)'));
      }),

      bus.on(VoiceEvent.SpeechRecognized, (result) => {
        this.spinner.stop();
        if (result.text) {
          process.stdout.write(
            `\n${chalk.hex('#4dd0e1').bold('❯ You')} ${chalk.dim(`(${result.latencyMs}ms)`)}\n`,
          );
          process.stdout.write(`${result.text}\n`);
        }
      }),

      bus.on(VoiceEvent.ClaudeToken, ({ text }) => {
        if (!this.streaming) {
          this.spinner.stop();
          this.streaming = true;
          process.stdout.write(`\n${chalk.hex('#a66cff').bold('✦ Claude')}\n`);
        }
        process.stdout.write(text);
      }),

      bus.on(VoiceEvent.ClaudeFinished, ({ elapsedMs }) => {
        if (this.streaming) {
          this.streaming = false;
          process.stdout.write(`\n${chalk.dim(`⏱  ${formatMs(elapsedMs)}`)}\n`);
        } else {
          this.spinner.stop();
        }
      }),

      bus.on(VoiceEvent.SpeechStarted, () => {
        if (!this.streaming && !this.spinner.isSpinning) {
          this.setSpinner(chalk.yellow('🔊 Speaking…'));
        }
      }),

      bus.on(VoiceEvent.Interrupted, () => {
        this.streaming = false;
        this.spinner.stop();
        process.stdout.write(`\n${chalk.dim('⏹  interrupted')}\n`);
      }),

      bus.on(VoiceEvent.Error, ({ scope, error }) => {
        this.streaming = false;
        this.spinner.stop();
        process.stderr.write(`\n${chalk.red(`✖ ${scope}:`)} ${describeError(error)}\n`);
      }),

      bus.on(VoiceEvent.ConversationEnded, () => {
        this.spinner.stop();
      }),
    );
  }

  detach(): void {
    this.spinner.stop();
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  private setSpinner(text: string): void {
    this.spinner.text = text;
    if (!this.spinner.isSpinning) this.spinner.start();
  }
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Print the startup banner (brand-colored). */
export function printBanner(subtitle: string): void {
  const title = chalk.bold(
    chalk.hex('#f5a623')('Claude ') + chalk.hex('#e8618c')('Voice ') + chalk.hex('#a66cff')('AI'),
  );
  process.stdout.write(`\n🎙️  ${title} ${chalk.dim('· talk to Claude, hear it think back')}\n`);
  process.stdout.write(`${chalk.dim(subtitle)}\n`);
}
