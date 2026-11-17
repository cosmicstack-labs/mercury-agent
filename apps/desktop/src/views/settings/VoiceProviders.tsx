import { CheckCircle2, CircleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { voiceKeyStatus, voiceProvidersApi, type VoiceProviderInfo, type VoiceProvidersResponse } from "~/api/models";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { cx } from "~/lib/cx";
import { errorText } from "./Models";

/**
 * Voice providers for phone calls and dictation (GET/PUT /api/voice/providers),
 * the same keys the phone apps and Optimus use: one shared store on this computer.
 * Hidden on a runtime without the routes.
 */
export function VoiceProvidersCard({ onOpenModels }: { onOpenModels: () => void }) {
  const [data, setData] = useState<VoiceProvidersResponse | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await voiceProvidersApi.list()); setError(null); } catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (data === null) return null;
  if (data === undefined && !error) return null;

  const phone = data?.providers.filter((p) => p.uses.includes("calls") || p.uses.includes("dictation")) ?? [];
  const caps = data?.capabilities;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div>
        <div className="text-base font-medium text-ink">Phone calls and dictation</div>
        <p className="mt-0.5 text-xs text-ink3">Keys for the Mercury phone apps' calls and live dictation. They stay on this computer and are the same keys Optimus uses.</p>
      </div>
      {error && <p className="text-sm text-red">{error} <button className="text-accent hover:underline" onClick={() => void load()}>Retry</button></p>}
      {phone.map((p) => <ProviderRow key={p.id} p={p} onOpenModels={onOpenModels} onSaved={(r) => setData((d) => d && ({ providers: d.providers.map((x) => (x.id === r.provider.id ? r.provider : x)), capabilities: r.capabilities }))} />)}
      {caps && (
        <div className="grid grid-cols-2 gap-2 border-t border-line pt-3 text-sm">
          <div><span className="text-ink3">Calls use: </span><span className="text-ink">{caps.call ? caps.callEngineName ?? caps.callEngine : "Not set up"}</span></div>
          <div><span className="text-ink3">Dictation uses: </span><span className="text-ink">{caps.dictation ? caps.dictationEngineName ?? caps.dictationEngine : "Not set up"}</span></div>
        </div>
      )}
    </div>
  );
}

function ProviderRow({ p, onOpenModels, onSaved }: { p: VoiceProviderInfo; onOpenModels: () => void; onSaved: (r: { provider: VoiceProviderInfo; capabilities: VoiceProvidersResponse["capabilities"] }) => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const uses = p.uses.filter((u) => u !== "optimus").map((u) => (u === "calls" ? "Calls" : "Dictation")).join(" · ");

  async function run(kind: "save" | "remove", value: string | null) {
    setBusy(kind); setError(null); setMessage(null);
    try {
      const r = await voiceProvidersApi.set(p.id, value);
      onSaved(r);
      setMessage(r.message ?? (value ? "Saved." : "Removed."));
      setKey("");
      if (!value) setOpen(false);
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-ink">{p.name}</div>
          <div className="text-xs text-ink3">{uses}</div>
        </div>
        <span className={cx("flex items-center gap-1 text-xs", p.set ? "text-ink" : "text-ink3")}>
          {p.set && <CheckCircle2 size={12} />}{voiceKeyStatus(p)}
        </span>
        {p.source === "provider" || (!p.canEdit && p.id === "openai")
          ? <Button size="sm" variant="ghost" onClick={onOpenModels}>{p.set ? "Change" : "Add key"}</Button>
          : p.canEdit
            ? <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>{p.set ? "Change" : "Add key"}</Button>
            : null}
      </div>
      {!p.canEdit && p.source === "env" && p.note && <p className="text-2xs text-ink4">{p.note}</p>}
      {open && p.canEdit && (
        <div className="flex flex-col gap-1.5 pl-0.5">
          <div className="flex gap-2">
            <Input type="password" mono autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} aria-label={`${p.name} key`}
              placeholder={p.set ? "Paste a new key to replace it" : "Paste the key"}
              onKeyDown={(e) => { if (e.key === "Enter" && key.trim()) void run("save", key.trim()); }} />
            <Button size="md" variant="primary" loading={busy === "save"} disabled={!key.trim() || !!busy} onClick={() => void run("save", key.trim())}>Save</Button>
            {p.set && <Button size="md" variant="outline" loading={busy === "remove"} disabled={!!busy} onClick={() => void run("remove", null)}>Remove</Button>}
          </div>
          {busy === "save" && <p className="text-xs text-ink3">Checking the key with {p.name}…</p>}
          {p.note && <p className="text-2xs text-ink4">{p.note}</p>}
        </div>
      )}
      {message && <p className="flex items-center gap-1.5 text-xs text-ink3"><CheckCircle2 size={12} />{message}</p>}
      {error && <p className="flex items-center gap-1.5 text-xs text-red"><CircleAlert size={12} />{error}</p>}
    </div>
  );
}
