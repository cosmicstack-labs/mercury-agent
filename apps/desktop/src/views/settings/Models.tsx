import { CheckCircle2, ExternalLink, KeyRound, Plug, Power, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "~/api/client";
import { modelsApi, type CheckField, type ProviderCheck, type ProviderInfo, type ProviderKind, type ProviderSettings, type SaveResult } from "~/api/models";
import { ModelPicker } from "~/components/ModelPicker";
import { Button } from "~/components/ui/Button";
import { Dialog } from "~/components/ui/Dialog";
import { Field, Input } from "~/components/ui/Input";
import { Badge, Spinner } from "~/components/ui/bits";
import { ConfirmButton, IconTile } from "~/components/ui/kit";
import { desktop } from "~/shell/tauri";
import { CloudCard } from "./Cloud";
import { cx } from "~/lib/cx";

/**
 * Models: which providers and gateways Mercury can use, and which model does
 * which job. Every key is checked live before it's saved (the check also
 * fetches every model the key can use, for the menu), saves apply to the
 * running Mercury at once, and keys are never shown back in full.
 */

const KIND_TITLE: Record<ProviderKind, { title: string; hint: string }> = {
  gateway: { title: "Gateways", hint: "One key, models from many labs." },
  cloud: { title: "Model labs", hint: "A key from the company that makes the model." },
  local: { title: "On this computer", hint: "Free and private; runs on your machine." },
  account: { title: "Subscriptions", hint: "Use a plan you already pay for." },
};
const KIND_ORDER: ProviderKind[] = ["gateway", "cloud", "local", "account"];

export function ModelsSettings() {
  const [data, setData] = useState<ProviderSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProviderInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await modelsApi.settings()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function saved(r: SaveResult, what: string) {
    setNotice(r.restarting ? `${what}. Mercury is restarting with it…` : r.restartRequired ? `${what}. Restart Mercury to use it (this Mercury is too old to apply it live).` : `${what}. In use from the next message.`);
    void load();
  }

  if (error) return <p className="text-sm text-red">Couldn't load providers: {error}</p>;
  if (!data) return <Spinner size={16} />;

  // Mercury Cloud has its own card, always first.
  const others = data.providers.filter((p) => p.id !== "mercuryCloud");
  const connected = others.filter((p) => p.configured);
  const rest = others.filter((p) => !p.configured);
  const anyConnected = data.providers.some((p) => p.configured);

  return (
    <section className="flex flex-col gap-6">
      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/[0.06] px-3 py-2 text-sm text-ink2">
          <CheckCircle2 size={15} className="shrink-0 text-accent" />{notice}
        </div>
      )}

      <CloudCard onChanged={() => void load()} />

      {anyConnected
        ? <Defaults data={data} onSaved={(r) => saved(r, "Saved")} />
        : <EmptyState />}

      {connected.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionTitle title="Connected" hint="Mercury falls back to these, in order, if the default can't answer." />
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            {connected.map((p) => (
              <ProviderRow key={p.id} p={p} onEdit={() => setEditing(p)}
                onOff={() => void modelsApi.save(p.id, { enabled: false }).then((r) => saved(r, `${p.label} turned off`)).catch((e) => setNotice(errorText(e)))}
                onForget={() => void modelsApi.forget(p.id).then((r) => saved(r, `${p.label} key removed`)).catch((e) => setNotice(errorText(e)))} />
            ))}
          </div>
        </div>
      )}

      {KIND_ORDER.map((kind) => {
        const list = rest.filter((p) => p.kind === kind);
        if (!list.length) return null;
        return (
          <div key={kind} className="flex flex-col gap-2">
            <SectionTitle title={connected.length ? `Add · ${KIND_TITLE[kind].title}` : KIND_TITLE[kind].title} hint={KIND_TITLE[kind].hint} />
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              {list.map((p) => <ProviderRow key={p.id} p={p} onEdit={() => setEditing(p)} />)}
            </div>
          </div>
        );
      })}

      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }} title={editing ? (editing.configured ? `${editing.label}` : `Connect ${editing.label}`) : ""} description={editing?.blurb} width={520}>
        {editing && (
          <ProviderEditor provider={editing} offerDefault={!editing.isDefault}
            onSaved={(r) => { setEditing(null); saved(r, `${editing.label} saved`); }} onCancel={() => setEditing(null)} />
        )}
      </Dialog>
    </section>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <h2 className="text-sm font-medium text-ink">{title}</h2>
      {hint && <span className="text-xs text-ink4">{hint}</span>}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber/40 bg-amber/[0.06] px-4 py-3">
      <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber" />
      <div className="text-sm text-ink2">
        <div className="font-medium text-ink">No model connected yet</div>
        Mercury needs at least one. Mercury Cloud is the quickest: sign in, no keys. Or bring your own key below; Ollama runs free models on this computer.
      </div>
    </div>
  );
}

function ProviderRow({ p, onEdit, onOff, onForget }: { p: ProviderInfo; onEdit: () => void; onOff?: () => void; onForget?: () => void }) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <IconTile id={p.id} label={p.label} size={34} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base text-ink">{p.label}</span>
          {p.isDefault && p.configured && <Badge tone="accent">default</Badge>}
          {p.recommended && !p.configured && <Badge tone="cyan">recommended</Badge>}
          {!p.configured && p.hasKey && <Badge tone="amber">off</Badge>}
        </div>
        <div className="truncate text-xs text-ink3">
          {p.configured ? <span className="font-mono">{p.model}{p.hasKey ? ` · ${p.apiKey}` : ""}</span> : p.blurb}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {p.configured ? (
          <>
            <Button size="sm" variant="outline" onClick={onEdit}>Edit</Button>
            {onOff && !p.isDefault && <Button size="sm" variant="ghost" icon onClick={onOff} aria-label={`Turn off ${p.label}`} title="Turn off"><Power size={14} /></Button>}
            {onForget && p.hasKey && <ConfirmButton size="sm" variant="ghost" confirmLabel="Remove key?" onConfirm={onForget}>Remove</ConfirmButton>}
          </>
        ) : (
          <Button size="sm" variant={p.recommended ? "primary" : "outline"} onClick={onEdit}><Plug size={13} /> {p.hasKey ? "Turn on" : "Connect"}</Button>
        )}
      </div>
    </div>
  );
}

// ── Defaults: which model does which job ─────────────────────────────────────

function Defaults({ data, onSaved }: { data: ProviderSettings; onSaved: (r: SaveResult) => void }) {
  const connected = data.providers.filter((p) => p.configured);
  const [provider, setProvider] = useState(data.default.provider);
  const [model, setModel] = useState(data.default.model);
  const catalog = useCatalog(provider);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setProvider(data.default.provider); setModel(data.default.model); }, [data.default.provider, data.default.model]);

  const changed = provider !== data.default.provider || model !== data.default.model;
  async function save(kind: string, body: Parameters<typeof modelsApi.roles>[0]) {
    setBusy(kind);
    setError(null);
    try { onSaved(await modelsApi.roles(body)); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="text-base font-medium text-ink">Chat and tasks</span>
          <span className="text-xs text-ink4">The default for chats, code, sub-agents and bots</span>
        </div>
        <div className="grid grid-cols-[minmax(0,200px)_minmax(0,1fr)] gap-2">
          <Select value={provider} onChange={(v) => { setProvider(v); setModel(data.providers.find((p) => p.id === v)?.model ?? ""); }} options={connected.map((p) => ({ value: p.id, label: p.label }))} label="Default provider" />
          <ModelPicker value={model} models={catalog.models} recommended={catalog.recommended} loading={catalog.loading} onChange={setModel} />
        </div>
        {catalog.error && <p className="text-xs text-amber">Couldn't list models: {catalog.error} You can still type a model id.</p>}
        {changed && (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setProvider(data.default.provider); setModel(data.default.model); }}>Undo</Button>
            <Button size="sm" variant="primary" loading={busy === "default"} disabled={!model} onClick={() => void save("default", { default: { provider, model } })}>Make default</Button>
          </div>
        )}
      </div>

      <div className="h-px bg-line" />

      <RoleRow title="Learning about you" hint="Reads conversations to update your memory. Strict JSON work: a capable mid-size model learns best."
        value={data.roles.learning} connected={connected} busy={busy === "learning"} onChange={(v) => void save("learning", { learning: v })} />
      <RoleRow title="Bot crews" hint="The model fleet crews run on. Something cheaper saves money on long-running bots."
        value={data.roles.crew} connected={connected} busy={busy === "crew"} onChange={(v) => void save("crew", { crew: v })} />
      <p className="text-xs text-ink4">Voice has its own settings, under Voice.</p>
      {error && <p className="text-sm text-red">{error}</p>}
    </div>
  );
}

function RoleRow({ title, hint, value, connected, busy, onChange }: { title: string; hint: string; value: string | null; connected: ProviderInfo[]; busy: boolean; onChange: (v: string | null) => void }) {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink">{title}</div>
        <div className="text-xs text-ink3">{hint}</div>
      </div>
      <div className="flex w-[220px] shrink-0 items-center gap-2">
        {busy && <Spinner size={12} />}
        <Select value={value ?? ""} onChange={(v) => onChange(v || null)} label={title}
          options={[{ value: "", label: "Same as chat" }, ...connected.map((p) => ({ value: p.id, label: `${p.label} · ${p.model}` }))]} />
      </div>
    </div>
  );
}

function Select({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>; label: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
      className="h-9 w-full min-w-0 truncate rounded-md border border-line bg-surface px-2.5 text-sm text-ink hover:border-ink/25">
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Models a connected provider offers, fetched once per provider with its saved key. */
function useCatalog(provider: string): { models: string[]; recommended?: string; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ provider: string; models: string[]; recommended?: string; loading: boolean; error: string | null }>({ provider, models: [], loading: true, error: null });
  useEffect(() => {
    let live = true;
    setState({ provider, models: [], loading: true, error: null });
    modelsApi.check(provider, {}).then((r) => {
      if (live) setState({ provider, models: r.models ?? [], recommended: r.recommendedModel, loading: false, error: r.ok ? null : r.error ?? "unknown error" });
    }).catch((e) => { if (live) setState({ provider, models: [], loading: false, error: errorText(e) }); });
    return () => { live = false; };
  }, [provider]);
  return state;
}

// ── One provider: key, address, test, model ──────────────────────────────────

type CheckState = { status: "idle" } | { status: "checking" } | ({ status: "done" } & ProviderCheck);

/**
 * Connect or edit one provider. The key is tested live (and the model list
 * fetched) before anything is saved; a key that fails says which field is
 * wrong. Leaving the key empty keeps the saved one.
 */
export function ProviderEditor({ provider: p, offerDefault, defaultOn = false, onSaved, onCancel, saveLabel }: {
  provider: ProviderInfo;
  offerDefault: boolean;
  defaultOn?: boolean;
  onSaved: (r: SaveResult) => void;
  onCancel?: () => void;
  saveLabel?: string;
}) {
  const showKey = !p.signInOnly && (p.needsKey || p.kind === "gateway" || p.hasKey);
  // A fixed-endpoint gateway (AI/ML API, Atlas Cloud, Runcrate…) says so with needsBaseUrl: false;
  // only those that point at your own endpoint, and local servers, show the address.
  const showUrl = !p.signInOnly && (p.needsBaseUrl || p.kind === "local");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [model, setModel] = useState(p.model);
  const [makeDefault, setMakeDefault] = useState(defaultOn || p.isDefault);
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; field?: string } | null>(null);

  const draft = useMemo(() => ({ apiKey: key.trim() || undefined, baseUrl: baseUrl.trim() !== p.baseUrl ? baseUrl.trim() : undefined }), [key, baseUrl, p.baseUrl]);
  const credentialsChanged = !!draft.apiKey || draft.baseUrl !== undefined;
  const canCheckNow = p.signInOnly ? p.configured : !(p.needsKey && !p.hasKey && !draft.apiKey) && !(p.needsBaseUrl && !baseUrl.trim());

  async function runCheck(): Promise<ProviderCheck | null> {
    setCheck({ status: "checking" });
    setSaveError(null);
    try {
      const r = await modelsApi.check(p.id, draft);
      setCheck({ status: "done", ...r });
      if (r.ok && r.models?.length && (!model || !r.models.includes(model))) setModel(r.recommendedModel || r.models[0]);
      return r;
    } catch (e) {
      const r: ProviderCheck = { ok: false, error: errorText(e) };
      setCheck({ status: "done", ...r });
      return r;
    }
  }

  // Already connected: load its model list straight away with the saved key.
  useEffect(() => { if (p.configured) void runCheck(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A new key or address needs a new test: the last result was for different credentials.
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current) { typed.current = true; return; }
    setCheck((c) => (c.status === "done" ? { status: "idle" } : c));
  }, [key, baseUrl]);

  async function save() {
    setSaveError(null);
    // Never save credentials that haven't passed a live check.
    if (credentialsChanged || !p.configured) {
      const ok = check.status === "done" && check.ok ? check : await runCheck();
      if (!ok?.ok) return;
    }
    if (!model.trim()) { setSaveError({ message: "Pick a model.", field: "model" }); return; }
    setSaving(true);
    try {
      let r = await modelsApi.save(p.id, { ...draft, model: model.trim(), enabled: true });
      if (makeDefault && offerDefault && !r.restarting) r = { ...r, ...(await modelsApi.roles({ default: { provider: p.id, model: model.trim() } })) };
      onSaved(r);
    } catch (e) {
      const field = e instanceof ApiError ? (e.data.field as string | undefined) : undefined;
      setSaveError({ message: errorText(e), field });
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (f: CheckField | "model") => (check.status === "done" && !check.ok && check.field === f ? check.error : saveError?.field === f ? saveError.message : undefined);
  const generalError = check.status === "done" && !check.ok && !check.field ? check.error : saveError && !saveError.field ? saveError.message : undefined;

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {p.signInOnly && (
        <div className="rounded-lg border border-line bg-soft px-3 py-2.5 text-sm text-ink2">
          {p.configured
            ? <>Signed in. Pick the model to use below.</>
            : <>{p.label} signs in with your account instead of a key. On the computer running Mercury, run <code className="rounded bg-ink/[0.06] px-1 font-mono text-xs">mercury doctor</code> and choose {p.label}, then come back here.</>}
        </div>
      )}

      {showKey && (
        <Field label={p.needsKey ? "API key" : "API key (optional)"} htmlFor={`key-${p.id}`}
          hint={p.hasKey ? `Saved: ${p.apiKey}. Leave empty to keep it.` : p.needsKey ? "Stored on the computer running Mercury, never shown again in full." : "Only if your gateway asks for one."}>
          <div className="flex gap-2">
            <Input id={`key-${p.id}`} type="password" mono autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)}
              placeholder={p.hasKey ? "Keep the saved key" : p.keyHint ?? "Paste your key"} aria-invalid={!!fieldError("apiKey")} className={cx(fieldError("apiKey") && "border-red/60")} />
            {p.keyUrl && (
              <Button type="button" size="md" variant="ghost" onClick={() => void desktop.openExternal(p.keyUrl!)} title="Get a key"><KeyRound size={14} /> Get a key <ExternalLink size={12} /></Button>
            )}
          </div>
          {fieldError("apiKey") && <p className="text-xs text-red">{fieldError("apiKey")}</p>}
        </Field>
      )}

      {showUrl && (
        <Field label={p.needsBaseUrl ? "Base URL" : "Address"} htmlFor={`url-${p.id}`}
          hint={p.kind === "local" ? `Where ${p.label} listens. Start it first, then test.` : p.needsBaseUrl ? "The endpoint's /v1 URL, e.g. https://openrouter.ai/api/v1" : undefined}>
          <Input id={`url-${p.id}`} mono value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1"
            aria-invalid={!!fieldError("baseUrl")} className={cx(fieldError("baseUrl") && "border-red/60")} />
          {fieldError("baseUrl") && <p className="text-xs text-red">{fieldError("baseUrl")}</p>}
        </Field>
      )}

      {(!p.signInOnly || p.configured) && (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" loading={check.status === "checking"} disabled={!canCheckNow} onClick={() => void runCheck()}>
            <RefreshCw size={13} /> {check.status === "done" && check.ok ? "Test again" : "Test connection"}
          </Button>
          {check.status === "done" && check.ok && (
            <span className="flex items-center gap-1.5 text-xs text-accent"><CheckCircle2 size={13} /> Connected{check.ms !== undefined ? ` in ${check.ms} ms` : ""} · {check.models?.length ?? 0} models</span>
          )}
          {check.status === "idle" && credentialsChanged && <span className="text-xs text-ink4">Tested before saving.</span>}
        </div>
      )}
      {generalError && <p className="rounded-md border border-red/30 bg-red/[0.05] px-3 py-2 text-xs text-red">{generalError}</p>}

      {(!p.signInOnly || p.configured) && (
        <Field label="Model" htmlFor={`model-${p.id}`} hint={check.status === "done" && check.ok ? "Every model this key can use. Type to search, or enter any id." : "Test the connection to list models, or type an id."}>
          <ModelPicker id={`model-${p.id}`} value={model} onChange={setModel} models={check.status === "done" ? check.models ?? [] : []}
            recommended={check.status === "done" ? check.recommendedModel : undefined} loading={check.status === "checking"} />
          {fieldError("model") && <p className="text-xs text-red">{fieldError("model")}</p>}
        </Field>
      )}

      {offerDefault && (!p.signInOnly || p.configured) && (
        <label className="flex items-center gap-2 text-sm text-ink2">
          <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} className="accent-[var(--accent,#1A9E6E)]" />
          Use as the default for chat and tasks
        </label>
      )}

      {(!p.signInOnly || p.configured) && (
        <div className="flex justify-end gap-2">
          {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
          <Button type="submit" variant="primary" loading={saving || (check.status === "checking" && saving)} disabled={saving || check.status === "checking" || !canCheckNow}>
            {saveLabel ?? (p.configured ? "Save" : "Connect")}
          </Button>
        </div>
      )}
    </form>
  );
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
