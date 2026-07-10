/**
 * Typed error hierarchy.
 *
 * Distinct classes let the UI and recovery logic react appropriately (e.g. a
 * missing API key is user-fixable, a network blip is retryable). All extend the
 * base so a single `instanceof VoiceError` check catches anything we threw.
 */

export class VoiceError extends Error {
  /** Optional remediation hint surfaced to the user. */
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = new.target.name;
    this.hint = hint;
  }
}

/** A required dependency (binary, native module) is unavailable. */
export class DependencyError extends VoiceError {}

/** A credential is missing or rejected. */
export class CredentialError extends VoiceError {}

/** A provider (STT/TTS) request failed. */
export class ProviderError extends VoiceError {
  readonly status?: number;
  constructor(message: string, status?: number, hint?: string) {
    super(message, hint);
    this.status = status;
  }
}

/** The Claude CLI failed to start or exited abnormally. */
export class ClaudeError extends VoiceError {}

/** Audio capture or playback failed. */
export class AudioError extends VoiceError {}

/** Format an error for terminal display, including a hint when present. */
export function describeError(err: unknown): string {
  if (err instanceof VoiceError) {
    return err.hint ? `${err.message}\n  → ${err.hint}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
