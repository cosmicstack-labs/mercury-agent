/**
 * Shared Playwright-driven page operations used by both Cloud and Local backends.
 *
 * Both backends produce a `Browser` instance (or `BrowserContext`) and a primary `Page`,
 * then funnel all click/type/extract/state work through these helpers so the
 * NormalizedPageState contract is identical regardless of where Chromium is running.
 *
 * Playwright types are imported via `playwright-core` (lazy `require` so missing-dep
 * errors surface as friendly tool-output strings, not module-load crashes).
 */

import type { Page, ElementHandle } from 'playwright-core';
import type { InteractiveElement, NormalizedPageState } from './base.js';

// Browser-context globals referenced inside page.evaluate() callbacks. These
// are declared as `any` here because we deliberately don't pull the DOM lib
// into Mercury's tsconfig (it's a Node project; DOM types would pollute every
// other file). Inside an `evaluate` body the code executes in the browser, so
// using untyped globals here is correct.
declare const document: any;
declare const window: any;
declare const HTMLInputElement: any;

const DEFAULT_MAX_ELEMENTS = 75;
const EXTRACT_MAX_CHARS = 12000;

/**
 * Lazy-load playwright-core. Returns null if not installed. Callers must surface
 * a clear error to the user with installation guidance.
 */
export async function loadPlaywrightCore(): Promise<typeof import('playwright-core') | null> {
  try {
    // Dynamic import via Function() to avoid bundlers eagerly resolving the dep
    // at build time (we want it lazily resolved at runtime).
    const importer = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
    return await importer('playwright-core');
  } catch {
    return null;
  }
}

/**
 * Build the NormalizedPageState by querying the DOM for interactive elements
 * and assigning them stable per-call indices.
 */
export async function buildPageState(page: Page, maxElements = DEFAULT_MAX_ELEMENTS): Promise<NormalizedPageState> {
  // Wait for DOM stability briefly so we don't snapshot mid-render.
  // Cap at 2s — we'd rather return a partial state than block forever.
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 2000 });
  } catch {
    // ignore — page may already be loaded or still loading
  }

  const evalResult = await page.evaluate((cap: number) => {
    const selector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="textbox"]',
      '[role="combobox"]',
      '[role="menuitem"]',
      '[onclick]',
    ].join(',');

    const nodes = Array.from(document.querySelectorAll(selector)) as any[];
    const visible: any[] = [];
    for (const n of nodes) {
      const style = window.getComputedStyle(n);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      const rect = n.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      visible.push(n);
    }

    const total = visible.length;
    const sliced = visible.slice(0, cap);

    function labelFor(el: any): string {
      const aria = el.getAttribute('aria-label');
      if (aria && aria.trim()) return aria.trim().slice(0, 140);
      const placeholder = el.placeholder;
      if (placeholder && placeholder.trim()) return placeholder.trim().slice(0, 140);
      const value = el.value;
      if (el instanceof HTMLInputElement && value && value.trim()) return value.trim().slice(0, 140);
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 140);
      const title = el.getAttribute('title');
      if (title) return title.trim().slice(0, 140);
      return '';
    }

    return {
      url: window.location.href,
      title: document.title,
      total,
      elements: sliced.map((el, i) => {
        const rect = el.getBoundingClientRect();
        return {
          index: i,
          tag: el.tagName.toLowerCase(),
          text: labelFor(el),
          type: el.getAttribute('type') || undefined,
          href: el.getAttribute('href') || undefined,
          boundingBox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        };
      }),
    };
  }, maxElements);

  return {
    url: evalResult.url,
    title: evalResult.title,
    elements: evalResult.elements as InteractiveElement[],
    totalElements: evalResult.total,
    loading: false,
  };
}

/**
 * Resolve an element by the index returned in a prior buildPageState() call.
 * Re-queries the DOM so we don't hold a stale handle across navigation.
 */
async function resolveByIndex(page: Page, index: number): Promise<ElementHandle | null> {
  const handle = await page.evaluateHandle((idx: number) => {
    const selector = [
      'a[href]', 'button',
      'input:not([type="hidden"])', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="checkbox"]',
      '[role="textbox"]', '[role="combobox"]', '[role="menuitem"]',
      '[onclick]',
    ].join(',');
    const nodes = Array.from(document.querySelectorAll(selector)) as any[];
    const visible: any[] = [];
    for (const n of nodes) {
      const style = window.getComputedStyle(n);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      const rect = n.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      visible.push(n);
    }
    return visible[idx] || null;
  }, index);

  const el = handle.asElement();
  return el as ElementHandle | null;
}

export async function clickByIndex(page: Page, index: number): Promise<void> {
  const handle = await resolveByIndex(page, index);
  if (!handle) throw new Error(`No interactive element at index ${index} — call browser_state first.`);
  await handle.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  await handle.click({ timeout: 5000 });
}

export async function typeByIndex(page: Page, index: number, text: string, submit = false): Promise<void> {
  const handle = await resolveByIndex(page, index);
  if (!handle) throw new Error(`No input element at index ${index} — call browser_state first.`);
  await handle.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  // Clear existing value first for inputs/textareas so caller doesn't have to.
  try {
    await handle.evaluate((node: any) => {
      if (node && typeof node === 'object' && 'value' in node) node.value = '';
    });
  } catch {
    // not all elements support .value — ignore
  }
  await handle.type(text, { timeout: 5000, delay: 10 });
  if (submit) {
    await page.keyboard.press('Enter');
  }
}

export async function extractText(page: Page, selector?: string): Promise<string> {
  if (selector) {
    const handles = await page.$$(selector);
    if (handles.length === 0) return `(no elements matched selector ${JSON.stringify(selector)})`;
    const parts: string[] = [];
    for (const h of handles) {
      const text = (await h.innerText().catch(() => '')) || (await h.textContent().catch(() => '')) || '';
      const trimmed = text.replace(/\s+/g, ' ').trim();
      if (trimmed) parts.push(trimmed);
      if (parts.join('\n').length > EXTRACT_MAX_CHARS) break;
    }
    const out = parts.join('\n');
    return out.length > EXTRACT_MAX_CHARS ? out.slice(0, EXTRACT_MAX_CHARS) + '\n... (truncated)' : out;
  }

  // No selector — extract whole-page readable text by stripping scripts/styles/nav/footer.
  const raw = await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as any;
    for (const sel of ['script', 'style', 'nav', 'footer', 'header', 'noscript', 'svg']) {
      clone.querySelectorAll(sel).forEach((n: any) => n.remove());
    }
    return clone.innerText as string;
  });
  const cleaned = raw.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.length > EXTRACT_MAX_CHARS ? cleaned.slice(0, EXTRACT_MAX_CHARS) + '\n... (truncated)' : cleaned;
}

export async function pageScreenshot(page: Page): Promise<Buffer> {
  return page.screenshot({ type: 'png', fullPage: false });
}
