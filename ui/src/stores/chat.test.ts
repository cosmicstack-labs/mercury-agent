import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./chat";

afterEach(() => vi.unstubAllGlobals());
describe("switching web chat", () => {
  it("leaves the new session ready to send while the old one is thinking or streaming", () => {
    vi.stubGlobal("localStorage", { setItem: vi.fn(), removeItem: vi.fn() });
    useChatStore.setState({ activeThreadId: "a", waiting: true, isStreaming: true, streamingText: "A partial", totalSteps: 4, completedSteps: 2, currentStepTool: "run_command", messages: [{ id: "a1", role: "user", content: "A", timestamp: "2026-11-06T00:00:00Z" }] });
    useChatStore.getState().setActiveThread("b");
    expect(useChatStore.getState()).toMatchObject({ activeThreadId: "b", waiting: false, isStreaming: false, streamingText: "", totalSteps: 0, completedSteps: 0, currentStepTool: "", messages: [] });
  });
});
