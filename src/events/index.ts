import { TypedEventBus } from './bus.js';
import type { VoiceEventMap } from './types.js';

export { TypedEventBus } from './bus.js';
export type { Handler } from './bus.js';
export { VoiceEvent } from './types.js';
export type { VoiceEventName, VoiceEventMap } from './types.js';

/** The application-wide event bus type. */
export type VoiceBus = TypedEventBus<VoiceEventMap>;

/** Create a fresh, typed voice event bus. */
export function createBus(): VoiceBus {
  return new TypedEventBus<VoiceEventMap>();
}
