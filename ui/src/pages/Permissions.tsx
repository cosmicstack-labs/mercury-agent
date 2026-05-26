import { useEffect, useState, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield,
  Save,
  Loader2,
  HardDrive,
  Terminal,
  GitBranch,
  CheckCircle2,
  XCircle,
  Info,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import api from "@/lib/api";

/* ── Animations ─────────────────────────────────────────────── */

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.08, duration: 0.35, ease: "easeOut" as const },
  }),
};

/* ── Permission Metadata ────────────────────────────────────── */

interface PermMeta {
  icon: React.ElementType;
  label: string;
  description: string;
  permissions: Record<string, { label: string; description: string }>;
}

const CAPABILITY_META: Record<string, PermMeta> = {
  filesystem: {
    icon: HardDrive,
    label: "Filesystem",
    description: "Access to read, write, and manage files on the local system",
    permissions: {
      read: {
        label: "Read Files",
        description: "Read file contents and directory listings",
      },
      write: {
        label: "Write Files",
        description: "Create and modify files on disk",
      },
      delete: {
        label: "Delete Files",
        description: "Remove files and directories permanently",
      },
    },
  },
  shell: {
    icon: Terminal,
    label: "Shell",
    description: "Execute commands in the system shell",
    permissions: {
      execute: {
        label: "Execute Commands",
        description: "Run shell commands and scripts",
      },
    },
  },
  git: {
    icon: GitBranch,
    label: "Git",
    description: "Version control operations on repositories",
    permissions: {
      commit: {
        label: "Commit",
        description: "Create commits in repositories",
      },
      push: {
        label: "Push",
        description: "Push commits to remote repositories",
      },
      pull: {
        label: "Pull",
        description: "Pull changes from remote repositories",
      },
    },
  },
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

function CapabilitySkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-4 w-64 mt-1" />
      </CardHeader>
      <CardContent className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between">
            <div className="space-y-1">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ── Types ──────────────────────────────────────────────────── */

type Capabilities = Record<string, Record<string, boolean>>;

/* ── Main Page ──────────────────────────────────────────────── */

export function PermissionsPage() {
  const [capabilities, setCapabilities] = useState<Capabilities>({});
  const [originalCapabilities, setOriginalCapabilities] = useState<Capabilities>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((type: "success" | "error", message: string) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  const fetchPermissions = useCallback(async () => {
    try {
      const res = await api.permissions.get();
      const caps = res.manifest.capabilities as Capabilities;
      setCapabilities(structuredClone(caps));
      setOriginalCapabilities(structuredClone(caps));
    } catch (err: unknown) {
      toast("error", err instanceof Error ? err.message : "Failed to load permissions");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchPermissions();
  }, [fetchPermissions]);

  const hasChanges = useMemo(() => {
    return JSON.stringify(capabilities) !== JSON.stringify(originalCapabilities);
  }, [capabilities, originalCapabilities]);

  const handleToggle = (group: string, perm: string, checked: boolean) => {
    setCapabilities((prev) => ({
      ...prev,
      [group]: {
        ...prev[group],
        [perm]: checked,
      },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.permissions.update(capabilities);
      if (res.success) {
        const caps = res.manifest.capabilities as Capabilities;
        setCapabilities(structuredClone(caps));
        setOriginalCapabilities(structuredClone(caps));
        toast("success", "Permissions updated successfully");
      }
    } catch (err: unknown) {
      toast("error", err instanceof Error ? err.message : "Failed to save permissions");
    } finally {
      setSaving(false);
    }
  };

  // Merge API capabilities with known metadata, handling unknown groups gracefully
  const capabilityGroups = useMemo(() => {
    const groups: {
      key: string;
      icon: React.ElementType;
      label: string;
      description: string;
      permissions: { key: string; label: string; description: string; value: boolean }[];
    }[] = [];

    for (const [groupKey, groupValue] of Object.entries(capabilities)) {
      const meta = CAPABILITY_META[groupKey];
      const perms = typeof groupValue === "object" && groupValue !== null
        ? groupValue
        : {};

      const permEntries = Object.entries(perms).map(([permKey, permValue]) => {
        const permMeta = meta?.permissions[permKey];
        return {
          key: permKey,
          label: permMeta?.label ?? permKey.charAt(0).toUpperCase() + permKey.slice(1),
          description: permMeta?.description ?? `${permKey} permission`,
          value: Boolean(permValue),
        };
      });

      groups.push({
        key: groupKey,
        icon: meta?.icon ?? Info,
        label: meta?.label ?? groupKey.charAt(0).toUpperCase() + groupKey.slice(1),
        description: meta?.description ?? `Manage ${groupKey} permissions`,
        permissions: permEntries,
      });
    }

    return groups;
  }, [capabilities]);

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex items-start justify-between"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#00d4ff]/10">
            <Shield className="h-5 w-5 text-[#00d4ff]" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Permissions</h1>
            <p className="text-sm text-muted-foreground">
              Control what Mercury can access
            </p>
          </div>
        </div>
      </motion.div>

      {/* Capability Groups */}
      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <CapabilitySkeleton key={i} />
          ))}
        </div>
      ) : capabilityGroups.length === 0 ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
        >
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
                <Shield className="h-7 w-7 text-muted-foreground" />
              </div>
              <h3 className="text-base font-medium text-foreground mb-1">
                No permissions configured
              </h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                The permission manifest is empty. Capabilities will appear here
                once configured.
              </p>
            </CardContent>
          </Card>
        </motion.div>
      ) : (
        <div className="space-y-4">
          {capabilityGroups.map((group, i) => {
            const Icon = group.icon;
            return (
              <motion.div
                key={group.key}
                custom={i}
                variants={fadeUp}
                initial="hidden"
                animate="visible"
              >
                <Card>
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted">
                        <Icon className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <CardTitle className="text-base">{group.label}</CardTitle>
                        <CardDescription>{group.description}</CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="divide-y divide-border">
                      {group.permissions.map((perm) => (
                        <div
                          key={perm.key}
                          className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                        >
                          <div className="space-y-0.5 pr-4">
                            <label
                              htmlFor={`${group.key}-${perm.key}`}
                              className="text-sm font-medium text-foreground cursor-pointer"
                            >
                              {perm.label}
                            </label>
                            <p className="text-xs text-muted-foreground">
                              {perm.description}
                            </p>
                          </div>
                          <Switch
                            id={`${group.key}-${perm.key}`}
                            checked={perm.value}
                            onCheckedChange={(checked) =>
                              handleToggle(group.key, perm.key, checked)
                            }
                          />
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}

          {/* Save Button */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="flex justify-end pt-2"
          >
            <Button
              onClick={handleSave}
              disabled={saving || !hasChanges}
              size="lg"
              className={cn(
                hasChanges && "mercury-glow-sm"
              )}
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  Save Changes
                </>
              )}
            </Button>
          </motion.div>
        </div>
      )}

      <ToastBar toasts={toasts} />
    </div>
  );
}
