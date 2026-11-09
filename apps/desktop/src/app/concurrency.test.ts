import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ thread: vi.fn(), createThread: vi.fn(), send: vi.fn(), get: vi.fn(), research: vi.fn() }));
vi.mock("~/api/mercury", () => ({ chat: { ...api, threads: async () => ({ threads: [] }) } }));
vi.mock("~/api/client", () => ({ http: { get: api.get }, ApiError: class extends Error {} }));
const { conversations } = await import("./conversation");
const { handleEvent, openThread, sendMessage } = await import("./events");
const store = conversations.chat;
const message = (content: string) => ({ id: content, role: "user" as const, content, timestamp: "2026-11-06T00:00:00Z" });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };

beforeEach(() => {
  vi.resetAllMocks();
  store.getState().setActive("a");
  api.get.mockResolvedValue({});
  api.send.mockResolvedValue({ sent: true });
  api.research.mockResolvedValue({ armed: false, run: null });
});

describe("conversation isolation", () => {
  it("a fresh chat clears busy, queued, streaming and loading state", () => {
    store.setState({ waiting: { position: 1 }, agent: "working", streaming: "A partial", loading: true, stopping: true });
    store.getState().setActive(null);
    expect(store.getState()).toMatchObject({ waiting: null, agent: "idle", streaming: "", loading: false, stopping: false });
  });

  it.each(["sessionId", "targetId"])("ignores other conversations identified by %s, including while new", (key) => {
    handleEvent(store, "text_delta", JSON.stringify({ [key]: "b", text: "B private" }));
    expect(store.getState().streaming).toBe("");
    store.getState().setActive(null);
    handleEvent(store, "thinking", JSON.stringify({ [key]: "a" }));
    handleEvent(store, "text_done", JSON.stringify({ [key]: "a", text: "A private" }));
    expect(store.getState()).toMatchObject({ agent: "idle", messages: [] });
    handleEvent(store, "thinking", "{}");
    expect(store.getState().agent).toBe("idle");
  });

  it("drops untargeted conversation broadcasts", () => {
    handleEvent(store, "thinking", "{}");
    handleEvent(store, "text_delta", JSON.stringify({ text: "Unscoped private text" }));
    handleEvent(store, "text_done", JSON.stringify({ text: "Unscoped answer" }));
    handleEvent(store, "error", JSON.stringify({ message: "Unscoped failure" }));
    expect(store.getState()).toMatchObject({ agent: "idle", messages: [], streaming: "" });
  });

  it.each(["text_done", "error"])("clears held artifacts when a turn ends with %s cancellation or failure", (event) => {
    store.setState({ agent: "working" });
    handleEvent(store, "artifacts", JSON.stringify({ targetId: "a", items: [{ id: "cancelled-file", name: "Old output" }] }));
    handleEvent(store, event, JSON.stringify({ targetId: "a", text: "⏹ Task stopped. Cancelled.", message: "Failed" }));
    handleEvent(store, "thinking", JSON.stringify({ targetId: "a" }));
    handleEvent(store, "text_done", JSON.stringify({ targetId: "a", text: "Next answer" }));
    expect(store.getState().messages.at(-1)?.artifacts).toBeUndefined();
  });

  it("ignores a slow history response after another chat is selected", async () => {
    const old = deferred<{ messages: ReturnType<typeof message>[] }>();
    api.thread.mockImplementation((id: string) => id === "a" ? old.promise : Promise.resolve({ messages: [message("B message")] }));
    const first = openThread("chat", "a");
    await openThread("chat", "b");
    old.resolve({ messages: [message("A message")] });
    await first;
    expect(store.getState().messages.map(m => m.content)).toEqual(["B message"]);
  });

  it("loads history without removing a reply delivered during either bounded fetch", async () => {
    const first = deferred<{ messages: ReturnType<typeof message>[] }>();
    const second = deferred<{ messages: ReturnType<typeof message>[] }>();
    api.thread.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const opened = openThread("chat", "a");
    handleEvent(store, "text_done", JSON.stringify({ targetId: "a", text: "First live answer" }));
    first.resolve({ messages: [message("Old question")] });
    await first.promise;
    await Promise.resolve();
    handleEvent(store, "text_done", JSON.stringify({ targetId: "a", text: "Second live answer" }));
    second.resolve({ messages: [message("Old question")] });
    await opened;
    expect(api.thread).toHaveBeenCalledTimes(2);
    expect(store.getState().messages.map(m => m.content)).toEqual(["Old question", "First live answer", "Second live answer"]);
  });

  it("reconciles only the newly persisted tail and keeps repeated older answers and live traces", async () => {
    const pending = deferred<{ messages: unknown[] }>();
    const before = Date.now() - 60_000;
    const old = { id: "old", role: "assistant", content: "Okay", timestamp: new Date(before).toISOString() };
    api.thread.mockReturnValueOnce(pending.promise).mockImplementationOnce(async () => ({ messages: [old, { id: "saved-live", role: "assistant", content: "Okay", timestamp: new Date().toISOString() }] }));
    const opened = openThread("chat", "a");
    store.getState().setLive(() => ({ reasoning: "Verified", startedAt: Date.now(), steps: [] }));
    handleEvent(store, "text_done", JSON.stringify({ targetId: "a", text: "Okay" }));
    pending.resolve({ messages: [old] });
    await opened;
    expect(store.getState().messages.map(m => m.id)).toEqual(["old", "saved-live"]);
    expect(store.getState().messages.at(-1)?.trace?.reasoning).toBe("Verified");
  });

  it("keeps a same-session optimistic send when the initial snapshot was already in flight", async () => {
    const snapshot = deferred<{ messages: ReturnType<typeof message>[] }>();
    api.thread.mockReturnValue(snapshot.promise);
    const opened = openThread("chat", "a");
    await sendMessage("chat", "New request");
    snapshot.resolve({ messages: [message("Old question")] });
    await opened;
    expect(store.getState().messages.map(m => m.content)).toEqual(["Old question", "New request"]);
  });

  it("does not replay stale pending, research or plan snapshots after their live resolution", async () => {
    const pending = deferred<unknown>();
    const research = deferred<unknown>();
    const plan = deferred<unknown>();
    api.thread.mockResolvedValue({ messages: [] });
    api.get.mockImplementation((path: string) => path.includes("/pending?") ? pending.promise : path.includes("/plan?") ? plan.promise : Promise.resolve({}));
    api.research.mockReturnValue(research.promise);
    await openThread("chat", "a");
    handleEvent(store, "permission_resolved", JSON.stringify({ targetId: "a", id: "old-permission" }));
    handleEvent(store, "research_plan_resolved", JSON.stringify({ targetId: "a", id: "old-research-plan" }));
    handleEvent(store, "research", JSON.stringify({ targetId: "a", runId: "r", state: "done" }));
    handleEvent(store, "plan", JSON.stringify({ targetId: "a", steps: [{ label: "Done", status: "done" }] }));
    handleEvent(store, "text_done", JSON.stringify({ targetId: "a", text: "Finished" }));
    pending.resolve({ prompts: [{ id: "old-permission", type: "permission_request", prompt: "Already resolved" }, { id: "old-research-plan", type: "research_plan" }] });
    research.resolve({ armed: false, run: { runId: "r", state: "running" } });
    plan.resolve({ plan: { steps: [{ label: "Old", status: "active" }], updatedAt: 0 } });
    await Promise.all([pending.promise, research.promise, plan.promise]);
    expect(store.getState()).toMatchObject({ prompts: [], researchPlan: null, agent: "idle", research: { run: { state: "done" } }, plan: { steps: [{ label: "Done", status: "done" }] } });
  });

  it("an unrelated heartbeat does not hide an approval fetched while opening the chat", async () => {
    const pending = deferred<unknown>();
    api.thread.mockResolvedValue({ messages: [] });
    api.get.mockImplementation((path: string) => path.includes("/pending?") ? pending.promise : Promise.resolve({}));
    await openThread("chat", "a");
    handleEvent(store, "heartbeat", JSON.stringify({ targetId: "a", message: "Still waiting" }));
    pending.resolve({ prompts: [{ id: "still-pending", type: "permission_request", prompt: "Allow this?", targetId: "a" }] });
    await pending.promise;
    expect(store.getState().prompts.map(prompt => prompt.id)).toEqual(["still-pending"]);
    expect(store.getState().agent).toBe("needs-you");
  });

  it("restores only the selected session's running state", async () => {
    api.thread.mockResolvedValue({ messages: [] });
    api.get.mockImplementation((path: string) => Promise.resolve(path.endsWith("/queue") ? { state: "running" } : {}));
    await openThread("chat", "a");
    expect(store.getState().agent).toBe("working");
    await openThread("chat", null);
    expect(store.getState().agent).toBe("idle");
  });

  it("an old status response cannot revive a turn that already finished", async () => {
    const queue = deferred<{ state: string }>();
    api.thread.mockResolvedValue({ messages: [] });
    api.get.mockImplementation((path: string) => path.endsWith("/queue") ? queue.promise : Promise.resolve({}));
    await openThread("chat", "a");
    handleEvent(store, "text_done", JSON.stringify({ targetId: "a", text: "Done" }));
    queue.resolve({ state: "running" });
    await queue.promise;
    expect(store.getState().agent).toBe("idle");
  });

  it("held artifacts from one conversation do not attach to another's answer", async () => {
    store.setState({ agent: "working" });
    handleEvent(store, "artifacts", JSON.stringify({ targetId: "a", items: [{ id: "a-file", name: "A only" }] }));
    api.thread.mockResolvedValue({ messages: [] });
    await openThread("chat", "b");
    handleEvent(store, "text_done", JSON.stringify({ targetId: "b", text: "B answer" }));
    expect(store.getState().messages.at(-1)?.artifacts).toBeUndefined();
  });

  it("a new-chat creation finishing after navigation sends to its own session without overwriting the selection", async () => {
    const created = deferred<{ id: string }>();
    api.createThread.mockReturnValue(created.promise);
    store.getState().setActive(null);
    const send = sendMessage("chat", "A request");
    store.getState().setActive("b");
    store.getState().setMessages([message("B message")]);
    created.resolve({ id: "a" });
    await send;
    expect(api.send).toHaveBeenCalledWith("A request", "a", [], undefined);
    expect(store.getState()).toMatchObject({ activeId: "b", agent: "idle", messages: [message("B message")] });
  });
});
