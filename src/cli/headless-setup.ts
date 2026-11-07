import type { MercuryConfig } from '../utils/config.js';

/**
 * `mercury setup --headless`: the minimum a runtime needs to come up with
 * its dashboard on, with no terminal and no questions. Mercury Desktop runs
 * this right after installing the binary; providers, channels and the rest
 * are then configured from the dashboard.
 *
 * Only fills what is empty: re-running it on a configured install changes
 * nothing except what the flags name explicitly.
 */
export interface HeadlessSetupOptions {
  owner?: string;
  agentName?: string;
  port?: number;
}

export interface HeadlessSetupResult {
  changed: string[];
}

export function applyHeadlessSetup(config: MercuryConfig, opts: HeadlessSetupOptions): HeadlessSetupResult {
  const changed: string[] = [];

  const owner = cleanName(opts.owner);
  if (owner && config.identity.owner !== owner) {
    config.identity.owner = owner;
    changed.push('identity.owner');
  } else if (!config.identity.owner) {
    config.identity.owner = 'Owner';
    changed.push('identity.owner');
  }

  const agentName = cleanName(opts.agentName);
  if (agentName && config.identity.name !== agentName) {
    config.identity.name = agentName;
    changed.push('identity.name');
  } else if (!config.identity.name) {
    config.identity.name = 'Mercury';
    changed.push('identity.name');
  }

  if (!config.web.enabled) {
    config.web.enabled = true;
    changed.push('web.enabled');
  }
  if (opts.port !== undefined) {
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      throw new Error(`Invalid port: ${opts.port}`);
    }
    if (config.web.port !== opts.port) {
      config.web.port = opts.port;
      changed.push('web.port');
    }
  }

  return { changed };
}

function cleanName(raw: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- strips control characters on purpose
  return (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
}
