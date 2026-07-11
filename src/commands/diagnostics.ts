import { spawn } from 'node:child_process';

import { MicRecorder, SpeakerPlayer, FilePlayer } from '../audio/index.js';
import { createSttProvider } from '../stt/index.js';
import { createTtsProvider } from '../tts/index.js';
import { ENV_KEYS, needsApiKey } from '../config/credentials.js';
import { averageAmplitude, peakAmplitude } from '../utils/wav.js';
import type { DiagnosticCheck, HealthResult, VoiceConfig } from '../types/index.js';

/** Run a command and resolve with its combined output and exit code. */
function run(cmd: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    try {
      const child = spawn(cmd, args);
      child.stdout.on('data', (d) => (output += d));
      child.stderr.on('data', (d) => (output += d));
      child.on('error', () => resolve({ code: -1, output }));
      child.on('close', (code) => resolve({ code, output }));
    } catch {
      resolve({ code: -1, output });
    }
  });
}

/** True if a binary is resolvable on PATH. */
async function hasBinary(name: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const { code } = await run(finder, [name]);
  return code === 0;
}

export function buildChecks(config: VoiceConfig): DiagnosticCheck[] {
  const claudeBin = process.env.CLAUDE_VOICE_CLI ?? 'claude';

  return [
    {
      name: 'Node.js version',
      async run(): Promise<HealthResult> {
        const major = Number(process.versions.node.split('.')[0]);
        return major >= 18
          ? { ok: true, message: `Node ${process.versions.node}` }
          : {
              ok: false,
              message: `Node ${process.versions.node} is too old`,
              hint: 'Upgrade to Node 18 or newer.',
            };
      },
    },
    {
      name: 'Claude CLI',
      async run(): Promise<HealthResult> {
        const { code, output } = await run(claudeBin, ['--version']);
        return code === 0
          ? { ok: true, message: `installed (${output.trim() || 'version unknown'})` }
          : {
              ok: false,
              message: 'Claude CLI not found',
              hint: 'Install from https://claude.com/claude-code and ensure it is on your PATH.',
            };
      },
    },
    {
      name: 'Microphone',
      async run(): Promise<HealthResult> {
        if (!(await MicRecorder.isAvailable())) {
          return {
            ok: false,
            message: 'recorder module unavailable',
            hint: 'Reinstall claude-voice (optional native deps may have failed to build).',
          };
        }
        const backend = process.platform === 'linux' ? 'arecord' : 'sox';
        if (!(await hasBinary(backend)) && !(await hasBinary('rec'))) {
          return {
            ok: false,
            message: `recording backend "${backend}" not found`,
            hint:
              process.platform === 'darwin'
                ? 'Install sox: `brew install sox`'
                : process.platform === 'linux'
                  ? 'Install ALSA tools: `sudo apt-get install alsa-utils`'
                  : 'Install sox and add it to your PATH.',
          };
        }
        // Actually record ~1s of raw audio and measure its level. Digital
        // silence (level ~0) means the mic exists but isn't permitted/connected
        // — the most common and most confusing failure on macOS.
        let audio: Buffer;
        try {
          const handle = await new MicRecorder().startManual({
            sampleRate: config.sampleRate,
            device: config.device,
          });
          await new Promise((r) => setTimeout(r, 1000));
          audio = await handle.stop();
        } catch (err) {
          return { ok: false, message: `capture failed: ${(err as Error).message}` };
        }
        const peak = peakAmplitude(audio);
        if (audio.length === 0 || peak < 60) {
          return {
            ok: false,
            message: 'mic produced only silence (no permission?)',
            hint:
              process.platform === 'darwin'
                ? 'Grant mic access: System Settings → Privacy & Security → Microphone → enable your terminal, then restart it.'
                : 'Check the mic is connected and your terminal has microphone permission.',
          };
        }
        return {
          ok: true,
          message: `capture working (${backend}, level ~${Math.round(averageAmplitude(audio))})`,
        };
      },
    },
    {
      name: 'Speaker',
      async run(): Promise<HealthResult> {
        if (await FilePlayer.isAvailable()) {
          return { ok: true, message: `playback ready (${FilePlayer.playerName()})` };
        }
        if (await SpeakerPlayer.isAvailable()) {
          return { ok: true, message: 'playback ready (native speaker)' };
        }
        return {
          ok: false,
          message: 'no audio player found',
          hint:
            process.platform === 'darwin'
              ? 'afplay ships with macOS — this is unexpected; ensure /usr/bin is on PATH.'
              : 'Install a player: `sudo apt-get install alsa-utils` (aplay) or ffmpeg (ffplay).',
        };
      },
    },
    {
      name: `STT (${config.stt})`,
      run: () => createSttProvider(config).healthCheck(),
    },
    {
      name: `TTS (${config.tts})`,
      run: () => createTtsProvider(config).healthCheck(),
    },
    {
      name: 'API keys',
      async run(): Promise<HealthResult> {
        const missing = Object.entries(ENV_KEYS)
          .filter(([, envName]) => !process.env[envName])
          .map(([, envName]) => envName);
        // Only the active *cloud* providers need keys; local ones (whisper.cpp,
        // Kokoro) don't.
        const required = new Set<string>();
        if (needsApiKey(config.stt)) required.add(ENV_KEYS[config.stt]);
        if (needsApiKey(config.tts)) required.add(ENV_KEYS[config.tts]);
        const missingRequired = missing.filter((m) => required.has(m));
        if (missingRequired.length > 0) {
          return {
            ok: false,
            message: `missing: ${missingRequired.join(', ')}`,
            hint: `Export the required keys, e.g. \`export ${missingRequired[0]}="…"\``,
          };
        }
        return {
          ok: true,
          message: missing.length ? `active keys set (unused: ${missing.join(', ')})` : 'all set',
        };
      },
    },
    {
      name: 'Internet',
      async run(): Promise<HealthResult> {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          await fetch('https://api.groq.com', { method: 'HEAD', signal: controller.signal });
          clearTimeout(timer);
          return { ok: true, message: 'reachable' };
        } catch {
          return {
            ok: false,
            message: 'could not reach the network',
            hint: 'Check your internet connection / proxy settings.',
          };
        }
      },
    },
  ];
}
