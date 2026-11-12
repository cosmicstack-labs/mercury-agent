import { describe, expect, it } from "vitest";
import type { ThoughtStep, ThoughtTrace } from "~/api/types";
import { describeMedia, liveMedia } from "./TurnTimeline";
import { mediaGrid } from "./MediaSkeleton";
import { groupBatches } from "~/views/artifacts/ArtifactsView";
import type { ArtifactItem } from "~/api/artifacts";

const img = (id: number, status: ThoughtStep["status"], count?: number): ThoughtStep => ({
  id, key: `k${id}`, tool: "generate_image", label: "image", status, startedAt: 1000 + id,
  media: { kind: "image", aspect: "landscape", ...(count ? { count } : {}), prompt: "a red fox in snow" },
});
const trace = (steps: ThoughtStep[]) => ({ steps, reasoning: "", startedAt: 0 }) as unknown as ThoughtTrace;

describe("a batch of pictures in a running turn", () => {
  it("five pictures over several calls are one batch, counting the ready ones", () => {
    const b = liveMedia(trace([img(1, "done", 4), img(2, "running"), { id: 3, tool: "read_file", label: "x", status: "done", startedAt: 0 }]));
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ total: 5, done: 4, startedAt: 1001, shape: { kind: "image", count: 5, prompt: "a red fox in snow" } });
    expect(describeMedia(b[0], 2000)).toMatch(/^Creating 5 images · 4 of 5 ready · /);
  });

  it("failed or stopped calls leave the batch", () => {
    expect(liveMedia(trace([img(1, "error"), img(2, "stopped")]))).toEqual([]);
    expect(describeMedia(liveMedia(trace([img(1, "running")]))[0], 1001)).toBe("Creating image · Composing");
  });

  it("waiting and finished share a layout", () => {
    expect(mediaGrid(1).cols).toBe(1);
    expect(mediaGrid(4).cols).toBe(2);
    expect(mediaGrid(5).cols).toBe(3);
  });
});

describe("Artifacts: a batch is one card", () => {
  const a = (id: string, batch?: string) => ({ id, batch, name: `${id}.png`, kind: "image", size: 1, createdAt: 0 }) as ArtifactItem;
  it("gathers a batch at its first place, leaves the rest alone", () => {
    const e = groupBatches([a("1", "B"), a("x"), a("2", "B"), a("3", "B"), a("y")]);
    expect(e.map((x) => x.items.map((i) => i.id))).toEqual([["1", "2", "3"], ["x"], ["y"]]);
  });
});
