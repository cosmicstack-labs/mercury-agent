import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A chat waiting behind another chat's turn shows "Waiting" (with what's
 * ahead), not "Thinking" — until its own turn starts.
 */
vi.mock("~/api/mercury", () => ({ chat: {} }));

const { conversations } = await import("./conversation");
const { handleEvent } = await import("./events");
const store = conversations.chat;

describe("waiting for another chat", () => {
  beforeEach(() => store.setState({ activeId: "jokes", waiting: null, agent: "idle", messages: [], streaming: "", live: null }));

  it("a queued event shows where it stands and what's ahead", () => {
    handleEvent(store, "queued", JSON.stringify({ targetId: "jokes", position: 2, busyWith: "Research the top news", busySessionId: "research" }));
    expect(store.getState().waiting).toEqual({ position: 2, busyWith: "Research the top news", busySessionId: "research" });
    expect(store.getState().agent).toBe("thinking");
  });

  it("clears as soon as its own turn starts", () => {
    handleEvent(store, "queued", JSON.stringify({ position: 1 }));
    handleEvent(store, "thinking", JSON.stringify({}));
    expect(store.getState().waiting).toBeNull();
    handleEvent(store, "queued", JSON.stringify({ position: 1 }));
    handleEvent(store, "text_delta", JSON.stringify({ text: "Why did" }));
    expect(store.getState().waiting).toBeNull();
  });
});
