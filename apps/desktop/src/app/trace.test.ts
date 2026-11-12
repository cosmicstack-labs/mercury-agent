import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A running turn reads top to bottom in the order it happened, and the
 * status never blinks back to "Thinking" while tools run or text streams.
 */
vi.mock("~/api/mercury", () => ({ chat: {} }));

const { conversations } = await import("./conversation");
const { handleEvent } = await import("./events");
const { formatDuration, fromStored, normalizeMessages } = await import("./trace");
const { blocksOf } = await import("~/components/TurnTimeline");
const { traceSummary } = await import("~/components/ThoughtProcess");
const store = conversations.chat;
const ev = (type: string, data: Record<string, unknown> = {}) => handleEvent(store, type, JSON.stringify(data));

describe("a running turn as a timeline", () => {
  beforeEach(() => store.setState({ activeId: "a", waiting: null, agent: "thinking", messages: [], streaming: "", live: null, stopping: false, notice: null, prompts: [] }));

  it("keeps thinking, tools, text and notes in order, pairing tools by call id", () => {
    ev("reasoning", { text: "Plan the change." });
    ev("step_start", { id: "c1", tool: "read_file", title: "Reading a.ts", label: "read_file(path=a.ts)", step: 1 });
    ev("step_start", { id: "c2", tool: "read_file", title: "Reading b.ts", label: "read_file(path=b.ts)", step: 2 });
    // Out of order: the second finishes first. Ids pair them, not tool names.
    ev("step_done", { id: "c2", tool: "read_file", summary: "12 lines", failed: false, durationMs: 40 });
    ev("step_done", { id: "c1", tool: "read_file", summary: "HTTP 403", failed: true, reason: "Forbidden", durationMs: 900 });
    ev("text_delta", { text: "Here is " });
    ev("progress", { text: "Checking my work…" });
    ev("text_delta", { text: "the fix." });

    const live = store.getState().live!;
    expect(blocksOf(live).map((b) => b.kind)).toEqual(["reasoning", "steps", "text", "note", "text"]);
    const [a, b] = live.steps;
    expect(a).toMatchObject({ key: "c1", status: "error", summary: "Forbidden", durationMs: 900 });
    expect(b).toMatchObject({ key: "c2", status: "done", durationMs: 40 });
  });

  it("a progress note never ends the turn", () => {
    ev("progress", { text: "Alright — getting started…" });
    expect(store.getState().messages).toHaveLength(0);
    expect(store.getState().agent).toBe("thinking");
  });

  it("the periodic thinking signal doesn't flip Working or Answering back to Thinking", () => {
    ev("step_start", { id: "c1", tool: "run_command", title: "Running npm test" });
    expect(store.getState().agent).toBe("working");
    ev("thinking");
    expect(store.getState().agent).toBe("working");
    ev("text_delta", { text: "ok" });
    ev("thinking");
    expect(store.getState().agent).toBe("streaming");
  });

  it("a late thinking signal right after the reply doesn't start a phantom turn", () => {
    ev("text_delta", { text: "Done." });
    ev("text_done", { fullText: "Done." });
    ev("thinking");
    expect(store.getState().agent).toBe("idle");
    expect(store.getState().live).toBeNull();
  });

  it("the finished reply keeps the process without the streamed text", () => {
    ev("reasoning", { text: "Hmm." });
    ev("step_start", { id: "c1", tool: "web_search", title: "Searching x" });
    ev("step_done", { id: "c1", tool: "web_search", summary: "5 results", failed: false, durationMs: 1200 });
    ev("text_delta", { text: "Answer" });
    ev("text_done", { fullText: "Answer" });
    const msg = store.getState().messages.at(-1)!;
    expect(msg.content).toBe("Answer");
    expect(msg.trace?.items?.map((i) => i.kind)).toEqual(["reasoning", "step"]);
    expect(traceSummary(msg.trace!)).toMatch(/^Worked for .* · 1 step$/);
  });

  it("older runtimes (no call id): the latest running step of that tool finishes", () => {
    ev("step_start", { tool: "read_file", label: "read_file" });
    ev("step_done", { tool: "read_file", summary: "ok" });
    expect(store.getState().live?.steps[0].status).toBe("done");
  });

  it("phases show what happens between tools", () => {
    ev("phase", { phase: "Calling anthropic", detail: "claude-opus-5-5" });
    expect(store.getState().live?.phase).toBe("Calling anthropic · claude-opus-5-5");
  });
});

describe("history", () => {
  const stored = {
    startedAt: 1000, endedAt: 9000,
    items: [
      { kind: "reasoning", text: "Think.", startedAt: 1000, endedAt: 2000 },
      { kind: "tool", id: "c1", title: "Running npm test", status: "done", startedAt: 2000, durationMs: 5000, summary: "passed" },
    ],
  };

  it("a stored trace becomes the screen's shape", () => {
    const t = fromStored(stored)!;
    expect(t.reasoning).toBe("Think.");
    expect(t.steps[0]).toMatchObject({ key: "c1", title: "Running npm test", status: "done", durationMs: 5000 });
    expect(t.items?.map((i) => i.kind)).toEqual(["reasoning", "step"]);
  });

  it("drops the separate tools row where the reply carries its own trace", () => {
    const msgs = normalizeMessages([
      { id: "u", role: "user", content: "go", timestamp: "" },
      { id: "t", role: "assistant", kind: "tool-call", content: "[Tool activity]\n- run_command → ok", timestamp: "" },
      { id: "r", role: "assistant", content: "Done", timestamp: "", trace: stored } as never,
    ]);
    expect(msgs.map((m) => m.id)).toEqual(["u", "r"]);
    expect(msgs[1].trace?.steps).toHaveLength(1);
  });

  it("keeps the tools row for replies saved before traces were kept", () => {
    const msgs = normalizeMessages([
      { id: "t", role: "assistant", kind: "tool-call", content: "[Tool activity]\n- x → ok", timestamp: "" },
      { id: "r", role: "assistant", content: "Done", timestamp: "" },
    ]);
    expect(msgs).toHaveLength(2);
  });
});

it("durations read plainly", () => {
  expect(formatDuration(400)).toBe("0.4s");
  expect(formatDuration(12_000)).toBe("12s");
  expect(formatDuration(65_000)).toBe("1m 05s");
});
