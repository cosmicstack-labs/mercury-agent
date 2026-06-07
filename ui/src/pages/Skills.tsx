import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles,
  Download,
  Loader2,
  Trash2,
  Power,
  PowerOff,
  Package,
  FolderOpen,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";
import api, { type Skill } from "@/lib/api";

/* ── Animations ─────────────────────────────────────────────── */

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.06, duration: 0.35, ease: "easeOut" as const },
  }),
  exit: { opacity: 0, y: -8, transition: { duration: 0.2 } },
};

const stagger = {
  visible: { transition: { staggerChildren: 0.06 } },
};

/* ── Toast-style Feedback ───────────────────────────────────── */

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

function SkillCardSkeleton() {
  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-16 rounded-md" />
        </div>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-3 w-48" />
        <div className="flex gap-2 pt-1">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Main Page ──────────────────────────────────────────────── */

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [installUrl, setInstallUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((type: "success" | "error", message: string) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  const fetchSkills = useCallback(async () => {
    try {
      const res = await api.skills.list();
      setSkills(res.skills);
    } catch (err: unknown) {
      toast("error", err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const handleInstall = async () => {
    if (!installUrl.trim()) return;
    setInstalling(true);
    try {
      const res = await api.skills.install(installUrl.trim());
      toast("success", `Installed "${res.name}" successfully`);
      setInstallUrl("");
      await fetchSkills();
    } catch (err: unknown) {
      toast("error", err instanceof Error ? err.message : "Installation failed");
    } finally {
      setInstalling(false);
    }
  };

  const handleToggle = async (skill: Skill) => {
    setActionLoading((prev) => ({ ...prev, [skill.name]: true }));
    try {
      if (skill.active) {
        await api.skills.deactivate(skill.name);
        toast("success", `Deactivated "${skill.name}"`);
      } else {
        await api.skills.activate(skill.name);
        toast("success", `Activated "${skill.name}"`);
      }
      await fetchSkills();
    } catch (err: unknown) {
      toast("error", err instanceof Error ? err.message : "Toggle failed");
    } finally {
      setActionLoading((prev) => ({ ...prev, [skill.name]: false }));
    }
  };

  const handleDelete = async (name: string) => {
    setActionLoading((prev) => ({ ...prev, [name]: true }));
    try {
      await api.skills.delete(name);
      toast("success", `Deleted "${name}"`);
      await fetchSkills();
    } catch (err: unknown) {
      toast("error", err instanceof Error ? err.message : "Delete failed");
    } finally {
      setActionLoading((prev) => ({ ...prev, [name]: false }));
    }
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#00d4ff]/10">
            <Sparkles className="h-5 w-5 text-[#00d4ff]" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Skills</h1>
            <p className="text-sm text-muted-foreground">
              Extend Mercury with installable capabilities
            </p>
          </div>
        </div>
      </motion.div>

      {/* Install Section */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.3 }}
      >
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <Download className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium text-foreground">
                Install a Skill
              </span>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleInstall();
              }}
              className="flex gap-3"
            >
              <Input
                placeholder="https://github.com/user/skill-package"
                value={installUrl}
                onChange={(e) => setInstallUrl(e.target.value)}
                disabled={installing}
                className="flex-1"
              />
              <Button type="submit" disabled={installing || !installUrl.trim()}>
                {installing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Installing
                  </>
                ) : (
                  "Install"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </motion.div>

      {/* Skills List */}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkillCardSkeleton key={i} />
          ))}
        </div>
      ) : skills.length === 0 ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
        >
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
                <Package className="h-7 w-7 text-muted-foreground" />
              </div>
              <h3 className="text-base font-medium text-foreground mb-1">
                No skills installed
              </h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Install skills from a URL above to extend Mercury&apos;s capabilities
                with new tools, workflows, and integrations.
              </p>
            </CardContent>
          </Card>
        </motion.div>
      ) : (
        <motion.div
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          variants={stagger}
          initial="hidden"
          animate="visible"
        >
          <AnimatePresence mode="popLayout">
            {skills.map((skill, i) => (
              <motion.div
                key={skill.name}
                custom={i}
                variants={fadeUp}
                initial="hidden"
                animate="visible"
                exit="exit"
                layout
              >
                <Card className="h-full">
                  <CardContent className="p-5 flex flex-col gap-3 h-full">
                    {/* Name + Status */}
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-sm font-semibold text-foreground leading-tight">
                        {skill.name}
                      </h3>
                      <Badge variant={skill.active ? "success" : "secondary"}>
                        {skill.active ? "Active" : "Inactive"}
                      </Badge>
                    </div>

                    {/* Description */}
                    {skill.description && (
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {skill.description}
                      </p>
                    )}

                    {/* Path */}
                    <div className="flex items-center gap-1.5 mt-auto">
                      <FolderOpen className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                      <span className="text-xs text-muted-foreground/60 truncate font-mono">
                        {skill.path}
                      </span>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 pt-1 border-t border-border">
                      <Button
                        size="sm"
                        variant={skill.active ? "outline" : "default"}
                        disabled={!!actionLoading[skill.name]}
                        onClick={() => handleToggle(skill)}
                        className="flex-1"
                      >
                        {actionLoading[skill.name] ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : skill.active ? (
                          <>
                            <PowerOff className="h-3.5 w-3.5" />
                            Deactivate
                          </>
                        ) : (
                          <>
                            <Power className="h-3.5 w-3.5" />
                            Activate
                          </>
                        )}
                      </Button>

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!!actionLoading[skill.name]}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete Skill</AlertDialogTitle>
                            <AlertDialogDescription>
                              Are you sure you want to delete &ldquo;{skill.name}&rdquo;?
                              This will remove the skill and all its data permanently.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDelete(skill.name)}
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
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      <ToastBar toasts={toasts} />
    </div>
  );
}
