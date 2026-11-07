import { describe, expect, it } from "vitest";
import { parseToolActivity } from "./Message";

describe("tool activity", () => {
  it("turns the runtime's stored tool summary into rows", () => {
    const rows = parseToolActivity("[Tool activity in my previous turn]\n- use_skill name=web-search → ok (42 lines)\n- web_search query=weather in Kashmir → ok (22 lines)\n- fetch_url url=https://x.example → error: timeout");
    expect(rows).toEqual([
      { tool: "use_skill", args: "name=web-search", status: "done", detail: "(42 lines)" },
      { tool: "web_search", args: "query=weather in Kashmir", status: "done", detail: "(22 lines)" },
      { tool: "fetch_url", args: "url=https://x.example", status: "error", detail: "error: timeout" },
    ]);
  });
});
