/** Scoped streams can deliver a late frame during a conversation switch. */
export function acceptsSessionEvent(activeId: string | null, data: unknown, allowGlobal = false): boolean {
  if (!data || typeof data !== "object") return allowGlobal;
  const event = data as Record<string, unknown>;
  const target = typeof event.sessionId === "string" ? event.sessionId : event.targetId;
  return typeof target === "string" ? target === activeId : allowGlobal;
}
