import { CheckCircle2, CircleAlert, ExternalLink, Mic } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fieldApplies, modelsApi, voiceApi, type ProviderSettings, type VoiceCheck, type VoiceField, type VoicePlugin, type VoiceVendor } from "~/api/models";
import { useUi } from "~/app/store";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Switch } from "~/components/ui/Switch";
import { Badge, Spinner } from "~/components/ui/bits";
import { cx } from "~/lib/cx";
import { errorText } from "./Models";

/**
 * Voice: who listens and who speaks when you talk to Mercury. Lives in the
 * Optimus plugin's settings; this screen shows only what applies to the
 * chosen engine. Keys are tested against the vendor before they're saved,
 * and voice/model menus fill from the vendor when it can list them.
 */

const VENDOR_OF: Record<string, VoiceVendor> = {
  geminiKey: "gemini", elevenlabsKey: "elevenlabs", azureKey: "azure", qwenKey: "qwen", deepgramKey: "deepgram",
  assemblyaiKey: "assemblyai", sarvamKey: "sarvam", cartesiaKey: "cartesia", minimaxKey: "minimax",
};
/** Engines that think and speak with a Mercury model provider's key (set under Models). */
const ENGINE_PROVIDER: Record<string, { id: string; label: string }> = { openai: { id: "openai", label: "OpenAI" }, grok: { id: "grok", label: "Grok (xAI)" } };
const HOW = ["mode", "hotkey", "muteHotkey"];
const BEHAVIOUR = ["bargeIn", "thinkingSound", "idleStopSeconds", "maxSessionMinutes"];

export function VoiceSettings({ onOpenModels }: { onOpenModels: () => void }) {
  const [plugin, setPlugin] = useState<VoicePlugin | null | undefined>(undefined);
  const [providers, setProviders] = useState<ProviderSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Voices / models a key check returned, by vendor, for the menus. */
  const [lists, setLists] = useState<Partial<Record<VoiceVendor, VoiceCheck>>>({});
  const setView = useUi((s) => s.setView);

  const load = useCallback(async () => {
    try {
      const [pl, pr] = await Promise.all([voiceApi.plugin().catch(() => null), modelsApi.settings().catch(() => null)]);
      setPlugin(pl);
      setProviders(pr);
    } catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const fields = plugin?.settings ?? [];
  const values = Object.fromEntries(fields.map((f) => [f.key, f.value])) as Record<string, unknown>;
  const engine = String(values.voiceEngine ?? "");

  // Fill voice and model menus from keys that are already saved.
  useEffect(() => {
    for (const f of fields) {
      const vendor = VENDOR_OF[f.key];
      if (!vendor || !f.isSet || lists[vendor] || !fieldApplies(f, values) || !["elevenlabs", "cartesia", "gemini"].includes(vendor)) continue;
      void voiceApi.check(vendor, undefined, String(values.azureEndpoint ?? "")).then((r) => setLists((l) => ({ ...l, [vendor]: r }))).catch(() => {});
    }
  }, [plugin]); // eslint-disable-line react-hooks/exhaustive-deps

  async function set(key: string, value: unknown) {
    await voiceApi.set(key, value);
    await load();
  }

  if (error) return <p className="text-sm text-red">{error}</p>;
  if (plugin === undefined) return <Spinner size={16} />;
  if (!plugin || !plugin.installedVersion) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-line bg-surface p-5">
        <Mic size={18} className="mt-0.5 text-ink3" />
        <div className="flex flex-1 flex-col gap-2">
          <div className="text-base text-ink">Voice comes with the Optimus plugin</div>
          <p className="text-sm text-ink3">Install Optimus to talk to Mercury out loud: a hotkey, live voice, and Mercury controlling your computer when you ask.</p>
          <div><Button size="sm" variant="primary" onClick={() => setView("plugins")}>Open Plugins</Button></div>
        </div>
      </div>
    );
  }

  const byKey = new Map(fields.map((f) => [f.key, f]));
  const applies = (k: string) => { const f = byKey.get(k); return !!f && fieldApplies(f, values); };
  const engineField = byKey.get("voiceEngine");
  const engineFields = fields.filter((f) => f.group === "voice" && f.key !== "voiceEngine" && !BEHAVIOUR.includes(f.key) && fieldApplies(f, values));
  const group = plugin.settingGroups?.find((g) => g.id === "voice");
  const usesProvider = ENGINE_PROVIDER[engine];
  const provider = usesProvider ? providers?.providers.find((p) => p.id === usesProvider.id) : undefined;

  return (
    <section className="flex flex-col gap-5">
      <Card title="How you talk to Mercury">
        {HOW.filter(applies).map((k) => <FieldRow key={k} f={byKey.get(k)!} onSave={set} lists={lists} values={values} />)}
      </Card>

      {engineField && applies("voiceEngine") && (
        <Card title="Voice engine" badge={group ? (group.ready ? <Badge tone="accent">ready</Badge> : <Badge tone="amber">needs setup</Badge>) : null}
          hint="Who listens and speaks. OpenAI is the most natural; “Mercury” lets your own model think, with separate speech services.">
          <div className="grid grid-cols-2 gap-2">
            {(engineField.options ?? []).map((o) => (
              <button key={o} onClick={() => void set("voiceEngine", o)} aria-pressed={engine === o}
                className={cx("rounded-lg border px-3 py-2.5 text-left transition-colors", engine === o ? "border-accent/60 bg-accent/[0.07]" : "border-line hover:border-ink/25")}>
                <div className="text-sm font-medium text-ink">{ENGINE_NAMES[o] ?? o}</div>
                {engineField.optionLabels?.[o] && <div className="mt-0.5 line-clamp-2 text-xs text-ink3">{stripName(engineField.optionLabels[o])}</div>}
              </button>
            ))}
          </div>
        </Card>
      )}

      {applies("voiceEngine") && (
        <Card title={`${ENGINE_NAMES[engine] ?? engine} settings`}>
          {usesProvider && (
            <div className="flex items-center gap-3 rounded-lg border border-line bg-soft px-3 py-2.5">
              {provider?.configured ? <CheckCircle2 size={15} className="text-accent" /> : <CircleAlert size={15} className="text-amber" />}
              <div className="min-w-0 flex-1 text-sm text-ink2">
                {provider?.configured ? <>Uses your <span className="text-ink">{usesProvider.label}</span> key from Models.</> : <>Needs an <span className="text-ink">{usesProvider.label}</span> key. Add it under Models; voice uses the same one.</>}
              </div>
              <Button size="sm" variant={provider?.configured ? "ghost" : "primary"} onClick={onOpenModels}>{provider?.configured ? "Change" : "Add key"}</Button>
            </div>
          )}
          {engineFields.map((f) => <FieldRow key={f.key} f={f} onSave={set} lists={lists} values={values} onChecked={(v, r) => setLists((l) => ({ ...l, [v]: r }))} />)}
          {engineFields.length === 0 && !usesProvider && <p className="text-sm text-ink3">Nothing else to set.</p>}
        </Card>
      )}

      {BEHAVIOUR.some(applies) && (
        <Card title="Behaviour">
          {BEHAVIOUR.filter(applies).map((k) => <FieldRow key={k} f={byKey.get(k)!} onSave={set} lists={lists} values={values} />)}
        </Card>
      )}
    </section>
  );
}

const ENGINE_NAMES: Record<string, string> = { openai: "OpenAI", gemini: "Gemini", grok: "Grok", elevenlabs: "ElevenLabs", azure: "Azure OpenAI", qwen: "Qwen", mercury: "Mercury + speech services" };

/** "OpenAI: the most natural…" → "the most natural…" (the card already shows the name). */
function stripName(label: string): string {
  return label.replace(/^[^:]{1,40}:\s*/, "");
}

function Card({ title, hint, badge, children }: { title: string; hint?: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div>
        <div className="flex items-center gap-2"><span className="text-base font-medium text-ink">{title}</span>{badge}</div>
        {hint && <p className="mt-0.5 text-xs text-ink3">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

/** Which vendor list fills a free-text field's menu. */
function listFor(key: string, values: Record<string, unknown>, lists: Partial<Record<VoiceVendor, VoiceCheck>>): Array<{ value: string; label: string }> | null {
  const voices = (v: VoiceVendor) => lists[v]?.voices?.map((x) => ({ value: x.id, label: x.name })) ?? null;
  if (key === "elevenlabsVoice") return voices("elevenlabs");
  if (key === "ttsVoice") return values.ttsProvider === "elevenlabs" ? voices("elevenlabs") : values.ttsProvider === "cartesia" ? voices("cartesia") : null;
  if (key === "geminiModel") return lists.gemini?.models?.map((m) => ({ value: m, label: m })) ?? null;
  return null;
}

function FieldRow({ f, onSave, lists, values, onChecked }: {
  f: VoiceField;
  onSave: (key: string, value: unknown) => Promise<void>;
  lists: Partial<Record<VoiceVendor, VoiceCheck>>;
  values: Record<string, unknown>;
  onChecked?: (vendor: VoiceVendor, r: VoiceCheck) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = f.label ?? humanize(f.key);
  async function save(v: unknown) {
    setBusy(true);
    setError(null);
    try { await onSave(f.key, v); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  if (f.type === "secret") return <SecretRow f={f} label={label} vendor={VENDOR_OF[f.key]} endpoint={String(values.azureEndpoint ?? "")} onSave={(v) => onSave(f.key, v)} onChecked={onChecked} />;

  let control: React.ReactNode;
  if (f.type === "boolean") {
    control = <Switch checked={!!f.value} onCheckedChange={(v) => void save(v)} disabled={busy} />;
  } else if (f.type === "enum") {
    control = (
      <select value={String(f.value ?? "")} onChange={(e) => void save(e.target.value)} disabled={busy} aria-label={label}
        className="h-9 w-[240px] rounded-md border border-line bg-surface px-2.5 text-sm text-ink">
        {(f.options ?? []).map((o) => <option key={o} value={o}>{f.optionLabels?.[o] ? `${o}: ${stripName(f.optionLabels[o]).slice(0, 60)}` : o}</option>)}
      </select>
    );
  } else {
    const menu = listFor(f.key, values, lists);
    control = menu && menu.length
      ? (
        <select value={String(f.value ?? "")} onChange={(e) => void save(e.target.value)} disabled={busy} aria-label={label}
          className="h-9 w-[240px] rounded-md border border-line bg-surface px-2.5 text-sm text-ink">
          {!menu.some((m) => m.value === f.value) && <option value={String(f.value ?? "")}>{String(f.value ?? "Default")}</option>}
          {menu.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      )
      : <TextSetting f={f} label={label} busy={busy} onSave={save} />;
  }
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink">{label}</div>
        {f.description && <div className="line-clamp-2 text-xs text-ink3">{f.description}</div>}
        {error && <div className="text-xs text-red">{error}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{busy && <Spinner size={12} />}{control}</div>
    </div>
  );
}

function TextSetting({ f, label, busy, onSave }: { f: VoiceField; label: string; busy: boolean; onSave: (v: unknown) => Promise<void> }) {
  const [v, setV] = useState(String(f.value ?? ""));
  useEffect(() => { setV(String(f.value ?? "")); }, [f.value]);
  const commit = () => {
    if (v === String(f.value ?? "")) return;
    if (f.type === "number") { const n = Number(v); if (!Number.isFinite(n) || n < 0) { setV(String(f.value ?? "")); return; } void onSave(n); }
    else void onSave(v.trim());
  };
  const listId = f.examples?.length ? `ex-${f.key}` : undefined;
  return (
    <>
      <Input value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        type={f.type === "number" ? "number" : "text"} disabled={busy} aria-label={label} list={listId} className="w-[240px]" placeholder="Default" mono={f.type !== "number"} />
      {listId && <datalist id={listId}>{f.examples!.map((x) => <option key={x} value={x} />)}</datalist>}
    </>
  );
}

/** A voice key: test it against the vendor, then save. Leaving it empty and testing checks the saved key. */
function SecretRow({ f, label, vendor, endpoint, onSave, onChecked }: { f: VoiceField; label: string; vendor?: VoiceVendor; endpoint: string; onSave: (v: string) => Promise<void>; onChecked?: (vendor: VoiceVendor, r: VoiceCheck) => void }) {
  const [key, setKey] = useState("");
  const [result, setResult] = useState<VoiceCheck | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function test(): Promise<VoiceCheck | null> {
    if (!vendor) return { ok: true, verified: false, message: "" };
    setBusy("test");
    setError(null);
    try {
      const r = await voiceApi.check(vendor, key.trim() || undefined, endpoint);
      setResult(r);
      if (r.ok) onChecked?.(vendor, r);
      return r;
    } catch (e) { setError(errorText(e)); return null; } finally { setBusy(null); }
  }
  async function save() {
    const r = result && key ? result : await test();
    if (!r?.ok) return;
    setBusy("save");
    try { await onSave(key.trim()); setKey(""); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm text-ink">{label}</span>
        {f.isSet ? <Badge tone="accent">saved</Badge> : f.required ? <Badge tone="amber">required</Badge> : null}
      </div>
      <div className="flex gap-2">
        <Input type="password" mono autoComplete="off" value={key} onChange={(e) => { setKey(e.target.value); setResult(null); }}
          placeholder={f.isSet ? "Saved. Paste a new key to replace it" : "Paste the key"} aria-label={label} />
        <Button size="md" variant="outline" loading={busy === "test"} disabled={!key.trim() && !f.isSet} onClick={() => void test()}>Test</Button>
        <Button size="md" variant="primary" loading={busy === "save"} disabled={!key.trim()} onClick={() => void save()}>Save</Button>
      </div>
      {result && (
        <p className={cx("flex items-center gap-1.5 text-xs", result.ok ? (result.verified ? "text-accent" : "text-ink3") : "text-red")}>
          {result.ok ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}{result.message}
        </p>
      )}
      {error && <p className="text-xs text-red">{error}</p>}
      {f.description && <p className="text-2xs text-ink4">{f.description} {vendor && <VendorLink vendor={vendor} />}</p>}
    </div>
  );
}

const KEY_PAGES: Partial<Record<VoiceVendor, string>> = {
  elevenlabs: "https://elevenlabs.io/app/settings/api-keys", deepgram: "https://console.deepgram.com", assemblyai: "https://www.assemblyai.com/app/api-keys",
  cartesia: "https://play.cartesia.ai/keys", gemini: "https://aistudio.google.com/apikey", sarvam: "https://dashboard.sarvam.ai",
};

function VendorLink({ vendor }: { vendor: VoiceVendor }) {
  const url = KEY_PAGES[vendor];
  if (!url) return null;
  return (
    <button type="button" className="inline-flex items-center gap-0.5 text-accent hover:underline" onClick={() => void import("~/shell/tauri").then(({ desktop }) => desktop.openExternal(url))}>
      Get a key <ExternalLink size={10} />
    </button>
  );
}
