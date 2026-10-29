import { Cake, Check, Mail, MapPin, PawPrint, Phone, ShieldCheck, Sparkles, Briefcase, Link2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { brain, type BrainMemory, type BrainPerson, type PersonMeta } from "~/api/brain";
import { ApiError } from "~/api/client";
import { Button } from "~/components/ui/Button";
import { Field, Input } from "~/components/ui/Input";
import { Badge, Segmented, Spinner } from "~/components/ui/bits";
import { ConfirmButton } from "~/components/ui/kit";
import { cx } from "~/lib/cx";
import { FieldMic } from "~/components/dictation/Dictation";

/**
 * A person's contact card: view, edit (name, person or pet, relationship,
 * notes, contact details), merge into another person, or mark "not a
 * person". The id never changes; edits are the owner's and survive every
 * rebuild. Memories that mention them load when the card opens.
 */
export function PersonCard({ id, onClose, onChanged, allPeople }: { id: string; onClose?: () => void; onChanged: () => void; allPeople: BrainPerson[] }) {
  const [person, setPerson] = useState<BrainPerson | null>(null);
  const [memories, setMemories] = useState<BrainMemory[] | null>(null);
  const [total, setTotal] = useState(0);
  const [more, setMore] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [p, m] = await Promise.all([brain.person(id), brain.personMemories(id)]);
      setPerson(p.person);
      setMemories(m.memories);
      setTotal(m.total ?? m.memories.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { setPerson(null); setMemories(null); setTotal(0); setEditing(false); void load(); }, [id]);

  async function loadMore() {
    if (!memories) return;
    setMore(true);
    try {
      const m = await brain.personMemories(id, memories.length);
      setMemories([...memories, ...m.memories]);
      setTotal(m.total ?? total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMore(false);
    }
  }

  if (error) return <div className="p-5 text-sm text-red">{error}</div>;
  if (!person) return <div className="p-5 text-ink3"><Spinner size={16} /></div>;

  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex items-start gap-3">
        <Initials name={person.name} kind={person.kind} size={52} />
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold text-ink">{person.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-ink3">
            {person.relationship && person.relationship !== "known" && <span className="capitalize">{person.relationship}</span>}
            <VerifiedBadge p={person} />
            <span className="text-ink4">· {person.memoryCount} memor{person.memoryCount === 1 ? "y" : "ies"}</span>
          </div>
        </div>
        {onClose && <button onClick={onClose} className="rounded-md p-1 text-ink4 hover:text-ink" aria-label="Close"><X size={16} /></button>}
      </div>

      {!editing && person.standing && <StandingPanel person={person} />}

      {editing
        ? <EditForm person={person} onCancel={() => setEditing(false)} onSaved={(p) => { setPerson(p); setEditing(false); onChanged(); }} />
        : <ContactDetails person={person} />}

      {!editing && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>
          {person.kind === "unverified" && (
            <>
              <Button size="sm" variant="outline" onClick={() => void brain.updatePerson(id, { kind: "person" }).then((r) => { if (r.person) setPerson(r.person); onChanged(); })}><Check size={13} /> Real person</Button>
              <Button size="sm" variant="outline" onClick={() => void brain.updatePerson(id, { kind: "pet" }).then((r) => { if (r.person) setPerson(r.person); onChanged(); })}><PawPrint size={13} /> A pet</Button>
            </>
          )}
          <MergeInto person={person} people={allPeople} onMerged={(into) => { onChanged(); onClose?.(); void into; }} />
          <ConfirmButton size="sm" confirmLabel="Remove for good?" onConfirm={() => void brain.notAPerson(id).then(() => { onChanged(); onClose?.(); })}>Not a person</ConfirmButton>
        </div>
      )}

      <div>
        <div className="mb-2 text-2xs font-medium uppercase tracking-wider text-ink4">Memories with {person.name.split(" ")[0]}{total > 0 && <span className="ml-1.5 normal-case tracking-normal">· {total}</span>}</div>
        {memories === null && <Spinner size={14} className="text-ink3" />}
        {memories && memories.length === 0 && <p className="text-sm text-ink4">None yet.</p>}
        <div className="flex flex-col gap-1.5">
          {memories?.map((m) => (
            <div key={m.id} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink2">
              <span className="mr-2 font-mono text-2xs uppercase text-ink4">{m.type}</span>{m.summary}
            </div>
          ))}
        </div>
        {memories && memories.length < total && (
          <Button className="mt-2" size="sm" variant="ghost" loading={more} onClick={() => void loadMore()}>Show more ({total - memories.length})</Button>
        )}
      </div>
    </div>
  );
}

function ContactDetails({ person }: { person: BrainPerson }) {
  const m = person.meta ?? {};
  const rows: Array<[typeof Phone, string | undefined, string]> = [
    [Phone, m.phone, "phone"], [Mail, m.email, "email"], [Cake, m.birthday, "birthday"], [MapPin, m.location, "location"], [Briefcase, [m.role, m.company].filter(Boolean).join(" · ") || undefined, "work"],
  ];
  const shown = rows.filter(([, v]) => v);
  return (
    <div className="flex flex-col gap-2">
      {person.summary && <p className="text-sm leading-relaxed text-ink2" data-selectable>{person.summary}</p>}
      {shown.length > 0 && (
        <div className="grid grid-cols-1 gap-1.5 rounded-xl border border-line bg-surface p-3 text-sm">
          {shown.map(([Icon, value, key]) => <div key={key} className="flex items-center gap-2.5 text-ink2" data-selectable><Icon size={14} className="text-ink4" />{value}</div>)}
          {m.links?.map((l) => <a key={l} href={l} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5 truncate text-accent hover:underline"><Link2 size={14} className="shrink-0 text-ink4" />{l}</a>)}
        </div>
      )}
      {m.notes && <p className="whitespace-pre-wrap rounded-xl border border-line bg-surface p-3 text-sm text-ink2" data-selectable>{m.notes}</p>}
      {!person.summary && shown.length === 0 && !m.notes && <p className="text-sm text-ink4">No details yet. Add a phone, birthday or notes with Edit.</p>}
    </div>
  );
}

function EditForm({ person, onCancel, onSaved }: { person: BrainPerson; onCancel: () => void; onSaved: (p: BrainPerson) => void }) {
  const [name, setName] = useState(person.name);
  const [kind, setKind] = useState<"person" | "pet">(person.kind === "pet" ? "pet" : "person");
  const [relationship, setRelationship] = useState(person.relationship && person.relationship !== "known" ? person.relationship : "");
  const [summary, setSummary] = useState(person.summary ?? "");
  const [meta, setMeta] = useState<PersonMeta>({ ...person.meta });
  const [links, setLinks] = useState((person.meta.links ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [relations, setRelations] = useState<Array<{ label: string; cardinality: "one" | "many" }>>([]);
  useEffect(() => { void brain.relations().then((r) => setRelations(r.relations)).catch(() => {}); }, []);
  const spec = relations.find((r) => r.label === relationship.trim().toLowerCase());
  const set = (k: keyof PersonMeta) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setMeta((m) => ({ ...m, [k]: e.target.value }));

  async function save(force = false) {
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const r = await brain.updatePerson(person.id, {
        ...(force ? { force: true } : {}),
        name: name.trim() || person.name,
        kind,
        relationship: relationship.trim() || null,
        summary: summary.trim() || null,
        meta: { ...meta, links: links.split(/\s+/).map((l) => l.trim()).filter(Boolean) },
      });
      if (r.person) onSaved(r.person);
    } catch (e) {
      // A one-to-one relation someone else holds: say who, offer to move it.
      if (e instanceof ApiError && e.status === 409) setConflict(e.message);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex flex-col gap-3">
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Field label="Name" htmlFor="pc-name"><Input id="pc-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Segmented<"person" | "pet"> value={kind} onChange={setKind} options={[{ value: "person", label: "Person" }, { value: "pet", label: "Pet" }]} />
      </div>
      <Field label="Relationship to you" htmlFor="pc-rel">
        <Input id="pc-rel" list="pc-rel-options" value={relationship} onChange={(e) => { setRelationship(e.target.value); setConflict(null); }} placeholder="wife, son, friend, colleague…" />
        <datalist id="pc-rel-options">{relations.map((r) => <option key={r.label} value={r.label}>{r.cardinality === "one" ? "only one person" : ""}</option>)}</datalist>
        {spec && <span className="mt-1 block text-xs text-ink4">{spec.cardinality === "one" ? `Only one person can be your ${spec.label}.` : `You can have any number of ${spec.label}s.`}</span>}
      </Field>
      {conflict && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-ink">
          <span className="flex-1">{conflict}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void save(true)}>Move it to {name.trim() || person.name}</Button>
        </div>
      )}
      <Field label="About" htmlFor="pc-sum"><div className="relative"><textarea id="pc-sum" value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} className="w-full rounded-md border border-line bg-surface py-2 pl-3 pr-10 text-sm text-ink focus:border-accent/60" /><FieldMic value={summary} onChange={setSummary} /></div></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Phone" htmlFor="pc-phone"><Input id="pc-phone" value={meta.phone ?? ""} onChange={set("phone")} /></Field>
        <Field label="Email" htmlFor="pc-email"><Input id="pc-email" value={meta.email ?? ""} onChange={set("email")} /></Field>
        <Field label="Birthday" htmlFor="pc-bday"><Input id="pc-bday" value={meta.birthday ?? ""} onChange={set("birthday")} placeholder="YYYY-MM-DD" /></Field>
        <Field label="Location" htmlFor="pc-loc"><Input id="pc-loc" value={meta.location ?? ""} onChange={set("location")} /></Field>
        <Field label="Company" htmlFor="pc-co"><Input id="pc-co" value={meta.company ?? ""} onChange={set("company")} /></Field>
        <Field label="Role" htmlFor="pc-role"><Input id="pc-role" value={meta.role ?? ""} onChange={set("role")} /></Field>
      </div>
      <Field label="Links (one per line)" htmlFor="pc-links"><textarea id="pc-links" value={links} onChange={(e) => setLinks(e.target.value)} rows={2} className="w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs text-ink focus:border-accent/60" /></Field>
      <Field label="Notes" htmlFor="pc-notes"><div className="relative"><textarea id="pc-notes" value={meta.notes ?? ""} onChange={set("notes")} rows={3} className="w-full rounded-md border border-line bg-surface py-2 pl-3 pr-10 text-sm text-ink focus:border-accent/60" /><FieldMic value={meta.notes ?? ""} onChange={(v) => setMeta((m) => ({ ...m, notes: v }))} /></div></Field>
      {error && <p className="text-sm text-red">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>Save</Button>
      </div>
    </form>
  );
}

function MergeInto({ person, people, onMerged }: { person: BrainPerson; people: BrainPerson[]; onMerged: (into: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const candidates = useMemo(() => {
    const first = person.name.split(" ")[0].toLowerCase();
    const others = people.filter((p) => p.id !== person.id);
    const query = q.trim().toLowerCase();
    return (query ? others.filter((p) => p.name.toLowerCase().includes(query)) : others.filter((p) => p.name.toLowerCase().includes(first))).slice(0, 8);
  }, [people, person, q]);
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Merge into…</Button>;
  return (
    <div className="w-full rounded-xl border border-line bg-surface p-3">
      <div className="mb-2 text-sm text-ink">Merge <span className="font-medium">{person.name}</span> into:</div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" autoFocus />
      <div className="mt-2 flex flex-col gap-1">
        {candidates.map((c) => (
          <button key={c.id} onClick={() => void brain.mergePerson(person.id, c.id).then(() => onMerged(c.id))} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-ink/[0.06]">
            <Initials name={c.name} kind={c.kind} size={22} /> <span className="flex-1 text-ink">{c.name}</span><span className="text-xs text-ink4">{c.memoryCount}</span>
          </button>
        ))}
        {candidates.length === 0 && <p className="px-2 text-xs text-ink4">No match.</p>}
      </div>
      <div className="mt-2 text-right"><Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
    </div>
  );
}

/** Why Mercury counts (or doesn't yet count) this as someone in your life. */
function StandingPanel({ person }: { person: BrainPerson }) {
  const s = person.standing!;
  const tone = s.tier === "known" ? "bg-accent" : s.tier === "shadow" ? "bg-amber" : "bg-ink4";
  const label = s.tier === "known" ? "Known" : s.tier === "shadow" ? "Shadow" : "Faint";
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium text-ink">{label}</span>
        <span className="font-mono text-xs text-ink3">{s.score}/100</span>
        {person.cardinality === "one" && <span className="text-xs text-ink4">· one-to-one relationship</span>}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/[0.08]"><div className={cx("h-full rounded-full", tone)} style={{ width: `${s.score}%` }} /></div>
      {s.reasons.length > 0 && <div className="mt-2 text-xs text-ink3">{s.reasons.join(" · ")}</div>}
      {s.tier !== "known" && <div className="mt-1 text-xs text-ink4">Confirm them below, or they join Known once they recur with a relationship.</div>}
    </div>
  );
}

export function VerifiedBadge({ p }: { p: Pick<BrainPerson, "kind" | "verifiedBy"> }) {
  if (p.verifiedBy === "owner") return <Badge tone="accent"><ShieldCheck size={11} className="mr-1" />{p.kind === "pet" ? "pet · you" : "confirmed by you"}</Badge>;
  if (p.verifiedBy === "model") return <Badge tone="cyan"><Sparkles size={11} className="mr-1" />{p.kind === "pet" ? "pet · checked" : "checked"}</Badge>;
  return <Badge>unreviewed</Badge>;
}

export function Initials({ name, kind, size = 40 }: { name: string; kind: string; size?: number }) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = kind === "pet" ? 40 : h % 360;
  const letters = name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
  return (
    <span className={cx("flex shrink-0 items-center justify-center rounded-full font-semibold text-white")}
      style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(135deg, hsl(${hue} 60% 55%), hsl(${(hue + 30) % 360} 65% 42%))` }} aria-hidden="true">
      {kind === "pet" ? <PawPrint size={size * 0.45} /> : letters}
    </span>
  );
}
