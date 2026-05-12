/* ═══════════════════════════════════════════════════════════════
   Mercury Kanban — Alive Board for AI Agent Task Management
   Smart Execute · Dependencies · Comments · Attachments · Labels
   ═══════════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock,
  Columns3,
  Download,
  Eye,
  FileText,
  GitBranch,
  Image,
  Link2,
  Loader2,
  MessageSquare,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Tag,
  Trash2,
  X,
  XCircle,
  Zap,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatDate, formatTokens, truncate } from "@/lib/utils";
import api, {
  type Board,
  type BoardCard,
  type BoardResources,
  type CardComment,
  type CardAttachment,
  type CardLabel,
  type ExecutionPlan,
} from "@/lib/api";

// ── Constants ──────────────────────────────────────────────────

type CardStatus = BoardCard["status"];
type CardPriority = NonNullable<BoardCard["priority"]>;

const COLUMNS: { key: CardStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "running", label: "Running" },
  { key: "done", label: "Done" },
  { key: "failed", label: "Failed" },
];

const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  low: { label: "Low", color: "text-muted-foreground border-muted-foreground/40" },
  normal: { label: "Med", color: "text-yellow-400 border-yellow-400/40" },
  medium: { label: "Med", color: "text-yellow-400 border-yellow-400/40" },
  high: { label: "High", color: "text-orange-400 border-orange-400/40" },
  critical: { label: "Crit", color: "text-red-400 border-red-400/40" },
};

const STATUS_BORDER: Record<string, string> = {
  pending: "border-l-muted-foreground/40 border-dashed",
  running: "border-l-[#00d4ff]",
  paused: "border-l-yellow-400",
  done: "border-l-emerald-500",
  failed: "border-l-red-500",
  question: "border-l-purple-500",
};

const LABEL_PRESETS = [
  { name: "Bug", color: "#ef4444" },
  { name: "Feature", color: "#3b82f6" },
  { name: "Refactor", color: "#a78bfa" },
  { name: "Docs", color: "#10b981" },
  { name: "Test", color: "#f59e0b" },
  { name: "Urgent", color: "#dc2626" },
  { name: "Backend", color: "#06b6d4" },
  { name: "Frontend", color: "#8b5cf6" },
  { name: "DevOps", color: "#64748b" },
];

const ATTACHMENT_ICONS: Record<string, typeof FileText> = {
  markdown: FileText,
  document: FileText,
  image: Image,
  presentation: FileText,
  other: Paperclip,
};

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.05, duration: 0.3, ease: "easeOut" as const },
  }),
};

// ── Helpers ────────────────────────────────────────────────────

function useElapsed(startedAt?: string | number, active?: boolean) {
  const [elapsed, setElapsed] = useState("");
  useEffect(() => {
    if (!startedAt || !active) { setElapsed(""); return; }
    const update = () => {
      const start = typeof startedAt === "number" ? startedAt : new Date(startedAt).getTime();
      const diff = Math.max(0, Math.floor((Date.now() - start) / 1000));
      const m = Math.floor(diff / 60);
      const s = diff % 60;
      setElapsed(m > 0 ? `${m}m ${s}s` : `${s}s`);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAt, active]);
  return elapsed;
}

function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-muted", className)} />;
}

function PriorityBadge({ priority }: { priority?: string }) {
  if (!priority) return null;
  const cfg = PRIORITY_CONFIG[priority] ?? { label: priority, color: "text-muted-foreground border-muted-foreground/40" };
  return (
    <span className={cn("text-[10px] font-semibold uppercase border rounded px-1.5 py-0.5", cfg.color)}>
      {cfg.label}
    </span>
  );
}

function formatCost(tokenUsage: { input: number; output: number; total: number } | null | undefined): string {
  if (!tokenUsage) return "";
  // Rough cost estimate: $3/1M input, $15/1M output (Claude-like pricing)
  const cost = (tokenUsage.input * 3 + tokenUsage.output * 15) / 1_000_000;
  return cost < 0.01 ? `<$0.01` : `$${cost.toFixed(2)}`;
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ═══════════════════════════════════════════════════════════════
// KanbanPage — Root
// ═══════════════════════════════════════════════════════════════

export function KanbanPage() {
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);

  return selectedBoardId ? (
    <BoardDetailView boardId={selectedBoardId} onBack={() => setSelectedBoardId(null)} />
  ) : (
    <BoardListView onSelect={setSelectedBoardId} />
  );
}

// ═══════════════════════════════════════════════════════════════
// Board List View
// ═══════════════════════════════════════════════════════════════

function BoardListView({ onSelect }: { onSelect: (id: string) => void }) {
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api.boards
      .list()
      .then((d) => { setBoards(d.boards); setError(""); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      await api.boards.create({ name: createName.trim(), description: createDesc.trim() || undefined });
      setCreateOpen(false);
      setCreateName("");
      setCreateDesc("");
      load();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try { await api.boards.delete(id); load(); } catch (e: unknown) { setError((e as Error).message); }
  };

  const handleToggleActive = async (board: Board) => {
    try {
      if (board.active) await api.boards.deactivate(board.id);
      else await api.boards.activate(board.id);
      load();
    } catch (e: unknown) { setError((e as Error).message); }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Columns3 className="h-6 w-6 text-[#00d4ff]" />
          <h1 className="text-2xl font-semibold text-foreground">Kanban Boards</h1>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2 bg-[#00d4ff] text-black hover:bg-[#00d4ff]/80">
          <Plus className="h-4 w-4" /> Create Board
        </Button>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>}

      {loading && (
        <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36" />)}
        </div>
      )}

      {!loading && boards.length === 0 && !error && (
        <Card>
          <CardContent className="py-16 text-center">
            <Columns3 className="mx-auto mb-4 h-12 w-12 text-muted-foreground/40" />
            <p className="text-muted-foreground">No boards yet. Create one to get started.</p>
          </CardContent>
        </Card>
      )}

      {!loading && boards.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
          <AnimatePresence mode="popLayout">
            {boards.map((board, i) => (
              <motion.div key={board.id} custom={i} variants={fadeUp} initial="hidden" animate="visible" exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }} layout>
                <Card className="cursor-pointer transition-colors hover:border-[#00d4ff]/40" onClick={() => onSelect(board.id)}>
                  <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2">
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-base font-semibold">{board.name}</CardTitle>
                      {board.description && <p className="mt-1 text-sm text-muted-foreground">{truncate(board.description, 100)}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <Badge
                        variant={board.active ? "default" : "secondary"}
                        className={cn("cursor-pointer text-[10px]", board.active && "bg-[#00d4ff]/20 text-[#00d4ff] hover:bg-[#00d4ff]/30")}
                        onClick={() => handleToggleActive(board)}
                      >
                        {board.active ? <><Power className="mr-1 h-3 w-3" /> Active</> : <><PowerOff className="mr-1 h-3 w-3" /> Inactive</>}
                      </Badge>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete board?</AlertDialogTitle>
                            <AlertDialogDescription>This will permanently delete "{board.name}" and all its cards.</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => handleDelete(board.id)}>Delete</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span>{board.cardCount ?? board.cards?.length ?? 0} cards</span>
                      <span>{formatDate(board.createdAt)}</span>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Board</DialogTitle>
            <DialogDescription>Add a new Kanban board for organizing agent tasks.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Name</label>
              <Input placeholder="Board name" value={createName} onChange={(e) => setCreateName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleCreate()} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Description</label>
              <Textarea placeholder="Describe the project — AI will use this to generate task cards with dependencies..." value={createDesc} onChange={(e) => setCreateDesc(e.target.value)} rows={4} />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button onClick={handleCreate} disabled={!createName.trim() || creating} className="bg-[#00d4ff] text-black hover:bg-[#00d4ff]/80">
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Board Detail View (Kanban Columns)
// ═══════════════════════════════════════════════════════════════

function BoardDetailView({ boardId, onBack }: { boardId: string; onBack: () => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [resources, setResources] = useState<BoardResources | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [selectedCard, setSelectedCard] = useState<BoardCard | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [planOpen, setPlanOpen] = useState(false);
  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  const load = useCallback(async () => {
    try {
      const data = await api.boards.get(boardId);
      setBoard(data.board);
      setResources(data.resources);
      setError("");
      // Refresh selected card if open
      if (selectedCard) {
        const updated = data.board.cards?.find((c: BoardCard) => c.id === selectedCard.id);
        if (updated) setSelectedCard(updated);
      }
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [boardId, selectedCard?.id]);

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 2500);
    return () => clearInterval(pollRef.current);
  }, [boardId]); // intentionally not including load to avoid restart on selectedCard change

  const cards = useMemo(() => board?.cards ?? [], [board]);

  const columnCards = useMemo(() => {
    const map: Record<string, BoardCard[]> = { pending: [], running: [], paused: [], done: [], failed: [], question: [] };
    for (const c of cards) {
      if (map[c.status]) map[c.status].push(c);
      else map.pending.push(c); // fallback
    }
    return map;
  }, [cards]);

  const displayColumns = useMemo(() => {
    return COLUMNS.map((col) => ({
      ...col,
      cards: col.key === "pending"
        ? [...columnCards.pending, ...columnCards.paused, ...columnCards.question]
        : columnCards[col.key] ?? [],
    }));
  }, [columnCards]);

  const activeCard = useMemo(() => (activeId ? cards.find((c) => c.id === activeId) : undefined), [activeId, cards]);

  // Total token cost
  const totalCost = useMemo(() => {
    let inp = 0, out = 0;
    for (const c of cards) {
      if (c.tokenUsage) { inp += c.tokenUsage.input; out += c.tokenUsage.output; }
    }
    if (inp === 0 && out === 0) return null;
    return { input: inp, output: out, total: inp + out };
  }, [cards]);

  // Build dependency tree for display
  const cardMap = useMemo(() => {
    const m = new Map<string, BoardCard>();
    for (const c of cards) m.set(c.id, c);
    return m;
  }, [cards]);

  // ── DnD ──
  const handleDragStart = (event: DragStartEvent) => setActiveId(event.active.id as string);

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const overId = over.id as string;
    let targetStatus: CardStatus | undefined;
    const col = COLUMNS.find((c) => c.key === overId);
    if (col) targetStatus = col.key;
    else {
      const overCard = cards.find((c) => c.id === overId);
      if (overCard) targetStatus = overCard.status;
    }
    if (!targetStatus) return;
    const card = cards.find((c) => c.id === active.id);
    if (!card || card.status === targetStatus) return;
    try { await api.boards.cards.update(boardId, card.id, { status: targetStatus }); load(); } catch {}
  };

  // ── Actions ──
  const handleGenerate = async () => {
    setGenerating(true);
    try { await api.boards.generate(boardId); load(); }
    catch (e: unknown) { setError((e as Error).message); }
    finally { setGenerating(false); }
  };

  const handleSmartExecute = async () => {
    try { await api.boards.smartExecute(boardId); load(); }
    catch (e: unknown) { setError((e as Error).message); }
  };

  const handleRunAll = async () => {
    try { await api.boards.runAll(boardId); load(); }
    catch (e: unknown) { setError((e as Error).message); }
  };

  const handleClearDone = async () => {
    try { await api.boards.cards.clearDone(boardId); load(); }
    catch (e: unknown) { setError((e as Error).message); }
  };

  const handleHaltAll = async () => {
    try { await api.boards.haltAll(boardId); load(); }
    catch (e: unknown) { setError((e as Error).message); }
  };

  const handleRunCard = async (cardId: string) => {
    try { await api.boards.cards.run(boardId, cardId); load(); }
    catch (e: unknown) { setError((e as Error).message); }
  };

  const handleHaltCard = async (cardId: string) => {
    try { await api.boards.cards.halt(boardId, cardId); load(); }
    catch (e: unknown) { setError((e as Error).message); }
  };

  const handleDeleteCard = async (cardId: string) => {
    try { await api.boards.cards.delete(boardId, cardId); if (selectedCard?.id === cardId) setSelectedCard(null); load(); }
    catch (e: unknown) { setError((e as Error).message); }
  };

  const handleSaveDesc = async () => {
    try { await api.boards.update(boardId, { description: descDraft } as Partial<Board>); setEditingDesc(false); load(); }
    catch (e: unknown) { setError((e as Error).message); }
  };

  const handleViewPlan = async () => {
    setPlanLoading(true);
    setPlanOpen(true);
    try {
      const data = await api.boards.executionPlan(boardId);
      setPlan(data);
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setPlanLoading(false); }
  };

  if (loading && !board) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-10 w-64" />
        <div className="flex gap-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-96 flex-1" />)}</div>
      </div>
    );
  }

  if (error && !board) {
    return (
      <div className="p-6">
        <Button variant="ghost" onClick={onBack} className="mb-4 gap-2"><ArrowLeft className="h-4 w-4" /> Back</Button>
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-6">
      {/* ── Header ── */}
      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 shrink-0"><ArrowLeft className="h-4 w-4" /></Button>
          <h1 className="text-xl font-semibold text-foreground">{board?.name}</h1>
          {board?.active && <Badge className="bg-[#00d4ff]/20 text-[#00d4ff] text-[10px]">Active</Badge>}
        </div>

        {/* Board description (editable) */}
        <div className="group">
          {editingDesc ? (
            <div className="flex gap-2">
              <Textarea
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                rows={2}
                className="text-sm flex-1"
                placeholder="Board description..."
                autoFocus
              />
              <div className="flex flex-col gap-1">
                <Button size="sm" onClick={handleSaveDesc} className="h-7 text-xs bg-[#00d4ff] text-black hover:bg-[#00d4ff]/80">Save</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingDesc(false)} className="h-7 text-xs">Cancel</Button>
              </div>
            </div>
          ) : (
            <div
              className="flex items-start gap-2 cursor-pointer hover:bg-muted/30 rounded-md px-2 py-1 -mx-2 transition-colors"
              onClick={() => { setDescDraft(board?.description ?? ""); setEditingDesc(true); }}
            >
              <p className="text-sm text-muted-foreground flex-1">
                {board?.description || "Click to add a description..."}
              </p>
              <Pencil className="h-3.5 w-3.5 text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5 shrink-0" />
            </div>
          )}
        </div>

        {/* Metrics bar with token cost */}
        {resources && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="text-[#00d4ff]">{resources.runningCount} running</span>
            <span className="text-muted-foreground/40">·</span>
            <span>{resources.pendingCount} pending</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-emerald-400">{resources.doneCount} done</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-red-400">{resources.failedCount} failed</span>
            <span className="text-muted-foreground/40">|</span>
            <span>{formatTokens(resources.totalTokens)} tokens</span>
            {totalCost && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="text-emerald-400 font-medium">{formatCost(totalCost)}</span>
                <span className="text-muted-foreground/60">
                  ({formatTokens(totalCost.input)} in / {formatTokens(totalCost.output)} out)
                </span>
              </>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)} className="gap-1.5 text-xs">
            <Plus className="h-3.5 w-3.5" /> Add Card
          </Button>
          <Button size="sm" variant="outline" onClick={handleGenerate} disabled={generating} className="gap-1.5 text-xs">
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Generate Cards
          </Button>

          {/* Smart Execute */}
          <Button
            size="sm"
            onClick={handleSmartExecute}
            className="gap-1.5 text-xs bg-gradient-to-r from-[#00d4ff] to-[#a78bfa] text-black hover:opacity-90 font-semibold"
          >
            <Zap className="h-3.5 w-3.5" /> Smart Execute
          </Button>

          <Button size="sm" variant="outline" onClick={handleViewPlan} className="gap-1.5 text-xs">
            <GitBranch className="h-3.5 w-3.5" /> View Plan
          </Button>

          <Button size="sm" onClick={handleRunAll} className="gap-1.5 text-xs bg-[#00d4ff] text-black hover:bg-[#00d4ff]/80">
            <Play className="h-3.5 w-3.5" /> Run All
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1.5 text-xs text-red-400 hover:text-red-300">
                <Square className="h-3.5 w-3.5" /> Halt All
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Halt all running agents?</AlertDialogTitle>
                <AlertDialogDescription>All currently running cards will be stopped immediately.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={handleHaltAll}>Halt All</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button size="sm" variant="ghost" onClick={handleClearDone} className="gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5" /> Clear Done
          </Button>
        </div>

        {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>}
      </div>

      {/* Kanban Columns */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="hidden md:flex flex-1 gap-4 overflow-x-auto pb-4">
          {displayColumns.map((col) => (
            <KanbanColumn
              key={col.key}
              status={col.key}
              label={col.label}
              cards={col.cards}
              allCards={cards}
              boardId={boardId}
              onRun={handleRunCard}
              onHalt={handleHaltCard}
              onDelete={handleDeleteCard}
              onSelect={setSelectedCard}
            />
          ))}
        </div>
        <div className="flex flex-col gap-3 md:hidden">
          {displayColumns.map((col) => (
            <MobileColumn
              key={col.key}
              status={col.key}
              label={col.label}
              cards={col.cards}
              allCards={cards}
              boardId={boardId}
              onRun={handleRunCard}
              onHalt={handleHaltCard}
              onDelete={handleDeleteCard}
              onSelect={setSelectedCard}
            />
          ))}
        </div>
        <DragOverlay>
          {activeCard && (
            <div className="w-72 scale-105 opacity-90">
              <KanbanCardContent card={activeCard} allCards={cards} boardId={boardId} onRun={handleRunCard} onHalt={handleHaltCard} onDelete={handleDeleteCard} onSelect={setSelectedCard} overlay />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {cards.length === 0 && !loading && (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <CircleDot className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No cards yet. Add tasks or use AI to generate them.</p>
          </div>
        </div>
      )}

      <AddCardDialog boardId={boardId} open={addOpen} onOpenChange={setAddOpen} onCreated={load} allCards={cards} />

      <CardDetailSheet
        card={selectedCard}
        boardId={boardId}
        allCards={cards}
        open={!!selectedCard}
        onOpenChange={(open) => { if (!open) setSelectedCard(null); }}
        onRun={handleRunCard}
        onHalt={handleHaltCard}
        onDelete={handleDeleteCard}
        onRefresh={load}
      />

      {/* Execution Plan Dialog */}
      <Dialog open={planOpen} onOpenChange={setPlanOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><GitBranch className="h-5 w-5 text-[#00d4ff]" /> Execution Plan</DialogTitle>
            <DialogDescription>Dependency-aware execution order. Cards in each wave run concurrently.</DialogDescription>
          </DialogHeader>
          {planLoading && <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-[#00d4ff]" /></div>}
          {plan && !planLoading && (
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {plan.batches.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">No pending cards to execute.</p>}
              {plan.batches.map((batch) => (
                <div key={batch.wave} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] bg-[#00d4ff]/10 text-[#00d4ff] border-[#00d4ff]/30">
                      Wave {batch.wave}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">{batch.cards.length} card{batch.cards.length > 1 ? "s" : ""}</span>
                  </div>
                  {batch.cards.map((card) => (
                    <div key={card.id} className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-1.5 text-xs">
                      <PriorityBadge priority={card.priority} />
                      <span className="flex-1 truncate text-foreground/80">{card.task}</span>
                      {card.dependsOn && card.dependsOn.length > 0 && (
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          <Link2 className="h-3 w-3 inline mr-0.5" />{card.dependsOn.length} dep{card.dependsOn.length > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              <div className="flex items-center justify-between pt-2 border-t border-border/50 text-xs text-muted-foreground">
                <span>{plan.totalBatches} wave{plan.totalBatches > 1 ? "s" : ""}, {plan.totalCards} card{plan.totalCards > 1 ? "s" : ""}</span>
                <Button size="sm" onClick={() => { setPlanOpen(false); handleSmartExecute(); }} className="gap-1.5 text-xs bg-gradient-to-r from-[#00d4ff] to-[#a78bfa] text-black">
                  <Zap className="h-3 w-3" /> Execute Plan
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// KanbanColumn
// ═══════════════════════════════════════════════════════════════

interface ColumnProps {
  status: CardStatus;
  label: string;
  cards: BoardCard[];
  allCards: BoardCard[];
  boardId: string;
  onRun: (id: string) => void;
  onHalt: (id: string) => void;
  onDelete: (id: string) => void;
  onSelect: (c: BoardCard) => void;
}

function KanbanColumn({ status, label, cards, allCards, boardId, onRun, onHalt, onDelete, onSelect }: ColumnProps) {
  const statusColor = status === "running" ? "text-[#00d4ff]" : status === "done" ? "text-emerald-400" : status === "failed" ? "text-red-400" : "text-muted-foreground";

  return (
    <div className="flex min-w-[260px] flex-1 flex-col rounded-lg border border-border/50 bg-muted/20">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/30">
        <div className="flex items-center gap-2">
          <span className={cn("text-sm font-medium", statusColor)}>{label}</span>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 min-w-[20px] justify-center">{cards.length}</Badge>
        </div>
      </div>
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy} id={status}>
        <ScrollArea className="flex-1 p-2">
          <div className="space-y-2 min-h-[60px]">
            <AnimatePresence mode="popLayout">
              {cards.map((card, i) => (
                <SortableCard key={card.id} card={card} index={i} allCards={allCards} boardId={boardId} onRun={onRun} onHalt={onHalt} onDelete={onDelete} onSelect={onSelect} />
              ))}
            </AnimatePresence>
          </div>
        </ScrollArea>
      </SortableContext>
    </div>
  );
}

function MobileColumn({ status, label, cards, allCards, boardId, onRun, onHalt, onDelete, onSelect }: ColumnProps) {
  const [open, setOpen] = useState(status === "running" || status === "pending");
  const statusColor = status === "running" ? "text-[#00d4ff]" : status === "done" ? "text-emerald-400" : status === "failed" ? "text-red-400" : "text-muted-foreground";

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center justify-between rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5">
          <div className="flex items-center gap-2">
            {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <span className={cn("text-sm font-medium", statusColor)}>{label}</span>
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">{cards.length}</Badge>
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2 pt-2">
            <AnimatePresence mode="popLayout">
              {cards.map((card, i) => (
                <SortableCard key={card.id} card={card} index={i} allCards={allCards} boardId={boardId} onRun={onRun} onHalt={onHalt} onDelete={onDelete} onSelect={onSelect} />
              ))}
            </AnimatePresence>
          </div>
        </SortableContext>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ═══════════════════════════════════════════════════════════════
// SortableCard
// ═══════════════════════════════════════════════════════════════

interface SortableCardProps {
  card: BoardCard;
  index: number;
  allCards: BoardCard[];
  boardId: string;
  onRun: (id: string) => void;
  onHalt: (id: string) => void;
  onDelete: (id: string) => void;
  onSelect: (c: BoardCard) => void;
}

function SortableCard({ card, index, allCards, boardId, onRun, onHalt, onDelete, onSelect }: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: isDragging ? 0.4 : 1, y: 0, transition: { delay: index * 0.03 } }}
      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
      {...attributes}
      {...listeners}
    >
      <KanbanCardContent card={card} allCards={allCards} boardId={boardId} onRun={onRun} onHalt={onHalt} onDelete={onDelete} onSelect={onSelect} />
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════
// KanbanCardContent
// ═══════════════════════════════════════════════════════════════

interface CardContentProps {
  card: BoardCard;
  allCards: BoardCard[];
  boardId: string;
  onRun: (id: string) => void;
  onHalt: (id: string) => void;
  onDelete: (id: string) => void;
  onSelect: (c: BoardCard) => void;
  overlay?: boolean;
}

function KanbanCardContent({ card, allCards, boardId, onRun, onHalt, onDelete, onSelect, overlay }: CardContentProps) {
  const elapsed = useElapsed(card.startedAt, card.status === "running");
  const [expanded, setExpanded] = useState(false);
  const parentCard = card.parentId ? allCards.find(c => c.id === card.parentId) : null;
  const childCount = allCards.filter(c => c.parentId === card.id).length;
  const depCount = card.dependsOn?.length ?? 0;

  return (
    <div
      className={cn(
        "group relative rounded-md border border-border/50 bg-card p-3 text-sm transition-all border-l-[3px] cursor-pointer",
        STATUS_BORDER[card.status] ?? STATUS_BORDER.pending,
        card.status === "running" && "animate-pulse border-l-[3px]",
        card.status === "question" && "ring-1 ring-purple-500/30",
        card.status === "done" && "opacity-80",
        overlay && "shadow-lg shadow-[#00d4ff]/10 ring-1 ring-[#00d4ff]/20"
      )}
      onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; onSelect(card); }}
    >
      {/* Top: priority + labels + dependency indicators + delete */}
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <PriorityBadge priority={card.priority} />
          {card.labels?.map((label) => (
            <span
              key={label.id}
              className="text-[9px] font-medium rounded px-1.5 py-0.5 text-white"
              style={{ backgroundColor: label.color }}
            >
              {label.name}
            </span>
          ))}
          {card.status === "question" && (
            <span className="text-[9px] font-semibold uppercase border border-purple-400/40 text-purple-400 rounded px-1.5 py-0.5">
              Needs Input
            </span>
          )}
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-red-400 p-0.5" onClick={(e) => e.stopPropagation()}>
              <Trash2 className="h-3 w-3" />
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete card?</AlertDialogTitle>
              <AlertDialogDescription>This card will be permanently removed.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => onDelete(card.id)}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Parent indicator */}
      {parentCard && (
        <div className="flex items-center gap-1 text-[9px] text-muted-foreground/70 mb-1">
          <GitBranch className="h-2.5 w-2.5" />
          <span className="truncate">{truncate(parentCard.task, 40)}</span>
        </div>
      )}

      {/* Task text */}
      <p className="text-xs leading-relaxed text-foreground/90">{truncate(card.task, 120)}</p>

      {/* Activity indicators */}
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        {depCount > 0 && (
          <span className="text-[9px] text-muted-foreground/70 flex items-center gap-0.5">
            <Link2 className="h-2.5 w-2.5" /> {depCount}
          </span>
        )}
        {childCount > 0 && (
          <span className="text-[9px] text-muted-foreground/70 flex items-center gap-0.5">
            <GitBranch className="h-2.5 w-2.5" /> {childCount}
          </span>
        )}
        {(card.comments?.length ?? 0) > 0 && (
          <span className="text-[9px] text-muted-foreground/70 flex items-center gap-0.5">
            <MessageSquare className="h-2.5 w-2.5" /> {card.comments!.length}
          </span>
        )}
        {(card.attachments?.length ?? 0) > 0 && (
          <span className="text-[9px] text-muted-foreground/70 flex items-center gap-0.5">
            <Paperclip className="h-2.5 w-2.5" /> {card.attachments!.length}
          </span>
        )}
      </div>

      {/* Running state with live token usage */}
      {card.status === "running" && (
        <div className="mt-2 space-y-1.5">
          {card.progress && (
            <p className="text-[10px] text-[#00d4ff]/70 truncate">{card.progress}</p>
          )}
          {card.filesLocked && card.filesLocked.length > 0 && (
            <div className="text-[9px] text-muted-foreground/60">
              Editing: {card.filesLocked.slice(0, 2).map(f => f.split('/').pop()).join(', ')}
              {card.filesLocked.length > 2 && ` +${card.filesLocked.length - 2}`}
            </div>
          )}
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>
              {card.tokenUsage ? (
                <>{formatTokens(card.tokenUsage.total)} tokens · {formatCost(card.tokenUsage)}</>
              ) : card.tokensUsed != null ? (
                <>{formatTokens(card.tokensUsed)} tokens</>
              ) : null}
            </span>
            {elapsed && <span className="text-[#00d4ff]">{elapsed}</span>}
          </div>
          {card.tokenUsage && (
            <div className="flex gap-2 text-[9px] text-muted-foreground/60">
              <span>{formatTokens(card.tokenUsage.input)} in</span>
              <span>{formatTokens(card.tokenUsage.output)} out</span>
            </div>
          )}
          <Button
            size="sm" variant="destructive" className="h-6 w-full text-[10px] gap-1"
            onClick={(e) => { e.stopPropagation(); onHalt(card.id); }}
          >
            <Square className="h-3 w-3" /> Halt
          </Button>
        </div>
      )}

      {/* Pending state */}
      {(card.status === "pending" || card.status === "paused") && (
        <div className="mt-2">
          <Button
            size="sm" variant="outline" className="h-6 w-full text-[10px] gap-1 border-[#00d4ff]/30 text-[#00d4ff] hover:bg-[#00d4ff]/10"
            onClick={(e) => { e.stopPropagation(); onRun(card.id); }}
          >
            <Play className="h-3 w-3" /> Run
          </Button>
        </div>
      )}

      {/* Done state with cost */}
      {card.status === "done" && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
            {card.tokenUsage ? (
              <>
                <span>{formatTokens(card.tokenUsage.total)} tokens</span>
                <span className="text-emerald-400 font-medium">{formatCost(card.tokenUsage)}</span>
                <span className="text-muted-foreground/50">({formatTokens(card.tokenUsage.input)} in / {formatTokens(card.tokenUsage.output)} out)</span>
              </>
            ) : card.tokensUsed != null ? (
              <span>{formatTokens(card.tokensUsed)} tokens</span>
            ) : null}
            {card.completedAt && <span>{formatDate(card.completedAt)}</span>}
          </div>
          {card.result && (
            <button className="text-[10px] text-[#00d4ff] hover:underline" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}>
              {expanded ? "Hide result" : "Show result"}
            </button>
          )}
          {expanded && card.result && (
            <p className="mt-1 text-[10px] text-muted-foreground whitespace-pre-wrap rounded bg-muted/50 p-2">{card.result}</p>
          )}
        </div>
      )}

      {/* Failed state */}
      {card.status === "failed" && (
        <div className="mt-2 space-y-1.5">
          {card.error && <p className="text-[10px] text-red-400 line-clamp-2">{card.error}</p>}
          {card.tokenUsage && (
            <div className="text-[10px] text-muted-foreground">
              {formatTokens(card.tokenUsage.total)} tokens · {formatCost(card.tokenUsage)}
            </div>
          )}
          <Button
            size="sm" variant="outline" className="h-6 w-full text-[10px] gap-1 border-orange-400/30 text-orange-400 hover:bg-orange-400/10"
            onClick={(e) => { e.stopPropagation(); onRun(card.id); }}
          >
            <RotateCcw className="h-3 w-3" /> Retry
          </Button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Add Card Dialog (with parent selection)
// ═══════════════════════════════════════════════════════════════

function AddCardDialog({
  boardId, open, onOpenChange, onCreated, allCards,
}: {
  boardId: string; open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void; allCards: BoardCard[];
}) {
  const [task, setTask] = useState("");
  const [priority, setPriority] = useState<string>("normal");
  const [parentId, setParentId] = useState<string>("none");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!task.trim()) return;
    setSubmitting(true);
    try {
      const result = await api.boards.cards.add(boardId, { task: task.trim(), priority: priority || undefined });
      // Set parent if selected
      if (parentId !== "none" && result.card) {
        await api.boards.cards.setParent(boardId, result.card.id, parentId);
      }
      setTask("");
      setPriority("normal");
      setParentId("none");
      onOpenChange(false);
      onCreated();
    } catch {} finally { setSubmitting(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Card</DialogTitle>
          <DialogDescription>Create a new task card for this board.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Task</label>
            <Textarea placeholder="Describe the task..." value={task} onChange={(e) => setTask(e.target.value)} rows={4} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Priority</label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Parent Card</label>
              <Select value={parentId} onValueChange={setParentId}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {allCards.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {truncate(c.task, 50)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
          <Button onClick={handleSubmit} disabled={!task.trim() || submitting} className="bg-[#00d4ff] text-black hover:bg-[#00d4ff]/80">
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Add Card
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═══════════════════════════════════════════════════════════════
// Card Detail Sheet (with tabs: Details, Comments, Attachments)
// ═══════════════════════════════════════════════════════════════

function CardDetailSheet({
  card, boardId, allCards, open, onOpenChange, onRun, onHalt, onDelete, onRefresh,
}: {
  card: BoardCard | null;
  boardId: string;
  allCards: BoardCard[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onRun: (id: string) => void;
  onHalt: (id: string) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<"details" | "comments" | "attachments">("details");
  const [editingTask, setEditingTask] = useState(false);
  const [taskDraft, setTaskDraft] = useState("");
  const [commentText, setCommentText] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);
  const [labelName, setLabelName] = useState("");
  const [labelColor, setLabelColor] = useState("#3b82f6");
  const [showLabelInput, setShowLabelInput] = useState(false);

  const elapsed = useElapsed(card?.startedAt, card?.status === "running");

  if (!card) return null;

  const parentCard = card.parentId ? allCards.find(c => c.id === card.parentId) : null;
  const children = allCards.filter(c => c.parentId === card.id);
  const deps = (card.dependsOn ?? []).map(id => allCards.find(c => c.id === id)).filter(Boolean) as BoardCard[];

  const statusLabel =
    card.status === "running" ? "Running" :
    card.status === "pending" ? "Pending" :
    card.status === "paused" ? "Paused" :
    card.status === "done" ? "Done" :
    card.status === "question" ? "Needs Input" : "Failed";

  const statusColor =
    card.status === "running" ? "text-[#00d4ff]" :
    card.status === "done" ? "text-emerald-400" :
    card.status === "failed" ? "text-red-400" :
    card.status === "question" ? "text-purple-400" :
    "text-muted-foreground";

  const handleSaveTask = async () => {
    try {
      await api.boards.cards.update(boardId, card.id, { task: taskDraft } as Partial<BoardCard>);
      setEditingTask(false);
      onRefresh();
    } catch {}
  };

  const handleAddComment = async () => {
    if (!commentText.trim()) return;
    setSubmittingComment(true);
    try {
      await api.boards.cards.comments.add(boardId, card.id, commentText.trim(), "user", "Admin");
      setCommentText("");
      onRefresh();
    } catch {} finally { setSubmittingComment(false); }
  };

  const handleDeleteComment = async (commentId: string) => {
    try { await api.boards.cards.comments.delete(boardId, card.id, commentId); onRefresh(); } catch {}
  };

  const handleAddLabel = async () => {
    if (!labelName.trim()) return;
    try {
      await api.boards.cards.labels.add(boardId, card.id, labelName.trim(), labelColor);
      setLabelName("");
      setShowLabelInput(false);
      onRefresh();
    } catch {}
  };

  const handleRemoveLabel = async (labelId: string) => {
    try { await api.boards.cards.labels.remove(boardId, card.id, labelId); onRefresh(); } catch {}
  };

  const handleDeleteAttachment = async (attId: string) => {
    try { await api.boards.cards.attachments.delete(boardId, card.id, attId); onRefresh(); } catch {}
  };

  const handleUpdatePriority = async (priority: string) => {
    try { await api.boards.cards.update(boardId, card.id, { priority } as Partial<BoardCard>); onRefresh(); } catch {}
  };

  const tabClass = (t: string) => cn(
    "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
    tab === t ? "bg-[#00d4ff]/15 text-[#00d4ff]" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base">Card Details</SheetTitle>
          <SheetDescription className="sr-only">Detailed view of the selected task card.</SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* Status + Priority (editable) */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className={cn("text-sm font-semibold", statusColor)}>{statusLabel}</span>
            <Select value={card.priority ?? "normal"} onValueChange={handleUpdatePriority}>
              <SelectTrigger className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Labels */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              {card.labels?.map((label) => (
                <span key={label.id} className="inline-flex items-center gap-1 text-[10px] font-medium rounded px-2 py-0.5 text-white" style={{ backgroundColor: label.color }}>
                  {label.name}
                  <button onClick={() => handleRemoveLabel(label.id)} className="hover:opacity-70"><X className="h-2.5 w-2.5" /></button>
                </span>
              ))}
              <button onClick={() => setShowLabelInput(!showLabelInput)} className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5">
                <Tag className="h-3 w-3" /> Add Label
              </button>
            </div>
            {showLabelInput && (
              <div className="flex items-center gap-2">
                <div className="flex flex-wrap gap-1">
                  {LABEL_PRESETS.map((p) => (
                    <button
                      key={p.name}
                      onClick={() => { setLabelName(p.name); setLabelColor(p.color); }}
                      className={cn("text-[9px] font-medium rounded px-1.5 py-0.5 text-white transition-all", labelName === p.name && "ring-2 ring-white/50")}
                      style={{ backgroundColor: p.color }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                <Input value={labelName} onChange={(e) => setLabelName(e.target.value)} placeholder="Custom..." className="h-6 text-xs w-20" />
                <input type="color" value={labelColor} onChange={(e) => setLabelColor(e.target.value)} className="h-6 w-6 rounded cursor-pointer" />
                <Button size="sm" onClick={handleAddLabel} disabled={!labelName.trim()} className="h-6 text-[10px] px-2 bg-[#00d4ff] text-black">Add</Button>
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-border/50 pb-2">
            <button className={tabClass("details")} onClick={() => setTab("details")}>Details</button>
            <button className={tabClass("comments")} onClick={() => setTab("comments")}>
              Comments {(card.comments?.length ?? 0) > 0 && <Badge variant="secondary" className="ml-1 text-[9px] px-1 h-4">{card.comments!.length}</Badge>}
            </button>
            <button className={tabClass("attachments")} onClick={() => setTab("attachments")}>
              Attachments {(card.attachments?.length ?? 0) > 0 && <Badge variant="secondary" className="ml-1 text-[9px] px-1 h-4">{card.attachments!.length}</Badge>}
            </button>
          </div>

          {/* ── Details Tab ── */}
          {tab === "details" && (
            <div className="space-y-4">
              {/* Task (editable) */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Task</label>
                  {!editingTask && (
                    <button onClick={() => { setTaskDraft(card.task); setEditingTask(true); }} className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5">
                      <Pencil className="h-2.5 w-2.5" /> Edit
                    </button>
                  )}
                </div>
                {editingTask ? (
                  <div className="space-y-2">
                    <Textarea value={taskDraft} onChange={(e) => setTaskDraft(e.target.value)} rows={3} className="text-sm" />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSaveTask} className="h-6 text-xs bg-[#00d4ff] text-black">Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingTask(false)} className="h-6 text-xs">Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">{card.task}</p>
                )}
              </div>

              {/* Progress */}
              {card.progress && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Progress</label>
                  <p className="text-sm text-[#00d4ff]/80 mt-0.5">{card.progress}</p>
                </div>
              )}

              {/* Files being edited */}
              {card.filesLocked && card.filesLocked.length > 0 && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Files Locked</label>
                  <div className="mt-1 space-y-0.5">
                    {card.filesLocked.map((f, i) => (
                      <p key={i} className="text-[11px] font-mono text-foreground/70 truncate">{f}</p>
                    ))}
                  </div>
                </div>
              )}

              {/* Token Usage (detailed breakdown) */}
              {card.tokenUsage && (
                <div className="rounded-md border border-border/50 bg-muted/30 p-3 space-y-2">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Token Usage & Cost</label>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div>
                      <p className="text-lg font-semibold text-foreground">{formatTokens(card.tokenUsage.total)}</p>
                      <p className="text-[10px] text-muted-foreground">Total</p>
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-[#00d4ff]">{formatTokens(card.tokenUsage.input)}</p>
                      <p className="text-[10px] text-muted-foreground">Input</p>
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-[#a78bfa]">{formatTokens(card.tokenUsage.output)}</p>
                      <p className="text-[10px] text-muted-foreground">Output</p>
                    </div>
                  </div>
                  <div className="text-center pt-1 border-t border-border/30">
                    <p className="text-sm font-semibold text-emerald-400">{formatCost(card.tokenUsage)}</p>
                    <p className="text-[10px] text-muted-foreground">Estimated Cost</p>
                  </div>
                </div>
              )}

              {/* Timestamps */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-muted-foreground">Created</span>
                  <p className="text-foreground">{formatDate(card.createdAt)}</p>
                </div>
                {card.startedAt && <div><span className="text-muted-foreground">Started</span><p className="text-foreground">{formatDate(card.startedAt)}</p></div>}
                {card.completedAt && <div><span className="text-muted-foreground">Completed</span><p className="text-foreground">{formatDate(card.completedAt)}</p></div>}
                {card.status === "running" && elapsed && <div><span className="text-muted-foreground">Elapsed</span><p className="text-[#00d4ff]">{elapsed}</p></div>}
              </div>

              {/* Dependencies */}
              {(parentCard || children.length > 0 || deps.length > 0) && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Dependencies</label>
                  {parentCard && (
                    <div className="flex items-center gap-2 text-xs">
                      <GitBranch className="h-3 w-3 text-muted-foreground" />
                      <span className="text-muted-foreground">Parent:</span>
                      <span className="text-foreground truncate">{truncate(parentCard.task, 60)}</span>
                    </div>
                  )}
                  {deps.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-[10px] text-muted-foreground">Depends on:</span>
                      {deps.map(d => (
                        <div key={d.id} className="flex items-center gap-2 text-xs pl-2">
                          <Link2 className="h-2.5 w-2.5 text-muted-foreground/60" />
                          <span className={cn("truncate", d.status === "done" ? "text-emerald-400 line-through" : "text-foreground/70")}>{truncate(d.task, 50)}</span>
                          <Badge variant="secondary" className="text-[8px] px-1 h-3.5">{d.status}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                  {children.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-[10px] text-muted-foreground">Children ({children.length}):</span>
                      {children.map(ch => (
                        <div key={ch.id} className="flex items-center gap-2 text-xs pl-2">
                          <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/60" />
                          <span className="truncate text-foreground/70">{truncate(ch.task, 50)}</span>
                          <Badge variant="secondary" className="text-[8px] px-1 h-3.5">{ch.status}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Result */}
              {card.result && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Result</label>
                  <div className="mt-1 max-h-60 overflow-y-auto rounded-md bg-muted/50 p-3 text-xs text-foreground/80 whitespace-pre-wrap">{card.result}</div>
                </div>
              )}

              {/* Error */}
              {card.error && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Error</label>
                  <div className="mt-1 rounded-md border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-400 whitespace-pre-wrap">{card.error}</div>
                </div>
              )}
            </div>
          )}

          {/* ── Comments Tab ── */}
          {tab === "comments" && (
            <div className="space-y-3">
              {(card.comments?.length ?? 0) === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">No comments yet. Start a conversation.</p>
              )}
              {card.comments?.map((comment) => (
                <div key={comment.id} className={cn(
                  "rounded-md p-3 text-sm space-y-1",
                  comment.author === "agent" ? "bg-[#00d4ff]/5 border border-[#00d4ff]/20" : "bg-muted/50 border border-border/30"
                )}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={cn("text-xs font-medium", comment.author === "agent" ? "text-[#00d4ff]" : "text-foreground")}>
                        {comment.authorName}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{timeAgo(comment.timestamp)}</span>
                    </div>
                    <button onClick={() => handleDeleteComment(comment.id)} className="text-muted-foreground/50 hover:text-red-400">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <p className="text-xs text-foreground/80 whitespace-pre-wrap">{comment.content}</p>
                </div>
              ))}

              {/* Add comment */}
              <div className="flex gap-2 pt-2 border-t border-border/30">
                <Textarea
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder="Write a comment..."
                  rows={2}
                  className="text-xs flex-1"
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAddComment(); }}
                />
                <Button
                  size="sm" onClick={handleAddComment} disabled={!commentText.trim() || submittingComment}
                  className="h-8 w-8 p-0 bg-[#00d4ff] text-black hover:bg-[#00d4ff]/80 self-end"
                >
                  {submittingComment ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          )}

          {/* ── Attachments Tab ── */}
          {tab === "attachments" && (
            <AttachmentsTab card={card} boardId={boardId} onDelete={handleDeleteAttachment} />
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-border/50">
            {(card.status === "pending" || card.status === "paused" || card.status === "failed") && (
              <Button size="sm" className="gap-1.5 bg-[#00d4ff] text-black hover:bg-[#00d4ff]/80" onClick={() => { onRun(card.id); onOpenChange(false); }}>
                <Play className="h-3.5 w-3.5" /> {card.status === "failed" ? "Retry" : "Run"}
              </Button>
            )}
            {card.status === "running" && (
              <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => { onHalt(card.id); onOpenChange(false); }}>
                <Square className="h-3.5 w-3.5" /> Halt
              </Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" className="gap-1.5 text-red-400 hover:text-red-300"><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete card?</AlertDialogTitle>
                  <AlertDialogDescription>This card will be permanently removed.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => { onDelete(card.id); onOpenChange(false); }}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ═══════════════════════════════════════════════════════════════
// AttachmentsTab — with markdown preview + download
// ═══════════════════════════════════════════════════════════════

function AttachmentsTab({ card, boardId, onDelete }: { card: BoardCard; boardId: string; onDelete: (id: string) => void }) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);

  const handlePreview = async (att: CardAttachment) => {
    if (previewId === att.id) { setPreviewId(null); return; }
    setPreviewId(att.id);
    setPreviewLoading(true);
    try {
      const data = await api.boards.cards.attachments.content(boardId, card.id, att.id);
      setPreviewContent(data.content);
    } catch { setPreviewContent("Failed to load file content."); }
    finally { setPreviewLoading(false); }
  };

  const handleDownload = (att: CardAttachment) => {
    const url = api.boards.cards.attachments.downloadUrl(boardId, card.id, att.id);
    const a = document.createElement("a");
    a.href = url;
    a.download = att.name;
    a.click();
  };

  return (
    <div className="space-y-3">
      {(card.attachments?.length ?? 0) === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">No attachments. Documents generated by the agent will appear here.</p>
      )}
      {card.attachments?.map((att) => {
        const Icon = ATTACHMENT_ICONS[att.type] ?? Paperclip;
        const isPreviewable = att.type === "markdown" || att.type === "document";
        const isImage = att.type === "image";
        const isOpen = previewId === att.id;

        return (
          <div key={att.id} className="rounded-md border border-border/50 bg-muted/30 overflow-hidden">
            <div className="flex items-center gap-3 p-3">
              <div className={cn(
                "h-9 w-9 rounded-md flex items-center justify-center shrink-0",
                att.type === "markdown" ? "bg-emerald-500/15 text-emerald-400" :
                att.type === "image" ? "bg-purple-500/15 text-purple-400" :
                "bg-muted text-muted-foreground"
              )}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{att.name}</p>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="capitalize">{att.type}</span>
                  {att.size != null && <span>{(att.size / 1024).toFixed(1)} KB</span>}
                  <span>{timeAgo(att.addedAt)}</span>
                  <span>by {att.addedBy}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {(isPreviewable || isImage) && (
                  <button
                    onClick={() => handlePreview(att)}
                    className={cn("p-1.5 rounded-md transition-colors", isOpen ? "bg-[#00d4ff]/15 text-[#00d4ff]" : "text-muted-foreground/50 hover:text-foreground")}
                    title="Preview"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                )}
                <button onClick={() => handleDownload(att)} className="p-1.5 text-muted-foreground/50 hover:text-foreground" title="Download">
                  <Download className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => onDelete(att.id)} className="p-1.5 text-muted-foreground/50 hover:text-red-400" title="Delete">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Preview panel */}
            {isOpen && (
              <div className="border-t border-border/30 bg-background/50">
                {previewLoading ? (
                  <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-[#00d4ff]" /></div>
                ) : isImage ? (
                  <div className="p-3">
                    <img
                      src={api.boards.cards.attachments.downloadUrl(boardId, card.id, att.id)}
                      alt={att.name}
                      className="max-w-full max-h-96 rounded-md mx-auto"
                    />
                  </div>
                ) : (
                  <div className="p-3 max-h-96 overflow-y-auto">
                    <div className="prose prose-sm dark:prose-invert max-w-none text-xs">
                      <MarkdownRenderer content={previewContent} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Simple markdown renderer (handles headers, bold, code blocks, lists)
function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: JSX.Element[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre key={i} className="rounded-md bg-muted p-3 text-[11px] font-mono overflow-x-auto my-2">
            <code>{codeLines.join('\n')}</code>
          </pre>
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (line.startsWith('# ')) {
      elements.push(<h1 key={i} className="text-lg font-bold mt-3 mb-1">{renderInline(line.slice(2))}</h1>);
    } else if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className="text-base font-semibold mt-2 mb-1">{renderInline(line.slice(3))}</h2>);
    } else if (line.startsWith('### ')) {
      elements.push(<h3 key={i} className="text-sm font-semibold mt-2 mb-0.5">{renderInline(line.slice(4))}</h3>);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(<li key={i} className="ml-4 list-disc text-foreground/80">{renderInline(line.slice(2))}</li>);
    } else if (/^\d+\.\s/.test(line)) {
      elements.push(<li key={i} className="ml-4 list-decimal text-foreground/80">{renderInline(line.replace(/^\d+\.\s/, ''))}</li>);
    } else if (line.startsWith('> ')) {
      elements.push(<blockquote key={i} className="border-l-2 border-[#00d4ff]/40 pl-3 text-muted-foreground italic my-1">{renderInline(line.slice(2))}</blockquote>);
    } else if (line.trim() === '') {
      elements.push(<div key={i} className="h-2" />);
    } else {
      elements.push(<p key={i} className="text-foreground/80 my-0.5">{renderInline(line)}</p>);
    }
  }

  // Handle unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    elements.push(
      <pre key="unclosed" className="rounded-md bg-muted p-3 text-[11px] font-mono overflow-x-auto my-2">
        <code>{codeLines.join('\n')}</code>
      </pre>
    );
  }

  return <>{elements}</>;
}

function renderInline(text: string): React.ReactNode {
  // Handle bold, italic, inline code
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Inline code
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`/);
    if (codeMatch) {
      if (codeMatch[1]) parts.push(<span key={key++}>{codeMatch[1]}</span>);
      parts.push(<code key={key++} className="bg-muted px-1 py-0.5 rounded text-[10px] font-mono text-[#00d4ff]">{codeMatch[2]}</code>);
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Bold
    const boldMatch = remaining.match(/^(.*?)\*\*([^*]+)\*\*/);
    if (boldMatch) {
      if (boldMatch[1]) parts.push(<span key={key++}>{boldMatch[1]}</span>);
      parts.push(<strong key={key++}>{boldMatch[2]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // No more special formatting
    parts.push(<span key={key++}>{remaining}</span>);
    break;
  }

  return <>{parts}</>;
}
