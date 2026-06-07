import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Users, Shield, ChevronDown, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { collaborativeKnowledge, friends as friendsApi } from "@/lib/api";
import type { FriendInfo } from "@/lib/api";

const ACCENT = "#a855f7";

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({
    opacity: 1, y: 0, transition: { delay: i * 0.08, duration: 0.35, ease: "easeOut" as const },
  }),
};

interface Toast { id: number; type: "success" | "error"; message: string }

function ToastBar({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div key={t.id} initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur-sm",
              t.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-destructive/30 bg-destructive/10 text-destructive"
            )}>
            {t.type === "success" ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export default function CollaborativeKnowledgeAccess() {
  const [accessMap, setAccessMap] = useState<Record<string, string[]>>({});
  const [categories, setCategories] = useState<string[]>([]);
  const [allFriends, setAllFriends] = useState<FriendInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [updating, setUpdating] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((type: "success" | "error", message: string) => {
    const id = Date.now();
    setToasts((p) => [...p, { id, type, message }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 3000);
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [mapRes, catRes] = await Promise.all([
        collaborativeKnowledge.access.map(),
        collaborativeKnowledge.categories(),
      ]);
      setAccessMap(mapRes.accessMap);
      setCategories(catRes.categories);

      // Also fetch friends list to show friends without access configured
      try {
        const friendsRes = await friendsApi.list();
        if (friendsRes.available) {
          setAllFriends(friendsRes.friends || []);
        }
      } catch {
        // Relay not available — we still have accessMap friends
      }
    } catch (err) {
      console.error("Failed to fetch shared access data", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const toggleExpand = (friend: string) => {
    setExpanded((prev) => ({ ...prev, [friend]: !prev[friend] }));
  };

  const handleUpdate = useCallback(
    async (friend: string, action: "grant" | "revoke" | "grant-all" | "revoke-all", category?: string) => {
      setUpdating(friend);
      try {
        const payload = action === "grant-all" || action === "revoke-all"
          ? { action }
          : { action, category: category! };
        await collaborativeKnowledge.access.update(friend, payload);
        await fetchData();
        toast("success", `Access updated for @${friend}`);
      } catch (err) {
        console.error("Failed to update access", err);
        toast("error", "Failed to update access");
      } finally {
        setUpdating(null);
      }
    },
    [fetchData, toast],
  );

  const isCategoryGranted = (friend: string, category: string) =>
    accessMap[friend]?.includes(category) ?? false;

  // Merge: all friends from relay + any extra usernames from accessMap
  const accessFriends = Object.keys(accessMap);
  const friendUsernames = new Set(allFriends.map((f) => f.username));
  const allUsernames = [...new Set([...allFriends.map((f) => f.username), ...accessFriends])];

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" style={{ color: ACCENT }} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <ToastBar toasts={toasts} />

      {/* Header */}
      <div className="flex items-center gap-3">
        <Shield className="h-6 w-6" style={{ color: ACCENT }} />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Collaborative Knowledge Access</h1>
          <p className="text-sm text-muted-foreground">
            Control which categories each friend can access.
            {categories.length > 0 && <span className="text-muted-foreground/70"> {categories.length} categor{categories.length === 1 ? "y" : "ies"} available.</span>}
          </p>
        </div>
      </div>

      {/* Empty state */}
      {allUsernames.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16">
            <Users className="h-12 w-12 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No friends found.</p>
            <p className="text-xs text-muted-foreground">Add friends first to configure collaborative knowledge access.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {allUsernames.map((friend, i) => {
            const allowed = accessMap[friend] ?? [];
            const isExpanded = expanded[friend] ?? false;
            const isUpdating = updating === friend;
            const friendInfo = allFriends.find((f) => f.username === friend);

            return (
              <motion.div key={friend} custom={i} variants={fadeUp} initial="hidden" animate="visible">
                <Card className="transition-colors hover:border-[#a855f7]/20">
                  <CardContent className="p-4">
                    {/* Friend header row */}
                    <div className="flex items-center justify-between">
                      <button className="flex flex-1 items-center gap-3 text-left" onClick={() => toggleExpand(friend)}>
                        <div className="h-8 w-8 rounded-full bg-[#a855f7]/15 flex items-center justify-center text-[#a855f7] font-semibold text-sm shrink-0">
                          {friend.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <span className="font-medium">@{friend}</span>
                          {friendInfo?.display_name && <span className="text-sm text-muted-foreground ml-2">{friendInfo.display_name}</span>}
                        </div>
                        <Badge variant="secondary" className="ml-1 text-xs shrink-0"
                          style={{ backgroundColor: allowed.length > 0 ? `${ACCENT}20` : undefined, color: allowed.length > 0 ? ACCENT : undefined }}>
                          {allowed.length === 0 ? "no access" : `${allowed.length} categor${allowed.length === 1 ? "y" : "ies"}`}
                        </Badge>
                        <ChevronDown className={cn("ml-auto h-4 w-4 shrink-0 transition-transform duration-200", isExpanded && "rotate-180")} />
                      </button>

                      {/* Quick actions */}
                      <div className="ml-4 flex items-center gap-2">
                        <Button size="sm" variant="outline" disabled={isUpdating || categories.length === 0}
                          onClick={() => handleUpdate(friend, "grant-all")}
                          className="text-xs" style={{ borderColor: ACCENT, color: ACCENT }}>
                          {isUpdating ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                          Grant All
                        </Button>
                        <Button size="sm" variant="outline" disabled={isUpdating || allowed.length === 0}
                          onClick={() => handleUpdate(friend, "revoke-all")} className="text-xs">
                          Revoke All
                        </Button>
                      </div>
                    </div>

                    {/* Expandable categories */}
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                          <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
                            {categories.length === 0 ? (
                              <p className="text-xs text-muted-foreground">No categories available. Add collaborative knowledge to create categories.</p>
                            ) : (
                              categories.map((cat) => {
                                const granted = isCategoryGranted(friend, cat);
                                return (
                                  <Badge key={cat}
                                    className={cn(
                                      "cursor-pointer select-none transition-colors",
                                      granted ? "text-white hover:opacity-80" : "bg-muted text-muted-foreground hover:bg-muted/80",
                                    )}
                                    style={granted ? { backgroundColor: ACCENT } : undefined}
                                    onClick={() => handleUpdate(friend, granted ? "revoke" : "grant", cat)}>
                                    {cat}
                                  </Badge>
                                );
                              })
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
      )}
    </div>
  );
}
