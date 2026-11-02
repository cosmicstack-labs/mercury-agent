/* ═══════════════════════════════════════════════════════════════
   HTTP client — one runtime at a time, Bearer auth, typed errors.
   ═══════════════════════════════════════════════════════════════ */

export interface ApiTarget {
  /** Origin, no trailing slash. */
  baseUrl: string;
  /** Device token or attach token. */
  token: string | null;
}

let target: ApiTarget = { baseUrl: "", token: null };
let unauthorizedHandler: (() => void) | null = null;

/**
 * A remote runtime asks its owner before some actions (428 + an approval id).
 * The app waits for the owner's answer (approvalHandler shows that), then
 * repeats the request once with the approval. False = denied or given up.
 */
export type ApprovalHandler = (needed: { approvalId: string; code: string; where: string; error: string; expiresAt?: number }) => Promise<boolean>;
let approvalHandler: ApprovalHandler | null = null;
export function setApprovalHandler(fn: ApprovalHandler | null): void {
  approvalHandler = fn;
}

export function configureApi(next: Partial<ApiTarget> & { onUnauthorized?: (() => void) | null }): void {
  target = {
    baseUrl: next.baseUrl === undefined ? target.baseUrl : normalizeBaseUrl(next.baseUrl),
    token: next.token === undefined ? target.token : next.token,
  };
  if (next.onUnauthorized !== undefined) unauthorizedHandler = next.onUnauthorized;
}

export function getApiTarget(): ApiTarget {
  return target;
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${target.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export function authHeaders(): Record<string, string> {
  return target.token ? { Authorization: `Bearer ${target.token}` } : {};
}

export function normalizeBaseUrl(raw: string): string {
  return (raw ?? "").trim().replace(/\/+$/, "");
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfterSeconds: number | null = null, public readonly data: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 401) {
    unauthorizedHandler?.();
    // An expired device (unused too long) is told why.
    const body = (await res.json().catch(() => ({}))) as { error?: string; expired?: boolean };
    throw new ApiError(body.expired && body.error ? body.error : "Unauthorized", 401, null, body);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
    const asked = (init.headers as Record<string, string> | undefined)?.["X-Mercury-Approval"];
    if (res.status === 428 && body.approvalRequired === true && typeof body.approvalId === "string" && approvalHandler && !asked) {
      const ok = await approvalHandler({ approvalId: body.approvalId, code: String(body.code ?? ""), where: String(body.where ?? "the computer Mercury runs on"), error: String(body.error ?? ""), expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : undefined });
      if (!ok) throw new ApiError("The owner didn't approve this.", 403, null, { approvalDenied: true });
      return request<T>(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "X-Mercury-Approval": body.approvalId } });
    }
    const retry = res.headers.get("Retry-After");
    throw new ApiError(body.error || `Request failed (${res.status})`, res.status, retry ? Number(retry) : null, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const http = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
