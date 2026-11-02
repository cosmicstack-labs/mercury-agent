import { describe, expect, it, vi } from "vitest";
import type { StreamHandlers } from "~/api/stream";

/**
 * The microphone test: levels draw the meter (grey, green, orange), the
 * result arrives once, and a dropped connection never starts a second test.
 */

const streams: Array<{ path: string; handlers: StreamHandlers; closed: boolean }> = [];
vi.mock("~/api/stream", () => ({
  openStream: (path: string, handlers: StreamHandlers) => {
    const s = { path, handlers, closed: false };
    streams.push(s);
    return { close: () => { s.closed = true; handlers.onClose?.("closed"); }, get open() { return !s.closed; } };
  },
}));

const { testMicrophone } = await import("~/api/devices");
const { meterState, segmentTone } = await import("./Devices");

function run() {
  const seen = { levels: [] as number[], done: [] as unknown[], errors: [] as string[] };
  testMicrophone("optimus", 6, { level: (n) => seen.levels.push(n), done: (r) => seen.done.push(r), error: (m) => seen.errors.push(m) });
  return { seen, stream: streams[streams.length - 1] };
}

describe("microphone test", () => {
  it("asks the plugin's test route, passes levels on, and stops after the result", () => {
    const { seen, stream } = run();
    expect(stream.path).toBe("/api/devices/optimus/test?seconds=6");
    stream.handlers.onEvent("level", JSON.stringify({ level: 0.2 }));
    stream.handlers.onEvent("level", JSON.stringify({ level: 0.9 }));
    stream.handlers.onEvent("done", JSON.stringify({ heard: true, text: "works", steps: [] }));
    stream.handlers.onEvent("level", JSON.stringify({ level: 0.5 }));
    expect(seen.levels).toEqual([0.2, 0.9]);
    expect(seen.done).toHaveLength(1);
    expect(stream.closed).toBe(true);
    expect(seen.errors).toEqual([]);
  });

  it("shows the plugin's reason when it can't listen", () => {
    const { seen, stream } = run();
    stream.handlers.onEvent("error", JSON.stringify({ error: "macOS is blocking the microphone for Optimus." }));
    expect(seen.errors).toEqual(["macOS is blocking the microphone for Optimus."]);
    expect(stream.closed).toBe(true);
  });

  it("a dropped connection ends the test with a reason instead of reconnecting into a new one", () => {
    const { seen, stream } = run();
    stream.handlers.onClose?.("error");
    expect(seen.errors).toEqual(["Lost the connection to Mercury during the test."]);
    expect(stream.closed).toBe(true);
  });
});

describe("level meter", () => {
  it("reads idle, silent, speech and loud", () => {
    expect(meterState(0.5, false)).toBe("idle");
    expect(meterState(0, true)).toBe("silent");
    expect(meterState(Number.NaN, true)).toBe("silent");
    expect(meterState(0.3, true)).toBe("speech");
    expect(meterState(0.95, true)).toBe("loud");
  });

  it("lights green segments for speech and orange ones near the top", () => {
    expect(segmentTone(0, 0)).toBe("off");
    expect(segmentTone(0, 0.3)).toBe("ok");
    expect(segmentTone(10, 0.3)).toBe("off");
    expect(segmentTone(18, 1)).toBe("ok");
    expect(segmentTone(20, 1)).toBe("loud");
    expect(segmentTone(23, 2)).toBe("loud");
  });
});
