import { ImageUp, Shuffle, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { photoToDataUrl, randomSeed, useProfile } from "~/app/profile";
import { cx } from "~/lib/cx";
import { usePulse } from "~/app/pulse";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Marble, UserAvatar } from "~/components/UserAvatar";

/**
 * How you appear in conversations on this device: a photo, or a generated
 * avatar you can shuffle until you like it, and the name beside it.
 */
export function Profile() {
  const name = useProfile((s) => s.name);
  const image = useProfile((s) => s.image);
  const setName = useProfile((s) => s.setName);
  const setImage = useProfile((s) => s.setImage);
  const shuffle = useProfile((s) => s.shuffle);
  const owner = usePulse((s) => s.owner);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function pick(f: File | undefined) {
    if (!f) return;
    setError(null);
    try { setImage(await photoToDataUrl(f)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-5 rounded-xl border border-line bg-surface p-5">
        <UserAvatar size={84} />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="text-sm text-ink3">{image ? "Your photo shows next to your messages." : "Generated for you. Shuffle until you like it, or use a photo."}</div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => file.current?.click()}><ImageUp size={14} /> {image ? "Change photo" : "Upload photo"}</Button>
            {image
              ? <Button size="sm" variant="ghost" onClick={() => setImage(null)}><Trash2 size={14} /> Use generated avatar</Button>
              : <Button size="sm" variant="ghost" onClick={shuffle}><Shuffle size={14} /> Shuffle</Button>}
          </div>
          {error && <p className="text-sm text-red">{error}</p>}
          <input ref={file} type="file" accept="image/*" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
      </div>

      {!image && <ShufflePreview />}

      <form
        className="flex items-end gap-3 rounded-xl border border-line bg-surface p-5"
        onSubmit={(e) => { e.preventDefault(); setName(draft); }}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-base text-ink">Display name</span>
          <span className="text-xs text-ink3">Shown above your messages. Leave empty to use {owner ? `"${owner}" from Mercury's config` : "\"You\""}.</span>
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={owner || "You"} />
        </label>
        <Button type="submit" variant="primary" disabled={draft.trim() === name}>Save</Button>
      </form>
    </section>
  );
}

/** Eight alternatives to pick from; "More" draws a fresh set. */
function ShufflePreview() {
  const seed = useProfile((s) => s.seed);
  const setSeed = useProfile((s) => s.setSeed);
  const [options, setOptions] = useState(() => Array.from({ length: 8 }, randomSeed));
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-5 py-4">
      <span className="mr-1 text-sm text-ink3">Or pick one</span>
      {options.map((o) => (
        <button key={o} onClick={() => setSeed(o)} aria-pressed={o === seed}
          className={cx("rounded-full transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent/70", o === seed && "ring-2 ring-accent/80 ring-offset-2 ring-offset-surface")} aria-label="Use this avatar">
          <Marble seed={o} size={36} />
        </button>
      ))}
      <Button size="sm" variant="ghost" onClick={() => setOptions(Array.from({ length: 8 }, randomSeed))}><Shuffle size={14} /> More</Button>
    </div>
  );
}
