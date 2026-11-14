import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import readline from 'node:readline';
import { Command } from 'commander';
import chalk from 'chalk';
import { getMercuryHome } from '../utils/config.js';
import { openUrl } from '../utils/open-url.js';
import { SkillLoader } from '../skills/loader.js';
import { gwsFindings, type SecurityFinding } from '../security/check.js';
import { GWS_VERSION, findGws, installGws, mercuryGwsDir, type FoundGws } from './gws-binary.js';
import { GOOGLE_PERMISSIONS_URL, accessLabel, disconnectGoogle, googleOverview } from './overview.js';
import {
  DEFAULT_GOOGLE_SERVICES,
  googleLogout,
  googleStatus,
  gwsVersion,
  isReadOnly,
  startGoogleLogin,
  submitGoogleRedirect,
  type GoogleStatus,
} from './connect.js';

export const GOOGLE_SKILL_URL = 'https://mercuryagent.sh/skills/google-workspace/SKILL.md';
const GOOGLE_APP_DOCS = 'https://mercuryagent.sh/docs/integrations/google-workspace#before-you-start-your-own-google-app';

export interface GoogleCliDeps {
  findGws: typeof findGws;
  installGws: typeof installGws;
  gwsVersion: typeof gwsVersion;
  googleStatus: typeof googleStatus;
  googleLogout: typeof googleLogout;
  startGoogleLogin: typeof startGoogleLogin;
  submitGoogleRedirect: typeof submitGoogleRedirect;
  openUrl: (url: string) => Promise<boolean>;
  installSkill: () => Promise<'installed' | 'present'>;
  findings: () => SecurityFinding[];
  env: NodeJS.ProcessEnv;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  interactive: boolean;
}

export interface GoogleConnectOptions {
  write?: boolean;
  services?: string;
  client?: string;
  browser?: boolean;
  install?: boolean;
  yes?: boolean;
}

interface LineReader {
  next(): Promise<string | null>;
  close(): void;
}

export async function installGoogleSkill(): Promise<'installed' | 'present'> {
  const root = process.env.MERCURY_SKILLS_INSTALL_ROOT || join(getMercuryHome(), 'skills');
  const loader = new SkillLoader(root, { seedDefaults: false });
  if (loader.discover().some((skill) => skill.name === 'google-workspace')) return 'present';
  await loader.installFromUrl(GOOGLE_SKILL_URL);
  return 'installed';
}

export function defaultGoogleCliDeps(): GoogleCliDeps {
  return {
    findGws,
    installGws,
    gwsVersion,
    googleStatus,
    googleLogout,
    startGoogleLogin,
    submitGoogleRedirect,
    openUrl: (url) => openUrl(url),
    installSkill: installGoogleSkill,
    findings: () => gwsFindings(),
    env: process.env,
    input: process.stdin,
    output: process.stdout,
    interactive: Boolean(process.stdin.isTTY),
  };
}

function lineReader(input: NodeJS.ReadableStream): LineReader {
  const rl = readline.createInterface({ input, terminal: false });
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  rl.on('line', (line) => {
    if (waiter) {
      const resolveLine = waiter;
      waiter = null;
      resolveLine(line);
    } else {
      queue.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (waiter) {
      const resolveLine = waiter;
      waiter = null;
      resolveLine(null);
    }
  });
  return {
    next: () => {
      if (queue.length > 0) return Promise.resolve(queue.shift() ?? null);
      if (closed) return Promise.resolve(null);
      return new Promise((resolveLine) => { waiter = resolveLine; });
    },
    close: () => rl.close(),
  };
}

function parseServices(value: string | undefined): string[] {
  if (!value) return DEFAULT_GOOGLE_SERVICES;
  return value.split(',').map((service) => service.trim().toLowerCase()).filter(Boolean);
}

function serviceNames(services: string[]): string {
  const names: Record<string, string> = { gmail: 'Gmail', drive: 'Drive', docs: 'Docs', sheets: 'Sheets', calendar: 'Calendar', slides: 'Slides', tasks: 'Tasks', chat: 'Chat' };
  return services.map((service) => names[service] ?? service).join(', ');
}

export function readGoogleClientFile(path: string): { clientId: string; clientSecret: string } {
  const unquoted = path.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  const full = resolve(unquoted.replace(/^~(?=$|[\\/])/, homedir()));
  if (!existsSync(full)) throw new Error(`No file at ${full}.`);
  let data: Record<string, { client_id?: unknown; client_secret?: unknown } | undefined>;
  try {
    data = JSON.parse(readFileSync(full, 'utf8'));
  } catch {
    throw new Error(`${full} isn't a Google client JSON file.`);
  }
  if (!data.installed && data.web) {
    throw new Error('That is a Web application client. Create a client of type "Desktop app" instead; gws signs in through a local address that web clients refuse.');
  }
  const client = data.installed;
  if (typeof client?.client_id !== 'string' || typeof client.client_secret !== 'string') {
    throw new Error(`${full} has no client_id and client_secret. Download the JSON of a "Desktop app" client from Google Cloud.`);
  }
  return { clientId: client.client_id, clientSecret: client.client_secret };
}

export async function runGoogleConnect(opts: GoogleConnectOptions, deps: GoogleCliDeps): Promise<number> {
  const say = (line = '') => { deps.output.write(`${line}\n`); };
  const lines = lineReader(deps.input);
  const ask = async (question: string): Promise<string | null> => {
    deps.output.write(question);
    const line = await lines.next();
    return line === null ? null : line.trim();
  };
  try {
    const services = parseServices(opts.services);
    let gws: FoundGws | null = deps.findGws();
    let statusCheck: Promise<GoogleStatus | null> | null = null;
    if (gws && !opts.install) {
      if (!opts.client) statusCheck = deps.googleStatus(gws.path).catch(() => null);
      const version = await deps.gwsVersion(gws.path).catch(() => null);
      say(chalk.green(`✓ gws${version ? ` ${version}` : ''} found at ${gws.path}`));
      if (version && version !== GWS_VERSION) say(`  Mercury was checked with gws ${GWS_VERSION}. Newer commands may always ask before they run.`);
    } else {
      say(gws ? `Mercury will install its own gws ${GWS_VERSION} into ${mercuryGwsDir()}.` : `gws isn't installed. Mercury can install gws ${GWS_VERSION} (about 6 MB) into ${mercuryGwsDir()}.`);
      if (!opts.yes) {
        const answer = await ask('Install it now? [Y/n] ');
        if (answer === null) {
          say('');
          say('No answer came in, so nothing was installed. Run it again in a terminal, or add --yes.');
          return 1;
        }
        if (['n', 'no'].includes(answer.toLowerCase())) {
          say('Nothing was installed. To install gws yourself: npm install -g @googleworkspace/cli');
          return 1;
        }
      }
      const installed = await deps.installGws();
      gws = { path: installed.path, source: 'mercury' };
      say(chalk.green(`✓ Installed gws ${installed.version} into ${mercuryGwsDir()}`));
    }

    let client: { clientId: string; clientSecret: string } | undefined;
    if (opts.client) {
      client = readGoogleClientFile(opts.client);
    } else {
      const status = await (statusCheck ?? deps.googleStatus(gws.path).catch(() => null));
      const fromEnv = Boolean(deps.env.GOOGLE_WORKSPACE_CLI_CLIENT_ID && deps.env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET);
      if (!status?.clientConfigured && !fromEnv) {
        say('• Your Google app: none set up yet.');
        say(`  Create one (about 10 minutes, once): ${GOOGLE_APP_DOCS}`);
        const path = await ask('  Path to the client JSON you downloaded (or press Enter to type the ID and secret): ');
        if (path) {
          client = readGoogleClientFile(path);
        } else {
          const clientId = await ask('  Client ID: ');
          const clientSecret = await ask('  Client secret: ');
          if (!clientId || !clientSecret) {
            say(chalk.red('✗ A client ID and secret are needed to sign in.'));
            return 1;
          }
          client = { clientId, clientSecret };
        }
      }
    }

    const access = opts.write ? 'read and write' : 'read-only';
    const login = await deps.startGoogleLogin({ gwsPath: gws.path, services, write: opts.write, ...client });
    say(`• Sign in to Google (${access}: ${serviceNames(services)}):`);
    say(`  ${login.url}`);
    if (opts.browser !== false && await deps.openUrl(login.url).catch(() => false)) say('  Opened it in your browser.');
    if (deps.interactive) say("  Not on this computer? Sign in there, then paste the address the browser ends on here and press Enter.");

    let finished = false;
    const pastes = (async () => {
      while (!finished) {
        const line = await lines.next();
        if (line === null || finished) return;
        if (!line.trim()) continue;
        try {
          await deps.submitGoogleRedirect(login, line);
          say('  Got it. Finishing the sign-in…');
        } catch (err) {
          say(`  ${(err as Error).message}`);
        }
      }
    })();
    const result = await login.done.finally(() => {
      finished = true;
      lines.close();
    });
    await pastes;

    say(chalk.green(`✓ Connected as ${result.account ?? 'your Google account'} (${result.scopes.length > 0 && !isReadOnly(result.scopes) ? 'read and write' : access}).`));
    try {
      const skill = await deps.installSkill();
      say(chalk.green(skill === 'installed' ? "✓ Installed Mercury's google-workspace skill." : "✓ Mercury's google-workspace skill is already installed."));
    } catch {
      say(`• Couldn't download Mercury's skill. Install it with: mercury skills install --from ${GOOGLE_SKILL_URL}`);
    }
    say('');
    say('  Ask Mercury: "Summarize my unread email".');
    if (!opts.write) say('  To let Mercury write drafts and edit documents: mercury google connect --write');
    return 0;
  } catch (err) {
    say(chalk.red(`✗ ${(err as Error).message}`));
    return 1;
  } finally {
    lines.close();
  }
}

export async function runGoogleStatus(deps: GoogleCliDeps): Promise<number> {
  const say = (line = '') => { deps.output.write(`${line}\n`); };
  const overview = await googleOverview(deps);
  if (!overview.gws) {
    say("gws isn't installed. Connect Google with: mercury google connect");
    return 0;
  }
  say(`gws ${overview.version ?? '(version unknown)'} at ${overview.gws.path} (${overview.gws.source === 'mercury' ? 'installed by Mercury' : 'on your PATH'})`);
  if (overview.error) say(chalk.red(`✗ ${overview.error}`));
  else if (overview.status?.signedIn) say(chalk.green(`✓ Signed in as ${overview.status.account ?? 'a Google account'} (${accessLabel(overview.status.scopes)})`));
  else say('Not signed in. Connect Google with: mercury google connect');
  for (const finding of overview.findings) {
    const mark = finding.level === 'ok' ? chalk.green('✓') : finding.level === 'risk' ? chalk.red('✗') : chalk.yellow('!');
    say(`${mark} ${finding.title}${finding.fix ? ` · ${finding.fix}` : ''}`);
  }
  return 0;
}

export async function runGoogleDisconnect(deps: GoogleCliDeps): Promise<number> {
  const say = (line = '') => { deps.output.write(`${line}\n`); };
  const result = await disconnectGoogle(deps);
  if (result.kind === 'not-installed') {
    say("gws isn't installed, so there's nothing to disconnect.");
    return 0;
  }
  if (result.kind === 'failed') {
    say(chalk.red(`✗ ${result.error}`));
    return 1;
  }
  say(chalk.green(result.removed > 0 ? `✓ Signed out of gws on this computer (${result.removed} files removed).` : '✓ gws had no sign-in on this computer.'));
  say(`  To remove the app's access at Google too: ${GOOGLE_PERMISSIONS_URL}`);
  return 0;
}

export function registerGoogleCommand(program: Command, deps: () => GoogleCliDeps = defaultGoogleCliDeps): void {
  const google = program
    .command('google')
    .description("Connect Gmail, Drive and Docs through Google's gws tool");

  google
    .command('connect')
    .description('Install gws if needed, sign in to Google and install the skill')
    .option('--write', 'Allow drafts and edits, not only reading')
    .option('--services <list>', 'Google services to sign in to', DEFAULT_GOOGLE_SERVICES.join(','))
    .option('--client <path>', "Your Google app's client JSON (Desktop app)")
    .option('--no-browser', "Don't open the sign-in page in a browser")
    .option('--install', "Install Mercury's own gws even if one is on your PATH")
    .option('-y, --yes', 'Install gws without asking')
    .action(async (opts: GoogleConnectOptions) => {
      process.exitCode = await runGoogleConnect(opts, deps());
    });

  google
    .command('status')
    .description('Show gws, the Google sign-in and the security checks')
    .action(async () => {
      process.exitCode = await runGoogleStatus(deps());
    });

  google
    .command('disconnect')
    .description('Sign gws out on this computer')
    .action(async () => {
      process.exitCode = await runGoogleDisconnect(deps());
    });
}
