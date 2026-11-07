import { ChevronRight, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type ForceGraph from "force-graph";
import type { LinkObject, NodeObject } from "force-graph";
import { forceCollide, forceX, forceY } from "d3-force";
import { cluster, hierarchy } from "d3-hierarchy";
import { brain, type BrainMap } from "~/api/brain";
import { Button } from "~/components/ui/Button";
import { Segmented, Spinner } from "~/components/ui/bits";
import { Switch } from "~/components/ui/Switch";
import { Tooltip } from "~/components/ui/Tooltip";
import { useTheme } from "~/app/theme";
import { cx } from "~/lib/cx";
import { ZoomPanel, zoomKeys } from "./ZoomPanel";
import { shortLabel, useNoteHoverCard } from "./NoteHoverCard";

/**
 * Everything Mercury knows, as a mind map: You → themes → sub-themes →
 * notes, laid out radially (d3-hierarchy cluster) and kept alive by
 * force-graph, so it flows from a random start into place and stays fluid
 * under the pointer. Themes and links come from the runtime
 * (knowledge-map.ts: BM25 + mutual-kNN + Louvain + c-TF-IDF, no model).
 *
 * Only the tree is physics. "Related" links (notes saying similar things)
 * are drawn on top, for the note under the pointer, or all of them, faint,
 * with "Links" on, so the map never turns into a hairball. Click a theme to
 * focus its branch; drag anything to pin it until "Reset layout". Outline
 * shows the same tree as a list.
 */

type Kind = "you" | "theme" | "sub" | "note";

export interface MapNode extends NodeObject {
  id: string;
  kind: Kind;
  label: string;
  /** Top-level theme this node belongs to ("" for you). */
  theme: string;
  /** Parent node id in the tree. */
  parent: string | null;
  color: string;
  size: number;
  /** Where the mind map wants it (radial target). */
  tx: number;
  ty: number;
  noteKind?: string;
  loose?: boolean;
}

interface MapLink extends LinkObject<MapNode> {
  kind: "tree";
  length: number;
}

const PINS_KEY = "mercury.brain.map.pins.v1";
export const LOOSE = "loose";
/** Twelve hues that read on light and dark; a theme keeps its hue while its id lives. */
const HUES = ["#5B8DEF", "#E0739B", "#3FB37F", "#D4A72C", "#9B7BD8", "#E8894A", "#2BB5C9", "#C9644F", "#7AA33B", "#B565C9", "#4F9AA8", "#D08A2E"];
const KIND_LABEL: Record<string, string> = {
  fact: "Fact", preference: "Preference", trait: "Trait", situation: "Situation", relationship: "Relationship", goal: "Goal", project: "Project",
  episode: "Moment", identity: "Identity", habit: "Habit", decision: "Decision", constraint: "Constraint", reflection: "Reflection",
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Stable colours: each theme hashes to a hue; clashes step to the next free one. */
export function themeColors(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<number>();
  for (const id of ids) {
    if (id === LOOSE) { out.set(id, "#8A97A3"); continue; }
    let i = hash(id) % HUES.length;
    for (let k = 0; k < HUES.length && used.has(i); k++) i = (i + 1) % HUES.length;
    used.add(i);
    if (used.size === HUES.length) used.clear();
    out.set(id, HUES[i]);
  }
  return out;
}

/** The map as a tree with radial targets. Pure, for tests. */
export function toMindMap(m: BrainMap): { nodes: MapNode[]; links: MapLink[]; related: Map<string, Array<[string, number]>> } {
  const tops = m.themes.filter((t) => !t.parent).sort((a, b) => (a.id === LOOSE ? 1 : b.id === LOOSE ? -1 : b.size - a.size));
  const subsOf = new Map<string, typeof m.themes>();
  for (const t of m.themes) if (t.parent) subsOf.set(t.parent, [...(subsOf.get(t.parent) ?? []), t]);
  const notesIn = new Map<string, BrainMap["notes"]>();
  for (const n of m.notes) {
    const at = m.placement[n.id];
    if (!at) continue;
    notesIn.set(at, [...(notesIn.get(at) ?? []), n]);
  }
  const colors = themeColors(tops.map((t) => t.id));

  type T = { id: string; children?: T[] };
  const tree: T = {
    id: "you",
    children: tops.map((t) => {
      const subs = (subsOf.get(t.id) ?? []).sort((a, b) => b.size - a.size);
      const leaves = (id: string) => (notesIn.get(id) ?? []).sort((a, b) => a.kind.localeCompare(b.kind) || b.at - a.at).map((n) => ({ id: n.id }));
      return { id: t.id, children: subs.length ? subs.map((s) => ({ id: s.id, children: leaves(s.id) })) : leaves(t.id) };
    }),
  };
  const noteCount = m.notes.length;
  // Ring big enough for every note to have a few pixels of arc.
  const R = Math.max(240, (noteCount * 9) / (2 * Math.PI));
  const root = hierarchy(tree);
  cluster<T>().size([2 * Math.PI, R]).separation((a, b) => (a.parent === b.parent ? 1 : 2.4))(root);

  const byId = new Map(m.themes.map((t) => [t.id, t]));
  const noteById = new Map(m.notes.map((n) => [n.id, n]));
  const nodes: MapNode[] = [];
  const links: MapLink[] = [];
  for (const d of root.descendants()) {
    const angle = d.x ?? 0;
    const kind: Kind = d.depth === 0 ? "you" : d.depth === 1 ? "theme" : d.children ? "sub" : "note";
    const r = kind === "you" ? 0 : kind === "theme" ? R * 0.34 : kind === "sub" ? R * 0.64 : R;
    const tx = r * Math.cos(angle - Math.PI / 2);
    const ty = r * Math.sin(angle - Math.PI / 2);
    const top = d.ancestors().find((a) => a.depth === 1)?.data.id ?? "";
    const color = colors.get(top) ?? "#8A97A3";
    const id = d.data.id;
    if (kind === "note") {
      const n = noteById.get(id)!;
      nodes.push({ id, kind, label: n.text, theme: top, parent: d.parent?.data.id ?? null, color, size: n.confidence, tx, ty, noteKind: n.kind, loose: top === LOOSE });
    } else if (kind === "you") {
      nodes.push({ id, kind, label: "You", theme: "", parent: null, color, size: noteCount, tx: 0, ty: 0 });
    } else {
      const t = byId.get(id)!;
      nodes.push({ id, kind, label: t.label, theme: top, parent: d.parent?.data.id ?? null, color, size: t.size, tx, ty, loose: top === LOOSE });
    }
    if (d.parent) links.push({ source: d.parent.data.id, target: id, kind: "tree", length: Math.max(20, r - (d.parent.depth === 0 ? 0 : d.parent.depth === 1 ? R * 0.34 : R * 0.64)) });
  }
  // Draw order is label priority: you, themes, sub-themes, notes.
  const order: Record<Kind, number> = { you: 0, theme: 1, sub: 2, note: 3 };
  nodes.sort((a, b) => order[a.kind] - order[b.kind]);

  const related = new Map<string, Array<[string, number]>>();
  const add = (a: string, b: string, w: number) => related.set(a, [...(related.get(a) ?? []), [b, w]]);
  for (const l of m.links) { add(l.a, l.b, l.w); add(l.b, l.a, l.w); }
  for (const list of related.values()) list.sort((x, y) => y[1] - x[1]);
  return { nodes, links, related };
}

type Mode = "map" | "outline";

export function MindMap({ visible, onSelect, selectedId }: { visible: boolean; onSelect: (node: { id: string; kind: "memory" } | null) => void; selectedId: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraph<MapNode, MapLink> | null>(null);
  const hoverCard = useNoteHoverCard(graph, host);
  const [data, setData] = useState<BrainMap | null>(null);
  const [archive, setArchive] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const [mode, setMode] = useState<Mode>("map");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [find, setFind] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [focus, setFocus] = useState<string | null>(null);
  const hover = useRef<MapNode | null>(null);
  const focusRef = useRef<string | null>(null);
  focusRef.current = focus;
  const linksRef = useRef(showLinks);
  linksRef.current = showLinks;
  const related = useRef<Map<string, Array<[string, number]>>>(new Map());
  const byId = useRef<Map<string, MapNode>>(new Map());
  const labelsDrawn = useRef<Array<[number, number, number, number]>>([]);
  const matches = useRef<Set<string>>(new Set());
  const resolved = useTheme((s) => s.resolved);
  const dark = useRef(resolved === "dark");
  dark.current = resolved === "dark";
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const load = useCallback(async (withArchive: boolean) => {
    setLoading(true);
    setError(null);
    try { setData(await brain.map(withArchive)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }, []);

  const requested = useRef(false);
  useEffect(() => {
    if (visible && !requested.current) { requested.current = true; void load(archive); }
  }, [visible, archive, load]);

  const mapData = useMemo(() => (data ? toMindMap(data) : null), [data]);
  const lastData = useRef<typeof mapData>(null);

  function setGraph(g: ForceGraph<MapNode, MapLink>, next: NonNullable<typeof mapData>) {
    lastData.current = next;
    related.current = next.related;
    const placed = place(next, g.graphData().nodes);
    byId.current = new Map(placed.nodes.map((n) => [n.id, n]));
    g.graphData(placed);
  }

  useEffect(() => {
    if (!visible || mode !== "map" || !mapData || graph.current || !host.current) return;
    let disposed = false;
    void import("force-graph").then(({ default: ForceGraphCtor }) => {
      if (disposed || !host.current || graph.current) return;
      const el = host.current;
      const g = new ForceGraphCtor<MapNode, MapLink>(el)
        .width(el.clientWidth)
        .height(el.clientHeight)
        .backgroundColor("rgba(0,0,0,0)")
        .nodeId("id")
        .minZoom(0.08)
        .maxZoom(12)
        .d3VelocityDecay(0.35)
        .d3AlphaDecay(0.02)
        .warmupTicks(0)
        .cooldownTicks(800)
        .linkCanvasObjectMode(() => "replace")
        .linkCanvasObject((l, ctx, scale) => drawBranch(l, ctx, scale))
        .nodeCanvasObject((n, ctx, scale) => drawNode(n, ctx, scale))
        .nodePointerAreaPaint((n, color, ctx, scale) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x ?? 0, n.y ?? 0, radius(n) + 3 / Math.min(1, scale), 0, 2 * Math.PI);
          ctx.fill();
          const hit = (n as MapNode & { __hit?: [number, number, number, number] }).__hit;
          if (hit && n.kind !== "note") ctx.fillRect(hit[0], hit[1], hit[2], hit[3]);
        })
        .onRenderFramePre(() => { labelsDrawn.current = []; })
        .onRenderFramePost((ctx, scale) => drawRelated(ctx, scale))
        .onZoom(({ k }) => setZoomPct(Math.round(k * 100)))
        .onRenderFramePost(() => hoverCard.place())
        .onNodeHover((n) => {
          hover.current = n ?? null;
          el.style.cursor = n ? "pointer" : "grab";
          hoverCard.hover(n?.kind === "note" ? n : null, n?.kind === "note" ? { text: n.label, label: byId.current.get(n.theme)?.label, color: n.color } : null);
        })
        .onNodeClick((n) => {
          if (n.kind === "note") { onSelectRef.current({ id: n.id, kind: "memory" }); return; }
          if (n.kind === "you") { setFocus(null); g.zoomToFit(600, 60); return; }
          focusOn(n.kind === "theme" ? n.id : n.id);
        })
        .onBackgroundClick(() => { setFocus(null); onSelectRef.current(null); })
        .onNodeDragEnd((n) => { n.fx = n.x; n.fy = n.y; savePin(n); });

      g.d3Force("charge")?.strength?.((n: MapNode) => CHARGE[n.kind]).distanceMax?.(260);
      g.d3Force("link")?.distance?.((l: MapLink) => l.length).strength?.(0.06);
      g.d3Force("collide", forceCollide<MapNode>((n) => radius(n) + (n.kind === "note" ? 1.2 : 6)).strength(0.7).iterations(1));
      g.d3Force("x", forceX<MapNode>((n) => n.tx).strength((n: MapNode) => PULL[n.kind]));
      g.d3Force("y", forceY<MapNode>((n) => n.ty).strength((n: MapNode) => PULL[n.kind]));

      graph.current = g;
      setGraph(g, mapData);
      setTimeout(() => { if (graph.current === g) g.zoomToFit(800, 50); }, 1800);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mapData, mode]);

  useEffect(() => {
    const g = graph.current;
    if (!g || !mapData || lastData.current === mapData) return;
    setGraph(g, mapData);
  }, [mapData]);

  useEffect(() => {
    const g = graph.current;
    if (!g) return;
    if (visible && mode === "map") g.resumeAnimation();
    else g.pauseAnimation();
  }, [visible, mode]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (el.clientWidth && el.clientHeight) graph.current?.width(el.clientWidth).height(el.clientHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => { graph.current?._destructor(); graph.current = null; }, []);

  useEffect(() => { const g = graph.current; if (g) g.nodeCanvasObject(g.nodeCanvasObject()); }, [resolved, selectedId, focus, showLinks]);

  useEffect(() => {
    const q = find.trim().toLowerCase();
    matches.current = new Set(q.length < 2 ? [] : [...byId.current.values()].filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id));
    setMatchCount(matches.current.size);
    const g = graph.current;
    if (g) g.nodeCanvasObject(g.nodeCanvasObject());
  }, [find, mapData]);

  function inBranch(n: MapNode, id: string): boolean {
    if (n.id === id) return true;
    let p = n.parent;
    while (p) { if (p === id) return true; p = byId.current.get(p)?.parent ?? null; }
    return false;
  }

  function focusOn(id: string) {
    const g = graph.current;
    setFocus(id);
    if (g) g.zoomToFit(700, 70, (n: MapNode) => inBranch(n, id));
  }

  function flyToMatch() {
    const g = graph.current;
    const n = [...byId.current.values()].find((x) => matches.current.has(x.id));
    if (!g || !n) return;
    g.centerAt(n.x, n.y, 600);
    g.zoom(Math.max(2.4, g.zoom()), 600);
    if (n.kind === "note") onSelectRef.current({ id: n.id, kind: "memory" });
  }

  function zoomBy(f: number) {
    const g = graph.current;
    if (g) g.zoom(Math.min(12, Math.max(0.08, g.zoom() * f)), 250);
  }

  function resetLayout() {
    const g = graph.current;
    if (!g) return;
    clearPins();
    setFocus(null);
    scatter(g.graphData().nodes, true);
    g.d3ReheatSimulation();
    setTimeout(() => g.zoomToFit(800, 50), 1800);
  }

  useEffect(() => {
    if (!visible || mode !== "map") return;
    const onKey = zoomKeys(zoomBy, () => graph.current?.zoomToFit(500, 50));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, mode]);

  const empty = data && data.notes.length === 0;

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={host} className={cx("absolute inset-0", mode !== "map" && "invisible")} style={{ cursor: "grab" }} />
      {mode === "map" && hoverCard.card}
      {mode === "outline" && data && <Outline data={data} selectedId={selectedId} onSelect={(id) => onSelect({ id, kind: "memory" })} find={find} />}

      <div className="pointer-events-none absolute left-4 right-4 top-3 flex flex-wrap items-center gap-2">
        <div className="pointer-events-auto"><Segmented value={mode} onChange={setMode} options={[{ value: "map", label: "Map" }, { value: "outline", label: "Outline" }]} /></div>
        <div className="pointer-events-auto flex h-8 items-center gap-3 rounded-md bg-surface/85 px-2.5 text-xs text-ink2 backdrop-blur">
          <Tooltip label="Draw every related link, not only for the note under the pointer" side="bottom">
            <span><Switch checked={showLinks} onCheckedChange={setShowLinks} label="Links" /></span>
          </Tooltip>
          <Tooltip label="Include older memories from before the Owner Model" side="bottom">
            <span><Switch checked={archive} onCheckedChange={(v) => { setArchive(v); void load(v); }} label="Archive" /></span>
          </Tooltip>
        </div>
        <div className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface/85 px-2 backdrop-blur">
          <Search size={13} className="text-ink4" />
          <input value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") flyToMatch(); if (e.key === "Escape") setFind(""); }}
            placeholder="Find in your brain" className="w-[160px] bg-transparent text-xs text-ink placeholder:text-ink4" aria-label="Find in your brain" />
          {find.trim().length > 1 && <span className="text-2xs text-ink4">{matchCount}</span>}
        </div>
        {data && <span className="rounded-md bg-surface/80 px-2 py-1 text-xs text-ink3 backdrop-blur">{data.stats.themes} themes · {data.stats.notes} notes · {data.stats.links} links</span>}
        {focus && mode === "map" && (
          <Button className="pointer-events-auto" size="sm" variant="outline" onClick={() => { setFocus(null); graph.current?.zoomToFit(600, 50); }}>Show everything</Button>
        )}
        <span className="flex-1" />
        <Tooltip label="Reload" side="bottom">
          <Button className="pointer-events-auto" size="sm" variant="ghost" icon onClick={() => void load(archive)} loading={loading} aria-label="Reload"><RefreshCw size={14} /></Button>
        </Tooltip>
      </div>

      {mode === "map" && <ZoomPanel zoomPct={zoomPct} onZoom={zoomBy} onFit={() => graph.current?.zoomToFit(500, 50)} onReset={resetLayout} />}

      {!data && !error && <div className="absolute inset-0 flex items-center justify-center text-ink3"><Spinner size={20} /></div>}
      {error && <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-ink3">Couldn't load the map: {error}</div>}
      {empty && <div className="absolute inset-0 flex items-center justify-center text-sm text-ink3">Nothing to map yet. Mercury builds this as it learns about you.</div>}
      {mode === "map" && data && !empty && (
        <div className="pointer-events-none absolute bottom-3 left-4 rounded-md bg-surface/85 px-2.5 py-1.5 text-xs text-ink4 backdrop-blur">
          click a theme to focus · hover a note for related ones · drag to pin · scroll or +/− to zoom
        </div>
      )}
    </div>
  );

  // ── drawing ──────────────────────────────────────────────────────────────

  function dimmed(n: MapNode): boolean {
    const f = focusRef.current;
    if (f && !inBranch(n, f) && n.kind !== "you") return true;
    if (matches.current.size > 0 && !matches.current.has(n.id) && n.kind === "note") return true;
    const h = hover.current;
    if (h?.kind === "note" && n.kind === "note" && h.id !== n.id && !related.current.get(h.id)?.some(([id]) => id === n.id)) return true;
    return false;
  }

  function drawBranch(l: MapLink, ctx: CanvasRenderingContext2D, scale: number) {
    const s = l.source as MapNode;
    const t = l.target as MapNode;
    if (s.x === undefined || t.x === undefined) return;
    const sx = s.x, sy = s.y ?? 0, tx = t.x, ty = t.y ?? 0;
    // Radial curve: leave the parent outward, arrive at the child along its own ray.
    const rs = Math.hypot(sx, sy);
    const rt = Math.hypot(tx, ty) || 1;
    const rm = (rs + rt) / 2;
    const c1x = rs > 1 ? (sx / rs) * rm : 0;
    const c1y = rs > 1 ? (sy / rs) * rm : 0;
    const c2x = (tx / rt) * rm;
    const c2y = (ty / rt) * rm;
    const dim = dimmed(t);
    const lit = hover.current && (hover.current.id === t.id || hover.current.parent === t.id);
    ctx.globalAlpha = dim ? 0.07 : lit ? 0.9 : t.kind === "note" ? 0.28 : 0.55;
    ctx.strokeStyle = t.color;
    ctx.lineWidth = (t.kind === "note" ? 0.7 : t.kind === "sub" ? 1.4 : 2.2) / Math.sqrt(scale);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, tx, ty);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** Related links: the hovered (or selected) note's, bright; everything, faint, when "Links" is on. */
  function drawRelated(ctx: CanvasRenderingContext2D, scale: number) {
    const lines: Array<[MapNode, MapNode, number, boolean]> = [];
    const focusNote = hover.current?.kind === "note" ? hover.current : selectedRef.current ? byId.current.get(selectedRef.current) : undefined;
    if (linksRef.current) {
      for (const [a, list] of related.current) {
        const na = byId.current.get(a);
        if (!na) continue;
        for (const [b, w] of list) if (a < b) { const nb = byId.current.get(b); if (nb) lines.push([na, nb, w, false]); }
      }
    }
    if (focusNote) for (const [b, w] of related.current.get(focusNote.id) ?? []) { const nb = byId.current.get(b); if (nb) lines.push([focusNote, nb, w, true]); }
    if (!lines.length) return;
    const d = dark.current;
    for (const [a, b, w, lit] of lines) {
      const ax = a.x ?? 0, ay = a.y ?? 0, bx = b.x ?? 0, by = b.y ?? 0;
      // Bow toward the centre, like a chord diagram, so links read as arcs across the map.
      const mx = ((ax + bx) / 2) * 0.55;
      const my = ((ay + by) / 2) * 0.55;
      ctx.globalAlpha = lit ? Math.min(1, 0.45 + w) : Math.min(0.35, 0.06 + w * 0.4);
      ctx.strokeStyle = lit ? (d ? "#34E1A1" : "#1A9E6E") : (d ? "#C8D0D6" : "#4A535B");
      ctx.lineWidth = (lit ? 1.6 : 0.6) / Math.sqrt(scale);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(mx, my, bx, by);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Name the related notes of the one under the pointer.
    if (focusNote) for (const [b] of (related.current.get(focusNote.id) ?? []).slice(0, 4)) { const nb = byId.current.get(b); if (nb) noteLabel(nb, ctx, scale, true); }
  }

  function claim(x: number, y: number, w: number, h: number): boolean {
    for (const [ax, ay, aw, ah] of labelsDrawn.current) if (x < ax + aw && x + w > ax && y < ay + ah && y + h > ay) return false;
    labelsDrawn.current.push([x, y, w, h]);
    return true;
  }

  function noteLabel(n: MapNode, ctx: CanvasRenderingContext2D, scale: number, force: boolean) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const size = 10.5 / scale;
    const text = shortLabel(n.label);
    ctx.font = `400 ${size}px "Geist Variable", system-ui, sans-serif`;
    const w = ctx.measureText(text).width;
    // Outward along the node's ray, flipped on the left so it never reads upside down.
    const a = Math.atan2(y, x);
    const left = Math.cos(a) < 0;
    const gap = radius(n) + 3 / scale;
    const lx = x + Math.cos(a) * gap;
    const ly = y + Math.sin(a) * gap;
    const box: [number, number, number, number] = [Math.min(lx, lx + Math.cos(a) * w) - 1, Math.min(ly, ly + Math.sin(a) * w) - size / 2, Math.abs(Math.cos(a) * w) + size, Math.abs(Math.sin(a) * w) + size];
    if (!force && !claim(...box)) return;
    if (force) labelsDrawn.current.push(box);
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(left ? a + Math.PI : a);
    ctx.textAlign = left ? "right" : "left";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = dark.current ? "rgba(17,19,21,0.85)" : "rgba(255,255,255,0.9)";
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = dark.current ? "rgba(236,239,241,0.95)" : "rgba(22,24,26,0.92)";
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function drawNode(n: MapNode, ctx: CanvasRenderingContext2D, scale: number) {
    const d = dark.current;
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const r = radius(n);
    const dim = dimmed(n);
    ctx.globalAlpha = dim ? 0.14 : n.loose ? 0.7 : 1;

    if (n.kind === "you") {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = d ? "#34E1A1" : "#1A9E6E";
      ctx.fill();
      pill(n, ctx, scale, "You", 13, 650, x, y + r + 4 / scale, null);
      ctx.globalAlpha = 1;
      return;
    }

    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    if (n.kind === "note") {
      ctx.fillStyle = n.color;
      ctx.fill();
    } else {
      ctx.fillStyle = d ? "rgba(17,19,21,0.95)" : "rgba(255,255,255,0.97)";
      ctx.fill();
      ctx.lineWidth = (n.kind === "theme" ? 2.6 : 1.8) / scale;
      ctx.strokeStyle = n.color;
      ctx.stroke();
    }
    if (selectedRef.current === n.id || matches.current.has(n.id)) {
      ctx.beginPath();
      ctx.arc(x, y, r + 3 / scale, 0, 2 * Math.PI);
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = d ? "#fff" : "#111";
      ctx.stroke();
    }
    if (n.fx !== undefined) {
      ctx.beginPath();
      ctx.arc(x + r * 0.75, y - r * 0.75, 2 / scale, 0, 2 * Math.PI);
      ctx.fillStyle = d ? "#F5C451" : "#A0620A";
      ctx.fill();
    }

    if (!dim) {
      if (n.kind === "theme") pill(n, ctx, scale, `${n.label}  ${n.size}`, 13, 650, x, y + r + 4 / scale, n.color);
      else if (n.kind === "sub" && (scale > 0.5 || focusRef.current === n.theme)) pill(n, ctx, scale, n.label, 11.5, 550, x, y + r + 3 / scale, n.color);
      else if (n.kind === "note") {
        const lit = hover.current?.id === n.id || selectedRef.current === n.id || matches.current.has(n.id);
        if (lit || scale > 1.7 || (focusRef.current && scale > 1.1)) noteLabel(n, ctx, scale, lit);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** A label on a soft pill, kept in screen pixels; remembers its box as part of the click target. */
  function pill(n: MapNode, ctx: CanvasRenderingContext2D, scale: number, text: string, px: number, weight: number, cx0: number, top: number, accent: string | null) {
    const size = px / scale;
    ctx.font = `${weight} ${size}px "Geist Variable", system-ui, sans-serif`;
    const w = ctx.measureText(text).width;
    const padX = 6 / scale;
    const padY = 3 / scale;
    const bx = cx0 - w / 2 - padX;
    const bw = w + padX * 2;
    const bh = size + padY * 2;
    const force = n.kind !== "sub";
    if (!force && !claim(bx, top, bw, bh)) return;
    if (force) labelsDrawn.current.push([bx, top, bw, bh]);
    (n as MapNode & { __hit?: [number, number, number, number] }).__hit = [bx, top, bw, bh];
    const d = dark.current;
    ctx.beginPath();
    ctx.roundRect(bx, top, bw, bh, bh / 2);
    ctx.fillStyle = d ? "rgba(23,26,29,0.92)" : "rgba(255,255,255,0.94)";
    ctx.fill();
    if (accent) {
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = accent;
      ctx.stroke();
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = d ? "rgba(236,239,241,0.96)" : "rgba(22,24,26,0.94)";
    ctx.fillText(text, cx0, top + bh / 2);
  }
}

// ── outline: the same tree as a list ─────────────────────────────────────────

function Outline({ data, selectedId, onSelect, find }: { data: BrainMap; selectedId: string | null; onSelect: (id: string) => void; find: string }) {
  const q = find.trim().toLowerCase();
  const tree = useMemo(() => {
    const tops = data.themes.filter((t) => !t.parent).sort((a, b) => (a.id === LOOSE ? 1 : b.id === LOOSE ? -1 : b.size - a.size));
    const colors = themeColors(tops.map((t) => t.id));
    const notesIn = new Map<string, BrainMap["notes"]>();
    for (const n of data.notes) { const at = data.placement[n.id]; if (at) notesIn.set(at, [...(notesIn.get(at) ?? []), n]); }
    return tops.map((t) => ({
      theme: t,
      color: colors.get(t.id)!,
      subs: data.themes.filter((s) => s.parent === t.id).sort((a, b) => b.size - a.size).map((s) => ({ theme: s, notes: notesIn.get(s.id) ?? [] })),
      notes: notesIn.get(t.id) ?? [],
    }));
  }, [data]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(tree.slice(0, 1).map((t) => t.theme.id)));
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const hit = (text: string) => !q || text.toLowerCase().includes(q);

  const NoteRow = ({ n }: { n: BrainMap["notes"][number] }) => (
    <button onClick={() => onSelect(n.id)} className={cx("flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm text-ink2 hover:bg-ink/[0.05]", selectedId === n.id && "bg-ink/[0.07] text-ink")}>
      <span className="w-[74px] shrink-0 font-mono text-2xs uppercase text-ink4">{KIND_LABEL[n.kind] ?? n.kind}</span>
      <span className="min-w-0 flex-1">{n.text}</span>
    </button>
  );

  return (
    <div className="absolute inset-0 overflow-y-auto px-4 pb-8 pt-14">
      <div className="mx-auto flex max-w-3xl flex-col gap-1">
        {tree.map(({ theme, color, subs, notes }) => {
          const all = [...notes, ...subs.flatMap((s) => s.notes)];
          const shown = all.filter((n) => hit(n.text));
          if (q && shown.length === 0 && !hit(theme.label)) return null;
          const isOpen = open.has(theme.id) || (q.length > 1 && shown.length > 0);
          return (
            <div key={theme.id} className="rounded-xl border border-line bg-surface">
              <button onClick={() => toggle(theme.id)} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left">
                <ChevronRight size={14} className={cx("text-ink4 transition-transform", isOpen && "rotate-90")} />
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                <span className="flex-1 text-base font-medium text-ink">{theme.label}</span>
                <span className="font-mono text-xs text-ink4">{q ? `${shown.length}/` : ""}{all.length}</span>
              </button>
              {isOpen && (
                <div className="flex flex-col gap-2 border-t border-line px-3 py-2">
                  {subs.map((s) => {
                    const ns = s.notes.filter((n) => hit(n.text));
                    if (q && ns.length === 0) return null;
                    return (
                      <div key={s.theme.id}>
                        <div className="mb-0.5 flex items-center gap-2 px-2 pt-1 text-xs font-medium text-ink3">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />{s.theme.label}<span className="text-ink4">· {s.notes.length}</span>
                        </div>
                        {ns.map((n) => <NoteRow key={n.id} n={n} />)}
                      </div>
                    );
                  })}
                  {notes.filter((n) => hit(n.text)).map((n) => <NoteRow key={n.id} n={n} />)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── physics constants, placement ─────────────────────────────────────────────

const CHARGE: Record<Kind, number> = { you: -260, theme: -160, sub: -60, note: -6 };
/** Pull toward the mind-map position: firm for the skeleton, softer for notes so they stay fluid. */
const PULL: Record<Kind, number> = { you: 1, theme: 0.22, sub: 0.18, note: 0.1 };

function radius(n: MapNode): number {
  if (n.kind === "you") return 10;
  if (n.kind === "theme") return 6 + Math.min(9, Math.sqrt(n.size) * 0.9);
  if (n.kind === "sub") return 3.5 + Math.min(5, Math.sqrt(n.size) * 0.7);
  return 2.2 + Math.min(1.6, n.size * 1.6);
}

function readPins(): Record<string, [number, number]> {
  try { return JSON.parse(sessionStorage.getItem(PINS_KEY) ?? "{}") as Record<string, [number, number]>; } catch { return {}; }
}

function savePin(n: MapNode) {
  try {
    const pins = readPins();
    pins[n.id] = [Math.round(n.x ?? 0), Math.round(n.y ?? 0)];
    sessionStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch { /* storage blocked: the pin holds until reload */ }
}

function clearPins() {
  try { sessionStorage.removeItem(PINS_KEY); } catch { /* ignore */ }
}

/** A random start near the middle; the mind map then flows out into its shape. */
function scatter(nodes: MapNode[], unpin: boolean) {
  for (const n of nodes) {
    if (n.kind === "you") { n.x = 0; n.y = 0; n.fx = 0; n.fy = 0; continue; }
    if (unpin) { n.fx = undefined; n.fy = undefined; }
    const a = Math.random() * Math.PI * 2;
    const r = 40 + Math.random() * 260;
    n.x = Math.cos(a) * r;
    n.y = Math.sin(a) * r;
    n.vx = 0;
    n.vy = 0;
  }
}

function endId(e: string | number | MapNode | undefined): string {
  return typeof e === "object" && e ? String(e.id) : String(e ?? "");
}

function place(g: { nodes: MapNode[]; links: MapLink[] }, live: MapNode[]): { nodes: MapNode[]; links: MapLink[] } {
  const pins = readPins();
  const current = new Map(live.map((n) => [n.id, n]));
  const fresh: MapNode[] = [];
  const nodes = g.nodes.map((n) => {
    if (n.kind === "you") return { ...n, x: 0, y: 0, fx: 0, fy: 0 };
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
