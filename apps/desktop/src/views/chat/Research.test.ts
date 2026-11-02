import { describe, expect, it, vi } from "vitest";

vi.mock("~/api/mercury", () => ({ chat: {} }));
const { elapsed, outcomeLine, researchCounts } = await import("./Research");
const { handleEvent, stepFailed } = await import("~/app/events");
const { conversations } = await import("~/app/conversation");

const snap = (over: Record<string, unknown> = {}) => ({
  runId: "r1", topic: "solar storms", state: "running", phase: "reading", questions: [], startedAt: 0, steps: 4, maxSteps: 225,
  searches: 2, failedSearches: 0, read: 3, failed: 1, cited: 0, sourceList: [], searchList: [], ...over,
});

describe("research on the desktop", () => {
  it("counts and endings read plainly", () => {
    expect(researchCounts({ read: 1, failed: 0, searches: 1, cited: 0 })).toBe("1 source read · 1 search");
    expect(researchCounts({ read: 31, failed: 3, searches: 12, cited: 20 }, { cited: true })).toBe("31 sources read · 20 cited · 3 couldn't be read · 12 searches");
    expect(elapsed(372_000)).toBe("6:12");
    expect(outcomeLine(snap({ state: "partial", cut: "you asked it to finish now" }) as never).title).toBe("Partial report: stopped early because you asked it to finish now");
    expect(outcomeLine(snap({ state: "done" }) as never).tone).toBe("ok");
  });

  it("an HTTP 403 or a timeout is a failed step, not a green check", () => {
    expect(stepFailed({ failed: true }, "anything")).toBe(true);
    expect(stepFailed({ failed: false }, "Error: looks like one")).toBe(false);
    // Older runtimes don't say; the text decides.
    expect(stepFailed({}, "HTTP 403 Forbidden for https://x.com")).toBe(true);
    expect(stepFailed({}, "Request to https://x.com timed out after 30 seconds.")).toBe(true);
    expect(stepFailed({}, "# A page")).toBe(false);
  });

  it("follows a run, and puts the finished run's card on its answer", () => {
    const store = conversations.chat;
    store.setState({ activeId: "t1", messages: [{ id: "u", role: "user", content: "q", timestamp: "" }], research: null, agent: "working" });
    handleEvent(store, "research", JSON.stringify({ state: "armed", planFirst: true, topic: "solar storms" }));
    expect(store.getState().research).toMatchObject({ armed: true, planFirst: true });
    handleEvent(store, "research", JSON.stringify(snap()));
    expect(store.getState().research).toMatchObject({ armed: false, run: { runId: "r1", state: "running" } });
    handleEvent(store, "text_done", JSON.stringify({ fullText: "# Solar storms\n\nReport" }));
    handleEvent(store, "research", JSON.stringify(snap({ state: "done", cited: 2 })));
    const last = store.getState().messages[store.getState().messages.length - 1];
    expect(last.research).toMatchObject({ runId: "r1", state: "done", cited: 2 });
  });

  it("a stall notice is a note, not the answer", () => {
    const store = conversations.chat;
    store.setState({ activeId: "t1", messages: [], notice: null });
    handleEvent(store, "notice", JSON.stringify({ message: "Mercury detected a stalled provider", level: "warning" }));
    expect(store.getState().notice).toMatchObject({ level: "warning" });
    expect(store.getState().messages).toHaveLength(0);
    handleEvent(store, "text_done", JSON.stringify({ fullText: "done" }));
    expect(store.getState().notice).toBeNull();
  });

  it("a research plan waits for an answer and goes when it's resolved", () => {
    const store = conversations.chat;
    store.setState({ activeId: "t1", researchPlan: null });
    handleEvent(store, "research_plan", JSON.stringify({ id: "rplan_1", runId: "r1", topic: "t", questions: ["a?", "b?"], expiresAt: 1 }));
    expect(store.getState().researchPlan?.questions).toEqual(["a?", "b?"]);
    handleEvent(store, "research_plan_resolved", JSON.stringify({ id: "rplan_1", action: "start" }));
    expect(store.getState().researchPlan).toBeNull();
  });
});
