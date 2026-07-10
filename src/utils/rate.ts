/**
 * Speech-rate helpers shared by the TTS providers.
 *
 * Different backends accept different ranges (OpenAI/Kokoro `speed` is
 * 0.25–4.0, Sarvam `pace` ~0.3–3.0). We expose a single conservative range that
 * is valid everywhere so `/speed` behaves identically regardless of provider.
 */

/** Slowest spoken rate we allow. */
export const SPEED_MIN = 0.5;
/** Fastest spoken rate we allow. */
export const SPEED_MAX = 3.0;

/** Clamp a requested speech rate into the safe range (non-finite → 1). */
export function clampSpeed(rate: number | undefined): number {
  if (rate === undefined || !Number.isFinite(rate)) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, rate));
}

/**
 * Parse a user-supplied speed like `1.5`, `1.5x`, or `2X` into a clamped
 * multiplier. Returns `null` when the input isn't a number.
 */
export function parseSpeed(input: string): number | null {
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*x?$/i);
  if (!m) return null;
  return clampSpeed(parseFloat(m[1]!));
}
