/**
 * Renderers contributed by plugins (Plugin API 1.3).
 *
 * A plugin may declare `contributes.renderers: [{ language, asset, sandbox }]`. Mercury
 * *serves* that asset and the dashboard *offers* it for that fence language — it never
 * evals plugin code in the app's own context. The route below ships the file behind a
 * CSP that allows nothing, and the client draws it in `<iframe sandbox="allow-scripts">`
 * (no same-origin): the renderer sees pixels and a `postMessage` channel, never the
 * session cookie, the transcript, or the network.
 *
 * Nothing here runs when no plugin declares a renderer: the list is empty, the dashboard
 * falls back to the code block, and the core behaves exactly as it did before.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { loadManifest } from './installer.js';
import { pluginVersionDir, readState } from './store.js';
import type { PluginManifest } from './types.js';

/** An HTML renderer is one screen of markup + script: 768 KB is generous. */
export const MAX_RENDERER_BYTES = 768 * 1024;

export interface RendererEntry {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  language: string;
  title?: string;
  sandbox: 'iframe';
  /** Where the client loads it from; absolute path on this daemon. */
  url: string;
}

/** Enabled plugins that declare renderers, in install order. */
export function listRenderers(): RendererEntry[] {
  const state = readState();
  const entries: RendererEntry[] = [];
  for (const [id, installed] of Object.entries(state.plugins)) {
    if (!installed.enabled) continue;
    let manifest: PluginManifest;
    try {
      manifest = loadManifest(pluginVersionDir(id, installed.version));
    } catch {
      continue; // a broken manifest is the manager's problem, not the dashboard's
    }
    for (const renderer of manifest.contributes.renderers ?? []) {
      entries.push({
        pluginId: id,
        pluginName: manifest.name,
        pluginVersion: manifest.version,
        language: renderer.language,
        ...(renderer.title ? { title: renderer.title } : {}),
        sandbox: renderer.sandbox ?? 'iframe',
        url: `/api/ui/renderers/${encodeURIComponent(id)}/${encodeURIComponent(renderer.language)}`,
      });
    }
  }
  return entries;
}

export interface RendererAsset {
  html: string;
  pluginId: string;
  language: string;
}

/**
 * The asset for one renderer, or null. Every path is re-derived from the installed
 * manifest and checked to stay inside the plugin folder: the URL is a lookup key, not a
 * file path.
 */
export function readRendererAsset(pluginId: string, language: string): RendererAsset | null {
  const state = readState();
  const installed = state.plugins[pluginId];
  if (!installed?.enabled) return null;
  const dir = pluginVersionDir(pluginId, installed.version);
  let manifest: PluginManifest;
  try {
    manifest = loadManifest(dir);
  } catch {
    return null;
  }
  const renderer = (manifest.contributes.renderers ?? []).find((entry) => entry.language === language);
  if (!renderer) return null;
  const file = resolve(dir, renderer.asset);
  const root = resolve(dir);
  if (file !== root && !file.startsWith(root + sep)) return null;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  if (statSync(file).size > MAX_RENDERER_BYTES) return null;
  return { html: readFileSync(file, 'utf8'), pluginId, language };
}

/** Headers a served renderer gets: no network, no framing, no sniffing. */
export const RENDERER_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // A renderer is versioned with its plugin: revalidate, but never hold a stale copy.
  'Cache-Control': 'no-cache',
};

/** True when the language is claimed by more than one enabled plugin (first wins, loudly). */
export function duplicateLanguages(entries: RendererEntry[] = listRenderers()): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.language)) duplicates.add(entry.language);
    seen.add(entry.language);
  }
  return [...duplicates];
}

/** Exported for tests: the folder a renderer would be served from. */
export function rendererDirFor(pluginId: string): string | null {
  const installed = readState().plugins[pluginId];
  if (!installed) return null;
  return join(pluginVersionDir(pluginId, installed.version));
}
