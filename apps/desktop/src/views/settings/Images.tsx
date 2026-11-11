import { Check, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "~/api/mercury";
import { ApiError } from "~/api/client";
import type { MediaKindInfo, MediaModelsResponse, SpeechInfo, VoiceReplies } from "~/api/types";
import { Segmented, Spinner } from "~/components/ui/bits";
import { cx } from "~/lib/cx";

/**
 * Images (ADR-042): which model draws when you ask for an image. The list is
 * what your configured providers offer (OpenAI, OpenRouter, LiteLLM, AI/ML
 * API, Mercury Cloud, Ollama…), found automatically and checked again daily.
 * Automatic picks the best one, preferring the provider you chat with.
 */
export function ImageSettings() {
  const [info, setInfo] = useState<MediaModelsResponse["image"] | null>(null);
  const [speech, setSpeech] = useState<SpeechInfo | null>(null);
  const [video, setVideo] = useState<MediaKindInfo | null>(null);
  const [music, setMusic] = useState<MediaKindInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(refresh = false) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.media.models(refresh);
      setInfo(r.image);
      setSpeech(r.speech ?? null);
      setVideo(r.video ?? null);
      setMusic(r.music ?? null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404
        ? "This Mercury can't make images yet. Update it to use image models."
        : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function choose(ref: string | null, kind: "image" | "video" | "music" = "image") {
    setError(null);
    try {
      await api.media.setDefault(ref, kind);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!info) return error ? <p className="text-sm text-ink3">{error}</p> : <div className="py-10 text-ink3"><Spinner size={18} /></div>;
  const groups = new Map<string, typeof info.models>();
  for (const m of info.models) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);
  const chosen = info.default?.available ? info.default.ref : null;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink3">
        Images, videos, music and speech made by real models from your providers. Pick one for each, or let Mercury choose. Use the Create button in the chat box, ask in your own words, or type <code className="font-mono">/image</code>, <code className="font-mono">/video</code>, <code className="font-mono">/music</code> or <code className="font-mono">/say</code> — in the terminal, Telegram and WhatsApp too.
      </p>
      {error && <p className="text-sm text-red" role="alert">{error}</p>}
      {info.default && !info.default.available && (
        <p className="text-sm text-amber">Your choice ({info.default.ref}) isn't offered by your providers right now, so the automatic pick is used.</p>
      )}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink">Image model</h3>
          <button onClick={() => void load(true)} disabled={busy} className="flex items-center gap-1.5 text-xs text-ink3 hover:text-ink disabled:opacity-50">
            <RefreshCw size={12} className={cx(busy && "animate-spin")} /> Check providers again
          </button>
        </div>
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          <Row selected={!chosen} onSelect={() => void choose(null)} title="Automatic" detail={info.auto ? `Now: ${info.auto.label} · ${info.auto.group}` : "No image model found yet"} />
          {[...groups.entries()].map(([group, list]) => (
            <div key={group} className="flex flex-col">
              <div className="px-4 pb-1 pt-3 text-2xs font-medium uppercase tracking-wide text-ink4">{group}</div>
              {list.map((m) => (
                <Row key={m.ref} selected={chosen === m.ref} onSelect={() => void choose(m.ref)} title={m.label} detail={m.canEdit ? m.model : `${m.model} · can't edit images`} />
              ))}
            </div>
          ))}
        </div>
        {info.models.length === 0 && (
          <p className="text-xs text-ink3">
            None of your providers offers an image model. Add one that does — OpenAI (gpt-image), OpenRouter (Gemini image, FLUX…), LiteLLM, AI/ML API, Atlas Cloud, Runcrate, Mercury Cloud, or an Ollama image model — in Models, then check again.
          </p>
        )}
      </section>
      {video && <KindSection title="Video model" kind="video" info={video} onChoose={(ref) => void choose(ref, "video")}
        blurb="Short clips (3–15 seconds) for /video, the Create menu, or when you ask. They take a minute or a few and arrive in the chat when ready."
        none="No video model found. A Gemini key (Settings → Voice) gives Gemini Omni video; gateways such as LiteLLM or Mercury Cloud can serve others." />}
      {music && <KindSection title="Music model" kind="music" info={music} onChoose={(ref) => void choose(ref, "music")}
        blurb="Songs and instrumentals for /music, the Create menu, or when you ask. They arrive in the chat when ready."
        none="No music model found. A Gemini key (Lyria) or an ElevenLabs key (Settings → Voice) makes music." />}
      {speech && <SpeechSection speech={speech} onChange={async (update) => { setError(null); try { await api.media.setSpeech(update); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }} />}
    </div>
  );
}

/** One kind's models (video, music): Automatic or a model from your providers. */
function KindSection({ title, blurb, none, info, onChoose }: { title: string; kind: string; blurb: string; none: string; info: MediaKindInfo; onChoose: (ref: string | null) => void }) {
  const chosen = info.default?.available ? info.default.ref : null;
  const groups = new Map<string, typeof info.models>();
  for (const m of info.models) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      <p className="text-xs text-ink3">{blurb}</p>
      {info.models.length === 0 ? <p className="text-xs text-ink3">{none}</p> : (
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          <Row selected={!chosen} onSelect={() => onChoose(null)} title="Automatic" detail={info.auto ? `Now: ${info.auto.label} · ${info.auto.group}` : "—"} />
          {[...groups.entries()].map(([group, list]) => (
            <div key={group} className="flex flex-col">
              <div className="px-4 pb-1 pt-3 text-2xs font-medium uppercase tracking-wide text-ink4">{group}</div>
              {list.map((m) => <Row key={m.ref} selected={chosen === m.ref} onSelect={() => onChoose(m.ref)} title={m.label} detail={m.model} />)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const REPLIES: Array<{ value: VoiceReplies; label: string }> = [
  { value: "off", label: "Never" },
  { value: "mirror", label: "When I send one" },
  { value: "always", label: "Always" },
];

/**
 * Speaking (phase 2): what reads replies aloud, makes voice notes and
 * /say audio, in which voice, and when chat-app replies also come as a
 * voice note.
 */
function SpeechSection({ speech, onChange }: { speech: SpeechInfo; onChange: (u: { choice?: string | null; voice?: string | null; replies?: VoiceReplies }) => void }) {
  const [voice, setVoice] = useState(speech.voice ?? "");
  useEffect(() => { setVoice(speech.voice ?? ""); }, [speech.voice]);
  const current = speech.options.find((o) => o.id === speech.current?.id);
  const groups = new Map<string, typeof speech.options>();
  for (const o of speech.options) groups.set(o.group, [...(groups.get(o.group) ?? []), o]);
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-ink">Speech</h3>
      <p className="text-xs text-ink3">Reads replies aloud, makes voice notes and audio when you ask (or <code className="font-mono">/say</code>), and speaks in Telegram and WhatsApp.</p>
      <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
        <Row selected={!speech.choice} onSelect={() => onChange({ choice: null })} title="Same as Settings → Voice" detail={speech.current && !speech.choice ? `Now: ${speech.current.label}` : speech.options.length ? "The voice you chose for calls" : "No speech service set up"} />
        {[...groups.entries()].map(([group, list]) => (
          <div key={group} className="flex flex-col">
            <div className="px-4 pb-1 pt-3 text-2xs font-medium uppercase tracking-wide text-ink4">{group}</div>
            {list.map((o) => <Row key={o.id} selected={speech.choice === o.id} onSelect={() => onChange({ choice: o.id })} title={o.label} detail={o.id} />)}
          </div>
        ))}
      </div>
      {speech.options.length === 0 && (
        <p className="text-xs text-ink3">Add an OpenAI key in Models, or a Gemini, Deepgram or ElevenLabs key in Voice, to let Mercury speak.</p>
      )}
      {speech.current && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3">
          <label className="text-sm text-ink" htmlFor="speech-voice">Voice</label>
          <div className="flex items-center gap-2">
            <input
              id="speech-voice"
              list="speech-voices"
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              onBlur={() => { if ((speech.voice ?? "") !== voice.trim()) onChange({ voice: voice.trim() || null }); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              placeholder="The service's default"
              className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-sm text-ink outline-none focus:border-accent"
            />
            <datalist id="speech-voices">{(current?.voices ?? []).map((v) => <option key={v} value={v} />)}</datalist>
          </div>
          <p className="text-xs text-ink3">{current?.voices.length ? `For example: ${current.voices.slice(0, 6).join(", ")}.` : "A voice id from the service (ElevenLabs: from your voice library)."}</p>
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3">
        <span className="text-sm text-ink">Answer with a voice note in chat apps</span>
        <Segmented value={speech.replies} onChange={(v) => onChange({ replies: v as VoiceReplies })} options={REPLIES} />
        <p className="text-xs text-ink3">Telegram and WhatsApp: the text reply always comes; a voice note follows when you sent one, or on every reply.</p>
      </div>
    </section>
  );
}

function Row({ selected, onSelect, title, detail }: { selected: boolean; onSelect: () => void; title: string; detail: string }) {
  return (
    <button onClick={onSelect} className="flex items-center gap-3 px-4 py-2.5 text-left hover:bg-ink/[0.03]" aria-pressed={selected}>
      <span className={cx("flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", selected ? "border-accent bg-accent text-on-accent" : "border-line-strong")}>
        {selected && <Check size={10} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink">{title}</span>
        <span className="block truncate font-mono text-2xs text-ink4">{detail}</span>
      </span>
    </button>
  );
}
