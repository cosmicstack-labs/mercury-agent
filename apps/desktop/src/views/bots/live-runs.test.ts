import { describe, expect, it } from "vitest";
import type { BotActivityEvent } from "~/api/types";
import { mergeLive } from "~/app/store";
import { runsFrom, startedBy } from "./live-runs";

const ev = (e: Partial<BotActivityEvent> & Pick<BotActivityEvent, "kind" | "label">, at: number): BotActivityEvent => ({ botId: "w", jobId: "j1", botName: "Writer", ...e, at });

describe("live runs", () => {
  it("a run from your message to its end: queued, steps that finish in place, the reply, done", () => {
    const runs = runsFrom([
      ev({ kind: "queued", label: "Starting", trigger: "api", prompt: "Draft the post" }, 1),
      ev({ kind: "turn-start", label: "Draft the post", trigger: "api", prompt: "Draft the post" }, 2),
      ev({ kind: "step", label: "step 1", stepIndex: 1 }, 3),
      ev({ kind: "tool", label: "read_file notes.md", status: "running" }, 4),
      ev({ kind: "tool", label: "read_file notes.md", status: "done" }, 5),
      ev({ kind: "tool", label: "web_search ai agents", status: "running" }, 6),
      ev({ kind: "thinking", label: "thinking", textTail: "Here is the draft" }, 7),
      ev({ kind: "turn-end", label: "completed", status: "done" }, 8),
    ]);
    expect(runs).toHaveLength(1);
    const r = runs[0];
    expect(r.state).toBe("done");
    expect(r.prompt).toBe("Draft the post");
    expect(r.steps.map((s) => `${s.label}:${s.status}`)).toEqual(["read_file notes.md:done", "web_search ai agents:done"]);
    expect(r.stepCount).toBe(1);
    expect(r.text).toBe("Here is the draft");
    expect(startedBy(r, () => undefined)).toBe("You");
  });

  it("waiting for you only when a question for this run is pending", () => {
    const events = [ev({ kind: "turn-start", label: "x" }, 1), ev({ kind: "step", label: "Waiting for your approval" }, 2)];
    expect(runsFrom(events)[0].state).toBe("working");
    const approval = { id: "a", botId: "w", botName: "Writer", runId: "j1", prompt: "Run command: ls", at: 2, expiresAt: 9 };
    expect(runsFrom(events, { approvals: [approval] })[0].state).toBe("waiting");
    expect(runsFrom(events, { approvals: [{ ...approval, runId: "other" }] })[0].state).toBe("working");
  });

  it("a run whose bot stopped without an ending event is ended, not working forever", () => {
    const events = [ev({ kind: "turn-start", label: "x" }, 1_000)];
    expect(runsFrom(events, { running: new Set(), now: 200_000 })[0].state).toBe("ended");
    expect(runsFrom(events, { running: new Set(["w"]), now: 200_000 })[0].state).toBe("working");
  });

  it("failures, stops and pauses read as such; a delivery joins the bot's run", () => {
    expect(runsFrom([ev({ kind: "turn-start", label: "x" }, 1), ev({ kind: "turn-end", label: "failed: provider_timeout", status: "error" }, 2)])[0].state).toBe("failed");
    expect(runsFrom([ev({ kind: "turn-start", label: "x" }, 1), ev({ kind: "turn-end", label: "stopped — by you", status: "error" }, 2)])[0].state).toBe("stopped");
    const r = runsFrom([ev({ kind: "turn-start", label: "x" }, 1), { botId: "w", jobId: "", kind: "tool", label: "Delivered post.md", status: "done", at: 2 }]);
    expect(r).toHaveLength(1);
    expect(r[0].steps[0].label).toBe("Delivered post.md");
  });

  it("the store drops duplicates and keeps one thinking preview per run", () => {
    const a = ev({ kind: "tool", label: "ls", status: "done" }, 5);
    const t1 = ev({ kind: "thinking", label: "thinking", textTail: "Hel" }, 6);
    const t2 = ev({ kind: "thinking", label: "thinking", textTail: "Hello" }, 7);
    const merged = mergeLive(mergeLive([a], [a, t1]), [t2, a]);
    expect(merged.map((e) => e.textTail ?? e.label)).toEqual(["ls", "Hello"]);
  });
});
