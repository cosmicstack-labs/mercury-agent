import { Check, Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { PluginSetting } from "~/api/types";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Switch } from "~/components/ui/Switch";
import { Badge, Spinner } from "~/components/ui/bits";
import { cx } from "~/lib/cx";

/**
 * One plugin setting, the right control for its type: choices as cards
 * (with the plugin's own words for each), on/off as a switch, text and
 * numbers as a field that saves on Enter or when you leave it, secrets as
 * a hidden field with Save (never shown back). Used inline in a plugin's
 * page and, larger, as a setup step.
 */

export function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

export function labelOf(s: PluginSetting): string {
  return s.label ?? humanize(s.key);
}

/** Does a setting apply, given the others' values? (Mirrors the runtime's whenMatches.) */
export function applies(s: PluginSetting, all: PluginSetting[]): boolean {
  if (!s.when) return true;
  const values = Object.fromEntries(all.map((x) => [x.key, x.value])) as Record<string, unknown>;
  const conds = Array.isArray(s.when) ? s.when : [s.when];
  return conds.some((c) => Object.entries(c).every(([k, want]) => {
    const v = String(values[k]);
    return Array.isArray(want) ? want.includes(v) : v === String(want);
  }));
}

/** Filled in? (Secrets: stored. Others: a non-empty value.) */
export function filled(s: PluginSetting): boolean {
  return s.type === "secret" ? !!s.isSet : s.value !== undefined && s.value !== null && s.value !== "";
}

/** "OpenAI: the most natural…" → { title: "OpenAI", body: "the most natural…" } */
function splitOptionLabel(label: string | undefined, fallback: string): { title: string; body: string | null } {
  if (!label) return { title: fallback, body: null };
  const m = label.match(/^([^:]{1,48}):\s+(.+)$/);
  return m ? { title: m[1].replace(/^[^\p{L}\p{N}]+/u, "").trim() || fallback, body: m[2] } : { title: label, body: null };
}

export function SettingField({ s, onSave, size = "inline" }: { s: PluginSetting; onSave: (value: unknown) => Promise<void>; size?: "inline" | "step" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  async function save(v: unknown) {
    setBusy(true);
    setError(null);
    setOk(false);
    try { await onSave(v); setOk(true); setTimeout(() => setOk(false), 1500); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const step = size === "step";

  let control: React.ReactNode;
  if (s.type === "enum") {
    const options = s.options ?? [];
    const cards = step || options.length <= 4;
    control = cards ? (
      <div className={cx("grid gap-2", step ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2")} role="radiogroup" aria-label={labelOf(s)}>
        {options.map((o) => {
          const { title, body } = splitOptionLabel(s.optionLabels?.[o], o);
          const on = s.value === o;
          return (
            <button key={o} role="radio" aria-checked={on} disabled={busy} onClick={() => void save(o)}
              className={cx("flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors", on ? "border-accent/60 bg-accent/[0.07]" : "border-line hover:border-ink/25")}>
              <span className={cx("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", on ? "border-accent bg-accent text-white" : "border-line")}>{on && <Check size={10} strokeWidth={3} />}</span>
              <span className="min-w-0">
                <span className="block text-sm text-ink">{title}</span>
                {body && <span className="block text-xs text-ink3">{body}</span>}
              </span>
            </button>
          );
        })}
      </div>
    ) : (
      <select value={String(s.value ?? "")} onChange={(e) => void save(e.target.value)} disabled={busy} aria-label={labelOf(s)}
        className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-ink">
        {options.map((o) => <option key={o} value={o}>{s.optionLabels?.[o] ?? o}</option>)}
      </select>
    );
  } else if (s.type === "boolean") {
    const on = s.value === true;
    const labels = s.optionLabels;
    control = step && labels ? (
      <div className="grid grid-cols-1 gap-2" role="radiogroup" aria-label={labelOf(s)}>
        {(["true", "false"] as const).map((k) => {
          const { title, body } = splitOptionLabel(labels[k], k === "true" ? "On" : "Off");
          const sel = (k === "true") === on;
          return (
            <button key={k} role="radio" aria-checked={sel} disabled={busy} onClick={() => void save(k === "true")}
              className={cx("flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left", sel ? "border-accent/60 bg-accent/[0.07]" : "border-line hover:border-ink/25")}>
              <span className={cx("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", sel ? "border-accent bg-accent text-white" : "border-line")}>{sel && <Check size={10} strokeWidth={3} />}</span>
              <span><span className="block text-sm text-ink">{title}</span>{body && <span className="block text-xs text-ink3">{body}</span>}</span>
            </button>
          );
        })}
      </div>
    ) : (
      <Switch checked={on} onCheckedChange={(v) => void save(v)} disabled={busy} />
    );
  } else if (s.type === "secret") {
    control = <SecretInput s={s} busy={busy} onSave={save} />;
  } else {
    control = <TextInput s={s} busy={busy} onSave={save} />;
  }

  const inlineRow = !step && (s.type === "boolean");
  return (
    <div className={cx("flex flex-col gap-1.5", inlineRow && "flex-row items-center justify-between gap-4")}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cx(step ? "text-base font-medium" : "text-sm", "text-ink")}>{labelOf(s)}</span>
          {s.type === "secret" && (s.isSet ? <Badge tone="accent">saved</Badge> : s.required ? <Badge tone="amber">required</Badge> : null)}
          {s.type !== "secret" && s.required && !filled(s) && <Badge tone="amber">required</Badge>}
          {busy && <Spinner size={11} />}
          {ok && !busy && <Check size={13} className="text-accent" />}
        </div>
        {s.description && <p className="text-xs leading-relaxed text-ink3">{s.description}</p>}
      </div>
      {control}
      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}

function TextInput({ s, busy, onSave }: { s: PluginSetting; busy: boolean; onSave: (v: unknown) => Promise<void> }) {
  const current = s.value === undefined || s.value === null ? "" : String(s.value);
  const [v, setV] = useState(current);
  useEffect(() => { setV(current); }, [current]);
  const commit = () => {
    if (v === current) return;
    if (s.type === "number") {
      const n = Number(v);
      if (v.trim() === "" || !Number.isFinite(n)) { setV(current); return; }
      void onSave(n);
    } else void onSave(v.trim());
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Input value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        type={s.type === "number" ? "number" : s.format === "phone" ? "tel" : "text"} disabled={busy} aria-label={labelOf(s)} placeholder={s.format === "phone" ? "+92 300 1234567" : "Not set"} mono={s.type !== "number"} />
      {s.examples && s.examples.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {s.examples.map((x) => (
            <button key={x} onClick={() => { setV(x); void onSave(s.type === "number" ? Number(x) : x); }} disabled={busy}
              className={cx("rounded-full border px-2.5 py-0.5 font-mono text-xs", v === x ? "border-accent/60 bg-accent/[0.07] text-ink" : "border-line text-ink2 hover:border-ink/25")}>{x}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function SecretInput({ s, busy, onSave }: { s: PluginSetting; busy: boolean; onSave: (v: unknown) => Promise<void> }) {
  const [v, setV] = useState("");
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-2">
      <div className="relative min-w-0 flex-1">
        <Input type={show ? "text" : "password"} autoComplete="off" mono value={v} onChange={(e) => setV(e.target.value)} disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter" && v.trim()) { void onSave(v.trim()).then(() => setV("")); } }}
          placeholder={s.isSet ? "Saved. Paste a new value to replace it" : "Paste it here"} aria-label={labelOf(s)} className="pr-9" />
        <button type="button" onClick={() => setShow((x) => !x)} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink4 hover:text-ink" aria-label={show ? "Hide" : "Show"}>{show ? <EyeOff size={14} /> : <Eye size={14} />}</button>
      </div>
      <Button size="md" variant="primary" disabled={!v.trim() || busy} onClick={() => void onSave(v.trim()).then(() => setV(""))}>Save</Button>
    </div>
  );
}
