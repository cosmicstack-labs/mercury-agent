import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSseParser, createEventStream } from "./sse";
import { configureApi } from "./connection";

/**
 * The hosted-client event stream: a fetch() with a Bearer header that
 * behaves like EventSource for the hooks that consume it.
 */

describe("sse parser", () => {
  it("splits frames on blank lines, joins multi-line data, keeps ids, skips comments", () => {
    const p = createSseParser();
    expect(p.push("event: text_delta\ndata: {\"a\":1}\n\n")).toEqual([
      { event: "text_delta", data: "{\"a\":1}", id: "" },
    ]);
    expect(p.push(": keepalive\n")).toEqual([]);
    // Chunk boundaries fall anywhere.
    expect(p.push("id: 7\ndata: one\nda")).toEqual([]);
    expect(p.push("ta: two\n\ndata: x\r\n\r\n")).toEqual([
      { event: "message", data: "one\ntwo", id: "7" },
      { event: "message", data: "x", id: "7" },
    ]);
  });
});

describe("bearer event stream", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    configureApi({ baseUrl: "https://mercury.example", token: "mdt_test", onUnauthorized: () => {} });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    configureApi({ baseUrl: "", token: null, onUnauthorized: null, onSignedOut: null });
  });

  it("sends the token, dispatches named events, and stops on close", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let pulled = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled === 1) controller.enqueue(encoder.encode("event: thinking\ndata: {}\n\nevent: text_delta\ndata: {\"text\":\"hi\"}\n\n"));
          // Then hang open like a real stream until aborted.
          if (pulled > 1) return new Promise<void>(() => {});
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const stream = createEventStream("/api/chat/events?sessionId=abc");
    const got: Array<{ type: string; data: string }> = [];
    const opened = new Promise<void>((resolve) => { stream.onopen = () => resolve(); });
    stream.addEventListener("thinking", (e) => got.push({ type: "thinking", data: e.data }));
    stream.addEventListener("text_delta", (e) => got.push({ type: "text_delta", data: e.data }));

    await opened;
    await vi.waitFor(() => expect(got).toHaveLength(2));
    expect(seenUrl).toBe("https://mercury.example/api/chat/events?sessionId=abc");
    expect(seenAuth).toBe("Bearer mdt_test");
    expect(got[1]).toEqual({ type: "text_delta", data: "{\"text\":\"hi\"}" });
    expect(stream.readyState).toBe(1);

    stream.close();
    expect(stream.readyState).toBe(2);
  });

  it("hands a 401 to the shell instead of retrying forever", async () => {
    const unauthorized = vi.fn();
    configureApi({ onUnauthorized: unauthorized });
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 401 })) as typeof fetch;
    const stream = createEventStream("/api/bots/events");
    const errored = new Promise<void>((resolve) => { stream.onerror = () => resolve(); });
    await errored;
    await vi.waitFor(() => expect(unauthorized).toHaveBeenCalledTimes(1));
    expect(stream.readyState).toBe(2);
  });
});
