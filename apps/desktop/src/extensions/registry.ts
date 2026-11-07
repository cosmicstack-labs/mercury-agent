/* ═══════════════════════════════════════════════════════════════
   UI contribution registry — the extension point for the app chrome.

   Everything in the status bar (and, later, the environment bar, the
   command palette and view toolbars) is a CONTRIBUTION: an object with a
   stable id that a module registers. Built-in items register the same way
   a future UI plugin will, so plugins get no special path and built-ins
   get no special privileges.

   The user's layout is stored BY ID (hidden, order), never by position, so
   adding or removing contributions never scrambles someone's setup.

   Contract for a contribution (keep it stable; plugins will depend on it):
     id         "<owner>.<name>", e.g. "mercury.tokens", "optimus.screen"
     title      what the Customize menu calls it
     area       "status.left" | "status.right"
     priority   higher sits further left within its area (VS Code's rule)
     views      the views it appears in; omit for all
     render     a React component, mounted while visible
     defaultHidden  start hidden until the user turns it on
   ═══════════════════════════════════════════════════════════════ */

import { create } from "zustand";
import type { ComponentType } from "react";
import type { View } from "~/app/store";

export type ContributionArea = "status.left" | "status.right";

export interface StatusContribution {
  id: string;
  title: string;
  area: ContributionArea;
  priority: number;
  views?: View[];
  render: ComponentType;
  defaultHidden?: boolean;
  /** Who contributed it: "mercury" for built-ins, a plugin id otherwise. */
  source?: string;
}

interface Layout {
  hidden: string[];
  shown: string[];
  /** User order per area, by id; ids not listed fall back to priority. */
  order: Partial<Record<ContributionArea, string[]>>;
}

interface RegistryState {
  items: Record<string, StatusContribution>;
  layout: Layout;
  register(item: StatusContribution): () => void;
  setVisible(id: string, visible: boolean): void;
  move(id: string, direction: -1 | 1): void;
  reset(): void;
}

const LAYOUT_KEY = "mercury.statusbar.layout.v1";
const EMPTY: Layout = { hidden: [], shown: [], order: {} };

function readLayout(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as Layout | null;
    if (!raw || !Array.isArray(raw.hidden)) return EMPTY;
    return { hidden: raw.hidden, shown: Array.isArray(raw.shown) ? raw.shown : [], order: raw.order ?? {} };
  } catch {
    return EMPTY;
  }
}

function writeLayout(layout: Layout): void {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* private mode */ }
}

const ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/;

export const useContributions = create<RegistryState>((set, get) => ({
  items: {},
  layout: readLayout(),
  register(item) {
    if (!ID_RE.test(item.id)) throw new Error(`Contribution id must look like "owner.name": ${item.id}`);
    set((s) => ({ items: { ...s.items, [item.id]: { source: "mercury", ...item } } }));
    return () => set((s) => {
      const items = { ...s.items };
      delete items[item.id];
      return { items };
    });
  },
  setVisible(id, visible) {
    const { layout } = get();
    const next: Layout = {
      ...layout,
      hidden: visible ? layout.hidden.filter((x) => x !== id) : [...new Set([...layout.hidden, id])],
      shown: visible ? [...new Set([...layout.shown, id])] : layout.shown.filter((x) => x !== id),
    };
    writeLayout(next);
    set({ layout: next });
  },
  move(id, direction) {
    const item = get().items[id];
    if (!item) return;
    const ordered = orderedIds(get().items, get().layout, item.area);
    const i = ordered.indexOf(id);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    const next: Layout = { ...get().layout, order: { ...get().layout.order, [item.area]: ordered } };
    writeLayout(next);
    set({ layout: next });
  },
  reset() {
    writeLayout(EMPTY);
    set({ layout: EMPTY });
  },
}));

export function isVisible(item: StatusContribution, layout: Layout): boolean {
  if (layout.hidden.includes(item.id)) return false;
  if (item.defaultHidden) return layout.shown.includes(item.id);
  return true;
}

/** Ids in an area in display order: the user's order first, then by priority. */
export function orderedIds(items: Record<string, StatusContribution>, layout: Layout, area: ContributionArea): string[] {
  const inArea = Object.values(items).filter((i) => i.area === area);
  const custom = (layout.order[area] ?? []).filter((id) => inArea.some((i) => i.id === id));
  const rest = inArea.filter((i) => !custom.includes(i.id)).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).map((i) => i.id);
  // Items new since the user ordered go in by priority relative to the custom block's end.
  return [...custom, ...rest];
}

/** Public surface for UI add-ons. Stable names; extend, never rename. */
export const mercuryUi = {
  registerStatusItem: (item: StatusContribution) => useContributions.getState().register(item),
};
