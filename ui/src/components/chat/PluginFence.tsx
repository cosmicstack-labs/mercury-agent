import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api, { type PluginItem } from "@/lib/api";
import { CodeBlock } from "./CodeBlock";

/**
 * A fenced block drawn by a plugin (Plugin API 1.3).
 *
 * The plugin ships one HTML document; Mercury serves it with a CSP that allows nothing but
 * inline script and style, and this component hosts it in `sandbox="allow-scripts"` — an
 * opaque origin, so the document has no session cookie and no app DOM. The only way through
 * is the message channel below, and it starts with the frame saying it is ready:
 *
 *   frame → {v:1, type:'ready'}                       once, after its script ran
 *   host  → {v:1, type:'render', text, complete}      on every change, and on ready
 *   frame → {v:1, type:'height', px}                  whenever its layout settles
 *
 * `complete: false` while the answer streams: the renderer decides for itself what an
 * incomplete document means in its language (a half-parsed tree is not an error there).
 */

/** One fetch per dashboard session; renderers change only on a plugin install. */
let rendererCache: Promise<Map<string, { url: string; title?: string }>> | null = null;

function loadRenderers(): Promise<Map<string, { url: string; title?: string }>> {
  if (!rendererCache) {
    rendererCache = api.plugins
      .list()
      .then((result) => {
        const map = new Map<string, { url: string; title?: string }>();
        for (const item of result.items as PluginItem[]) {
          if (!item.running || !item.renderers) continue;
          for (const renderer of item.renderers) map.set(renderer.language, renderer);
        }
        return map;
      })
      .catch(() => new Map<string, { url: string; title?: string }>());
  }
  return rendererCache;
}

/** The installed renderers, keyed by the fenced-block language that selects them. */
export function useRenderers() {
  const [renderers, setRenderers] = useState<Map<string, { url: string; title?: string }>>(() => new Map());
  useEffect(() => {
    let live = true;
    loadRenderers().then((map) => {
      if (live) setRenderers(map);
    });
    return () => {
      live = false;
    };
  }, []);
  return renderers;
}

interface PluginFenceProps {
  language: string;
  code: string;
  /** False while the assistant is still streaming the fence. */
  complete?: boolean;
  url: string;
  title?: string;
}

export function PluginFence({ language, code, complete = true, url, title }: PluginFenceProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(48);
  const [failed, setFailed] = useState(false);

  const payload = useMemo(() => ({ v: 1, type: "render", text: code, complete }), [code, complete]);

  const send = useCallback(() => {
    const target = frame.current?.contentWindow;
    if (!target || !ready) return;
    target.postMessage(payload, "*");
  }, [payload, ready]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { v?: number; type?: string; px?: number } | null;
      if (!data || data.v !== 1) return;
      if (data.type === "ready") setReady(true);
      if (data.type === "height" && typeof data.px === "number") {
        // The renderer reports its own content height: a fixed height would clip it, and a
        // scrollbar inside the frame would belong to a document the dashboard cannot see.
        setHeight(Math.min(Math.max(data.px, 32), 4000));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    send();
  }, [send]);

  // A document that never says it is ready would leave an invisible frame behind. Six
  // seconds is long enough for a large bundle and short enough to notice.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!ready) setFailed(true);
    }, 6000);
    return () => clearTimeout(timer);
  }, [ready]);

  if (failed) return <CodeBlock code={code} language={language} />;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/50 bg-card/40">
      {title ? (
        <div className="border-b border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">
          {title}
        </div>
      ) : null}
      <iframe
        ref={frame}
        title={title ?? language}
        src={url}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{ width: "100%", height, border: 0, display: "block", background: "transparent" }}
      />
    </div>
  );
}

/** The renderer for a language, or null when no installed plugin claims it. */
export function useRendererFor(language: string) {
  const renderers = useRenderers();
  return renderers.get(language) ?? null;
}
