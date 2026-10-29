import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/api/mercury", () => ({ chat: { stop: async () => ({ ok: true }) } }));

const { conversations } = await import("~/app/conversation");
const { handleEvent } = await import("~/app/events");
const { parseCsv } = await import("./ArtifactViewer");

const store = conversations.chat;
const ref = (id: string) => ({ id, name: `${id}.png`, kind: "image" as const, mime: "image/png", size: 10, path: `/tmp/${id}.png` });

describe("artifacts in chat", () => {
  beforeEach(() => {
    store.setState({ messages: [], streaming: "", live: null, agent: "idle", stopping: false, prompts: [], step: null, activeId: null });
  });

  it("holds artifacts that arrive mid-turn and attaches them to the reply", () => {
    store.setState({ agent: "working", messages: [{ id: "u", role: "user", content: "draw", timestamp: "" }] });
    handleEvent(store, "artifacts", JSON.stringify({ items: [ref("a")] }));
    expect(store.getState().messages).toHaveLength(1);
    handleEvent(store, "text_done", JSON.stringify({ fullText: "Here it is." }));
    const last = store.getState().messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.artifacts?.map((a) => a.id)).toEqual(["a"]);
  });

  it("attaches artifacts that arrive after the reply to that reply", () => {
    store.setState({ agent: "idle", messages: [{ id: "u", role: "user", content: "draw", timestamp: "" }, { id: "r", role: "assistant", content: "Done.", timestamp: "" }] });
    handleEvent(store, "artifacts", JSON.stringify({ items: [ref("b")] }));
    expect(store.getState().messages.at(-1)!.artifacts?.map((a) => a.id)).toEqual(["b"]);
  });

  it("doesn't leak held artifacts into the next turn", () => {
    store.setState({ agent: "working" });
    handleEvent(store, "text_done", JSON.stringify({ fullText: "No files." }));
    expect(store.getState().messages.at(-1)!.artifacts).toBeUndefined();
  });
});

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, commas and CRLF", () => {
    expect(parseCsv('name,note\r\n"Smith, J","said ""hi"""\nx,y')).toEqual([["name", "note"], ["Smith, J", 'said "hi"'], ["x", "y"]]);
  });
  it("caps rows for the preview", () => {
    expect(parseCsv("a\nb\nc\nd", 2)).toHaveLength(2);
  });
});
