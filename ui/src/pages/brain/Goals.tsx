import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Target,
  FolderKanban,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  Rocket,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
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
import { cn, formatDate } from "@/lib/utils";
import api, { type Memory, type MemoryCreate } from "@/lib/api";

/* ── Animations ─────────────────────────────────────────────── */

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.05, duration: 0.3, ease: "easeOut" as const },
  }),
  exit: { opacity: 0, y: -8, transition: { duration: 0.2 } },
};

const stagger = {
  visible: { transition: { staggerChildren: 0.05 } },
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

function ItemCardSkeleton() {
  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Priority Indicator ─────────────────────────────────────── */

function PriorityIndicator({ importance }: { importance: number }) {
  const label =
    importance >= 8
      ? "Critical"
      : importance >= 6
        ? "High"
        : importance >= 4
          ? "Medium"
          : "Low";
  const color =
    importance >= 8
      ? "text-red-400 bg-red-500/15"
      : importance >= 6
        ? "text-amber-400 bg-amber-500/15"
        : importance >= 4
          ? "text-[#00d4ff] bg-[#00d4ff]/15"
          : "text-muted-foreground bg-muted";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        color
      )}
    >
      {label}
    </span>
  );
}

/* ── Item Card ──────────────────────────────────────────────── */

function ItemCard({
  item,
  onDelete,
  index,
  kind,
}: {
  item: Memory;
  onDelete: (id: string) => void;
  index: number;
  kind: "goal" | "project";
}) {
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
            <div className="flex-1 min-w-0 space-y-2">
              {/* Title row */}
              <div className="flex items-center gap-2.5">
                {kind === "goal" ? (
                  <Target className="h-4 w-4 text-amber-400 shrink-0" />
                ) : (
                  <FolderKanban className="h-4 w-4 text-cyan-400 shrink-0" />
                )}
                <h3 className="text-sm font-semibold text-foreground leading-tight">
                  {item.summary}
                </h3>
              </div>

              {/* Detail */}
              {item.detail && (
                <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3">
                  {item.detail}
                </p>
              )}

              {/* Meta */}
              <div className="flex flex-wrap items-center gap-3 pt-0.5">
                {item.importance != null && (
                  <PriorityIndicator importance={item.importance} />
                )}
                <span className="text-xs text-muted-foreground/50">
                  {formatDate(item.createdAt)}
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
                  <AlertDialogTitle>
                    Delete {kind === "goal" ? "Goal" : "Project"}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete this{" "}
                    {kind === "goal" ? "goal" : "project"}? This action cannot
                    be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => onDelete(item.id)}
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

/* ── Add Dialog ─────────────────────────────────────────────── */

function AddItemDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
  kind,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: MemoryCreate) => void;
  submitting: boolean;
  kind: "goal" | "project";
}) {
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const [importance, setImportance] = useState("5");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!summary.trim()) return;
    onSubmit({
      type: kind,
      summary: summary.trim(),
      detail: detail.trim() || undefined,
      importance: parseInt(importance),
    });
  };

  const reset = () => {
    setSummary("");
    setDetail("");
    setImportance("5");
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
          <DialogTitle>
            Add {kind === "goal" ? "Goal" : "Project"}
          </DialogTitle>
          <DialogDescription>
            Create a new {kind === "goal" ? "goal" : "project"} in the Second
            Brain.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              Summary <span className="text-destructive">*</span>
            </label>
            <Input
              placeholder={
                kind === "goal"
                  ? "What do you want to achieve?"
                  : "What are you working on?"
              }
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              Detail
            </label>
            <Textarea
              placeholder="Additional context..."
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={3}
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

          <DialogFooter>
            <Button type="submit" disabled={submitting || !summary.trim()}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                `Add ${kind === "goal" ? "Goal" : "Project"}`
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Tab Content ────────────────────────────────────────────── */

function TabSection({
  items,
  loading,
  error,
  kind,
  onDelete,
  onRetry,
  onAdd,
}: {
  items: Memory[];
  loading: boolean;
  error: string | null;
  kind: "goal" | "project";
  onDelete: (id: string) => void;
  onRetry: () => void;
  onAdd: () => void;
}) {
  if (error) {
    return (
      <Card className="border-destructive/30">
        <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
          <XCircle className="h-4 w-4 shrink-0" />
          {error}
          <Button size="sm" variant="outline" className="ml-auto" onClick={onRetry}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <ItemCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
            {kind === "goal" ? (
              <Target className="h-7 w-7 text-muted-foreground" />
            ) : (
              <Rocket className="h-7 w-7 text-muted-foreground" />
            )}
          </div>
          <h3 className="text-base font-medium text-foreground mb-1">
            No {kind === "goal" ? "goals" : "projects"} yet
          </h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            {kind === "goal"
              ? "Add goals to help Mercury understand what you're working towards."
              : "Track active projects so Mercury can provide better context."}
          </p>
          <Button className="mt-4" onClick={onAdd}>
            <Plus className="h-4 w-4" />
            Add {kind === "goal" ? "Goal" : "Project"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <motion.div
      className="space-y-3"
      variants={stagger}
      initial="hidden"
      animate="visible"
    >
      <AnimatePresence mode="popLayout">
        {items.map((item, i) => (
          <ItemCard
            key={item.id}
            item={item}
            onDelete={onDelete}
            index={i}
            kind={kind}
          />
        ))}
      </AnimatePresence>
    </motion.div>
  );
}

/* ── Main Page ──────────────────────────────────────────────── */

export function GoalsPage() {
  const [goals, setGoals] = useState<Memory[]>([]);
  const [projects, setProjects] = useState<Memory[]>([]);
  const [goalsLoading, setGoalsLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [goalsError, setGoalsError] = useState<string | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogKind, setDialogKind] = useState<"goal" | "project">("goal");
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState("goals");
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((type: "success" | "error", message: string) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  const fetchGoals = useCallback(async () => {
    try {
      setGoalsLoading(true);
      setGoalsError(null);
      const res = await api.brain.memory.list({ type: "goal" });
      setGoals(res.memories);
    } catch (err: unknown) {
      setGoalsError(
        err instanceof Error ? err.message : "Failed to load goals"
      );
    } finally {
      setGoalsLoading(false);
    }
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      setProjectsLoading(true);
      setProjectsError(null);
      const res = await api.brain.memory.list({ type: "project" });
      setProjects(res.memories);
    } catch (err: unknown) {
      setProjectsError(
        err instanceof Error ? err.message : "Failed to load projects"
      );
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGoals();
    fetchProjects();
  }, [fetchGoals, fetchProjects]);

  const openDialog = (kind: "goal" | "project") => {
    setDialogKind(kind);
    setDialogOpen(true);
  };

  const handleCreate = async (data: MemoryCreate) => {
    setSubmitting(true);
    try {
      await api.brain.memory.create(data);
      toast("success", `${data.type === "goal" ? "Goal" : "Project"} created`);
      setDialogOpen(false);
      if (data.type === "goal") fetchGoals();
      else fetchProjects();
    } catch (err: unknown) {
      toast("error", err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteGoal = async (id: string) => {
    try {
      await api.brain.memory.delete(id);
      setGoals((prev) => prev.filter((g) => g.id !== id));
      toast("success", "Goal deleted");
    } catch (err: unknown) {
      toast("error", err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const handleDeleteProject = async (id: string) => {
    try {
      await api.brain.memory.delete(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
      toast("success", "Project deleted");
    } catch (err: unknown) {
      toast("error", err instanceof Error ? err.message : "Failed to delete");
    }
  };

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
            <Target className="h-5 w-5 text-[#00d4ff]" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-semibold text-foreground">
                Goals &amp; Projects
              </h1>
              <Badge variant="secondary" className="tabular-nums">
                {goals.length + projects.length}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Track objectives and active initiatives
            </p>
          </div>
        </div>
        <Button
          onClick={() =>
            openDialog(activeTab === "goals" ? "goal" : "project")
          }
        >
          <Plus className="h-4 w-4" />
          Add {activeTab === "goals" ? "Goal" : "Project"}
        </Button>
      </motion.div>

      {/* Tabs */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.3 }}
      >
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="space-y-4"
        >
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="goals" className="gap-1.5">
              <Target className="h-3.5 w-3.5" />
              Goals
              {!goalsLoading && (
                <span className="ml-1 text-xs text-muted-foreground/60 tabular-nums">
                  ({goals.length})
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="projects" className="gap-1.5">
              <FolderKanban className="h-3.5 w-3.5" />
              Projects
              {!projectsLoading && (
                <span className="ml-1 text-xs text-muted-foreground/60 tabular-nums">
                  ({projects.length})
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="goals">
            <TabSection
              items={goals}
              loading={goalsLoading}
              error={goalsError}
              kind="goal"
              onDelete={handleDeleteGoal}
              onRetry={fetchGoals}
              onAdd={() => openDialog("goal")}
            />
          </TabsContent>

          <TabsContent value="projects">
            <TabSection
              items={projects}
              loading={projectsLoading}
              error={projectsError}
              kind="project"
              onDelete={handleDeleteProject}
              onRetry={fetchProjects}
              onAdd={() => openDialog("project")}
            />
          </TabsContent>
        </Tabs>
      </motion.div>

      {/* Add dialog */}
      <AddItemDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
        submitting={submitting}
        kind={dialogKind}
      />

      <ToastBar toasts={toasts} />
    </div>
  );
}
