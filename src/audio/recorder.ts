import { Readable } from 'node:stream';

import { AudioError } from '../utils/errors.js';
import { averageAmplitude, peakAmplitude } from '../utils/wav.js';
import { logger } from '../utils/logger.js';

/**
 * Peak amplitude below which a mic is treated as producing no real signal
 * (i.e. no OS permission). A working mic — even in a silent room — easily
 * exceeds this from ambient/electrical noise; digital silence sits near 0.
 */
const MIC_LIVE_FLOOR = 60;

/** Options common to all capture modes. */
export interface RecordOptions {
  sampleRate: number;
  channels?: number;
  /** Recording device name/index passed to the underlying recorder. */
  device?: string;
  /** Recorder backend: `sox`, `rec`, or `arecord`. Auto-detected by default. */
  program?: string;
}

/** Options for automatic (silence-endpointed) capture. */
export interface CaptureOptions extends RecordOptions {
  /** Consecutive silence (ms) that ends the utterance. */
  silenceTimeoutMs: number;
  /** Amplitude threshold below which a chunk counts as silence. */
  silenceThreshold?: number;
  /** Hard cap on utterance length (ms) as a safety valve. */
  maxDurationMs?: number;
  /** Abort to stop capture early (returns whatever was captured). */
  signal?: AbortSignal;
  /** Called once when speech is first detected. */
  onSpeechStart?: () => void;
  /** Called per chunk with the current input level (0..1), for a UI meter. */
  onLevel?: (level: number) => void;
  /**
   * Called once if, after `noAudioTimeoutMs`, the mic has produced only digital
   * silence (all ~zero samples) — the tell-tale sign of a mic that isn't
   * permitted/connected. Capture continues so it can still recover.
   */
  onNoAudio?: () => void;
  /** How long to wait before deciding the mic is producing no audio at all. */
  noAudioTimeoutMs?: number;
}

/** Minimal shape of the optional `node-record-lpcm16` module. */
interface RecorderModule {
  record(options: Record<string, unknown>): RecordingInstance;
}
interface RecordingInstance {
  stream(): Readable;
  stop(): void;
}

let cachedRecorder: RecorderModule | null | undefined;

async function loadRecorder(): Promise<RecorderModule | null> {
  if (cachedRecorder !== undefined) return cachedRecorder;
  try {
    const mod = (await import('node-record-lpcm16')) as unknown as {
      default?: RecorderModule;
    } & RecorderModule;
    cachedRecorder = mod.default ?? mod;
  } catch {
    cachedRecorder = null;
  }
  return cachedRecorder;
}

/** Pick a sensible default recorder backend per platform. */
function defaultProgram(): string {
  if (process.env.CLAUDE_VOICE_RECORDER) return process.env.CLAUDE_VOICE_RECORDER;
  return process.platform === 'linux' ? 'arecord' : 'sox';
}

/** An in-progress manual recording (push-to-talk). */
export interface ManualRecording {
  /** Stop recording and resolve with the captured PCM buffer. */
  stop(): Promise<Buffer>;
}

/**
 * Microphone capture backed by `node-record-lpcm16` (which drives sox/rec on
 * macOS/Windows and arecord on Linux). Supports two modes:
 *
 *   - {@link captureUntilSilence} — continuous mode. Waits for the user to
 *     start speaking, then records until a configurable silence gap.
 *   - {@link startManual} — push-to-talk. Records until the caller stops it.
 *
 * All PCM is 16-bit little-endian mono, matching what the STT layer expects.
 */
export class MicRecorder {
  static async isAvailable(): Promise<boolean> {
    return (await loadRecorder()) !== null;
  }

  private async open(
    options: RecordOptions,
  ): Promise<{ recording: RecordingInstance; stream: Readable }> {
    const recorder = await loadRecorder();
    if (!recorder) {
      throw new AudioError(
        'Microphone capture unavailable: "node-record-lpcm16" is not installed.',
        'Install a recorder backend (e.g. `brew install sox`) and see `claude-voice doctor`.',
      );
    }
    let recording: RecordingInstance;
    try {
      recording = recorder.record({
        sampleRate: options.sampleRate,
        channels: options.channels ?? 1,
        audioType: 'raw',
        recorder: options.program ?? defaultProgram(),
        device: options.device,
        // Let claude-voice handle silence/endpointing itself.
        thresholdStart: 0,
        thresholdEnd: 0,
        silence: '10.0',
      });
    } catch (err) {
      throw new AudioError(`Failed to start microphone: ${(err as Error).message}`);
    }
    return { recording, stream: recording.stream() };
  }

  /**
   * Record a single utterance, ending after `silenceTimeoutMs` of silence once
   * speech has begun. Resolves with the captured 16-bit PCM buffer.
   */
  async captureUntilSilence(options: CaptureOptions): Promise<Buffer> {
    const { recording, stream } = await this.open(options);
    // Floor for what counts as speech; the effective threshold adapts upward
    // from the measured ambient noise so quiet mics still register.
    const minSpeech = options.silenceThreshold ?? 150;
    const maxDurationMs = options.maxDurationMs ?? 30_000;

    const noAudioTimeoutMs = options.noAudioTimeoutMs ?? 4000;

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let speechStarted = false;
      let liveMicSeen = false;
      let peakSeen = 0;
      let ambient = Infinity; // running min of pre-speech levels (noise floor)
      let silenceTimer: NodeJS.Timeout | null = null;
      let maxTimer: NodeJS.Timeout | null = null;
      let noAudioTimer: NodeJS.Timeout | null = null;
      let settled = false;

      const cleanup = (): void => {
        if (silenceTimer) clearTimeout(silenceTimer);
        if (maxTimer) clearTimeout(maxTimer);
        if (noAudioTimer) clearTimeout(noAudioTimer);
        options.signal?.removeEventListener('abort', onAbort);
        stream.removeAllListeners();
        try {
          recording.stop();
        } catch {
          // already stopped
        }
      };

      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Buffer.concat(chunks));
      };

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = (): void => finish();

      const armSilence = (): void => {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(finish, options.silenceTimeoutMs);
      };

      if (options.signal?.aborted) {
        finish();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      maxTimer = setTimeout(finish, maxDurationMs);
      // Watchdog: if the mic only ever produces digital silence, the app is
      // almost certainly missing microphone permission. Notify once.
      noAudioTimer = setTimeout(() => {
        if (!liveMicSeen && !speechStarted) {
          logger.debug(`no mic audio after ${noAudioTimeoutMs}ms (peak amplitude ${peakSeen})`);
          options.onNoAudio?.();
        }
      }, noAudioTimeoutMs);

      stream.on('data', (chunk: Buffer) => {
        const level = averageAmplitude(chunk);
        const peak = peakAmplitude(chunk);
        if (peak > peakSeen) peakSeen = peak;
        // Report a normalized level for the UI meter (peak is more reactive).
        options.onLevel?.(Math.min(1, peak / 10000));
        // A peak above the noise floor means the mic is genuinely live (even a
        // quiet room), distinguishing it from permission-denied digital silence
        // (all ~zero samples). Using peak (not average) avoids false "no mic"
        // warnings when the user simply hasn't started speaking yet.
        if (peak > MIC_LIVE_FLOOR) liveMicSeen = true;

        // Adapt the speech threshold to the room: track the quietest pre-speech
        // level as the noise floor, and require speech to rise clearly above it
        // (but never below the configured floor).
        if (!speechStarted) ambient = Math.min(ambient, level);
        const noiseFloor = Number.isFinite(ambient) ? ambient : 0;
        const threshold = Math.max(minSpeech, noiseFloor * 3);
        const silent = level < threshold;
        if (!speechStarted) {
          if (silent) return; // still waiting for the user to start talking
          speechStarted = true;
          logger.debug(
            `speech detected (level ${Math.round(level)}, threshold ${Math.round(threshold)})`,
          );
          options.onSpeechStart?.();
        }
        chunks.push(chunk);
        if (!silent) armSilence();
      });
      stream.on('error', (err: Error) => fail(new AudioError(`Microphone error: ${err.message}`)));
    });
  }

  /**
   * Begin a manual recording for push-to-talk. Call {@link ManualRecording.stop}
   * to end it and receive the captured PCM.
   */
  async startManual(options: RecordOptions): Promise<ManualRecording> {
    const { recording, stream } = await this.open(options);
    const chunks: Buffer[] = [];
    let errored: Error | null = null;

    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', (err: Error) => {
      errored = new AudioError(`Microphone error: ${err.message}`);
    });

    return {
      stop: () =>
        new Promise<Buffer>((resolve, reject) => {
          stream.removeAllListeners();
          try {
            recording.stop();
          } catch {
            // already stopped
          }
          if (errored) reject(errored);
          else resolve(Buffer.concat(chunks));
        }),
    };
  }
}
