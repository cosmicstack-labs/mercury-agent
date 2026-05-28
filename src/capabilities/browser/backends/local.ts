/**
 * Local backend — drives a locally-installed Chromium via Playwright.
 *
 * Probe-first design:
 *   - probeLocalBackend() is read-only and never installs. It looks for both
 *     playwright-core AND a working Chromium binary in any of the usual caches.
 *   - installLocalChromium() is invoked explicitly by `mercury browser install`.
 *     It dynamically loads `playwright` (full package — includes the CLI) and
 *     runs its installer programmatically. `playwright` is an optionalDependency
 *     so we never break installs that don't want the 170 MB Chromium tarball.
 *
 * Sessions use chromium.launchPersistentContext('~/.mercury/browser-profile/') so
 * cookies / logged-in state survive Mercury restarts — that's what makes Local
 * the right backend for sensitive (bank, email) flows.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { logger } from '../../../utils/logger.js';
import type { BackendName, BrowserBackend, BrowserSessionHandle, NormalizedPageState } from './base.js';
import { loadPlaywrightCore, buildPageState, clickByIndex, typeByIndex, extractText, pageScreenshot } from './playwright-ops.js';

const MERCURY_BROWSERS_DIR = join(homedir(), '.mercury', 'browsers');
const MERCURY_BROWSER_PROFILE = join(homedir(), '.mercury', 'browser-profile');

interface LocalSessionState {
  context: BrowserContext;
  page: Page;
  /** Set when running in `--attach` mode against a user-launched Chrome via CDP. */
  attachedBrowser?: Browser;
}

export interface LocalBackendOptions {
  /** Override Chromium executable path. Defaults to ~/.mercury/browsers/chromium-* discovery. */
  executablePath?: string;
  /** Attach to a user-launched Chrome instead of launching our own. */
  attachCdpUrl?: string;
  headless?: boolean;
}

export interface ProbeResult {
  ok: boolean;
  /** Human-readable reason when ok=false. */
  reason?: string;
  /** Hint for fixing — surfaced verbatim to the user. */
  remediation?: string;
  /** Discovered Chromium executable path (when ok=true). */
  browserPath?: string;
  /** How the backend would run: native launch or CDP attach. */
  method?: 'launch' | 'attach';
}

/**
 * Read-only probe — checks playwright-core is loadable AND a Chromium binary
 * exists in one of the standard cache locations. Never installs.
 */
export async function probeLocalBackend(): Promise<ProbeResult> {
  const pw = await loadPlaywrightCore();
  if (!pw) {
    return {
      ok: false,
      reason: 'playwright-core not installed',
      remediation: 'Run: mercury browser install',
    };
  }

  const found = findChromiumExecutable();
  if (found) {
    return { ok: true, method: 'launch', browserPath: found };
  }

  return {
    ok: false,
    reason: 'No local Chromium binary found',
    remediation: 'Run: mercury browser install',
  };
}

/**
 * Search standard Playwright cache locations and Mercury's own browsers dir
 * for a Chromium executable. Returns the first match or null.
 */
function findChromiumExecutable(): string | null {
  const caches = [
    MERCURY_BROWSERS_DIR,
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'AppData', 'Local', 'ms-playwright'),
  ];
  const isWin = platform() === 'win32';
  const isMac = platform() === 'darwin';
  const binNames = isWin ? ['chrome.exe'] : isMac ? ['Chromium', 'Google Chrome for Testing'] : ['chrome', 'chromium', 'headless_shell'];

  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    let entries: string[];
    try { entries = readdirSync(cache); } catch { continue; }
    for (const entry of entries) {
      if (!entry.startsWith('chromium')) continue;
      const dir = join(cache, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch { continue; }
      // Walk a few levels deep to find the actual binary.
      const candidate = walkForBinary(dir, binNames, 4);
      if (candidate) return candidate;
    }
  }
  return null;
}

function walkForBinary(root: string, binNames: string[], maxDepth: number): string | null {
  if (maxDepth < 0) return null;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return null; }
  for (const name of entries) {
    const full = join(root, name);
    if (binNames.includes(name)) {
      try {
        const st = statSync(full);
        if (st.isFile()) return full;
      } catch { /* ignore */ }
    }
    try {
      if (statSync(full).isDirectory()) {
        const nested = walkForBinary(full, binNames, maxDepth - 1);
        if (nested) return nested;
      }
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Install Playwright's Chromium into the standard cache so probeLocalBackend()
 * subsequently succeeds. Requires the `playwright` (full, not -core) package
 * to be present — it ships the install CLI. We dynamic-import it so users who
 * skipped the optionalDependency don't break.
 */
export async function installLocalChromium(): Promise<ProbeResult> {
  const pwCore = await loadPlaywrightCore();
  if (!pwCore) {
    return {
      ok: false,
      reason: 'playwright-core is missing from the Mercury installation',
      remediation: 'Reinstall Mercury: `npm i -g @cosmicstack/mercury-agent`',
    };
  }

  // Prefer the programmatic API exposed by `playwright`'s install entry. Fall back
  // to spawning `npx playwright install chromium` if the dynamic import fails.
  try {
    // `playwright/lib/server/registry/index.js` is internal; instead invoke via CLI.
    const { spawn } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npx', ['--yes', 'playwright', 'install', 'chromium'], {
        stdio: 'inherit',
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' /* use default cache */ },
      });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`playwright install exited ${code}`)));
    });
  } catch (err: any) {
    return {
      ok: false,
      reason: `Install command failed: ${err?.message ?? err}`,
      remediation: 'Try: `npx playwright install chromium` manually.',
    };
  }

  const probe = await probeLocalBackend();
  if (probe.ok) return probe;
  return {
    ok: false,
    reason: 'Install reported success but no Chromium binary was found afterwards',
    remediation: 'Try: `npx playwright install chromium` manually and check the output.',
  };
}

export class LocalBrowserBackend implements BrowserBackend {
  readonly name: BackendName = 'local';
  private sessions = new Map<string, LocalSessionState>();
  private idSeq = 0;

  constructor(private readonly opts: LocalBackendOptions = {}) {}

  async isAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.opts.attachCdpUrl) {
      const pw = await loadPlaywrightCore();
      if (!pw) return { ok: false, reason: 'playwright-core not installed. Run: mercury browser install' };
      return { ok: true };
    }
    const probe = await probeLocalBackend();
    if (probe.ok) return { ok: true };
    return { ok: false, reason: (probe.reason ?? 'unknown') + (probe.remediation ? ` — ${probe.remediation}` : '') };
  }

  async open(url: string, opts: { existingSessionId?: string } = {}): Promise<BrowserSessionHandle> {
    if (opts.existingSessionId) {
      const existing = this.sessions.get(opts.existingSessionId);
      if (!existing) throw new Error(`Unknown session ${opts.existingSessionId}`);
      await existing.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return { sessionId: opts.existingSessionId, backend: 'local', startedAt: Date.now() };
    }

    const pw = await loadPlaywrightCore();
    if (!pw) throw new Error('playwright-core is not installed. Run: mercury browser install');

    let context: BrowserContext;
    let attachedBrowser: Browser | undefined;

    if (this.opts.attachCdpUrl) {
      attachedBrowser = await pw.chromium.connectOverCDP(this.opts.attachCdpUrl);
      const contexts = attachedBrowser.contexts();
      context = contexts[0] ?? (await attachedBrowser.newContext());
    } else {
      const probe = await probeLocalBackend();
      const exePath = this.opts.executablePath ?? probe.browserPath;
      context = await pw.chromium.launchPersistentContext(MERCURY_BROWSER_PROFILE, {
        headless: this.opts.headless ?? true,
        executablePath: exePath,
        viewport: { width: 1280, height: 800 },
      });
    }

    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const sessionId = `local-${++this.idSeq}-${Date.now().toString(36)}`;
    this.sessions.set(sessionId, { context, page, attachedBrowser });
    logger.info({ sessionId, attached: !!attachedBrowser }, 'Local browser session created');
    return { sessionId, backend: 'local', startedAt: Date.now() };
  }

  async state(sessionId: string, opts: { maxElements?: number } = {}): Promise<NormalizedPageState> {
    return buildPageState(this.require(sessionId).page, opts.maxElements);
  }

  async click(sessionId: string, index: number): Promise<void> {
    await clickByIndex(this.require(sessionId).page, index);
  }

  async type(sessionId: string, index: number, text: string, opts: { submit?: boolean } = {}): Promise<void> {
    await typeByIndex(this.require(sessionId).page, index, text, opts.submit);
  }

  async extract(sessionId: string, selector?: string): Promise<string> {
    return extractText(this.require(sessionId).page, selector);
  }

  async screenshot(sessionId: string): Promise<{ data: Buffer; mime: 'image/png' }> {
    const data = await pageScreenshot(this.require(sessionId).page);
    return { data, mime: 'image/png' };
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    try {
      if (s.attachedBrowser) {
        await s.attachedBrowser.close();
      } else {
        await s.context.close();
      }
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to close local browser session');
    }
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.close(id).catch(() => {})));
  }

  getSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  private require(sessionId: string): LocalSessionState {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown browser session ${sessionId}. Call browser_open first.`);
    return s;
  }
}

export { MERCURY_BROWSERS_DIR, MERCURY_BROWSER_PROFILE };
