import { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Brain,
  Search,
  Plus,
  Trash2,
  ChevronDown,
  Loader2,
  CheckCircle2,
  XCircle,
  DatabaseZap,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { cn, formatDate } from "@/lib/utils";
import api, { type Memory, type BrainStatus, type MemoryCreate } from "@/lib/api";

/* ── Constants ─────────────────────────────────────────────── */

const MEMORY_TYPES = [
  "fact",
  "preference",
  "experience",
  "goal",
  "project",
  "person",
  "skill",
  "belief",
  "observation",
] as const;

const TYPE_COLORS: Record<string, string> = {
  fact: "bg-blue-500/15 text-blue-400",
  preference: "bg-purple-500/15 text-purple-400",
  experience: "bg-emerald-500/15 text-emerald-400",
  goal: "bg-amber-500/15 text-amber-400",
  project: "bg-cyan-500/15 text-cyan-400",
  person: "bg-pink-500/15 text-pink-400",
  skill: "bg-indigo-500/15 text-indigo-400",
  belief: "bg-orange-500/15 text-orange-400",
  observation: "bg-teal-500/15 text-teal-400",
};

const DURABILITY_OPTIONS = ["temporary", "short", "long", "permanent"] as const;
const PAGE_SIZE = 50;

/* ── Animations ─────────────────────────────────────────────── */

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.04, duration: 0.3, ease: "easeOut" as const },
  }),
  exit: { opacity: 0, y: -8, transition: { duration: 0.2 } },
};

const stagger = {
  visible: { transition: { staggerChildren: 0.04 } },
};

/* ── Toast ──────────────────────────────────────────────────── */

interface Toast {
  id: number;
  type: "success" | "error";
  message: string;
}

function ToastBar({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur-sm",
              t.type === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            )}
          >
            {t.type === "success" ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ── Skeleton ───────────────────────────────────────────────── */

function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-lg bg-muted", className)} />
  );
}

function MemoryCardSkeleton() {
  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-20 rounded-md" />
          <Skeleton className="h-4 w-full" />
        </div>
        <Skeleton className="h-3 w-3/4" />
        <div className="flex items-center gap-4">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Importance Bar ─────────────────────────────────────────── */

function ImportanceBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground/70 shrink-0">Imp</span>
      <div className="flex gap-0.5">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-1.5 w-1.5 rounded-full transition-colors",
              i < value
                ? "bg-[#00d4ff]"
                : "bg-muted-foreground/15"
            )}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Memory Item ────────────────────────────────────────────── */

function MemoryItem({
  memory,
  onDelete,
  index,
}: {
  memory: Memory;
  onDelete: (id: string) => void;
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <motion.div
      custom={index}
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      exit="exit"
      layout
    >
      <Card className="group transition-colors hover:border-[#00d4ff]/20">
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-3">
            {/* Left content */}
            <div className="flex-1 min-w-0 space-y-2">
              {/* Type badge + summary */}
              <div className="flex items-start gap-2.5">
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-semibold capitalize",
                    TYPE_COLORS[memory.type] ?? "bg-muted text-muted-foreground"
                  )}
                >
                  {memory.type}
                </span>
                <p className="text-sm font-medium text-foreground leading-relaxed">
                  {memory.summary}
                </p>
              </div>

              {/* Detail */}
              {memory.detail && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="w-full text-left"
                >
                  <p
                    className={cn(
                      "text-sm text-muted-foreground leading-relaxed transition-all",
                      !expanded && "line-clamp-2"
                    )}
                  >
                    {memory.detail}
                  </p>
                  {memory.detail.length > 120 && (
                    <span className="text-xs text-[#00d4ff]/70 hover:text-[#00d4ff] mt-0.5 inline-block">
                      {expanded ? "Show less" : "Show more"}
                    </span>
                  )}
                </button>
              )}

              {/* Meta row */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1">
                {memory.importance != null && (
                  <ImportanceBar value={memory.importance} />
                )}
                {memory.confidence != null && (
                  <span className="text-xs text-muted-foreground/70">
                    {Math.round(memory.confidence * 100)}% conf
                  </span>
                )}
                {memory.durability && (
                  <span className="text-xs text-muted-foreground/50 capitalize">
                    {memory.durability}
                  </span>
                )}
                <span className="text-xs text-muted-foreground/50">
                  {formatDate(memory.createdAt)}
                </span>
              </div>
            </div>

            {/* Delete */}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Memory</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete this memory? This action
                    cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => onDelete(memory.id)}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

/* ── Add Memory Dialog ──────────────────────────────────────── */

function AddMemoryDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: MemoryCreate) => void;
  submitting: boolean;
}) {
  const [type, setType] = useState<string>("fact");
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const [confidence, setConfidence] = useState("0.8");
  const [importance, setImportance] = useState("5");
  const [durability, setDurability] = useState("long");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!summary.trim()) return;
    onSubmit({
      type,
      summary: summary.trim(),
      detail: detail.trim() || undefined,
      confidence: parseFloat(confidence),
      importance: parseInt(importance),
      durability,
    });
  };

  const reset = () => {
    setType("fact");
    setSummary("");
    setDetail("");
    setConfidence("0.8");
    setImportance("5");
    setDurability("long");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Memory</DialogTitle>
          <DialogDescription>
            Create a new memory entry in the Second Brain.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Type */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Type</label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEMORY_TYPES.map((t) => (
                  <SelectItem key={t} value={t} className="capitalize">
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Summary */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              Summary <span className="text-destructive">*</span>
            </label>
            <Input
              placeholder="What should Mercury remember?"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              required
            />
          </div>

          {/* Detail */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              Detail
            </label>
            <Textarea
              placeholder="Additional context or details..."
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={3}
            />
          </div>

          {/* Confidence + Importance row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Confidence (0–1)
              </label>
              <Input
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={confidence}
                onChange={(e) => setConfidence(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Importance (1–10)
              </label>
              <Input
                type="number"
                min="1"
                max="10"
                step="1"
                value={importance}
                onChange={(e) => setImportance(e.target.value)}
              />
            </div>
          </div>

          {/* Durability */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              Durability
            </label>
            <Select value={durability} onValueChange={setDurability}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURABILITY_OPTIONS.map((d) => (
                  <SelectItem key={d} value={d} className="capitalize">
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={submitting || !summary.trim()}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Add Memory"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Main Page ──────────────────────────────────────────────── */

export function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [brainStatus, setBrainStatus] = useState<BrainStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const toast = useCallback((type: "success" | "error", message: string) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  /* Fetch brain status */
  const fetchStatus = useCallback(async () => {
    try {
      const s = await api.brain.status();
      setBrainStatus(s);
    } catch {
      // non-critical
    }
  }, []);

  /* Fetch memories */
  const fetchMemories = useCallback(
    async (offset = 0, append = false) => {
      try {
        if (!append) setLoading(true);
        else setLoadingMore(true);
        setError(null);

        let result: { memories: Memory[]; total: number };

        if (query.trim()) {
          result = await api.brain.memory.search(query.trim(), PAGE_SIZE);
        } else {
          // If multiple types active, we need to filter client-side or make multiple calls
          // API accepts single type param — if one type active use it, otherwise fetch all
          const typeParam =
            activeTypes.size === 1
              ? Array.from(activeTypes)[0]
              : undefined;
          result = await api.brain.memory.list({
            limit: PAGE_SIZE,
            offset,
            type: typeParam,
          });
        }

        let filtered = result.memories;
        // Client-side multi-type filter when >1 type selected and not searching
        if (activeTypes.size > 1 && !query.trim()) {
          filtered = filtered.filter((m) => activeTypes.has(m.type));
        }

        if (append) {
          setMemories((prev) => [...prev, ...filtered]);
        } else {
          setMemories(filtered);
        }
        setTotal(result.total);
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : "Failed to load memories"
        );
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [query, activeTypes]
  );

  /* Initial load */
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  /* Debounced search + filter */
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchMemories(0, false);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [fetchMemories]);

  /* Toggle type filter */
  const toggleType = (type: string) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  /* Load more */
  const handleLoadMore = () => {
    fetchMemories(memories.length, true);
  };

  /* Create memory */
  const handleCreate = async (data: MemoryCreate) => {
    setSubmitting(true);
    try {
      await api.brain.memory.create(data);
      toast("success", "Memory created");
      setDialogOpen(false);
      fetchMemories(0, false);
      fetchStatus();
    } catch (err: unknown) {
      toast("error", err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSubmitting(false);
    }
  };

  /* Delete memory */
  const handleDelete = async (id: string) => {
    try {
      await api.brain.memory.delete(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
      setTotal((prev) => prev - 1);
      toast("success", "Memory deleted");
      fetchStatus();
    } catch (err: unknown) {
      toast("error", err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const hasMore = memories.length < total;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex items-start justify-between gap-4"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#00d4ff]/10">
            <Brain className="h-5 w-5 text-[#00d4ff]" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-semibold text-foreground">Memory</h1>
              {brainStatus && (
                <Badge variant="secondary" className="tabular-nums">
                  {brainStatus.total.toLocaleString()}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Browse and manage Mercury&apos;s knowledge
            </p>
          </div>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          Add Memory
        </Button>
      </motion.div>

      {/* Search */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05, duration: 0.3 }}
        className="relative"
      >
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search memories..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
      </motion.div>

      {/* Type filter chips */}
      {brainStatus && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.3 }}
          className="flex flex-wrap gap-2"
        >
          {MEMORY_TYPES.map((type) => {
            const count = brainStatus.byType?.[type] ?? 0;
            const active = activeTypes.has(type);
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium capitalize transition-all",
                  active
                    ? "border-[#00d4ff]/40 bg-[#00d4ff]/10 text-[#00d4ff]"
                    : "border-border bg-secondary/50 text-muted-foreground hover:border-border hover:bg-secondary"
                )}
              >
                {type}
                <span
                  className={cn(
                    "tabular-nums",
                    active ? "text-[#00d4ff]/70" : "text-muted-foreground/50"
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </motion.div>
      )}

      {/* Error state */}
      {error && (
        <Card className="border-destructive/30">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
            <XCircle className="h-4 w-4 shrink-0" />
            {error}
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => fetchMemories(0, false)}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <MemoryCardSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Memory list */}
      {!loading && !error && memories.length > 0 && (
        <motion.div
          className="space-y-3"
          variants={stagger}
          initial="hidden"
          animate="visible"
        >
          <AnimatePresence mode="popLayout">
            {memories.map((memory, i) => (
              <MemoryItem
                key={memory.id}
                memory={memory}
                onDelete={handleDelete}
                index={i}
              />
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {/* Empty state */}
      {!loading && !error && memories.length === 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
        >
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
                <DatabaseZap className="h-7 w-7 text-muted-foreground" />
              </div>
              <h3 className="text-base font-medium text-foreground mb-1">
                {query.trim() ? "No memories found" : "No memories yet"}
              </h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                {query.trim()
                  ? "Try a different search term or adjust your filters."
                  : "Mercury's Second Brain is empty. Add a memory to get started."}
              </p>
              {!query.trim() && (
                <Button
                  className="mt-4"
                  onClick={() => setDialogOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  Add First Memory
                </Button>
              )}
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Load more */}
      {!loading && hasMore && memories.length > 0 && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            onClick={handleLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading...
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4" />
                Load More ({memories.length} / {total})
              </>
            )}
          </Button>
        </div>
      )}

      {/* Add dialog */}
      <AddMemoryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
        submitting={submitting}
      />

      <ToastBar toasts={toasts} />
    </div>
  );
}
