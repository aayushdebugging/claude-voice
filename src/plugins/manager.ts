import { logger } from '../utils/logger.js';
import type { Plugin, PluginContext } from './types.js';

/**
 * Registers and lifecycles plugins. A plugin failing to set up is logged and
 * skipped rather than aborting the whole session — a broken optional plugin
 * should never prevent a conversation from starting.
 */
export class PluginManager {
  private readonly plugins: Plugin[] = [];
  private readonly active: Plugin[] = [];

  register(plugin: Plugin): this {
    this.plugins.push(plugin);
    return this;
  }

  /** Number of registered plugins. */
  get size(): number {
    return this.plugins.length;
  }

  async setupAll(ctx: PluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.setup(ctx);
        this.active.push(plugin);
      } catch (err) {
        logger.warn(`plugin "${plugin.name}" failed to load:`, err as Error);
      }
    }
  }

  async teardownAll(): Promise<void> {
    for (const plugin of this.active.reverse()) {
      try {
        await plugin.teardown?.();
      } catch (err) {
        logger.debug(`plugin "${plugin.name}" teardown error:`, err as Error);
      }
    }
    this.active.length = 0;
  }
}
