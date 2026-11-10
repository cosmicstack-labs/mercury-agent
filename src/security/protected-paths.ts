import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getMercuryHome } from '../utils/config.js';

/**
 * Files no API caller reads or writes through Mercury's file endpoints.
 *
 *  - Mercury's own credentials (device tokens, the password hash, browser
 *    sessions, the attach token, remote-access settings, the security log,
 *    provider keys): writing one would let a caller plant a token that
 *    survives being revoked; reading one hands out secrets. Always refused.
 *  - The owner's keys and shell start-up files (~/.ssh, ~/.gnupg, cloud
 *    credentials, .zshrc…): refused to remote devices.
 */

const MERCURY_SECRETS = ['devices.json', 'web-config.json', 'web-sessions.json', 'attach-token', 'remote.json', 'security', 'mercury.yaml', '.env', 'keys', 'github-session.json', 'chatgpt-session.json'];
const AGENT_DENIED_HOME = ['.config/gws', 'Library/Application Support/gws', 'AppData/Roaming/gws', '.google_workspace_mcp'];
const HOME_SECRETS = ['.ssh', '.gnupg', '.aws', '.azure', '.config/gcloud', '.kube', '.docker/config.json', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.zshrc', '.bashrc', '.bash_profile', '.profile', '.zprofile', '.config/fish', 'Library/Keychains', ...AGENT_DENIED_HOME];

/** The real path, following symlinks; for a file that doesn't exist yet, its nearest existing parent's. */
export function realPathOf(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    if (existsSync(cur)) {
      try { return join(realpathSync(cur), ...tail.reverse()); } catch { return resolve(p); }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.push(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cur = parent;
  }
  return resolve(p);
}

const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Inside `root` after following symlinks (a link inside the workspace pointing at ~/.ssh is not inside it). */
export function realInside(path: string, root: string): boolean {
  return within(realPathOf(path), realPathOf(root));
}

/** Why this path is off limits, or null. `remote` adds the owner's keys and start-up files. */
export function protectedReason(path: string, remote: boolean): string | null {
  const real = realPathOf(path);
  const home = realPathOf(homedir());
  const mercury = realPathOf(getMercuryHome());
  for (const name of MERCURY_SECRETS) {
    if (within(real, join(mercury, name))) return "Mercury's credentials can't be read or changed this way.";
  }
  if (remote) {
    for (const name of HOME_SECRETS) {
      if (within(real, join(home, name))) return 'Keys and shell start-up files can only be opened on the computer itself.';
    }
  }
  return null;
}

/** Mercury's login credentials: never touched by its own tools (a prompt-injected agent can't read or plant a token). */
const AGENT_DENIED = ['devices.json', 'web-config.json', 'web-sessions.json', 'attach-token', 'remote.json', 'security'];

export function isMercuryCredentialPath(path: string): boolean {
  const real = realPathOf(path);
  const mercury = realPathOf(getMercuryHome());
  return AGENT_DENIED.some((name) => within(real, join(mercury, name)) || within(resolve(path), join(resolve(getMercuryHome()), name)));
}

/** A shell command that names one of those files. */
function mentionsMercuryHome(command: string): boolean {
  return command.includes('.mercury') || command.includes(getMercuryHome()) || /\$MERCURY_HOME|\$\{MERCURY_HOME\}/.test(command);
}

export function commandTouchesMercuryCredentials(command: string): boolean {
  return mentionsMercuryHome(command) && AGENT_DENIED.some((name) => command.includes(name));
}

const MERCURY_PROGRAMS = ['gws-bin'];

export function isMercuryProgramPath(path: string): boolean {
  const real = realPathOf(path);
  const mercury = realPathOf(getMercuryHome());
  return MERCURY_PROGRAMS.some((name) => within(real, join(mercury, name)) || within(resolve(path), join(resolve(getMercuryHome()), name)));
}

export function commandTouchesMercuryPrograms(command: string): boolean {
  return mentionsMercuryHome(command) && MERCURY_PROGRAMS.some((name) => command.includes(name));
}

export function isOtherAppCredentialPath(path: string): boolean {
  const real = realPathOf(path);
  const home = realPathOf(homedir());
  return AGENT_DENIED_HOME.some((name) => within(real, join(home, name)) || within(resolve(path), join(resolve(homedir()), name)));
}

const OTHER_APP_CREDENTIALS = /(?:\.config[\\/]+gws|Application\\? Support[\\/]+gws|AppData[\\/]+Roaming[\\/]+gws|APPDATA%?[\\/]+gws|\.google_workspace_mcp|\.encryption_key)(?![\w.-])/i;

export function commandTouchesOtherAppCredentials(command: string): boolean {
  return OTHER_APP_CREDENTIALS.test(command);
}
