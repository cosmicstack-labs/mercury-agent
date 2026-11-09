import { describe, expect, it } from "vitest";
import { acceptsSessionEvent } from "./chat-session";

describe("chat event session boundary", () => {
  it("matches current and legacy session fields", () => {
    expect(acceptsSessionEvent("a", { sessionId: "a" })).toBe(true);
    expect(acceptsSessionEvent("a", { targetId: "a" })).toBe(true);
    expect(acceptsSessionEvent("b", { sessionId: "a" })).toBe(false);
    expect(acceptsSessionEvent("b", { targetId: "a" })).toBe(false);
  });
  it("a new conversation does not consume unscoped or old session activity", () => {
    expect(acceptsSessionEvent(null, {})).toBe(false);
    expect(acceptsSessionEvent(null, { sessionId: "a" })).toBe(false);
    expect(acceptsSessionEvent("a", {})).toBe(false);
    expect(acceptsSessionEvent("a", "unscoped error")).toBe(false);
  });
  it("allows global provider status but rejects a different explicit target", () => {
    expect(acceptsSessionEvent(null, { provider: "Global" }, true)).toBe(true);
    expect(acceptsSessionEvent("a", { provider: "Global" }, true)).toBe(true);
    expect(acceptsSessionEvent("a", { targetId: "b", provider: "Other" }, true)).toBe(false);
  });

});
