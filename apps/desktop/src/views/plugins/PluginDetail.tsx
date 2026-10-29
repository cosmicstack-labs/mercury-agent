import { AlertTriangle, ArrowUpCircle, Download, Globe, KeyRound, ListChecks, Monitor, RotateCcw, Sparkles, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import * as api from "~/api/mercury";
import type { PluginItem, PluginSetting } from "~/api/types";
import { Button } from "~/components/ui/Button";
import { Switch } from "~/components/ui/Switch";
import { Badge, Mono, Spinner } from "~/components/ui/bits";
import { ConfirmButton, IconTile } from "~/components/ui/kit";
import { cx } from "~/lib/cx";
import { ChannelPanel } from "./ChannelPanel";
import { applies, SettingField } from "./SettingField";
import { needsSetup, setupKeys } from "./SetupFlow";

/**
 * One plugin, everything about it on one page: on or off; what needs
 * attention and how to fix it; setup again; the account it's linked to;
 * every setting, in the plugin's own sections; what it can reach (sites,
 * keys, the screen) and what it adds (tools, commands); update, roll back,
 * remove (with or without its data).
 */

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function size(bytes?: number): string {
  if (!bytes) return "";
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function StatusDot({ on, className }: { on: boolean; className?: string }) {
  return <span className={cx("inline-block h-2.5 w-2.5 shrink-0 rounded-full", on ? "bg-accent" : "bg-ink/25", className)} aria-label={on ? "On" : "Off"} />;
}

export function PluginDetail({ id, onSetup, onChanged, onRemoved }: { id: string; onSetup: () => void; onChanged: () => void; onRemoved: () => void }) {
  const [p, setP] = useState<PluginItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [purge, setPurge] = useState(false);

  const load = useCallback(async () => {
    try { setP(await api.plugins.info(id)); setError(null); } catch (e) { setError(errorText(e)); }
  }, [id]);
  useEffect(() => { setP(null); setNote(null); void load(); }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    setNote(null);
    try { await fn(); if (done) setNote({ text: done, ok: true }); await load(); onChanged(); } catch (e) { setNote({ text: errorText(e), ok: false }); } finally { setBusy(null); }
  }

  async function saveSetting(key: string, value: unknown) {
    await api.plugins.setSetting(id, key, value);
    await load();
    onChanged();
  }

  if (error && !p) return <p className="p-6 text-sm text-red">{error}{/only|local|this computer/i.test(error) ? "" : ""}</p>;
  if (!p) return <div className="p-6"><Spinner size={16} /></div>;

  const all = p.settings ?? [];
  const shown = all.filter((s) => applies(s, all));
  const groups = p.settingGroups ?? [];
  const loose = shown.filter((s) => !s.group || !groups.some((g) => g.id === s.group));
  const problem = p.lastError || p.disabled?.message || p.incompatibleReason;
  const attention = needsSetup(p);
  const hasSetup = setupKeys(p).length > 0 || (!!p.channel && p.channel.type !== "desktop");
  const updatable = p.status === "update-available";

  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <div className="flex items-start gap-4">
        <IconTile id={p.id} label={p.name} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">{p.name}</h2>
            <Mono>{p.installedVersion}</Mono>
            {p.tier === "official" && <Badge tone="accent">official</Badge>}
            {p.tier === "local" && <Badge>local</Badge>}
            {p.verified && p.tier !== "official" && <Badge>verified</Badge>}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-ink2">{p.description}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            {busy === "toggle" && <Spinner size={12} />}
            <StatusDot on={p.enabled} />
            <Switch checked={p.enabled} disabled={busy !== null || (p.status === "incompatible" && !p.enabled)}
              onCheckedChange={(v) => void run("toggle", () => (v ? api.plugins.enable(id) : api.plugins.disable(id)), v ? `${p.name} is on.` : `${p.name} is off.`)} label={p.enabled ? "On" : "Off"} />
          </div>
          {p.enabled && !p.running && !problem && <span className="text-2xs text-ink4">on · runs in the background service</span>}
        </div>
      </div>

      {note && <p className={cx("text-sm", note.ok ? "text-accent" : "text-red")}>{note.text}</p>}

      {(problem || attention || (p.missing ?? []).length > 0) && (
        <section className="flex flex-col gap-2 rounded-xl border border-amber/40 bg-amber/[0.05] p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-ink"><AlertTriangle size={15} className="text-amber" /> Needs your attention</div>
          {problem && <p className="text-sm text-ink2">{problem}</p>}
          {attention && <p className="text-sm text-ink2">Some required settings aren't filled in yet.</p>}
          {(p.missing ?? []).map((m) => (
            <p key={m.key} className="text-sm text-ink2"><span className="text-ink">{m.unlocks}</span> is off: it needs {m.needs}. <span className="text-ink3">{m.fix}</span></p>
          ))}
          {hasSetup && <div><Button size="sm" variant="primary" onClick={onSetup}><ListChecks size={13} /> Run setup</Button></div>}
        </section>
      )}

      {updatable && (
        <section className="flex items-center gap-3 rounded-xl border border-cyan/40 bg-cyan/[0.05] px-4 py-3">
          <ArrowUpCircle size={16} className="text-cyan" />
          <span className="flex-1 text-sm text-ink2">Version {p.latestVersion} is available.</span>
          <Button size="sm" variant="primary" loading={busy === "update"} onClick={() => void run("update", () => api.plugins.update(id), `Updated to ${p.latestVersion}.`)}>Update</Button>
        </section>
      )}

      {p.channel && p.channel.type !== "desktop" && (
        <Section title="Account" hint="The account Mercury talks through.">
          {p.enabled ? <ChannelPanel id={id} name={p.name} /> : <p className="text-sm text-ink3">Turn {p.name} on to link an account.</p>}
        </Section>
      )}

      {shown.length > 0 && (
        <Section title="Settings" hint="Changes apply at once; the plugin restarts if it needs to." action={hasSetup && !attention ? <Button size="sm" variant="ghost" onClick={onSetup}><Sparkles size={13} /> Run setup again</Button> : null}>
          <div className="flex flex-col gap-4">
            {groups.map((g) => {
              const fields = shown.filter((s) => s.group === g.id);
              if (!fields.length) return null;
              return (
                <div key={g.id} className="flex flex-col gap-4 rounded-xl border border-line p-4">
                  <div>
                    <div className="flex items-center gap-2"><span className="text-sm font-medium text-ink">{g.label.replace(/^[^\p{L}\p{N}]+/u, "")}</span><Badge tone={g.ready ? "accent" : "amber"}>{g.ready ? "ready" : "needs setup"}</Badge></div>
                    {g.description && <p className="text-xs text-ink3">{g.description}</p>}
                  </div>
                  {fields.map((s) => <SettingField key={s.key} s={s} onSave={(v) => saveSetting(s.key, v)} />)}
                </div>
              );
            })}
            {loose.length > 0 && (
              <div className="flex flex-col gap-4 rounded-xl border border-line p-4">
                {groups.length > 0 && <span className="text-sm font-medium text-ink">General</span>}
                {orderLoose(loose).map((s) => <SettingField key={s.key} s={s} onSave={(v) => saveSetting(s.key, v)} />)}
              </div>
            )}
          </div>
        </Section>
      )}

      <Section title="What it can do and reach">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Fact icon={<Wrench size={13} />} title={`${p.tools.length} tool${p.tools.length === 1 ? "" : "s"}${p.commands.length ? ` · ${p.commands.length} command${p.commands.length === 1 ? "" : "s"}` : ""}`}
            body={[...p.tools.map((t) => t.replace(/^[^_]+__/, "")), ...p.commands].join(", ") || "None"} />
          <Fact icon={<Globe size={13} />} title="Internet" body={p.permissions?.network?.length ? p.permissions.network.join(", ") : "No internet access"} />
          <Fact icon={<KeyRound size={13} />} title="Keys it can read" body={p.permissions?.secrets?.length ? p.permissions.secrets.join(", ") : "None"} />
          <Fact icon={<Monitor size={13} />} title="Runs" body={`${p.kind === "in-process" ? "Inside Mercury" : "In its own process"}${p.permissions?.desktop ? " · uses this computer's screen, mouse and keyboard" : ""}${p.sizeBytes ? ` · ${size(p.sizeBytes)}` : ""}`} />
        </div>
      </Section>

      <Section title="Version and removal">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink2">Installed <Mono>{p.installedVersion}</Mono>{p.latestVersion && p.latestVersion !== p.installedVersion ? <> · catalog <Mono>{p.latestVersion}</Mono></> : null}</span>
            <span className="flex-1" />
            {p.previousVersion && (
              <ConfirmButton size="sm" variant="ghost" confirmLabel={`Go back to ${p.previousVersion}?`} loading={busy === "rollback"}
                onConfirm={() => void run("rollback", async () => { const r = await api.plugins.rollback(id); setNote({ text: `Rolled back from ${r.from} to ${r.to}.`, ok: true }); })}>
                <RotateCcw size={13} /> Roll back to {p.previousVersion}
              </ConfirmButton>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-red/25 bg-red/[0.03] px-3 py-2.5">
            <Trash2 size={14} className="text-red" />
            <span className="flex-1 text-sm text-ink2">Remove {p.name}</span>
            <label className="flex items-center gap-1.5 text-xs text-ink3"><input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} className="accent-[var(--red,#d14)]" /> also delete its data and settings</label>
            <ConfirmButton size="sm" variant="ghost" confirmLabel={purge ? "Remove with data?" : "Remove?"} loading={busy === "remove"} onConfirm={() => void (async () => {
              setBusy("remove");
              try { await api.plugins.uninstall(id, purge); onRemoved(); } catch (e) { setNote({ text: errorText(e), ok: false }); setBusy(null); }
            })()}>Remove</ConfirmButton>
          </div>
        </div>
      </Section>
    </div>
  );
}

/** Ungrouped settings: setup ones first (they matter most), in the plugin's order. */
function orderLoose(list: PluginSetting[]): PluginSetting[] {
  return [...list.filter((s) => s.setup), ...list.filter((s) => !s.setup)];
}

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div><h3 className="text-sm font-semibold text-ink">{title}</h3>{hint && <p className="text-xs text-ink3">{hint}</p>}</div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Fact({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-ink2">{icon}{title}</div>
      <p className="mt-0.5 break-words font-mono text-xs text-ink3">{body}</p>
    </div>
  );
}

/** A plugin from the catalog, before installing: what it is, what it can reach, Install. */
export function CatalogDetail({ p, installing, onInstall }: { p: PluginItem; installing: boolean; onInstall: () => void }) {
  const incompatible = p.status === "incompatible";
  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <div className="flex items-start gap-4">
        <IconTile id={p.id} label={p.name} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">{p.name}</h2>
            <Mono>{p.latestVersion}</Mono>
            {p.tier === "official" ? <Badge tone="accent">official</Badge> : <Badge>community</Badge>}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-ink2">{p.description}</p>
        </div>
        <Button size="md" variant="primary" loading={installing} disabled={incompatible} onClick={onInstall}><Download size={14} /> {installing ? "Installing…" : "Install"}</Button>
      </div>
      {incompatible && <p className="rounded-lg border border-amber/40 bg-amber/[0.05] px-3 py-2 text-sm text-ink2">{p.incompatibleReason ?? "Not compatible with this Mercury or computer."}</p>}
      <Section title="What it can do and reach" hint="From the catalog. You'll set it up right after installing.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Fact icon={<Wrench size={13} />} title={`${p.tools.length} tool${p.tools.length === 1 ? "" : "s"}`} body={p.tools.map((t) => t.replace(/^[^_]+__/, "")).join(", ") || "None listed"} />
          <Fact icon={<Globe size={13} />} title="Internet" body={p.permissions?.network?.length ? p.permissions.network.join(", ") : "No internet access"} />
          <Fact icon={<KeyRound size={13} />} title="Keys it can read" body={p.permissions?.secrets?.length ? p.permissions.secrets.join(", ") : "None"} />
          <Fact icon={<Monitor size={13} />} title="Runs" body={`${p.kind === "in-process" ? "Inside Mercury" : "In its own process"}${p.sizeBytes ? ` · ${size(p.sizeBytes)} download` : ""}`} />
        </div>
      </Section>
    </div>
  );
}
