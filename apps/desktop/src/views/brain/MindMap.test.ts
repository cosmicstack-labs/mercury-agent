import { describe, expect, it } from "vitest";
import type { BrainMap } from "~/api/brain";
import { toMindMap } from "./MindMap";

const map: BrainMap = {
  themes: [
    { id: "t1", label: "Garden · Tomatoes", terms: [], parent: null, size: 3 },
    { id: "t2", label: "Rust · CLI", terms: [], parent: null, size: 4 },
    { id: "t2.a", label: "Cargo", terms: [], parent: "t2", size: 2 },
    { id: "t2.b", label: "Ownership", terms: [], parent: "t2", size: 2 },
    { id: "loose", label: "Loose notes", terms: [], parent: null, size: 1 },
  ],
  placement: { g1: "t1", g2: "t1", g3: "t1", r1: "t2.a", r2: "t2.a", r3: "t2.b", r4: "t2.b", x: "loose" },
  links: [{ a: "g1", b: "g2", w: 0.5 }, { a: "r1", b: "r2", w: 0.4 }],
  notes: ["g1", "g2", "g3", "r1", "r2", "r3", "r4", "x"].map((id, i) => ({ id, text: `note ${id}`, kind: "fact", at: i, confidence: 0.8, archived: false })),
  stats: { notes: 8, links: 2, themes: 2, ms: 1 },
  available: true,
};

describe("toMindMap", () => {
  it("builds you → themes → sub-themes → notes", () => {
    const { nodes, links } = toMindMap(map);
    const kind = (id: string) => nodes.find((n) => n.id === id)?.kind;
    expect(kind("you")).toBe("you");
    expect(kind("t1")).toBe("theme");
    expect(kind("t2.a")).toBe("sub");
    expect(kind("r1")).toBe("note");
    expect(nodes.find((n) => n.id === "r1")?.parent).toBe("t2.a");
    expect(nodes.find((n) => n.id === "g1")?.parent).toBe("t1");
    expect(links.length).toBe(nodes.length - 1);
  });

  it("puts notes on the outer ring and themes inside it", () => {
    const { nodes } = toMindMap(map);
    const r = (id: string) => { const n = nodes.find((x) => x.id === id)!; return Math.hypot(n.tx, n.ty); };
    expect(r("you")).toBe(0);
    expect(r("t1")).toBeLessThan(r("t2.a"));
    expect(r("t2.a")).toBeLessThan(r("r1"));
    expect(Math.abs(r("g1") - r("r4"))).toBeLessThan(1e-6);
  });

  it("colours a branch with its theme and keeps loose notes grey, last", () => {
    const { nodes } = toMindMap(map);
    const c = (id: string) => nodes.find((n) => n.id === id)!.color;
    expect(c("r1")).toBe(c("t2"));
    expect(c("t1")).not.toBe(c("t2"));
    expect(c("x")).toBe("#8A97A3");
    expect(nodes.filter((n) => n.kind === "theme").at(-1)?.id).toBe("loose");
  });

  it("indexes related notes both ways, strongest first", () => {
    const { related } = toMindMap(map);
    expect(related.get("g2")?.[0][0]).toBe("g1");
    expect(related.get("r1")?.[0]).toEqual(["r2", 0.4]);
  });
});
