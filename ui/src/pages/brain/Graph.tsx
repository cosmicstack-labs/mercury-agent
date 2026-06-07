import { useEffect, useRef, useState, useCallback } from "react";
import { Network, Search, Loader2 } from "lucide-react";
import api, { type GraphNode, type GraphEdge } from "@/lib/api";

// ── Node type color map ──
const TYPE_COLORS: Record<string, string> = {
  fact: "#3b82f6",
  preference: "#a78bfa",
  experience: "#22c55e",
  goal: "#f59e0b",
  project: "#00d4ff",
  person: "#ec4899",
  skill: "#6366f1",
  belief: "#f97316",
  observation: "#14b8a6",
  default: "#6b7280",
};

function getTypeColor(type: string): string {
  return TYPE_COLORS[type] || TYPE_COLORS.default;
}

// ── Internal layout types ──
interface NodePos {
  x: number;
  y: number;
}

interface NodeVelocity {
  seed: number;
  freq: number;
  amp: number;
}

interface TooltipInfo {
  x: number;
  y: number;
  node: GraphNode;
  connections: number;
}

function isDarkMode(): boolean {
  return (
    document.documentElement.classList.contains("dark") ||
    document.documentElement.getAttribute("data-theme") !== "light"
  );
}

export function GraphPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(true);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);

  // Mutable refs for canvas state (avoid re-renders during animation)
  const stateRef = useRef({
    nodes: [] as GraphNode[],
    edges: [] as GraphEdge[],
    positions: new Map<string, NodePos>(),
    anchors: new Map<string, NodePos>(),
    velocities: new Map<string, NodeVelocity>(),
    pan: { x: 0, y: 0 },
    zoom: 1,
    dragging: false,
    dragNode: null as GraphNode | null,
    hoveredNode: null as GraphNode | null,
    selectedNode: null as GraphNode | null,
    lastMouse: { x: 0, y: 0 },
    searchQuery: "",
    animFrame: 0,
    dpr: 1,
  });

  // Keep searchQuery in sync with ref
  useEffect(() => {
    stateRef.current.searchQuery = searchQuery;
  }, [searchQuery]);

  // ── Connection count helper ──
  const connectionCount = useCallback((nodeId: string, edgeList: GraphEdge[]) => {
    let count = 0;
    for (const e of edgeList) {
      if (e.source === nodeId || e.target === nodeId) count++;
    }
    return count;
  }, []);

  // ── Init positions in a circle ──
  const initPositions = useCallback(
    (nodeList: GraphNode[], canvasW: number, canvasH: number) => {
      const s = stateRef.current;
      const cx = canvasW / 2;
      const cy = canvasH / 2;
      s.positions.clear();
      s.anchors.clear();
      s.velocities.clear();

      nodeList.forEach((node, i) => {
        const angle = (i / nodeList.length) * Math.PI * 2;
        const r = 150 + Math.random() * 100;
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        s.positions.set(node.id, { x, y });
        s.anchors.set(node.id, { x, y });
        s.velocities.set(node.id, {
          seed: Math.random(),
          freq: 0.00009 + Math.random() * 0.00007,
          amp: 0.25 + Math.random() * 0.25,
        });
      });
    },
    []
  );

  // ── Force-directed layout (80 iterations) ──
  const runLayout = useCallback(
    (nodeList: GraphNode[], edgeList: GraphEdge[], w: number, h: number) => {
      const s = stateRef.current;
      const iters = 80;

      for (let iter = 0; iter < iters; iter++) {
        const area = w * h;
        const k = Math.sqrt(area / Math.max(1, nodeList.length));
        const repForce = k * k;
        const attForce = 0.01;
        const forces = new Map<string, { fx: number; fy: number }>();
        nodeList.forEach((n) => forces.set(n.id, { fx: 0, fy: 0 }));

        // Repulsion (Coulomb)
        for (let i = 0; i < nodeList.length; i++) {
          for (let j = i + 1; j < nodeList.length; j++) {
            const pi = s.positions.get(nodeList[i].id);
            const pj = s.positions.get(nodeList[j].id);
            if (!pi || !pj) continue;
            const dx = pi.x - pj.x;
            const dy = pi.y - pj.y;
            const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
            const f = repForce / (dist * dist);
            const fx = (dx / dist) * f;
            const fy = (dy / dist) * f;
            forces.get(nodeList[i].id)!.fx += fx;
            forces.get(nodeList[i].id)!.fy += fy;
            forces.get(nodeList[j].id)!.fx -= fx;
            forces.get(nodeList[j].id)!.fy -= fy;
          }
        }

        // Attraction (Hooke) along edges
        edgeList.forEach((e) => {
          const ps = s.positions.get(e.source);
          const pt = s.positions.get(e.target);
          if (!ps || !pt) return;
          const dx = pt.x - ps.x;
          const dy = pt.y - ps.y;
          const fs = forces.get(e.source);
          const ft = forces.get(e.target);
          if (fs) {
            fs.fx += dx * attForce;
            fs.fy += dy * attForce;
          }
          if (ft) {
            ft.fx -= dx * attForce;
            ft.fy -= dy * attForce;
          }
        });

        // Center gravity
        const cx = w / 2;
        const cy = h / 2;
        const gravity = 0.001;
        nodeList.forEach((n) => {
          const p = s.positions.get(n.id);
          const f = forces.get(n.id);
          if (!p || !f) return;
          f.fx += (cx - p.x) * gravity;
          f.fy += (cy - p.y) * gravity;
        });

        // Apply with damping
        const damp = 0.1;
        nodeList.forEach((n) => {
          const f = forces.get(n.id);
          const p = s.positions.get(n.id);
          if (!f || !p) return;
          p.x += f.fx * damp;
          p.y += f.fy * damp;
        });
      }

      // Sync anchors
      nodeList.forEach((n) => {
        const p = s.positions.get(n.id);
        const a = s.anchors.get(n.id);
        if (p && a) {
          a.x = p.x;
          a.y = p.y;
        }
      });
    },
    []
  );

  // ── Resize canvas with DPR ──
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    stateRef.current.dpr = dpr;
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }, []);

  // ── Screen → graph coordinate transform ──
  const screenToGraph = useCallback(
    (sx: number, sy: number): { x: number; y: number } => {
      const s = stateRef.current;
      const dpr = s.dpr;
      return {
        x: (sx * dpr - s.pan.x) / s.zoom,
        y: (sy * dpr - s.pan.y) / s.zoom,
      };
    },
    []
  );

  // ── Hit test ──
  const findNodeAt = useCallback(
    (gx: number, gy: number): GraphNode | null => {
      const s = stateRef.current;
      for (let i = s.nodes.length - 1; i >= 0; i--) {
        const n = s.nodes[i];
        const p = s.positions.get(n.id);
        if (!p) continue;
        const r = (n.size || 8) * 1.5;
        const dx = gx - p.x;
        const dy = gy - p.y;
        if (dx * dx + dy * dy < r * r) return n;
      }
      return null;
    },
    []
  );

  // ── Draw ──
  const draw = useCallback((ts: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const s = stateRef.current;
    const dpr = s.dpr;
    const w = canvas.width;
    const h = canvas.height;
    const dark = isDarkMode();

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = dark ? "#0a0e14" : "#ffffff";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(s.pan.x, s.pan.y);
    ctx.scale(s.zoom, s.zoom);

    // Focus neighborhood
    const focus = s.hoveredNode || s.selectedNode;
    const neighbors = new Set<string>();
    const activeEdgeIdx = new Set<number>();
    if (focus) {
      s.edges.forEach((e, i) => {
        if (e.source === focus.id) {
          neighbors.add(e.target);
          activeEdgeIdx.add(i);
        }
        if (e.target === focus.id) {
          neighbors.add(e.source);
          activeEdgeIdx.add(i);
        }
      });
      neighbors.add(focus.id);
    }

    // ── Edges ──
    s.edges.forEach((e, i) => {
      const ps = s.positions.get(e.source);
      const pt = s.positions.get(e.target);
      if (!ps || !pt) return;

      const active = activeEdgeIdx.has(i);
      if (active) {
        ctx.strokeStyle = dark
          ? "rgba(0,212,255,0.7)"
          : "rgba(0,136,170,0.6)";
        ctx.lineWidth = (2 * dpr) / s.zoom;
      } else if (focus) {
        ctx.strokeStyle = dark
          ? "rgba(0,212,255,0.06)"
          : "rgba(0,136,170,0.05)";
        ctx.lineWidth = (0.6 * dpr) / s.zoom;
      } else {
        const pulse = (Math.sin(ts * 0.00022 + i * 1.3) + 1) * 0.5;
        const alpha = (dark ? 0.16 : 0.13) + pulse * 0.06;
        ctx.strokeStyle = dark
          ? `rgba(0,212,255,${alpha.toFixed(3)})`
          : `rgba(0,136,170,${alpha.toFixed(3)})`;
        ctx.lineWidth = ((0.7 + pulse * 0.3) * dpr) / s.zoom;
      }

      ctx.beginPath();
      ctx.moveTo(ps.x, ps.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
    });

    // ── Nodes ──
    const searchQ = s.searchQuery.toLowerCase();
    const showLabels = s.zoom > 0.7 || s.nodes.length < 500;

    s.nodes.forEach((n) => {
      const p = s.positions.get(n.id);
      if (!p) return;

      const isHovered = s.hoveredNode?.id === n.id;
      const isSelected = s.selectedNode?.id === n.id;
      const isNeighbor = neighbors.has(n.id);

      const v = s.velocities.get(n.id);
      const breathe =
        1 + Math.sin(ts * 0.00035 + (v?.seed ?? 0) * 11.7) * 0.01;
      const baseR = (n.size || 8) * dpr;
      const r = baseR * (isHovered || isSelected ? 1.4 : breathe);

      // Alpha based on search / focus
      let alpha = 1;
      if (searchQ) {
        alpha = n.label.toLowerCase().includes(searchQ) ? 1 : 0.12;
      } else if (focus) {
        alpha = isHovered || isSelected || isNeighbor ? 1 : 0.18;
      }
      ctx.globalAlpha = alpha;

      // Glow
      if (isHovered || isSelected) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + (5 * dpr) / s.zoom, 0, Math.PI * 2);
        ctx.fillStyle = dark
          ? "rgba(0,212,255,0.14)"
          : "rgba(0,136,170,0.12)";
        ctx.fill();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = getTypeColor(n.type);
      ctx.fill();

      // Stroke
      if (isHovered || isSelected) {
        ctx.strokeStyle = dark ? "#f0f0f0" : "#1a1a1a";
        ctx.lineWidth = (2 * dpr) / s.zoom;
        ctx.stroke();
      } else if (isNeighbor && focus) {
        ctx.strokeStyle = dark
          ? "rgba(0,212,255,0.65)"
          : "rgba(0,136,170,0.55)";
        ctx.lineWidth = (1.8 * dpr) / s.zoom;
        ctx.stroke();
      }

      // Labels
      if (showLabels || isHovered || isSelected) {
        const fontSize = Math.max(10 * dpr, (11 * dpr) / s.zoom);
        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = dark
          ? `rgba(240,240,240,${alpha})`
          : `rgba(20,20,20,${alpha})`;
        ctx.fillText(n.label, p.x, p.y + r + 4 * dpr);
      }

      ctx.globalAlpha = 1;
    });

    ctx.restore();
  }, []);

  // ── Motion update (breathing drift) ──
  const updateMotion = useCallback((ts: number) => {
    const s = stateRef.current;
    s.nodes.forEach((n) => {
      if (s.dragNode?.id === n.id) return;
      const p = s.positions.get(n.id);
      const a = s.anchors.get(n.id);
      const v = s.velocities.get(n.id);
      if (!p || !a || !v) return;
      p.x = a.x + Math.sin(ts * v.freq + v.seed * 11.1) * v.amp;
      p.y = a.y + Math.cos(ts * v.freq * 0.87 + v.seed * 17.3) * v.amp;
    });
  }, []);

  // ── Mouse handlers ──
  const onMouseDown = useCallback(
    (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const gp = screenToGraph(sx, sy);
      const node = findNodeAt(gp.x, gp.y);
      const s = stateRef.current;

      if (node) {
        s.dragNode = node;
      } else {
        s.dragging = true;
      }
      s.lastMouse = { x: e.clientX, y: e.clientY };
    },
    [screenToGraph, findNodeAt]
  );

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const s = stateRef.current;

      if (s.dragNode) {
        const gp = screenToGraph(sx, sy);
        const p = s.positions.get(s.dragNode.id);
        const a = s.anchors.get(s.dragNode.id);
        if (p) {
          p.x = gp.x;
          p.y = gp.y;
        }
        if (a) {
          a.x = gp.x;
          a.y = gp.y;
        }
      } else if (s.dragging) {
        const dpr = s.dpr;
        s.pan.x += (e.clientX - s.lastMouse.x) * dpr;
        s.pan.y += (e.clientY - s.lastMouse.y) * dpr;
      } else {
        const gp = screenToGraph(sx, sy);
        const node = findNodeAt(gp.x, gp.y);
        if (node !== s.hoveredNode) {
          s.hoveredNode = node;
          if (node) {
            setTooltip({
              x: e.clientX - rect.left + 14,
              y: e.clientY - rect.top + 14,
              node,
              connections: connectionCount(node.id, s.edges),
            });
          } else {
            setTooltip(null);
          }
        } else if (node && tooltip) {
          setTooltip((prev) =>
            prev
              ? {
                  ...prev,
                  x: e.clientX - rect.left + 14,
                  y: e.clientY - rect.top + 14,
                }
              : null
          );
        }
      }
      s.lastMouse = { x: e.clientX, y: e.clientY };
    },
    [screenToGraph, findNodeAt, connectionCount, tooltip]
  );

  const onMouseUp = useCallback(() => {
    const s = stateRef.current;
    s.dragNode = null;
    s.dragging = false;
  }, []);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const s = stateRef.current;
      const delta = e.deltaY > 0 ? 0.92 : 1.08;
      const newZoom = Math.min(3.0, Math.max(0.3, s.zoom * delta));
      const scaleFactor = newZoom / s.zoom;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * s.dpr;
      const my = (e.clientY - rect.top) * s.dpr;

      s.pan.x = mx - (mx - s.pan.x) * scaleFactor;
      s.pan.y = my - (my - s.pan.y) * scaleFactor;
      s.zoom = newZoom;
    },
    []
  );

  const onDblClick = useCallback(
    (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const gp = screenToGraph(
        e.clientX - rect.left,
        e.clientY - rect.top
      );
      const node = findNodeAt(gp.x, gp.y);
      stateRef.current.selectedNode = node;
    },
    [screenToGraph, findNodeAt]
  );

  // ── Main effect: fetch, layout, animate ──
  useEffect(() => {
    let cancelled = false;

    async function init() {
      setLoading(true);
      try {
        const data = await api.brain.graph();
        if (cancelled) return;
        const n = data.nodes || [];
        const e = data.edges || [];
        setNodes(n);
        setEdges(e);

        const s = stateRef.current;
        s.nodes = n;
        s.edges = e;

        resizeCanvas();
        const canvas = canvasRef.current;
        const cw = canvas ? canvas.width : 800;
        const ch = canvas ? canvas.height : 600;

        initPositions(n, cw, ch);
        runLayout(n, e, cw, ch);
      } catch (err) {
        console.error("Failed to load graph data:", err);
      }
      if (!cancelled) setLoading(false);
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [initPositions, runLayout, resizeCanvas]);

  // ── Animation loop + event listeners ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || loading) return;

    resizeCanvas();

    // Animation loop
    let running = true;
    const loop = (ts: number) => {
      if (!running) return;
      updateMotion(ts);
      draw(ts);
      stateRef.current.animFrame = requestAnimationFrame(loop);
    };
    stateRef.current.animFrame = requestAnimationFrame(loop);

    // Event listeners
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mouseleave", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDblClick);

    const handleResize = () => {
      resizeCanvas();
    };
    window.addEventListener("resize", handleResize);

    return () => {
      running = false;
      cancelAnimationFrame(stateRef.current.animFrame);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("mouseleave", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("resize", handleResize);
    };
  }, [
    loading,
    resizeCanvas,
    updateMotion,
    draw,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onWheel,
    onDblClick,
  ]);

  // ── Legend entries ──
  const legendEntries = nodes.length
    ? [...new Set(nodes.map((n) => n.type))].sort()
    : [];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 bg-background/80 px-6 py-4 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#00d4ff]/10">
            <Network className="h-5 w-5 text-[#00d4ff]" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Knowledge Graph
            </h1>
            <p className="text-xs text-muted-foreground">
              Visualize connections in Mercury&apos;s memory
            </p>
          </div>
        </div>
      </div>

      {/* Canvas area */}
      <div
        ref={containerRef}
        className="relative flex-1"
        style={{ minHeight: 500 }}
      >
        {loading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/60 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-[#00d4ff]" />
              <span className="text-sm text-muted-foreground">
                Loading knowledge graph...
              </span>
            </div>
          </div>
        )}

        {!loading && nodes.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-center">
              <Network className="h-12 w-12 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                No knowledge graph data available yet
              </p>
            </div>
          </div>
        )}

        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full cursor-crosshair"
        />

        {/* Search overlay */}
        <div className="absolute right-4 top-4 z-10">
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/90 px-3 py-1.5 shadow-lg backdrop-blur-sm">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search nodes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-48 border-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
            />
          </div>
        </div>

        {/* Legend overlay */}
        {legendEntries.length > 0 && (
          <div className="absolute bottom-4 left-4 z-10 rounded-lg border border-border/60 bg-background/90 px-3 py-2.5 shadow-lg backdrop-blur-sm">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Node Types
            </p>
            <div className="flex flex-col gap-1">
              {legendEntries.map((type) => (
                <div key={type} className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: getTypeColor(type) }}
                  />
                  <span className="text-[11px] capitalize text-foreground/80">
                    {type}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tooltip */}
        {tooltip && (
          <div
            className="pointer-events-none absolute z-30 rounded-lg border border-border/60 bg-popover px-3 py-2 shadow-xl"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            <p className="text-sm font-medium text-foreground">
              {tooltip.node.label}
            </p>
            <div className="mt-0.5 flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: getTypeColor(tooltip.node.type) }}
              />
              <span className="text-xs capitalize text-muted-foreground">
                {tooltip.node.type}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {tooltip.connections} connection
              {tooltip.connections !== 1 ? "s" : ""}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
