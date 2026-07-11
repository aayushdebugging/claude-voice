/**
 * API-key resolution.
 *
 * Keys are never stored in the config file. They are read from environment
 * variables so users can manage them with their existing secret tooling.
 */

export const ENV_KEYS = {
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  sarvam: 'SARVAM_API_KEY',
} as const;

export type CredentialProvider = keyof typeof ENV_KEYS;

/** True when a provider authenticates with an API key (cloud). Local ones don't. */
export function needsApiKey(provider: string): provider is CredentialProvider {
  return Object.prototype.hasOwnProperty.call(ENV_KEYS, provider);
}

export function getApiKey(provider: CredentialProvider): string | undefined {
  const value = process.env[ENV_KEYS[provider]];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** Return the API key for a provider or throw a helpful error. */
export function requireApiKey(provider: CredentialProvider): string {
  const key = getApiKey(provider);
  if (!key) {
    throw new Error(
      `Missing ${ENV_KEYS[provider]}. Set it in your environment:\n` +
        `  export ${ENV_KEYS[provider]}="your-key-here"`,
    );
  }
  return key;
}
