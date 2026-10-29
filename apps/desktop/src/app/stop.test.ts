import { beforeEach, describe, expect, it, vi } from "vitest";

const stopCall = vi.fn(async () => ({ ok: true }));
vi.mock("~/api/mercury", () => ({ chat: { stop: () => stopCall() } }));

const { conversations } = await import("./conversation");
const { isStopNote, stopTurn } = await import("./events");

const store = conversations.chat;

describe("stop button", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.setState({ messages: [], streaming: "", live: null, agent: "idle", stopping: false, prompts: [], step: null });
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
    expect(stopCall).toHaveBeenCalledOnce();
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
});
