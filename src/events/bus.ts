/**
 * A typed wrapper around Node's EventEmitter.
 *
 * Provides compile-time safety for event names and payloads while retaining the
 * familiar `on`/`emit` API.
 */

import { EventEmitter } from 'node:events';

export type Handler<T> = (payload: T) => void;

export class TypedEventBus<M> {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Voice pipelines fan out to many listeners (UI, TTS, logger, plugins).
    // Raise the ceiling so we never hit the default 10-listener warning.
    this.emitter.setMaxListeners(100);
  }

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof M>(event: K, handler: Handler<M[K]>): () => void {
    this.emitter.on(event as string, handler as (...args: unknown[]) => void);
    return () => this.off(event, handler);
  }

  once<K extends keyof M>(event: K, handler: Handler<M[K]>): void {
    this.emitter.once(event as string, handler as (...args: unknown[]) => void);
  }

  off<K extends keyof M>(event: K, handler: Handler<M[K]>): void {
    this.emitter.off(event as string, handler as (...args: unknown[]) => void);
  }

  emit<K extends keyof M>(event: K, ...payload: M[K] extends void ? [] : [M[K]]): void {
    this.emitter.emit(event as string, payload[0]);
  }

  /** Remove every listener (used on teardown). */
  removeAll(): void {
    this.emitter.removeAllListeners();
  }
}
