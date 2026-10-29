import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "~/api/client";

const stopCall = vi.fn(async () => ({ ok: true }));
const undoCall = vi.fn();
vi.mock("~/api/mercury", () => ({ chat: { stop: () => stopCall(), undo: (id: string, content: string) => undoCall(id, content) } }));

const { conversations } = await import("./conversation");
const { undoLast, turnRunning } = await import("./events");

const store = conversations.chat;
const msg = (id: string, role: "user" | "assistant", content: string) => ({ id, role, content, timestamp: "2026-10-28T10:00:00Z" });

describe("undo your last message", () => {
  beforeEach(() => {
    stopCall.mockClear();
    undoCall.mockReset();
    store.setState({
      activeId: "t1", streaming: "", live: null, agent: "idle", stopping: false, prompts: [], step: null, draft: null,
      messages: [msg("a", "user", "Hi"), msg("b", "assistant", "Hello"), msg("c", "user", "Weather tomorow?"), msg("d", "assistant", "Rain.")],
    });
  });

  it("when nothing is running: takes it back and puts the text in the box", async () => {
    undoCall.mockResolvedValue({ ok: true, content: "Weather tomorow?", removed: 2 });
    expect(turnRunning(store)).toBe(false);
    await undoLast(store, msg("c", "user", "Weather tomorow?"));
    expect(stopCall).not.toHaveBeenCalled();
    expect(undoCall).toHaveBeenCalledWith("t1", "Weather tomorow?");
    expect(store.getState().messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(store.getState().draft).toBe("Weather tomorow?");
  });

  it("while Mercury works: stops first, waits out the runtime, then undoes", async () => {
    store.setState({ agent: "working", messages: store.getState().messages.slice(0, 3) });
    // The runtime ends the turn shortly after the stop.
    stopCall.mockImplementation(async () => { setTimeout(() => store.setState({ agent: "idle", stopping: false }), 50); return { ok: true }; });
    undoCall
      .mockRejectedValueOnce(new ApiError("still working", 409, null, { busy: true }))
      .mockResolvedValueOnce({ ok: true, content: "Weather tomorow?", removed: 2 });
    await undoLast(store, msg("c", "user", "Weather tomorow?"));
    expect(stopCall).toHaveBeenCalledOnce();
    expect(undoCall).toHaveBeenCalledTimes(2);
    expect(store.getState().messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(store.getState().draft).toBe("Weather tomorow?");
  });

  it("a refusal other than busy is reported, and nothing changes", async () => {
    undoCall.mockRejectedValue(new ApiError("Only your last message can be undone.", 409, null, { notLast: true }));
    await expect(undoLast(store, msg("a", "user", "Hi"))).rejects.toThrow("Only your last message");
    expect(store.getState().messages).toHaveLength(4);
    expect(store.getState().draft).toBeNull();
  });
});
