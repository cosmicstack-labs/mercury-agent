import type { DeviceSummary } from '../web/devices.js';
import type { OwnerApproval } from './owner-approvals.js';
import type { RemoteSettings } from './remote-settings.js';
import type { AuditEntry } from './audit.js';
import type { SecurityFinding } from './check.js';
import type { PairCodeShown, PairOutcome } from './pair-codes.js';
import { parseIpRule } from './ip-match.js';
import { qrBlocks } from '../plugins/qr-svg.js';

/**
 * The owner's remote-access screen: `/server` in the terminal (and in
 * Mercury Desktop on this computer), and `mercury server`. One menu over two
 * kinds of plumbing (the running Mercury's own state, or its API from a
 * separate process) and two kinds of screen (arrow-key menus, choice prompts).
 */

export interface ServerStatus {
  remote: RemoteSettings;
  devices: DeviceSummary[];
  browsers: number;
  pending: OwnerApproval[];
  approvalRoutes: string[];
  lastRemote: { at: number; proxied: boolean; clientIpKnown: boolean; ip: string } | null;
  check: { summary: string; findings: SecurityFinding[] };
  /** The address pairing QR codes carry (absent from a Mercury before 1.5.6). */
  phone?: PhoneAddress;
}

export interface PhoneAddress {
  /** What the owner saved (web.publicUrl), if anything. */
  saved: string | null;
  /** What a QR code would carry now. */
  address: string | null;
  source: 'saved' | 'tailscale' | null;
  /** Why there is no usable address. */
  problem: string | null;
}

export interface AddressResult {
  ok: boolean;
  address: string | null;
  message: string;
}

export interface ServerOps {
  status(): Promise<ServerStatus>;
  setRemote(patch: Partial<RemoteSettings>): Promise<void>;
  decide(idOrCode: string, decision: 'allow' | 'deny'): Promise<OwnerApproval | null>;
  createDevice(name: string): Promise<{ token: string; device: DeviceSummary }>;
  revoke(id: string): Promise<boolean>;
  revokeAll(): Promise<number>;
  audit(limit: number): Promise<AuditEntry[]>;
  pair(address?: string): Promise<PairStart>;
  waitPair(id: string): Promise<PairOutcome>;
  cancelPair(): Promise<void>;
  /** Save the phone address (null clears it: automatic). */
  setAddress(address: string | null): Promise<AddressResult>;
}

export type PairRefusal = 'remote-off' | 'limit' | 'not-running' | 'none' | 'insecure' | 'loopback' | 'invalid';

const ASKS_FOR_ADDRESS: ReadonlySet<PairRefusal> = new Set(['none', 'insecure', 'loopback', 'invalid']);

export type PairStart = ({ ok: true } & PairCodeShown) | { ok: false; reason: PairRefusal; message: string };

export interface ServerUi {
  choose(title: string, options: Array<{ value: string; label: string }>): Promise<string | null>;
  say(text: string): Promise<void>;
  /** Something that must not stay in a transcript (a new token): shown until acknowledged. 'copied' when it went to the clipboard. */
  secret(text: string, copy?: string): Promise<void | 'copied' | 'ok'>;
  /** One line of typed text (an address); '' or null when the owner backed out. Absent where nothing can be typed. */
  ask?(title: string, hint?: string): Promise<string | null>;
  terminal?: boolean;
  waitFor?<T>(text: string, until: Promise<T>): Promise<T | null>;
}

export function pairScreenText(p: PairCodeShown, terminal: boolean, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((p.expiresAt - now) / 60_000));
  const qr = qrBlocks(p.url, { ansi: terminal });
  return [
    'Scan with the Mercury app (Connect → Scan to connect), or type in:',
    `  Address  ${p.address}`,
    `  Code     ${p.display}  (works once, for ${minutes} minutes)`,
    '',
    terminal ? qr : `\`\`\`text\n${qr}\n\`\`\``,
    ...(terminal ? [] : ['', 'Clearer in Mercury Desktop: Settings → Connections → Paired devices → Pair a phone.']),
  ].join('\n');
}

export function pairOutcomeText(o: PairOutcome): string {
  if (o.status === 'paired') return `✓ Paired with ${o.device.name}${o.device.platform && o.device.platform !== 'unknown' ? ` (${o.device.platform})` : ''}.`;
  if (o.status === 'expired') return 'The pairing code expired before a phone used it. Run /server pair for a new one.';
  if (o.status === 'replaced') return 'A newer pairing code replaced this one.';
  return 'Cancelled: that pairing code no longer works.';
}

const ago = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return 'never used';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
};

export function deviceLine(d: DeviceSummary, now = Date.now()): string {
  return `${d.name} · ${d.platform} · ${ago(d.lastSeenAt, now)}${d.lastIp ? ` · ${d.lastIp}` : ''}`;
}

export function statusLine(s: ServerStatus): string {
  const r = s.remote;
  const parts = [
    r.enabled ? 'Remote access: on' : 'Remote access: off',
    `${s.devices.length} device${s.devices.length === 1 ? '' : 's'}`,
    s.pending.length ? `${s.pending.length} waiting for you` : null,
    `Security: ${s.check.summary}`,
  ].filter(Boolean);
  return parts.join(' · ');
}

export function statusText(s: ServerStatus): string {
  const r = s.remote;
  const lines = [
    `**Remote access** ${r.enabled ? 'on' : 'off'}${r.enabled ? (r.allowIps.length ? ` · only from ${r.allowIps.join(', ')}` : ' · from any address') : ''}`,
    `**Devices** ${s.devices.length} of ${r.maxDevices}${r.idleDays ? ` · unused ones expire after ${r.idleDays} days` : ' · never expire'}`,
    ...s.devices.map((d) => `  · ${deviceLine(d)}`),
    `**Remote terminal** ${r.allowShell ? 'on (each command asks you)' : 'off'}`,
    `**Approvals reach you on** ${s.approvalRoutes.join(', ')}`,
    s.lastRemote ? `**Last remote request** ${ago(new Date(s.lastRemote.at).toISOString())}${s.lastRemote.proxied ? ' through a tunnel' : ''}${s.lastRemote.clientIpKnown ? ` from ${s.lastRemote.ip}` : ' (the tunnel did not say from where)'}` : '**Last remote request** none since Mercury started',
    ...(s.phone ? [`**Phone address** ${phoneAddressLabel(s.phone)}`] : []),
    `**Security check** ${s.check.summary}`,
  ];
  if (s.pending.length) lines.push('', '**Waiting for you**', ...s.pending.map((p) => `  · ${p.title} (code ${p.code})${p.ip ? ` from ${p.ip}` : ''}`));
  return lines.join('\n');
}

export function phoneAddressLabel(p: PhoneAddress): string {
  if (p.saved && p.address === p.saved) return `${p.saved} (saved)`;
  if (p.source === 'tailscale' && p.address) return `${p.address} (found through Tailscale Serve)`;
  if (p.saved) return `${p.saved} (saved, but it can't be used)`;
  return 'not set';
}

export function findingsText(f: SecurityFinding[]): string {
  const mark = { ok: '✓', info: '·', warn: '!', risk: '✗' } as const;
  return f.map((x) => `${mark[x.level]} ${x.title}${x.detail ? `\n    ${x.detail}` : ''}${x.fix ? `\n    → ${x.fix}` : ''}`).join('\n');
}

export function auditText(entries: AuditEntry[]): string {
  if (!entries.length) return 'Nothing in the security log yet.';
  const label: Record<string, string> = {
    'pair.requested': 'asked to pair', 'pair.approved': 'paired (approved)', 'pair.denied': 'pairing denied', 'pair.expired': 'pairing expired', 'pair.local': 'paired on this computer',
    'pair.code.created': 'pairing code made', 'pair.code.redeemed': 'paired with a code', 'pair.code.expired': 'pairing code ended',
    'device.revoked': 'signed out', 'device.expired': 'expired (unused)', 'device.new-location': 'connected from a new address', 'device.blocked': 'refused',
    'action.requested': 'asked to', 'action.allowed': 'allowed', 'action.denied': 'denied',
    'remote.changed': 'remote access changed', 'login.failed': 'wrong code or token', 'login.locked': 'sign-in locked (too many tries)', 'password.changed': 'password changed',
  };
  const local = (iso: string): string => {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return entries.map((e) => `${local(e.at)}  ${e.who ? `${e.who}: ` : ''}${label[e.kind] ?? e.kind}${e.detail ? ` ${e.detail}` : ''}${e.ip ? ` (${e.ip})` : ''}${e.by ? ` · by ${e.by}` : ''}`).join('\n');
}

/** `/server <words>`: the menu's actions as one-line commands (and the ones that need typed input). */
export async function runServerCommand(args: string, ops: ServerOps, ui: ServerUi): Promise<boolean> {
  const [sub = '', ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const arg = rest.join(' ');
  switch (sub.toLowerCase()) {
    case '':
      await serverMenu(ops, ui);
      return true;
    case 'status':
      await ui.say(statusText(await ops.status()));
      return true;
    case 'on':
    case 'off':
      await ops.setRemote({ enabled: sub === 'on' });
      await ui.say(sub === 'on' ? 'Remote access is on: approved devices can connect.' : 'Remote access is off: only this computer can use Mercury. Devices stay paired; turn it on again any time.');
      return true;
    case 'approve':
    case 'allow':
    case 'deny': {
      if (!arg) { await ui.say(`Usage: /server ${sub} <code>`); return true; }
      const a = await ops.decide(arg, sub === 'deny' ? 'deny' : 'allow');
      await ui.say(a ? `${a.status === 'allowed' ? '✓ Approved' : '✗ Denied'}: ${a.title}${a.kind === 'action' ? ` for ${a.who}` : ''}.` : 'No question is waiting with that code (it may have expired).');
      return true;
    }
    case 'devices':
      await ui.say((await ops.status()).devices.map((d) => `${d.id}  ${deviceLine(d)}`).join('\n') || 'No devices are paired.');
      return true;
    case 'revoke': {
      const s = await ops.status();
      const d = s.devices.find((x) => x.id === arg || x.name.toLowerCase() === arg.toLowerCase());
      if (!d) { await ui.say('No device with that id or name. /server devices lists them.'); return true; }
      await ops.revoke(d.id);
      await ui.say(`Signed out “${d.name}”. It can't connect any more.`);
      return true;
    }
    case 'revoke-all': {
      const n = await ops.revokeAll();
      await ui.say(n ? `Signed out all ${n} devices.` : 'No devices were paired.');
      return true;
    }
    case 'token': {
      const created = await ops.createDevice(arg || 'Manual token');
      const shown = await ui.secret(`Token for “${created.device.name}” (shown only now):\n\n${created.token}\n\nPaste it into the device (Mercury Desktop → Add a remote → Token).`, created.token);
      if (shown === 'copied') await ui.say(`✓ Token for “${created.device.name}” copied. Paste it into the device (it's not shown again).`);
      return true;
    }
    case 'pair': {
      let started = await ops.pair(arg || undefined);
      if (!started.ok && started.reason === 'remote-off') {
        const on = await ui.choose("Remote access is off, so a phone can't connect. Turn it on?", [{ value: 'on', label: 'Turn remote access on' }, { value: 'off', label: 'Leave it off' }]);
        if (on !== 'on') { await ui.say('Remote access stays off. Turn it on with /server on, then pair again.'); return true; }
        await ops.setRemote({ enabled: true });
        started = await ops.pair(arg || undefined);
      }
      let typedAddress: string | null = null;
      for (let tries = 0; tries < 5 && ui.ask && !started.ok && ASKS_FOR_ADDRESS.has(started.reason); tries++) {
        const typed = (await ui.ask(`${started.message}\n\nThe address your phone opens Mercury at`, 'For example https://mercury.example.com. Enter to use it, Esc to stop.'))?.trim();
        if (!typed) break;
        typedAddress = typed;
        started = await ops.pair(typed);
      }
      if (!started.ok) { await ui.say(started.message); return true; }
      const screen = pairScreenText(started, ui.terminal === true);
      const until = ops.waitPair(started.id);
      if (!ui.waitFor) {
        await ui.say(screen);
        void until.then((o) => ui.say(pairOutcomeText(o)), () => {});
        return true;
      }
      const outcome = await ui.waitFor(screen, until);
      if (outcome === null) {
        await ops.cancelPair();
        await ui.say(pairOutcomeText({ status: 'cancelled' }));
        return true;
      }
      await ui.say(pairOutcomeText(outcome));
      if (outcome.status === 'paired' && typedAddress) {
        const keep = await ui.choose(`Save ${started.address} as the phone address, so the next QR code uses it?`, [{ value: 'save', label: 'Save it' }, { value: 'no', label: 'Not now' }]);
        if (keep === 'save') await ui.say((await ops.setAddress(started.address)).message);
      }
      return true;
    }
    case 'address': {
      if (!arg) {
        const s = await ops.status();
        await ui.say([
          `Phone address: ${s.phone ? phoneAddressLabel(s.phone) : 'not set'}`,
          ...(s.phone?.problem ? [s.phone.problem] : []),
          'Set it with /server address https://your-tunnel-address, or /server address auto to let Mercury find it (Tailscale Serve).',
        ].join('\n'));
        return true;
      }
      await ui.say((await ops.setAddress(arg)).message);
      return true;
    }
    case 'allow-ip': {
      const rule = parseIpRule(arg);
      if (!rule) { await ui.say('Give an address or range, e.g. /server allow-ip 203.0.113.7 or /server allow-ip 100.64.0.0/10 (a Tailscale network).'); return true; }
      const s = await ops.status();
      await ops.setRemote({ allowIps: [...new Set([...s.remote.allowIps, rule])] });
      await ui.say(`Allowed ${rule}. Only listed addresses can connect now${s.lastRemote && !s.lastRemote.clientIpKnown ? ' — but your tunnel does not pass client addresses, so remote devices will be refused until it does.' : '.'}`);
      return true;
    }
    case 'remove-ip': {
      const s = await ops.status();
      const rule = parseIpRule(arg) ?? arg;
      await ops.setRemote({ allowIps: s.remote.allowIps.filter((r) => r !== rule) });
      await ui.say(s.remote.allowIps.includes(rule) ? `Removed ${rule}.` : `${rule} wasn't on the list.`);
      return true;
    }
    case 'allow-any':
      await ops.setRemote({ allowIps: [] });
      await ui.say('Any address may connect again (devices still need to be approved).');
      return true;
    case 'shell': {
      if (arg !== 'on' && arg !== 'off') { await ui.say('Usage: /server shell on|off'); return true; }
      await ops.setRemote({ allowShell: arg === 'on' });
      await ui.say(arg === 'on' ? 'Remote devices may use the terminal; each command asks you first.' : 'The terminal is off for remote devices.');
      return true;
    }
    case 'password': {
      await ui.say('Mercury has no password any more: devices connect with a QR code (/server pair) or a device token (/server token <name>), and a browser here opens with mercury web.');
      return true;
    }
    case 'expire': {
      const days = arg === 'never' ? 0 : Number(arg);
      if (!Number.isFinite(days) || days < 0) { await ui.say('Usage: /server expire <days> | never'); return true; }
      await ops.setRemote({ idleDays: Math.round(days) });
      await ui.say(days ? `Devices unused for ${Math.round(days)} days now stop working until you approve them again.` : 'Devices no longer expire when unused.');
      return true;
    }
    case 'limit': {
      const n = Number(arg);
      if (!Number.isFinite(n) || n < 1) { await ui.say('Usage: /server limit <number>'); return true; }
      await ops.setRemote({ maxDevices: Math.round(n) });
      await ui.say(`Up to ${Math.round(n)} devices can be paired.`);
      return true;
    }
    case 'check':
      await ui.say(findingsText((await ops.status()).check.findings));
      return true;
    case 'log':
      await ui.say(auditText(await ops.audit(Number(arg) || 20)));
      return true;
    default:
      await ui.say(SERVER_HELP);
      return true;
  }
}

export const SERVER_HELP = [
  '/server — remote access and its security (this computer only):',
  '  /server                 open the menu',
  '  /server status          what can connect, and how',
  '  /server on | off        allow or refuse other devices',
  '  /server approve <code>  let a waiting device or action through (deny <code> to refuse)',
  '  /server devices         paired devices · /server revoke <id|name> · /server revoke-all',
  '  /server pair [address]  show a QR code to pair a phone (a one-time code, 5 minutes)',
  '  /server address <url|auto>  the address phones open Mercury at (pairing QR codes use it)',
  '  /server token <name>    make a token for a device by hand (shown once)',
  '  /server allow-ip <ip|range> · remove-ip <ip|range> · allow-any',
  '  /server shell on|off    the terminal for remote devices (each command still asks you)',
  '  /server expire <days>|never · /server limit <n>',
  '  /server check           the security check · /server log  the security log',
].join('\n');

/** The interactive menu. Returns when the owner picks Done (or closes it). */
export async function serverMenu(ops: ServerOps, ui: ServerUi): Promise<void> {
  for (let guard = 0; guard < 200; guard++) {
    const s = await ops.status();
    const r = s.remote;
    const pick = await ui.choose(statusLine(s), [
      ...(s.pending.length ? [{ value: 'pending', label: `Waiting for you (${s.pending.length})` }] : []),
      { value: 'devices', label: `Devices (${s.devices.length})` },
      { value: 'pair', label: 'Pair a phone (QR code)' },
      ...(s.phone ? [{ value: 'address', label: `Phone address: ${phoneAddressLabel(s.phone)}` }] : []),
      { value: 'toggle', label: r.enabled ? 'Turn remote access off' : 'Turn remote access on' },
      { value: 'ips', label: `Allowed addresses: ${r.allowIps.length ? r.allowIps.join(', ') : 'any'}` },
      { value: 'shell', label: `Terminal for remote devices: ${r.allowShell ? 'on' : 'off'}` },
      { value: 'check', label: `Security check: ${s.check.summary}` },
      { value: 'log', label: 'Security log' },
      { value: 'status', label: 'Show everything' },
      { value: 'done', label: 'Done' },
    ]);
    if (!pick || pick === 'done') return;
    if (pick === 'status') await ui.say(statusText(s));
    if (pick === 'pair') await runServerCommand('pair', ops, ui);
    if (pick === 'address') await phoneAddressMenu(ops, ui);
    if (pick === 'toggle') await runServerCommand(r.enabled ? 'off' : 'on', ops, ui);
    if (pick === 'check') await ui.say(findingsText(s.check.findings));
    if (pick === 'log') await ui.say(auditText(await ops.audit(20)));
    if (pick === 'shell') {
      const v = await ui.choose('The terminal for remote devices', [
        { value: 'off', label: `Off${!r.allowShell ? ' (now)' : ''} — remote devices can't run commands` },
        { value: 'on', label: `On${r.allowShell ? ' (now)' : ''} — each command asks you first` },
        { value: 'back', label: 'Back' },
      ]);
      if (v === 'on' || v === 'off') await runServerCommand(`shell ${v}`, ops, ui);
    }
    if (pick === 'ips') {
      await allowedAddressesMenu(ops, ui);
    }
    if (pick === 'pending') {
      const v = await ui.choose('Waiting for you', [...s.pending.map((p) => ({ value: p.id, label: `${p.title}${p.ip ? ` · ${p.ip}` : ''} · code ${p.code}` })), { value: 'back', label: 'Back' }]);
      const q = s.pending.find((p) => p.id === v);
      if (q) {
        const d = await ui.choose(`${q.title}${q.detail ? ` — ${q.detail}` : ''}`, [{ value: 'allow', label: q.kind === 'pair' ? 'Approve this device' : 'Allow it, once' }, { value: 'deny', label: 'Deny' }, { value: 'back', label: 'Back' }]);
        if (d === 'allow' || d === 'deny') {
          const a = await ops.decide(q.id, d);
          await ui.say(a ? `${a.status === 'allowed' ? '✓ Approved' : '✗ Denied'}: ${a.title}.` : 'That question has expired.');
        }
      }
    }
    if (pick === 'devices') await devicesMenu(ops, ui);
  }
}

const TAILSCALE = '100.64.0.0/10';

/** Allowed addresses: see the list, remove one, add one by typing it (or a suggestion). */
async function phoneAddressMenu(ops: ServerOps, ui: ServerUi): Promise<void> {
  for (let guard = 0; guard < 100; guard++) {
    const p = (await ops.status()).phone;
    const v = await ui.choose(`Phone address: ${p ? phoneAddressLabel(p) : 'not set'}${p?.problem ? `\n${p.problem}` : ''}\nPairing QR codes send phones here.`, [
      ...(ui.ask ? [{ value: 'type', label: p?.saved ? 'Change it…' : 'Type the address…' }] : [{ value: 'how', label: 'Set an address…' }]),
      ...(p?.saved ? [{ value: 'auto', label: 'Clear it (find it through Tailscale Serve)' }] : []),
      { value: 'back', label: 'Back' },
    ]);
    if (!v || v === 'back') return;
    if (v === 'how') { await ui.say('Type /server address https://your-tunnel-address'); return; }
    if (v === 'auto') { await ui.say((await ops.setAddress(null)).message); continue; }
    if (v === 'type' && ui.ask) {
      let title = 'The https:// address your phone opens Mercury at';
      for (let tries = 0; tries < 5; tries++) {
        const typed = (await ui.ask(title, 'For example https://mac.tail1234.ts.net or a Cloudflare Tunnel address. Enter to save, Esc to go back.'))?.trim();
        if (!typed) break;
        const r = await ops.setAddress(typed);
        if (r.ok) { await ui.say(r.message); break; }
        title = `${r.message}\n\nTry another address`;
      }
    }
  }
}

async function allowedAddressesMenu(ops: ServerOps, ui: ServerUi): Promise<void> {
  for (let guard = 0; guard < 100; guard++) {
    const s = await ops.status();
    const r = s.remote;
    const last = s.lastRemote?.clientIpKnown ? parseIpRule(s.lastRemote.ip) : null;
    const v = await ui.choose(`Allowed addresses: ${r.allowIps.length ? r.allowIps.join(', ') : 'any (approved devices from anywhere)'}`, [
      ...(ui.ask ? [{ value: 'type', label: 'Add an address or range…' }] : []),
      ...(last && !r.allowIps.includes(last) ? [{ value: `add:${last}`, label: `Add ${last} (the last remote device's address)` }] : []),
      ...(!r.allowIps.includes(TAILSCALE) ? [{ value: `add:${TAILSCALE}`, label: `Add ${TAILSCALE} (any device on your Tailscale network)` }] : []),
      ...r.allowIps.map((ip) => ({ value: `remove:${ip}`, label: `Remove ${ip}` })),
      ...(r.allowIps.length ? [{ value: 'any', label: 'Allow any address again' }] : []),
      ...(!ui.ask ? [{ value: 'how', label: 'Add another address…' }] : []),
      { value: 'back', label: 'Back' },
    ]);
    if (!v || v === 'back') return;
    if (v === 'any') await runServerCommand('allow-any', ops, ui);
    else if (v.startsWith('remove:')) await runServerCommand(`remove-ip ${v.slice(7)}`, ops, ui);
    else if (v.startsWith('add:')) await runServerCommand(`allow-ip ${v.slice(4)}`, ops, ui);
    else if (v === 'how') await ui.say('Type /server allow-ip <address or range>, e.g. 203.0.113.7, or 100.64.0.0/10 for a Tailscale network.');
    else if (v === 'type' && ui.ask) {
      let title = 'Address or range to allow';
      for (let tries = 0; tries < 5; tries++) {
        const typed = (await ui.ask(title, 'An address (203.0.113.7) or a range (192.168.1.0/24). Enter to add, Esc to go back.'))?.trim();
        if (!typed) break;
        if (parseIpRule(typed)) { await runServerCommand(`allow-ip ${typed}`, ops, ui); break; }
        title = `“${typed}” isn't an address or range. Try again`;
      }
    }
    if (s.lastRemote && !s.lastRemote.clientIpKnown && v !== 'back') {
      const now = await ops.status();
      if (now.remote.allowIps.length) await ui.say('Note: your tunnel does not pass client addresses yet, so the list refuses every remote device until it does.');
    }
  }
}

async function devicesMenu(ops: ServerOps, ui: ServerUi): Promise<void> {
  for (let guard = 0; guard < 100; guard++) {
    const s = await ops.status();
    const r = s.remote;
    const v = await ui.choose(`Devices (${s.devices.length} of ${r.maxDevices})`, [
      ...s.devices.map((d) => ({ value: `dev:${d.id}`, label: deviceLine(d) })),
      { value: 'token', label: 'Make a token for a device…' },
      ...(s.devices.length > 1 ? [{ value: 'all', label: 'Sign out every device' }] : []),
      { value: 'expire', label: `Unused devices expire: ${r.idleDays ? `after ${r.idleDays} days` : 'never'}` },
      { value: 'limit', label: `Device limit: ${r.maxDevices}` },
      { value: 'back', label: 'Back' },
    ]);
    if (!v || v === 'back') return;
    if (v === 'token') await runServerCommand('token Manual token', ops, ui);
    if (v === 'all') {
      const sure = await ui.choose('Sign out every device? Each one needs your approval to come back.', [{ value: 'yes', label: 'Sign them all out' }, { value: 'no', label: 'Cancel' }]);
      if (sure === 'yes') await runServerCommand('revoke-all', ops, ui);
    }
    if (v === 'expire') {
      const e = await ui.choose('Unused devices stop working after', [7, 30, 90, 365].map((d) => ({ value: String(d), label: `${d} days${r.idleDays === d ? ' (now)' : ''}` })).concat([{ value: 'never', label: `Never${r.idleDays === 0 ? ' (now)' : ''}` }]));
      if (e) await runServerCommand(`expire ${e}`, ops, ui);
    }
    if (v === 'limit') {
      const l = await ui.choose('How many devices can be paired', [3, 5, 10, 20, 50].map((n) => ({ value: String(n), label: `${n}${r.maxDevices === n ? ' (now)' : ''}` })));
      if (l) await runServerCommand(`limit ${l}`, ops, ui);
    }
    if (v.startsWith('dev:')) {
      const d = s.devices.find((x) => x.id === v.slice(4));
      if (!d) continue;
      const a = await ui.choose(`${d.name} — paired ${d.createdAt.slice(0, 10)}${d.approvedBy ? ` (approved on ${d.approvedBy})` : ''}, last used ${ago(d.lastSeenAt)}${d.lastIp ? ` from ${d.lastIp}` : ''}${d.expiresAt ? `, expires ${d.expiresAt.slice(0, 10)} if unused` : ''}`, [
        { value: 'revoke', label: 'Sign this device out' },
        { value: 'back', label: 'Back' },
      ]);
      if (a === 'revoke') await runServerCommand(`revoke ${d.id}`, ops, ui);
    }
  }
}
