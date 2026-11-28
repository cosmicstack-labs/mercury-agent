import { describe, expect, it } from "vitest";
import { isPlayable } from "./ArtifactCard";
import { canOpenOutside, isWebPage } from "./ArtifactViewer";

describe("how an artifact is shown", () => {
  it("shows every picture, clip and sound large, generated or downloaded", () => {
    for (const kind of ["image", "video", "audio"] as const) expect(isPlayable({ kind })).toBe(true);
    for (const kind of ["pdf", "document", "text", "file"] as const) expect(isPlayable({ kind })).toBe(false);
  });

  it("knows a web page by its type or its name", () => {
    expect(isWebPage({ name: "page.bin", mime: "text/html" })).toBe(true);
    expect(isWebPage({ name: "Report.HTM", mime: "application/octet-stream" })).toBe(true);
    expect(isWebPage({ name: "notes.md", mime: "text/markdown" })).toBe(false);
  });

  it("never opens something that would run", () => {
    expect(canOpenOutside({ name: "budget.xlsx" })).toBe(true);
    expect(canOpenOutside({ name: "slides.key" })).toBe(true);
    for (const name of ["setup.pkg", "Tool.app", "run.sh", "x.command", "a.exe", "s.py"]) expect(canOpenOutside({ name })).toBe(false);
  });
});
