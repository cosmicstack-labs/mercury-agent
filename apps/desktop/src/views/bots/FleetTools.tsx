import { Crown, Sparkles, UserPlus } from "lucide-react";
import { useState } from "react";
import * as api from "~/api/mercury";
import type { CrewSpec } from "~/api/types";
import { refreshBots } from "~/app/events";
import { useBots } from "~/app/store";
import { Button } from "~/components/ui/Button";
import { Dialog } from "~/components/ui/Dialog";
import { CrewEditor, slugify } from "./BotForms";

/**
 * Growing a fleet from its page: write a crew member yourself, or let
 * Mercury design more (it reads the lead's instructions and proposes
 * specialists it doesn't have yet; they appear as they're created).
 */
export function CrewActions({ leadId, leadName, crewCount, maxCrew = 6 }: { leadId: string; leadName: string; crewCount: number; maxCrew?: number }) {
  const bots = useBots((s) => s.bots);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<CrewSpec[]>([{ id: "", name: "", description: "", persona: "" }]);
  const [busy, setBusy] = useState<"add" | "suggest" | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const full = crewCount >= maxCrew;

  async function add() {
    const m = draft[0];
    if (!m.name.trim() || !m.persona.trim()) { setNote({ text: "Give it a name and instructions.", ok: false }); return; }
    setBusy("add");
    setNote(null);
    try {
      const taken = bots.map((b) => b.id);
      let id = slugify(m.name);
      for (let i = 2; taken.includes(id); i++) id = `${slugify(m.name)}-${i}`;
      await api.bots.addCrew(leadId, { id, name: m.name.trim(), description: m.description.trim(), persona: m.persona.trim() });
      setAdding(false);
      setDraft([{ id: "", name: "", description: "", persona: "" }]);
      setNote({ text: `${m.name.trim()} joined ${leadName}'s crew.`, ok: true });
      void refreshBots();
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(null);
    }
  }

  async function suggest() {
    setBusy("suggest");
    setNote(null);
    try {
      await api.bots.autoCrew(leadId);
      setNote({ text: "Mercury is designing crew for this fleet (up to a minute or two). New members appear here as they're created.", ok: true });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={full} onClick={() => setAdding(true)}><UserPlus size={13} /> Add a crew member</Button>
        <Button size="sm" variant="ghost" disabled={full} loading={busy === "suggest"} onClick={() => void suggest()}><Sparkles size={13} /> Let Mercury suggest crew</Button>
        {full && <span className="text-xs text-ink4">The crew is full ({maxCrew}).</span>}
      </div>
      {note && <p className={note.ok ? "text-xs text-ink3" : "text-xs text-red"}>{note.text}</p>}
      <Dialog open={adding} onOpenChange={setAdding} title={`New crew member for ${leadName}`} description="It gets the lead's permission level. The lead hands it work and combines what it sends back." width={560}>
        <div className="flex flex-col gap-3">
          <CrewEditor value={draft} onChange={(c) => setDraft(c.length ? c.slice(0, 1) : [{ id: "", name: "", description: "", persona: "" }])} max={1} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" loading={busy === "add"} onClick={() => void add()}>Add to the crew</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/** A bot working alone can become a fleet lead: then it hands parts of its job to crew. */
export function MakeFleet({ id, name }: { id: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function promote() {
    setBusy(true);
    setProblem(null);
    try {
      await api.bots.promote(id);
      await refreshBots();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
      <Crown size={16} className="shrink-0 text-ink3" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink">{name} works alone</div>
        <p className="text-xs text-ink3">Make it a fleet lead when the job has separate parts (research, writing, checking…). You then add crew, or let Mercury suggest them.</p>
        {problem && <p className="text-xs text-red">{problem}</p>}
      </div>
      <Button size="sm" variant="outline" loading={busy} onClick={() => void promote()}>Turn into a fleet</Button>
    </div>
  );
}
