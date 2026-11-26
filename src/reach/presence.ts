/**
 * Live presence of the owner's phones (ADR-046): which paired device has an
 * event stream open to Mercury right now, and a way to send that device an
 * event on it. This is the only way Mercury reaches a phone: no push relay,
 * no background service. A phone is "live" while the Mercury app is open,
 * or while the OS still lets it run in the background.
 *
 * The activity stream (/api/chat/activity) registers a link when the caller
 * is a paired device; the link goes when the stream closes (or the device is
 * revoked, which closes its streams).
 */

export interface LiveLink {
  deviceId: string;
  /** Send one SSE event on this stream. */
  send: (event: string, data: unknown) => void;
  since: number;
}

const links = new Map<string, Set<LiveLink>>();
const openListeners = new Set<(deviceId: string) => void>();

/** Register a device's open stream. Returns the unregister function. */
export function openLiveLink(deviceId: string, send: (event: string, data: unknown) => void, now = Date.now()): () => void {
  const link: LiveLink = { deviceId, send, since: now };
  const set = links.get(deviceId) ?? new Set<LiveLink>();
  set.add(link);
  links.set(deviceId, set);
  for (const l of openListeners) { try { l(deviceId); } catch { /* a listener's problem */ } }
  return () => {
    set.delete(link);
    if (!set.size && links.get(deviceId) === set) links.delete(deviceId);
  };
}

export function isLive(deviceId: string): boolean {
  return (links.get(deviceId)?.size ?? 0) > 0;
}

export function liveDeviceIds(): string[] {
  return [...links.keys()];
}

/** Send an event on every open stream of a device; how many streams got it. */
export function sendToDevice(deviceId: string, event: string, data: unknown): number {
  let n = 0;
  for (const link of links.get(deviceId) ?? []) {
    try { link.send(event, data); n++; } catch { /* the stream is closing */ }
  }
  return n;
}

/** Called whenever a device opens a stream (e.g. to tell it about missed items). */
export function onLiveLinkOpened(listener: (deviceId: string) => void): () => void {
  openListeners.add(listener);
  return () => { openListeners.delete(listener); };
}

/** Test hook. */
export function _resetPresence(): void {
  links.clear();
  openListeners.clear();
}
