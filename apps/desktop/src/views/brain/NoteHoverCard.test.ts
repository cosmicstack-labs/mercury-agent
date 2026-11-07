import { describe, expect, it } from "vitest";
import { shortLabel } from "./NoteHoverCard";

describe("note labels on the graph", () => {
  it("leaves short notes alone and drops the full stop", () => {
    expect(shortLabel("Married to Heer.")).toBe("Married to Heer");
  });
  it("ends at the first clause when it's short enough", () => {
    expect(shortLabel("Lives in Srinagar, works on Mercury at Cosmic Stack every evening")).toBe("Lives in Srinagar…");
  });
  it("otherwise cuts at a whole word, never mid-word", () => {
    const out = shortLabel("Prefers Mercury to communicate in Urdu and not switch languages without asking");
    expect(out).toBe("Prefers Mercury to communicate…");
    expect(out.length).toBeLessThanOrEqual(32);
  });
  it("cuts one very long word hard", () => {
    expect(shortLabel("a".repeat(60))).toHaveLength(32);
  });
  it("doesn't end on dangling punctuation", () => {
    expect(shortLabel("Uses Tauri for the desktop app (Rust shell) — React UI and more after that")).toBe("Uses Tauri for the desktop app…");
  });
});
