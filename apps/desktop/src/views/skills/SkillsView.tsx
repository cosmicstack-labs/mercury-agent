import { AlertTriangle, ChevronDown, Download, RefreshCw, Sparkles, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as api from "~/api/mercury";
import type { Skill, SkillDraft } from "~/api/types";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Switch } from "~/components/ui/Switch";
import { Badge, Empty, Mono, Segmented, Spinner } from "~/components/ui/bits";
import { ConfirmButton, IconTile, ItemRow, PageHeader, SearchField } from "~/components/ui/kit";
import { FieldMic } from "~/components/dictation/Dictation";
import { cx } from "~/lib/cx";

/**
 * Skills: make one, get one, manage yours. At the top, the skill builder:
 * say what you want (type or dictate), Mercury's model writes the skill,
 * you review and edit it or ask for changes, then save. Below it, install
 * by registry id or URL. Then every skill, with on/off and remove.
 */

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const IDEAS = [
  "Every Monday, summarise my GitHub notifications into a short list of what needs me",
  "Turn a YouTube link into clean study notes with the key points and timestamps",
  "Check my site's homepage, contact form and checkout, and tell me what's broken",
  "Draft a polite follow-up email for an invoice that's overdue",
];

export function SkillsView() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "on" | "off" | "self">("all");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  async function load() {
    setLoading(true);
    try { setSkills((await api.skills.list()).skills); } catch (err) { setNote({ text: errorText(err), ok: false }); }
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function act(key: string, fn: () => Promise<unknown>, done?: string) {
    setNote(null);
    setBusy(key);
    try { await fn(); if (done) setNote({ text: done, ok: true }); } catch (err) { setNote({ text: errorText(err), ok: false }); }
    setBusy(null);
    void load();
  }

  async function install() {
    const s = source.trim();
    if (!s) return;
    await act("install", () => (/^https?:\/\//i.test(s) ? api.skills.install(s) : api.skills.installFromRegistry(s)), "Installed.");
    setSource("");
  }

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => skills
    .filter((s) => filter === "all" || (filter === "self" ? s.selfMade : filter === "on" ? s.active : !s.active))
    .filter((s) => !q || `${s.name} ${s.description ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)), [skills, filter, q]);
  const active = skills.filter((s) => s.active).length;
  const selfMade = skills.filter((s) => s.selfMade).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Skills" meta={`${active} of ${skills.length} on`}>
        <Button variant="ghost" size="sm" icon onClick={() => void load()} loading={loading} aria-label="Refresh"><RefreshCw size={15} /></Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[820px] flex-col gap-4 px-8 py-6">
          <SkillBuilder onSaved={(name) => { setNote({ text: `Saved "${name}". Mercury will use it when you ask for this.`, ok: true }); setFilter("all"); void load(); }} />

          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-2 pl-3">
            <Download size={15} className="shrink-0 text-ink3" />
            <Input value={source} onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void install(); }}
              placeholder="Install a skill by registry id (category/name) or URL…" mono className="h-9 border-0 bg-transparent focus:border-0" aria-label="Install a skill" />
            <Button variant="outline" size="md" disabled={!source.trim()} loading={busy === "install"} onClick={() => void install()}>Install</Button>
          </div>

          {note && <p className={cx("text-sm", note.ok ? "text-accent" : "text-red")}>{note.text}</p>}

          <div className="mt-2 flex items-center gap-3">
            <Segmented size="md" value={filter} onChange={setFilter} options={[
              { value: "all", label: "All" }, { value: "on", label: "On" }, { value: "off", label: "Off" }, { value: "self", label: `Self-made · ${selfMade}` },
            ]} />
            <SearchField value={query} onChange={setQuery} placeholder="Search skills" className="ml-auto w-[240px]" />
          </div>
          {shown.length === 0 && !loading && <Empty title={q || filter !== "all" ? "No skill matches" : "No skills yet"} body={q || filter !== "all" ? undefined : "Build one above, or install one."} />}
          {shown.map((s) => (
            <ItemRow
              key={s.name}
              tile={<IconTile id={s.name} label={s.name} />}
              title={s.name}
              badges={<>{s.selfMade && <Badge tone="cyan">self-made</Badge>}{s.version && <Mono>{s.version}</Mono>}</>}
              description={s.description}
              footer={s.allowedTools && s.allowedTools.length > 0 ? <p className="truncate font-mono text-xs text-ink4">uses {s.allowedTools.join(", ")}</p> : undefined}
              actions={
                <>
                  <Switch id={`skill-${s.name}`} checked={s.active} onCheckedChange={(v) => void act(`t:${s.name}`, () => (v ? api.skills.activate(s.name) : api.skills.deactivate(s.name)))} label={s.active ? "On" : "Off"} />
                  <ConfirmButton size="sm" confirmLabel="Remove?" onConfirm={() => void act(`r:${s.name}`, () => api.skills.remove(s.name), `${s.name} removed.`)}>Remove</ConfirmButton>
                </>
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── The builder ─────────────────────────────────────────────────────────────

function SkillBuilder({ onSaved }: { onSaved: (name: string) => void }) {
  const [request, setRequest] = useState("");
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [clash, setClash] = useState<string | null>(null);
  const [model, setModel] = useState<string>("");
  const [tools, setTools] = useState<string[]>([]);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<"build" | "revise" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Folded to one line until you open it; a draft in progress keeps it open.
  const [open, setOpen] = useState(false);

  async function build(previous?: { draft: SkillDraft; feedback: string }) {
    setBusy(previous ? "revise" : "build");
    setError(null);
    try {
      const r = await api.skills.draft(request.trim(), previous);
      setDraft(r.draft);
      setProblem(r.problem);
      setClash(r.clash);
      setModel(r.model);
      setTools(r.tools);
      setFeedback("");
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  async function save() {
    if (!draft) return;
    setBusy("save");
    setError(null);
    try {
      const r = await api.skills.saveSelfMade({ ...draft, intents: draft.intents.map((i) => i.trim()).filter(Boolean) });
      onSaved(r.name);
      setDraft(null);
      setRequest("");
      setOpen(false);
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  const set = <K extends keyof SkillDraft>(k: K, v: SkillDraft[K]) => { setDraft((d) => (d ? { ...d, [k]: v } : d)); setProblem(null); setClash(null); };

  if (!draft && !open) {
    return (
      <button onClick={() => setOpen(true)} aria-expanded={false}
        className="flex w-full items-center gap-2.5 rounded-2xl border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-ink/25">
        <Wand2 size={16} className="shrink-0 text-accent" />
        <span className="text-base font-medium text-ink">Build a skill</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink4">Describe it; Mercury writes it, you check it before it's saved.</span>
        <ChevronDown size={15} className="shrink-0 text-ink4" />
      </button>
    );
  }

  if (!draft) {
    return (
      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
        <button onClick={() => { setOpen(false); setError(null); }} aria-expanded className="flex flex-wrap items-center gap-2 text-left">
          <Wand2 size={16} className="text-accent" />
          <span className="text-base font-medium text-ink">Build a skill</span>
          <span className="min-w-0 flex-1 truncate text-xs text-ink4">Describe it; Mercury writes it, and you check it before it's saved.</span>
          <ChevronDown size={15} className="shrink-0 rotate-180 text-ink4" />
        </button>
        <div className="relative">
          <textarea autoFocus value={request} onChange={(e) => setRequest(e.target.value)} rows={3} placeholder="What should Mercury be able to do? Say what it starts from and what you want back."
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && request.trim().length >= 10) void build(); }}
            className="w-full resize-none rounded-lg border border-line bg-bg py-2.5 pl-3 pr-10 text-sm leading-relaxed text-ink placeholder:text-ink4 focus:border-accent/60" aria-label="Describe the skill" />
          <FieldMic value={request} onChange={setRequest} />
        </div>
        {!request && (
          <div className="flex flex-wrap gap-1.5">
            {IDEAS.map((i) => (
              <button key={i} onClick={() => setRequest(i)} className="max-w-full truncate rounded-full border border-line px-2.5 py-1 text-xs text-ink2 hover:border-ink/25 hover:text-ink">{i}</button>
            ))}
          </div>
        )}
        {error && <p className="text-sm text-red">{error}</p>}
        <div className="flex items-center gap-2">
          <Button variant="primary" loading={busy === "build"} disabled={request.trim().length < 10} onClick={() => void build()}><Sparkles size={14} /> {busy === "build" ? "Writing the skill…" : "Build skill"}</Button>
          <span className="text-xs text-ink4">Uses your default model · ⌘↵</span>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-accent/40 bg-surface p-4">
      <div className="flex items-center gap-2">
        <Wand2 size={16} className="text-accent" />
        <span className="text-base font-medium text-ink">Review the skill</span>
        {model && <span className="font-mono text-xs text-ink4">written by {model}</span>}
        <span className="flex-1" />
        <button onClick={() => { setDraft(null); setError(null); }} className="rounded-md p-1 text-ink4 hover:bg-ink/[0.06] hover:text-ink" aria-label="Discard draft"><X size={15} /></button>
      </div>

      {(problem || clash) && (
        <p className="flex items-start gap-2 rounded-lg border border-amber/40 bg-amber/[0.05] px-3 py-2 text-sm text-ink2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber" />{clash ?? `Needs a fix before saving: ${problem}.`}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
        <label className="flex flex-col gap-1"><span className="text-xs font-medium text-ink2">Name</span>
          <Input value={draft.name} onChange={(e) => set("name", e.target.value)} mono aria-invalid={!!clash} className={cx(clash && "border-amber/60")} /></label>
        <label className="flex flex-col gap-1"><span className="text-xs font-medium text-ink2">What it does</span>
          <Input value={draft.description} onChange={(e) => set("description", e.target.value)} /></label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink2">When Mercury uses it <span className="font-normal text-ink4">(one way you'd ask, per line)</span></span>
        <textarea value={draft.intents.join("\n")} onChange={(e) => set("intents", e.target.value.split("\n"))} rows={Math.min(5, Math.max(2, draft.intents.length))}
          className="resize-y rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink focus:border-accent/60" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink2">Steps</span>
        <textarea value={draft.instructions} onChange={(e) => set("instructions", e.target.value)} rows={Math.min(16, Math.max(6, draft.instructions.split("\n").length + 1))}
          className="resize-y rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink focus:border-accent/60" />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink2">Tools it may use</span>
        <div className="flex flex-wrap gap-1.5">
          {(draft.allowedTools ?? []).length === 0 && <span className="text-xs text-ink4">Any of Mercury's tools</span>}
          {(draft.allowedTools ?? []).map((t) => (
            <span key={t} className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 font-mono text-xs text-ink2">
              {t}<button onClick={() => set("allowedTools", (draft.allowedTools ?? []).filter((x) => x !== t))} className="text-ink4 hover:text-ink" aria-label={`Remove ${t}`}><X size={10} /></button>
            </span>
          ))}
          {tools.length > 0 && (
            <select value="" onChange={(e) => { if (e.target.value) set("allowedTools", [...new Set([...(draft.allowedTools ?? []), e.target.value])]); }}
              className="h-6 rounded-md border border-dashed border-line bg-transparent px-1.5 text-xs text-ink3" aria-label="Add a tool">
              <option value="">+ add tool</option>
              {tools.filter((t) => !(draft.allowedTools ?? []).includes(t)).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-line bg-soft p-3">
        <span className="text-xs font-medium text-ink2">Ask for changes</span>
        <div className="flex gap-2">
          <Input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="e.g. also email the result to finance, and ask before deleting anything"
            onKeyDown={(e) => { if (e.key === "Enter" && feedback.trim()) void build({ draft, feedback }); }} aria-label="Ask for changes" />
          <Button variant="outline" size="md" loading={busy === "revise"} disabled={!feedback.trim() || busy !== null} onClick={() => void build({ draft, feedback })}>Revise</Button>
        </div>
      </div>

      {error && <p className="text-sm text-red">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={busy === "save"} disabled={busy !== null || !!clash} onClick={() => void save()}>Save skill</Button>
        <Button variant="ghost" onClick={() => { setDraft(null); setError(null); }}>Discard</Button>
        {busy === "revise" && <span className="flex items-center gap-1.5 text-xs text-ink3"><Spinner size={11} /> Rewriting…</span>}
        <span className="ml-auto text-xs text-ink4">Saved as self-made, marked "not run yet" until Mercury uses it.</span>
      </div>
    </section>
  );
}
