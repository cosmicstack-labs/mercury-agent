import { describe, expect, it } from "vitest";
import type { BrainGraphData } from "~/api/brain";
import { toGraph } from "./BrainGraph";

const data: BrainGraphData = {
  available: true,
  persons: [
    { id: "heer", name: "Heer", kind: "person", relationship: "wife", memoryCount: 5, tier: "known", score: 99 },
    { id: "zaid", name: "Zaid", kind: "person", relationship: "friend", memoryCount: 4, tier: "known", score: 99 },
    { id: "castor", name: "Castor", kind: "unverified", relationship: null, memoryCount: 4, tier: "shadow", score: 56 },
  ],
  memories: [
    { id: "m1", summary: "Heer loves tea", type: "preference", importance: 0.5, updatedAt: 1 },
    { id: "m2", summary: "Ship Mercury Desktop", type: "project", importance: 0.8, updatedAt: 1 },
    { id: "m3", summary: "Castor promo video", type: "project", importance: 0.4, updatedAt: 1 },
  ],
  memoryPersons: [{ memoryId: "m1", personId: "heer", role: "mention" }],
  relationships: [{ source: "zaid", target: "heer", type: "knows", strength: 0.6 }],
};

const ids = (g: ReturnType<typeof toGraph>) => g.nodes.map((n) => n.id);
const link = (g: ReturnType<typeof toGraph>, kind: string) => g.links.filter((l) => l.kind === kind).map((l) => `${String(l.source)}>${String(l.target)}${l.label ? `:${l.label}` : ""}`);

describe("brain graph shape", () => {
  it("clusters memories on people, and the rest by topic instead of one star on you", () => {
    const g = toGraph(data, "all");
    expect(link(g, "about")).toEqual(["m1>heer"]);
    expect(link(g, "topic").sort()).toEqual(["m2>hub:project", "m3>hub:project"]);
    expect(link(g, "hub")).toEqual(["you>hub:project"]);
    expect(g.links.some((l) => l.kind === "you" && String(l.target).startsWith("m"))).toBe(false);
    expect(g.nodes.find((n) => n.id === "hub:project")?.label).toBe("Projects · 2");
  });

  it("names relationships on the lines", () => {
    const g = toGraph(data, "all");
    expect(link(g, "you")).toContain("you>heer:wife");
    expect(link(g, "relation")).toEqual(["zaid>heer:knows"]);
  });

  it("marks shadows and keeps label priority: you, topics, people, memories", () => {
    const g = toGraph(data, "all");
    expect(g.nodes.find((n) => n.id === "castor")?.shadow).toBe(true);
    expect(ids(g)).toEqual(["you", "hub:project", "heer", "zaid", "castor", "m1", "m2", "m3"]);
  });

  it("filters: people only, or memories only", () => {
    expect(ids(toGraph(data, "people"))).toEqual(["you", "heer", "zaid", "castor"]);
    const mem = toGraph(data, "memories");
    expect(mem.nodes.some((n) => n.kind === "person")).toBe(false);
    expect(link(mem, "topic").length).toBe(3);
  });
});
