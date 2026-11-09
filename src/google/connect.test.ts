import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeGoogleLogin,
  googleLogout,
  googleStatus,
  gwsVersion,
  startGoogleLogin,
  submitGoogleRedirect,
  type PendingGoogleLogin,
} from './connect.js';

const FAKE_GWS = String.raw`
const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.FAKE_GWS_MODE || 'ok';
const record = process.env.FAKE_GWS_RECORD;
if (record) fs.writeFileSync(record, JSON.stringify({
  args,
  clientId: process.env.GOOGLE_WORKSPACE_CLI_CLIENT_ID || null,
  clientSecret: process.env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET || null,
}));
if (args[0] === '--version') {
  console.log('gws 0.22.5');
  console.log('This is not an officially supported Google product.');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ auth_method: 'oauth2', has_refresh_token: true, user: 'owner@example.com', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }, null, 2));
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'logout') {
  console.log(JSON.stringify({ status: 'success', message: 'Logged out.', removed: ['a', 'b'] }, null, 2));
  process.exit(0);
}
if (mode === 'fail') {
  console.error('Error: No OAuth client configured. Run gws auth setup.');
  process.exit(1);
}
if (mode === 'silent') {
  setInterval(() => {}, 1000);
  return;
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.end('ok');
  server.close();
  if (!url.searchParams.get('code')) {
    console.error('Error: No authorization code in callback');
    process.exit(1);
  }
  console.log(JSON.stringify({ status: 'success', account: 'owner@example.com', scopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'] }, null, 2));
  process.exit(0);
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const redirect = mode === 'no-port' ? '' : '&redirect_uri=' + encodeURIComponent('http://localhost:' + port);
  const line = 'Open this URL in your browser to authenticate:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=x' + redirect + '&response_type=code\n\n';
  if (mode === 'stdout') process.stdout.write(line);
  else process.stderr.write(line);
});
`;

let work: string;
let gwsPath: string;
let record: string;
const started: PendingGoogleLogin[] = [];

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'mercury-google-connect-'));
  record = join(work, 'record.json');
  const script = join(work, 'fake-gws.cjs');
  writeFileSync(script, `(() => {${FAKE_GWS}})();`);
  if (process.platform === 'win32') {
    gwsPath = join(work, 'gws.cmd');
    writeFileSync(gwsPath, `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    gwsPath = join(work, 'gws');
    writeFileSync(gwsPath, `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`);
    chmodSync(gwsPath, 0o755);
  }
});

afterEach(() => {
  for (const login of started.splice(0)) login.cancel();
  rmSync(work, { recursive: true, force: true });
});

function env(mode = 'ok'): NodeJS.ProcessEnv {
  return { ...process.env, FAKE_GWS_MODE: mode, FAKE_GWS_RECORD: record };
}

async function start(options: Partial<Parameters<typeof startGoogleLogin>[0]> = {}, mode = 'ok'): Promise<PendingGoogleLogin> {
  const login = await startGoogleLogin({ gwsPath, env: env(mode), ...options });
  started.push(login);
  return login;
}

function recorded(): { args: string[]; clientId: string | null; clientSecret: string | null } {
  return JSON.parse(readFileSync(record, 'utf8'));
}

describe('starting a Google sign-in', () => {
  it('catches the link gws prints and its local port, read-only by default', async () => {
    const login = await start({ clientId: 'id-123', clientSecret: 'secret-456' });
    expect(login.url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/);
    expect(login.port).toBeGreaterThan(0);
    expect(recorded()).toEqual({ args: ['auth', 'login', '-s', 'gmail,drive,docs', '--readonly'], clientId: 'id-123', clientSecret: 'secret-456' });
    expect(process.env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET).toBeUndefined();
    expect(activeGoogleLogin()).toBe(login);
  }, 20_000);

  it('also finds the link on stdout, and asks for write access when told to', async () => {
    const login = await start({ write: true, services: ['gmail', 'calendar'] }, 'stdout');
    expect(login.port).toBeGreaterThan(0);
    expect(recorded().args).toEqual(['auth', 'login', '-s', 'gmail,calendar']);
  }, 20_000);

  it('refuses service names that are not plain words', async () => {
    await expect(startGoogleLogin({ gwsPath, services: ['gmail;rm -rf /'] })).rejects.toThrow(/Not a list of Google services/);
  });

  it("passes gws's error on when it stops before showing a link", async () => {
    await expect(startGoogleLogin({ gwsPath, env: env('fail') })).rejects.toThrow(/No OAuth client configured/);
  }, 20_000);

  it('gives up when gws shows no link in time', async () => {
    await expect(startGoogleLogin({ gwsPath, env: env('silent'), urlTimeoutMs: 1_500 })).rejects.toThrow(/didn't show a sign-in link/);
  }, 20_000);

  it('refuses a link with no local address to come back to', async () => {
    await expect(startGoogleLogin({ gwsPath, env: env('no-port') })).rejects.toThrow(/no local address/);
  }, 20_000);
});

describe('finishing a Google sign-in', () => {
  it('finishes when the browser on this computer reaches gws', async () => {
    const login = await start();
    await fetch(`http://127.0.0.1:${login.port}/?state=s&code=4%2F0abc&scope=x`);
    await expect(login.done).resolves.toEqual({ account: 'owner@example.com', scopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'] });
    expect(activeGoogleLogin()).toBeNull();
  }, 20_000);

  it('finishes from an address pasted from another device', async () => {
    const login = await start();
    await submitGoogleRedirect(login, `  http://localhost:${login.port}/?state=s&code=4%2F0abc&scope=x  `);
    await expect(login.done).resolves.toMatchObject({ account: 'owner@example.com' });
  }, 20_000);

  it('only accepts the address of the sign-in that is waiting, once', async () => {
    const login = await start();
    const port = login.port;
    await expect(submitGoogleRedirect(login, 'not a url')).rejects.toThrow(/isn't the address/);
    await expect(submitGoogleRedirect(login, `http://evil.example:${port}/?code=x`)).rejects.toThrow(/isn't the address of this sign-in/);
    await expect(submitGoogleRedirect(login, `https://localhost:${port}/?code=x`)).rejects.toThrow(/isn't the address of this sign-in/);
    await expect(submitGoogleRedirect(login, `http://localhost:${port + 1}/?code=x`)).rejects.toThrow(/isn't the address of this sign-in/);
    await expect(submitGoogleRedirect(login, `http://localhost:${port}/?state=s`)).rejects.toThrow(/no sign-in code/);
    await submitGoogleRedirect(login, `http://127.0.0.1:${port}/?code=x`);
    await expect(submitGoogleRedirect(login, `http://127.0.0.1:${port}/?code=x`)).rejects.toThrow(/already received|No Google sign-in is waiting/);
    await login.done;
  }, 20_000);

  it('stops the sign-in when Google says access was denied', async () => {
    const login = await start();
    await expect(submitGoogleRedirect(login, `http://localhost:${login.port}/?error=access_denied`)).rejects.toThrow(/didn't allow access \(access_denied\)/);
    await expect(login.done).rejects.toThrow(/cancelled/);
  }, 20_000);

  it('times out and stops gws', async () => {
    const login = await start({ timeoutMs: 1_500 });
    await expect(login.done).rejects.toThrow(/timed out/);
    await expect(fetch(`http://127.0.0.1:${login.port}/?code=x`, { signal: AbortSignal.timeout(3_000) })).rejects.toThrow();
  }, 20_000);

  it('cancels the waiting sign-in when a new one starts', async () => {
    const first = await start();
    const second = await start();
    await expect(first.done).rejects.toThrow(/cancelled/);
    expect(activeGoogleLogin()).toBe(second);
  }, 30_000);
});

describe('gws status, sign-out and version', () => {
  it('reads who is signed in', async () => {
    await expect(googleStatus(gwsPath)).resolves.toEqual({ signedIn: true, account: 'owner@example.com', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
  }, 20_000);

  it('signs out', async () => {
    await expect(googleLogout(gwsPath)).resolves.toEqual({ removed: 2 });
  }, 20_000);

  it('reads the version', async () => {
    await expect(gwsVersion(gwsPath)).resolves.toBe('0.22.5');
  }, 20_000);
});
