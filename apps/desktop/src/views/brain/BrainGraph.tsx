import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type ForceGraph from "force-graph";
import type { LinkObject, NodeObject } from "force-graph";
import { forceCollide, forceX, forceY } from "d3-force";
import { brain, type BrainGraphData } from "~/api/brain";
import { Button } from "~/components/ui/Button";
import { Segmented, Spinner } from "~/components/ui/bits";
import { Switch } from "~/components/ui/Switch";
import { Tooltip } from "~/components/ui/Tooltip";
import { useTheme } from "~/app/theme";
import { cx } from "~/lib/cx";
import { ZoomPanel, zoomKeys } from "./ZoomPanel";
import { shortLabel, useNoteHoverCard } from "./NoteHoverCard";

/**
 * The brain as a living graph, Obsidian-style.
 *
 * Library: force-graph (d3-force on canvas). Chosen after comparing sigma,
 * cosmos, Cytoscape, vis-network, G6 and a custom Pixi renderer: it is the
 * only one with d3's drag-reheat built in (the simulation warms while you
 * drag, so neighbours follow like liquid) and it is light and WebKit-safe.
 *
 * Layout: you at the centre; people around you; memories cluster on the
 * people they are about, and the rest gather by topic (Projects, Goals…)
 * instead of one big star. Every open starts from a random scatter that
 * flows into place. A node you drag stays where you left it (pinned) until
 * "Reset layout". Labels never overlap; relationships are named on the
 * lines. Nothing loads until the graph is opened; it pauses when hidden.
 */

type Kind = "you" | "hub" | "person" | "pet" | "memory";
export type SelectableKind = "you" | "person" | "pet" | "memory";

export interface GraphNode extends NodeObject {
  id: string;
  kind: Kind;
  label: string;
  type?: string;
  weight: number;
  shadow?: boolean;
  relationship?: string | null;
}

interface GraphLink extends LinkObject<GraphNode> {
  kind: "you" | "relation" | "about" | "topic" | "hub";
  label?: string;
}

const PINS_KEY = "mercury.brain.graph.pins.v2";
const TYPE_COLORS: Record<string, string> = {
  fact: "#7E8FA3", preference: "#D4A72C", trait: "#9B7BD8", situation: "#4FA6C8", relationship: "#E07BA8",
  goal: "#3FB37F", project: "#8B7CF6", episode: "#6C8EF0", identity: "#2BB5C9", habit: "#E8894A", decision: "#4C8FD6", constraint: "#E06B6B", reflection: "#3BA99C",
};
const HUB_LABEL: Record<string, string> = {
  fact: "Facts", preference: "Preferences", trait: "Traits", situation: "Situations", relationship: "Relationships", goal: "Goals", project: "Projects",
  episode: "Moments", identity: "Identity", habit: "Habits", decision: "Decisions", constraint: "Constraints", reflection: "Reflections",
};

type Show = "all" | "people" | "memories";

export function BrainGraph({ visible, onSelect, selectedId }: { visible: boolean; onSelect: (node: { id: string; kind: SelectableKind } | null) => void; selectedId: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraph<GraphNode, GraphLink> | null>(null);
  const hoverCard = useNoteHoverCard(graph, host);
  const [data, setData] = useState<BrainGraphData | null>(null);
  const [limit, setLimit] = useState(300);
  const [show, setShow] = useState<Show>("all");
  const [shadows, setShadows] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [find, setFind] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const hover = useRef<GraphNode | null>(null);
  const adjacency = useRef<Map<string, Set<string>>>(new Map());
  const labelsDrawn = useRef<Array<[number, number, number, number]>>([]);
  const matches = useRef<Set<string>>(new Set());
  const resolved = useTheme((s) => s.resolved);
  const dark = useRef(resolved === "dark");
  dark.current = resolved === "dark";
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const load = useCallback(async (n: number, withShadows: boolean) => {
    setLoading(true);
    setError(null);
    try { setData(await brain.graph(n, withShadows)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }, []);

  // Lazy: nothing is fetched until the graph is first shown.
  const requested = useRef(false);
  useEffect(() => {
    if (visible && !requested.current) { requested.current = true; void load(limit, shadows); }
  }, [visible, limit, shadows, load]);

  const graphData = useMemo(() => (data ? toGraph(data, show) : null), [data, show]);
  const lastData = useRef<typeof graphData>(null);

  function setGraph(g: ForceGraph<GraphNode, GraphLink>, next: NonNullable<typeof graphData>) {
    lastData.current = next;
    adjacency.current = buildAdjacency(next.links);
    g.graphData(place(next, g.graphData().nodes));
  }

  // Build the engine once (dynamic import keeps it out of the main bundle).
  useEffect(() => {
    if (!visible || !graphData || graph.current || !host.current) return;
    let disposed = false;
    void import("force-graph").then(({ default: ForceGraphCtor }) => {
      if (disposed || !host.current || graph.current) return;
      const el = host.current;
      const g = new ForceGraphCtor<GraphNode, GraphLink>(el)
        .width(el.clientWidth)
        .height(el.clientHeight)
        .backgroundColor("rgba(0,0,0,0)")
        .nodeId("id")
        .minZoom(0.15)
        .maxZoom(10)
        // Fluid: low friction, slow cooling, and a random start that flows into place.
        .d3VelocityDecay(0.3)
        .d3AlphaDecay(0.0228)
        .warmupTicks(0)
        .cooldownTicks(600)
        .linkColor((l) => linkColor(l))
        .linkWidth((l) => (isLit(l) ? 1.8 : l.kind === "relation" || l.kind === "you" ? 1.1 : 0.6))
        .linkCanvasObjectMode(() => "after")
        .linkCanvasObject((l, ctx, scale) => drawLinkLabel(l, ctx, scale))
        .nodeCanvasObject((node, ctx, scale) => drawNode(node, ctx, scale))
        .nodePointerAreaPaint((node, color, ctx) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x ?? 0, node.y ?? 0, radius(node) + 4, 0, 2 * Math.PI); ctx.fill(); })
        .onRenderFramePre(() => { labelsDrawn.current = []; })
        .onZoom(({ k }) => setZoomPct(Math.round(k * 100)))
        .onRenderFramePost(() => hoverCard.place())
        .onNodeHover((node) => {
          hover.current = node ?? null;
          el.style.cursor = node ? "pointer" : "grab";
          const memory = node?.kind === "memory" ? node : null;
          hoverCard.hover(memory, memory ? { text: memory.label, label: memory.type } : null);
        })
        .onNodeClick((node) => {
          if (node.kind === "hub") { g.centerAt(node.x, node.y, 500); g.zoom(Math.max(g.zoom(), 1.6), 500); return; }
          onSelectRef.current({ id: node.id, kind: node.kind });
          g.centerAt(node.x, node.y, 500);
        })
        .onBackgroundClick(() => onSelectRef.current(null))
        // Pinned where you leave it; d3 already warms the simulation while you drag.
        .onNodeDragEnd((node) => {
          node.fx = node.x;
          node.fy = node.y;
          savePin(node);
        });

      g.d3Force("charge")?.strength?.((n: GraphNode) => CHARGE[n.kind]).distanceMax?.(520);
      g.d3Force("link")
        ?.distance?.((l: GraphLink) => LINK_DISTANCE[l.kind])
        .strength?.((l: GraphLink) => LINK_STRENGTH[l.kind]);
      g.d3Force("collide", forceCollide<GraphNode>((n) => radius(n) + (n.kind === "memory" ? 2 : 6)).strength(0.8).iterations(1));
      g.d3Force("x", forceX<GraphNode>(0).strength(0.035));
      g.d3Force("y", forceY<GraphNode>(0).strength(0.035));

      graph.current = g;
      setGraph(g, graphData);
      setTimeout(() => { if (graph.current === g) g.zoomToFit(700, 80); }, 1600);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, graphData]);

  // New data or filter: swap it in, keeping where everything already is.
  useEffect(() => {
    const g = graph.current;
    if (!g || !graphData || lastData.current === graphData) return;
    setGraph(g, graphData);
  }, [graphData]);

  // Pause when hidden: no frames, no CPU.
  useEffect(() => {
    const g = graph.current;
    if (!g) return;
    if (visible) g.resumeAnimation();
    else g.pauseAnimation();
  }, [visible]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (el.clientWidth && el.clientHeight) graph.current?.width(el.clientWidth).height(el.clientHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => { graph.current?._destructor(); graph.current = null; }, []);

  // Theme or selection changed: one redraw (the canvas only repaints on change).
  useEffect(() => { const g = graph.current; if (g) g.nodeCanvasObject(g.nodeCanvasObject()); }, [resolved, selectedId]);

  // Find: highlight matches; Enter flies to the first one.
  useEffect(() => {
    const q = find.trim().toLowerCase();
    const g = graph.current;
    matches.current = new Set(q.length < 2 || !g ? [] : g.graphData().nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id));
    setMatchCount(matches.current.size);
    if (g) g.nodeCanvasObject(g.nodeCanvasObject());
  }, [find]);
  function flyToMatch() {
    const g = graph.current;
    if (!g) return;
    const n = g.graphData().nodes.find((x) => matches.current.has(x.id));
    if (!n) return;
    g.centerAt(n.x, n.y, 600);
    g.zoom(Math.max(2.2, g.zoom()), 600);
    if (n.kind !== "hub") onSelectRef.current({ id: n.id, kind: n.kind });
  }

  function zoomBy(f: number) {
    const g = graph.current;
    if (g) g.zoom(Math.min(10, Math.max(0.15, g.zoom() * f)), 250);
  }

  function resetLayout() {
    const g = graph.current;
    if (!g) return;
    clearPins();
    scatter(g.graphData().nodes, true);
    g.d3ReheatSimulation();
    setTimeout(() => g.zoomToFit(700, 80), 1600);
  }

  // Keyboard: + / - / 0 zoom while the graph is on screen.
  useEffect(() => {
    if (!visible) return;
    const onKey = zoomKeys(zoomBy, () => graph.current?.zoomToFit(500, 80));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  const counts = data ? { people: data.persons.length, memories: data.memories.length, links: data.memoryPersons.length + data.relationships.length } : null;

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={host} className="absolute inset-0" style={{ cursor: "grab" }} />
      {hoverCard.card}

      <div className="pointer-events-none absolute left-4 right-4 top-3 flex flex-wrap items-center gap-2">
        <div className="pointer-events-auto"><Segmented value={show} onChange={setShow} options={[{ value: "all", label: "Everything" }, { value: "people", label: "People" }, { value: "memories", label: "Memories" }]} /></div>
        <div className="pointer-events-auto flex h-8 items-center rounded-md bg-surface/85 px-2.5 text-xs text-ink2 backdrop-blur">
          <Switch checked={shadows} onCheckedChange={(v) => { setShadows(v); void load(limit, v); }} label="Shadows" />
        </div>
        <div className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface/85 px-2 backdrop-blur">
          <Search size={13} className="text-ink4" />
          <input value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") flyToMatch(); if (e.key === "Escape") setFind(""); }}
            placeholder="Find in graph" className="w-[150px] bg-transparent text-xs text-ink placeholder:text-ink4" aria-label="Find in graph" />
          {find.trim().length > 1 && <span className="text-2xs text-ink4">{matchCount}</span>}
        </div>
        {counts && <span className="rounded-md bg-surface/80 px-2 py-1 text-xs text-ink3 backdrop-blur">{counts.people} people · {counts.memories} memories · {counts.links} links</span>}
        <span className="flex-1" />
        {data && data.memories.length >= limit && limit < 2000 && (
          <Button className="pointer-events-auto" size="sm" variant="outline" onClick={() => { const next = Math.min(2000, limit * 2); setLimit(next); void load(next, shadows); }}>Load more</Button>
        )}
        <Tooltip label="Reload" side="bottom">
          <Button className="pointer-events-auto" size="sm" variant="ghost" icon onClick={() => void load(limit, shadows)} loading={loading} aria-label="Reload"><RefreshCw size={14} /></Button>
        </Tooltip>
      </div>

      <ZoomPanel zoomPct={zoomPct} onZoom={zoomBy} onFit={() => graph.current?.zoomToFit(500, 80)} onReset={resetLayout} />

      {!data && !error && <div className="absolute inset-0 flex items-center justify-center text-ink3"><Spinner size={20} /></div>}
      {error && <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-ink3">Couldn't load the brain: {error}</div>}
      {data && data.memories.length === 0 && data.persons.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-sm text-ink3">Nothing in the brain yet.</div>}
      <Legend />
    </div>
  );

  // ── drawing ──────────────────────────────────────────────────────────────

  function near(id: string): boolean {
    const h = hover.current;
    return !!h && (h.id === id || !!adjacency.current.get(h.id)?.has(id));
  }

  function isLit(l: GraphLink): boolean {
    const h = hover.current;
    return !!h && (endId(l.source) === h.id || endId(l.target) === h.id);
  }

  function linkColor(l: GraphLink): string {
    const d = dark.current;
    if (isLit(l)) return d ? "rgba(52,225,161,0.9)" : "rgba(26,158,110,0.9)";
    const f = hover.current ? 0.35 : 1;
    if (l.kind === "relation") return d ? `rgba(240,140,185,${0.7 * f})` : `rgba(200,80,140,${0.6 * f})`;
    if (l.kind === "you") return d ? `rgba(127,216,232,${0.45 * f})` : `rgba(14,124,140,${0.4 * f})`;
    if (l.kind === "hub") return d ? `rgba(230,234,237,${0.18 * f})` : `rgba(22,24,26,${0.16 * f})`;
    return d ? `rgba(230,234,237,${0.1 * f})` : `rgba(22,24,26,${0.1 * f})`;
  }

  function drawLinkLabel(l: GraphLink, ctx: CanvasRenderingContext2D, scale: number) {
    if (!l.label) return;
    if (scale < 1.1 && !isLit(l)) return;
    const s = l.source as GraphNode;
    const t = l.target as GraphNode;
    if (s.x === undefined || t.x === undefined) return;
    const x = (s.x + t.x) / 2;
    const y = ((s.y ?? 0) + (t.y ?? 0)) / 2;
    const size = 10 / scale;
    ctx.font = `500 ${size}px "Geist Variable", system-ui, sans-serif`;
    const w = ctx.measureText(l.label).width;
    if (!claim(x - w / 2, y - size / 2, w, size)) return;
    ctx.fillStyle = dark.current ? "rgba(17,19,21,0.85)" : "rgba(255,255,255,0.88)";
    ctx.fillRect(x - w / 2 - 2 / scale, y - size / 2 - 1 / scale, w + 4 / scale, size + 2 / scale);
    ctx.fillStyle = l.kind === "relation" ? (dark.current ? "#F08CB9" : "#B8437E") : (dark.current ? "#7FD8E8" : "#0E7C8C");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(l.label, x, y);
  }

  /** Reserve a label box for this frame; false when it would overlap one already drawn. */
  function claim(x: number, y: number, w: number, h: number): boolean {
    for (const [ax, ay, aw, ah] of labelsDrawn.current) {
      if (x < ax + aw && x + w > ax && y < ay + ah && y + h > ay) return false;
    }
    labelsDrawn.current.push([x, y, w, h]);
    return true;
  }

  function drawNode(n: GraphNode, ctx: CanvasRenderingContext2D, scale: number) {
    const d = dark.current;
    const r = radius(n);
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const h = hover.current;
    const finding = matches.current.size > 0;
    const dim = (h && !near(n.id)) || (finding && !matches.current.has(n.id));
    ctx.globalAlpha = dim ? 0.18 : n.shadow ? 0.55 : 1;

    const fill = colorOf(n, d);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    if (n.kind === "hub") {
      ctx.fillStyle = d ? "rgba(17,19,21,0.9)" : "rgba(255,255,255,0.95)";
      ctx.fill();
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = fill;
      ctx.stroke();
    } else if (n.shadow) {
      ctx.setLineDash([2 / scale, 2 / scale]);
      ctx.lineWidth = 1.4 / scale;
      ctx.strokeStyle = fill;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (selectedRef.current === n.id || matches.current.has(n.id)) {
      ctx.beginPath();
      ctx.arc(x, y, r + 3 / scale, 0, 2 * Math.PI);
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = d ? "#fff" : "#111";
      ctx.stroke();
    }
    // A small dot marks a node you pinned by dragging.
    if (n.fx !== undefined && n.kind !== "you") {
      ctx.beginPath();
      ctx.arc(x + r * 0.75, y - r * 0.75, Math.max(1.2 / scale, 2 / scale), 0, 2 * Math.PI);
      ctx.fillStyle = d ? "#F5C451" : "#A0620A";
      ctx.fill();
    }

    // Labels: you and topics always; people once readable; memories when zoomed in or near the pointer.
    const lit = h?.id === n.id || near(n.id) || selectedRef.current === n.id || matches.current.has(n.id);
    const want = n.kind === "you" || n.kind === "hub" || ((n.kind === "person" || n.kind === "pet") && scale > 0.45) || (n.kind === "memory" && (scale > 2.2 || lit));
    if (want && !dim) {
      const px = n.kind === "memory" ? 10.5 : n.kind === "hub" || n.kind === "you" ? 12.5 : 12;
      const size = px / scale;
      ctx.font = `${n.kind === "memory" ? 400 : 600} ${size}px "Geist Variable", system-ui, sans-serif`;
      const text = n.kind === "memory" ? shortLabel(n.label) : n.label;
      const w = ctx.measureText(text).width;
      const ty = y + r + 2 / scale;
      const free = lit || n.kind === "you" ? (labelsDrawn.current.push([x - w / 2, ty, w, size]), true) : claim(x - w / 2, ty, w, size);
      if (free) {
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
}

// ── data → graph ───────────────────────────────────────────────────────────

const CHARGE: Record<Kind, number> = { you: -700, hub: -320, person: -240, pet: -240, memory: -34 };
const LINK_DISTANCE: Record<GraphLink["kind"], number> = { you: 120, hub: 170, relation: 80, about: 42, topic: 46 };
const LINK_STRENGTH: Record<GraphLink["kind"], number> = { you: 0.35, hub: 0.5, relation: 0.45, about: 0.75, topic: 0.7 };

export function toGraph(d: BrainGraphData, show: Show): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = [{ id: "you", kind: "you", label: "You", weight: 10 }];
  const links: GraphLink[] = [];
  const withPeople = show !== "memories";
  const withMemories = show !== "people";
  const people: GraphNode[] = [];
  const hubs = new Map<string, GraphNode>();
  const mems: GraphNode[] = [];

  if (withPeople) {
    for (const p of d.persons) {
      const rel = p.relationship && p.relationship !== "known" ? p.relationship : null;
      people.push({ id: p.id, kind: p.kind === "pet" ? "pet" : "person", label: p.name, weight: p.memoryCount, relationship: rel, shadow: p.tier === "shadow" });
      links.push({ source: "you", target: p.id, kind: "you", label: rel ?? undefined });
    }
    for (const r of d.relationships) links.push({ source: r.source, target: r.target, kind: "relation", label: r.type });
  }
  if (withMemories) {
    const shownPeople = new Set(people.map((p) => p.id));
    const about = withPeople ? d.memoryPersons.filter((l) => shownPeople.has(l.personId)) : [];
    const linked = new Set(about.map((l) => l.memoryId));
    for (const m of d.memories) {
      mems.push({ id: m.id, kind: "memory", label: m.summary, type: m.type, weight: m.importance });
      if (linked.has(m.id)) continue;
      // Not about anyone shown: gather by topic, so the brain reads as clusters, not one star.
      const hubId = `hub:${m.type}`;
      let hub = hubs.get(hubId);
      if (!hub) {
        hub = { id: hubId, kind: "hub", label: HUB_LABEL[m.type] ?? m.type, type: m.type, weight: 0 };
        hubs.set(hubId, hub);
        links.push({ source: "you", target: hubId, kind: "hub" });
      }
      hub.weight += 1;
      links.push({ source: m.id, target: hubId, kind: "topic" });
    }
    for (const l of about) links.push({ source: l.memoryId, target: l.personId, kind: "about" });
  }
  for (const h of hubs.values()) h.label = `${h.label} · ${h.weight}`;
  // Draw order is label priority: you, topics, people, then memories.
  nodes.push(...hubs.values(), ...people, ...mems);
  return { nodes, links };
}

function radius(n: GraphNode): number {
  if (n.kind === "you") return 11;
  if (n.kind === "hub") return 6 + Math.min(8, Math.sqrt(n.weight) * 1.2);
  if (n.kind === "memory") return 2.4 + Math.min(2.6, n.weight * 2.6);
  return 4.5 + Math.min(7, Math.sqrt(n.weight) * 1.3);
}

function colorOf(n: GraphNode, dark: boolean): string {
  if (n.kind === "you") return dark ? "#34E1A1" : "#1A9E6E";
  if (n.kind === "person") return dark ? "#7FD8E8" : "#0E7C8C";
  if (n.kind === "pet") return dark ? "#F5C451" : "#B7791F";
  return TYPE_COLORS[n.type ?? ""] ?? "#8A97A3";
}

function endId(e: string | number | GraphNode | undefined): string {
  return typeof e === "object" && e ? String(e.id) : String(e ?? "");
}

function buildAdjacency(links: GraphLink[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (a: string, b: string) => { let s = m.get(a); if (!s) { s = new Set(); m.set(a, s); } s.add(b); };
  for (const l of links) { const s = endId(l.source); const t = endId(l.target); add(s, t); add(t, s); }
  return m;
}

// ── placement: random start, pins kept for the session ─────────────────────

function readPins(): Record<string, [number, number]> {
  try { return JSON.parse(sessionStorage.getItem(PINS_KEY) ?? "{}") as Record<string, [number, number]>; } catch { return {}; }
}

function savePin(n: GraphNode) {
  try {
    const pins = readPins();
    pins[n.id] = [Math.round(n.x ?? 0), Math.round(n.y ?? 0)];
    sessionStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch { /* storage blocked: the pin still holds until reload */ }
}

function clearPins() {
  try { sessionStorage.removeItem(PINS_KEY); } catch { /* ignore */ }
}

/** Random scatter around the centre, so every fresh layout flows in from a new start. */
function scatter(nodes: GraphNode[], unpin: boolean) {
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  for (const n of nodes) {
    if (n.kind === "you") { n.x = 0; n.y = 0; n.fx = 0; n.fy = 0; n.vx = 0; n.vy = 0; continue; }
    if (unpin) { n.fx = undefined; n.fy = undefined; }
    const angle = rnd(0, Math.PI * 2);
    const dist = n.kind === "hub" ? rnd(160, 260) : n.kind === "memory" ? rnd(120, 420) : rnd(70, 220);
    n.x = Math.cos(angle) * dist;
    n.y = Math.sin(angle) * dist;
    n.vx = 0;
    n.vy = 0;
  }
}

/** Keep live positions, apply pins, scatter the rest at random. "You" sits fixed at the centre. */
function place(g: { nodes: GraphNode[]; links: GraphLink[] }, live: GraphNode[]): { nodes: GraphNode[]; links: GraphLink[] } {
  const pins = readPins();
  const current = new Map(live.map((n) => [n.id, n]));
  const fresh: GraphNode[] = [];
  const nodes = g.nodes.map((n) => {
    const c = current.get(n.id);
    const pin = pins[n.id];
    if (n.kind === "you") return { ...n, x: 0, y: 0, fx: 0, fy: 0 };
    if (pin) return { ...n, x: pin[0], y: pin[1], fx: pin[0], fy: pin[1] };
    if (c?.x !== undefined) return { ...n, x: c.x, y: c.y, vx: c.vx, vy: c.vy, fx: c.fx, fy: c.fy };
    const copy = { ...n };
    fresh.push(copy);
    return copy;
  });
  scatter(fresh, false);
  return { nodes, links: g.links.map((l) => ({ ...l, source: endId(l.source), target: endId(l.target) })) };
}

function Legend() {
  const items: Array<[string, string]> = [["You", "bg-accent"], ["Person", "bg-cyan"], ["Pet", "bg-amber"]];
  return (
    <div className="pointer-events-none absolute bottom-3 left-4 flex flex-wrap items-center gap-3 rounded-md bg-surface/85 px-2.5 py-1.5 text-xs text-ink3 backdrop-blur">
      {items.map(([label, cls]) => <span key={label} className="flex items-center gap-1.5"><span className={cx("block h-2.5 w-2.5 rounded-full", cls)} />{label}</span>)}
      <span className="flex items-center gap-1.5"><span className="block h-2.5 w-2.5 rounded-full border border-dashed border-cyan" />Shadow</span>
      <span className="flex items-center gap-1.5"><span className="block h-2.5 w-2.5 rounded-full border-2 border-ink3" />Topic</span>
      <span className="text-ink4">· drag to pin · scroll or +/− to zoom · click for details</span>
    </div>
  );
}
