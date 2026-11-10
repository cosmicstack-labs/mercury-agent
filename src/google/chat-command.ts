import type { ChannelMessage } from '../types/channel.js';
import { gwsFindings, type SecurityFinding } from '../security/check.js';
import { GWS_VERSION, findGws, installGws } from './gws-binary.js';
import {
  activeGoogleLogin,
  googleLogout,
  googleStatus,
  isReadOnly,
  startGoogleLogin,
  submitGoogleRedirect,
} from './connect.js';
import { GOOGLE_SKILL_URL, installGoogleSkill } from './cli.js';
import { GOOGLE_PERMISSIONS_URL, accessLabel, disconnectGoogle, googleOverview } from './overview.js';

export interface GoogleChatChannel {
  send(content: string, targetId?: string): Promise<void>;
}

export interface GoogleChatDeps {
  findGws: typeof findGws;
  installGws: typeof installGws;
  googleStatus: typeof googleStatus;
  googleLogout: typeof googleLogout;
  startGoogleLogin: typeof startGoogleLogin;
  submitGoogleRedirect: typeof submitGoogleRedirect;
  activeGoogleLogin: typeof activeGoogleLogin;
  installSkill: () => Promise<'installed' | 'present'>;
  findings: () => SecurityFinding[];
  env: NodeJS.ProcessEnv;
}

export function defaultGoogleChatDeps(): GoogleChatDeps {
  return {
    findGws,
    installGws,
    googleStatus,
    googleLogout,
    startGoogleLogin,
    submitGoogleRedirect,
    activeGoogleLogin,
    installSkill: installGoogleSkill,
    findings: () => gwsFindings(),
    env: process.env,
  };
}

const USAGE = [
  '**Google Workspace**',
  '`/google connect` connects Gmail, Drive and Docs (read-only)',
  '`/google connect write` also lets Mercury write drafts and edit documents',
  '`/google status` shows the connection',
  '`/google disconnect` signs gws out on the computer Mercury runs on',
].join('\n');

export function mayUseGoogleCommand(msg: ChannelMessage): boolean {
  return msg.senderRole !== 'member' && msg.senderId !== 'system' && msg.channelType !== 'internal';
}

export async function handleGoogleCommand(trimmed: string, msg: ChannelMessage, channel: GoogleChatChannel, deps: GoogleChatDeps = defaultGoogleChatDeps()): Promise<void> {
  const reply = (text: string) => channel.send(text, msg.channelId);
  if (!mayUseGoogleCommand(msg)) {
    await reply('Only the owner or an admin can connect Google, from a chat they type in.');
    return;
  }
  const [sub = '', ...rest] = trimmed.replace(/^\/google\b/i, '').trim().split(/\s+/).filter(Boolean);

  switch (sub.toLowerCase()) {
    case 'connect': {
      const words = rest.map((word) => word.replace(/^[<"'(]+|[>"')]+$/g, ''));
      const address = words.find((word) => /^https?:\/\//i.test(word));
      if (address) {
        const login = deps.activeGoogleLogin();
        if (!login) {
          await reply('No Google sign-in is waiting. Send `/google connect` to start one.');
          return;
        }
        try {
          await deps.submitGoogleRedirect(login, address);
          await reply('Got it. Finishing the sign-in…');
        } catch (err) {
          await reply((err as Error).message);
        }
        return;
      }
      if (words.some((word) => word.toLowerCase() !== 'write')) {
        await reply("That isn't a sign-in address. Send `/google connect` to start, then `/google connect <the address your browser ends on>`.");
        return;
      }
      await connect(words.length > 0, reply, deps);
      return;
    }
    case 'status':
    case '':
      await status(reply, deps, sub === '');
      return;
    case 'disconnect':
      await disconnect(reply, deps);
      return;
    default:
      await reply(USAGE);
  }
}

async function connect(write: boolean, reply: (text: string) => Promise<void>, deps: GoogleChatDeps): Promise<void> {
  try {
    let gws = deps.findGws();
    if (!gws) {
      await reply(`Installing gws ${GWS_VERSION} (about 6 MB), Google's tool for Workspace…`);
      const installed = await deps.installGws();
      gws = { path: installed.path, source: 'mercury' };
    }
    const configured = await deps.googleStatus(gws.path).then((s) => s.clientConfigured).catch(() => false);
    const fromEnv = Boolean(deps.env.GOOGLE_WORKSPACE_CLI_CLIENT_ID && deps.env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET);
    if (!configured && !fromEnv) {
      await reply([
        "Your Google app isn't set up yet, and its secret shouldn't travel through a chat.",
        'On the computer Mercury runs on, run `mercury google connect` once: it asks for the client file you downloaded from Google Cloud.',
        'Or save that file as `~/.config/gws/client_secret.json` there.',
        'After that, `/google connect` works from here.',
      ].join('\n'));
      return;
    }
    const access = write ? 'read and write' : 'read-only';
    const login = await deps.startGoogleLogin({ gwsPath: gws.path, write });
    await reply([
      `Open this link and allow access (${access}: Gmail, Drive, Docs):`,
      login.url,
      '',
      "On another device the last page won't load. Copy its address from the address bar and send `/google connect <that address>`.",
    ].join('\n'));
    login.done.then(async (result) => {
      const granted = result.scopes.length > 0 && !isReadOnly(result.scopes) ? 'read and write' : access;
      let skill: string;
      try {
        skill = (await deps.installSkill()) === 'installed' ? "Installed Mercury's google-workspace skill." : "Mercury's google-workspace skill is already installed.";
      } catch {
        skill = `Couldn't download Mercury's skill. Install it with \`/skills install ${GOOGLE_SKILL_URL}\`.`;
      }
      await reply(`✓ Connected as ${result.account ?? 'your Google account'} (${granted}). ${skill}\nTry: "Summarize my unread email".`);
    }, async (err: Error) => {
      await reply(`✗ ${err.message}`);
    }).catch(() => {});
  } catch (err) {
    await reply(`✗ ${(err as Error).message}`);
  }
}

async function status(reply: (text: string) => Promise<void>, deps: GoogleChatDeps, withUsage: boolean): Promise<void> {
  const overview = await googleOverview(deps);
  const lines: string[] = [];
  if (!overview.gws) {
    lines.push("gws isn't installed. Send `/google connect` to set it up.");
  } else {
    if (overview.error) lines.push(`✗ ${overview.error}`);
    else if (overview.status?.signedIn) lines.push(`✓ Signed in as ${overview.status.account ?? 'a Google account'} (${accessLabel(overview.status.scopes)})`);
    else lines.push('Not signed in. Send `/google connect`.');
    for (const finding of overview.findings) {
      if (finding.level !== 'ok') lines.push(`${finding.level === 'risk' ? '✗' : '!'} ${finding.title}${finding.fix ? ` · ${finding.fix}` : ''}`);
    }
  }
  if (withUsage) lines.push('', USAGE);
  await reply(lines.join('\n'));
}

async function disconnect(reply: (text: string) => Promise<void>, deps: GoogleChatDeps): Promise<void> {
  const result = await disconnectGoogle(deps);
  if (result.kind === 'not-installed') await reply("gws isn't installed, so there's nothing to disconnect.");
  else if (result.kind === 'failed') await reply(`✗ ${result.error}`);
  else await reply(`${result.removed > 0 ? '✓ Signed gws out on the computer Mercury runs on.' : '✓ gws had no sign-in there.'}\nTo remove the app's access at Google too: ${GOOGLE_PERMISSIONS_URL}`);
}
