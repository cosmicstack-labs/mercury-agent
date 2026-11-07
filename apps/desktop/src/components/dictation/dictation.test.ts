import { describe, expect, it } from "vitest";
import { joinText } from "./Dictation";
import { formatClock, micErrorText, pickMimeType } from "./useDictation";

describe("dictation", () => {
  it("adds spoken words after what's typed, with one space", () => {
    expect(joinText("", "hello")).toBe("hello");
    expect(joinText("Remind me", "to call Heer")).toBe("Remind me to call Heer");
    expect(joinText("Line one\n", "line two")).toBe("Line one\nline two");
  });
  it("records in the best format the webview supports", () => {
    expect(pickMimeType((t) => t.startsWith("audio/mp4"))).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(pickMimeType((t) => t === "audio/webm;codecs=opus")).toBe("audio/webm;codecs=opus");
    expect(pickMimeType(() => false)).toBe("");
  });
  it("explains microphone failures in plain words", () => {
    expect(micErrorText(new DOMException("x", "NotAllowedError"))).toMatch(/Privacy & Security → Microphone/);
    expect(micErrorText(new DOMException("x", "NotFoundError"))).toMatch(/No microphone/);
  });
  it("shows the timer as m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(75)).toBe("1:15");
  });
});
