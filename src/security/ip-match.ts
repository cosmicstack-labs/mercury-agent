import { isIP } from 'node:net';

/**
 * Allowed-address rules: an address ("203.0.113.7", "2001:db8::1") or a
 * range ("203.0.113.0/24", "100.64.0.0/10" for a tailnet, "2001:db8::/32").
 */

function v4(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) | BigInt(Number(p));
  }
  return n;
}

function v6(ip: string): bigint | null {
  let s = ip.toLowerCase();
  // An IPv4-mapped tail ("::ffff:1.2.3.4").
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const n4 = v4(tail[1]);
    if (n4 === null) return null;
    s = `${s.slice(0, -tail[1].length)}${(n4 >> 16n).toString(16)}:${(n4 & 0xffffn).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** "::ffff:1.2.3.4" is 1.2.3.4. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip.trim());
  return m ? m[1] : ip.trim().replace(/^\[|\]$/g, '');
}

/** A valid rule, normalized, or null. */
export function parseIpRule(rule: string): string | null {
  const [addr, bits, extra] = rule.trim().split('/');
  if (extra !== undefined || !addr) return null;
  const ip = normalizeIp(addr);
  const family = isIP(ip);
  if (!family) return null;
  if (bits === undefined) return ip;
  if (!/^\d{1,3}$/.test(bits)) return null;
  const n = Number(bits);
  if (n > (family === 4 ? 32 : 128)) return null;
  return `${ip}/${n}`;
}

export function ipMatches(ipRaw: string, rule: string): boolean {
  const ip = normalizeIp(ipRaw);
  const parsed = parseIpRule(rule);
  if (!parsed) return false;
  const [base, bitsStr] = parsed.split('/');
  const family = isIP(ip);
  if (!family || family !== isIP(base)) return false;
  const a = family === 4 ? v4(ip) : v6(ip);
  const b = family === 4 ? v4(base) : v6(base);
  if (a === null || b === null) return false;
  const width = family === 4 ? 32 : 128;
  const bits = bitsStr === undefined ? width : Number(bitsStr);
  if (bits === 0) return true;
  const shift = BigInt(width - bits);
  return (a >> shift) === (b >> shift);
}

export function ipAllowed(ip: string, rules: readonly string[]): boolean {
  return rules.some((r) => ipMatches(ip, r));
}
