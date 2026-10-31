import { useEffect, useRef, useState } from "react";
import type { PluginRenderer } from "@/lib/renderers";

/**
 * Frame protocol v1 — the only thing a renderer and this host agree on.
 *
 * Host → renderer: `{ v: 1, type: "render", language, text, complete, theme }`, sent on
 * load and on every change while the answer streams.
 * Renderer → host: `{ v: 1, type: "height", px }` and `{ v: 1, type: "error", message }`.
 *
 * `text` may be incomplete: `complete: false` means the fence is still being written.
 * Incrementality is the renderer's business — it knows what a valid boundary is in its
 * own language — which is why the host never parses anything.
 */
export interface FrameTheme {
  dark: boolean;
  text: string;
  muted: string;
  surface: string;
  border: string;
  accent: string;
  danger: string;
  mono: string;
}

interface HostMessage {
  v: 1;
  type: "render";
  language: string;
  text: string;
  complete: boolean;
  theme: FrameTheme;
}

const MIN_HEIGHT = 32;
const MAX_HEIGHT = 2400;

function readTheme(): FrameTheme {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => {
    const value = styles.getPropertyValue(name).trim();
    return value ? `hsl(${value})` : fallback;
  };
  const dark = document.documentElement.classList.contains("dark");
  return {
    dark,
    text: read("--foreground", dark ? "#e8e8e6" : "#141414"),
    muted: read("--muted-foreground", dark ? "#8b98aa" : "#737373"),
    surface: read("--card", dark ? "#0f1720" : "#ffffff"),
    border: read("--border", dark ? "#1d2530" : "#e5e5e5"),
    accent: "#00d4ff",
    danger: dark ? "#ff6b6b" : "#dc2626",
    mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  };
}

interface PluginRendererFrameProps {
  renderer: PluginRenderer;
  text: string;
  complete: boolean;
}

/**
 * A plugin renderer, drawn in `<iframe sandbox="allow-scripts">`.
 *
 * No `allow-same-origin`: the frame gets an opaque origin, so it cannot reach the app's
 * DOM, its storage or its session cookie, and the asset it loads ships with a CSP that
 * blocks every network call. The host learns the height from the frame and never guesses
 * it: a renderer that reports nothing keeps the minimum height, and one that reports an
 * error is replaced by a one-line notice rather than an empty box.
 */
export function PluginRendererFrame({ renderer, text, complete }: PluginRendererFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [failed, setFailed] = useState<string | null>(null);
  const readyRef = useRef(false);

  const post = (message: HostMessage) => {
    frameRef.current?.contentWindow?.postMessage(message, "*");
  };

  const sendRender = () => {
    post({ v: 1, type: "render", language: renderer.language, text, complete, theme: readTheme() });
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // The frame has an opaque origin, so `event.origin` is "null": the only thing we can
      // check is that the message comes from *this* frame.
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { v?: number; type?: string; px?: number; message?: string };
      if (!data || data.v !== 1) return;
      if (data.type === "ready") {
        readyRef.current = true;
        sendRender();
        return;
      }
      if (data.type === "height" && typeof data.px === "number" && Number.isFinite(data.px)) {
        setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(data.px))));
        return;
      }
      if (data.type === "error") {
        setFailed(typeof data.message === "string" ? data.message : "renderer error");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  // Every change in the answer goes to the frame as a whole document: the renderer decides
  // what it can draw from a prefix.
  useEffect(() => {
    if (readyRef.current) sendRender();
  });

  if (failed) {
    return (
      <div className="rounded-lg border border-border bg-card/60 px-3 py-2 text-[11px] text-muted-foreground">
        {renderer.title ?? renderer.language} — renderer failed: {failed}
      </div>
    );
  }

  // The message bubble is shrink-to-fit (`max-w-[80%]` inside a flex row), and a percentage
  // width does not resolve during intrinsic sizing — so `width: 100%` alone leaves the frame
  // at the 300 px a replaced element gets by default. A definite `min-width` in viewport
  // units breaks that cycle without touching how text bubbles hug their content.
  return (
    <div className="my-3" style={{ width: "100%", maxWidth: "100%" }}>
      <iframe
        ref={frameRef}
        title={renderer.title ?? `${renderer.language} renderer`}
        src={renderer.url}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        // No `loading="lazy"`: a frame that loads while scrolled out of view inside the
        // message list can be left unpainted by the compositor. The frame is a few KB.
        // `onLoad` fires after the frame's script has run, so the render cannot be lost to a
        // `ready` posted before this window had a listener (a reloaded page hits that race).
        onLoad={sendRender}
        className="rounded-lg border border-border bg-transparent"
        style={{
          display: "block",
          width: "100%",
          minWidth: "min(480px, 85vw)",
          height,
          border: "none",
          background: "transparent",
        }}
      />
    </div>
  );
}
