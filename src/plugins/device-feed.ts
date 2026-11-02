/**
 * Live device readings from desktop plugins (`mercury/device/level`), for the
 * app's microphone test: the plugin measures, Mercury relays, the app draws
 * the meter. Nothing is kept; a reading nobody listens to is dropped.
 */

export interface DeviceLevel {
  plugin: string;
  kind: string;
  level: number;
  at: number;
}

type Listener = (ev: DeviceLevel) => void;

const listeners = new Set<Listener>();

export const deviceFeed = {
  /** A reading from plugin `plugin`; levels are clamped to 0..1. */
  level(plugin: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    const n = Number(p.level);
    const ev: DeviceLevel = {
      plugin,
      kind: typeof p.kind === 'string' ? p.kind.slice(0, 32) : 'microphone',
      level: Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0,
      at: Date.now(),
    };
    for (const l of listeners) {
      try { l(ev); } catch { /* a listener's problem */ }
    }
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
