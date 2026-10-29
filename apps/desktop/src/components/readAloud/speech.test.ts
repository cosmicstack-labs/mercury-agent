import { describe, expect, it } from "vitest";
import { speakableText, speechParts } from "./speech";

describe("read aloud text", () => {
  it("reads prose, not markdown, code or link addresses", () => {
    const md = [
      "## Weather today",
      "",
      "It's **sunny** and *warm*. See [the forecast](https://example.com/f) or https://x.y/z.",
      "",
      "- Take water",
      "1. Leave at 9",
      "",
      "```bash",
      "curl wttr.in",
      "```",
      "",
      "Use `npm run dev` to start.",
    ].join("\n");
    const out = speakableText(md);
    expect(out).toContain("Weather today.");
    expect(out).toContain("It's sunny and warm. See the forecast or a link.");
    expect(out).toContain("Take water");
    expect(out).toContain("Leave at 9");
    expect(out).toContain("(code omitted)");
    expect(out).toContain("Use npm run dev to start.");
    expect(out).not.toMatch(/[#*`]|https?:|curl/);
  });

  it("reads a table row by row", () => {
    expect(speakableText("| City | Temp |\n|---|---|\n| Srinagar | 12 |")).toBe("City, Temp.\nSrinagar, 12.");
  });

  it("splits into parts at sentence boundaries, a short one first", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`);
    const parts = speechParts(sentences.join(" "), 100, 400);
    expect(parts[0].length).toBeLessThanOrEqual(100);
    expect(parts.every((p) => p.length <= 400)).toBe(true);
    expect(parts.join(" ")).toBe(sentences.join(" "));
    expect(parts.every((p) => p.endsWith("."))).toBe(true);
  });

  it("cuts a single huge sentence at word boundaries", () => {
    const long = Array.from({ length: 300 }, () => "word").join(" ");
    const parts = speechParts(long, 100, 400);
    expect(parts.every((p) => p.length <= 400 && !p.startsWith(" "))).toBe(true);
    expect(parts.join(" ")).toBe(long);
  });
});
