import type { PendingPrompt } from "~/api/types";

/* ═══════════════════════════════════════════════════════════════
   A question from the runtime, in words: a short title, the exact
   thing it would run or touch (shown as one code line), and any note
   or warning. The runtime sends plain text in a handful of shapes;
   anything unrecognised is shown as it came.
   ═══════════════════════════════════════════════════════════════ */

export interface Described {
  title: string;
  /** The command, path, URL or arguments, verbatim. */
  code?: string;
  /** Context in a quiet line ("Read: weather.html, notes.txt"). */
  note?: string;
  /** Something to look at twice (data leaving, hidden instructions). */
  warning?: string;
  /** Free text when the prompt isn't one of the known shapes (a question, a pick). */
  body?: string;
}

export function describePrompt(p: Pick<PendingPrompt, "kind" | "text">): Described {
  const text = p.text.trim();
  if (p.kind === "continue") return { title: "Keep going?", body: text };
  if (p.kind === "choice") return { title: "Your pick", body: text };

  let m = /^Run command(?: \(([^)]*)\))?:\s*([\s\S]+)$/.exec(text);
  if (m) return { title: "Run a command", code: m[2].trim(), ...(m[1] ? { note: cap(m[1]) } : {}) };

  m = /^(Write to file|Read file):\s*(.+)$/.exec(text);
  if (m) return { title: m[1] === "Read file" ? "Read a file" : "Write a file", code: m[2].trim() };

  m = /^Mercury needs (read|write) access to:\s*\n(.+?)\n/s.exec(text);
  if (m) return { title: `Allow ${m[1]} access`, code: m[2].trim(), note: m[1] === "write" ? "Mercury may create and change files there." : "Mercury may read files there." };

  m = /^MCP tool call\nServer:\s*(.+)\nTool:\s*(.+)\nArguments:\n([\s\S]*)$/.exec(text);
  if (m) return { title: `Use ${m[2].trim()}`, note: `${m[1].trim()} (MCP server)`, code: m[3].trim() || undefined };

  if (/^⚠ Possible prompt injection|^Mercury read content from outside this chat/.test(text)) {
    const injection = text.startsWith("⚠");
    const wants = /It now wants to run (\S+) with:\n([\s\S]*?)(?:\n\n|$)/.exec(text);
    const sources = [...text.matchAll(/^- (.+?)(?: — contains instructions to an AI: .*)?$/gm)].map((x) => x[1].replace(/\s*\((\w+)\)$/, "")).filter((s) => !s.startsWith("…"));
    const leak = /⚠ This could send data out: (.+?)\.?$/m.exec(text);
    return {
      title: wants ? `${injection ? "Suspicious request" : "After reading outside content"}: ${toolWords(wants[1])}` : "After reading outside content",
      ...(wants ? { code: wants[2].trim() } : {}),
      note: sources.length ? `It read: ${sources.slice(0, 3).map(shortSource).join(", ")}${sources.length > 3 ? ` and ${sources.length - 3} more` : ""}. Approve only if you asked for this.` : "Approve only if you asked for this.",
      ...(injection ? { warning: "What it read contains instructions written to an AI." } : {}),
      ...(leak ? { warning: `${injection ? "Hidden instructions, and this " : "This "}could send data out: ${leak[1]}.` } : {}),
    };
  }

  m = /^Open (\S+) in this chat.s isolated read-only browser\?\s*([\s\S]*)$/.exec(text);
  if (m) return { title: "Open a page", code: m[1], note: cap(m[2].trim()) || undefined };

  return { title: "Allow this?", body: text };
}

/** "run_command" → "run a command"; other tool names as they are, spaced. */
function toolWords(name: string): string {
  const words: Record<string, string> = {
    run_command: "run a command", write_file: "write a file", edit_file: "edit a file", create_file: "create a file", delete_file: "delete a file",
    fetch_url: "open a web address", web_search: "search the web", schedule_task: "schedule a task", send_message: "send a message", send_file: "send a file",
    save_memory: "save to memory", git_push: "push to git", create_pr: "open a pull request", create_issue: "open an issue", delegate_task: "hand off a task",
  };
  return words[name] ?? name.replace(/_/g, " ");
}

function shortSource(s: string): string {
  const t = s.replace(/^https?:\/\//, "");
  const path = t.split("/");
  return path.length > 2 && !/^[\w.-]+\.\w+$/.test(path[0]) ? path[path.length - 1] : t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
