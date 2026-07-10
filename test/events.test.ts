import { describe, it, expect } from 'vitest';

import { createBus, VoiceEvent } from '../src/events/index.js';

describe('TypedEventBus', () => {
  it('delivers payloads to subscribers', () => {
    const bus = createBus();
    const received: string[] = [];
    bus.on(VoiceEvent.ClaudeToken, ({ text }) => received.push(text));
    bus.emit(VoiceEvent.ClaudeToken, { text: 'hello' });
    bus.emit(VoiceEvent.ClaudeToken, { text: 'world' });
    expect(received).toEqual(['hello', 'world']);
  });

  it('supports void-payload events', () => {
    const bus = createBus();
    let count = 0;
    bus.on(VoiceEvent.UserStartedSpeaking, () => count++);
    bus.emit(VoiceEvent.UserStartedSpeaking);
    expect(count).toBe(1);
  });

  it('on returns an unsubscribe function', () => {
    const bus = createBus();
    let count = 0;
    const off = bus.on(VoiceEvent.Interrupted, () => count++);
    bus.emit(VoiceEvent.Interrupted, { reason: 'user' });
    off();
    bus.emit(VoiceEvent.Interrupted, { reason: 'user' });
    expect(count).toBe(1);
  });

  it('once fires only a single time', () => {
    const bus = createBus();
    let count = 0;
    bus.once(VoiceEvent.ConversationEnded, () => count++);
    bus.emit(VoiceEvent.ConversationEnded, { reason: 'a' });
    bus.emit(VoiceEvent.ConversationEnded, { reason: 'b' });
    expect(count).toBe(1);
  });

  it('removeAll detaches every listener', () => {
    const bus = createBus();
    let count = 0;
    bus.on(VoiceEvent.ClaudeToken, () => count++);
    bus.removeAll();
    bus.emit(VoiceEvent.ClaudeToken, { text: 'x' });
    expect(count).toBe(0);
  });
});
