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
    throw new ApiError("Unauthorized", 401);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
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
