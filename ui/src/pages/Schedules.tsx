import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Clock,
  Pencil,
  Trash2,
  Calendar,
  Timer,
  Sparkles,
  AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { cn, formatDate, truncate } from "@/lib/utils";
import api, { type Schedule } from "@/lib/api";

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.07, duration: 0.35, ease: "easeOut" as const },
  }),
};

function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-lg bg-muted", className)} />
  );
}

function humanizeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hour, dom, , dow] = parts;

  if (cron === "* * * * *") return "Every minute";
  if (min === "0" && hour === "*") return "Every hour";
  if (min === "*/5" && hour === "*") return "Every 5 minutes";
  if (min === "*/10" && hour === "*") return "Every 10 minutes";
  if (min === "*/15" && hour === "*") return "Every 15 minutes";
  if (min === "*/30" && hour === "*") return "Every 30 minutes";
  if (dom === "*" && dow === "*" && hour !== "*" && min !== "*")
    return `Daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  if (dow === "1-5" && hour !== "*")
    return `Weekdays at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  return cron;
}

function humanizeDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s delay`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m delay`;
  return `${(seconds / 3600).toFixed(1)}h delay`;
}

interface EditForm {
  description: string;
  cron: string;
  delaySeconds: string;
  prompt: string;
  skillName: string;
}

export function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    description: "",
    cron: "",
    delaySeconds: "",
    prompt: "",
    skillName: "",
  });
  const [saving, setSaving] = useState(false);

  // Delete dialog state
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.schedules
      .list()
      .then((res) => {
        setSchedules(res.schedules);
        setError("");
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-dismiss feedback
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(t);
  }, [feedback]);

  function openEdit(schedule: Schedule) {
    setEditId(schedule.id);
    setEditForm({
      description: schedule.description,
      cron: schedule.cron ?? "",
      delaySeconds: schedule.delaySeconds?.toString() ?? "",
      prompt: schedule.prompt ?? "",
      skillName: schedule.skillName ?? "",
    });
    setEditOpen(true);
  }

  async function handleSave() {
    if (!editId) return;
    setSaving(true);
    try {
      const payload: Partial<Schedule> = {
        description: editForm.description,
      };
      if (editForm.cron.trim()) payload.cron = editForm.cron.trim();
      if (editForm.delaySeconds.trim())
        payload.delaySeconds = Number(editForm.delaySeconds);
      if (editForm.prompt.trim()) payload.prompt = editForm.prompt.trim();
      if (editForm.skillName.trim())
        payload.skillName = editForm.skillName.trim();

      const res = await api.schedules.update(editId, payload);
      if (res.success) {
        setSchedules((prev) =>
          prev.map((s) => (s.id === editId ? { ...s, ...res.schedule } : s))
        );
        setFeedback({ type: "success", message: "Schedule updated" });
        setEditOpen(false);
      }
    } catch (err) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Update failed",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await api.schedules.delete(deleteId);
      if (res.success) {
        setSchedules((prev) => prev.filter((s) => s.id !== deleteId));
        setFeedback({ type: "success", message: "Schedule deleted" });
      }
    } catch (err) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Delete failed",
      });
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  }

  if (error && !schedules.length) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6 p-6 lg:p-8">
        <div className="space-y-1">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[140px]" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 lg:p-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <h1 className="text-2xl font-bold tracking-tight">Schedules</h1>
        <p className="text-sm text-muted-foreground">
          Automated recurring tasks
        </p>
      </motion.div>

      {/* Feedback toast */}
      <AnimatePresence>
        {feedback && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={cn(
              "rounded-lg border px-4 py-2.5 text-sm font-medium",
              feedback.type === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            )}
          >
            {feedback.message}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Empty state */}
      {schedules.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3 }}
        >
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Clock className="mb-4 h-10 w-10 text-muted-foreground/50" />
              <p className="text-lg font-medium text-muted-foreground">
                No scheduled tasks
              </p>
              <p className="mt-1 text-sm text-muted-foreground/70">
                Schedules will appear here once configured via the API or CLI.
              </p>
            </CardContent>
          </Card>
        </motion.div>
      ) : (
        <div className="flex flex-col gap-4">
          {schedules.map((schedule, idx) => (
            <motion.div
              key={schedule.id}
              custom={idx}
              variants={fadeUp}
              initial="hidden"
              animate="visible"
            >
              <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <CardTitle className="text-base">
                      {schedule.description}
                    </CardTitle>
                    <div className="flex flex-wrap items-center gap-2">
                      {schedule.cron && (
                        <Badge variant="secondary" className="gap-1">
                          <Calendar className="h-3 w-3" />
                          {humanizeCron(schedule.cron)}
                        </Badge>
                      )}
                      {schedule.delaySeconds != null && (
                        <Badge variant="secondary" className="gap-1">
                          <Timer className="h-3 w-3" />
                          {humanizeDelay(schedule.delaySeconds)}
                        </Badge>
                      )}
                      {schedule.skillName && (
                        <Badge variant="default" className="gap-1">
                          <Sparkles className="h-3 w-3" />
                          {schedule.skillName}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(schedule)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteId(schedule.id)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-2 text-sm">
                    {schedule.prompt && (
                      <p className="text-muted-foreground">
                        <span className="font-medium text-foreground">Prompt: </span>
                        {truncate(schedule.prompt, 100)}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                      {schedule.lastRun && (
                        <span>
                          Last run:{" "}
                          <span className="font-medium tabular-nums text-foreground">
                            {formatDate(schedule.lastRun)}
                          </span>
                        </span>
                      )}
                      {schedule.nextRun && (
                        <span>
                          Next run:{" "}
                          <span className="font-medium tabular-nums text-foreground">
                            {formatDate(schedule.nextRun)}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Schedule</DialogTitle>
            <DialogDescription>
              Update the schedule configuration.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Description</label>
              <Input
                value={editForm.description}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder="Schedule description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Cron Expression</label>
                <Input
                  value={editForm.cron}
                  onChange={(e) =>
                    setEditForm((f) => ({ ...f, cron: e.target.value }))
                  }
                  placeholder="*/30 * * * *"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Delay (seconds)</label>
                <Input
                  type="number"
                  value={editForm.delaySeconds}
                  onChange={(e) =>
                    setEditForm((f) => ({ ...f, delaySeconds: e.target.value }))
                  }
                  placeholder="3600"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Prompt</label>
              <Input
                value={editForm.prompt}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, prompt: e.target.value }))
                }
                placeholder="Optional prompt text"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Skill Name</label>
              <Input
                value={editForm.skillName}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, skillName: e.target.value }))
                }
                placeholder="Optional skill name"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !editForm.description.trim()}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Schedule
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The scheduled task will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
