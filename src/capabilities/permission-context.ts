/**
 * Immutable per-agent permission contexts (ROADMAP P2.2, ADR-016).
 *
 * Before this, channel, sender role, allow-all, skill elevation and session
 * scopes were mutable fields on the single PermissionManager shared by the
 * main agent and every sub-agent. An internal (scheduled) turn switched
 * allow-all on for its duration, and a delegated worker whose tool call
 * landed inside that window inherited it (#75/#99 residual).
 *
 * Now each agent's view is a frozen `PermissionContext`. Sub-agents run
 * inside `AsyncLocalStorage` with a context derived from their parent's at
 * spawn time (child ⊆ parent), so any tool they invoke — however deep in
 * the AI SDK's promise chain — reads their own context, never the main
 * agent's current one.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export interface ContextScope {
  readonly path: string;
  readonly read: boolean;
  readonly write: boolean;
  readonly execute?: boolean;
}

export interface PermissionContext {
  readonly channelType: string;
  readonly channelId: string;
  readonly senderRole: 'admin' | 'member' | undefined;
  /** Allow-all: approved-scope actions and non-blocked commands run without prompts. */
  readonly autoApprove: boolean;
  /**
   * Where allow-all came from. `session`: the user chose Allow All (CLI
   * /permissions, Telegram/Signal button) — inherited by children. `turn`:
   * the grant of one internal (scheduled/background) turn — never inherited.
   */
  readonly autoApproveOrigin: 'session' | 'turn' | null;
  /** Tool allowlist; `undefined` = unrestricted. */
  readonly allowedTools: readonly string[] | undefined;
  /** Session/turn scopes on top of the persisted manifest scopes. */
  readonly scopes: readonly ContextScope[];
  /** Skill elevation grants (`run_command`, `fs_read`, `fs_write`) — never inherited. */
  readonly elevated: readonly string[];
}

function freezeScopes(scopes: readonly ContextScope[]): readonly ContextScope[] {
  return Object.freeze(scopes.map((s) => Object.freeze({ ...s })));
}

export function makeContext(fields: Partial<PermissionContext> = {}): PermissionContext {
  return Object.freeze({
    channelType: fields.channelType ?? 'cli',
    channelId: fields.channelId ?? 'cli',
    senderRole: fields.senderRole,
    autoApprove: fields.autoApprove ?? false,
    autoApproveOrigin: fields.autoApprove ? (fields.autoApproveOrigin ?? 'session') : null,
    allowedTools: fields.allowedTools ? Object.freeze([...fields.allowedTools]) : undefined,
    scopes: freezeScopes(fields.scopes ?? []),
    elevated: Object.freeze([...(fields.elevated ?? [])]),
  });
}

/** A new frozen context = `base` with `patch` applied. */
export function withChanges(base: PermissionContext, patch: Partial<PermissionContext>): PermissionContext {
  const merged = { ...base, ...patch };
  if (patch.autoApprove === false) merged.autoApproveOrigin = null;
  if (patch.autoApprove === true && !patch.autoApproveOrigin) merged.autoApproveOrigin = base.autoApproveOrigin ?? 'session';
  return makeContext(merged);
}

function expand(path: string): string {
  return resolve(path.replace(/^~/, homedir()));
}

function covers(parent: ContextScope, child: ContextScope): boolean {
  const p = expand(parent.path);
  const c = expand(child.path);
  const inside = c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
  return inside
    && (!child.read || parent.read)
    && (!child.write || parent.write)
    && (!child.execute || parent.execute === true);
}

export interface ChildContextRequest {
  channelType?: string;
  channelId?: string;
  allowedTools?: readonly string[];
  /** Requested scopes; each must be covered by one of the parent's. Defaults to the parent's. */
  scopes?: readonly ContextScope[];
}

/**
 * Derive a child's context. The child is a subset of the parent on every
 * privilege axis:
 * - allow-all only when the parent's is a user-chosen session grant (an
 *   internal turn's grant stays with that turn);
 * - allowedTools = parent ∩ requested;
 * - scopes = requested scopes the parent covers (default: parent's);
 * - no skill elevation.
 * Channel identity is a routing attribute (where prompts go), not a privilege.
 */
export function deriveChildContext(parent: PermissionContext, req: ChildContextRequest = {}): PermissionContext {
  let allowedTools: readonly string[] | undefined;
  if (parent.allowedTools && req.allowedTools && req.allowedTools.length > 0) {
    const p = new Set(parent.allowedTools);
    allowedTools = req.allowedTools.filter((t) => p.has(t));
  } else if (req.allowedTools && req.allowedTools.length > 0) {
    allowedTools = req.allowedTools;
  } else {
    allowedTools = parent.allowedTools;
  }
  const scopes = req.scopes
    ? req.scopes.filter((s) => parent.scopes.some((p) => covers(p, s)))
    : parent.scopes;
  const inheritAllow = parent.autoApprove && parent.autoApproveOrigin === 'session';
  return makeContext({
    channelType: req.channelType ?? parent.channelType,
    channelId: req.channelId ?? parent.channelId,
    senderRole: parent.senderRole,
    autoApprove: inheritAllow,
    autoApproveOrigin: inheritAllow ? 'session' : null,
    allowedTools,
    scopes,
    elevated: [],
  });
}

/** True when `child` grants nothing `parent` does not (used by tests and assertions). */
export function isSubsetContext(child: PermissionContext, parent: PermissionContext): boolean {
  if (child.autoApprove && !parent.autoApprove) return false;
  if (parent.allowedTools) {
    if (!child.allowedTools) return false;
    if (child.allowedTools.some((t) => !parent.allowedTools!.includes(t))) return false;
  }
  if (child.scopes.some((s) => !parent.scopes.some((p) => covers(p, s)))) return false;
  if (child.elevated.some((e) => !parent.elevated.includes(e))) return false;
  if (child.senderRole === 'admin' && parent.senderRole === 'member') return false;
  return true;
}

/**
 * The cell an agent's async tree carries. `owner` ties it to one
 * PermissionManager (bots have their own) so a bot dispatched from inside a
 * sub-agent never reads that sub-agent's context. `ctx` is replaced (never
 * mutated) when the agent itself is granted something mid-run, e.g. the
 * user answers "yes" to a scope request.
 */
export interface ContextCell {
  readonly owner: object;
  ctx: PermissionContext;
}

export const permissionContextStore = new AsyncLocalStorage<ContextCell>();
