import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Bot, Plus, Send, RefreshCw, Trash2, Play, Pause, RotateCcw, RotateCw, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { cn, formatDate } from "@/lib/utils";
import api, { type BotStatus, type BotManifest, type BotRunRecord, type BotDlqEntry } from "@/lib/api";

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.07, duration: 0.35, ease: "easeOut" as const },
  }),
};

const STATE_STYLES: Record<string, { label: string; className: string }> = {
  running: { label: "🟢 Running", className: "bg-emerald-500/15 text-emerald-500" },
  queued: { label: "🔵 Queued", className: "bg-blue-500/15 text-blue-500" },
  paused: { label: "🟡 Paused", className: "bg-yellow-500/15 text-yellow-500" },
  disabled: { label: "⛔ Disabled", className: "bg-muted text-muted-foreground" },
  idle: { label: "⚪ Idle", className: "bg-muted text-muted-foreground" },
};

function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-muted", className)} />;
}

export function BotsPage() {
  const [botsList, setBotsList] = useState<BotStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ bot: BotManifest; journal: BotRunRecord[]; inbox: unknown[] } | null>(null);
  const [dlq, setDlq] = useState<BotDlqEntry[]>([]);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.bots.list();
      setBotsList(data.bots);
      setAvailable(data.available);
    } catch {
      setAvailable(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const openDetail = useCallback(async (id: string) => {
    setSelected(id);
    try {
      const [detail, dlqData] = await Promise.all([api.bots.get(id), api.bots.dlq(id)]);
      setDetail(detail);
      setDlq(dlqData.dlq);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000); // live roster states
    return () => clearInterval(t);
  }, [refresh]);

  const sendMessage = async () => {
    if (!selected || !message.trim()) return;
    try {
      const result = await api.bots.message(selected, message.trim());
      if (result.accepted) {
        setMessage("");
        setTimeout(() => void openDetail(selected), 400);
      } else {
        setError(`Rejected: ${result.reasonCode}`);
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const createBot = async () => {
    try {
      await api.bots.create({ id: newId.toLowerCase(), name: newName, description: newDescription || undefined });
      setCreating(false);
      setNewId(""); setNewName(""); setNewDescription("");
      void refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const toggleEnabled = async (bot: BotStatus) => {
    await (bot.enabled ? api.bots.disable(bot.id) : api.bots.enable(bot.id));
    void refresh();
  };

  const replay = async (entry: BotDlqEntry) => {
    try {
      await api.bots.replay(entry.botId, entry.id);
      if (selected) void openDetail(selected);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Bot className="h-6 w-6" /> Bots</h1>
          <p className="text-sm text-muted-foreground">
            Persistent persona-scoped agents — own model, memory, and permissions; run outside the main conversation.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /> Refresh</Button>
          <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Onboard bot</Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
      )}

      {!available && (
        <Card><CardContent className="py-8 text-center text-muted-foreground">
          Bots are not available on this instance (config.bots.enabled is off).
        </CardContent></Card>
      )}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : botsList.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">
          No bots configured yet. Onboard one to get started.
        </CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {botsList.map((bot, i) => (
            <motion.div key={bot.id} custom={i} variants={fadeUp} initial="hidden" animate="visible">
              <Card
                className="cursor-pointer transition-colors hover:border-primary/50"
                onClick={() => void openDetail(bot.id)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Bot className="h-4 w-4" /> {bot.name}
                    </CardTitle>
                    <Badge variant="secondary" className={STATE_STYLES[bot.state]?.className}>
                      {STATE_STYLES[bot.state]?.label ?? bot.state}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {bot.activity && <p className="text-muted-foreground truncate">↳ {bot.activity}</p>}
                  {bot.needsYou && (
                    <p className="flex items-center gap-1 text-yellow-500"><AlertTriangle className="h-3.5 w-3.5" /> Needs you — see DLQ</p>
                  )}
                  {bot.lastRunAt && (
                    <p className="text-muted-foreground">Last run {formatDate(bot.lastRunAt)} · {bot.lastRunState}</p>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}

      {/* Detail dialog: config, send, journal, DLQ */}
      <Dialog open={!!selected} onOpenChange={(o) => { if (!o) { setSelected(null); setDetail(null); } }}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Bot className="h-5 w-5" /> {detail.bot.name} <span className="text-muted-foreground text-sm">({detail.bot.id})</span>
                </DialogTitle>
                <DialogDescription>{detail.bot.description ?? "Mercury bot"}</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2 text-sm">
                  <Badge variant="secondary">model: {detail.bot.model?.provider ?? "inherit"}{detail.bot.model?.model ? `:${detail.bot.model.model}` : ""}</Badge>
                  <Badge variant="secondary">memory: {detail.bot.memory?.scope ?? "own"}</Badge>
                  {detail.bot.autonomy?.dailyTokenBudget && <Badge variant="secondary">budget: {detail.bot.autonomy.dailyTokenBudget}/day</Badge>}
                  {(detail.bot.comms?.canMessage?.length ?? 0) > 0 && <Badge variant="secondary">→ {detail.bot.comms!.canMessage!.join(", ")}</Badge>}
                </div>

                {(detail.bot.schedules?.length ?? 0) > 0 && (
                  <div className="text-sm">
                    <p className="font-medium mb-1">Routines</p>
                    {detail.bot.schedules!.map(s => (
                      <p key={s.name} className="text-muted-foreground">⏰ {s.name} — <code>{s.cron}</code></p>
                    ))}
                  </div>
                )}

                <div className="space-y-2">
                  <Textarea
                    placeholder={`Message ${detail.bot.name}… (runs outside the main conversation)`}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    rows={3}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void sendMessage()} disabled={!message.trim()}>
                      <Send className="h-3.5 w-3.5" /> Send
                    </Button>
                    <Button
                      size="sm" variant="outline"
                      onClick={async () => { await (detail.bot.enabled ? api.bots.disable(detail.bot.id) : api.bots.enable(detail.bot.id)); void openDetail(detail.bot.id); void refresh(); }}
                    >
                      {detail.bot.enabled ? <><Pause className="h-3.5 w-3.5" /> Disable</> : <><Play className="h-3.5 w-3.5" /> Enable</>}
                    </Button>
                    <Button size="sm" variant="outline" onClick={async () => { await api.bots.stop(detail.bot.id); void openDetail(detail.bot.id); }}>
                      Stop
                    </Button>
                  </div>
                </div>

                <div>
                  <p className="font-medium text-sm mb-2">Recent runs</p>
                  {detail.journal.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No runs yet.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {[...detail.journal].reverse().map(r => (
                        <div key={r.runId} className="flex items-center gap-2 text-sm">
                          <Badge variant="secondary" className={
                            r.state === "completed" ? "bg-emerald-500/15 text-emerald-500"
                            : r.state === "failed" ? "bg-red-500/15 text-red-500"
                            : "bg-yellow-500/15 text-yellow-500"
                          }>{r.state}</Badge>
                          <span className="text-muted-foreground">{r.trigger}</span>
                          <span>{(r.durationMs / 1000).toFixed(1)}s</span>
                          <span className="text-muted-foreground">{r.tokensIn + r.tokensOut} tok</span>
                          {r.reasonCode && <span className="text-red-500">[{r.reasonCode}]</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {dlq.length > 0 && (
                  <div>
                    <p className="font-medium text-sm mb-2 flex items-center gap-1"><AlertTriangle className="h-4 w-4 text-yellow-500" /> Dead-lettered jobs</p>
                    <div className="space-y-1.5">
                      {dlq.map(e => (
                        <div key={e.id} className="flex items-center gap-2 text-sm">
                          <span className="text-muted-foreground font-mono">{e.id}</span>
                          <span className="text-red-500">[{e.reasonCode ?? "unknown"}]</span>
                          <span className="text-muted-foreground truncate flex-1">{e.prompt.slice(0, 60)}</span>
                          <Button size="sm" variant="ghost" onClick={() => void replay(e)}><RotateCw className="h-3.5 w-3.5" /> Replay</Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Onboard dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Onboard a bot</DialogTitle>
            <DialogDescription>
              Fail-closed defaults: dangerous tools denied, memory scope own, only its own directory writable. Refine in the profile files afterwards.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input placeholder="id (lowercase, e.g. researcher)" value={newId} onChange={e => setNewId(e.target.value)} />
            <Input placeholder="Name (e.g. Research)" value={newName} onChange={e => setNewName(e.target.value)} />
            <Input placeholder="Description (optional)" value={newDescription} onChange={e => setNewDescription(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={() => void createBot()} disabled={!newId || !newName}><Trash2 className="hidden" /> Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}