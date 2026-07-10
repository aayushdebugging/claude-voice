/** Networking helpers shared by local-server providers. */

/**
 * True if an HTTP server answers at `baseUrl` at all — any HTTP response counts
 * as "up"; only a connection failure (ECONNREFUSED) or timeout counts as down.
 * Used to detect whether a local model server (whisper.cpp, Kokoro) is running.
 */
export async function serverReachable(baseUrl: string, timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(baseUrl, { signal: controller.signal });
    return true;
  } catch (err) {
    const code = String((err as { cause?: { code?: string } }).cause?.code ?? '');
    // A non-connection error still implies something answered.
    return !(code.includes('ECONNREFUSED') || (err as Error).name === 'AbortError');
  } finally {
    clearTimeout(timer);
  }
}
