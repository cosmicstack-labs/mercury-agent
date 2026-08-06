import { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Brain,
  Search,
  Plus,
  Trash2,
  Pencil,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  DatabaseZap,
  Moon,
  Pin,
  Clock,
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
  "identity",
  "preference",
  "goal",
  "project",
  "habit",
  "decision",
  "constraint",
  "relationship",
  "episode",
  "reflection",
] as const;

const TYPE_COLORS: Record<string, string> = {
  identity: "bg-blue-500/15 text-blue-400",
  preference: "bg-purple-500/15 text-purple-400",
  goal: "bg-amber-500/15 text-amber-400",
  project: "bg-cyan-500/15 text-cyan-400",
  habit: "bg-emerald-500/15 text-emerald-400",
  decision: "bg-indigo-500/15 text-indigo-400",
  constraint: "bg-red-500/15 text-red-400",
  relationship: "bg-pink-500/15 text-pink-400",
  episode: "bg-orange-500/15 text-orange-400",
  reflection: "bg-teal-500/15 text-teal-400",
};

const PAGE_SIZE = 30;

/* ── Animations ─────────────────────────────────────────────── */

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.03, duration: 0.25, ease: "easeOut" as const },
  }),
  exit: { opacity: 0, y: -8, transition: { duration: 0.15 } },
};

const stagger = {
  visible: { transition: { staggerChildren: 0.03 } },
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
  const normalized = Math.round(value * 10);
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground/70 shrink-0">Imp</span>
      <div className="flex gap-0.5">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-1.5 w-1.5 rounded-full transition-colors",
              i < normalized
                ? "bg-[#00d4ff]"
                : "bg-muted-foreground/15"
            )}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Scope Badge ────────────────────────────────────────────── */

function ScopeBadge({ scope }: { scope?: string }) {
  if (scope === "durable") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-400/80" title="Durable memory">
        <Pin className="h-3 w-3" />
      </span>
    );
  }
  if (scope === "subconscious") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-violet-400/80" title="Subconscious memory">
        <Moon className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/50" title="Active memory">
      <Clock className="h-3 w-3" />
    </span>
  );
}

/* ── Memory Item ────────────────────────────────────────────── */

function MemoryItem({
  memory,
  onDelete,
  onEdit,
  index,
  showLastSeen,
}: {
  memory: Memory;
  onDelete: (id: string) => void;
  onEdit: (memory: Memory) => void;
  index: number;
  showLastSeen?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const lastSeenDays = memory.lastSeenAt
    ? Math.round((Date.now() - new Date(memory.lastSeenAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;

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
              {/* Type badge + scope + summary */}
              <div className="flex items-start gap-2.5">
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-semibold capitalize",
                    TYPE_COLORS[memory.type] ?? "bg-muted text-muted-foreground"
                  )}
                >
                  {memory.type}
                </span>
                <ScopeBadge scope={memory.scope} />
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
                {memory.evidenceCount != null && memory.evidenceCount > 1 && (
                  <span className="text-xs text-muted-foreground/50">
                    Seen {memory.evidenceCount}x
                  </span>
                )}
                {showLastSeen && lastSeenDays != null && (
                  <span className="text-xs text-violet-400/70">
                    Last seen: {lastSeenDays}d ago
                  </span>
                )}
                <span className="text-xs text-muted-foreground/50">
                  {formatDate(memory.createdAt)}
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-[#00d4ff]"
                onClick={() => onEdit(memory)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
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
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

/* ── Edit Memory Dialog ─────────────────────────────────────── */

function EditMemoryDialog({
  memory,
  open,
  onOpenChange,
  onSave,
  saving,
}: {
  memory: Memory | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (id: string, data: Partial<Memory>) => void;
  saving: boolean;
}) {
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const [confidence, setConfidence] = useState("0.8");
  const [importance, setImportance] = useState("0.7");

  useEffect(() => {
    if (memory) {
      setSummary(memory.summary);
      setDetail(memory.detail || "");
      setConfidence(String(memory.confidence ?? 0.8));
      setImportance(String(memory.importance ?? 0.7));
    }
  }, [memory]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!memory || !summary.trim()) return;
    onSave(memory.id, {
      summary: summary.trim(),
      detail: detail.trim() || undefined,
      confidence: parseFloat(confidence),
      importance: parseFloat(importance),
    });
  };

  if (!memory) return null;

  const lastSeenDays = memory.lastSeenAt
    ? Math.round((Date.now() - new Date(memory.lastSeenAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Memory</DialogTitle>
          <DialogDescription>
            Update this memory entry.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Type + Scope (read-only) */}
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold capitalize",
                TYPE_COLORS[memory.type] ?? "bg-muted text-muted-foreground"
              )}
            >
              {memory.type}
            </span>
            <Badge variant="secondary" className="text-xs capitalize">
              {memory.scope}
            </Badge>
            {lastSeenDays != null && memory.scope === "subconscious" && (
              <span className="text-xs text-violet-400/70">
                Last seen {lastSeenDays}d ago
              </span>
            )}
          </div>

          {/* Summary */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              Summary <span className="text-destructive">*</span>
            </label>
            <Input
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
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={3}
            />
          </div>

          {/* Confidence + Importance row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Confidence (0-1)
              </label>
              <Input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={confidence}
                onChange={(e) => setConfidence(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Importance (0-1)
              </label>
              <Input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={importance}
                onChange={(e) => setImportance(e.target.value)}
              />
            </div>
          </div>

          {/* Timestamps */}
          <div className="flex items-center gap-4 text-xs text-muted-foreground/60">
            <span>Created: {formatDate(memory.createdAt)}</span>
            {memory.updatedAt && <span>Updated: {formatDate(memory.updatedAt)}</span>}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={saving || !summary.trim()}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  const [type, setType] = useState<string>("preference");
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const [confidence, setConfidence] = useState("0.8");
  const [importance, setImportance] = useState("0.7");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!summary.trim()) return;
    onSubmit({
      type,
      summary: summary.trim(),
      detail: detail.trim() || undefined,
      confidence: parseFloat(confidence),
      importance: parseFloat(importance),
      durability: "0.8",
    });
  };

  const reset = () => {
    setType("preference");
    setSummary("");
    setDetail("");
    setConfidence("0.8");
    setImportance("0.7");
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
                Confidence (0-1)
              </label>
              <Input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={confidence}
                onChange={(e) => setConfidence(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Importance (0-1)
              </label>
              <Input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={importance}
                onChange={(e) => setImportance(e.target.value)}
              />
            </div>
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

/* ── Collapsible Section ────────────────────────────────────── */

function MemorySection({
  title,
  icon,
  count,
  defaultOpen,
  children,
  actions,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  defaultOpen: boolean;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="space-y-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-left group"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform" />
        )}
        <span className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-semibold text-foreground">{title}</span>
        </span>
        <Badge variant="secondary" className="tabular-nums text-xs">
          {count}
        </Badge>
        {actions && <div className="ml-auto" onClick={(e) => e.stopPropagation()}>{actions}</div>}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Main Page ──────────────────────────────────────────────── */

export function MemoryPage() {
  const [consciousMemories, setConsciousMemories] = useState<Memory[]>([]);
  const [subconsciousMemories, setSubconsciousMemories] = useState<Memory[]>([]);
  const [consciousTotal, setConsciousTotal] = useState(0);
  const [subconsciousTotal, setSubconsciousTotal] = useState(0);
  const [brainStatus, setBrainStatus] = useState<BrainStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMoreConscious, setLoadingMoreConscious] = useState(false);
  const [loadingMoreSubconscious, setLoadingMoreSubconscious] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editMemory, setEditMemory] = useState<Memory | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
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

  /* Fetch memories for both sections */
  const fetchMemories = useCallback(
    async (section: "conscious" | "subconscious" | "both", offset = 0, append = false) => {
      try {
        if (!append) setLoading(true);
        setError(null);

        if (section === "conscious" || section === "both") {
          if (append) setLoadingMoreConscious(true);

          let result: { memories: Memory[]; total: number };
          if (query.trim()) {
            // Search conscious
            result = await api.brain.memory.list({
              limit: PAGE_SIZE,
              offset: section === "conscious" ? offset : 0,
              q: query.trim(),
              scope: "conscious",
            });
          } else {
            const typeParam = activeTypes.size === 1 ? Array.from(activeTypes)[0] : undefined;
            result = await api.brain.memory.list({
              limit: PAGE_SIZE,
              offset: section === "conscious" ? offset : 0,
              type: typeParam,
              scope: "conscious",
            });
          }

          let filtered = result.memories;
          if (activeTypes.size > 1 && !query.trim()) {
            filtered = filtered.filter((m) => activeTypes.has(m.type));
          }

          if (append && section === "conscious") {
            setConsciousMemories((prev) => [...prev, ...filtered]);
          } else {
            setConsciousMemories(filtered);
          }
          setConsciousTotal(result.total);
          setLoadingMoreConscious(false);
        }

        if (section === "subconscious" || section === "both") {
          if (append) setLoadingMoreSubconscious(true);

          let result: { memories: Memory[]; total: number };
          if (query.trim()) {
            // Search subconscious — use the main list endpoint with scope
            result = await api.brain.memory.list({
              limit: PAGE_SIZE,
              offset: section === "subconscious" ? offset : 0,
              q: query.trim(),
              scope: "subconscious",
            });
          } else {
            result = await api.brain.memory.list({
              limit: PAGE_SIZE,
              offset: section === "subconscious" ? offset : 0,
              scope: "subconscious",
            });
          }

          if (append && section === "subconscious") {
            setSubconsciousMemories((prev) => [...prev, ...result.memories]);
          } else {
            setSubconsciousMemories(result.memories);
          }
          setSubconsciousTotal(result.total);
          setLoadingMoreSubconscious(false);
        }
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : "Failed to load memories"
        );
      } finally {
        setLoading(false);
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
      fetchMemories("both", 0, false);
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

  /* Create memory */
  const handleCreate = async (data: MemoryCreate) => {
    setSubmitting(true);
    try {
      await api.brain.memory.create(data);
      toast("success", "Memory created");
      setDialogOpen(false);
      fetchMemories("both", 0, false);
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
      setConsciousMemories((prev) => prev.filter((m) => m.id !== id));
      setSubconsciousMemories((prev) => prev.filter((m) => m.id !== id));
      toast("success", "Memory deleted");
      fetchStatus();
    } catch (err: unknown) {
      toast("error", err instanceof Error ? err.message : "Failed to delete");
    }
  };

  /* Edit memory */
  const handleEdit = (memory: Memory) => {
    setEditMemory(memory);
    setEditOpen(true);
  };

  const handleSave = async (id: string, data: Partial<Memory>) => {
    setSaving(true);
    try {
      await api.brain.memory.update(id, data);
      toast("success", "Memory updated");
      setEditOpen(false);
      setEditMemory(null);
      // Update in-place
      const updater = (prev: Memory[]) =>
        prev.map((m) => (m.id === id ? { ...m, ...data } : m));
      setConsciousMemories(updater);
      setSubconsciousMemories(updater);
    } catch (err: unknown) {
      toast("error", err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  const hasMoreConscious = consciousMemories.length < consciousTotal;
  const hasMoreSubconscious = subconsciousMemories.length < subconsciousTotal;

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
                <div className="flex items-center gap-1.5">
                  <Badge variant="secondary" className="tabular-nums">
                    {brainStatus.total} conscious
                  </Badge>
                  <Badge variant="secondary" className="tabular-nums text-violet-400">
                    {brainStatus.subconsciousTotal ?? 0} subconscious
                  </Badge>
                </div>
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
          placeholder="Search across all memories..."
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
                {count > 0 && (
                  <span
                    className={cn(
                      "tabular-nums",
                      active ? "text-[#00d4ff]/70" : "text-muted-foreground/50"
                    )}
                  >
                    {count}
                  </span>
                )}
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
              onClick={() => fetchMemories("both", 0, false)}
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

      {/* Memory sections */}
      {!loading && !error && (
        <div className="space-y-6">
          {/* Conscious Section */}
          <MemorySection
            title="Conscious"
            icon={<Brain className="h-4 w-4 text-[#00d4ff]" />}
            count={consciousTotal}
            defaultOpen={true}
          >
            {consciousMemories.length > 0 ? (
              <div className="space-y-3">
                <motion.div
                  className="space-y-3"
                  variants={stagger}
                  initial="hidden"
                  animate="visible"
                >
                  <AnimatePresence mode="popLayout">
                    {consciousMemories.map((memory, i) => (
                      <MemoryItem
                        key={memory.id}
                        memory={memory}
                        onDelete={handleDelete}
                        onEdit={handleEdit}
                        index={i}
                      />
                    ))}
                  </AnimatePresence>
                </motion.div>
                {hasMoreConscious && (
                  <div className="flex justify-center pt-2">
                    <Button
                      variant="outline"
                      onClick={() => fetchMemories("conscious", consciousMemories.length, true)}
                      disabled={loadingMoreConscious}
                    >
                      {loadingMoreConscious ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading...
                        </>
                      ) : (
                        <>
                          <ChevronDown className="h-4 w-4" />
                          Load More ({consciousMemories.length} / {consciousTotal})
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-10 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-3">
                    <DatabaseZap className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {query.trim()
                      ? "No conscious memories match your search."
                      : "No conscious memories yet. Start a conversation or add one manually."}
                  </p>
                </CardContent>
              </Card>
            )}
          </MemorySection>

          {/* Subconscious Section */}
          <MemorySection
            title="Subconscious"
            icon={<Moon className="h-4 w-4 text-violet-400" />}
            count={subconsciousTotal}
            defaultOpen={false}
          >
            {subconsciousMemories.length > 0 ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground/70 px-1">
                  Dormant memories not referenced in 30+ days. Automatically recalled when relevant.
                </p>
                <motion.div
                  className="space-y-3"
                  variants={stagger}
                  initial="hidden"
                  animate="visible"
                >
                  <AnimatePresence mode="popLayout">
                    {subconsciousMemories.map((memory, i) => (
                      <MemoryItem
                        key={memory.id}
                        memory={memory}
                        onDelete={handleDelete}
                        onEdit={handleEdit}
                        index={i}
                        showLastSeen
                      />
                    ))}
                  </AnimatePresence>
                </motion.div>
                {hasMoreSubconscious && (
                  <div className="flex justify-center pt-2">
                    <Button
                      variant="outline"
                      onClick={() => fetchMemories("subconscious", subconsciousMemories.length, true)}
                      disabled={loadingMoreSubconscious}
                    >
                      {loadingMoreSubconscious ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading...
                        </>
                      ) : (
                        <>
                          <ChevronDown className="h-4 w-4" />
                          Load More ({subconsciousMemories.length} / {subconsciousTotal})
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-10 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-3">
                    <Moon className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {query.trim()
                      ? "No subconscious memories match your search."
                      : "No subconscious memories yet. Memories move here after 30 days of not being referenced."}
                  </p>
                </CardContent>
              </Card>
            )}
          </MemorySection>
        </div>
      )}

      {/* Dialogs */}
      <AddMemoryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
        submitting={submitting}
      />

      <EditMemoryDialog
        memory={editMemory}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSave={handleSave}
        saving={saving}
      />

      <ToastBar toasts={toasts} />
    </div>
  );
}
