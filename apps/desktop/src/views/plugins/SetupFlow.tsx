import { ArrowLeft, ArrowRight, CheckCircle2, PartyPopper } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "~/api/mercury";
import type { PluginItem, PluginSetting } from "~/api/types";
import { Button } from "~/components/ui/Button";
import { Spinner } from "~/components/ui/bits";
import { ChannelPanel } from "./ChannelPanel";
import { applies, filled, labelOf, SettingField } from "./SettingField";

/**
 * Guided setup, the way the plugin defines it: each setting it marks for
 * setup, in its order, asked one at a time with its own words; a setting
 * that depends on a missing key is asked only while it's missing; answers
 * can change which later questions apply (picking a voice engine asks for
 * that engine's key), so the steps are worked out again after each one.
 * Messaging plugins finish by linking their account. Then it's on.
 */

export function setupKeys(p: PluginItem): string[] {
  const all = p.settings ?? [];
  const missing = new Set((p.missing ?? []).map((m) => m.key));
  return all.filter((s) => s.setup && (!s.setupWhenMissing || missing.has(s.setupWhenMissing)) && applies(s, all)).map((s) => s.key);
}

export function needsSetup(p: PluginItem): boolean {
  const all = p.settings ?? [];
  return all.some((s) => s.required && applies(s, all) && !filled(s)) || (p.settingGroups ?? []).some((g) => !g.ready);
}

type Step = { kind: "setting"; key: string } | { kind: "link" } | { kind: "done" };

export function SetupFlow({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [p, setP] = useState<PluginItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<Step | null>(null);
  const [history, setHistory] = useState<Step[]>([]);
  const [finishing, setFinishing] = useState(false);

  const load = useCallback(async () => {
    try { const info = await api.plugins.info(id); setP(info); return info; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return null; }
  }, [id]);

  const linkable = !!p?.channel && p.channel.type !== "desktop";
  const steps = useMemo<Step[]>(() => {
    if (!p) return [];
    return [...setupKeys(p).map((key) => ({ kind: "setting" as const, key })), ...(linkable ? [{ kind: "link" as const }] : []), { kind: "done" as const }];
  }, [p, linkable]);

  useEffect(() => { void load().then((info) => { if (info) setAt(null); }); }, [load]);
  // Start at the first step once loaded.
  useEffect(() => { if (p && !at && steps.length) setAt(steps[0]); }, [p, at, steps]);

  const same = (a: Step, b: Step) => a.kind === b.kind && (a.kind !== "setting" || b.kind !== "setting" || a.key === b.key);
  const index = at ? steps.findIndex((s) => same(s, at)) : -1;
  // A setting that stopped applying (an earlier answer changed things) moves on by itself.
  useEffect(() => { if (p && at && index === -1) setAt(steps[0]); }, [p, at, index, steps]);

  function next() {
    if (!at) return;
    const i = steps.findIndex((s) => same(s, at));
    const n = steps[i + 1];
    if (n) { setHistory((h) => [...h, at]); setAt(n); }
  }
  function back() {
    setHistory((h) => {
      const prev = h[h.length - 1];
      if (prev) setAt(prev);
      return h.slice(0, -1);
    });
  }

  async function save(key: string, value: unknown) {
    await api.plugins.setSetting(id, key, value);
    await load();
    onChanged();
  }

  async function finish() {
    setFinishing(true);
    try {
      if (p && !p.enabled) await api.plugins.enable(id);
      onChanged();
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setFinishing(false); }
  }

  if (error && !p) return <p className="p-6 text-sm text-red">{error}</p>;
  if (!p || !at) return <div className="p-6"><Spinner size={16} /></div>;

  const settingNow: PluginSetting | undefined = at.kind === "setting" ? p.settings?.find((s) => s.key === at.key) : undefined;
  const total = steps.length - 1;
  const position = Math.min(index + 1, total);
  const canContinue = at.kind !== "setting" || !settingNow || !settingNow.required || filled(settingNow);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-6 py-4">
        <div className="min-w-0 flex-1">
          <div className="text-base font-medium text-ink">Set up {p.name}</div>
          <div className="text-xs text-ink3">{at.kind === "done" ? "All set" : `Step ${position} of ${total}`}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>{at.kind === "done" ? "Close" : "Finish later"}</Button>
      </div>
      <div className="h-1 bg-ink/[0.06]"><div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${total ? (Math.min(index, total) / total) * 100 : 100}%` }} /></div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-[520px] flex-col gap-4">
          {at.kind === "setting" && settingNow && <SettingField key={settingNow.key} s={settingNow} size="step" onSave={(v) => save(settingNow.key, v)} />}
          {at.kind === "setting" && !settingNow && <p className="text-sm text-ink3">This step no longer applies.</p>}
          {at.kind === "link" && (
            <>
              <div><div className="text-base font-medium text-ink">Link the {p.name} account</div><p className="text-xs text-ink3">Use a spare number, not your main one.</p></div>
              <ChannelPanel id={id} name={p.name} />
            </>
          )}
          {at.kind === "done" && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <PartyPopper size={28} className="text-accent" />
              <div className="text-lg font-medium text-ink">{p.name} is ready</div>
              <p className="max-w-[420px] text-sm text-ink3">
                {p.enabled ? "It's on." : "Turn it on to start."} You can change any of this later on its page.
                {(p.missing ?? []).length > 0 && ` Still optional: ${(p.missing ?? []).map((m) => m.unlocks).join("; ")}.`}
              </p>
              {(p.settings ?? []).filter((s) => s.setup && applies(s, p.settings ?? [])).length > 0 && (
                <ul className="w-full max-w-[420px] divide-y divide-line rounded-lg border border-line text-left text-sm">
                  {(p.settings ?? []).filter((s) => s.setup && applies(s, p.settings ?? [])).map((s) => (
                    <li key={s.key} className="flex items-center gap-2 px-3 py-2">
                      <CheckCircle2 size={13} className={filled(s) ? "text-accent" : "text-ink4"} />
                      <span className="min-w-0 flex-1 truncate text-ink2">{labelOf(s)}</span>
                      <span className="max-w-[180px] truncate font-mono text-xs text-ink3">{s.type === "secret" ? (s.isSet ? "saved" : "not set") : String(s.value ?? "not set")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {error && <p className="text-sm text-red">{error}</p>}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-line px-6 py-3">
        <Button size="md" variant="ghost" disabled={history.length === 0} onClick={back}><ArrowLeft size={14} /> Back</Button>
        <span className="flex-1" />
        {at.kind === "done"
          ? <Button size="md" variant="primary" loading={finishing} onClick={() => void finish()}>{p.enabled ? "Done" : `Turn on ${p.name}`}</Button>
          : (
            <>
              {at.kind === "setting" && settingNow && !settingNow.required && !filled(settingNow) && <Button size="md" variant="ghost" onClick={next}>Skip</Button>}
              <Button size="md" variant="primary" disabled={!canContinue} onClick={next}>Continue <ArrowRight size={14} /></Button>
            </>
          )}
      </div>
    </div>
  );
}
