import { useCallback, useEffect, useState } from "react";
import { brain, type BrainMemory, type BrainPerson } from "~/api/brain";
import { useUi } from "~/app/store";
import { ErrorBoundary } from "~/components/ErrorBoundary";
import { Badge, Segmented, Spinner } from "~/components/ui/bits";
import { PageHeader } from "~/components/ui/kit";
import { BrainGraph, type SelectableKind } from "./BrainGraph";
import { Memories } from "./Memories";
import { MindMap } from "./MindMap";
import { NoteWeb } from "./NoteWeb";
import { People } from "./People";
import { PersonCard } from "./PersonCard";

type Tab = "mind" | "map" | "graph" | "memories" | "people";
const TAB_KEY = "mercury.brain.tab";

/**
 * The second brain: the mind map (every note and its connections), the
 * themes (the same notes as a radial tree), a living graph of people, the
 * memories, and the people. Each tab loads its data only when
 * first opened; canvases pause while hidden; each part is behind its own
 * crash boundary.
 */
export function BrainView() {
  const view = useUi((s) => s.view);
  const [tab, setTab] = useState<Tab>(() => { try { return (sessionStorage.getItem(TAB_KEY) as Tab) || "mind"; } catch { return "mind"; } });
  const [opened, setOpened] = useState<Record<Tab, boolean>>({ mind: false, map: false, graph: false, memories: false, people: false });
  const [selected, setSelected] = useState<{ id: string; kind: SelectableKind } | null>(null);
  const [people, setPeople] = useState<BrainPerson[]>([]);
  const visible = view === "brain";

  useEffect(() => { try { sessionStorage.setItem(TAB_KEY, tab); } catch { /* ignore */ } }, [tab]);
  useEffect(() => { if (visible) setOpened((o) => (o[tab] ? o : { ...o, [tab]: true })); }, [visible, tab]);
  const loadPeople = useCallback(() => { void brain.persons({ limit: 2000 }).then((r) => setPeople(r.persons)).catch(() => {}); }, []);
  useEffect(() => { if (visible && selected && selected.kind !== "memory" && people.length === 0) loadPeople(); }, [visible, selected, people.length, loadPeople]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Brain">
        <Segmented size="md" value={tab} onChange={setTab} options={[{ value: "mind", label: "Mind map" }, { value: "map", label: "Themes" }, { value: "graph", label: "Graph" }, { value: "memories", label: "Memories" }, { value: "people", label: "People" }]} />
      </PageHeader>
      <div className="relative min-h-0 flex-1">
        <div className={tab === "mind" || tab === "map" || tab === "graph" ? "absolute inset-0 flex" : "hidden"}>
          <div className="relative min-w-0 flex-1">
            <div className={tab === "mind" ? "absolute inset-0" : "hidden"}>
              {opened.mind && (
                <ErrorBoundary label="The mind map" resetKey={tab}>
                  <NoteWeb visible={visible && tab === "mind"} selectedId={selected?.id ?? null} onSelect={setSelected} />
                </ErrorBoundary>
              )}
            </div>
            <div className={tab === "map" ? "absolute inset-0" : "hidden"}>
              {opened.map && (
                <ErrorBoundary label="Themes" resetKey={tab}>
                  <MindMap visible={visible && tab === "map"} selectedId={selected?.id ?? null} onSelect={setSelected} />
                </ErrorBoundary>
              )}
            </div>
            <div className={tab === "graph" ? "absolute inset-0" : "hidden"}>
              {opened.graph && (
                <ErrorBoundary label="The graph" resetKey={tab}>
                  <BrainGraph visible={visible && tab === "graph"} selectedId={selected?.id ?? null} onSelect={setSelected} />
                </ErrorBoundary>
              )}
            </div>
          </div>
          {selected && selected.kind !== "you" && (
            <aside className="w-[380px] shrink-0 overflow-y-auto border-l border-line bg-soft">
              <ErrorBoundary label="Details" resetKey={selected.id}>
                {selected.kind === "memory"
                  ? <MemoryDetail id={selected.id} onClose={() => setSelected(null)} onOpenList={() => setTab("memories")} />
                  : <PersonCard id={selected.id} allPeople={people} onClose={() => setSelected(null)} onChanged={loadPeople} />}
              </ErrorBoundary>
            </aside>
          )}
        </div>
        <div className={tab === "memories" ? "absolute inset-0" : "hidden"}>
          {opened.memories && <ErrorBoundary label="Memories"><Memories focusId={selected?.kind === "memory" ? selected.id : null} /></ErrorBoundary>}
        </div>
        <div className={tab === "people" ? "absolute inset-0" : "hidden"}>
          {opened.people && <ErrorBoundary label="People"><People initialId={selected && selected.kind !== "memory" && selected.kind !== "you" ? selected.id : null} /></ErrorBoundary>}
        </div>
      </div>
    </div>
  );
}

/** A memory's details, fetched when its node is clicked. */
function MemoryDetail({ id, onClose, onOpenList }: { id: string; onClose: () => void; onOpenList: () => void }) {
  const [m, setM] = useState<BrainMemory | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setM(null);
    brain.memory(id).then((r) => { if (live) setM(r); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [id]);
  if (error) return <div className="p-5 text-sm text-red">{error}</div>;
  if (!m) return <div className="p-5 text-ink3"><Spinner size={16} /></div>;
  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-2 text-xs text-ink4">
        <Badge>{m.type}</Badge>
        {m.evidenceKind === "owner" && <Badge tone="accent">you said</Badge>}
        <span className="flex-1" />
        <button onClick={onClose} className="rounded-md px-1 text-ink4 hover:text-ink" aria-label="Close">✕</button>
      </div>
      <p className="text-lg leading-relaxed text-ink" data-selectable>{m.summary}</p>
      {m.detail && <p className="text-sm leading-relaxed text-ink2" data-selectable>{m.detail}</p>}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-xl border border-line bg-surface p-3 text-sm">
        <dt className="text-ink4">Confidence</dt><dd className="text-ink">{Math.round(m.confidence * 100)}%</dd>
        {m.evidenceCount !== undefined && <><dt className="text-ink4">Evidence</dt><dd className="text-ink">{m.evidenceCount}</dd></>}
        <dt className="text-ink4">First learned</dt><dd className="text-ink">{new Date(m.createdAt).toLocaleDateString()}</dd>
        <dt className="text-ink4">Last updated</dt><dd className="text-ink">{new Date(m.updatedAt).toLocaleDateString()}</dd>
      </dl>
      <button onClick={onOpenList} className="w-fit text-sm text-accent hover:underline">Edit in Memories →</button>
    </div>
  );
}
