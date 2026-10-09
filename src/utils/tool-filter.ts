/**
 * Filter a tool map down to an allowlist. A missing or empty allowlist means
 * "no restriction" and returns the full map unchanged.
 */
export function filterToolsByAllowlist<T>(all: Record<string, T>, allowed?: readonly string[]): Record<string, T> {
  if (!allowed || allowed.length === 0) return all;
  const allowedSet = new Set(allowed);
  return Object.fromEntries(Object.entries(all).filter(([name]) => allowedSet.has(name)));
}

/**
 * Tools that reach across the agent tree. A child never receives them by
 * default: a worker spawned without an `allowedTools` list used to inherit
 * `stop_agent` and could halt its siblings (#74). The parent must grant them
 * by name, and even then the supervisor restricts them to the caller's own
 * descendants.
 */
export const ORCHESTRATION_TOOLS: readonly string[] = ['delegate_task', 'list_agents', 'stop_agent'];

/**
 * The tool set a sub-agent is handed: the allowlist filter, with the
 * orchestration tools stripped unless the allowlist names them explicitly.
 */
export function resolveChildTools<T>(all: Record<string, T>, allowed?: readonly string[]): Record<string, T> {
  const granted = new Set(allowed ?? []);
  const withoutOrchestration = Object.fromEntries(
    Object.entries(all).filter(([name]) => !ORCHESTRATION_TOOLS.includes(name) || granted.has(name)),
  );
  return filterToolsByAllowlist(withoutOrchestration, allowed);
}

/** True when a child's allowlist explicitly grants the named orchestration tool. */
export function childMayUse(toolName: string, allowed?: readonly string[]): boolean {
  return ORCHESTRATION_TOOLS.includes(toolName) && Array.isArray(allowed) && allowed.includes(toolName);
}
