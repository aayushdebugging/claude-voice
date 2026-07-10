export { loadConfig, saveConfig, updateConfig, configExists, deepMerge } from './config.js';
export type { PartialConfig } from './config.js';
export { DEFAULT_CONFIG } from './defaults.js';
export { CONFIG_DIR, CONFIG_PATH, configDir, configFilePath } from './paths.js';
export { getApiKey, requireApiKey, needsApiKey, ENV_KEYS } from './credentials.js';
export type { CredentialProvider } from './credentials.js';
