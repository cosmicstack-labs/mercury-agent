import { beforeEach, describe, expect, it, vi } from "vitest";

const stopCall = vi.fn(async (_id: string) => ({ ok: true }));
vi.mock("~/api/mercury", () => ({ chat: { stop: (id: string) => stopCall(id) } }));

const { conversations } = await import("./conversation");
const { isStopNote, stopTurn, handleEvent } = await import("./events");

const store = conversations.chat;

describe("stop button", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.setState({ activeId: "a", messages: [], streaming: "", live: null, agent: "idle", stopping: false, prompts: [], step: null });
    stopCall.mockClear();
  });

  it("recognises the runtime's stop note", () => {
    expect(isStopNote("⏹ Task stopped. Its work entry was cancelled — a restart will not resume it.")).toBe(true);
    expect(isStopNote("⏹ Task halted. …")).toBe(true);
    expect(isStopNote("The task stopped early because of rain.")).toBe(false);
  });

  it("marks running steps as stopped at once, never as done", async () => {
    store.setState({ agent: "working", live: { reasoning: "", startedAt: 1, steps: [
      { id: 1, tool: "read_file", label: "read_file", status: "done", startedAt: 1, endedAt: 2 },
      { id: 2, tool: "run_command", label: "run_command", status: "running", startedAt: 2 },
    ] } });
    await stopTurn(store);
    expect(stopCall).toHaveBeenCalledWith("a");
    expect(store.getState().stopping).toBe(true);
    expect(store.getState().live?.steps.map((s) => s.status)).toEqual(["done", "stopped"]);
  });

  it("ends the turn as stopped and keeps the partial answer", async () => {
    store.setState({ agent: "streaming", streaming: "Half an ans", live: { reasoning: "thinking…", startedAt: 1, steps: [] } });
    await stopTurn(store);
    vi.advanceTimersByTime(8000);
    const s = store.getState();
    expect(s.stopping).toBe(false);
    expect(s.agent).toBe("idle");
    expect(s.streaming).toBe("");
    const last = s.messages.at(-1);
    expect(last?.stopped).toBe(true);
    expect(last?.content).toBe("Half an ans");
    expect(last?.trace?.stopped).toBe(true);
  });

  it("adds nothing when the answer had already finished", async () => {
    store.setState({ agent: "idle" });
    await stopTurn(store);
    vi.advanceTimersByTime(8000);
    expect(store.getState().messages).toHaveLength(0);
  });

  it("lets you press stop again if the runtime refused", async () => {
    stopCall.mockRejectedValueOnce(new Error("offline"));
    store.setState({ agent: "working" });
    await expect(stopTurn(store)).rejects.toThrow("offline");
    expect(store.getState().stopping).toBe(false);
  });

  it("never sends a global stop from a new conversation", async () => {
    store.getState().setActive(null);
    await stopTurn(store);
    expect(stopCall).not.toHaveBeenCalled();
  });

  it("a delayed stop completion cannot end the newly selected conversation", async () => {
    let finish!: () => void;
    stopCall.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true }); }));
    store.setState({ agent: "working" });
    const stopped = stopTurn(store);
    store.getState().setActive("b");
    store.setState({ agent: "streaming", streaming: "B still runs", stopping: true });
    finish();
    await stopped;
    vi.advanceTimersByTime(8000);
    expect(stopCall).toHaveBeenCalledWith("a");
    expect(store.getState()).toMatchObject({ activeId: "b", agent: "streaming", streaming: "B still runs", stopping: true });
  });

  it("a late rejected stop does not clear the next conversation's stopping state", async () => {
    let reject!: (reason: Error) => void;
    stopCall.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const stopped = stopTurn(store);
    store.getState().setActive("b");
    store.setState({ stopping: true });
    reject(new Error("late refusal"));
    await expect(stopped).resolves.toBeUndefined();
    expect(store.getState().stopping).toBe(true);
  });

  it("an old timer cannot stop a new turn after leaving and reopening the same chat", async () => {
    await stopTurn(store);
    store.getState().setActive("b");
    store.getState().setActive("a");
    store.setState({ agent: "working", stopping: true });
    vi.advanceTimersByTime(8000);
    expect(store.getState()).toMatchObject({ agent: "working", stopping: true });
  });


  it("a late cancellation never clears artifacts waiting for another session's answer", async () => {
    let finish!: () => void;
    stopCall.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true }); }));
    store.setState({ agent: "working" });
    const stopped = stopTurn(store);
    store.getState().setActive("b");
    handleEvent(store, "thinking", JSON.stringify({ targetId: "b" }));
    handleEvent(store, "artifacts", JSON.stringify({ targetId: "b", items: [{ id: "b-file", name: "B output" }] }));
    finish();
    await stopped;
    vi.advanceTimersByTime(8000);
    handleEvent(store, "text_done", JSON.stringify({ targetId: "a", text: "⏹ Task stopped. A only." }));
    handleEvent(store, "text_done", JSON.stringify({ targetId: "b", text: "B answer" }));
    expect(store.getState().messages.at(-1)?.artifacts?.map(item => item.id)).toEqual(["b-file"]);
  });

});
