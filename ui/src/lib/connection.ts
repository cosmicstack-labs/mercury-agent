/* ═══════════════════════════════════════════════════════════════
   Connection — where the API lives and how we prove who we are.

   Served by the runtime itself (the normal web dashboard) nothing is
   configured: requests are same-origin and the session cookie does the
   work. Hosted elsewhere (Mercury Desktop, a phone, a dev server) the
   shell calls configureApi() once with the runtime's URL and a device
   token, and every request and event stream picks it up from here.
   ═══════════════════════════════════════════════════════════════ */

export interface ApiConnection {
  /** Origin of the runtime, no trailing slash. "" = same origin. */
  baseUrl: string;
  /** Bearer credential (device token or session token). null = cookie session. */
  token: string | null;
}

export interface ConfigureApiOptions extends Partial<ApiConnection> {
  /** Called on a 401 instead of the default redirect to /login. */
  onUnauthorized?: (() => void) | null;
  /** Called after a sign-out completes instead of the default redirect. */
  onSignedOut?: (() => void) | null;
}

let connection: ApiConnection = { baseUrl: "", token: null };
let unauthorizedHandler: (() => void) | null = null;
let signedOutHandler: (() => void) | null = null;

export function configureApi(options: ConfigureApiOptions): void {
  connection = {
    baseUrl: normalizeBaseUrl(options.baseUrl ?? connection.baseUrl),
    token: options.token === undefined ? connection.token : options.token,
  };
  if (options.onUnauthorized !== undefined) unauthorizedHandler = options.onUnauthorized;
  if (options.onSignedOut !== undefined) signedOutHandler = options.onSignedOut;
}

export function getConnection(): ApiConnection {
  return connection;
}

/** True when a shell (not the runtime) hosts this UI: Bearer auth, absolute URLs. */
export function isRemoteMode(): boolean {
  return connection.token !== null || connection.baseUrl !== "";
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${connection.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export function authHeaders(): Record<string, string> {
  return connection.token ? { Authorization: `Bearer ${connection.token}` } : {};
}

/** The 401 path: a shell decides (re-pair, pick another connection); the web redirects. */
export function handleUnauthorized(): void {
  if (unauthorizedHandler) {
    unauthorizedHandler();
    return;
  }
  if (typeof window !== "undefined") window.location.href = "/login";
}

export function handleSignedOut(): void {
  if (signedOutHandler) {
    signedOutHandler();
    return;
  }
  if (typeof window !== "undefined") window.location.href = "/login";
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}
