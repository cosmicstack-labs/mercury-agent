/**
 * Open event streams, by who opened them, so revoking a device (or signing
 * a browser out) cuts its live connection at once instead of leaving it
 * streaming until it disconnects by itself.
 */

type Close = () => void;
const streams = new Map<string, Set<Close>>();

/** `principal` is "device:<id>" or "session:<key>". Returns the unregister function. */
export function trackStream(principal: string | null, close: Close): () => void {
  if (!principal) return () => {};
  const set = streams.get(principal) ?? new Set<Close>();
  set.add(close);
  streams.set(principal, set);
  return () => {
    set.delete(close);
    if (!set.size) streams.delete(principal);
  };
}

/** Close every stream a principal holds; how many were closed. */
export function closeStreams(principal: string): number {
  const set = streams.get(principal);
  if (!set) return 0;
  streams.delete(principal);
  let n = 0;
  for (const close of set) { try { close(); n++; } catch { /* already closed */ } }
  return n;
}

export function closeStreamsWhere(match: (principal: string) => boolean): number {
  let n = 0;
  for (const key of [...streams.keys()]) if (match(key)) n += closeStreams(key);
  return n;
}
