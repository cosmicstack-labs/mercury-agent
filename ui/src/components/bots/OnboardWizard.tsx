import { useEffect, useState } from "react";
import { Bot, Crown, Users, ChevronLeft, ChevronRight, Shield, Cpu, Network } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import api, { type BotTierInfo, type BotManifest } from "@/lib/api";

const STEPS = ["Identity", "Permissions tier", "Model & budget", "Fleet"] as const;

/**
 * Guided onboarding — mirrors the CLI's tier question (§2.5: tiers EXECUTE;
 * the chosen round-trips into permissions.yaml, never a silent default).
 */
export function OnboardWizard({
  open,
  onOpenChange,
  leads,
  crewAsLeadId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Existing fleet leads (for the "crew of" step). */
  leads: BotManifest[];
  /** Set = onboard INTO this lead's crew (crew step skipped). */
  crewAsLeadId?: string;
  onCreated: (bot: BotManifest) => void;
}) {
  const [step, setStep] = useState(0);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [persona, setPersona] = useState("");
  const [tiers, setTiers] = useState<BotTierInfo[]>([]);
  const [tier, setTier] = useState<string>("readonly");
  const [provider, setProvider] = useState<string>("inherit");
  const [model, setModel] = useState<string>("");
  const [budget, setBudget] = useState<string>("");
  const [fleet, setFleet] = useState<string>("solo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0); setId(""); setName(""); setDescription(""); setPersona("");
    setTier("readonly"); setProvider("inherit"); setModel(""); setBudget("");
    setFleet("solo"); setError(null);
    api.bots.tiers().then(({ tiers }) => setTiers(tiers)).catch(() => setTiers([]));
  }, [open, crewAsLeadId]);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const manifestPatch: Record<string, unknown> = {};
      if (provider !== "inherit" || model) manifestPatch.model = { provider: provider === "inherit" ? undefined : provider, model: model || undefined };
      if (budget) manifestPatch.autonomy = { dailyTokenBudget: parseInt(budget, 10) };
      let bot: BotManifest;
      if (fleet === "crewman" && crewAsLeadId) {
        bot = (await api.bots.addCrewFull(crewAsLeadId, {
          id: id.toLowerCase(), name, description: description || undefined, persona: persona || undefined, tier,
        })).bot;
      } else {
        const res = await api.bots.createFull({
          id: id.toLowerCase(), name, description: description || undefined, persona: persona || undefined,
          tier, manifest: manifestPatch as never,
        });
        bot = res.bot;
        if (fleet === "leadauto") {
          // TUI parity: auto-build runs detached (30-90s LLM proposal); the
          // roster broadcasts crew members live as they land.
          void api.bots.autocrew(bot.id);
        } else if (fleet === "leadman") {
          void api.bots.promote(bot.id);
        }
      }
      onCreated(bot);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canNext = step === 0 ? !!id && !!name : step === 3 ? true : true;
  const targetCrewLead = crewAsLeadId ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            {targetCrewLead ? `Add crew member — ${targetCrewLead}` : "Onboard a bot"}
          </DialogTitle>
          <DialogDescription>
            Fail-closed by design: explicit grants only, no mid-run prompts, no allow-all.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1 text-xs text-muted-foreground mb-2">
          {STEPS.map((s, i) => (
            <span key={s} className={cn("flex items-center gap-1", i === step && "text-foreground font-medium")}>
              <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-full border",
                i < step ? "bg-primary text-primary-foreground border-primary" : "border-muted")}>
                {i < step ? "✓" : i + 1}
              </span>
              {s}
              {i < STEPS.length - 1 && <span className="mx-1">→</span>}
            </span>
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-3">
            <Input placeholder="id (lowercase, e.g. researcher)" value={id} onChange={(e) => setId(e.target.value)} />
            <Input placeholder="Name (e.g. Research)" value={name} onChange={(e) => setName(e.target.value)} />
            <Input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
            <Textarea
              placeholder="Persona (optional — who this bot is and how it writes; you can edit it later in Configure)"
              value={persona} onChange={(e) => setPersona(e.target.value)} rows={4}
            />
          </div>
        )}

        {step === 1 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {tiers.map((t) => (
              <Card
                key={t.id}
                className={cn("cursor-pointer transition-colors", tier === t.id ? "border-primary" : "hover:border-primary/50")}
                onClick={() => setTier(t.id)}
              >
                <CardHeader className="pb-1">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Shield className="h-4 w-4" /> {t.label}
                    {t.id === "readonly" && <Badge variant="secondary" className="text-[10px]">safest</Badge>}
                    {t.id === "full" && <Badge variant="destructive" className="text-[10px]">broad</Badge>}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-xs text-muted-foreground">
                  <p>{t.description}</p>
                  <p className="text-[11px]">Denied: {t.deny.length > 0 ? t.deny.join(", ") : "nothing"}</p>
                  {tier === t.id && <p className="text-[11px] text-primary">✓ written to permissions.yaml on create</p>}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Cpu className="h-3.5 w-3.5" /> Optional — leave empty to inherit the instance model.</p>
            <div className="grid grid-cols-2 gap-3">
              <Input placeholder="Provider (e.g. deepseek; empty = inherit)" value={provider === "inherit" ? "" : provider} onChange={(e) => { setProvider(e.target.value || "inherit"); }} />
              <Input placeholder="Model (e.g. deepseek-chat)" value={model} onChange={(e) => setModel(e.target.value)} />
            </div>
            <Input placeholder="Daily token budget (default 5,000,000 · light 1,000,000 · heavy 20,000,000 · 0 = unlimited)" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ""))} />
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Crew options match the TUI onboarding exactly.</p>
            {[
              { key: "solo", title: "Solo bot", desc: "Works independently — no sub-bots.", icon: Network },
              crewAsLeadId
                ? { key: "crewman", title: `Crew member of ${crewAsLeadId}`, desc: "Joins this lead; inherits the lead's permissions unless a tier above was picked.", icon: Users }
                : { key: "leadauto", title: "Lead a fleet — auto-build the crew", desc: "Mercury proposes 3-5 matched specialists (an LLM call) and creates them in the background; they appear live on the roster.", icon: Crown },
              { key: "leadman", title: "Lead a fleet — I'll add crew myself", desc: "Becomes a lead now (gets bot_spawn) — add specialists later from its Ops panel, or tell it to hire its own crew.", icon: Crown },
            ].map((opt) => {
              const Icon = opt.icon;
              const active = fleet === opt.key;
              return (
                <Card key={opt.key} className={cn("cursor-pointer", active ? "border-primary" : "hover:border-primary/50")} onClick={() => setFleet(opt.key)}>
                  <CardContent className="py-3 flex items-start gap-2 text-sm">
                    <Icon className={cn("h-4 w-4 mt-0.5", opt.key.startsWith("lead") ? "text-yellow-500" : "")} />
                    <span>
                      <b>{opt.title}</b>
                      <p className="text-xs text-muted-foreground">{opt.desc}</p>
                    </span>
                  </CardContent>
                </Card>
              );
            })}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {step > 0 && (
            <Button variant="outline" onClick={() => setStep((s) => s - 1)}><ChevronLeft className="h-4 w-4" /> Back</Button>
          )}
          {step < 3 ? (
            <Button onClick={() => setStep((s) => s + 1)} disabled={!canNext}>Next <ChevronRight className="h-4 w-4" /></Button>
          ) : (
            <Button onClick={() => void create()} disabled={busy}>
              {busy ? "Creating…" : fleet === "leadman" ? "Create lead (add crew later)" : fleet === "leadauto" ? "Create & auto-build crew" : "Create bot"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}