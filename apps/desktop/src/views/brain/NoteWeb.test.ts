import { describe, expect, it } from "vitest";
import type { BrainMap } from "~/api/brain";
import { toWeb } from "./NoteWeb";

const map: BrainMap = {
  themes: [
    { id: "t1", label: "Garden", terms: [], parent: null, size: 3 },
    { id: "t2", label: "Rust", terms: [], parent: null, size: 2 },
    { id: "t2.a", label: "Cargo", terms: [], parent: "t2", size: 2 },
    { id: "loose", label: "Loose notes", terms: [], parent: null, size: 1 },
  ],
  placement: { a: "t1", b: "t1", c: "t1", r1: "t2.a", r2: "t2.a", x: "loose" },
  links: [{ a: "a", b: "b", w: 0.5 }, { a: "b", b: "c", w: 0.4 }, { a: "r1", b: "r2", w: 0.3 }, { a: "c", b: "r1", w: 0.2 }],
  notes: ["a", "b", "c", "r1", "r2", "x"].map((id) => ({ id, text: `note ${id}`, kind: "fact", at: 0, confidence: 0.8, archived: false })),
  stats: { notes: 6, links: 4, themes: 2, ms: 1 },
  available: true,
};
const base = { orphans: true, hidden: new Set<string>(), query: "", local: null };

describe("toWeb", () => {
  it("every note is a dot, every related link a line, sized by connections", () => {
    const w = toWeb(map, base);
    expect(w.nodes.length).toBe(6);
    expect(w.links.length).toBe(4);
    expect(w.nodes.find((n) => n.id === "b")?.degree).toBe(2);
    expect(w.nodes.find((n) => n.id === "x")?.degree).toBe(0);
  });

  it("colours a sub-theme note with its top theme", () => {
    const w = toWeb(map, base);
    const color = (id: string) => w.nodes.find((n) => n.id === id)!.color;
    expect(color("r1")).toBe(color("r2"));
    expect(color("a")).not.toBe(color("r1"));
  });

  it("hides orphans, hidden groups, and non-matching notes", () => {
    expect(toWeb(map, { ...base, orphans: false }).nodes.some((n) => n.id === "x")).toBe(false);
    const noRust = toWeb(map, { ...base, hidden: new Set(["t2"]) });
    expect(noRust.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "x"]);
    expect(noRust.links.length).toBe(2);
    expect(toWeb(map, { ...base, query: "note r" }).nodes.length).toBe(2);
  });

  it("local graph keeps a note and its neighbours to the chosen depth", () => {
    expect(toWeb(map, { ...base, local: { id: "a", depth: 1 } }).nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(toWeb(map, { ...base, local: { id: "a", depth: 3 } }).nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "r1"]);
  });
});
