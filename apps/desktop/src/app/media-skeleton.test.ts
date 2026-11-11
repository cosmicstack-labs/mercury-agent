import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Media on its way: a placeholder in the right shape while a picture or
 * voice is made in the reply, and one per video or song made in the
 * background until it arrives.
 */
vi.mock("~/api/mercury", () => ({ chat: {} }));

const { conversations } = await import("./conversation");
const { handleEvent } = await import("./events");
const { mediaPhase } = await import("~/components/MediaSkeleton");
const store = conversations.chat;
const ev = (type: string, data: Record<string, unknown> = {}) => handleEvent(store, type, JSON.stringify(data));

describe("media placeholders", () => {
  beforeEach(() => store.setState({ activeId: "a", messages: [], streaming: "", live: null, agent: "thinking", pendingMedia: [], prompts: [], waiting: null }));

  it("a picture being made: its step carries the shape for the placeholder", () => {
    ev("step_start", { id: "c1", tool: "generate_image", title: "Generating an image", media: { kind: "image", aspect: "portrait", count: 2, prompt: "a fox" } });
    expect(store.getState().live?.steps[0].media).toEqual({ kind: "image", aspect: "portrait", count: 2, prompt: "a fox" });
  });

  it("a video in the background holds its place until it arrives, then becomes a message", () => {
    ev("media_pending", { jobId: "j1", kind: "video", prompt: "a cat surfing", startedAt: 1000, aspect: "portrait" });
    ev("media_pending", { jobId: "j2", kind: "music", prompt: "lo-fi", startedAt: 1000 });
    expect(store.getState().pendingMedia.map((p) => p.jobId)).toEqual(["j1", "j2"]);
    ev("media_ready", { jobId: "j1", text: "🎬 Your video is ready.", artifacts: [{ id: "x", name: "cat.mp4", kind: "video", mime: "video/mp4", size: 1, path: "/p", tool: "generate_video" }] });
    expect(store.getState().pendingMedia.map((p) => p.jobId)).toEqual(["j2"]);
    expect(store.getState().messages.at(-1)?.artifacts?.[0].tool).toBe("generate_video");
  });

  it("the status moves on during a long wait, so it never reads as stuck", () => {
    expect(mediaPhase("image", 0)).toBe("Composing");
    expect(mediaPhase("image", 12_000)).toBe("Adding light and colour");
    expect(mediaPhase("image", 600_000)).toBe("Refining");
    expect(mediaPhase("video", 30_000)).toBe("Animating");
  });
});
