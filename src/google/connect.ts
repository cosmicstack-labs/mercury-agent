import { spawn, type ChildProcess } from 'node:child_process';

export const DEFAULT_GOOGLE_SERVICES = ['gmail', 'drive', 'docs'];

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const URL_TIMEOUT_MS = 30_000;
const SIGN_IN_URL = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/;

export interface GoogleLoginOptions {
  gwsPath: string;
  services?: string[];
  write?: boolean;
  clientId?: string;
  clientSecret?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  urlTimeoutMs?: number;
}

export interface GoogleLoginResult {
  account: string | null;
  scopes: string[];
}

export interface PendingGoogleLogin {
  url: string;
  port: number;
  done: Promise<GoogleLoginResult>;
  cancel(): void;
}

export interface GoogleStatus {
  signedIn: boolean;
  account: string | null;
  scopes: string[];
  clientConfigured: boolean;
}

interface LoginState {
  settled: boolean;
  redirected: boolean;
}

const states = new WeakMap<PendingGoogleLogin, LoginState>();
let active: PendingGoogleLogin | null = null;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function completeLines(text: string): string {
  return text.slice(0, text.lastIndexOf('\n') + 1);
}

function spawnGws(gwsPath: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const viaShell = /\.(cmd|bat)$/i.test(gwsPath);
  return spawn(viaShell ? `"${gwsPath}"` : gwsPath, args, {
    env,
    shell: viaShell,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}

function lastLine(text: string): string {
  return stripAnsi(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? '';
}

function parseJson(text: string): Record<string, unknown> | null {
  const match = stripAnsi(text).match(/\{[\s\S]*\}\s*$/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function portOf(url: string): number | null {
  try {
    const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '');
    const port = Number(redirect.port);
    return ['localhost', '127.0.0.1'].includes(redirect.hostname) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function accountOf(value: unknown): string | null {
  return typeof value === 'string' && value.includes('@') ? value : null;
}

function scopesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((scope): scope is string => typeof scope === 'string') : [];
}

export function activeGoogleLogin(): PendingGoogleLogin | null {
  return active && !states.get(active)?.settled ? active : null;
}

export function startGoogleLogin(opts: GoogleLoginOptions): Promise<PendingGoogleLogin> {
  const services = opts.services ?? DEFAULT_GOOGLE_SERVICES;
  if (services.length === 0 || !services.every((service) => /^[a-z][a-z0-9-]*$/.test(service))) {
    return Promise.reject(new Error(`Not a list of Google services: ${services.join(',')}`));
  }
  activeGoogleLogin()?.cancel();

  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  if (opts.clientId) env.GOOGLE_WORKSPACE_CLI_CLIENT_ID = opts.clientId;
  if (opts.clientSecret) env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET = opts.clientSecret;
  const args = ['auth', 'login', '-s', services.join(','), ...(opts.write ? [] : ['--readonly'])];

  return new Promise<PendingGoogleLogin>((resolveStart, rejectStart) => {
    const child = spawnGws(opts.gwsPath, args, env);
    let stdout = '';
    let stderr = '';
    let pending: PendingGoogleLogin | null = null;
    let finish: { resolve: (r: GoogleLoginResult) => void; reject: (e: Error) => void } | null = null;
    let failure: Error | null = null;

    const urlTimer = setTimeout(() => {
      failure = new Error(`gws didn't show a sign-in link within ${Math.round((opts.urlTimeoutMs ?? URL_TIMEOUT_MS) / 1000)} seconds. ${lastLine(stderr || stdout)}`.trim());
      killTree(child);
    }, opts.urlTimeoutMs ?? URL_TIMEOUT_MS);
    let loginTimer: NodeJS.Timeout | null = null;

    const settle = (error: Error | null, result?: GoogleLoginResult) => {
      clearTimeout(urlTimer);
      if (loginTimer) clearTimeout(loginTimer);
      if (pending) {
        const state = states.get(pending);
        if (state?.settled) return;
        if (state) state.settled = true;
        if (error) finish?.reject(error);
        else if (result) finish?.resolve(result);
      } else {
        rejectStart(error ?? new Error('gws stopped before showing a sign-in link.'));
      }
    };

    const watch = (chunk: Buffer, which: 'out' | 'err') => {
      if (which === 'out') stdout += chunk.toString();
      else stderr += chunk.toString();
      if (pending) return;
      const url = stripAnsi(completeLines(which === 'out' ? stdout : stderr)).match(SIGN_IN_URL)?.[0];
      if (!url) return;
      const port = portOf(url);
      if (!port) {
        failure = new Error("gws's sign-in link has no local address to come back to.");
        killTree(child);
        return;
      }
      clearTimeout(urlTimer);
      const done = new Promise<GoogleLoginResult>((resolve, reject) => { finish = { resolve, reject }; });
      done.catch(() => {});
      const login: PendingGoogleLogin = {
        url,
        port,
        done,
        cancel: () => {
          failure = failure ?? new Error('The Google sign-in was cancelled.');
          killTree(child);
          settle(failure);
        },
      };
      pending = login;
      states.set(login, { settled: false, redirected: false });
      active = login;
      loginTimer = setTimeout(() => {
        failure = new Error(`The Google sign-in timed out after ${Math.round((opts.timeoutMs ?? LOGIN_TIMEOUT_MS) / 60_000)} minutes.`);
        killTree(child);
      }, opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
      resolveStart(login);
    };

    child.stdout?.on('data', (chunk: Buffer) => watch(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => watch(chunk, 'err'));
    child.on('error', (err) => settle(new Error(`Couldn't run gws: ${err.message}`)));
    child.on('close', (code) => {
      if (failure) return settle(failure);
      if (code !== 0) return settle(new Error(lastLine(stderr) || lastLine(stdout) || `gws auth login stopped (exit ${code}).`));
      const result = parseJson(stdout);
      if (!result || result.status !== 'success') return settle(new Error(lastLine(stdout) || 'gws finished without confirming the sign-in.'));
      settle(null, { account: accountOf(result.account), scopes: scopesOf(result.scopes) });
    });
  });
}

export async function submitGoogleRedirect(login: PendingGoogleLogin, address: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const state = states.get(login);
  if (!state || state.settled) throw new Error('No Google sign-in is waiting. Start one with connect.');
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new Error("That isn't the address from the sign-in page.");
  }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || Number(url.port) !== login.port) {
    throw new Error(`That isn't the address of this sign-in. It should start with http://localhost:${login.port}/`);
  }
  const error = url.searchParams.get('error');
  if (error) {
    login.cancel();
    throw new Error(`Google didn't allow access (${error}).`);
  }
  if (!url.searchParams.get('code')) throw new Error("That address has no sign-in code. Copy the whole address from your browser's address bar.");
  if (state.redirected) throw new Error('This sign-in already received its address.');
  state.redirected = true;
  await fetchImpl(`http://127.0.0.1:${login.port}${url.pathname}${url.search}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
}

function runGws(gwsPath: string, args: string[], timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnGws(gwsPath, args, process.env);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`Couldn't run gws: ${err.message}`)); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export async function gwsVersion(gwsPath: string): Promise<string | null> {
  const { stdout } = await runGws(gwsPath, ['--version'], 10_000);
  return stdout.match(/gws\s+(\d+\.\d+\.\d+\S*)/)?.[1] ?? null;
}

export async function googleStatus(gwsPath: string): Promise<GoogleStatus> {
  const { code, stdout, stderr } = await runGws(gwsPath, ['auth', 'status']);
  const status = parseJson(stdout);
  if (code !== 0 || !status) throw new Error(lastLine(stderr) || lastLine(stdout) || "gws couldn't report its sign-in.");
  return {
    signedIn: status.auth_method === 'oauth2' && status.has_refresh_token !== false,
    account: accountOf(status.user),
    scopes: scopesOf(status.scopes),
    clientConfigured: status.client_config_exists === true,
  };
}

export function isReadOnly(scopes: string[]): boolean {
  const access = scopes.filter((scope) => scope.startsWith('https://www.googleapis.com/auth/') && !/\/auth\/userinfo\./.test(scope));
  return access.every((scope) => scope.endsWith('.readonly'));
}

export async function googleLogout(gwsPath: string): Promise<{ removed: number }> {
  const { code, stdout, stderr } = await runGws(gwsPath, ['auth', 'logout']);
  const result = parseJson(stdout);
  if (code !== 0 || !result) throw new Error(lastLine(stderr) || lastLine(stdout) || "gws couldn't sign out.");
  return { removed: Array.isArray(result.removed) ? result.removed.length : 0 };
}
