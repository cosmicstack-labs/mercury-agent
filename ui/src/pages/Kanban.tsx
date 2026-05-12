/* ═══════════════════════════════════════════════════════════════
   Mercury Kanban — Alive Board for AI Agent Task Management
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
  CircleDot,
  Clock,
  Columns3,
  Loader2,
  Pause,
  Play,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  XCircle,
  Zap,
  ChevronDown,
  ChevronRight,
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
import api, { type Board, type BoardCard, type BoardResources } from "@/lib/api";

// ── Constants ──────────────────────────────────────────────────

type CardStatus = BoardCard["status"];
type CardPriority = NonNullable<BoardCard["priority"]>;

const COLUMNS: { key: CardStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "running", label: "Running" },
  { key: "done", label: "Done" },
  { key: "failed", label: "Failed" },
];

const PRIORITY_CONFIG: Record<CardPriority, { label: string; color: string }> = {
  low: { label: "Low", color: "text-muted-foreground border-muted-foreground/40" },
  medium: { label: "Med", color: "text-yellow-400 border-yellow-400/40" },
  high: { label: "High", color: "text-orange-400 border-orange-400/40" },
  critical: { label: "Crit", color: "text-red-400 border-red-400/40" },
};

const STATUS_BORDER: Record<CardStatus, string> = {
  pending: "border-l-muted-foreground/40 border-dashed",
  running: "border-l-[#00d4ff]",
  paused: "border-l-yellow-400",
  done: "border-l-emerald-500",
  failed: "border-l-red-500",
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

function useElapsed(startedAt?: string, active?: boolean) {
  const [elapsed, setElapsed] = useState("");
  useEffect(() => {
    if (!startedAt || !active) {
      setElapsed("");
      return;
    }
    const update = () => {
      const diff = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
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

function PriorityBadge({ priority }: { priority?: CardPriority }) {
  if (!priority) return null;
  const cfg = PRIORITY_CONFIG[priority];
  return (
    <span className={cn("text-[10px] font-semibold uppercase border rounded px-1.5 py-0.5", cfg.color)}>
      {cfg.label}
    </span>
  );
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
    try {
      await api.boards.delete(id);
      load();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const handleToggleActive = async (board: Board) => {
    try {
      if (board.active) await api.boards.deactivate(board.id);
      else await api.boards.activate(board.id);
      load();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Columns3 className="h-6 w-6 text-[#00d4ff]" />
          <h1 className="text-2xl font-semibold text-foreground">Kanban Boards</h1>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2 bg-[#00d4ff] text-black hover:bg-[#00d4ff]/80">
          <Plus className="h-4 w-4" />
          Create Board
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36" />)}
        </div>
      )}

      {/* Empty */}
      {!loading && boards.length === 0 && !error && (
        <Card>
          <CardContent className="py-16 text-center">
            <Columns3 className="mx-auto mb-4 h-12 w-12 text-muted-foreground/40" />
            <p className="text-muted-foreground">No boards yet. Create one to get started.</p>
          </CardContent>
        </Card>
      )}

      {/* Board Grid */}
      {!loading && boards.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
          <AnimatePresence mode="popLayout">
            {boards.map((board, i) => (
              <motion.div
                key={board.id}
                custom={i}
                variants={fadeUp}
                initial="hidden"
                animate="visible"
                exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                layout
              >
                <Card
                  className="cursor-pointer transition-colors hover:border-[#00d4ff]/40"
                  onClick={() => onSelect(board.id)}
                >
                  <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2">
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-base font-semibold">{board.name}</CardTitle>
                      {board.description && (
                        <p className="mt-1 text-sm text-muted-foreground">{truncate(board.description, 100)}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <Badge
                        variant={board.active ? "default" : "secondary"}
                        className={cn(
                          "cursor-pointer text-[10px]",
                          board.active && "bg-[#00d4ff]/20 text-[#00d4ff] hover:bg-[#00d4ff]/30"
                        )}
                        onClick={() => handleToggleActive(board)}
                      >
                        {board.active ? (
                          <><Power className="mr-1 h-3 w-3" /> Active</>
                        ) : (
                          <><PowerOff className="mr-1 h-3 w-3" /> Inactive</>
                        )}
                      </Badge>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-red-400">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete board?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will permanently delete "{board.name}" and all its cards. This action cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-red-600 hover:bg-red-700"
                              onClick={() => handleDelete(board.id)}
                            >
                              Delete
                            </AlertDialogAction>
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
              <Input
                placeholder="Board name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Description</label>
              <Textarea
                placeholder="Optional description..."
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              onClick={handleCreate}
              disabled={!createName.trim() || creating}
              className="bg-[#00d4ff] text-black hover:bg-[#00d4ff]/80"
            >
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create
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
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  // Polling
  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 2500);
    return () => clearInterval(pollRef.current);
  }, [load]);

  const cards = useMemo(() => board?.cards ?? [], [board]);

  const columnCards = useMemo(() => {
    const map: Record<CardStatus, BoardCard[]> = { pending: [], running: [], paused: [], done: [], failed: [] };
    for (const c of cards) map[c.status].push(c);
    return map;
  }, [cards]);

  // Merge paused into pending for display
  const displayColumns = useMemo(() => {
    return COLUMNS.map((col) => ({
      ...col,
      cards: col.key === "pending" ? [...columnCards.pending, ...columnCards.paused] : columnCards[col.key],
    }));
  }, [columnCards]);

  const activeCard = useMemo(() => (activeId ? cards.find((c) => c.id === activeId) : undefined), [activeId, cards]);

  // ── DnD Handlers ──
  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    // Determine target column by finding which column the "over" item belongs to, or the column itself
    const overId = over.id as string;
    let targetStatus: CardStatus | undefined;

    // Check if dropped onto a column droppable
    const col = COLUMNS.find((c) => c.key === overId);
    if (col) {
      targetStatus = col.key;
    } else {
      // Dropped onto another card — find that card's column
      const overCard = cards.find((c) => c.id === overId);
      if (overCard) targetStatus = overCard.status;
    }

    if (!targetStatus) return;
    const card = cards.find((c) => c.id === active.id);
    if (!card || card.status === targetStatus) return;

    try {
      await api.boards.cards.update(boardId, card.id, { status: targetStatus });
      load();
    } catch {
      // ignore
    }
  };

  // ── Actions ──
  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await api.boards.generate(boardId);
      load();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const handleRunAll = async () => {
    try {
      await api.boards.runAll(boardId);
      load();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const handleClearDone = async () => {
    try {
      await api.boards.cards.clearDone(boardId);
      load();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const handleHaltAll = async () => {
    try {
      await api.boards.haltAll(boardId);
      load();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const handleRunCard = async (cardId: string) => {
    try {
      await api.boards.cards.run(boardId, cardId);
      load();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const handleHaltCard = async (cardId: string) => {
    try {
      await api.boards.cards.halt(boardId, cardId);
      load();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const handleDeleteCard = async (cardId: string) => {
    try {
      await api.boards.cards.delete(boardId, cardId);
      if (selectedCard?.id === cardId) setSelectedCard(null);
      load();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  // Loading
  if (loading && !board) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-10 w-64" />
        <div className="flex gap-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-96 flex-1" />)}
        </div>
      </div>
    );
  }

  if (error && !board) {
    return (
      <div className="p-6">
        <Button variant="ghost" onClick={onBack} className="mb-4 gap-2">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-6">
      {/* Header */}
      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-xl font-semibold text-foreground">{board?.name}</h1>
          {board?.active && (
            <Badge className="bg-[#00d4ff]/20 text-[#00d4ff] text-[10px]">Active</Badge>
          )}
        </div>

        {/* Metrics */}
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
            <span>Total: {formatTokens(resources.totalTokens)} tokens</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)} className="gap-1.5 text-xs">
            <Plus className="h-3.5 w-3.5" /> Add Card
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleGenerate}
            disabled={generating}
            className="gap-1.5 text-xs"
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Generate Cards
          </Button>
          <Button
            size="sm"
            onClick={handleRunAll}
            className="gap-1.5 text-xs bg-[#00d4ff] text-black hover:bg-[#00d4ff]/80"
          >
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
                <AlertDialogDescription>
                  All currently running cards will be stopped immediately.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={handleHaltAll}>
                  Halt All
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button size="sm" variant="ghost" onClick={handleClearDone} className="gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5" /> Clear Done
          </Button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>
        )}
      </div>

      {/* Kanban Columns */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {/* Desktop: all 4 cols. Tablet: 2 cols scroll. Mobile: accordion */}
        <div className="hidden md:flex flex-1 gap-4 overflow-x-auto pb-4">
          {displayColumns.map((col) => (
            <KanbanColumn
              key={col.key}
              status={col.key}
              label={col.label}
              cards={col.cards}
              boardId={boardId}
              onRun={handleRunCard}
              onHalt={handleHaltCard}
              onDelete={handleDeleteCard}
              onSelect={setSelectedCard}
            />
          ))}
        </div>

        {/* Mobile: collapsible accordion */}
        <div className="flex flex-col gap-3 md:hidden">
          {displayColumns.map((col) => (
            <MobileColumn
              key={col.key}
              status={col.key}
              label={col.label}
              cards={col.cards}
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
              <KanbanCardContent
                card={activeCard}
                boardId={boardId}
                onRun={handleRunCard}
                onHalt={handleHaltCard}
                onDelete={handleDeleteCard}
                onSelect={setSelectedCard}
                overlay
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Empty state */}
      {cards.length === 0 && !loading && (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <CircleDot className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No cards yet. Add tasks or use AI to generate them.</p>
          </div>
        </div>
      )}

      {/* Add Card Dialog */}
      <AddCardDialog boardId={boardId} open={addOpen} onOpenChange={setAddOpen} onCreated={load} />

      {/* Card Detail Sheet */}
      <CardDetailSheet
        card={selectedCard}
        boardId={boardId}
        open={!!selectedCard}
        onOpenChange={(open) => { if (!open) setSelectedCard(null); }}
        onRun={handleRunCard}
        onHalt={handleHaltCard}
        onDelete={handleDeleteCard}
      />
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
  boardId: string;
  onRun: (id: string) => void;
  onHalt: (id: string) => void;
  onDelete: (id: string) => void;
  onSelect: (c: BoardCard) => void;
}

function KanbanColumn({ status, label, cards, boardId, onRun, onHalt, onDelete, onSelect }: ColumnProps) {
  const columnId = status;
  const statusColor = status === "running" ? "text-[#00d4ff]" : status === "done" ? "text-emerald-400" : status === "failed" ? "text-red-400" : "text-muted-foreground";

  return (
    <div className="flex min-w-[260px] flex-1 flex-col rounded-lg border border-border/50 bg-muted/20">
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/30">
        <div className="flex items-center gap-2">
          <span className={cn("text-sm font-medium", statusColor)}>{label}</span>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 min-w-[20px] justify-center">
            {cards.length}
          </Badge>
        </div>
      </div>

      {/* Cards area */}
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy} id={columnId}>
        <ScrollArea className="flex-1 p-2">
          <div className="space-y-2 min-h-[60px]">
            <AnimatePresence mode="popLayout">
              {cards.map((card, i) => (
                <SortableCard
                  key={card.id}
                  card={card}
                  index={i}
                  boardId={boardId}
                  onRun={onRun}
                  onHalt={onHalt}
                  onDelete={onDelete}
                  onSelect={onSelect}
                />
              ))}
            </AnimatePresence>
          </div>
        </ScrollArea>
      </SortableContext>
    </div>
  );
}

// ── Mobile Column (Collapsible) ─────────────────────────────

function MobileColumn({ status, label, cards, boardId, onRun, onHalt, onDelete, onSelect }: ColumnProps) {
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
                <SortableCard
                  key={card.id}
                  card={card}
                  index={i}
                  boardId={boardId}
                  onRun={onRun}
                  onHalt={onHalt}
                  onDelete={onDelete}
                  onSelect={onSelect}
                />
              ))}
            </AnimatePresence>
          </div>
        </SortableContext>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ═══════════════════════════════════════════════════════════════
// SortableCard (DnD wrapper)
// ═══════════════════════════════════════════════════════════════

interface SortableCardProps {
  card: BoardCard;
  index: number;
  boardId: string;
  onRun: (id: string) => void;
  onHalt: (id: string) => void;
  onDelete: (id: string) => void;
  onSelect: (c: BoardCard) => void;
}

function SortableCard({ card, index, boardId, onRun, onHalt, onDelete, onSelect }: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

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
      <KanbanCardContent
        card={card}
        boardId={boardId}
        onRun={onRun}
        onHalt={onHalt}
        onDelete={onDelete}
        onSelect={onSelect}
      />
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════
// KanbanCardContent (visual card body)
// ═══════════════════════════════════════════════════════════════

interface CardContentProps {
  card: BoardCard;
  boardId: string;
  onRun: (id: string) => void;
  onHalt: (id: string) => void;
  onDelete: (id: string) => void;
  onSelect: (c: BoardCard) => void;
  overlay?: boolean;
}

function KanbanCardContent({ card, boardId, onRun, onHalt, onDelete, onSelect, overlay }: CardContentProps) {
  const elapsed = useElapsed(card.startedAt, card.status === "running");
  const tokenPct = card.tokenBudget && card.tokensUsed ? Math.min(100, (card.tokensUsed / card.tokenBudget) * 100) : 0;
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "group relative rounded-md border border-border/50 bg-card p-3 text-sm transition-all border-l-[3px] cursor-pointer",
        STATUS_BORDER[card.status],
        card.status === "running" && "animate-pulse border-l-[3px]",
        card.status === "done" && "opacity-80",
        overlay && "shadow-lg shadow-[#00d4ff]/10 ring-1 ring-[#00d4ff]/20"
      )}
      onClick={(e) => {
        // Don't open sheet when clicking buttons
        if ((e.target as HTMLElement).closest("button")) return;
        onSelect(card);
      }}
    >
      {/* Top row: priority + delete */}
      <div className="flex items-start justify-between gap-2 mb-1">
        <PriorityBadge priority={card.priority} />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-red-400 p-0.5"
              onClick={(e) => e.stopPropagation()}
            >
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
              <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => onDelete(card.id)}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Task text */}
      <p className="text-xs leading-relaxed text-foreground/90">{truncate(card.task, 120)}</p>

      {/* Running state */}
      {card.status === "running" && (
        <div className="mt-2 space-y-1.5">
          {card.tokensUsed != null && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>{formatTokens(card.tokensUsed)}{card.tokenBudget ? ` / ${formatTokens(card.tokenBudget)}` : ""} tokens</span>
                {elapsed && <span className="text-[#00d4ff]">{elapsed}</span>}
              </div>
              {card.tokenBudget && (
                <Progress value={tokenPct} className="h-1 [&>div]:bg-[#00d4ff]" />
              )}
            </div>
          )}
          {!card.tokensUsed && elapsed && (
            <div className="flex items-center gap-1.5 text-[10px] text-[#00d4ff]">
              <Clock className="h-3 w-3" />
              <span>{elapsed}</span>
            </div>
          )}
          <Button
            size="sm"
            variant="destructive"
            className="h-6 w-full text-[10px] gap-1"
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
            size="sm"
            variant="outline"
            className="h-6 w-full text-[10px] gap-1 border-[#00d4ff]/30 text-[#00d4ff] hover:bg-[#00d4ff]/10"
            onClick={(e) => { e.stopPropagation(); onRun(card.id); }}
          >
            <Play className="h-3 w-3" /> Run
          </Button>
        </div>
      )}

      {/* Done state */}
      {card.status === "done" && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {card.tokensUsed != null && <span>{formatTokens(card.tokensUsed)} tokens</span>}
            {card.completedAt && <span>{formatDate(card.completedAt)}</span>}
          </div>
          {card.result && (
            <button
              className="text-[10px] text-[#00d4ff] hover:underline"
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            >
              {expanded ? "Hide result" : "Show result"}
            </button>
          )}
          {expanded && card.result && (
            <p className="mt-1 text-[10px] text-muted-foreground whitespace-pre-wrap rounded bg-muted/50 p-2">
              {card.result}
            </p>
          )}
        </div>
      )}

      {/* Failed state */}
      {card.status === "failed" && (
        <div className="mt-2 space-y-1.5">
          {card.error && (
            <p className="text-[10px] text-red-400 line-clamp-2">{card.error}</p>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-6 w-full text-[10px] gap-1 border-orange-400/30 text-orange-400 hover:bg-orange-400/10"
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
// Add Card Dialog
// ═══════════════════════════════════════════════════════════════

function AddCardDialog({
  boardId,
  open,
  onOpenChange,
  onCreated,
}: {
  boardId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}) {
  const [task, setTask] = useState("");
  const [priority, setPriority] = useState<string>("medium");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!task.trim()) return;
    setSubmitting(true);
    try {
      await api.boards.cards.add(boardId, { task: task.trim(), priority: priority || undefined });
      setTask("");
      setPriority("medium");
      onOpenChange(false);
      onCreated();
    } catch {
      // error handled at board level
    } finally {
      setSubmitting(false);
    }
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
            <Textarea
              placeholder="Describe the task..."
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={4}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Priority</label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button
            onClick={handleSubmit}
            disabled={!task.trim() || submitting}
            className="bg-[#00d4ff] text-black hover:bg-[#00d4ff]/80"
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Add Card
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═══════════════════════════════════════════════════════════════
// Card Detail Sheet
// ═══════════════════════════════════════════════════════════════

function CardDetailSheet({
  card,
  boardId,
  open,
  onOpenChange,
  onRun,
  onHalt,
  onDelete,
}: {
  card: BoardCard | null;
  boardId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onRun: (id: string) => void;
  onHalt: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const elapsed = useElapsed(card?.startedAt, card?.status === "running");

  if (!card) return null;

  const statusLabel =
    card.status === "running" ? "Running" :
    card.status === "pending" ? "Pending" :
    card.status === "paused" ? "Paused" :
    card.status === "done" ? "Done" : "Failed";

  const statusColor =
    card.status === "running" ? "text-[#00d4ff]" :
    card.status === "done" ? "text-emerald-400" :
    card.status === "failed" ? "text-red-400" :
    "text-muted-foreground";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base">Card Details</SheetTitle>
          <SheetDescription className="sr-only">Detailed view of the selected task card.</SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-5">
          {/* Status */}
          <div className="flex items-center gap-3">
            <span className={cn("text-sm font-semibold", statusColor)}>{statusLabel}</span>
            <PriorityBadge priority={card.priority} />
          </div>

          {/* Task */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Task</label>
            <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">{card.task}</p>
          </div>

          {/* Timestamps */}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-muted-foreground">Created</span>
              <p className="text-foreground">{formatDate(card.createdAt)}</p>
            </div>
            {card.startedAt && (
              <div>
                <span className="text-muted-foreground">Started</span>
                <p className="text-foreground">{formatDate(card.startedAt)}</p>
              </div>
            )}
            {card.completedAt && (
              <div>
                <span className="text-muted-foreground">Completed</span>
                <p className="text-foreground">{formatDate(card.completedAt)}</p>
              </div>
            )}
            {card.status === "running" && elapsed && (
              <div>
                <span className="text-muted-foreground">Elapsed</span>
                <p className="text-[#00d4ff]">{elapsed}</p>
              </div>
            )}
          </div>

          {/* Token usage */}
          {card.tokensUsed != null && (
            <div>
              <span className="text-xs text-muted-foreground">Tokens</span>
              <p className="text-sm text-foreground">
                {formatTokens(card.tokensUsed)}
                {card.tokenBudget ? ` / ${formatTokens(card.tokenBudget)}` : ""}
              </p>
              {card.tokenBudget && (
                <Progress
                  value={Math.min(100, (card.tokensUsed / card.tokenBudget) * 100)}
                  className="mt-1 h-1.5 [&>div]:bg-[#00d4ff]"
                />
              )}
            </div>
          )}

          {/* Agent ID */}
          {card.agentId && (
            <div>
              <span className="text-xs text-muted-foreground">Agent ID</span>
              <p className="text-xs font-mono text-foreground/70">{card.agentId}</p>
            </div>
          )}

          {/* Result */}
          {card.result && (
            <div>
              <span className="text-xs text-muted-foreground">Result</span>
              <div className="mt-1 max-h-60 overflow-y-auto rounded-md bg-muted/50 p-3 text-xs text-foreground/80 whitespace-pre-wrap">
                {card.result}
              </div>
            </div>
          )}

          {/* Error */}
          {card.error && (
            <div>
              <span className="text-xs text-muted-foreground">Error</span>
              <div className="mt-1 rounded-md border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-400 whitespace-pre-wrap">
                {card.error}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-border/50">
            {(card.status === "pending" || card.status === "paused" || card.status === "failed") && (
              <Button
                size="sm"
                className="gap-1.5 bg-[#00d4ff] text-black hover:bg-[#00d4ff]/80"
                onClick={() => { onRun(card.id); onOpenChange(false); }}
              >
                <Play className="h-3.5 w-3.5" />
                {card.status === "failed" ? "Retry" : "Run"}
              </Button>
            )}
            {card.status === "running" && (
              <Button
                size="sm"
                variant="destructive"
                className="gap-1.5"
                onClick={() => { onHalt(card.id); onOpenChange(false); }}
              >
                <Square className="h-3.5 w-3.5" /> Halt
              </Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" className="gap-1.5 text-red-400 hover:text-red-300">
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete card?</AlertDialogTitle>
                  <AlertDialogDescription>This card will be permanently removed.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-red-600 hover:bg-red-700"
                    onClick={() => { onDelete(card.id); onOpenChange(false); }}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
