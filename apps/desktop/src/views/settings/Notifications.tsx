import { Check, ExternalLink, Play, Trash2, Upload, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { askPermission, permission, sendTest, type Permission } from "~/app/notify/notify";
import { CUSTOM_MAX_BYTES, playSound, SOUNDS, type SoundId } from "~/app/notify/sounds";
import { useNotify } from "~/app/notify/store";
import { Button } from "~/components/ui/Button";
import { Switch } from "~/components/ui/Switch";
import { Segmented } from "~/components/ui/bits";
import { isTauri } from "~/shell/tauri";
import { cx } from "~/lib/cx";

/**
 * Notifications: what tells you (needs an answer, a long task done or
 * failed), how (system banner, sound, Dock badge), and the sound itself:
 * twelve built in, or your own clip.
 */

const AFTER: Array<{ value: string; label: string }> = [
  { value: "10", label: "10 s" }, { value: "30", label: "30 s" }, { value: "60", label: "1 min" }, { value: "120", label: "2 min" }, { value: "300", label: "5 min" },
];

async function systemSettingsUrl(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { platform } = await import("@tauri-apps/plugin-os");
    const p = platform();
    if (p === "macos") return "x-apple.systempreferences:com.apple.Notifications-Settings.extension";
    if (p === "windows") return "ms-settings:notifications";
  } catch { /* unknown platform */ }
  return null;
}

export function NotificationsSettings() {
  const prefs = useNotify((s) => s.prefs);
  const custom = useNotify((s) => s.custom);
  const setPrefs = useNotify((s) => s.setPrefs);
  const setCustom = useNotify((s) => s.setCustom);
  const [perm, setPerm] = useState<Permission | null>(null);
  const [settingsUrl, setSettingsUrl] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => { void permission().then(setPerm); void systemSettingsUrl().then(setSettingsUrl); }, []);

  const pick = (id: SoundId) => { setPrefs({ sound: id }); playSound(id, prefs.volume, custom?.url); };

  async function turnOn(v: boolean) {
    setPrefs({ system: v });
    if (v) setPerm(await askPermission());
  }

  function upload(f: File) {
    setNote(null);
    if (!f.type.startsWith("audio/")) return setNote({ text: "That isn't an audio file.", ok: false });
    if (f.size > CUSTOM_MAX_BYTES) return setNote({ text: "Pick a clip under 1 MB (a second or two is plenty).", ok: false });
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      setCustom({ name: f.name, url });
      setPrefs({ sound: "custom" });
      playSound("custom", prefs.volume, url);
      setNote({ text: `Using ${f.name}.`, ok: true });
    };
    r.onerror = () => setNote({ text: "Couldn't read that file.", ok: false });
    r.readAsDataURL(f);
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink3">Mercury tells you when a conversation you're not looking at needs an answer, or when a long task finishes. Telegram, WhatsApp and other channels already notify you in their own apps.</p>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-ink">System notifications</h3>
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm text-ink">Show notifications</div>
              <div className="text-xs text-ink3">{perm === "denied" ? "Blocked. Allow them in your system settings, then try again." : perm === "unsupported" ? "Not available here; Mercury uses the sound, the badge and in-app alerts instead." : "A banner from your system, even when Mercury is in the background."}</div>
            </div>
            <Switch id="notify-system" checked={prefs.system && perm !== "denied"} onCheckedChange={(v) => void turnOn(v)} disabled={perm === "unsupported"} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => { sendTest(); setNote({ text: "Test sent. No banner? Allow Mercury in your system's notification settings.", ok: true }); }}>Send a test</Button>
            {settingsUrl && (
              <Button size="sm" variant="ghost" onClick={() => void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(settingsUrl)).catch(() => {})}>
                <ExternalLink size={13} /> Open system notification settings
              </Button>
            )}
          </div>
          <p className="text-xs text-ink4">If banners are off or blocked, you still get the sound, a count on the app icon, a blue dot on the conversation, and an alert inside Mercury.</p>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-ink">Tell me when</h3>
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          <ToggleRow id="notify-needs" title="Mercury needs an answer" hint="An approval or a question in a conversation you're not looking at." checked={prefs.needsYou} onChange={(v) => setPrefs({ needsYou: v })} />
          <div className="flex flex-col gap-2 px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm text-ink">A task finishes</div>
                <div className="text-xs text-ink3">Only tasks that ran at least this long, so quick replies stay quiet.</div>
              </div>
              <Switch id="notify-done" checked={prefs.done} onCheckedChange={(v) => setPrefs({ done: v })} />
            </div>
            {prefs.done && <Segmented value={String(prefs.doneAfterSec)} onChange={(v) => setPrefs({ doneAfterSec: Number(v) })} options={AFTER} />}
          </div>
          <ToggleRow id="notify-failed" title="A task stops with an error" checked={prefs.failed} onChange={(v) => setPrefs({ failed: v })} />
          <ToggleRow id="notify-badge" title="Count on the app icon" hint="Conversations waiting for you or with something new." checked={prefs.badge} onChange={(v) => setPrefs({ badge: v })} />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink">Sound</h3>
          <button onClick={() => setPrefs({ muted: !prefs.muted })} aria-pressed={prefs.muted} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink3 hover:bg-ink/[0.05] hover:text-ink">
            {prefs.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}{prefs.muted ? "Muted" : "Mute"}
          </button>
        </div>
        <div className={cx("flex flex-col gap-4 rounded-lg border border-line bg-surface px-4 py-4", prefs.muted && "opacity-50")}>
          <label className="flex items-center gap-3 text-sm text-ink2">
            <span className="w-16 shrink-0">Volume</span>
            <input type="range" min={0} max={1} step={0.05} value={prefs.volume} onChange={(e) => setPrefs({ volume: Number(e.target.value) })} onMouseUp={() => playSound(prefs.sound, prefs.volume, custom?.url)} className="flex-1 accent-[rgb(var(--accent))]" aria-label="Volume" />
            <span className="w-10 text-right font-mono text-xs text-ink3">{Math.round(prefs.volume * 100)}%</span>
          </label>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Notification sound">
            {SOUNDS.map((s) => (
              <button key={s.id} role="radio" aria-checked={prefs.sound === s.id} onClick={() => pick(s.id)}
                className={cx("flex h-10 items-center gap-2 rounded-lg border px-3 text-left text-sm", prefs.sound === s.id ? "border-accent/70 bg-accent/[0.08] text-ink" : "border-line text-ink2 hover:border-line-strong hover:text-ink")}>
                {prefs.sound === s.id ? <Check size={14} className="shrink-0 text-accent" /> : <Play size={13} className="shrink-0 text-ink4" />}
                <span className="flex-1">{s.label}</span>
                {prefs.sound === s.id && <span className="text-2xs text-accent">Default</span>}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            {custom ? (
              <button role="radio" aria-checked={prefs.sound === "custom"} onClick={() => pick("custom")}
                className={cx("flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 text-left text-sm", prefs.sound === "custom" ? "border-accent/70 bg-accent/[0.08] text-ink" : "border-line text-ink2 hover:border-line-strong")}>
                {prefs.sound === "custom" ? <Check size={14} className="shrink-0 text-accent" /> : <Play size={13} className="shrink-0 text-ink4" />}
                <span className="min-w-0 flex-1 truncate">{custom.name}</span>
                {prefs.sound === "custom" && <span className="text-2xs text-accent">Default</span>}
              </button>
            ) : <span className="flex-1 text-sm text-ink3">Or use your own sound.</span>}
            <Button size="sm" variant="outline" onClick={() => file.current?.click()}><Upload size={13} /> {custom ? "Replace" : "Choose a file"}</Button>
            {custom && <Button size="sm" variant="ghost" icon aria-label="Remove your sound" onClick={() => { setCustom(null); if (prefs.sound === "custom") setPrefs({ sound: "pop" }); }}><Trash2 size={14} /></Button>}
            <input ref={file} type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
          </div>
          {note && <p className={cx("text-xs", note.ok ? "text-accent" : "text-red")}>{note.text}</p>}
        </div>
      </section>
    </div>
  );
}

function ToggleRow({ id, title, hint, checked, onChange }: { id: string; title: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <div className="text-sm text-ink">{title}</div>
        {hint && <div className="text-xs text-ink3">{hint}</div>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
