import type { AudioFormat } from '../types/index.js';

/**
 * Wrap raw little-endian PCM samples in a minimal WAV (RIFF) container.
 *
 * Recorders produce headerless PCM, but STT HTTP APIs expect a recognizable
 * audio file. A 44-byte canonical WAV header is the simplest broadly-accepted
 * wrapper.
 */
export function encodeWav(pcm: Buffer, format: AudioFormat): Buffer {
  const { sampleRate, channels, bitDepth } = format;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * Extract the raw PCM samples from a WAV (RIFF) buffer by locating the `data`
 * chunk. Providers that return a full WAV file (e.g. Sarvam returns base64 WAV)
 * need this so the samples can be fed to the PCM audio sink. If the buffer is
 * not a WAV it is assumed to already be raw PCM and returned unchanged.
 */
export function extractPcmFromWav(wav: Buffer): Buffer {
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return wav;
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (id === 'data') {
      return wav.subarray(dataStart, Math.min(dataStart + size, wav.length));
    }
    // Chunks are word-aligned: skip the payload plus any pad byte.
    offset = dataStart + size + (size % 2);
  }
  // Malformed but plausibly a canonical 44-byte header — fall back to that.
  return wav.subarray(44);
}

/**
 * Mean absolute amplitude of 16-bit PCM samples (a cheap loudness proxy).
 * Returns 0 for empty/too-short buffers. Digital silence (e.g. a mic with no
 * permission) yields ~0; ambient room noise is typically tens; speech hundreds.
 */
export function averageAmplitude(pcm: Buffer): number {
  if (pcm.length < 2) return 0;
  let sum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    sum += Math.abs(pcm.readInt16LE(i));
  }
  return sum / samples;
}

/**
 * Peak (maximum) absolute amplitude of 16-bit PCM samples. Unlike the average,
 * this cleanly separates a *working but quiet* mic (ambient/electrical noise
 * produces peaks in the tens–hundreds) from a mic with no OS permission (all
 * samples ~0, peak ≈ 0–2). Used to avoid false "no microphone" warnings.
 */
export function peakAmplitude(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * Estimate whether a PCM buffer contains actual speech vs. silence, using
 * average absolute amplitude. Used to discard empty recordings before paying
 * for a transcription request.
 */
export function isLikelySilent(pcm: Buffer, threshold = 350): boolean {
  if (pcm.length < 2) return true;
  return averageAmplitude(pcm) < threshold;
}

/**
 * Scale 16-bit PCM so its loudest sample reaches `targetPeak`, capped at
 * `maxGain`. This rescues quiet microphones (low input gain / wrong device):
 * a faint capture is boosted to a level Whisper can transcribe. Gain is capped
 * so near-silence isn't amplified into noise, and a buffer that's already loud
 * enough is returned unchanged.
 */
export function normalizePcm(pcm: Buffer, targetPeak = 10000, maxGain = 25): Buffer {
  if (pcm.length < 2) return pcm;
  const peak = peakAmplitude(pcm);
  if (peak <= 0) return pcm;
  const gain = Math.min(maxGain, targetPeak / peak);
  if (gain <= 1.1) return pcm; // already loud enough
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.round(pcm.readInt16LE(i) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i);
  }
  return out;
}
