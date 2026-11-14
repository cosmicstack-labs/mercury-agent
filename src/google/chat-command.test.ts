import { describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '../types/channel.js';
import { handleGoogleCommand, mayUseGoogleCommand, type GoogleChatDeps } from './chat-command.js';
import type { GoogleLoginResult, PendingGoogleLogin } from './connect.js';

const READ_ONLY = ['openid', 'https://www.googleapis.com/auth/gmail.readonly'];

function message(content: string, extra: Partial<ChannelMessage> = {}): ChannelMessage {
  return { id: 'm1', channelId: 'telegram:42', channelType: 'telegram', senderId: '7', senderRole: 'admin', content, timestamp: Date.now(), ...extra } as ChannelMessage;
}

function harness(overrides: Partial<GoogleChatDeps> = {}) {
  const replies: string[] = [];
  const channel = { send: vi.fn(async (text: string) => { replies.push(text); }) };
  let resolveDone: (result: GoogleLoginResult) => void = () => {};
  let rejectDone: (error: Error) => void = () => {};
  const done = new Promise<GoogleLoginResult>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => {});
  const login: PendingGoogleLogin = { url: 'https://accounts.google.com/o/oauth2/auth?client_id=x', port: 51234, done, cancel: () => {} };
  const deps: GoogleChatDeps = {
    findGws: vi.fn(() => ({ path: '/usr/local/bin/gws', source: 'path' as const })),
    installGws: vi.fn(async () => ({ path: '/home/me/.mercury/gws-bin/gws', version: '0.22.5' })),
    googleStatus: vi.fn(async () => ({ signedIn: false, account: null, scopes: [], clientConfigured: true })),
    googleLogout: vi.fn(async () => ({ removed: 2 })),
    startGoogleLogin: vi.fn(async () => login),
    submitGoogleRedirect: vi.fn(async () => {}),
    activeGoogleLogin: vi.fn(() => login),
    installSkill: vi.fn(async () => 'installed' as const),
    findings: vi.fn(() => [
      { level: 'ok' as const, title: 'gws keeps your Google sign-in encrypted, and the service can find it' },
      { level: 'warn' as const, title: "Mercury's background service can't find gws", fix: 'Run mercury google connect --install' },
    ]),
    env: {},
    ...overrides,
  };
  const run = (content: string, extra: Partial<ChannelMessage> = {}) => handleGoogleCommand(content, message(content, extra), channel, deps);
  return { deps, replies, run, channel, finish: (r: GoogleLoginResult = { account: 'owner@example.com', scopes: READ_ONLY }) => resolveDone(r), fail: (e: Error) => rejectDone(e) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('who may use /google', () => {
  it('lets the owner and admins in, never members, scheduled prompts or internal turns', () => {
    expect(mayUseGoogleCommand(message('/google'))).toBe(true);
    expect(mayUseGoogleCommand(message('/google', { senderRole: undefined, channelType: 'cli' } as Partial<ChannelMessage>))).toBe(true);
    expect(mayUseGoogleCommand(message('/google', { senderRole: 'member' }))).toBe(false);
    expect(mayUseGoogleCommand(message('/google', { senderId: 'system' }))).toBe(false);
    expect(mayUseGoogleCommand(message('/google', { channelType: 'internal' } as Partial<ChannelMessage>))).toBe(false);
  });

  it('refuses a member without starting anything', async () => {
    const h = harness();
    await h.run('/google connect', { senderRole: 'member' });
    expect(h.replies).toEqual(['Only the owner or an admin can connect Google, from a chat they type in.']);
    expect(h.deps.startGoogleLogin).not.toHaveBeenCalled();
  });
});

describe('/google connect in a chat', () => {
  it('sends the sign-in link, then the result, and installs the skill', async () => {
    const h = harness();
    await h.run('/google connect');
    expect(h.deps.startGoogleLogin).toHaveBeenCalledWith({ gwsPath: '/usr/local/bin/gws', write: false });
    expect(h.replies[0]).toContain('allow access (read-only: Gmail, Drive, Docs)');
    expect(h.replies[0]).toContain('https://accounts.google.com/o/oauth2/auth?client_id=x');
    expect(h.replies[0]).toContain('/google connect <that address>');
    h.finish();
    await tick();
    expect(h.replies[1]).toContain("✓ Connected as owner@example.com (read-only). Installed Mercury's google-workspace skill.");
  });

  it('asks for write access with "write"', async () => {
    const h = harness();
    await h.run('/google connect write');
    expect(h.deps.startGoogleLogin).toHaveBeenCalledWith(expect.objectContaining({ write: true }));
    h.finish({ account: 'owner@example.com', scopes: ['openid', 'https://www.googleapis.com/auth/gmail.modify'] });
    await tick();
    expect(h.replies[1]).toContain('(read and write)');
  });

  it('installs gws first when it is missing', async () => {
    const h = harness({ findGws: vi.fn(() => null) });
    await h.run('/google connect');
    expect(h.replies[0]).toContain('Installing gws 0.22.5');
    expect(h.deps.startGoogleLogin).toHaveBeenCalledWith(expect.objectContaining({ gwsPath: '/home/me/.mercury/gws-bin/gws' }));
  });

  it('never takes the Google app in a chat: it points to the terminal', async () => {
    const h = harness({ googleStatus: vi.fn(async () => ({ signedIn: false, account: null, scopes: [], clientConfigured: false })) });
    await h.run('/google connect');
    expect(h.replies[0]).toContain('run `mercury google connect` once');
    expect(h.deps.startGoogleLogin).not.toHaveBeenCalled();
  });

  it('uses a Google app from the environment', async () => {
    const h = harness({
      googleStatus: vi.fn(async () => ({ signedIn: false, account: null, scopes: [], clientConfigured: false })),
      env: { GOOGLE_WORKSPACE_CLI_CLIENT_ID: 'id', GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: 'secret' },
    });
    await h.run('/google connect');
    expect(h.deps.startGoogleLogin).toHaveBeenCalled();
  });

  it('passes a pasted address to the waiting sign-in', async () => {
    const h = harness();
    await h.run('/google connect <http://localhost:51234/?state=s&code=4%2F0abc>');
    expect(h.deps.submitGoogleRedirect).toHaveBeenCalledWith(expect.anything(), 'http://localhost:51234/?state=s&code=4%2F0abc');
    expect(h.deps.startGoogleLogin).not.toHaveBeenCalled();
    expect(h.replies).toEqual(['Got it. Finishing the sign-in…']);
  });

  it('says so when no sign-in is waiting, or the address is wrong', async () => {
    const idle = harness({ activeGoogleLogin: vi.fn(() => null) });
    await idle.run('/google connect http://localhost:51234/?code=x');
    expect(idle.replies).toEqual(['No Google sign-in is waiting. Send `/google connect` to start one.']);

    const wrong = harness({ submitGoogleRedirect: vi.fn(async () => { throw new Error("That isn't the address of this sign-in."); }) });
    await wrong.run('/google connect http://localhost:1/?code=x');
    expect(wrong.replies).toEqual(["That isn't the address of this sign-in."]);
  });

  it('does not start a new sign-in for text that is not an address', async () => {
    const h = harness();
    await h.run('/google connect please');
    expect(h.replies[0]).toContain("That isn't a sign-in address");
    expect(h.deps.startGoogleLogin).not.toHaveBeenCalled();
  });

  it('reports a failed sign-in in the chat', async () => {
    const h = harness();
    await h.run('/google connect');
    h.fail(new Error('The Google sign-in timed out after 10 minutes.'));
    await tick();
    expect(h.replies[1]).toBe('✗ The Google sign-in timed out after 10 minutes.');
    expect(h.deps.installSkill).not.toHaveBeenCalled();
  });

  it('gives the install command when the skill download fails', async () => {
    const h = harness({ installSkill: vi.fn(async () => { throw new Error('offline'); }) });
    await h.run('/google connect');
    h.finish();
    await tick();
    expect(h.replies[1]).toContain('/skills install https://mercuryagent.sh/skills/google-workspace/SKILL.md');
  });
});

describe('/google status and disconnect in a chat', () => {
  it('shows the account and only the checks that need attention, with the commands', async () => {
    const h = harness({ googleStatus: vi.fn(async () => ({ signedIn: true, account: 'owner@example.com', scopes: READ_ONLY, clientConfigured: true })) });
    await h.run('/google');
    expect(h.replies[0]).toContain('✓ Signed in as owner@example.com (read-only)');
    expect(h.replies[0]).toContain("! Mercury's background service can't find gws · Run mercury google connect --install");
    expect(h.replies[0]).not.toContain('keeps your Google sign-in encrypted');
    expect(h.replies[0]).toContain('`/google connect write`');
  });

  it('says how to start when gws is missing', async () => {
    const h = harness({ findGws: vi.fn(() => null) });
    await h.run('/google status');
    expect(h.replies[0]).toContain("gws isn't installed. Send `/google connect`");
  });

  it('signs gws out and links to Google', async () => {
    const h = harness();
    await h.run('/google disconnect');
    expect(h.deps.googleLogout).toHaveBeenCalledWith('/usr/local/bin/gws');
    expect(h.replies[0]).toContain('✓ Signed gws out on the computer Mercury runs on.');
    expect(h.replies[0]).toContain('https://myaccount.google.com/permissions');
  });

  it('shows the commands for anything else', async () => {
    const h = harness();
    await h.run('/google help');
    expect(h.replies[0]).toContain('**Google Workspace**');
  });
});
