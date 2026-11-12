import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mercury Desktop and the runtime's newer work (ADR-037/038, #296): a dropped
 * waiting message clears "Waiting", replies carry what they cost, running
 * chats map to their threads, and today's split reads plainly.
 */
vi.mock("~/api/mercury", () => ({ chat: {} }));

const { conversations } = await import("./conversation");
const { handleEvent, replyUsage } = await import("./events");
const { turnStates } = await import("./pulse");
const { usageLabel } = await import("~/views/chat/Message");
const { splitLine } = await import("~/views/settings/Budgets");
const store = conversations.chat;

describe("a stop drops this chat's waiting message", () => {
  beforeEach(() => store.setState({ activeId: "a", waiting: null, agent: "idle", messages: [], streaming: "", live: null, stopping: false, notice: null }));

  it("clears Waiting, goes idle and says it wasn't sent", () => {
    handleEvent(store, "queued", JSON.stringify({ position: 1 }));
    expect(store.getState().agent).toBe("thinking");
    handleEvent(store, "queue_dropped", JSON.stringify({ targetId: "a", dropped: 1 }));
    expect(store.getState().waiting).toBeNull();
    expect(store.getState().agent).toBe("idle");
    expect(store.getState().notice?.message).toMatch(/wasn't sent/);
  });

  it("finishes a stop that was waiting for the runtime", () => {
    store.setState({ stopping: true, agent: "thinking" });
    handleEvent(store, "queue_dropped", JSON.stringify({ targetId: "a", dropped: 2 }));
    expect(store.getState().stopping).toBe(false);
  });
});

describe("what a reply cost", () => {
  beforeEach(() => store.setState({ activeId: "a", messages: [], streaming: "", live: null, stopping: false }));

  it("the final event's usage lands on the reply", () => {
    handleEvent(store, "text_done", JSON.stringify({ fullText: "Done.", usage: { inputTokens: 14000, cachedInputTokens: 11480, outputTokens: 420, steps: 6, elapsedMs: 12400, provider: "anthropic", model: "claude-x" } }));
    const reply = store.getState().messages.at(-1)!;
    expect(reply.usage).toEqual({ inputTokens: 14000, cachedInputTokens: 11480, outputTokens: 420, steps: 6, elapsedMs: 12400, provider: "anthropic", model: "claude-x" });
    expect(usageLabel(reply.usage!).short).toBe("14K tokens · 82% cached · 6 steps · 12s");
    expect(usageLabel(reply.usage!).detail).toContain("anthropic · claude-x");
  });

  it("an older runtime's reply has no usage, and bad input is ignored", () => {
    handleEvent(store, "text_done", JSON.stringify({ fullText: "Hi" }));
    expect(store.getState().messages.at(-1)!.usage).toBeUndefined();
    expect(replyUsage({ inputTokens: "x", outputTokens: 1 })).toBeUndefined();
    expect(usageLabel({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 }).short).toBe("120 tokens");
  });
});

describe("running chats and today's split", () => {
  it("maps running and waiting chats to thread ids (desktop chats are web sessions)", () => {
    const states = turnStates({
      limit: 4, configured: 0, auto: 4,
      running: [{ sessionId: "s1", channelType: "web", channelId: "s1", startedAt: 1, activity: "", steps: 0 }, { channelType: "telegram", channelId: "123", startedAt: 1, activity: "", steps: 0 }],
      waiting: [{ channelType: "web", channelId: "s2", waiting: 1, position: 1 }],
    });
    expect([...states.running]).toEqual(["s1"]);
    expect([...states.queued]).toEqual(["s2"]);
    expect(turnStates(null).running.size).toBe(0);
  });

  it("reads today's split plainly, and says nothing before anything ran", () => {
    expect(splitLine({ inputTokens: 122_000, cachedInputTokens: 101_000, noCacheInputTokens: 21_000, outputTokens: 4_400 })).toMatch(/^122K in \(101K from cache · 83%\) · 21K new · 4\.4K out$/);
    expect(splitLine({ inputTokens: 0, cachedInputTokens: 0, noCacheInputTokens: 0, outputTokens: 0 })).toBeNull();
    expect(splitLine(undefined)).toBeNull();
  });
});
