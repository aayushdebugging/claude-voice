import type { Conversation } from '../core/conversation.js';
import type { VoiceBus } from '../events/index.js';
import type { VoiceConfig } from '../types/index.js';

/**
 * Everything a plugin needs to observe and influence a session. Plugins are
 * intentionally given the event bus (to react) and the conversation (to act,
 * e.g. interrupt), but not the internals of any provider — keeping the surface
 * small and stable.
 */
export interface PluginContext {
  bus: VoiceBus;
  config: Readonly<VoiceConfig>;
  conversation: Conversation;
}

/**
 * A claude-voice plugin. Register plugins to add capabilities such as wake-word
 * detection, clipboard integration, memory, notifications, or MCP bridges,
 * without touching the core pipeline.
 */
export interface Plugin {
  /** Unique, human-readable name. */
  readonly name: string;
  /** Called once when the session starts. Subscribe to bus events here. */
  setup(ctx: PluginContext): void | Promise<void>;
  /** Called on shutdown to release resources. */
  teardown?(): void | Promise<void>;
}
