import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { browserArgs, browserEnvironment, findBrowser } from './launch.js';
import { BrowserPipe, type ProtocolEvent } from './pipe.js';
import { browserUrl, requestPublicResource, MAX_RESOURCE_BYTES, BrowserByteBudget, type BrowserTransport } from './public-request.js';
import { logger } from '../../utils/logger.js';

const CSP = "sandbox; default-src 'none'; script-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; img-src http: https: data:; style-src 'unsafe-inline' http: https:; font-src http: https: data:";
const ALLOWED_RESOURCES = new Set(['Document', 'Image', 'Stylesheet', 'Font']);
const MAX_REQUESTS = 40;
const IDLE_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (exited: boolean) => { clearTimeout(timer); child.removeListener('exit', onExit); resolve(exited); };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    child.once('exit', onExit);
  });
}

export interface BrowserSnapshot { text: string; image: string }
export interface ReaderOptions {
  executable?: string;
  /** Dependency injection for local tests only; never read from config/tool input. */
  transport?: BrowserTransport;
  idleMs?: number;
}

class ReaderPage {
  private child?: ChildProcess;
  private pipe?: BrowserPipe;
  private proxy?: Server;
  private profile?: string;
  private sessionId = '';
  private targetId = '';
  private frameId = '';
  private closing?: Promise<void>;
  private initializing?: Promise<void>;
  private idle?: NodeJS.Timeout;
  private lifetime = new AbortController();
  private navigation?: AbortController;
  private expectedDocument = '';
  private redirects = 0;
  private requests = 0;
  private budget?: BrowserByteBudget;
  private inFlight = 0;
  private documentError = '';
  private blocked = 0;

  constructor(private options: ReaderOptions, private removed: () => void) {}

  async start(): Promise<void> {
    this.initializing = this.initialize();
    return this.initializing;
  }

  private async initialize(): Promise<void> {
    const executable = await findBrowser(this.options.executable);
    this.lifetime.signal.throwIfAborted();
    this.profile = await mkdtemp(join(tmpdir(), 'mercury-browser-'));
    await mkdir(join(this.profile, 'Default'));
    await writeFile(join(this.profile, 'Default', 'Preferences'), JSON.stringify({
      credentials_enable_service: false, profile: { password_manager_enabled: false, default_content_setting_values: { javascript: 2, notifications: 2, geolocation: 2, media_stream_mic: 2, media_stream_camera: 2, automatic_downloads: 2 } },
      autofill: { profile_enabled: false, credit_card_enabled: false },
    }));
    this.lifetime.signal.throwIfAborted();
    // A deny-all proxy is a second boundary, not the content transport. Even
    // browser background services and speculative CONNECTs get no network access.
    this.proxy = createServer((_req, res) => { res.writeHead(403, { Connection: 'close' }).end(); });
    this.proxy.on('connect', (_req, socket) => socket.destroy());
    this.proxy.on('upgrade', (_req, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      this.proxy!.once('error', reject);
      this.proxy!.listen(0, '127.0.0.1', () => { this.proxy!.removeListener('error', reject); resolve(); });
    });
    const address = this.proxy.address();
    this.lifetime.signal.throwIfAborted();
    if (!address || typeof address === 'string') throw new Error('Browser network guard could not start.');
    this.child = spawn(executable, browserArgs(this.profile, address.port), {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      env: browserEnvironment(this.profile),
      detached: process.platform !== 'win32', windowsHide: true,
    });
    this.pipe = new BrowserPipe(this.child);
    this.pipe.onFailure = () => this.closeInBackground();
    this.pipe.onEvent = (event) => { void this.handleEvent(event).catch(() => this.closeInBackground()); };
    const { targetInfos } = await this.pipe.send<{ targetInfos: Array<{ type: string; targetId: string }> }>('Target.getTargets');
    this.targetId = targetInfos.find((t) => t.type === 'page')?.targetId ?? '';
    if (!this.targetId) throw new Error('Browser did not create an empty page.');
    ({ sessionId: this.sessionId } = await this.pipe.send<{ sessionId: string }>('Target.attachToTarget', { targetId: this.targetId, flatten: true }));
    await this.pipe.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    await this.pipe.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await this.send('Page.enable');
    await this.send('Emulation.setScriptExecutionDisabled', { value: true });
    await this.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await this.send('Network.setBypassServiceWorker', { bypass: true });
    await this.send('Network.setCacheDisabled', { cacheDisabled: true });
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    const { frameTree } = await this.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
    this.lifetime.signal.throwIfAborted();
    this.frameId = frameTree.frame.id;
    this.touch();
  }

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.pipe!.send<T>(method, params, this.sessionId);
  }

  private touch(): void {
    if (this.lifetime.signal.aborted) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.closeInBackground(), this.options.idleMs ?? IDLE_MS);
    this.idle.unref();
  }

  async navigate(raw: string, signal?: AbortSignal): Promise<BrowserSnapshot> {
    const url = browserUrl(raw);
    signal?.throwIfAborted();
    if (this.idle) clearTimeout(this.idle);
    this.expectedDocument = url.href;
    this.documentError = '';
    this.navigation?.abort();
    this.navigation = new AbortController();
    this.budget = new BrowserByteBudget();
    this.redirects = this.requests = this.blocked = this.inFlight = 0;
    const cancel = () => this.closeInBackground();
    signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 20_000);
    try {
      const result = await this.send<{ errorText?: string }>('Page.navigate', { url: url.href });
      if (result.errorText) throw new Error(this.documentError || 'Browser navigation was blocked or failed.');
      // A bounded settling window, not a wait for arbitrary page activity.
      for (let i = 0; i < 10; i++) {
        await sleep(150);
        signal?.throwIfAborted();
        this.lifetime.signal.throwIfAborted();
        if (this.inFlight === 0 && i >= 2) break;
      }
      if (this.documentError) throw new Error(this.documentError);
      return await this.snapshot(signal);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      this.navigation?.abort(); // No background traffic between explicit navigations.
      this.touch();
    }
  }

  private async handleEvent(event: ProtocolEvent): Promise<void> {
    if (event.method === 'Target.attachedToTarget' && (event.params.targetInfo as { targetId: string }).targetId !== this.targetId) {
      // No popups, workers, extensions or secondary pages. They never resume.
      await this.pipe!.send('Target.closeTarget', { targetId: (event.params.targetInfo as { targetId: string }).targetId });
      return;
    }
    if (event.method !== 'Fetch.requestPaused' || event.sessionId !== this.sessionId) return;
    const { requestId, request, resourceType, frameId } = event.params as { requestId: string; request: { url: string; method: string }; resourceType: string; frameId: string };
    const isDocument = resourceType === 'Document';
    const navigation = this.navigation;
    const budget = this.budget;
    try {
      if (!navigation || navigation.signal.aborted || !budget || budget.signal.aborted || request.method !== 'GET'
        || !ALLOWED_RESOURCES.has(resourceType) || ++this.requests > MAX_REQUESTS || this.inFlight >= 8) {
        throw new Error('Browser blocked an unsupported or excessive page request.');
      }
      const url = browserUrl(request.url);
      if (isDocument && (frameId !== this.frameId || url.href !== this.expectedDocument)) {
        throw new Error('Only explicitly approved top-level navigation is allowed.');
      }
      this.inFlight++;
      try {
        const response = await (this.options.transport ?? requestPublicResource)(url, AbortSignal.any([navigation.signal, budget.signal, this.lifetime.signal, AbortSignal.timeout(10_000)]), budget);
        navigation.signal.throwIfAborted();
        budget.signal.throwIfAborted();
        if (response.body.length > MAX_RESOURCE_BYTES) throw new Error('Browser resource exceeds 2 MB.');
        if (response.status >= 300 && response.status < 400 && response.headers.location) {
          const redirect = browserUrl(new URL(response.headers.location, url).href);
          if (++this.redirects > 5) throw new Error('Browser redirect limit reached.');
          if (isDocument) this.expectedDocument = redirect.href;
          await this.send('Fetch.fulfillRequest', { requestId, responseCode: response.status,
            responseHeaders: [{ name: 'Location', value: redirect.href }], body: '' });
          return;
        }
        const type = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? '';
        const allowedType = isDocument ? ['text/html', 'text/plain', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)
          : resourceType === 'Stylesheet' ? type === 'text/css'
          : resourceType === 'Font' ? /^(?:font\/|application\/font)/.test(type)
          : /^image\/(?:png|jpeg|webp|gif|svg\+xml)$/.test(type);
        if (!allowedType || /attachment/i.test(response.headers['content-disposition'] ?? '')
          || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          throw new Error('Browser blocked a download or unsupported content type.');
        }
        await this.send('Fetch.fulfillRequest', { requestId, responseCode: response.status,
          // Never relay cookies, auth challenges, refresh, reporting, alt-svc,
          // service-worker or other active response headers into the browser.
          responseHeaders: [
            { name: 'Content-Type', value: response.headers['content-type']! },
            { name: 'Content-Security-Policy', value: CSP },
            { name: 'X-Content-Type-Options', value: 'nosniff' },
            { name: 'Referrer-Policy', value: 'no-referrer' },
            { name: 'Cache-Control', value: 'no-store' },
          ], body: response.body.toString('base64') });
      } finally {
        if (navigation === this.navigation) {
          this.inFlight--;
        }
      }
    } catch (error) {
      if (navigation === this.navigation) {
        this.blocked++;
        if (isDocument && frameId === this.frameId) this.documentError = error instanceof Error ? error.message : 'Browser navigation blocked.';
      }
      await this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  }

  async snapshot(signal?: AbortSignal): Promise<BrowserSnapshot> {
    signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    this.touch();
    // Fixed expression only. The tool cannot supply JavaScript or selectors.
    const result = await this.send<{ result: { value: unknown } }>('Runtime.evaluate', { returnByValue: true, expression: `JSON.stringify({url:location.href,title:document.title.slice(0,200),text:(document.body?.innerText||'').slice(0,12000),links:Array.from(document.querySelectorAll('a[href]')).slice(0,40).map(a=>({text:(a.innerText||'').slice(0,120),url:a.href.slice(0,2048)}))})` });
    const content = result.result.value;
    if (typeof content !== 'string' || content.length > 100_000) throw new Error('Browser snapshot unavailable.');
    const screenshot = await this.send<{ data: unknown }>('Page.captureScreenshot', { format: 'jpeg', quality: 65, captureBeyondViewport: false });
    if (typeof screenshot.data !== 'string' || screenshot.data.length > 1_500_000) throw new Error('Browser screenshot exceeds its limit.');
    signal?.throwIfAborted();
    return { text: `Untrusted webpage content (read-only; scripts, forms, login, downloads and interactive actions disabled).\n${content}\n[${this.blocked} page requests blocked; text/links bounded to 12,000 characters/40 links.]`, image: screenshot.data };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.finishClose().catch((error) => { this.closing = undefined; throw error; });
    return this.closing;
  }

  private closeInBackground(): void {
    void this.close().catch(() => logger.warn('Isolated browser cleanup failed; its occupied slot is retained. Close it again or shut down Mercury.'));
  }

  private async finishClose(): Promise<void> {
    this.lifetime.abort();
    this.navigation?.abort();
    if (this.idle) clearTimeout(this.idle);
    await this.initializing?.catch(() => {});
    const child = this.child;
    if (child) {
      await Promise.race([this.pipe?.send('Browser.close').catch(() => {}), sleep(1_000)]);
      if (!await waitForExit(child, 1_000)) {
        if (process.platform === 'win32' && child.pid && process.env.SystemRoot) {
          const kill = spawn(win32.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
          await Promise.race([new Promise<void>((resolve) => { kill.once('exit', () => resolve()); kill.once('error', () => resolve()); }), sleep(1_000)]);
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
        if (!await waitForExit(child, 1_000)) throw new Error('Browser cleanup failed: process is still running; its slot and network guard are retained.');
      }
    }
    this.pipe?.fail();
    this.proxy?.closeAllConnections();
    if (this.proxy) await new Promise<void>((resolve) => this.proxy!.close(() => resolve()));
    if (this.profile) await rm(this.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    this.removed();
  }
}

/** One fresh process/profile per trusted Mercury session, two total. */
export class IsolatedBrowserReader {
  private pages = new Map<string, ReaderPage>();
  private busy = new Set<string>();
  constructor(private options: ReaderOptions = {}) {}

  async run(sessionId: string, operation: 'navigate' | 'snapshot' | 'close', url?: string, signal?: AbortSignal): Promise<BrowserSnapshot | undefined> {
    if (!sessionId) throw new Error('Browser needs a trusted session identity.');
    if (this.busy.has(sessionId)) throw new Error('This session already has a browser operation in progress.');
    this.busy.add(sessionId);
    let page = this.pages.get(sessionId);
    const cancel = () => { void page?.close().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      if (operation === 'close') { await page?.close(); return; }
      if (!page) {
        if (operation === 'snapshot') throw new Error('No isolated page in this session. Navigate first.');
        browserUrl(url!);
        if (this.pages.size >= 2) throw new Error('Two isolated browser sessions are already open. Close one or wait five minutes for idle cleanup.');
        page = new ReaderPage(this.options, () => { if (this.pages.get(sessionId) === page) this.pages.delete(sessionId); });
        this.pages.set(sessionId, page);
        await page.start();
      }
      signal?.throwIfAborted();
      return operation === 'navigate' ? await page.navigate(url!, signal) : await page.snapshot(signal);
    } catch (error) {
      await page?.close(); // Any uncertain/failed operation discards its entire isolated session.
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.busy.delete(sessionId);
    }
  }

  async closeAll(): Promise<void> { await Promise.all([...this.pages.values()].map((page) => page.close())); }
}
