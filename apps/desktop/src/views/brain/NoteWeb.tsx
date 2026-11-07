import { Crosshair, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type ForceGraph from "force-graph";
import type { LinkObject, NodeObject } from "force-graph";
import { forceCollide, forceX, forceY } from "d3-force";
import { brain, type BrainMap } from "~/api/brain";
import { Button } from "~/components/ui/Button";
import { Spinner } from "~/components/ui/bits";
import { Switch } from "~/components/ui/Switch";
import { Tooltip } from "~/components/ui/Tooltip";
import { useTheme } from "~/app/theme";
import { cx } from "~/lib/cx";
import { LOOSE, themeColors } from "./MindMap";
import { ZoomPanel, zoomKeys } from "./ZoomPanel";
import { shortLabel, useNoteHoverCard } from "./NoteHoverCard";

/**
 * The mind map: Obsidian's graph view for the second brain. Every note is a dot,
 * every "related" link a line (the sparse kNN links from knowledge-map.ts),
 * dots grow with their connections and take their theme's colour. Hover
 * lights a note's neighbours; click opens it; "Local" shows just a note and
 * its neighbourhood. The settings panel mirrors Obsidian's: filters, groups,
 * display, forces. Drag pins a dot until "Reset layout".
 */

export interface WebNode extends NodeObject {
  id: string;
  label: string;
  theme: string;
  color: string;
  degree: number;
  kind: string;
}

interface WebLink extends LinkObject<WebNode> {
  w: number;
}

export interface WebSettings {
  orphans: boolean;
  nodeSize: number;
  linkWidth: number;
  /** Zoom level from which labels fade in (Obsidian's "text fade threshold"). */
  textFade: number;
  center: number;
  repel: number;
  linkForce: number;
  linkDistance: number;
  hidden: string[];
}

const DEFAULTS: WebSettings = { orphans: true, nodeSize: 1, linkWidth: 1, textFade: 1.6, center: 0.06, repel: 40, linkForce: 0.5, linkDistance: 34, hidden: [] };
const SETTINGS_KEY = "mercury.brain.web.settings.v1";
const PINS_KEY = "mercury.brain.web.pins.v1";

function readSettings(): WebSettings {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<WebSettings>) }; } catch { return DEFAULTS; }
}

/** Notes and links → dots and lines, with degree and theme colour. Pure, for tests. */
export function toWeb(m: BrainMap, opts: { orphans: boolean; hidden: Set<string>; query: string; local: { id: string; depth: number } | null }): { nodes: WebNode[]; links: WebLink[] } {
  const parentOf = new Map(m.themes.map((t) => [t.id, t.parent]));
  const topOf = (id: string | undefined) => (id ? parentOf.get(id) ?? id : LOOSE);
  const tops = m.themes.filter((t) => !t.parent).sort((a, b) => (a.id === LOOSE ? 1 : b.id === LOOSE ? -1 : b.size - a.size));
  const colors = themeColors(tops.map((t) => t.id));
  const q = opts.query.trim().toLowerCase();

  let keep = new Set(m.notes.filter((n) => !opts.hidden.has(topOf(m.placement[n.id])) && (!q || n.text.toLowerCase().includes(q))).map((n) => n.id));
  let links = m.links.filter((l) => keep.has(l.a) && keep.has(l.b));

  if (opts.local && keep.has(opts.local.id)) {
    const adj = new Map<string, string[]>();
    for (const l of links) { adj.set(l.a, [...(adj.get(l.a) ?? []), l.b]); adj.set(l.b, [...(adj.get(l.b) ?? []), l.a]); }
    const seen = new Set([opts.local.id]);
    let frontier = [opts.local.id];
    for (let d = 0; d < opts.local.depth; d++) {
      const next: string[] = [];
      for (const id of frontier) for (const j of adj.get(id) ?? []) if (!seen.has(j)) { seen.add(j); next.push(j); }
      frontier = next;
    }
    keep = seen;
    links = links.filter((l) => keep.has(l.a) && keep.has(l.b));
  }

  const degree = new Map<string, number>();
  for (const l of links) { degree.set(l.a, (degree.get(l.a) ?? 0) + 1); degree.set(l.b, (degree.get(l.b) ?? 0) + 1); }
  const nodes = m.notes
    .filter((n) => keep.has(n.id) && (opts.orphans || (degree.get(n.id) ?? 0) > 0))
    .map((n) => {
      const theme = topOf(m.placement[n.id]);
      return { id: n.id, label: n.text, theme, color: colors.get(theme) ?? "#8A97A3", degree: degree.get(n.id) ?? 0, kind: n.kind };
    })
    // Hubs first, so their labels win the space.
    .sort((a, b) => b.degree - a.degree);
  const shown = new Set(nodes.map((n) => n.id));
  return { nodes, links: links.filter((l) => shown.has(l.a) && shown.has(l.b)).map((l) => ({ source: l.a, target: l.b, w: l.w })) };
}

export function NoteWeb({ visible, onSelect, selectedId }: { visible: boolean; onSelect: (node: { id: string; kind: "memory" } | null) => void; selectedId: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraph<WebNode, WebLink> | null>(null);
  const [data, setData] = useState<BrainMap | null>(null);
  const [archive, setArchive] = useState(false);
  const [settings, setSettings] = useState<WebSettings>(readSettings);
  const [panel, setPanel] = useState(false);
  const [query, setQuery] = useState("");
  const [local, setLocal] = useState<{ id: string; depth: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const hover = useRef<WebNode | null>(null);
  const adjacency = useRef<Map<string, Set<string>>>(new Map());
  const labelsDrawn = useRef<Array<[number, number, number, number]>>([]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const resolved = useTheme((s) => s.resolved);
  const dark = useRef(resolved === "dark");
  dark.current = resolved === "dark";
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const themeNames = useRef(new Map<string, string>());
  themeNames.current = new Map((data?.themes ?? []).map((t) => [t.id, t.label]));
  const hoverCard = useNoteHoverCard(graph, host);

  useEffect(() => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* per-device nicety only */ } }, [settings]);
  const set = <K extends keyof WebSettings>(k: K, v: WebSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  const load = useCallback(async (withArchive: boolean) => {
    setLoading(true);
    setError(null);
    try { setData(await brain.map(withArchive)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }, []);
  const requested = useRef(false);
  useEffect(() => { if (visible && !requested.current) { requested.current = true; void load(archive); } }, [visible, archive, load]);

  const hidden = useMemo(() => new Set(settings.hidden), [settings.hidden]);
  const webData = useMemo(() => (data ? toWeb(data, { orphans: settings.orphans, hidden, query, local }) : null), [data, settings.orphans, hidden, query, local]);
  const lastData = useRef<typeof webData>(null);

  function setGraph(g: ForceGraph<WebNode, WebLink>, next: NonNullable<typeof webData>) {
    lastData.current = next;
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => { let s = m.get(a); if (!s) m.set(a, (s = new Set())); s.add(b); };
    for (const l of next.links) { add(String(l.source), String(l.target)); add(String(l.target), String(l.source)); }
    adjacency.current = m;
    g.graphData(place(next, g.graphData().nodes));
  }

  useEffect(() => {
    if (!visible || !webData || graph.current || !host.current) return;
    let disposed = false;
    void import("force-graph").then(({ default: ForceGraphCtor }) => {
      if (disposed || !host.current || graph.current) return;
      const el = host.current;
      const g = new ForceGraphCtor<WebNode, WebLink>(el)
        .width(el.clientWidth)
        .height(el.clientHeight)
        .backgroundColor("rgba(0,0,0,0)")
        .nodeId("id")
        .minZoom(0.08)
        .maxZoom(12)
        .d3VelocityDecay(0.32)
        .d3AlphaDecay(0.018)
        .warmupTicks(0)
        .cooldownTicks(900)
        .linkColor((l) => linkColor(l))
        .linkWidth((l) => (isLit(l) ? 1.6 : 0.6) * settingsRef.current.linkWidth)
        .nodeCanvasObject((n, ctx, scale) => drawNode(n, ctx, scale))
        .nodePointerAreaPaint((n, color, ctx) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(n.x ?? 0, n.y ?? 0, radius(n) + 3, 0, 2 * Math.PI); ctx.fill(); })
        .onRenderFramePre(() => { labelsDrawn.current = []; })
        .onZoom(({ k }) => setZoomPct(Math.round(k * 100)))
        .onRenderFramePost(() => hoverCard.place())
        .onNodeHover((n) => {
          hover.current = n ?? null;
          el.style.cursor = n ? "pointer" : "grab";
          hoverCard.hover(n ?? null, n ? { text: n.label, label: themeNames.current.get(n.theme), color: n.color } : null);
        })
        .onNodeClick((n) => { onSelectRef.current({ id: n.id, kind: "memory" }); })
        .onBackgroundClick(() => onSelectRef.current(null))
        .onNodeDragEnd((n) => { n.fx = n.x; n.fy = n.y; savePin(n); });
      graph.current = g;
      applyForces(g, settingsRef.current);
      setGraph(g, webData);
      setTimeout(() => { if (graph.current === g) g.zoomToFit(700, 60); }, 1800);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, webData]);

  useEffect(() => {
    const g = graph.current;
    if (!g || !webData || lastData.current === webData) return;
    setGraph(g, webData);
    if (local) setTimeout(() => g.zoomToFit(600, 80), 900);
  }, [webData, local]);

  // Forces follow the sliders live, like Obsidian.
  useEffect(() => {
    const g = graph.current;
    if (!g) return;
    applyForces(g, settings);
    g.d3ReheatSimulation();
  }, [settings.center, settings.repel, settings.linkForce, settings.linkDistance, settings.nodeSize]);

  useEffect(() => { const g = graph.current; if (g) g.nodeCanvasObject(g.nodeCanvasObject()); }, [resolved, selectedId, settings.textFade, settings.linkWidth]);

  useEffect(() => {
    const g = graph.current;
    if (!g) return;
    if (visible) g.resumeAnimation(); else g.pauseAnimation();
  }, [visible]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (el.clientWidth && el.clientHeight) graph.current?.width(el.clientWidth).height(el.clientHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => { graph.current?._destructor(); graph.current = null; }, []);

  function zoomBy(f: number) {
    const g = graph.current;
    if (g) g.zoom(Math.min(12, Math.max(0.08, g.zoom() * f)), 250);
  }
  function resetLayout() {
    const g = graph.current;
    if (!g) return;
    clearPins();
    scatter(g.graphData().nodes, true);
    g.d3ReheatSimulation();
    setTimeout(() => g.zoomToFit(700, 60), 1800);
  }
  useEffect(() => {
    if (!visible) return;
    const onKey = zoomKeys(zoomBy, () => graph.current?.zoomToFit(500, 60));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  const tops = useMemo(() => {
    if (!data) return [];
    const list = data.themes.filter((t) => !t.parent).sort((a, b) => (a.id === LOOSE ? 1 : b.id === LOOSE ? -1 : b.size - a.size));
    const colors = themeColors(list.map((t) => t.id));
    return list.map((t) => ({ ...t, color: colors.get(t.id)! }));
  }, [data]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={host} className="absolute inset-0" style={{ cursor: "grab" }} />
      {hoverCard.card}

      <div className="pointer-events-none absolute left-4 right-4 top-3 flex flex-wrap items-center gap-2">
        <div className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface/85 px-2 backdrop-blur">
          <Search size={13} className="text-ink4" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
            placeholder="Filter notes" className="w-[160px] bg-transparent text-xs text-ink placeholder:text-ink4" aria-label="Filter notes" />
          {query && <button onClick={() => setQuery("")} className="text-ink4 hover:text-ink" aria-label="Clear filter"><X size={12} /></button>}
        </div>
        {selectedId && !local && (
          <Button className="pointer-events-auto" size="sm" variant="outline" onClick={() => setLocal({ id: selectedId, depth: 1 })}><Crosshair size={13} /> Local graph</Button>
        )}
        {local && (
          <div className="pointer-events-auto flex h-8 items-center gap-2 rounded-md border border-accent/40 bg-surface/90 px-2.5 text-xs text-ink2 backdrop-blur">
            <Crosshair size={13} className="text-accent" /> Local
            <span className="text-ink4">depth</span>
            {[1, 2, 3].map((d) => (
              <button key={d} onClick={() => setLocal({ ...local, depth: d })} className={cx("h-5 w-5 rounded font-mono", local.depth === d ? "bg-accent text-white" : "text-ink3 hover:bg-ink/[0.07]")}>{d}</button>
            ))}
            <button onClick={() => { setLocal(null); setTimeout(() => graph.current?.zoomToFit(600, 60), 900); }} className="text-ink4 hover:text-ink" aria-label="Back to the whole web"><X size={13} /></button>
          </div>
        )}
        {webData && <span className="rounded-md bg-surface/80 px-2 py-1 text-xs text-ink3 backdrop-blur">{webData.nodes.length} notes · {webData.links.length} links</span>}
        <span className="flex-1" />
        <Tooltip label="Reload" side="bottom">
          <Button className="pointer-events-auto" size="sm" variant="ghost" icon onClick={() => void load(archive)} loading={loading} aria-label="Reload"><RefreshCw size={14} /></Button>
        </Tooltip>
        <Tooltip label="Graph settings" side="bottom">
          <Button className="pointer-events-auto" size="sm" variant={panel ? "outline" : "ghost"} icon onClick={() => setPanel((p) => !p)} aria-label="Graph settings" aria-pressed={panel}><SlidersHorizontal size={14} /></Button>
        </Tooltip>
      </div>

      {panel && (
        <div className="absolute right-4 top-14 z-10 flex max-h-[calc(100%-140px)] w-[260px] flex-col gap-4 overflow-y-auto rounded-xl border border-line bg-surface/95 p-4 text-sm shadow-lg backdrop-blur">
          <Section title="Filters">
            <Row label="Orphans"><Switch checked={settings.orphans} onCheckedChange={(v) => set("orphans", v)} /></Row>
            <Row label="Archive"><Switch checked={archive} onCheckedChange={(v) => { setArchive(v); void load(v); }} /></Row>
          </Section>
          <Section title="Groups">
            <div className="flex flex-col gap-1">
              {tops.map((t) => {
                const off = hidden.has(t.id);
                return (
                  <button key={t.id} onClick={() => set("hidden", off ? settings.hidden.filter((h) => h !== t.id) : [...settings.hidden, t.id])}
                    className={cx("flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-ink/[0.05]", off && "opacity-40")} aria-pressed={!off}>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.color }} />
                    <span className="min-w-0 flex-1 truncate text-ink2">{t.label}</span>
                    <span className="font-mono text-2xs text-ink4">{t.size}</span>
                  </button>
                );
              })}
            </div>
          </Section>
          <Section title="Display">
            <Slider label="Node size" value={settings.nodeSize} min={0.4} max={2.5} step={0.1} onChange={(v) => set("nodeSize", v)} />
            <Slider label="Link thickness" value={settings.linkWidth} min={0.2} max={3} step={0.1} onChange={(v) => set("linkWidth", v)} />
            <Slider label="Text fade threshold" value={settings.textFade} min={0.3} max={4} step={0.1} onChange={(v) => set("textFade", v)} />
          </Section>
          <Section title="Forces">
            <Slider label="Center force" value={settings.center} min={0} max={0.3} step={0.01} onChange={(v) => set("center", v)} />
            <Slider label="Repel force" value={settings.repel} min={0} max={200} step={2} onChange={(v) => set("repel", v)} />
            <Slider label="Link force" value={settings.linkForce} min={0} max={1} step={0.02} onChange={(v) => set("linkForce", v)} />
            <Slider label="Link distance" value={settings.linkDistance} min={8} max={200} step={2} onChange={(v) => set("linkDistance", v)} />
          </Section>
          <Button size="sm" variant="ghost" onClick={() => setSettings({ ...DEFAULTS, hidden: settings.hidden })}>Restore defaults</Button>
        </div>
      )}

      <ZoomPanel zoomPct={zoomPct} onZoom={zoomBy} onFit={() => graph.current?.zoomToFit(500, 60)} onReset={resetLayout} />

      {!data && !error && <div className="absolute inset-0 flex items-center justify-center text-ink3"><Spinner size={20} /></div>}
      {error && <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-ink3">Couldn't load the mind map: {error}</div>}
      {data && data.notes.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-sm text-ink3">Nothing here yet. Notes appear as Mercury learns about you.</div>}
      {webData && data && data.notes.length > 0 && webData.nodes.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-sm text-ink3">No notes match.</div>}
      {data && data.notes.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 left-4 rounded-md bg-surface/85 px-2.5 py-1.5 text-xs text-ink4 backdrop-blur">
          hover to light up connections · click to open · drag to pin · scroll or +/− to zoom
        </div>
      )}
    </div>
  );

  // ── drawing ──────────────────────────────────────────────────────────────

  function radius(n: WebNode): number {
    return (2.2 + Math.sqrt(n.degree) * 1.15) * settingsRef.current.nodeSize;
  }

  function near(id: string): boolean {
    const h = hover.current;
    return !!h && (h.id === id || !!adjacency.current.get(h.id)?.has(id));
  }

  function isLit(l: WebLink): boolean {
    const h = hover.current;
    return !!h && (endId(l.source) === h.id || endId(l.target) === h.id);
  }

  function linkColor(l: WebLink): string {
    const d = dark.current;
    if (isLit(l)) return (l.source as WebNode).color ?? (d ? "#34E1A1" : "#1A9E6E");
    const a = hover.current ? 0.05 : 0.1 + Math.min(0.25, l.w * 0.4);
    return d ? `rgba(220,226,230,${a})` : `rgba(30,34,38,${a})`;
  }

  function claim(x: number, y: number, w: number, h: number): boolean {
    for (const [ax, ay, aw, ah] of labelsDrawn.current) if (x < ax + aw && x + w > ax && y < ay + ah && y + h > ay) return false;
    labelsDrawn.current.push([x, y, w, h]);
    return true;
  }

  function drawNode(n: WebNode, ctx: CanvasRenderingContext2D, scale: number) {
    const d = dark.current;
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const r = radius(n);
    const h = hover.current;
    const dim = !!h && !near(n.id);
    ctx.globalAlpha = dim ? 0.15 : 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = n.color;
    ctx.fill();
    if (selectedRef.current === n.id || local?.id === n.id) {
      ctx.beginPath();
      ctx.arc(x, y, r + 2.5 / scale, 0, 2 * Math.PI);
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = d ? "#fff" : "#111";
      ctx.stroke();
    }
    if (n.fx !== undefined) {
      ctx.beginPath();
      ctx.arc(x + r * 0.75, y - r * 0.75, 1.8 / scale, 0, 2 * Math.PI);
      ctx.fillStyle = d ? "#F5C451" : "#A0620A";
      ctx.fill();
    }
    // Labels fade in past the threshold (hubs a little sooner); hovered neighbourhoods always.
    const lit = h?.id === n.id || (!!h && near(n.id)) || selectedRef.current === n.id;
    const fadeAt = settingsRef.current.textFade / (1 + Math.min(1.2, n.degree / 8));
    const alpha = lit ? 1 : Math.max(0, Math.min(1, (scale - fadeAt) / (fadeAt * 0.5)));
    if (alpha > 0.02 && !dim) {
      const size = 10.5 / scale;
      ctx.font = `${lit ? 500 : 400} ${size}px "Geist Variable", system-ui, sans-serif`;
      const text = shortLabel(n.label);
      const w = ctx.measureText(text).width;
      const ty = y + r + 2 / scale;
      if (lit ? (labelsDrawn.current.push([x - w / 2, ty, w, size]), true) : claim(x - w / 2, ty, w, size)) {
        ctx.globalAlpha = alpha;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.lineWidth = 3 / scale;
        ctx.strokeStyle = d ? "rgba(17,19,21,0.85)" : "rgba(255,255,255,0.9)";
        ctx.strokeText(text, x, ty);
        ctx.fillStyle = d ? "rgba(236,239,241,0.95)" : "rgba(22,24,26,0.92)";
        ctx.fillText(text, x, ty);
      }
    }
    ctx.globalAlpha = 1;
  }

  function applyForces(g: ForceGraph<WebNode, WebLink>, s: WebSettings) {
    g.d3Force("charge")?.strength?.(-s.repel).distanceMax?.(400);
    g.d3Force("link")?.distance?.(s.linkDistance).strength?.((l: WebLink) => s.linkForce * (0.4 + Math.min(0.6, l.w)));
    g.d3Force("center", null);
    g.d3Force("x", forceX<WebNode>(0).strength(s.center));
    g.d3Force("y", forceY<WebNode>(0).strength(s.center));
    g.d3Force("collide", forceCollide<WebNode>((n) => radius(n) + 1).strength(0.6).iterations(1));
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-2xs font-medium uppercase tracking-wider text-ink4">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between text-xs text-ink2">{label}{children}</div>;
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink2">
      <span className="flex justify-between">{label}<span className="font-mono text-2xs text-ink4">{Number(value.toFixed(2))}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--accent,#1A9E6E)]" />
    </label>
  );
}

function endId(e: string | number | WebNode | undefined): string {
  return typeof e === "object" && e ? String(e.id) : String(e ?? "");
}

function readPins(): Record<string, [number, number]> {
  try { return JSON.parse(sessionStorage.getItem(PINS_KEY) ?? "{}") as Record<string, [number, number]>; } catch { return {}; }
}
function savePin(n: WebNode) {
  try { const p = readPins(); p[n.id] = [Math.round(n.x ?? 0), Math.round(n.y ?? 0)]; sessionStorage.setItem(PINS_KEY, JSON.stringify(p)); } catch { /* pin holds until reload */ }
}
function clearPins() {
  try { sessionStorage.removeItem(PINS_KEY); } catch { /* ignore */ }
}

function scatter(nodes: WebNode[], unpin: boolean) {
  const spread = 60 + Math.sqrt(nodes.length) * 18;
  for (const n of nodes) {
    if (unpin) { n.fx = undefined; n.fy = undefined; }
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    n.x = Math.cos(a) * r;
    n.y = Math.sin(a) * r;
    n.vx = 0;
    n.vy = 0;
  }
}

function place(g: { nodes: WebNode[]; links: WebLink[] }, live: WebNode[]): { nodes: WebNode[]; links: WebLink[] } {
  const pins = readPins();
  const current = new Map(live.map((n) => [n.id, n]));
  const fresh: WebNode[] = [];
  const nodes = g.nodes.map((n) => {
    const pin = pins[n.id];
    if (pin) return { ...n, x: pin[0], y: pin[1], fx: pin[0], fy: pin[1] };
    const c = current.get(n.id);
    if (c?.x !== undefined) return { ...n, x: c.x, y: c.y, vx: c.vx, vy: c.vy, fx: c.fx, fy: c.fy };
    const copy = { ...n };
    fresh.push(copy);
    return copy;
  });
  scatter(fresh, false);
  return { nodes, links: g.links.map((l) => ({ ...l, source: endId(l.source), target: endId(l.target) })) };
}
