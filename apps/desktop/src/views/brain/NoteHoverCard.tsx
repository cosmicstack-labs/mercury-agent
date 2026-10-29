import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Long notes on a graph: the canvas shows a short label, and pausing on a
 * note shows the whole thing in a card beside its dot (Obsidian's page
 * preview, without the modifier key). Clicking still opens the side panel.
 */

/** A note's label for the canvas: its first clause or first few words, never cut mid-word. */
export function shortLabel(text: string, max = 32): string {
  const s = text.replace(/\s+/g, " ").trim().replace(/[.。]+$/, "");
  if (s.length <= max) return s;
  // A natural break early enough reads better than a cut ("…, and later…").
  const clause = /^(.{12,}?)(?:[,;:]\s|\s[—–-]\s|\s\()/.exec(s);
  if (clause && clause[1].length <= max - 1) return `${clause[1].trimEnd()}…`;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const base = space >= max * 0.5 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,;:.(—–-]+$/, "")}…`;
}

export interface HoverNote {
  text: string;
  /** Theme or kind, shown above the text. */
  label?: string;
  color?: string;
}

interface Positioned { x?: number; y?: number }
interface Projector { graph2ScreenCoords(x: number, y: number): { x: number; y: number } }

const DELAY_MS = 280;

/**
 * Hover card state for a force-graph. Call `hover` from onNodeHover and
 * `place` from onRenderFramePost (the dot can move); render `card`.
 */
export function useNoteHoverCard(graph: RefObject<Projector | null>, host: RefObject<HTMLElement | null>) {
  const [note, setNote] = useState<HoverNote | null>(null);
  const anchor = useRef<Positioned | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  function hover(node: Positioned | null, info: HoverNote | null) {
    window.clearTimeout(timer.current);
    if (!node || !info) { anchor.current = null; setNote(null); return; }
    anchor.current = node;
    timer.current = window.setTimeout(() => { if (anchor.current === node) setNote(info); }, DELAY_MS);
  }

  /** Beside the dot, flipped to the other side or nudged in at the edges. */
  function place() {
    const card = el.current, n = anchor.current, g = graph.current, box = host.current;
    if (!card || !n || !g || !box) return;
    const p = g.graph2ScreenCoords(n.x ?? 0, n.y ?? 0);
    const W = box.clientWidth, H = box.clientHeight, w = card.offsetWidth, h = card.offsetHeight, gap = 16;
    let left = p.x + gap;
    if (left + w > W - 8) left = Math.max(8, p.x - gap - w);
    const top = Math.min(Math.max(8, p.y - h / 2), Math.max(8, H - h - 8));
    card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  useLayoutEffect(place, [note]); // eslint-disable-line react-hooks/exhaustive-deps

  const card = note ? (
    <div ref={el} role="tooltip" className="pointer-events-none absolute left-0 top-0 z-20 w-max max-w-[300px] animate-fade-in rounded-xl border border-line bg-surface/95 px-3.5 py-3 shadow-xl backdrop-blur" style={{ transform: "translate(-9999px, 0)" }}>
      {note.label && (
        <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-ink4">
          {note.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: note.color }} />}
          <span className="truncate">{note.label}</span>
        </div>
      )}
      <p className="line-clamp-5 text-sm leading-relaxed text-ink">{note.text}</p>
      <div className="mt-2 text-2xs text-ink4">Click to open</div>
    </div>
  ) : null;

  return { hover, place, card };
}
