import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Users, Shield, ChevronDown, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { sharedMemory } from "@/lib/api";
import type { SharedAccessMap } from "@/lib/api";

/* ── Animations ─────────────────────────────────────────────── */

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.08, duration: 0.35, ease: "easeOut" as const },
  }),
};

const ACCENT = "#a855f7";

/* ── Component ──────────────────────────────────────────────── */

export default function SharedAccess() {
  const [accessMap, setAccessMap] = useState<Record<string, string[]>>({});
  const [categories, setCategories] = useState<string[]>([]);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [updating, setUpdating] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [mapRes, catRes] = await Promise.all([
        sharedMemory.access.map(),
        sharedMemory.categories(),
      ]);
      setAccessMap(mapRes.accessMap);
      setAvailable(mapRes.available);
      setCategories(catRes.categories);
    } catch (err) {
      console.error("Failed to fetch shared access data", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const toggleExpand = (friend: string) => {
    setExpanded((prev) => ({ ...prev, [friend]: !prev[friend] }));
  };

  const handleUpdate = useCallback(
    async (
      friend: string,
      action: "grant" | "revoke" | "grant-all" | "revoke-all",
      category?: string,
    ) => {
      setUpdating(friend);
      try {
        const payload =
          action === "grant-all" || action === "revoke-all"
            ? { action }
            : { action, category: category! };
        await sharedMemory.access.update(friend, payload);
        await fetchData();
      } catch (err) {
        console.error("Failed to update access", err);
      } finally {
        setUpdating(null);
      }
    },
    [fetchData],
  );

  const isCategoryGranted = (friend: string, category: string) =>
    accessMap[friend]?.includes(category) ?? false;

  const friends = Object.keys(accessMap);

  /* ── Render ────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2
          className="h-8 w-8 animate-spin"
          style={{ color: ACCENT }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Shield className="h-6 w-6" style={{ color: ACCENT }} />
        <h1 className="text-2xl font-bold tracking-tight">
          Shared Memory Access
        </h1>
      </div>

      {/* Empty state */}
      {friends.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16">
            <Users className="h-12 w-12 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No friends have access configured yet.
            </p>
          </CardContent>
        </Card>
      ) : (
        <AnimatePresence mode="wait">
          <div className="space-y-4">
            {friends.map((friend, i) => {
              const allowed = accessMap[friend] ?? [];
              const isExpanded = expanded[friend] ?? false;
              const isUpdating = updating === friend;

              return (
                <motion.div
                  key={friend}
                  custom={i}
                  variants={fadeUp}
                  initial="hidden"
                  animate="visible"
                >
                  <Card>
                    <CardContent className="p-4">
                      {/* Friend header row */}
                      <div className="flex items-center justify-between">
                        <button
                          className="flex flex-1 items-center gap-3 text-left"
                          onClick={() => toggleExpand(friend)}
                        >
                          <Users
                            className="h-5 w-5 shrink-0"
                            style={{ color: ACCENT }}
                          />
                          <span className="font-medium">{friend}</span>
                          <Badge
                            variant="secondary"
                            className="ml-1 text-xs"
                            style={{
                              backgroundColor: `${ACCENT}20`,
                              color: ACCENT,
                            }}
                          >
                            {allowed.length} categor
                            {allowed.length === 1 ? "y" : "ies"}
                          </Badge>
                          <ChevronDown
                            className={cn(
                              "ml-auto h-4 w-4 shrink-0 transition-transform duration-200",
                              isExpanded && "rotate-180",
                            )}
                          />
                        </button>

                        {/* Action buttons */}
                        <div className="ml-4 flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isUpdating}
                            onClick={() =>
                              handleUpdate(friend, "grant-all")
                            }
                            className="text-xs"
                            style={{ borderColor: ACCENT, color: ACCENT }}
                          >
                            {isUpdating ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : null}
                            Grant All
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isUpdating}
                            onClick={() =>
                              handleUpdate(friend, "revoke-all")
                            }
                            className="text-xs"
                          >
                            Revoke All
                          </Button>
                        </div>
                      </div>

                      {/* Expandable categories */}
                      <AnimatePresence>
                        {isExpanded && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
                              {categories.map((cat) => {
                                const granted = isCategoryGranted(
                                  friend,
                                  cat,
                                );
                                return (
                                  <Badge
                                    key={cat}
                                    className={cn(
                                      "cursor-pointer select-none transition-colors",
                                      granted
                                        ? "text-white hover:opacity-80"
                                        : "bg-muted text-muted-foreground hover:bg-muted/80",
                                    )}
                                    style={
                                      granted
                                        ? { backgroundColor: ACCENT }
                                        : undefined
                                    }
                                    onClick={() =>
                                      handleUpdate(
                                        friend,
                                        granted ? "revoke" : "grant",
                                        cat,
                                      )
                                    }
                                  >
                                    {cat}
                                  </Badge>
                                );
                              })}
                              {categories.length === 0 && (
                                <p className="text-xs text-muted-foreground">
                                  No categories available.
                                </p>
                              )}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        </AnimatePresence>
      )}
    </div>
  );
}
