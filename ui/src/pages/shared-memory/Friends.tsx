import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users, UserPlus, UserMinus, Check, X, Clock, Loader2, CheckCircle2, XCircle, Circle, Send, Radio, Shield, Search, Lock, Unlock,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { friends as api, relay as relayApi, sharedMemory as smApi, notifications as notifApi, type FriendInfo, type PendingRequestInfo, type RelayStatus, type NotificationRecord } from "@/lib/api";

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

function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-muted", className)} />;
}

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.04, duration: 0.3 } }),
  exit: { opacity: 0, y: -8, transition: { duration: 0.2 } },
};

export default function FriendsPage() {
  const navigate = useNavigate();
  const [friendsList, setFriendsList] = useState<FriendInfo[]>([]);
  const [pendingSent, setPendingSent] = useState<PendingRequestInfo[]>([]);
  const [pendingReceived, setPendingReceived] = useState<PendingRequestInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addUsername, setAddUsername] = useState("");
  const [adding, setAdding] = useState(false);
  const [onlineStatuses, setOnlineStatuses] = useState<Record<string, boolean>>({});
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ username: string; display_name: string | null }>>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Side panel state
  const [panelFriend, setPanelFriend] = useState<FriendInfo | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [myCategories, setMyCategories] = useState<string[]>([]);
  const [grantedToFriend, setGrantedToFriend] = useState<string[]>([]);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelUpdating, setPanelUpdating] = useState(false);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryQuerying, setMemoryQuerying] = useState(false);
  const [memoryQueryResult, setMemoryQueryResult] = useState<string | null>(null);
  const [memoryResponses, setMemoryResponses] = useState<NotificationRecord[]>([]);

  const toast = useCallback((type: "success" | "error", message: string) => {
    const id = Date.now();
    setToasts((p) => [...p, { id, type, message }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 3000);
  }, []);

  const fetchFriends = useCallback(async () => {
    setLoading(true);
    try {
      // Check relay status first
      const rs = await relayApi.status();
      setRelayStatus(rs);
      if (!rs.available || !rs.registered || !rs.connected) {
        setAvailable(false);
        setLoading(false);
        return;
      }

      const data = await api.list();
      setFriendsList(data.friends || []);
      setPendingSent(data.pending_sent || []);
      setPendingReceived(data.pending_received || []);
      setAvailable(data.available !== false);
      setError(null);

      // Fetch online status for each friend
      const statuses: Record<string, boolean> = {};
      for (const f of (data.friends || []).slice(0, 20)) {
        try {
          const s = await api.status(f.username);
          statuses[f.username] = s.online;
        } catch {
          statuses[f.username] = false;
        }
      }
      setOnlineStatuses(statuses);
    } catch (err: any) {
      setError(err.message || "Failed to load friends");
      setAvailable(false);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchFriends(); }, [fetchFriends]);

  // Debounced user search for typeahead
  useEffect(() => {
    const query = addUsername.toLowerCase().trim();
    if (!query || query.length < 1) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    setSuggestionsLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await relayApi.searchUsers(query, 8);
        // Filter out already-known users
        const knownUsernames = new Set([
          ...friendsList.map((f) => f.username),
          ...pendingSent.map((p) => p.target_user.username),
          ...pendingReceived.map((p) => p.target_user.username),
        ]);
        const filtered = (res.users || []).filter((u) => !knownUsernames.has(u.username));
        setSuggestions(filtered);
        setShowSuggestions(filtered.length > 0);
      } catch {
        setSuggestions([]);
        setShowSuggestions(false);
      } finally {
        setSuggestionsLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [addUsername, friendsList, pendingSent, pendingReceived]);

  const handleAdd = async () => {
    if (!addUsername.trim()) return;
    setAdding(true);
    try {
      const result = await api.sendRequest(addUsername.trim().toLowerCase());
      toast("success", `Friend request sent to @${result.target_user.username}${result.target_online ? " (online)" : ""}`);
      setAddOpen(false);
      setAddUsername("");
      fetchFriends();
    } catch (err: any) {
      toast("error", err.message || "Failed to send request");
    }
    setAdding(false);
  };

  const handleAccept = async (username: string) => {
    try {
      await api.acceptRequest(username);
      toast("success", `Accepted friend request from @${username}`);
      fetchFriends();
    } catch (err: any) {
      toast("error", err.message || "Failed to accept");
    }
  };

  const handleReject = async (username: string) => {
    try {
      await api.rejectRequest(username);
      toast("success", `Rejected request from @${username}`);
      fetchFriends();
    } catch (err: any) {
      toast("error", err.message || "Failed to reject");
    }
  };

  const handleCancel = async (username: string) => {
    try {
      await api.cancelRequest(username);
      toast("success", `Cancelled request to @${username}`);
      fetchFriends();
    } catch (err: any) {
      toast("error", err.message || "Failed to cancel");
    }
  };

  const handleRemove = async (username: string) => {
    try {
      await api.remove(username);
      toast("success", `Removed @${username} from friends`);
      fetchFriends();
    } catch (err: any) {
      toast("error", err.message || "Failed to remove");
    }
  };

  const openPanel = async (friend: FriendInfo) => {
    setPanelFriend(friend);
    setPanelOpen(true);
    setPanelLoading(true);
    setGrantedToFriend([]);
    setMyCategories([]);
    setRequestCats([]);
    setMemoryQuery("");
    setMemoryQueryResult(null);
    setMemoryResponses([]);
    try {
      const [catRes, accessRes, notifRes] = await Promise.all([
        smApi.categories(),
        smApi.access.get(friend.username).catch(() => ({ friend: friend.username, categories: [] as string[] })),
        notifApi.list({ type: "memory_response", source: friend.username, limit: 20 }).catch(() => ({ notifications: [] })),
      ]);
      setMyCategories(catRes.categories || []);
      setGrantedToFriend(accessRes.categories || []);
      setMemoryResponses(notifRes.notifications || []);
    } catch {
      // Access page may not be available
    } finally {
      setPanelLoading(false);
    }
  };

  const handleGrantToggle = async (category: string) => {
    if (!panelFriend) return;
    const granted = grantedToFriend.includes(category);
    setPanelUpdating(true);
    try {
      const res = await smApi.access.update(panelFriend.username, {
        action: granted ? "revoke" : "grant",
        category,
      });
      setGrantedToFriend(res.categories || []);
      toast("success", `${granted ? "Revoked" : "Granted"} "${category}" for @${panelFriend.username}`);
    } catch (err: any) {
      toast("error", err.message || "Failed to update access");
    } finally {
      setPanelUpdating(false);
    }
  };

  const handleGrantAll = async () => {
    if (!panelFriend) return;
    setPanelUpdating(true);
    try {
      const res = await smApi.access.update(panelFriend.username, { action: "grant-all" });
      setGrantedToFriend(res.categories || []);
      toast("success", `Granted all categories to @${panelFriend.username}`);
    } catch (err: any) {
      toast("error", err.message || "Failed");
    } finally {
      setPanelUpdating(false);
    }
  };

  const handleRevokeAll = async () => {
    if (!panelFriend) return;
    setPanelUpdating(true);
    try {
      const res = await smApi.access.update(panelFriend.username, { action: "revoke-all" });
      setGrantedToFriend(res.categories || []);
      toast("success", `Revoked all access for @${panelFriend.username}`);
    } catch (err: any) {
      toast("error", err.message || "Failed");
    } finally {
      setPanelUpdating(false);
    }
  };

  const handleMemoryQuery = async () => {
    if (!panelFriend || !memoryQuery.trim()) return;
    setMemoryQuerying(true);
    setMemoryQueryResult(null);
    try {
      const res = await api.queryMemory(panelFriend.username, memoryQuery.trim());
      if (res.forwarded) {
        setMemoryQueryResult("Query sent — waiting for response...");
        // Poll for the response notification
        let attempts = 0;
        const beforeCount = memoryResponses.length;
        const poll = setInterval(async () => {
          attempts++;
          try {
            const notifRes = await notifApi.list({ type: "memory_response", source: panelFriend!.username, limit: 20 });
            const newNotifs = notifRes.notifications || [];
            if (newNotifs.length > beforeCount) {
              setMemoryResponses(newNotifs);
              setMemoryQueryResult(null);
              setMemoryQuerying(false);
              clearInterval(poll);
              return;
            }
          } catch {}
          if (attempts >= 15) {
            setMemoryQueryResult("Response may still arrive — check back shortly");
            setMemoryQuerying(false);
            clearInterval(poll);
          }
        }, 2000);
      } else {
        setMemoryQueryResult("Could not forward query — friend may be offline");
        setMemoryQuerying(false);
      }
    } catch (err: any) {
      setMemoryQueryResult(err.message || "Query failed");
      setMemoryQuerying(false);
    }
  };

  if (!available && !loading) {
    const needsSetup = !relayStatus?.available || !relayStatus?.registered;
    const needsConnect = relayStatus?.registered && !relayStatus?.connected;

    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-3">
          <Users className="h-6 w-6 text-[#a855f7]" />
          <h1 className="text-2xl font-bold">Friends</h1>
        </div>
        <Card>
          <CardContent className="p-12 text-center">
            <Radio className="h-12 w-12 mx-auto mb-4 text-[#a855f7] opacity-50" />
            {needsSetup ? (
              <>
                <p className="text-muted-foreground">Relay not set up</p>
                <p className="text-sm text-muted-foreground mt-2">
                  Register on the relay network to manage friends and share memories.
                </p>
                <Button className="mt-4" style={{ backgroundColor: "#a855f7" }} onClick={() => navigate("/relay")}>
                  <Radio className="mr-2 h-4 w-4" /> Set Up Relay
                </Button>
              </>
            ) : needsConnect ? (
              <>
                <p className="text-muted-foreground">Relay disconnected</p>
                <p className="text-sm text-muted-foreground mt-2">
                  Connect to the relay to manage friends.
                </p>
                <Button className="mt-4" style={{ backgroundColor: "#a855f7" }} onClick={() => navigate("/relay")}>
                  <Radio className="mr-2 h-4 w-4" /> Go to Relay
                </Button>
              </>
            ) : (
              <>
                <p className="text-muted-foreground">Relay unavailable</p>
                <p className="text-sm text-muted-foreground mt-2">{error || "Could not reach the relay server."}</p>
                <Button className="mt-4" variant="outline" onClick={() => navigate("/relay")}>
                  <Radio className="mr-2 h-4 w-4" /> Relay Settings
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <ToastBar toasts={toasts} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Users className="h-6 w-6 text-[#a855f7]" />
          <div>
            <h1 className="text-2xl font-bold">Friends</h1>
            <p className="text-sm text-muted-foreground">
              {friendsList.length} friend{friendsList.length !== 1 ? "s" : ""}
              {pendingReceived.length > 0 && <span className="text-amber-400 ml-2">{pendingReceived.length} pending request{pendingReceived.length !== 1 ? "s" : ""}</span>}
            </p>
          </div>
        </div>
        <Dialog open={addOpen} onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) { setAddUsername(""); setSuggestions([]); setShowSuggestions(false); }
        }}>
          <DialogTrigger asChild>
            <Button size="sm" className="bg-[#a855f7] hover:bg-[#a855f7]/90">
              <UserPlus className="h-4 w-4 mr-1" /> Add Friend
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Send Friend Request</DialogTitle>
              <DialogDescription>Enter the username of the person you want to add.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="relative">
                <label className="text-sm font-medium mb-1.5 block">Username</label>
                <div className="relative">
                  <Input
                    value={addUsername}
                    onChange={(e) => {
                      setAddUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""));
                      setShowSuggestions(true);
                    }}
                    placeholder="Start typing a username..."
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && addUsername.trim()) handleAdd();
                      if (e.key === "Escape") setShowSuggestions(false);
                    }}
                    onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
                    autoComplete="off"
                  />
                  {suggestionsLoading && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">Lowercase letters, numbers, and underscores only.</p>

                {/* Suggestions dropdown */}
                {showSuggestions && suggestions.length > 0 && (
                  <div className="absolute left-0 right-0 z-50 mt-1 rounded-lg border border-border bg-popover shadow-lg overflow-hidden">
                    {suggestions.map((user) => (
                      <button
                        key={user.username}
                        type="button"
                        className="flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
                        onClick={() => {
                          setAddUsername(user.username);
                          setShowSuggestions(false);
                        }}
                      >
                        <div className="h-7 w-7 rounded-full bg-[#a855f7]/15 flex items-center justify-center text-[#a855f7] font-semibold text-xs shrink-0">
                          {user.username.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">@{user.username}</p>
                          {user.display_name && (
                            <p className="text-xs text-muted-foreground truncate">{user.display_name}</p>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button onClick={handleAdd} disabled={adding || !addUsername.trim()} className="bg-[#a855f7] hover:bg-[#a855f7]/90">
                  {adding ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />}
                  Send Request
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Pending Received */}
      {pendingReceived.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-amber-400 flex items-center gap-2">
            <Clock className="h-4 w-4" /> Incoming Requests
          </h2>
          <AnimatePresence>
            {pendingReceived.map((req, i) => (
              <motion.div key={req.request_id} custom={i} variants={fadeUp} initial="hidden" animate="visible" exit="exit">
                <Card className="border-amber-500/20">
                  <CardContent className="p-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium">@{req.target_user.username}</p>
                      {req.target_user.display_name && <p className="text-sm text-muted-foreground">{req.target_user.display_name}</p>}
                      <p className="text-xs text-muted-foreground mt-1">Received {new Date(req.created_at).toLocaleDateString()}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => handleAccept(req.target_user.username)} className="bg-emerald-600 hover:bg-emerald-700">
                        <Check className="h-4 w-4 mr-1" /> Accept
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => handleReject(req.target_user.username)} className="border-destructive/30 text-destructive hover:bg-destructive/10">
                        <X className="h-4 w-4 mr-1" /> Reject
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Pending Sent */}
      {pendingSent.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
            <Clock className="h-4 w-4" /> Sent Requests
          </h2>
          <AnimatePresence>
            {pendingSent.map((req, i) => (
              <motion.div key={req.request_id} custom={i} variants={fadeUp} initial="hidden" animate="visible" exit="exit">
                <Card className="border-muted">
                  <CardContent className="p-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium">@{req.target_user.username}</p>
                      {req.target_user.display_name && <p className="text-sm text-muted-foreground">{req.target_user.display_name}</p>}
                      <p className="text-xs text-muted-foreground mt-1">Sent {new Date(req.created_at).toLocaleDateString()}</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => handleCancel(req.target_user.username)} className="text-muted-foreground">
                      <X className="h-4 w-4 mr-1" /> Cancel
                    </Button>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Friends List */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Friends</h2>
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="p-4 flex items-center gap-4">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-20" /></div>
            </CardContent></Card>
          ))
        ) : friendsList.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-30" />
              <p>No friends yet.</p>
              <p className="text-sm mt-1">Send a friend request to get started.</p>
            </CardContent>
          </Card>
        ) : (
          <AnimatePresence>
            {friendsList.map((friend, i) => (
              <motion.div key={friend.username} custom={i} variants={fadeUp} initial="hidden" animate="visible" exit="exit">
                <Card className="group transition-colors hover:border-[#a855f7]/20">
                  <CardContent className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <div className="h-10 w-10 rounded-full bg-[#a855f7]/15 flex items-center justify-center text-[#a855f7] font-semibold text-sm">
                          {friend.username.charAt(0).toUpperCase()}
                        </div>
                        <Circle
                          className={cn(
                            "absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 fill-current",
                            onlineStatuses[friend.username] ? "text-emerald-400" : "text-muted-foreground/30"
                          )}
                        />
                      </div>
                      <div>
                        <p className="font-medium">@{friend.username}</p>
                        {friend.display_name && <p className="text-sm text-muted-foreground">{friend.display_name}</p>}
                        <p className="text-xs text-muted-foreground">
                          Friends since {new Date(friend.friends_since).toLocaleDateString()}
                          {onlineStatuses[friend.username] !== undefined && (
                            <span className={cn("ml-2", onlineStatuses[friend.username] ? "text-emerald-400" : "text-muted-foreground/50")}>
                              {onlineStatuses[friend.username] ? "online" : "offline"}
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="ghost" onClick={() => openPanel(friend)}
                        className="text-muted-foreground hover:text-[#a855f7] transition-colors"
                        title="Memory access">
                        <Shield className="h-4 w-4" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="ghost" className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive">
                            <UserMinus className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove @{friend.username}?</AlertDialogTitle>
                            <AlertDialogDescription>This will remove them from your friends list. They will no longer have access to your shared memories.</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleRemove(friend.username)} className="bg-destructive hover:bg-destructive/90">Remove</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>

      {/* Memory Access Side Panel */}
      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent className="w-[400px] sm:w-[440px] overflow-y-auto">
          {panelFriend && (
            <>
              <SheetHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-[#a855f7]/15 flex items-center justify-center text-[#a855f7] font-semibold text-sm">
                    {panelFriend.username.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <SheetTitle className="text-lg">@{panelFriend.username}</SheetTitle>
                    {panelFriend.display_name && (
                      <SheetDescription>{panelFriend.display_name}</SheetDescription>
                    )}
                  </div>
                </div>
              </SheetHeader>

              {panelLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-[#a855f7]" />
                </div>
              ) : (
                <div className="space-y-6">

                  {/* Section 1: Your Access Grants (what you share with them) */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold flex items-center gap-2">
                        <Unlock className="h-4 w-4 text-[#a855f7]" />
                        Your Shared Categories
                      </h3>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" className="h-7 text-xs px-2" disabled={panelUpdating || myCategories.length === 0}
                          onClick={handleGrantAll}>
                          Grant All
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 text-xs px-2" disabled={panelUpdating || grantedToFriend.length === 0}
                          onClick={handleRevokeAll}>
                          Revoke All
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Categories of your memories that @{panelFriend.username} can access.
                    </p>
                    {myCategories.length === 0 ? (
                      <p className="text-xs text-muted-foreground/60 py-2">No categories yet. Add shared memories to create categories.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {myCategories.map((cat) => {
                          const granted = grantedToFriend.includes(cat);
                          return (
                            <Badge
                              key={cat}
                              className={cn(
                                "cursor-pointer select-none transition-all text-xs",
                                granted
                                  ? "text-white hover:opacity-80"
                                  : "bg-muted text-muted-foreground hover:bg-muted/80",
                              )}
                              style={granted ? { backgroundColor: "#a855f7" } : undefined}
                              onClick={() => !panelUpdating && handleGrantToggle(cat)}
                            >
                              {granted ? <Unlock className="h-3 w-3 mr-1" /> : <Lock className="h-3 w-3 mr-1" />}
                              {cat}
                            </Badge>
                          );
                        })}
                      </div>
                    )}
                   </div>

                  <div className="border-t" />

                  {/* Section 2: Query their memory */}
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      <Search className="h-4 w-4 text-emerald-400" />
                      Query Memory
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Search @{panelFriend.username}'s shared memories (they must be online).
                    </p>
                    <div className="flex gap-2">
                      <Input
                        placeholder="What do you want to know?"
                        value={memoryQuery}
                        onChange={(e) => setMemoryQuery(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleMemoryQuery()}
                        className="text-sm flex-1"
                      />
                      <Button size="sm" onClick={handleMemoryQuery}
                        disabled={memoryQuerying || !memoryQuery.trim()}
                        style={{ backgroundColor: "#a855f7" }}>
                        {memoryQuerying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                      </Button>
                    </div>
                    {memoryQueryResult && (
                      <div className="rounded-lg border bg-muted/30 p-3">
                        <p className="text-xs text-muted-foreground">{memoryQueryResult}</p>
                      </div>
                    )}
                    {memoryResponses.length > 0 && (
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        <p className="text-xs font-medium text-muted-foreground">Past Responses</p>
                        {memoryResponses.map((n) => (
                          <div key={n.id} className="rounded-lg border bg-muted/20 p-3 space-y-1">
                            <pre className="text-xs text-foreground whitespace-pre-wrap font-mono leading-relaxed">{n.message}</pre>
                            <p className="text-[10px] text-muted-foreground/60">
                              {new Date(n.createdAt * 1000).toLocaleString()}
                              {!n.read && <span className="ml-2 text-[#a855f7] font-medium">new</span>}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
