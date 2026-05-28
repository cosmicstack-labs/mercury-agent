/**
 * Singleton browser-session manager. Tracks open sessions across both backends
 * so the AI-SDK tools can refer to them by id, and so Mercury's shutdown hook
 * can close them cleanly.
 *
 * One backend instance per backend type per Mercury process. Sessions are
 * created lazily on first browser_open call.
 */

import { logger } from '../../utils/logger.js';
import type { BackendName, BrowserBackend, BrowserSessionHandle } from './backends/base.js';
import { CloudBrowserBackend } from './backends/cloud.js';
import { LocalBrowserBackend } from './backends/local.js';
import { getBrowserUseApiKey, isBrowserUseConfigured } from '../../auth/browser-use-auth.js';
import { loadConfig } from '../../utils/config.js';
import { getBrowserUseUsageTracker } from '../../utils/browser-use-usage.js';

export interface BrowserSessionRecord {
  sessionId: string;
  backend: BackendName;
  startedAt: number;
  lastUrl?: string;
}

class BrowserSessionManager {
  private cloudBackend?: CloudBrowserBackend;
  private localBackend?: LocalBrowserBackend;
  /** sessionId → backend name, for dispatch on subsequent tool calls. */
  private sessionRouting = new Map<string, BackendName>();
  /** sessionId → record, for listing / debugging / lifecycle. */
  private records = new Map<string, BrowserSessionRecord>();

  getCloudBackend(): CloudBrowserBackend | null {
    if (this.cloudBackend) return this.cloudBackend;
    if (!isBrowserUseConfigured()) return null;
    const tracker = getBrowserUseUsageTracker(loadConfig());
    this.cloudBackend = new CloudBrowserBackend({
      apiKey: getBrowserUseApiKey(),
      usageHook: {
        canStart: () => tracker.canStartCloudSession(),
        recordSession: (opts) => tracker.recordSession(opts),
      },
    });
    return this.cloudBackend;
  }

  getLocalBackend(): LocalBrowserBackend {
    if (!this.localBackend) this.localBackend = new LocalBrowserBackend();
    return this.localBackend;
  }

  getBackendForSession(sessionId: string): BrowserBackend {
    const name = this.sessionRouting.get(sessionId);
    if (!name) throw new Error(`Unknown browser session ${sessionId}. Call browser_open first.`);
    if (name === 'cloud') {
      const b = this.getCloudBackend();
      if (!b) throw new Error('Cloud backend no longer available (API key removed?)');
      return b;
    }
    return this.getLocalBackend();
  }

  registerSession(handle: BrowserSessionHandle, url: string): void {
    this.sessionRouting.set(handle.sessionId, handle.backend);
    this.records.set(handle.sessionId, {
      sessionId: handle.sessionId,
      backend: handle.backend,
      startedAt: handle.startedAt,
      lastUrl: url,
    });
  }

  forgetSession(sessionId: string): void {
    this.sessionRouting.delete(sessionId);
    this.records.delete(sessionId);
  }

  listSessions(): BrowserSessionRecord[] {
    return [...this.records.values()];
  }

  async closeAll(): Promise<void> {
    logger.info({ count: this.records.size }, 'Closing all browser sessions');
    if (this.cloudBackend) await this.cloudBackend.closeAll().catch(() => {});
    if (this.localBackend) await this.localBackend.closeAll().catch(() => {});
    this.records.clear();
    this.sessionRouting.clear();
  }
}

let singleton: BrowserSessionManager | null = null;

export function getBrowserSessionManager(): BrowserSessionManager {
  if (!singleton) singleton = new BrowserSessionManager();
  return singleton;
}

/** Wired by lifecycle.ts so paid Cloud sessions don't leak on shutdown. */
export async function shutdownBrowserSessions(): Promise<void> {
  if (singleton) await singleton.closeAll();
}
