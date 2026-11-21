import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who a plugin tool call is running for, carried through the plugin's own
 * async code. A bot run is unattended (ADR-048): nobody is there to hand a
 * task to, so ctx.owner.ask answers "unavailable" instead of asking.
 */
export interface PluginCallContext { unattended: boolean }

const store = new AsyncLocalStorage<PluginCallContext>();

export function runPluginCall<T>(ctx: PluginCallContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function currentPluginCall(): PluginCallContext | undefined {
  return store.getStore();
}
