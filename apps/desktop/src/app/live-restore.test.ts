import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Switching chats mid-reply and coming back shows the reply as far as it
 * got: what the screen had at once, then the runtime's snapshot.
 */
const live = vi.fn();
const thread = vi.fn();
// Every other call openThread makes (research, plan…) answers nothing.
vi.mock("~/api/mercury", () => ({
  chat: new Proxy({ live: (id: string) => live(id), thread: (id: string) => thread(id) } as Record<string, unknown>, {
    get: (t, k: string) => t[k] ?? (async () => ({})),
  }),
}));
vi.mock("~/api/client", () => ({ http: { get: async () => ({}) }, ApiError: class extends Error {} }));

const { conversations } = await import("./conversation");
const { handleEvent, openThread } = await import("./events");
const { liveFromSnapshot } = await import("./trace");
const store = conversations.chat;
const ev = (type: string, data: Record<string, unknown> = {}) => handleEvent(store, type, JSON.stringify(data));

describe("coming back to a chat mid-reply", () => {
  beforeEach(() => {
    live.mockReset(); thread.mockReset();
    store.setState({ activeId: "a", messages: [], streaming: "", live: null, agent: "idle", stopping: false, prompts: [], waiting: null, step: null });
  });

  it("shows the runtime's snapshot: thinking, the running step, the text so far", async () => {
    thread.mockResolvedValue({ messages: [{ id: "u", role: "user", content: "go", timestamp: "" }] });
    live.mockResolvedValue({
      running: true, startedAt: 1000, activity: "⚙️ Running npm test", text: "Half an answer",
      trace: { startedAt: 1000, endedAt: 2000, items: [
        { kind: "reasoning", text: "Planning.", startedAt: 1000, endedAt: 1500 },
        { kind: "tool", id: "c1", title: "Running npm test", status: "running", startedAt: 1500 },
      ] },
    });
    await openThread("chat", "b");
    const s = store.getState();
    expect(s.live?.items?.map((i) => i.kind)).toEqual(["reasoning", "step", "text"]);
    expect(s.live?.steps[0]).toMatchObject({ key: "c1", status: "running" });
    expect(s.streaming).toBe("Half an answer");
    expect(s.agent).toBe("working");
    // Live events carry on from there.
    ev("step_done", { id: "c1", tool: "run_command", summary: "passed", failed: false, durationMs: 4000 });
    expect(store.getState().live?.steps[0].status).toBe("done");
  });

  it("what the screen had is back at once when you return, before the runtime answers", async () => {
    store.setState({ activeId: "a", agent: "working" });
    ev("reasoning", { text: "Thinking about it." });
    ev("step_start", { id: "s1", tool: "read_file", title: "Reading a.ts" });
    thread.mockResolvedValue({ messages: [] });
    let answer!: (v: unknown) => void;
    const pending = new Promise((r) => { answer = r; });
    live.mockImplementation((id: string) => (id === "a" ? pending : Promise.resolve({ running: false })));
    await openThread("chat", "b");          // away
    expect(store.getState().live).toBeNull();
    const back = openThread("chat", "a");   // and back
    await Promise.resolve();
    expect(store.getState().live?.steps[0]).toMatchObject({ key: "s1", status: "running" });
    expect(store.getState().agent).toBe("working");
    answer({ running: false });             // it finished meanwhile
    await back;
    expect(store.getState().live).toBeNull();
    expect(store.getState().agent).toBe("idle");
  });

  it("a snapshot keeps thinking that is still streaming open", () => {
    const t = liveFromSnapshot({ startedAt: 1, endedAt: 2, items: [{ kind: "reasoning", text: "Hmm", startedAt: 1 }] }, "", 1);
    expect(t.items?.[0]).toEqual({ kind: "reasoning", text: "Hmm", startedAt: 1 });
    expect(t.endedAt).toBeUndefined();
  });
});
