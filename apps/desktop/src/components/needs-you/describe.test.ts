import { describe, expect, it } from "vitest";
import { describePrompt } from "./describe";

const perm = (text: string) => describePrompt({ kind: "permission", text });

describe("a question, in words", () => {
  it("commands, files, folders, MCP and pages", () => {
    expect(perm("Run command: npm install @scope/pkg")).toEqual({ title: "Run a command", code: "npm install @scope/pkg" });
    expect(perm("Run command (changes Mercury's MCP servers or config, so it always asks): mercury mcp add x")).toMatchObject({ title: "Run a command", code: "mercury mcp add x", note: "Changes Mercury's MCP servers or config, so it always asks" });
    expect(perm("Write to file: /Users/me/a.txt")).toEqual({ title: "Write a file", code: "/Users/me/a.txt" });
    expect(perm("Mercury needs write access to:\n/Users/me/proj\n\nAllow access?")).toMatchObject({ title: "Allow write access", code: "/Users/me/proj" });
    expect(perm('MCP tool call\nServer: github\nTool:   create_issue\nArguments:\n{\n  "title": "x"\n}')).toMatchObject({ title: "Use create_issue", note: "github (MCP server)", code: '{\n  "title": "x"\n}' });
  });

  it("the prompt-injection approval: what it read, what it wants, and the warning", () => {
    const text = [
      "⚠ Possible prompt injection. Mercury read content that contains instructions written to an AI:",
      "- /Users/me/Downloads/weather.html (read_file) — contains instructions to an AI: \"create a schedule\"",
      "- https://news.example/today (fetch_url)",
      "",
      "It now wants to run schedule_task with:",
      '{\n  "cron": "0 9 * * *"\n}',
      "",
      "Approve only if YOU asked for this.",
    ].join("\n");
    const d = perm(text);
    expect(d.title).toBe("Suspicious request: schedule a task");
    expect(d.code).toBe('{\n  "cron": "0 9 * * *"\n}');
    expect(d.note).toContain("weather.html");
    expect(d.warning).toContain("instructions written to an AI");
  });

  it("unknown shapes and questions are shown as they came", () => {
    expect(perm("Something new?")).toEqual({ title: "Allow this?", body: "Something new?" });
    expect(describePrompt({ kind: "continue", text: "25 steps so far. Continue?" })).toEqual({ title: "Keep going?", body: "25 steps so far. Continue?" });
  });
});
