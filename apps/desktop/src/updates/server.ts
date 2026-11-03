/* ═══════════════════════════════════════════════════════════════
   A server's updates, for ANY connection (not only the active one):
   each request carries that connection's own credential. Updating a
   server rides through its restart: the daemon is down for a few
   seconds, and a local one comes back with a new attach token.
   ═══════════════════════════════════════════════════════════════ */

import { credentialFor, type Connection } from "~/shell/connections";
import type { ServerUpdates, UpdateJob } from "./types";

export class ServerError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

async function call<T>(conn: Connection, path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const token = await credentialFor(conn).catch(() => null);
  const res = await fetch(`${conn.baseUrl.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ServerError(typeof body.error === "string" ? body.error : `${conn.name} answered ${res.status}`, res.status, body);
  return body as T;
}

/** null = this Mercury predates updates (no /api/updates): the caller falls back to its health version. */
export async function fetchServerUpdates(conn: Connection, refresh = false): Promise<ServerUpdates | null> {
  try {
    return await call<ServerUpdates>(conn, refresh ? "/api/updates/check" : "/api/updates", refresh ? { method: "POST", body: "{}" } : {});
  } catch (err) {
    if (err instanceof ServerError && err.status === 404) return null;
    // Rate-limited manual check: the plain status is fine.
    if (refresh && err instanceof ServerError && err.status === 429) return fetchServerUpdates(conn, false);
    throw err;
  }
}

export async function serverVersion(conn: Connection): Promise<string | null> {
  const h = await call<{ version?: string }>(conn, "/api/health", {}, 6000).catch(() => null);
  return h?.version ?? null;
}

export type StartOutcome =
  | { kind: "started"; job: UpdateJob }
  | { kind: "approval"; approvalId: string; code: string; where: string; expiresAt?: number };

/** Start updating a server. A remote device gets an owner question (428) first. */
export async function startServerUpdate(conn: Connection, opts: { now?: boolean; approvalId?: string } = {}): Promise<StartOutcome> {
  try {
    const r = await call<{ job: UpdateJob }>(conn, "/api/updates/server", {
      method: "POST",
      body: JSON.stringify({ now: !!opts.now }),
      headers: opts.approvalId ? { "X-Mercury-Approval": opts.approvalId } : {},
    });
    return { kind: "started", job: r.job };
  } catch (err) {
    if (err instanceof ServerError && err.status === 409 && err.body.job) return { kind: "started", job: err.body.job as UpdateJob };
    if (err instanceof ServerError && err.status === 428 && typeof err.body.approvalId === "string" && !opts.approvalId) {
      return {
        kind: "approval",
        approvalId: err.body.approvalId,
        code: String(err.body.code ?? ""),
        where: String(err.body.where ?? "the computer Mercury runs on"),
        expiresAt: typeof err.body.expiresAt === "number" ? err.body.expiresAt : undefined,
      };
    }
    throw err;
  }
}

export async function approvalStatus(conn: Connection, approvalId: string): Promise<string> {
  const r = await call<{ status?: string }>(conn, `/api/security/approvals/${encodeURIComponent(approvalId)}/status`, {}, 8000);
  return r.status ?? "pending";
}

export async function cancelServerUpdate(conn: Connection): Promise<void> {
  await call(conn, "/api/updates/server/cancel", { method: "POST", body: "{}" });
}
