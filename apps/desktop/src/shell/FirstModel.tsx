import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";
import { modelsApi, type ProviderInfo, type ProviderSettings } from "~/api/models";
import { Wordmark } from "~/components/Logo";
import { Badge, Spinner } from "~/components/ui/bits";
import { IconTile } from "~/components/ui/kit";
import { ProviderEditor, errorText } from "~/views/settings/Models";
import { CloudSignInFlow } from "~/views/settings/Cloud";
import { Sparkles } from "lucide-react";

/**
 * First run, after Mercury is installed: it can't think until a model is
 * connected. A few good starting points, everything else one click away;
 * the key is tested live before it's saved, then Mercury restarts with it.
 */
const FEATURED = ["aimlapi", "openai", "anthropic", "ollamaLocal"];

export function FirstModel({ onReady, onSwitch }: { onReady: () => void; onSwitch: () => void }) {
  const [data, setData] = useState<ProviderSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ProviderInfo | null>(null);
  const [all, setAll] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [cloud, setCloud] = useState<"idle" | "signing-in" | null>("idle");

  useEffect(() => { modelsApi.settings().then(setData).catch((e) => setError(errorText(e))); }, []);
  // After the restart, reconnect; the workspace takes over once Mercury is up.
  useEffect(() => {
    if (!starting) return;
    const t = setTimeout(onReady, 6000);
    return () => clearTimeout(t);
  }, [starting, onReady]);

  const choices = (data?.providers ?? []).filter((p) => !p.signInOnly);
  const featured = FEATURED.map((id) => choices.find((p) => p.id === id)).filter(Boolean) as ProviderInfo[];
  const others = choices.filter((p) => !FEATURED.includes(p.id));

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg" data-tauri-drag-region>
      <div className="mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center gap-6 px-8 py-10">
        <div className="flex flex-col items-center gap-1 text-center">
          <Wordmark width={200} breathe={!!starting} />
          <p className="mt-1 text-sm text-ink3">{starting ? `Starting Mercury with ${starting}…` : "Connect a model so Mercury can think. You can add more, and change it any time, in Settings → Models."}</p>
        </div>

        {starting && <div className="flex justify-center text-ink3"><Spinner size={18} /></div>}
        {error && !starting && <p className="text-center text-sm text-red">Couldn't reach Mercury: {error}</p>}
        {!data && !error && <div className="flex justify-center text-ink3"><Spinner size={18} /></div>}

        {data && !starting && !picked && cloud && (
          <div className="flex flex-col gap-3 rounded-xl border border-accent/40 bg-accent/[0.05] p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent"><Sparkles size={18} /></div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><span className="text-base font-medium text-ink">Mercury Cloud</span><Badge tone="cyan">recommended</Badge></div>
                <div className="text-xs text-ink3">The quick start: sign in and chat. No API keys.</div>
              </div>
            </div>
            {cloud === "signing-in"
              ? <CloudSignInFlow onDone={() => setStarting("Mercury Cloud")} onCancel={() => setCloud("idle")} />
              : <div><button onClick={() => setCloud("signing-in")} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent/90">Sign in to Mercury Cloud</button></div>}
          </div>
        )}

        {data && !starting && !picked && (
          <div className="flex flex-col gap-2">
            <div className="text-xs text-ink4">Or bring your own key</div>
            {featured.map((p) => <Choice key={p.id} p={p} onPick={() => setPicked(p)} />)}
            {all && others.map((p) => <Choice key={p.id} p={p} onPick={() => setPicked(p)} />)}
            {!all && <button className="self-center text-xs text-ink3 hover:text-ink hover:underline" onClick={() => setAll(true)}>More providers ({others.length})</button>}
          </div>
        )}

        {data && !starting && picked && (
          <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
            <div className="flex items-center gap-3">
              <button onClick={() => setPicked(null)} className="rounded-md p-1 text-ink3 hover:bg-ink/[0.06] hover:text-ink" aria-label="Back"><ArrowLeft size={16} /></button>
              <IconTile id={picked.id} label={picked.label} size={30} />
              <div>
                <div className="text-base font-medium text-ink">{picked.label}</div>
                <div className="text-xs text-ink3">{picked.blurb}</div>
              </div>
            </div>
            <ProviderEditor provider={picked} offerDefault={false} saveLabel="Connect and start"
              onSaved={(r) => { if (r.restarting || r.applied || r.restartRequired) setStarting(picked.label); }} />
          </div>
        )}

        <button className="self-center text-xs text-ink4 hover:text-ink2 hover:underline" onClick={onSwitch}>Use another connection</button>
      </div>
    </div>
  );
}

function Choice({ p, onPick }: { p: ProviderInfo; onPick: () => void }) {
  return (
    <button onClick={onPick} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-ink/25">
      <IconTile id={p.id} label={p.label} size={34} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><span className="text-base text-ink">{p.label}</span>{p.recommended && <Badge tone="cyan">recommended</Badge>}{p.kind === "local" && <Badge>free</Badge>}</div>
        <div className="text-xs text-ink3">{p.blurb}</div>
      </div>
      {p.configured && <CheckCircle2 size={16} className="text-accent" />}
      <span className={p.recommended ? "rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-on-accent" : "rounded-md border border-line px-2.5 py-1 text-xs text-ink2"}>Choose</span>
    </button>
  );
}
