/**
 * Which phone the owner meant ("call me on my iPhone", "ring the vivo", "on the Mercury app").
 * A named device is rung alone, never WhatsApp (ADR-046). Matching, in order: a device id, a
 * device's name ("Salman's iPhone", "Android (vivo)"), then its kind ("iPhone"/"iOS", "Android",
 * or a maker such as Pixel, Samsung, vivo). Two phones of the same kind are ambiguous: the answer
 * asks which.
 */
import type { DeviceSummary } from '../web/devices.js';

export type PhoneTarget =
  | { kind: 'any' }
  | { kind: 'app'; label: string }
  | { kind: 'device'; deviceIds: string[]; label: string }
  | { kind: 'unknown'; message: string };

const APP_WORDS = /^(the )?(mercury( app)?|app|my phone|phone|mobile|my mobile)$/i;
const IOS_WORDS = /\b(iphone|ios|apple)\b/i;
const ANDROID_WORDS = /\b(android|pixel|samsung|galaxy|vivo|oneplus|xiaomi|redmi|oppo|realme|motorola|nokia)\b/i;

function platformOf(d: DeviceSummary): string {
  return (d.reach?.platform ?? d.platform ?? '').toLowerCase();
}

/** A phone's name for the owner and the model: its own name, plus its kind when the name doesn't say. */
export function phoneLabel(d: DeviceSummary): string {
  const p = platformOf(d);
  const kind = p === 'ios' ? 'iPhone' : p === 'android' ? 'Android phone' : 'phone';
  const name = (d.name ?? '').trim();
  if (!name || /^manual token$/i.test(name)) return `your ${kind}`;
  return IOS_WORDS.test(name) || ANDROID_WORDS.test(name) ? `"${name}"` : `"${name}" (${kind})`;
}

export function resolvePhoneTarget(query: string | undefined, phones: DeviceSummary[]): PhoneTarget {
  const q = (query ?? '').trim();
  if (!q) return { kind: 'any' };
  if (APP_WORDS.test(q)) return { kind: 'app', label: 'the Mercury app' };
  const lower = q.toLowerCase();
  const byId = phones.filter((d) => d.id.toLowerCase() === lower);
  if (byId.length) return { kind: 'device', deviceIds: byId.map((d) => d.id), label: phoneLabel(byId[0]) };
  const strip = (s: string) => s.toLowerCase().replace(/^(my|the)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const sq = strip(q);
  // Just a kind ("android", "my iPhone"): the kind, not a device whose name happens to contain it.
  const pureKind = /^(iphone|ios|apple|android)( phone)?$/.test(sq);
  const byName = pureKind ? [] : phones.filter((d) => {
    const n = strip(d.name ?? '');
    return n.length > 0 && (n === sq || n.includes(sq) || (sq.length >= 3 && sq.includes(n)));
  });
  if (byName.length === 1) return { kind: 'device', deviceIds: [byName[0].id], label: phoneLabel(byName[0]) };
  const wantIos = IOS_WORDS.test(q);
  const wantAndroid = ANDROID_WORDS.test(q);
  if (wantIos || wantAndroid) {
    const maker = (q.match(ANDROID_WORDS)?.[1] ?? '').toLowerCase();
    let pool = phones.filter((d) => platformOf(d) === (wantIos ? 'ios' : 'android'));
    // A maker named ("the vivo") narrows by name when it can.
    if (maker && maker !== 'android') {
      const named = pool.filter((d) => (d.name ?? '').toLowerCase().includes(maker));
      if (named.length) pool = named;
    }
    if (pool.length === 1) return { kind: 'device', deviceIds: [pool[0].id], label: phoneLabel(pool[0]) };
    if (pool.length > 1) {
      return { kind: 'unknown', message: `More than one ${wantIos ? 'iPhone' : 'Android phone'} is paired: ${pool.map(phoneLabel).join(', ')}. Ask the owner which one.` };
    }
    return { kind: 'unknown', message: `No ${wantIos ? 'iPhone' : 'Android phone'} is paired with Mercury. Paired phones: ${phones.map(phoneLabel).join(', ') || 'none'}.` };
  }
  if (byName.length > 1) return { kind: 'unknown', message: `"${q}" matches more than one phone: ${byName.map(phoneLabel).join(', ')}. Ask the owner which one.` };
  return { kind: 'unknown', message: `No paired phone called "${q}". Paired phones: ${phones.map(phoneLabel).join(', ') || 'none'}.` };
}
