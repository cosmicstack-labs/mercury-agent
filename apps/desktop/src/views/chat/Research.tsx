import { AlertTriangle, BookOpen, Check, ChevronDown, ChevronRight, CircleSlash, Copy, Download, FileText, Globe, ListChecks, Plus, RotateCw, Search, Telescope, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { exportArtifact, faviconUrl, type ExportFormat } from "~/api/artifacts";
import { Menu, MenuItem } from "~/components/ui/Menu";
import { useConnections } from "~/shell/connections";
import { isTauri } from "~/shell/tauri";
import * as api from "~/api/mercury";
import type { ResearchSnapshot, ResearchSource } from "~/api/types";
import { useConversation, useConversationStore } from "~/app/conversation";
import { sendMessage } from "~/app/events";
import { ArtifactViewer } from "~/components/artifacts/ArtifactViewer";
import { Button } from "~/components/ui/Button";
import { Dialog } from "~/components/ui/Dialog";
import { Segmented } from "~/components/ui/bits";
import { cx } from "~/lib/cx";

/**
 * Research, made visible. Four pieces:
 *  - ResearchBar      above the composer: research is on for your next
 *                     message, or a run is going (phase, counts, time) with
 *                     Details and "Write report now"
 *  - ResearchPlan     a proposed plan to edit, then Start (plan-first runs)
 *  - ResearchReport   under a report: how the run went, the file, and
 *                     Continue / Retry failed sources when it fell short
 *  - ResearchDetails  Activity and Sources: every search and every page,
 *                     and why the ones that failed failed
 */

const PHASE: Record<ResearchSnapshot["phase"], string> = {
  planning: "Planning",
  searching: "Searching",
  reading: "Reading sources",
  writing: "Writing the report",
};

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "31 sources read · 3 couldn't be read · 12 searches". */
export function researchCounts(r: Pick<ResearchSnapshot, "read" | "failed" | "searches" | "cited">, opts: { cited?: boolean } = {}): string {
  const parts = [`${r.read} source${r.read === 1 ? "" : "s"} read`];
  if (opts.cited && r.cited) parts.push(`${r.cited} cited`);
  if (r.failed) parts.push(`${r.failed} couldn't be read`);
  parts.push(`${r.searches} search${r.searches === 1 ? "" : "es"}`);
  return parts.join(" · ");
}

/** What a finished (or cut-short) run says about itself. */
export function outcomeLine(r: ResearchSnapshot): { title: string; tone: "ok" | "warn" | "bad" } {
  switch (r.state) {
    case "done": return { title: "Research report", tone: "ok" };
    case "partial": return { title: `Partial report: stopped early because ${r.cut ?? "it was interrupted"}`, tone: "warn" };
    case "stopped": return { title: r.cut === "you stopped it" ? "Research stopped" : `Research stopped: ${r.cut ?? "you stopped it"}`, tone: "warn" };
    case "failed": return { title: `Research didn't finish: ${r.cut ?? "something went wrong"}`, tone: "bad" };
    case "cancelled": return { title: "Research cancelled", tone: "warn" };
    default: return { title: "Researching", tone: "ok" };
  }
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/* ── above the composer ─────────────────────────────────────────── */

export function ResearchBar() {
  const research = useConversation((s) => s.research);
  const threadId = useConversation((s) => s.activeId);
  const streaming = useConversation((s) => !!s.streaming);
  const plan = useConversation((s) => s.plan);
  const run = research?.run;
  const running = run?.state === "running";
  const now = useNow(running);
  const [open, setOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { setFinishing(false); setProblem(null); }, [run?.runId]);

  if (!research || (!research.armed && !running)) return null;

  if (!running) {
    return (
      <Shell>
        <Telescope size={15} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm text-ink2">
          <span className="font-medium text-ink">Research is on</span> for your next message{research.planFirst ? ", with a plan to check first" : ""}. It searches live sources and writes a full report, then switches off.
        </span>
        {threadId && <Button size="sm" variant="ghost" onClick={() => void api.chat.researchOff(threadId).catch(() => {})}>Turn off</Button>}
      </Shell>
    );
  }

  const phase = streaming && run.phase !== "planning" ? "writing" : run.phase;
  const steps = plan?.steps ?? [];
  const done = steps.filter((s) => s.status === "done").length;

  async function finish() {
    if (!threadId) return;
    setFinishing(true);
    setProblem(null);
    try {
      await api.chat.finishResearch(threadId);
    } catch (e) {
      setFinishing(false);
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Shell>
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
        <span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-accent/40" />
        <span className="h-2 w-2 rounded-full bg-accent" />
      </span>
      <button onClick={() => setOpen(true)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-label="Research details">
        <span className="shrink-0 text-sm font-medium text-ink">{finishing ? "Writing the report" : PHASE[phase]}</span>
        <span className="min-w-0 truncate text-xs text-ink3">
          {steps.length >= 2 ? `${done} of ${steps.length} questions · ` : ""}
          {run.read} read{run.failed ? ` · ${run.failed} failed` : ""} · {run.searches} searches · {elapsed(now - run.startedAt)} · step {run.steps}/{run.maxSteps}
        </span>
        <ChevronRight size={14} className="shrink-0 text-ink4" />
      </button>
      {problem && <span className="max-w-[220px] truncate text-xs text-red" title={problem}>{problem}</span>}
      {phase !== "writing" && phase !== "planning" && run.read > 0 && !finishing && (
        <Button size="sm" variant="ghost" onClick={() => void finish()} title="Stop searching and write the report from what's been read">Write report now</Button>
      )}
      <ResearchDetails run={run} open={open} onOpenChange={setOpen} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0 px-8 pt-1">
      <div className="mx-auto w-full max-w-[780px]">
        <section className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-2 shadow-[0_1px_2px_rgb(0_0_0/0.04)]" role="status" aria-label="Research">
          {children}
        </section>
      </div>
    </div>
  );
}

/* ── the plan, before starting ──────────────────────────────────── */

export function ResearchPlan() {
  const plan = useConversation((s) => s.researchPlan);
  const store = useConversationStore();
  const [questions, setQuestions] = useState<string[]>([]);
  const [busy, setBusy] = useState<"start" | "cancel" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const now = useNow(!!plan);
  useEffect(() => { setQuestions(plan?.questions ?? []); setBusy(null); setProblem(null); }, [plan?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!plan) return null;
  const left = Math.max(0, plan.expiresAt - now);

  async function answer(action: "start" | "cancel") {
    if (!plan) return;
    setBusy(action);
    setProblem(null);
    try {
      await api.chat.answerResearchPlan(plan.id, action, questions.map((q) => q.trim()).filter(Boolean));
      store.getState().setResearchPlan(null);
    } catch (e) {
      setBusy(null);
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="ml-10 flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3.5" role="group" aria-label="Research plan">
      <div className="flex items-start gap-2.5">
        <ListChecks size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Research plan</p>
          <p className="text-xs text-ink3">Edit the questions it will answer, then start. Nothing has been searched yet.</p>
        </div>
      </div>
      <ol className="flex flex-col gap-1.5 pl-[26px]">
        {questions.map((q, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="w-4 shrink-0 text-right font-mono text-xs text-ink4">{i + 1}</span>
            <input value={q} onChange={(e) => setQuestions(questions.map((x, j) => (j === i ? e.target.value : x)))}
              className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 text-sm text-ink focus:border-line-strong focus:outline-none" aria-label={`Question ${i + 1}`} />
            <button onClick={() => setQuestions(questions.filter((_, j) => j !== i))} disabled={questions.length <= 1}
              className="rounded p-1.5 text-ink4 hover:text-red disabled:opacity-30" aria-label={`Remove question ${i + 1}`}><Trash2 size={13} /></button>
          </li>
        ))}
        {questions.length < 8 && (
          <li className="pl-6">
            <button onClick={() => setQuestions([...questions, ""])} className="flex items-center gap-1.5 text-xs text-ink2 hover:text-ink"><Plus size={13} /> Add a question</button>
          </li>
        )}
      </ol>
      <div className="flex flex-wrap items-center gap-2 pl-[26px]">
        <Button size="sm" variant="primary" loading={busy === "start"} disabled={!!busy || !questions.some((q) => q.trim())} onClick={() => void answer("start")}>Start research</Button>
        <Button size="sm" variant="ghost" loading={busy === "cancel"} disabled={!!busy} onClick={() => void answer("cancel")}>Cancel</Button>
        <span className="text-xs text-ink4">Starts as shown in {elapsed(left)} if you don't answer.</span>
        {problem && <span className="text-xs text-red">{problem}</span>}
      </div>
    </div>
  );
}

/* ── under a report ─────────────────────────────────────────────── */

export function ResearchReport({ run, content }: { run: ResearchSnapshot; content: string }) {
  const threadId = useConversation((s) => s.activeId);
  const surface = useConversation((s) => s.surface);
  const latest = useConversation((s) => s.research?.run?.runId === run.runId || !s.research?.run);
  const busy = useConversation((s) => s.agent === "thinking" || s.agent === "working" || s.agent === "streaming");
  const [details, setDetails] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState<{ text: string; ok: boolean } | null>(null);
  const local = useConnections((s) => s.connections.find((c) => c.id === s.activeId)?.kind === "local");
  const { title, tone } = outcomeLine(run);

  async function exportAs(format: ExportFormat) {
    if (!run.report) return;
    setExported({ text: format === "original" ? "Saving…" : `Making the ${format === "pdf" ? "PDF" : "Word document"}…`, ok: true });
    try {
      const dest = await exportArtifact(run.report, format, !!local, isTauri);
      setExported(dest === null ? null : { text: dest ? `Saved to ${dest}` : "Downloaded.", ok: true });
    } catch (e) {
      setExported({ text: e instanceof Error ? e.message : String(e), ok: false });
    }
  }
  const took = run.endedAt ? elapsed(run.endedAt - run.startedAt) : null;
  const shortOf = run.state !== "done";

  function again(cmd: "/research continue" | "/research retry") {
    if (!threadId) return;
    void sendMessage(surface, cmd).catch(() => {});
  }

  return (
    <div className={cx("mt-3 flex flex-col gap-2.5 rounded-xl border px-3.5 py-3",
      tone === "ok" ? "border-line bg-soft" : tone === "warn" ? "border-amber/40 bg-amber/[0.05]" : "border-red/40 bg-red/[0.05]")} aria-label="Research summary">
      <div className="flex items-start gap-2.5">
        {tone === "ok" ? <BookOpen size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          : tone === "warn" ? <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber" aria-hidden="true" />
          : <CircleSlash size={15} className="mt-0.5 shrink-0 text-red" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{title}</p>
          <p className="text-xs text-ink3">{researchCounts(run, { cited: true })}{took ? ` · ${took}` : ""}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-[25px]">
        {run.report && <Button size="sm" variant="secondary" onClick={() => setReportOpen(true)}><FileText size={13} /> Open report</Button>}
        {run.report && (
          <Menu trigger={<Button size="sm" variant="ghost" aria-label="Export the report"><Download size={13} /> Export <ChevronDown size={12} /></Button>}>
            <MenuItem onSelect={() => void exportAs("pdf")} hint="links stay clickable">PDF</MenuItem>
            <MenuItem onSelect={() => void exportAs("docx")} hint="Word, Pages, Google Docs">Word (.docx)</MenuItem>
            <MenuItem onSelect={() => void exportAs("original")} hint="with every source">Markdown (.md)</MenuItem>
          </Menu>
        )}
        {content.trim() && (
          <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setDetails(true)}><Globe size={13} /> Sources & activity</Button>
        {latest && !busy && (
          <>
            <Button size="sm" variant={shortOf ? "secondary" : "ghost"} onClick={() => again("/research continue")}>
              <Telescope size={13} /> {shortOf ? "Continue research" : "Go deeper"}
            </Button>
            {run.failed > 0 && <Button size="sm" variant="ghost" onClick={() => again("/research retry")}><RotateCw size={13} /> Retry {run.failed} failed</Button>}
          </>
        )}
      </div>
      {exported && <p className={cx("pl-[25px] text-xs", exported.ok ? "text-ink3" : "text-red")} data-selectable>{exported.text}</p>}
      <ResearchDetails run={run} open={details} onOpenChange={setDetails} />
      {run.report && (
        <Dialog open={reportOpen} onOpenChange={setReportOpen} title="Research report" width={900}>
          {reportOpen && <div className="-m-5 h-[75vh]"><ArtifactViewer id={run.report.id} onDeleted={() => setReportOpen(false)} /></div>}
        </Dialog>
      )}
    </div>
  );
}

/* ── Activity and Sources ───────────────────────────────────────── */

export function ResearchDetails({ run, open, onOpenChange }: { run: ResearchSnapshot; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [tab, setTab] = useState<"activity" | "sources">("sources");
  const [filter, setFilter] = useState<"all" | "failed">("all");
  const plan = useConversation((s) => s.plan);
  const sources = [...run.sourceList].reverse().filter((s) => filter === "all" || s.status === "failed");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={run.topic.length > 70 ? `${run.topic.slice(0, 70)}…` : run.topic} description={researchCounts(run, { cited: true })} width={720}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Segmented value={tab} onChange={setTab} options={[{ value: "sources", label: `Sources (${run.read + run.failed})` }, { value: "activity", label: "Activity" }]} />
          <div className="flex-1" />
          {tab === "sources" && run.failed > 0 && <Segmented value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "failed", label: `Failed (${run.failed})` }]} />}
        </div>
        {tab === "sources" ? (
          sources.length === 0
            ? <p className="py-6 text-center text-sm text-ink3">{run.state === "running" ? "No pages read yet: it's still searching." : "No pages were read."}</p>
            : <ul className="flex max-h-[55vh] flex-col divide-y divide-line overflow-y-auto rounded-lg border border-line">{sources.map((s) => <SourceRow key={s.url} source={s} />)}</ul>
        ) : (
          <div className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto">
            {(plan?.steps?.length ?? 0) > 0 && run.state === "running" ? (
              <section>
                <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink4">Questions</h3>
                <ol className="flex flex-col gap-1">
                  {plan!.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      {s.status === "done" ? <Check size={14} className="mt-0.5 shrink-0 text-accent" /> : <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", s.status === "active" ? "animate-pulse bg-accent" : "border border-ink4")} />}
                      <span className={s.status === "done" ? "text-ink3" : s.status === "active" ? "font-medium text-ink" : "text-ink2"}>{s.label}</span>
                    </li>
                  ))}
                </ol>
              </section>
            ) : run.questions.length > 0 && (
              <section>
                <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink4">Questions</h3>
                <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-ink2">{run.questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
              </section>
            )}
            <section>
              <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink4">Searches ({run.searches})</h3>
              {run.searchList.length === 0 ? <p className="text-sm text-ink3">None yet.</p> : (
                <ul className="flex flex-col gap-1">
                  {[...run.searchList].reverse().map((q, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <Search size={13} className={cx("mt-1 shrink-0", q.ok ? "text-ink4" : "text-red")} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="text-ink2" data-selectable>{q.query || "(top stories)"}</span>
                        <span className={cx("ml-2 text-xs", q.ok ? "text-ink4" : "text-red")}>{q.ok ? `${q.results} results` : q.reason ?? "found nothing"}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {run.cut && <p className="rounded-md border border-amber/40 bg-amber/[0.06] px-3 py-2 text-sm text-ink2">Stopped early because {run.cut}.</p>}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** A site's icon (fetched by the runtime), or its first letters while there's none. */
export function SiteIcon({ domain, failed, cited }: { domain: string; failed?: boolean; cited?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    void faviconUrl(domain).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [domain]);
  return (
    <span className="relative mt-0.5 flex h-6 w-6 shrink-0" aria-hidden="true">
      {url
        ? <img src={url} alt="" className={cx("h-6 w-6 rounded-md bg-white object-contain p-0.5 ring-1 ring-line", failed && "opacity-50 grayscale")} draggable={false} />
        : <span className={cx("flex h-6 w-6 items-center justify-center rounded-md font-mono text-2xs uppercase", failed ? "bg-red/10 text-red" : cited ? "bg-accent/15 text-accent" : "bg-ink/[0.06] text-ink3")}>{domain.slice(0, 2)}</span>}
      {failed && <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red text-white ring-2 ring-surface"><X size={9} strokeWidth={3} /></span>}
      {cited && !failed && <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-on-accent ring-2 ring-surface"><Check size={9} strokeWidth={3} /></span>}
    </span>
  );
}

function SourceRow({ source: s }: { source: ResearchSource }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <SiteIcon domain={s.domain} failed={s.status === "failed"} cited={s.cited} />
      <span className="min-w-0 flex-1">
        <a href={s.url} target="_blank" rel="noreferrer" className="block truncate text-sm text-ink hover:underline" title={s.url}>{s.title || s.domain}</a>
        <span className="block truncate text-xs text-ink4">{s.domain}</span>
      </span>
      <span className={cx("shrink-0 text-xs", s.status === "failed" ? "text-red" : s.cited ? "text-accent" : "text-ink4")}>
        {s.status === "failed" ? s.reason ?? "failed" : s.cited ? "cited" : "read"}
      </span>
    </li>
  );
}
