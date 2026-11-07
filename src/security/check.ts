import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compareSync } from 'bcryptjs';
import { getMercuryHome } from '../utils/config.js';
import { loadPermissionMode } from '../capabilities/permission-mode-store.js';
import { listDevices } from '../web/devices.js';
import { loadWebAuth } from '../web/auth.js';
import { readRemoteSettings } from './remote-settings.js';

/**
 * The security check (`mercury doctor --security`, /server → Security check,
 * Mercury Desktop): what a careful person would look at before letting other
 * devices reach this Mercury, each with what to do about it.
 */

export interface SecurityFinding {
  level: 'ok' | 'info' | 'warn' | 'risk';
  title: string;
  detail?: string;
  fix?: string;
}

const KNOWN_WEAK = ['Mercury@123', 'mercury', 'password', 'admin', '123456', '12345678', 'changeme'];
const CREDENTIAL_FILES = ['devices.json', 'web-config.json', 'web-sessions.json', 'attach-token', 'remote.json', 'mercury.yaml', '.env'];

export interface CheckContext {
  /** The last request from outside this computer, if any (middleware.lastRemoteRequest). */
  lastRemote?: { at: number; proxied: boolean; clientIpKnown: boolean } | null;
  cloudConnected?: boolean;
  now?: number;
}

export function securityCheck(ctx: CheckContext = {}): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const now = ctx.now ?? Date.now();
  const remote = readRemoteSettings();
  const devices = listDevices();

  // Password
  const auth = loadWebAuth();
  if (!auth) {
    out.push({ level: 'info', title: 'No sign-in password yet', detail: 'Nobody can sign in from another device until one is set.', fix: 'mercury web-reset-password' });
  } else {
    const weak = KNOWN_WEAK.find((p) => { try { return compareSync(p, auth.password_hash); } catch { return false; } });
    if (weak) out.push({ level: 'risk', title: 'The sign-in password is a well-known one', detail: `It is “${weak}”, which anyone can guess.`, fix: 'Change it: /server → Password, or mercury web-reset-password' });
    else out.push({ level: 'ok', title: 'The sign-in password is not a well-known one' });
  }

  // Remote access
  if (!remote.enabled) {
    out.push({ level: 'ok', title: 'Remote access is off', detail: 'Only this computer can use Mercury.' });
  } else {
    out.push({ level: 'info', title: `Remote access is on · ${devices.length} device${devices.length === 1 ? '' : 's'}`, detail: remote.allowIps.length ? `Only from: ${remote.allowIps.join(', ')}` : 'From any address (with an approved device or the password).', fix: devices.length ? undefined : 'Turn it off with /server if you never connect from elsewhere.' });
    const stale = devices.filter((d) => now - Date.parse(d.lastSeenAt ?? d.createdAt) > 30 * 86_400_000);
    if (stale.length) out.push({ level: 'warn', title: `${stale.length} device${stale.length === 1 ? '' : 's'} not used in 30 days`, detail: stale.map((d) => d.name).join(', '), fix: 'Revoke the ones you no longer use: /server → Devices' });
    if (remote.idleDays === 0 && devices.length) out.push({ level: 'warn', title: 'Unused devices never expire', fix: 'Set an idle limit: /server → Devices' });
    if (remote.allowShell) out.push({ level: 'warn', title: 'Remote devices may use the terminal', detail: 'Each command still needs your approval.', fix: 'Turn it off unless you need it: /server' });
    if (loadPermissionMode() === 'allow-all' && devices.length) {
      out.push({ level: 'warn', title: 'Allow All is on while devices can connect', detail: 'Mercury acts without asking, also for a paired device. That device is trusted like you; make sure each one is yours.', fix: 'Review /server → Devices, or switch to Ask Me' });
    }
    const lr = ctx.lastRemote;
    if (lr && remote.allowIps.length && !lr.clientIpKnown) {
      out.push({ level: 'risk', title: "The address allow-list can't work with this tunnel", detail: "The last remote request didn't say which address it came from, so every remote client is refused while the list is set.", fix: 'Use a tunnel that passes the client address (Tailscale Serve, Cloudflare Tunnel), or clear the list' });
    }
  }

  // Credential files
  const home = getMercuryHome();
  if (process.platform !== 'win32') {
    const open = CREDENTIAL_FILES.filter((f) => {
      const p = join(home, f);
      try { return existsSync(p) && (statSync(p).mode & 0o077) !== 0; } catch { return false; }
    });
    if (open.length) out.push({ level: 'risk', title: 'Some credential files can be read by other users', detail: open.join(', '), fix: `chmod 600 ${open.map((f) => `~/.mercury/${f}`).join(' ')}` });
    else out.push({ level: 'ok', title: 'Credential files are private to you' });
  }

  if (ctx.cloudConnected) out.push({ level: 'info', title: 'Mercury Cloud is connected', detail: 'Allow All and skill installs from Cloud ask you first.' });
  return out;
}

export function summarizeFindings(f: SecurityFinding[]): string {
  const risks = f.filter((x) => x.level === 'risk').length;
  const warns = f.filter((x) => x.level === 'warn').length;
  return risks ? `${risks} risk${risks === 1 ? '' : 's'}${warns ? `, ${warns} to review` : ''}` : warns ? `${warns} to review` : 'All good';
}
