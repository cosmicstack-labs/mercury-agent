/**
 * Cloud backend — drives a remote Browser-Use Cloud Chromium over CDP.
 *
 * Flow:
 *   1. POST /api/v3/browsers          → get { id, cdp_url }
 *   2. chromium.connectOverCDP(cdp_url) via playwright-core
 *   3. Drive the page via shared playwright-ops helpers
 *   4. PATCH /api/v3/browsers/{id} on close (status: stopped) → unused time refunded
 *
 * Auth: X-Browser-Use-API-Key header. Key sourced from $BROWSER_USE_API_KEY or
 *       ~/.mercury/mercury.yaml → browserUse.apiKey (see auth/browser-use-auth.ts).
 *
 * Pricing reminder (from OpenAPI v3 spec):
 *   - PAYG:       $0.06 / hour, charged upfront, refunded proportionally on stop
 *   - Business:   $0.03 / hour (50% discount)
 *   - Min 1 min, max 4 hour timeout
 *
 * Sessions are tracked in src/capabilities/browser/session.ts and closed on Mercury
 * shutdown via the lifecycle hook so we don't leak paid sessions.
 */

import type { Browser, BrowserContext, Page } from 'playwright-core';
import { logger } from '../../../utils/logger.js';
import type { BackendName, BrowserBackend, BrowserSessionHandle, NormalizedPageState } from './base.js';
import { loadPlaywrightCore, buildPageState, clickByIndex, typeByIndex, extractText, pageScreenshot } from './playwright-ops.js';

const API_BASE = 'https://api.browser-use.com/api/v3';

interface CloudSessionState {
  /** Remote browser session id from POST /browsers — used for PATCH on stop. */
  remoteId: string;
  cdpUrl: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Wall-clock ms when the session was created. Used to compute billed duration on close. */
  startedAtMs: number;
}

/**
 * Hook that the session manager wires in. Decouples Cloud backend from the
 * config + tracker singleton so we don't pull MercuryConfig into this file.
 */
export interface CloudUsageHook {
  /** Called before opening a new Cloud session; deny if budgets exhausted. */
  canStart(): { ok: true } | { ok: false; reason: string };
  /** Called when a Cloud session closes (or runAgentTask finishes) with the billed duration. */
  recordSession(opts: { sessionId: string; durationSec: number; kind: 'agent' | 'browser' }): void;
}

export interface CloudBackendOptions {
  apiKey: string;
  /** Optional persistent profile id from POST /profiles. */
  profileId?: string;
  /** Two-letter country code for the residential proxy. */
  proxyCountryCode?: string;
  /** Session timeout in minutes. Default 15, max 240. */
  timeoutMinutes?: number;
  /** Cost-tracking hook. When set, gates new sessions and records cost on close. */
  usageHook?: CloudUsageHook;
}

export class CloudBrowserBackend implements BrowserBackend {
  readonly name: BackendName = 'cloud';
  private sessions = new Map<string, CloudSessionState>();

  constructor(private readonly opts: CloudBackendOptions) {}

  async isAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.opts.apiKey) return { ok: false, reason: 'BROWSER_USE_API_KEY not configured' };
    const pw = await loadPlaywrightCore();
    if (!pw) return { ok: false, reason: 'playwright-core not installed. Run: mercury browser install' };
    if (this.opts.usageHook) {
      const budget = this.opts.usageHook.canStart();
      if (!budget.ok) return { ok: false, reason: budget.reason };
    }
    return { ok: true };
  }

  async open(url: string, opts: { existingSessionId?: string } = {}): Promise<BrowserSessionHandle> {
    if (opts.existingSessionId) {
      const existing = this.sessions.get(opts.existingSessionId);
      if (!existing) throw new Error(`Unknown session ${opts.existingSessionId}`);
      await existing.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return { sessionId: opts.existingSessionId, backend: 'cloud', startedAt: existing.startedAtMs };
    }

    // Budget gate — re-checked at open() so a session denied between probe and
    // open (rare race) still bails cleanly.
    if (this.opts.usageHook) {
      const budget = this.opts.usageHook.canStart();
      if (!budget.ok) throw new Error(budget.reason);
    }

    const pw = await loadPlaywrightCore();
    if (!pw) throw new Error('playwright-core is not installed. Run: mercury browser install');

    // Provision remote browser
    const createResp = await fetch(`${API_BASE}/browsers`, {
      method: 'POST',
      headers: {
        'X-Browser-Use-API-Key': this.opts.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        profile_id: this.opts.profileId,
        proxy_country_code: this.opts.proxyCountryCode,
        timeout: this.opts.timeoutMinutes ?? 15,
      }),
    });

    if (!createResp.ok) {
      const body = await createResp.text().catch(() => '');
      throw new Error(`Browser-Use Cloud /browsers POST failed: HTTP ${createResp.status} ${createResp.statusText} ${body.slice(0, 300)}`);
    }

    const created = (await createResp.json()) as { id: string; cdp_url?: string; cdpUrl?: string };
    const remoteId = created.id;
    const cdpUrl = created.cdp_url ?? created.cdpUrl;
    if (!cdpUrl) throw new Error('Browser-Use Cloud returned no cdp_url');

    logger.info({ remoteId }, 'Cloud browser session created');

    const browser = await pw.chromium.connectOverCDP(cdpUrl);
    const contexts = browser.contexts();
    const context = contexts[0] ?? (await browser.newContext());
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const startedAtMs = Date.now();
    const sessionId = `cloud-${remoteId}`;
    this.sessions.set(sessionId, { remoteId, cdpUrl, browser, context, page, startedAtMs });

    return { sessionId, backend: 'cloud', startedAt: startedAtMs };
  }

  async state(sessionId: string, opts: { maxElements?: number } = {}): Promise<NormalizedPageState> {
    const s = this.require(sessionId);
    return buildPageState(s.page, opts.maxElements);
  }

  async click(sessionId: string, index: number): Promise<void> {
    const s = this.require(sessionId);
    await clickByIndex(s.page, index);
  }

  async type(sessionId: string, index: number, text: string, opts: { submit?: boolean } = {}): Promise<void> {
    const s = this.require(sessionId);
    await typeByIndex(s.page, index, text, opts.submit);
  }

  async extract(sessionId: string, selector?: string): Promise<string> {
    const s = this.require(sessionId);
    return extractText(s.page, selector);
  }

  async screenshot(sessionId: string): Promise<{ data: Buffer; mime: 'image/png' }> {
    const s = this.require(sessionId);
    const data = await pageScreenshot(s.page);
    return { data, mime: 'image/png' };
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);

    try {
      await s.browser.close();
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to close Playwright CDP connection');
    }

    // Stop the remote browser so we stop being billed.
    try {
      const resp = await fetch(`${API_BASE}/browsers/${s.remoteId}`, {
        method: 'PATCH',
        headers: {
          'X-Browser-Use-API-Key': this.opts.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'stopped' }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        logger.warn({ sessionId, status: resp.status, body: body.slice(0, 200) }, 'Failed to stop remote browser session — may continue billing until timeout');
      }
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to PATCH /browsers/{id} on close');
    }

    // Record billable duration for budget tracking. Note: this is wall-clock
    // duration on our side; the actual Cloud billed time may differ slightly
    // due to provisioning + tear-down. Good enough for budget enforcement.
    if (this.opts.usageHook) {
      const durationSec = Math.max(0, (Date.now() - s.startedAtMs) / 1000);
      this.opts.usageHook.recordSession({ sessionId, durationSec, kind: 'browser' });
    }
  }

  /**
   * Fire-and-poll Agent API helper used by the high-level `browser_task` tool.
   * Submits a natural-language task, polls every 2s up to maxWaitMs, returns the
   * final `output` string. Independent of the CDP session lifecycle above.
   */
  async runAgentTask(task: string, opts: { maxWaitMs?: number } = {}): Promise<string> {
    if (this.opts.usageHook) {
      const budget = this.opts.usageHook.canStart();
      if (!budget.ok) throw new Error(budget.reason);
    }
    const taskStartedAt = Date.now();
    const maxWait = opts.maxWaitMs ?? 4 * 60 * 1000; // 4 minutes default
    const createResp = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: {
        'X-Browser-Use-API-Key': this.opts.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task }),
    });

    if (!createResp.ok) {
      const body = await createResp.text().catch(() => '');
      throw new Error(`Browser-Use Cloud /sessions POST failed: HTTP ${createResp.status} ${createResp.statusText} ${body.slice(0, 300)}`);
    }

    const created = (await createResp.json()) as { id: string; status?: string; output?: string };
    const sid = created.id;
    const recordIfTracked = (output: string): string => {
      if (this.opts.usageHook) {
        const durationSec = Math.max(0, (Date.now() - taskStartedAt) / 1000);
        this.opts.usageHook.recordSession({ sessionId: sid, durationSec, kind: 'agent' });
      }
      return output;
    };
    if (created.status === 'completed' && typeof created.output === 'string') return recordIfTracked(created.output);

    const started = Date.now();
    while (Date.now() - started < maxWait) {
      await new Promise((r) => setTimeout(r, 2000));
      const pollResp = await fetch(`${API_BASE}/sessions/${sid}`, {
        headers: { 'X-Browser-Use-API-Key': this.opts.apiKey },
      });
      if (!pollResp.ok) {
        const body = await pollResp.text().catch(() => '');
        throw new Error(`Browser-Use Cloud /sessions/${sid} GET failed: HTTP ${pollResp.status} ${body.slice(0, 200)}`);
      }
      const polled = (await pollResp.json()) as { status?: string; output?: string; error?: string };
      if (polled.status === 'completed') return recordIfTracked(polled.output ?? '(task completed with no output)');
      if (polled.status === 'failed' || polled.status === 'error' || polled.status === 'stopped') {
        return recordIfTracked(`Task ${polled.status}: ${polled.error ?? polled.output ?? '(no detail)'}`);
      }
    }
    return recordIfTracked(`Task did not complete within ${Math.round(maxWait / 1000)}s. Session id: ${sid}. You can stop it via the dashboard.`);
  }

  private require(sessionId: string): CloudSessionState {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown browser session ${sessionId}. Call browser_open first.`);
    return s;
  }

  /** Close all live sessions — called from Mercury's lifecycle shutdown hook. */
  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.close(id).catch(() => {})));
  }

  getSessionIds(): string[] {
    return [...this.sessions.keys()];
  }
}
