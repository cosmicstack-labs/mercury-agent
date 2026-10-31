import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot, Send, Pause, Play, Square, RotateCw, AlertTriangle, Crown, Shield,
  Download, Package, Clock, Save, RefreshCw, Users, Camera, Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import api, { type BotManifest, type BotStatus, type BotRunRecord, type BotDlqEntry, type BotTierInfo, type BotPermissionsFile } from "@/lib/api";
import { BotFace } from "./BotFace";
import { DeliverablesList } from "./DeliverablesList";
import type { BotEventState } from "./useBotEvents";

const RUN_STYLES: Record<string, string> = {
  completed: "bg-emerald-500/15 text-emerald-500",
  failed: "bg-red-500/15 text-red-500",
  halted: "bg-yellow-500/15 text-yellow-500",
  paused: "bg-yellow-500/15 text-yellow-500",
};

/**
 * The full bot panel: live feed + send, configuration (persona + permissions
 * editors), deliverables, and ops (DLQ/controls/bundle). One dialog, tabs.
 */
export function BotDetail({
  bot,
  live,
  open,
  onOpenChange,
  onChanged,
}: {
  bot: { bot: BotManifest; state: BotStatus | null; journal: BotRunRecord[]; inbox: unknown[] } | null;
  live: BotEventState;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onChanged: () => void;
}) {
  const id = bot?.bot.id;
  const [detail, setDetail] = useState(bot);
  const [journal, setJournal] = useState<BotRunRecord[]>(bot?.journal ?? []);
  const [dlq, setDlq] = useState<BotDlqEntry[]>([]);
  const [message, setMessage] = useState("");
  const [tiers, setTiers] = useState<BotTierInfo[]>([]);
  const [persona, setPersona] = useState("");
  const [personaState, setPersonaState] = useState<"clean" | "dirty" | "saved" | "error">("clean");
  const [perms, setPerms] = useState<BotPermissionsFile | null>(null);
  const [permText, setPermText] = useState("");
  const [permState, setPermState] = useState<"clean" | "dirty" | "saved" | "error">("clean");
  const [crewId, setCrewId] = useState("");
  const [crewName, setCrewName] = useState("");
  const [crewPersona, setCrewPersona] = useState("");
  const [crewTier, setCrewTier] = useState("inherit");
  // The face: bytes go up as base64 (the core sniffs them and refuses anything that is not
  // an image), and `avatarVersion` re-requests the image after a change — the browser would
  // otherwise keep the old bytes, the ETag on the route notwithstanding.
  const avatarInput = useRef<HTMLInputElement | null>(null);
  const [hasAvatar, setHasAvatar] = useState(Boolean(bot?.state?.hasAvatar));
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  useEffect(() => {
    setHasAvatar(Boolean(bot?.state?.hasAvatar));
    setAvatarError(null);
  }, [bot?.state?.hasAvatar, id]);

  const loadJournal = useCallback(async () => {
    if (!id) return;
    try {
      const [j, d] = await Promise.all([api.bots.get(id).then((r) => r.journal), api.bots.dlq(id)]);
      setJournal(j);
      setDlq(d.dlq);
    } catch {}
  }, [id]);

  const loadConfig = useCallback(async () => {
    if (!id) return;
    try {
      const [p, permsRes, tiersRes] = await Promise.all([
        api.bots.persona(id), api.bots.permissions(id), api.bots.tiers(),
      ]);
      setPersona(p.persona);
      setPersonaState("clean");
      setPerms(permsRes.permissions);
      setPermText(JSON.stringify(permsRes.permissions, null, 2));
      setPermState("clean");
      setTiers(tiersRes.tiers);
    } catch (e) {
      setPermText(String(e));
    }
  }, [id]);

  useEffect(() => {
    setDetail(bot);
    setJournal(bot?.journal ?? []);
    if (bot?.bot.id) {
      void loadConfig();
      void loadJournal();
      void api.bots.dlq(bot.bot.id).then(({ dlq }) => setDlq(dlq)).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot?.bot.id, open]);

  useEffect(() => {
    // Live runs append to the journal — refresh the feed while the dialog is open.
    if (!open || !id) return;
    const t = setInterval(() => void loadJournal(), 5000);
    return () => clearInterval(t);
  }, [open, id, loadJournal]);

  if (!bot || !id) return null;
  const m = bot.bot;

  const sendMessage = async () => {
    if (!message.trim()) return;
    const result = await api.bots.message(id, message.trim()).catch((e) => ({ accepted: false, reasonCode: (e as Error).message } as const));
    if (result.accepted) setMessage("");
    void loadJournal();
    onChanged();
  };

  const savePersona = async () => {
    await api.bots.setPersona(id, persona).then(() => {
      setPersonaState("saved");
      onChanged();
    }).catch(() => setPersonaState("error"));
  };

  const pickAvatar = async (file: File | null) => {
    if (!id || !file) return;
    if (file.size > 2 * 1024 * 1024) {
      setAvatarError(`That photo is ${Math.round(file.size / 1048576)} MB; the limit is 2 MB.`);
      return;
    }
    setAvatarBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read that file"));
        reader.readAsDataURL(file);
      });
      await api.bots.setAvatar(id, data);
      setHasAvatar(true);
      setAvatarVersion((v) => v + 1);
      setAvatarError(null);
      onChanged();
    } catch (e) {
      setAvatarError(e instanceof Error ? e.message : "Could not store that photo");
    } finally {
      setAvatarBusy(false);
      if (avatarInput.current) avatarInput.current.value = "";
    }
  };

  const removeAvatar = async () => {
    if (!id) return;
    setAvatarBusy(true);
    try {
      await api.bots.clearAvatar(id);
      setHasAvatar(false);
      setAvatarVersion((v) => v + 1);
      setAvatarError(null);
      onChanged();
    } catch {
      setAvatarError("Could not remove the photo");
    } finally {
      setAvatarBusy(false);
    }
  };

  const applyTier = async (tier: string) => {
    await api.bots.setPermissions(id, { tier });
    await loadConfig();
    onChanged();
  };

  const savePermissions = async () => {
    try {
      const parsed = JSON.parse(permText) as BotPermissionsFile;
      await api.bots.setPermissions(id, { permissions: parsed });
      setPermState("saved");
      onChanged();
    } catch (e) {
      setPermText(`${e}\n\n${permText}`);
      setPermState("error");
    }
  };

  // Match the current deny-set tier like the CLI does — empty deny sets
  // (allow-lists present) report as "custom".
  const deniedSet = new Set(perms?.tools?.deny ?? []);
  const activeTier = tiers.find((t) => t.deny?.length === deniedSet.size && t.deny.every((d) => deniedSet.has(d)) && deniedSet.size > 0);

  const liveLabel = live.activity[id] ?? bot.state?.activity;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => avatarInput.current?.click()}
              disabled={avatarBusy}
              title={hasAvatar ? "Change this bot's photo" : "Give this bot a photo"}
              className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
            >
              <BotFace id={id ?? ""} name={m.name} hasAvatar={hasAvatar} version={avatarVersion} size={32} />
            </button>
            {m.name}
            <span className="text-muted-foreground text-sm">({id})</span>
            {m.fleetRole === "lead" && <Badge variant="secondary" className="text-yellow-500"><Crown className="h-3 w-3" /> fleet lead</Badge>}
            {m.fleetRole === "crew" && <Badge variant="secondary">crew of {m.parent}</Badge>}
            <input
              ref={avatarInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => void pickAvatar(e.target.files?.[0] ?? null)}
            />
            <Button size="sm" variant="outline" disabled={avatarBusy} onClick={() => avatarInput.current?.click()}>
              <Camera className="h-3.5 w-3.5" /> {hasAvatar ? "Change photo" : "Add photo"}
            </Button>
            {hasAvatar && (
              <Button size="sm" variant="ghost" disabled={avatarBusy} onClick={() => void removeAvatar()}>
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            )}
          </DialogTitle>
          {avatarError && <p className="text-xs text-red-500">{avatarError}</p>}
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">model: {m.model?.provider ?? "inherit"}{m.model?.model ? `:${m.model.model}` : ""}</Badge>
            <Badge variant="secondary">memory: {m.memory?.scope ?? "own"}</Badge>
            {m.autonomy?.dailyTokenBudget && <Badge variant="secondary">budget {m.autonomy.dailyTokenBudget}/day</Badge>}
            {(m.comms?.canMessage?.length ?? 0) > 0 && <Badge variant="secondary">→ {(m.comms!.canMessage ?? []).join(", ")}</Badge>}
            {(m.schedules?.length ?? 0) > 0 && m.schedules!.map((s) => <Badge key={s.name} variant="secondary">⏰ {s.name} <code className="text-[10px]">{s.cron}</code></Badge>)}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="live" className="mt-2">
          <TabsList>
            <TabsTrigger value="live">Live</TabsTrigger>
            <TabsTrigger value="configure">Configure</TabsTrigger>
            <TabsTrigger value="deliverables">Deliverables</TabsTrigger>
            <TabsTrigger value="ops">Ops</TabsTrigger>
          </TabsList>

          <TabsContent value="live" className="space-y-3 mt-3">
            <Card>
              <CardContent className="pt-4 space-y-3">
                {(liveLabel || live.activity[id]) && (
                  <p className="text-sm flex items-center gap-2 text-muted-foreground">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" /> {liveLabel}
                  </p>
                )}
                <Textarea
                  placeholder={`Task ${m.name}… (runs outside the main conversation; durable)`}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={2}
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void sendMessage()} disabled={!message.trim()}>
                    <Send className="h-3.5 w-3.5" /> Send
                  </Button>
                  <Button size="sm" variant="outline" onClick={async () => { await api.bots.run(id); void loadJournal(); }}>
                    <Clock className="h-3.5 w-3.5" /> Wake now
                  </Button>
                </div>
              </CardContent>
            </Card>
            <div>
              <p className="font-medium text-sm mb-2">Runs</p>
              {journal.length === 0 ? (
                <p className="text-sm text-muted-foreground">No runs yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {[...journal].reverse().map((r) => (
                    <div key={r.runId} className="rounded-lg border px-3 py-2 space-y-1">
                      <div className="flex items-center gap-2 text-sm">
                        <Badge variant="secondary" className={RUN_STYLES[r.state] ?? ""}>{r.state}</Badge>
                        <span className="text-muted-foreground">{r.trigger}</span>
                        <span className="text-muted-foreground ml-auto">{(r.durationMs / 1000).toFixed(1)}s · {(r.tokensIn + r.tokensOut).toLocaleString()} tok</span>
                        {r.reasonCode && <Badge variant="destructive">{r.reasonCode}</Badge>}
                      </div>
                      {(r.summary || r.error) && (
                        <p className="text-xs text-muted-foreground whitespace-pre-wrap">{r.error ?? r.summary}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="configure" className="space-y-4 mt-3">
            <div className="space-y-1.5">
              <p className="font-medium text-sm flex items-center gap-1"><Bot className="h-4 w-4" /> Persona</p>
              <Textarea value={persona} onChange={(e) => { setPersona(e.target.value); setPersonaState("dirty"); }} rows={8} />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void savePersona()} disabled={personaState === "clean"}>
                  <Save className="h-3.5 w-3.5" /> Save persona
                </Button>
                {personaState === "saved" && <span className="text-xs text-emerald-500">Saved — applies on the bot's next turn</span>}
                {personaState === "error" && <span className="text-xs text-destructive">Save failed</span>}
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="font-medium text-sm flex items-center gap-1"><Shield className="h-4 w-4" /> Permissions — the single source of truth (tool gate, path scopes, shell lists)</p>
              <div className="flex flex-wrap gap-2">
                {tiers.map((t) => (
                  <Button
                    key={t.id}
                    size="sm"
                    variant={activeTier?.id === t.id ? "default" : "outline"}
                    title={`${t.description} — denied: ${t.deny.join(", ") || "nothing"}`}
                    onClick={() => void applyTier(t.id)}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>
              <Textarea
                className="font-mono text-xs"
                rows={8}
                value={permText}
                onChange={(e) => { setPermText(e.target.value); setPermState("dirty"); }}
              />
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void savePermissions()} disabled={permState !== "dirty"}>
                  <Save className="h-3.5 w-3.5" /> Save custom permissions (JSON)
                </Button>
                {permState === "saved" && <span className="text-xs text-emerald-500">Saved — applies on the next turn</span>}
                {permState === "error" && <span className="text-xs text-destructive">Invalid JSON</span>}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="deliverables" className="mt-3">
            <DeliverablesList botId={id} lastDelivery={live.lastDelivery} />
          </TabsContent>

          <TabsContent value="ops" className="space-y-4 mt-3">
            {m.fleetRole === "lead" && (
              <div className="space-y-1.5">
                <p className="font-medium text-sm">Add crew member</p>
                <p className="text-xs text-muted-foreground">Fail-closed specialist under this lead (gets the lead's permissions unless tiered here).</p>
                <div className="grid grid-cols-2 gap-2">
                  <Input placeholder="id (lowercase)" value={crewId} onChange={(e) => setCrewId(e.target.value)} />
                  <Input placeholder="Name" value={crewName} onChange={(e) => setCrewName(e.target.value)} />
                </div>
                <Textarea className="text-xs" rows={2} placeholder="Persona (optional)" value={crewPersona} onChange={(e) => setCrewPersona(e.target.value)} />
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={async () => {
                    if (!crewId || !crewName) return;
                    await api.bots.addCrewFull(id, { id: crewId.toLowerCase(), name: crewName, persona: crewPersona || undefined, tier: crewTier });
                    setCrewId(""); setCrewName(""); setCrewPersona("");
                    onChanged();
                  }} disabled={!crewId || !crewName}>
                    <Users className="h-3.5 w-3.5" /> Add to crew
                  </Button>
                  <Select value={crewTier} onValueChange={setCrewTier}>
                    <SelectTrigger className="h-9 w-40 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">inherit lead's permissions</SelectItem>
                      {tiers.map((t) => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={async () => { await (m.enabled ? api.bots.disable(id) : api.bots.enable(id)); onChanged(); }}>
                {m.enabled ? <><Pause className="h-3.5 w-3.5" /> Disable</> : <><Play className="h-3.5 w-3.5" /> Enable</>}
              </Button>
              <Button size="sm" variant="outline" onClick={async () => { await api.bots.stop(id); onChanged(); }}>
                <Square className="h-3.5 w-3.5" /> Stop
              </Button>
              <Button size="sm" variant="outline" onClick={async () => { await api.bots.start(id); onChanged(); }}>
                <Play className="h-3.5 w-3.5" /> Start (resume held jobs)
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={api.bots.bundleUrl(id)} download={`${id}-bundle.json`}>
                  <Download className="h-3.5 w-3.5" /> Export bundle
                </a>
              </Button>
            </div>

            {dlq.length > 0 && (
              <div>
                <p className="font-medium text-sm mb-2 flex items-center gap-1"><AlertTriangle className="h-4 w-4 text-yellow-500" /> Dead-lettered jobs</p>
                <div className="space-y-1.5">
                  {dlq.map((e) => (
                    <div key={e.id} className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground font-mono">{e.id}</span>
                      <span className="text-red-500">[{e.reasonCode ?? "unknown"}]</span>
                      <span className="text-muted-foreground truncate flex-1" title={e.prompt}>{e.prompt.slice(0, 60)}</span>
                      <Button size="sm" variant="ghost" onClick={async () => { await api.bots.replay(id, e.id); void loadJournal(); onChanged(); }}>
                        <RotateCw className="h-3.5 w-3.5" /> Replay
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}