/**
 * Shared interface for browser automation backends.
 *
 * Two implementations live alongside this file:
 *   - cloud.ts   — connects to a remote Browser-Use Cloud Chromium over CDP
 *   - local.ts   — launches a local Chromium with Playwright (lazy install)
 *
 * Both produce identical NormalizedPageState shapes so tools can be backend-agnostic.
 */

export interface InteractiveElement {
  /** Stable per-session index used by browser_click / browser_type. */
  index: number;
  /** Element tag (a, button, input, select, textarea, ...). */
  tag: string;
  /** Best-effort textual label (innerText, placeholder, aria-label, value). */
  text: string;
  /** Element type attribute (for inputs / buttons). */
  type?: string;
  /** href for anchors, src for media. */
  href?: string;
  /** Numeric viewport position; useful for the LLM to reason about layout. */
  boundingBox?: { x: number; y: number; width: number; height: number };
}

export interface NormalizedPageState {
  url: string;
  title: string;
  /** Top-N interactive elements (capped by tool). */
  elements: InteractiveElement[];
  /** Total interactive elements on the page (uncapped). */
  totalElements: number;
  /** True when the page is still loading; tool may want to re-poll. */
  loading: boolean;
}

export interface BrowserSessionHandle {
  /** Stable session id, exposed in tool output for the LLM. */
  sessionId: string;
  /** Which backend served this session. */
  backend: BackendName;
  /** Wall-clock timestamp when the session started (ms since epoch). */
  startedAt: number;
}

export type BackendName = 'cloud' | 'local';

export interface BrowserBackend {
  readonly name: BackendName;

  /** Probe whether this backend can run right now without performing any installation. */
  isAvailable(): Promise<{ ok: true } | { ok: false; reason: string }>;

  /** Open `url` in a new session, or in the existing session if `existingSessionId` is supplied. */
  open(url: string, opts?: { existingSessionId?: string }): Promise<BrowserSessionHandle>;

  state(sessionId: string, opts?: { maxElements?: number }): Promise<NormalizedPageState>;

  click(sessionId: string, index: number): Promise<void>;

  type(sessionId: string, index: number, text: string, opts?: { submit?: boolean }): Promise<void>;

  /** Extract text content; if `selector` is supplied, scope to that CSS selector. */
  extract(sessionId: string, selector?: string): Promise<string>;

  screenshot(sessionId: string): Promise<{ data: Buffer; mime: 'image/png' }>;

  close(sessionId: string): Promise<void>;
}

/**
 * Domains that ALWAYS prefer the local backend regardless of user default.
 * Cannot be removed by user config — only extended. Matched as suffix or full host.
 */
export const SENSITIVE_DOMAIN_SUFFIXES: ReadonlyArray<string> = [
  // Email
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.yahoo.com',
  'proton.me',
  'protonmail.com',
  'fastmail.com',
  'icloud.com',
  // Banks (non-exhaustive seed; user can extend)
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'hsbc.com',
  'hsbc.co.uk',
  'citibank.com',
  'usbank.com',
  'capitalone.com',
  'barclays.co.uk',
  'lloydsbank.com',
  // Crypto
  'coinbase.com',
  'binance.com',
  'binance.us',
  'kraken.com',
  'metamask.io',
  // Identity
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
  'login.live.com',
  // Government TLDs (matched separately as suffix)
  '.gov',
  '.gov.uk',
  '.gc.ca',
  '.gov.au',
];

/**
 * Heuristic: does this host look like a bank? Used in addition to the explicit list
 * so we err on the side of routing to local when uncertain.
 */
export function looksLikeSensitiveHost(host: string): boolean {
  const h = host.toLowerCase();
  for (const suffix of SENSITIVE_DOMAIN_SUFFIXES) {
    if (suffix.startsWith('.')) {
      if (h.endsWith(suffix)) return true;
    } else if (h === suffix || h.endsWith('.' + suffix)) {
      return true;
    }
  }
  // Generic banking heuristic — catches *bank*.com, *.bank, online-banking.*, etc.
  if (/\b(bank|banking|credit-?union)\b/.test(h)) return true;
  return false;
}

export function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
