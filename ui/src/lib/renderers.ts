import { useEffect, useState } from "react";

/**
 * Renderers a plugin declares for a fence language (Plugin API 1.3).
 *
 * The dashboard does not know what `openui` or `diff` mean, and it must not: a plugin
 * ships an HTML renderer, Mercury serves it behind a CSP that allows nothing, and the
 * client draws it in a sandboxed iframe. With no plugin installed the list is empty and
 * every fence stays a code block — that is the whole default behaviour, unchanged.
 */
export interface PluginRenderer {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  language: string;
  title?: string;
  sandbox: "iframe";
  url: string;
}

let cache: Promise<PluginRenderer[]> | null = null;

/** One fetch per page load; a failed listing is an empty registry, never an error screen. */
export function loadRenderers(): Promise<PluginRenderer[]> {
  if (!cache) {
    cache = fetch("/api/ui/renderers", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : { renderers: [] }))
      .then((body: { renderers?: PluginRenderer[] }) => (Array.isArray(body.renderers) ? body.renderers : []))
      .catch(() => []);
  }
  return cache;
}

/** The renderer that should draw this fence, if any. Comparison is on the fence language. */
export function useRenderer(language: string): { renderer?: PluginRenderer; loading: boolean } {
  const [available, setAvailable] = useState<PluginRenderer[] | null>(null);

  useEffect(() => {
    let alive = true;
    loadRenderers().then((list) => {
      if (alive) setAvailable(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (available === null) return { loading: true };
  const normalised = language.trim().toLowerCase();
  return { renderer: available.find((renderer) => renderer.language === normalised), loading: false };
}
