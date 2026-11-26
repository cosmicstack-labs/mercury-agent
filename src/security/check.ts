import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { compareSync } from 'bcryptjs';
import { getMercuryHome } from '../utils/config.js';
import { resolveFromDirs } from '../capabilities/shell/argv-lane.js';
import { pinnedServicePath } from '../cli/service.js';
import { mercuryGwsDir } from '../google/gws-binary.js';
import { loadPermissionMode } from '../capabilities/permission-mode-store.js';
import { listDevices } from '../web/devices.js';
import { getWebPort, loadWebAuth } from '../web/auth.js';
import { readRemoteSettings, type RemoteSettings } from './remote-settings.js';
import { configuredPublicUrl, hostAllowsPlainHttp, isLoopbackHost, readTailscale, toUrl, type TailscaleState } from './tunnel.js';

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
  lastRemote?: { at: number; proxied: boolean; clientIpKnown: boolean; scheme?: 'https' | 'http' | null; via?: string } | null;
  lastPlainHttp?: { at: number; ip: string } | null;
  tailscale?: TailscaleState | null;
  publicUrl?: string | null;
  port?: number;
  cloudConnected?: boolean;
  now?: number;
}

const RECENT_MS = 7 * 86_400_000;

function agoText(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 120) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

export function remoteAccessFindings(ctx: CheckContext, remote: Pick<RemoteSettings, 'enabled'>, deviceCount: number): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const devicesText = `${deviceCount} device${deviceCount === 1 ? '' : 's'}`;
  if (!remote.enabled) {
    if (deviceCount) out.push({ level: 'info', title: `Remote access is off, but ${devicesText} ${deviceCount === 1 ? 'is' : 'are'} paired`, detail: "They can't connect until remote access is on.", fix: 'mercury server on, or sign them out: mercury server revoke-all' });
    return out;
  }
  const now = ctx.now ?? Date.now();
  const port = ctx.port ?? getWebPort();
  const recent = (at: number | undefined): boolean => at !== undefined && now - at < RECENT_MS;
  const tailscale = ctx.tailscale !== undefined ? ctx.tailscale : readTailscale({ port });
  const configured = ctx.publicUrl !== undefined ? ctx.publicUrl : configuredPublicUrl();
  const publicUrl = configured ? toUrl(configured) : null;
  const lastRemote = ctx.lastRemote && recent(ctx.lastRemote.at) ? ctx.lastRemote : null;
  const plainRequest = ctx.lastPlainHttp && recent(ctx.lastPlainHttp.at) ? ctx.lastPlainHttp : null;
  const serveHttps = tailscale?.serve.find((s) => s.https);
  const servePlain = tailscale?.serve.find((s) => !s.https);

  const plainUrl = publicUrl && publicUrl.protocol === 'http:' && !hostAllowsPlainHttp(publicUrl.hostname) && !isLoopbackHost(publicUrl.hostname) ? publicUrl.origin : null;
  if (plainUrl || plainRequest) {
    out.push({
      level: 'risk',
      title: 'Mercury is reachable over plain http from the internet',
      detail: plainUrl ? `web.publicUrl is ${plainUrl}, so passwords and tokens would cross the internet unencrypted.` : `A request from ${plainRequest!.ip} came in over plain http ${agoText(plainRequest!.at, now)}.`,
      fix: `Serve Mercury over HTTPS (tailscale serve --bg ${port}, or a Cloudflare Tunnel), then set web.publicUrl to the https:// address`,
    });
  }

  const otherTunnel = !!publicUrl || (!!lastRemote && lastRemote.via !== 'tailscale' && lastRemote.via !== 'funnel');
  const certsOff = !!tailscale && (!tailscale.magicDns || !tailscale.httpsCerts);
  if (tailscale && ((servePlain && !serveHttps) || (certsOff && (tailscale.serve.length > 0 || !otherTunnel)))) {
    const off = [!tailscale.magicDns && 'MagicDNS', !tailscale.httpsCerts && 'HTTPS Certificates'].filter(Boolean).join(' and ');
    out.push({
      level: 'warn',
      title: "Tailscale Serve isn't using HTTPS",
      detail: servePlain && !serveHttps ? `It sends ${servePlain.url} to Mercury over plain http, which the phone apps refuse.` : `${off} ${off.includes(' and ') ? 'are' : 'is'} off for your tailnet, so tailscale serve can't give Mercury an https:// address.`,
      fix: `In the Tailscale admin console, open DNS and turn on MagicDNS and HTTPS Certificates, then run tailscale serve --bg ${port}`,
    });
  }

  if (!tailscale?.serve.length && !publicUrl && !lastRemote) {
    out.push({
      level: deviceCount ? 'warn' : 'info',
      title: 'Remote access is on, but no tunnel reaches Mercury',
      detail: "Mercury only listens on this computer, and it found no Tailscale Serve, no web.publicUrl and no recent remote request. If you use another tunnel, set web.publicUrl to its address.",
      fix: `tailscale serve --bg ${port}, then mercury server pair`,
    });
  }

  const working = serveHttps?.url ?? (publicUrl?.protocol === 'https:' && lastRemote?.scheme === 'https' ? publicUrl.origin : null);
  if (working) {
    out.push({ level: 'ok', title: `Remote access works over HTTPS: ${working}`, detail: serveHttps ? 'Tailscale Serve sends it to Mercury.' : 'A remote request came in over HTTPS recently.' });
  }
  return out;
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
    out.push({ level: 'info', title: `Remote access is on · ${devices.length} device${devices.length === 1 ? '' : 's'}`, detail: remote.allowIps.length ? `Only from: ${remote.allowIps.join(', ')}` : `From any address, with a device token${remote.passwordSignIn ? ' or the password (password sign-in is on)' : ''}.`, fix: devices.length ? undefined : 'Turn it off with /server if you never connect from elsewhere.' });
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
  out.push(...remoteAccessFindings({ ...ctx, now }, remote, devices.length));

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

  out.push(...gwsFindings());

  if (ctx.cloudConnected) out.push({ level: 'info', title: 'Mercury Cloud is connected', detail: 'Allow All and skill installs from Cloud ask you first.' });
  return out;
}

export interface GwsCheckOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  serviceDirs?: string[];
  mercuryBinDir?: string;
}

function gwsConfigDir(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  const configured = env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR;
  if (configured) return existsSync(configured) ? configured : null;
  const candidates = [join(home, '.config', 'gws')];
  if (platform === 'darwin') candidates.push(join(home, 'Library', 'Application Support', 'gws'));
  if (platform === 'win32') candidates.push(join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'gws'));
  return candidates.find((dir) => existsSync(dir)) ?? null;
}

export function gwsFindings(opts: GwsCheckOptions = {}): SecurityFinding[] {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const dir = gwsConfigDir(opts.home ?? homedir(), platform, env);
  if (!dir) return [];

  const out: SecurityFinding[] = [];
  const plain = join(dir, 'credentials.json');
  if (existsSync(plain)) {
    out.push({ level: 'risk', title: 'Your Google sign-in for gws is stored unencrypted', detail: plain, fix: `Run gws auth login to store it encrypted, then delete ${plain}` });
  }
  if ((platform === 'darwin' || platform === 'win32') && existsSync(join(dir, '.encryption_key'))) {
    out.push({ level: 'warn', title: "gws's encryption key is a file next to your Google sign-in", detail: 'Anyone who can read your files can decrypt the sign-in. gws normally keeps the key in the system keychain.', fix: 'Remove GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file if you set it, then run gws auth login again' });
  }
  const nodeDir = dirname(process.execPath);
  const serviceDirs = [...(opts.serviceDirs ?? pinnedServicePath(platform, nodeDir, env).split(platform === 'win32' ? ';' : ':')), opts.mercuryBinDir ?? mercuryGwsDir()];
  if (!resolveFromDirs('gws', serviceDirs, platform)) {
    out.push({
      level: 'warn',
      title: "Mercury's background service can't find gws",
      detail: "The service only looks in the system folders and Node.js's folder, so gws commands fail when Mercury runs as a service.",
      fix: platform === 'win32'
        ? `Run mercury google connect --install, or copy gws.exe from a gws release into ${nodeDir}`
        : 'Run mercury google connect --install, or: sudo ln -s "$(command -v gws)" /usr/local/bin/gws',
    });
  }
  if (out.length === 0) out.push({ level: 'ok', title: 'gws keeps your Google sign-in encrypted, and the service can find it' });
  return out;
}

export function summarizeFindings(f: SecurityFinding[]): string {
  const risks = f.filter((x) => x.level === 'risk').length;
  const warns = f.filter((x) => x.level === 'warn').length;
  return risks ? `${risks} risk${risks === 1 ? '' : 's'}${warns ? `, ${warns} to review` : ''}` : warns ? `${warns} to review` : 'All good';
}
