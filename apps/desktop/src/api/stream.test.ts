import { describe, expect, it } from "vitest";
import { createSseParser } from "./stream";

describe("sse parser", () => {
  it("splits frames on blank lines, joins multi-line data, keeps ids, skips comments", () => {
    const p = createSseParser();
    expect(p.push("event: text_delta\ndata: {\"a\":1}\n\n")).toEqual([{ event: "text_delta", data: "{\"a\":1}", id: "" }]);
    expect(p.push(": keepalive\n")).toEqual([]);
    expect(p.push("id: 7\ndata: one\nda")).toEqual([]);
    expect(p.push("ta: two\n\ndata: x\r\n\r\n")).toEqual([
      { event: "message", data: "one\ntwo", id: "7" },
      { event: "message", data: "x", id: "7" },
    ]);
  });
});
