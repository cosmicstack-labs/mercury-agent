import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Command } from 'commander';
import {
  readGoogleClientFile,
  registerGoogleCommand,
  runGoogleConnect,
  runGoogleDisconnect,
  runGoogleStatus,
  type GoogleCliDeps,
} from './cli.js';
import type { GoogleLoginResult, PendingGoogleLogin } from './connect.js';

const READ_ONLY = ['openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.readonly'];

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'mercury-google-cli-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

interface Harness {
  deps: GoogleCliDeps;
  input: PassThrough;
  text: () => string;
  finish: (result?: GoogleLoginResult) => void;
  fail: (error: Error) => void;
}

function harness(overrides: Partial<GoogleCliDeps> = {}): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => { written += chunk.toString(); });
  let resolveDone: (result: GoogleLoginResult) => void = () => {};
  let rejectDone: (error: Error) => void = () => {};
  const done = new Promise<GoogleLoginResult>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => {});
  const login: PendingGoogleLogin = { url: 'https://accounts.google.com/o/oauth2/auth?client_id=x', port: 51234, done, cancel: () => rejectDone(new Error('cancelled')) };
  const deps: GoogleCliDeps = {
    findGws: vi.fn(() => ({ path: '/usr/local/bin/gws', source: 'path' as const })),
    installGws: vi.fn(async () => ({ path: '/home/me/.mercury/gws-bin/gws', version: '0.22.5' })),
    gwsVersion: vi.fn(async () => '0.22.5'),
    googleStatus: vi.fn(async () => ({ signedIn: false, account: null, scopes: [], clientConfigured: true })),
    googleLogout: vi.fn(async () => ({ removed: 2 })),
    startGoogleLogin: vi.fn(async () => login),
    submitGoogleRedirect: vi.fn(async () => { resolveDone({ account: 'owner@example.com', scopes: READ_ONLY }); }),
    openUrl: vi.fn(async () => true),
    installSkill: vi.fn(async () => 'installed' as const),
    findings: vi.fn(() => [{ level: 'ok' as const, title: 'gws keeps your Google sign-in encrypted, and the service can find it' }]),
    env: {},
    input,
    output,
    interactive: true,
    ...overrides,
  };
  return {
    deps,
    input,
    text: () => written,
    finish: (result = { account: 'owner@example.com', scopes: READ_ONLY }) => resolveDone(result),
    fail: (error) => rejectDone(error),
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('mercury google connect', () => {
  it('signs in with the gws it finds, opens the browser and installs the skill', async () => {
    const h = harness();
    const run = runGoogleConnect({}, h.deps);
    await settle();
    h.finish();
    await expect(run).resolves.toBe(0);
    expect(h.deps.startGoogleLogin).toHaveBeenCalledWith({ gwsPath: '/usr/local/bin/gws', services: ['gmail', 'drive', 'docs'], write: undefined });
    expect(h.deps.openUrl).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?client_id=x');
    expect(h.deps.installGws).not.toHaveBeenCalled();
    expect(h.text()).toContain('gws 0.22.5 found at /usr/local/bin/gws');
    expect(h.text()).toContain('Sign in to Google (read-only: Gmail, Drive, Docs)');
    expect(h.text()).toContain('Connected as owner@example.com (read-only)');
    expect(h.text()).toContain("Installed Mercury's google-workspace skill");
    expect(h.text()).toContain('mercury google connect --write');
  });

  it('asks for write access and other services, without a browser', async () => {
    const h = harness();
    const run = runGoogleConnect({ write: true, services: 'gmail, Calendar', browser: false }, h.deps);
    await settle();
    h.finish({ account: 'owner@example.com', scopes: ['openid', 'https://www.googleapis.com/auth/gmail.modify'] });
    await expect(run).resolves.toBe(0);
    expect(h.deps.startGoogleLogin).toHaveBeenCalledWith(expect.objectContaining({ services: ['gmail', 'calendar'], write: true }));
    expect(h.deps.openUrl).not.toHaveBeenCalled();
    expect(h.text()).toContain('read and write: Gmail, Calendar');
    expect(h.text()).toContain('Connected as owner@example.com (read and write)');
  });

  it('notes a gws version other than the one Mercury was checked with', async () => {
    const h = harness({ gwsVersion: vi.fn(async () => '0.30.0') });
    const run = runGoogleConnect({}, h.deps);
    await settle();
    h.finish();
    await run;
    expect(h.text()).toContain('Mercury was checked with gws 0.22.5');
  });

  it('installs gws when it is missing and the owner says yes', async () => {
    const h = harness({ findGws: vi.fn(() => null) });
    const run = runGoogleConnect({}, h.deps);
    h.input.write('y\n');
    await settle();
    h.finish();
    await expect(run).resolves.toBe(0);
    expect(h.text()).toContain("gws isn't installed");
    expect(h.deps.installGws).toHaveBeenCalled();
    expect(h.deps.startGoogleLogin).toHaveBeenCalledWith(expect.objectContaining({ gwsPath: '/home/me/.mercury/gws-bin/gws' }));
  });

  it('installs without asking with --yes, and its own copy with --install', async () => {
    const h = harness();
    const run = runGoogleConnect({ install: true, yes: true }, h.deps);
    await settle();
    h.finish();
    await expect(run).resolves.toBe(0);
    expect(h.text()).not.toContain('Install it now?');
    expect(h.deps.installGws).toHaveBeenCalled();
  });

  it('installs nothing when the owner says no', async () => {
    const h = harness({ findGws: vi.fn(() => null) });
    const run = runGoogleConnect({}, h.deps);
    h.input.write('n\n');
    await expect(run).resolves.toBe(1);
    expect(h.deps.installGws).not.toHaveBeenCalled();
    expect(h.deps.startGoogleLogin).not.toHaveBeenCalled();
    expect(h.text()).toContain('npm install -g @googleworkspace/cli');
  });

  it('installs nothing when no answer comes in', async () => {
    const h = harness({ findGws: vi.fn(() => null) });
    const run = runGoogleConnect({}, h.deps);
    h.input.end();
    await expect(run).resolves.toBe(1);
    expect(h.deps.installGws).not.toHaveBeenCalled();
    expect(h.text()).toContain('No answer came in, so nothing was installed');
  });

  it('reads the Google app from a client JSON when none is set up', async () => {
    const file = join(work, 'client_secret_123.json');
    writeFileSync(file, JSON.stringify({ installed: { client_id: 'id-1.apps.googleusercontent.com', client_secret: 'secret-1' } }));
    const h = harness({ googleStatus: vi.fn(async () => ({ signedIn: false, account: null, scopes: [], clientConfigured: false })) });
    const run = runGoogleConnect({}, h.deps);
    h.input.write(`${file}\n`);
    await settle();
    h.finish();
    await expect(run).resolves.toBe(0);
    expect(h.text()).toContain('Your Google app: none set up yet');
    expect(h.deps.startGoogleLogin).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'id-1.apps.googleusercontent.com', clientSecret: 'secret-1' }));
  });

  it('takes a typed client ID and secret', async () => {
    const h = harness({ googleStatus: vi.fn(async () => ({ signedIn: false, account: null, scopes: [], clientConfigured: false })) });
    const run = runGoogleConnect({}, h.deps);
    h.input.write('\nid-2\nsecret-2\n');
    await settle();
    h.finish();
    await expect(run).resolves.toBe(0);
    expect(h.deps.startGoogleLogin).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'id-2', clientSecret: 'secret-2' }));
  });

  it('does not ask for the Google app when gws already has one or it is in the environment', async () => {
    const h = harness({
      googleStatus: vi.fn(async () => ({ signedIn: false, account: null, scopes: [], clientConfigured: false })),
      env: { GOOGLE_WORKSPACE_CLI_CLIENT_ID: 'id', GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: 'secret' },
    });
    const run = runGoogleConnect({}, h.deps);
    await settle();
    h.finish();
    await expect(run).resolves.toBe(0);
    expect(h.text()).not.toContain('none set up yet');
  });

  it('finishes from an address pasted while it waits, and reports a wrong one', async () => {
    const submit = vi.fn(async (_login: PendingGoogleLogin, address: string) => {
      if (!address.includes('localhost')) throw new Error("That isn't the address of this sign-in.");
      h.finish();
    });
    const h = harness({ submitGoogleRedirect: submit });
    const run = runGoogleConnect({}, h.deps);
    await settle();
    expect(h.text()).toContain('Not on this computer?');
    h.input.write('https://example.com/nope\n');
    await settle();
    h.input.write('http://localhost:51234/?code=4%2F0abc\n');
    await expect(run).resolves.toBe(0);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(h.text()).toContain("That isn't the address of this sign-in.");
    expect(h.text()).toContain('Got it. Finishing the sign-in');
  });

  it('reports a failed sign-in', async () => {
    const h = harness();
    const run = runGoogleConnect({}, h.deps);
    await settle();
    h.fail(new Error('The Google sign-in timed out after 10 minutes.'));
    await expect(run).resolves.toBe(1);
    expect(h.text()).toContain('✗ The Google sign-in timed out after 10 minutes.');
    expect(h.deps.installSkill).not.toHaveBeenCalled();
  });

  it('shows the install command when the skill download fails', async () => {
    const h = harness({ installSkill: vi.fn(async () => { throw new Error('offline'); }) });
    const run = runGoogleConnect({}, h.deps);
    await settle();
    h.finish();
    await expect(run).resolves.toBe(0);
    expect(h.text()).toContain('mercury skills install --from https://mercuryagent.sh/skills/google-workspace/SKILL.md');
  });
});

describe('reading the Google client JSON', () => {
  it('reads a Desktop app client', () => {
    const file = join(work, 'client.json');
    writeFileSync(file, JSON.stringify({ installed: { client_id: 'a', client_secret: 'b' } }));
    expect(readGoogleClientFile(` "${file}" `)).toEqual({ clientId: 'a', clientSecret: 'b' });
  });

  it('expands ~ in a quoted path', () => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = work;
    process.env.USERPROFILE = work;
    try {
      writeFileSync(join(work, 'client.json'), JSON.stringify({ installed: { client_id: 'a', client_secret: 'b' } }));
      expect(readGoogleClientFile('"~/client.json"')).toEqual({ clientId: 'a', clientSecret: 'b' });
      expect(readGoogleClientFile("'~/client.json'")).toEqual({ clientId: 'a', clientSecret: 'b' });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('refuses a Web application client, a missing file and other JSON', () => {
    const web = join(work, 'web.json');
    writeFileSync(web, JSON.stringify({ web: { client_id: 'a', client_secret: 'b' } }));
    expect(() => readGoogleClientFile(web)).toThrow(/Desktop app/);
    expect(() => readGoogleClientFile(join(work, 'missing.json'))).toThrow(/No file at/);
    const other = join(work, 'other.json');
    writeFileSync(other, '{"hello":1}');
    expect(() => readGoogleClientFile(other)).toThrow(/no client_id and client_secret/);
  });
});

describe('mercury google status and disconnect', () => {
  it('shows gws, the account and the security checks', async () => {
    const h = harness({ googleStatus: vi.fn(async () => ({ signedIn: true, account: 'owner@example.com', scopes: READ_ONLY, clientConfigured: true })) });
    await expect(runGoogleStatus(h.deps)).resolves.toBe(0);
    expect(h.text()).toContain('gws 0.22.5 at /usr/local/bin/gws (on your PATH)');
    expect(h.text()).toContain('Signed in as owner@example.com (read-only)');
    expect(h.text()).toContain('gws keeps your Google sign-in encrypted');
  });

  it('says how to connect when gws is missing or signed out', async () => {
    const missing = harness({ findGws: vi.fn(() => null) });
    await runGoogleStatus(missing.deps);
    expect(missing.text()).toContain('mercury google connect');
    const signedOut = harness();
    await runGoogleStatus(signedOut.deps);
    expect(signedOut.text()).toContain('Not signed in');
  });

  it('signs out and points to Google to remove access', async () => {
    const h = harness();
    await expect(runGoogleDisconnect(h.deps)).resolves.toBe(0);
    expect(h.deps.googleLogout).toHaveBeenCalledWith('/usr/local/bin/gws');
    expect(h.text()).toContain('Signed out of gws on this computer (2 files removed)');
    expect(h.text()).toContain('https://myaccount.google.com/permissions');
  });
});

describe('the mercury google command', () => {
  it('passes its options to connect', async () => {
    const h = harness();
    const program = new Command();
    program.exitOverride();
    registerGoogleCommand(program, () => h.deps);
    const parsed = program.parseAsync(['google', 'connect', '--write', '--services', 'gmail', '--no-browser'], { from: 'user' });
    await settle();
    h.finish();
    await parsed;
    expect(h.deps.startGoogleLogin).toHaveBeenCalledWith(expect.objectContaining({ services: ['gmail'], write: true }));
    expect(h.deps.openUrl).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    process.exitCode = undefined;
  });
});
