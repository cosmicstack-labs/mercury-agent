import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Bot, Plus, RefreshCw, AlertTriangle, Crown, Users, Package } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn, formatDate } from "@/lib/utils";
import api, { type BotStatus, type BotRunRecord, type BotDlqEntry, type BotManifest } from "@/lib/api";
import { useBotEvents } from "@/components/bots/useBotEvents";
import { BotFace } from "@/components/bots/BotFace";
import { BotDetail } from "@/components/bots/BotDetail";
import { OnboardWizard } from "@/components/bots/OnboardWizard";
import { DeliverablesList } from "@/components/bots/DeliverablesList";

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

/**
 * "Mercury Bots" — the full fleet cockpit: live roster (fleet nesting), bot
 * panels, the deliverables inbox, and onboarding with executable tiers.
 */
export function BotsPage() {
  const [botsList, setBotsList] = useState<BotStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [detail, setDetail] = useState<{ bot: BotManifest; state: BotStatus | null; journal: BotRunRecord[]; inbox: unknown[] } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [newInFleet, setNewInFleet] = useState<"solo" | { leadId: string }>("solo");
  const [liveBanner, setLiveBanner] = useState<string | null>(null);
  const live = useBotEvents();

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

  const openBot = useCallback(async (id: string) => {
    setSelectedId(id);
    try {
      const d = await api.bots.get(id);
      setDetail(d);
    } catch {}
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000); // fallback: SSE rides live activity
    return () => clearInterval(t);
  }, [refresh]);

  // Live deliverable banner + inbox refresh
  useEffect(() => {
    if (live.lastDelivery) {
      const name = live.lastDelivery.name;
      setLiveBanner(`${live.lastDelivery.botId} delivered ${name}`);
      const t = setTimeout(() => setLiveBanner(null), 6000);
      return () => clearTimeout(t);
    }
  }, [live.lastDelivery?.at, live.lastDelivery?.name, live.lastDelivery?.botId]);

  const botNames = useMemo(() => Object.fromEntries(botsList.map((b) => [b.id, b.name])), [botsList]);

  // Fleet-first grouping: leads with nested crew, then solos, then crew orphans sorted after
  const grouped = useMemo(() => {
    const leads = botsList.filter((b) => b.fleetRole === "lead");
    const crews = botsList.filter((b) => b.fleetRole === "crew");
    const solos = botsList.filter((b) => !b.fleetRole);
    return { leads, crews, solos };
  }, [botsList]);

  const BotCard = ({ id, idx }: { id: string; idx: number }) => {
    const bot = botsList.find((b) => b.id === id);
    if (!bot) return null;
    const liveLabel = live.activity[bot.id];
    // Crew members live inside their lead's card — render only on demand here.
    if (bot.fleetRole === "crew") return null;
    const crewCount = bot.fleetRole === "lead" ? grouped.crews.filter((c) => c.parent === bot.id).length : 0;
    return (
      <motion.div key={bot.id} custom={idx} variants={fadeUp} initial="hidden" animate="visible">
        <Card className={cn("cursor-pointer transition-colors hover:border-primary/50", bot.needsYou && "border-yellow-500/40")}>
          <CardHeader className="pb-2" onClick={() => void openBot(bot.id)}>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <BotFace id={bot.id} name={bot.name} hasAvatar={bot.hasAvatar} version={live.rosterSeq} size={28} /> {bot.name}
                {bot.fleetRole === "lead" && <Badge variant="secondary" className="text-yellow-500"><Crown className="h-3 w-3" /> lead</Badge>}
                {crewCount > 0 && <Badge variant="secondary"><Users className="h-3 w-3" /> {crewCount}</Badge>}
              </CardTitle>
              <Badge variant="secondary" className={STATE_STYLES[bot.state]?.className}>
                {STATE_STYLES[bot.state]?.label ?? bot.state}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm" onClick={() => void openBot(bot.id)}>
            {liveLabel && (
              <p className="flex items-center gap-1.5 text-emerald-400 truncate">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                {liveLabel}
              </p>
            )}
            {bot.fleetRole === "lead" && (
              <p className="text-muted-foreground">
                {grouped.crews.filter((c) => c.parent === bot.id).map((c) => {
                  const cl = live.activity[c.id];
                  return (
                    <span key={c.id} className="inline-flex items-center gap-1 mr-2">
                      <BotFace id={c.id} name={c.name} hasAvatar={c.hasAvatar} version={live.rosterSeq} size={18} /> {c.name}
                      {cl && <span className="text-emerald-400"> {cl.slice(0, 30)}</span>}
                      {c.needsYou && <AlertTriangle className="h-3 w-3 text-yellow-500" />}
                    </span>
                  );
                })}
              </p>
            )}
            {!liveLabel && bot.needsYou && (
              <p className="flex items-center gap-1 text-yellow-500"><AlertTriangle className="h-3.5 w-3.5" /> Needs you — check Ops → DLQ</p>
            )}
            {!liveLabel && bot.lastRunAt && (
              <p className="text-muted-foreground">Last run {formatDate(bot.lastRunAt)} · {bot.lastRunState}</p>
            )}
          </CardContent>
        </Card>
      </motion.div>
    );
  };

  const openBotDetail = detail && selectedId
    ? botsList.find((b) => b.id === selectedId)
      ? { ...detail, bot: detail.bot }
      : null
    : null;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Bot className="h-6 w-6" /> Mercury Bots
            <span
              className={cn(
                "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border",
                live.connected ? "text-emerald-500 border-emerald-500/40" : "text-muted-foreground border-muted",
              )}
            >
              <span className={cn("inline-block h-1.5 w-1.5 rounded-full", live.connected ? "bg-emerald-400" : "bg-muted-foreground")} />
              {live.connected ? "live" : "reconnecting…"}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Persistent persona-scoped agents — own model, memory, and permissions; run outside the main conversation. Deliverables land in their outputs zone.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /> Refresh</Button>
          <Button size="sm" onClick={() => { setNewInFleet("solo"); setWizardOpen(true); }}><Plus className="h-4 w-4" /> Onboard bot</Button>
        </div>
      </div>

      {liveBanner && (
        <div className="rounded-lg border border-primary/40 bg-primary/10 px-4 py-2 text-sm flex items-center gap-2">
          <Package className="h-4 w-4" /> <b>Delivered:</b> {liveBanner}
        </div>
      )}

      {!available && (
        <Card><CardContent className="py-8 text-center text-muted-foreground">
          Bots are not available on this instance (config.bots.enabled is off).
        </CardContent></Card>
      )}

      <Tabs defaultValue="fleet">
        <TabsList>
          <TabsTrigger value="fleet">Fleet</TabsTrigger>
          <TabsTrigger value="outputs">
            <Package className="h-3.5 w-3.5 mr-1" /> Deliverables
          </TabsTrigger>
        </TabsList>

        <TabsContent value="fleet" className="mt-4">
          {loading ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => <div key={i} className="animate-pulse rounded-lg bg-muted h-28" />)}
            </div>
          ) : !available || botsList.length === 0 ? (
            <Card><CardContent className="py-8 text-center text-muted-foreground">
              No bots configured yet. Onboard one to get started.
            </CardContent></Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {grouped.leads.map((_, i) => <BotCard key={i} id={grouped.leads[i].id} idx={i} />)}
              {grouped.solos.map((b, i) => <BotCard key={b.id} id={b.id} idx={i} />)}
            </div>
          )}
        </TabsContent>

        <TabsContent value="outputs" className="mt-4">
          <DeliverablesList botNames={botNames} lastDelivery={live.lastDelivery} />
        </TabsContent>
      </Tabs>

      {openBotDetail && (
        <BotDetail
          bot={detail}
          live={live}
          open={!!selectedId}
          onOpenChange={(o) => { if (!o) { setSelectedId(null); setDetail(null); } }}
          onChanged={() => { void refresh(); if (selectedId) void openBot(selectedId); }}
        />
      )}

      <OnboardWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        leads={grouped.leads.map((l) => ({ id: l.id, name: l.name } as BotManifest))}
        crewAsLeadId={newInFleet === "solo" ? undefined : newInFleet.leadId}
        onCreated={() => void refresh()}
      />
    </div>
  );
}