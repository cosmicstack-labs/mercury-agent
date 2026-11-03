import type { Context } from 'hono';
import { normalizeIp } from './ip-match.js';

/**
 * Where a request really comes from.
 *
 * Mercury listens on 127.0.0.1 only, so a remote client always arrives
 * through a tunnel or proxy on this machine (Tailscale Serve, cloudflared,
 * ngrok, nginx/Caddy) — and those connect from 127.0.0.1 too. The socket
 * address alone therefore says nothing; a request is from THIS computer only
 * when the socket is loopback, no proxy added its headers, and the Host is a
 * loopback name. Everything else is remote.
 *
 * Proxies that add none of those headers and rewrite Host to 127.0.0.1 (a
 * bare nginx `proxy_pass`) can't be told apart from a local browser; the
 * actions that matter most also require the local attach token (which only
 * a process on this machine can read), and the security check warns about it.
 */

export interface RequestOrigin {
  /** The TCP peer is this machine. */
  socketLocal: boolean;
  /** A proxy or tunnel forwarded it (one of its headers is present). */
  proxied: boolean;
  /** The Host header names this machine (localhost, 127.0.0.1, ::1). */
  hostLocal: boolean;
  /** From this computer: local socket, not proxied, local Host. */
  local: boolean;
  /** The client's address as best known: the forwarded one through a proxy, else the socket's. */
  clientIp: string;
  /** The client's address is real: the proxy passed it on, or the client connected directly (so allow-lists can work). */
  clientIpKnown: boolean;
}

const PROXY_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'cf-connecting-ip', 'cf-ray', 'true-client-ip', 'fly-client-ip', 'x-client-ip',
  'tailscale-user-login', 'tailscale-user-name', 'tailscale-headers-info',
];

const LOCAL_SOCKETS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function socketAddress(c: Context): string {
  try {
    return String((c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress || '');
  } catch {
    return '';
  }
}

/** The host part of a Host header ("127.0.0.1:6174" → "127.0.0.1", "[::1]:6174" → "::1"). */
export function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  return h.replace(/:\d+$/, '');
}

function forwardedFor(value: string): string | null {
  // Forwarded: for=203.0.113.7;proto=https, for="[2001:db8::1]"
  const all = [...value.matchAll(/for="?\[?([^\]";,]+)\]?"?/gi)].map((m) => m[1]);
  return all.length ? all[all.length - 1] : null;
}

export function requestOrigin(c: Context): RequestOrigin {
  const socket = socketAddress(c);
  const socketLocal = LOCAL_SOCKETS.has(socket);
  const header = (name: string): string => c.req.header(name) ?? '';
  const proxied = PROXY_HEADERS.some((h) => header(h) !== '');
  // The Node server builds the URL from Host, so its hostname is the Host (requests made in-process have no header).
  let urlHost = '';
  try { urlHost = new URL(c.req.url).hostname; } catch { /* none */ }
  const hostLocal = LOCAL_HOSTS.has(hostName(header('host') || urlHost));
  // The address the proxy saw. The right-most X-Forwarded-For entry is the
  // one this machine's proxy appended; anything left of it is client-supplied.
  const xff = header('x-forwarded-for').split(',').map((s) => s.trim()).filter(Boolean);
  const forwarded = header('cf-connecting-ip') || header('true-client-ip') || header('fly-client-ip')
    || xff[xff.length - 1] || header('x-real-ip') || forwardedFor(header('forwarded')) || '';
  // Known: what the proxy reported, or a direct connection's own socket address.
  const viaProxy = proxied && forwarded !== '';
  const direct = !proxied && !socketLocal && socket !== '';
  return {
    socketLocal,
    proxied,
    hostLocal,
    local: socketLocal && !proxied && hostLocal,
    clientIp: normalizeIp(viaProxy ? forwarded : socket || 'unknown'),
    clientIpKnown: viaProxy || direct,
  };
}
