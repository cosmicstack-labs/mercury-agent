import { describe, expect, it } from "vitest";
import { ackHolds, compareVersions, messagesFor, requiredBy, snoozed, timeLeft, urgencyOf, versionMatches } from "./logic";
import { buttonOf, forceOf, itemsOf, updatableOf, type Snapshot } from "./selectors";
import type { Connection } from "~/shell/connections";
import type { ServerUpdates, UpdateManifest } from "./types";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-03T12:00:00Z");

describe("version order", () => {
  it("numbers, not strings", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.4.2", "1.4.2")).toBe(0);
    expect(compareVersions("v1.4.2", "1.4.3")).toBe(-1);
  });
  it("a pre-release comes before its release", () => {
    expect(compareVersions("1.5.0-dev.20261103.abc", "1.5.0")).toBe(-1);
    expect(compareVersions("1.5.0-beta.2", "1.5.0-beta.10")).toBe(-1);
  });
  it("ranges: every comparator must hold", () => {
    expect(versionMatches("<1.5.0", "1.4.9")).toBe(true);
    expect(versionMatches(">=1.2.0 <1.4.3", "1.4.3")).toBe(false);
    expect(versionMatches("=1.4.1", "1.4.1")).toBe(true);
    expect(versionMatches("", "9.9.9")).toBe(true);
  });
});

describe("how loud the Update button is (Chrome-style)", () => {
  it("rises with age", () => {
    expect(urgencyOf(NOW - 1 * DAY, NOW)).toBe("low");
    expect(urgencyOf(NOW - 2 * DAY, NOW)).toBe("elevated");
    expect(urgencyOf(NOW - 5 * DAY, NOW)).toBe("high");
    expect(urgencyOf(NOW - 8 * DAY, NOW)).toBe("critical");
  });
  it("a security fix or a required update starts red", () => {
    expect(urgencyOf(NOW, NOW, { security: true })).toBe("critical");
    expect(urgencyOf(NOW, NOW, { required: true })).toBe("critical");
  });
});

describe("force updates", () => {
  const min = { version: "1.4.2", severity: "security" as const, reason: "Fixes a leak" };
  it("only a verified manifest can require an update", () => {
    expect(requiredBy("1.4.1", min, true)).toEqual(min);
    expect(requiredBy("1.4.1", min, false)).toBeNull();
    expect(requiredBy("1.4.2", min, true)).toBeNull();
    expect(requiredBy("", min, true)).toBeNull();
  });
  it("'continue anyway' ends with the app, or after 24 hours", () => {
    const ack = { key: "k", at: NOW, launchId: "a" };
    expect(ackHolds(ack, "k", "a", NOW + 23 * 3_600_000)).toBe(true);
    expect(ackHolds(ack, "k", "a", NOW + 25 * 3_600_000)).toBe(false);
    expect(ackHolds(ack, "k", "b", NOW)).toBe(false); // restarted
    expect(ackHolds(ack, "other", "a", NOW)).toBe(false); // a newer minimum
  });
  it("'Later' is for a day", () => {
    expect(snoozed(NOW + 1000, NOW)).toBe(true);
    expect(snoozed(NOW - 1000, NOW)).toBe(false);
    expect(snoozed(undefined, NOW)).toBe(false);
  });
});

describe("manifest messages", () => {
  const manifest: UpdateManifest = {
    schema: 1,
    issuedAt: "2026-11-03T00:00:00Z",
    messages: [
      { id: "a", title: "For everyone", apps: ["desktop", "server"] },
      { id: "b", title: "Servers only", apps: ["server"] },
      { id: "c", title: "Old desktops", apps: ["desktop"], versions: "<0.2.0" },
      { id: "d", title: "Not yet", apps: ["desktop"], startsAt: "2026-12-01T00:00:00Z" },
      { id: "e", title: "Over", apps: ["desktop"], endsAt: "2026-11-01T00:00:00Z" },
      { id: "f", title: "Critical", apps: ["desktop"], level: "critical", dismissible: false },
    ],
  };
  it("right app, version and dates", () => {
    expect(messagesFor(manifest, true, "desktop", "0.1.0", NOW).map((m) => m.id)).toEqual(["a", "c", "f"]);
    expect(messagesFor(manifest, true, "desktop", "0.2.0", NOW).map((m) => m.id)).toEqual(["a", "f"]);
    expect(messagesFor(manifest, true, "server", "1.4.2", NOW).map((m) => m.id)).toEqual(["a", "b"]);
  });
  it("an unverified manifest says nothing", () => {
    expect(messagesFor(manifest, false, "desktop", "0.1.0", NOW)).toEqual([]);
  });
  it("dismissed ones stay gone, except a critical one that can't be dismissed", () => {
    expect(messagesFor(manifest, true, "desktop", "0.1.0", NOW, { a: NOW, f: NOW }).map((m) => m.id)).toEqual(["c", "f"]);
  });
});

it("time left", () => {
  expect(timeLeft(50, 100, 1)).toBe("less than a minute left");
  expect(timeLeft(0, 6000, 50)).toBe("about 2 min left");
  expect(timeLeft(0, null, 50)).toBeNull();
});

/* ── what the button, panel and force screen show ── */

const conn = (id: string, kind: "local" | "remote" = "remote"): Connection => ({ id, kind, name: id, baseUrl: `https://${id}.example`, createdAt: "" });

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    prefs: { firstSeen: {}, later: {}, dismissedMessages: {}, shownMessages: {}, lastDesktopVersion: null, lastServerVersion: {}, failures: {}, autoDownload: true, installOnQuit: true },
    manifest: null,
    desktop: { current: "0.1.0", available: null, phase: "idle", progress: null, error: null, checkedAt: null },
    servers: {},
    ...over,
  };
}

const serverInfo = (over: Partial<ServerUpdates> = {}): ServerUpdates => ({
  current: "1.4.2", channel: "stable", install: "binary", canSelfUpdate: true, latest: { version: "1.5.0", notes: "New" }, updateAvailable: true,
  required: null, manifestVerified: true, checkedAt: NOW, job: null, blocked: null, justUpdated: null, messages: [], ...over,
});

describe("the Update button", () => {
  it("hidden when there's nothing to do", () => {
    expect(buttonOf(itemsOf(snap(), [], NOW), false)).toBeNull();
  });
  it("one per thing to update: this app and each server", () => {
    const s = snap({
      desktop: { current: "0.1.0", available: { version: "0.2.0", currentVersion: "0.1.0", date: null, notes: null, ready: true, partialBytes: 0 }, phase: "ready", progress: null, error: null, checkedAt: NOW },
      servers: { home: { connectionId: "home", info: serverInfo(), version: "1.4.2", error: null, checkedAt: NOW, action: { phase: "idle" } } },
    });
    const items = itemsOf(s, [conn("home")], NOW);
    expect(items.map((i) => i.kind)).toEqual(["desktop", "server"]);
    expect(buttonOf(items, true)).toMatchObject({ label: "Update", count: 2 });
    expect(buttonOf(items.slice(0, 1), true)).toMatchObject({ label: "Restart to update" });
  });
  it("'Later' hides it for a day, but never a required update", () => {
    const later = { "server:home:1.5.0": NOW + DAY };
    const s = snap({ prefs: { ...snap().prefs, later }, servers: { home: { connectionId: "home", info: serverInfo(), version: "1.4.2", error: null, checkedAt: NOW, action: { phase: "idle" } } } });
    expect(buttonOf(itemsOf(s, [conn("home")], NOW), false)).toBeNull();
    const req = snap({ prefs: { ...snap().prefs, later }, servers: { home: { connectionId: "home", info: serverInfo({ required: { version: "1.5.0", severity: "security", reason: "x" } }), version: "1.4.2", error: null, checkedAt: NOW, action: { phase: "idle" } } } });
    expect(buttonOf(itemsOf(req, [conn("home")], NOW), false)).toMatchObject({ label: "Update required", required: true, urgency: "critical" });
  });
  it("an older server without the updates API: the manifest's version decides", () => {
    const s = snap({
      manifest: { manifest: { schema: 1, issuedAt: "x", server: { channels: { stable: { version: "1.5.0" } } } }, verified: true, checkedAt: NOW, error: null },
      servers: { old: { connectionId: "old", info: null, version: "1.3.0", error: null, checkedAt: NOW, action: { phase: "idle" } } },
    });
    const items = itemsOf(s, [conn("old")], NOW);
    expect(items[0]).toMatchObject({ kind: "server", current: "1.3.0", next: "1.5.0" });
  });
});

describe("Update everything", () => {
  const entry = (id: string, over: Partial<ServerUpdates> = {}, action: Snapshot["servers"][string]["action"] = { phase: "idle" }) =>
    ({ connectionId: id, info: serverInfo(over), version: "1.4.2", error: null, checkedAt: NOW, action });
  it("takes this app and every server that can update itself, and nothing already running", () => {
    const s = snap({
      desktop: { current: "0.1.0", available: { version: "0.2.0", currentVersion: "0.1.0", date: null, notes: null, ready: false, partialBytes: 0 }, phase: "idle", progress: null, error: null, checkedAt: NOW },
      servers: {
        home: entry("home"),
        src: entry("src", { canSelfUpdate: false, install: "source" }),
        busy: entry("busy", {}, { phase: "approval", code: "K7Q2M", where: "Telegram" }),
        current: entry("current", { updateAvailable: false, latest: null }),
      },
    });
    const items = itemsOf(s, [conn("home"), conn("src"), conn("busy"), conn("current")], NOW);
    expect(updatableOf(items, s).map((i) => i.name)).toEqual(["Mercury Desktop", "home"]);
  });
  it("nothing while this app is installing", () => {
    const s = snap({ desktop: { current: "0.1.0", available: { version: "0.2.0", currentVersion: "0.1.0", date: null, notes: null, ready: true, partialBytes: 0 }, phase: "installing", progress: null, error: null, checkedAt: NOW } });
    expect(updatableOf(itemsOf(s, [], NOW), s)).toEqual([]);
  });
});

describe("the force screen", () => {
  const required = { version: "1.5.0", severity: "security" as const, reason: "x" };
  const s = snap({ servers: {
    a: { connectionId: "a", info: serverInfo({ required }), version: "1.4.2", error: null, checkedAt: NOW, action: { phase: "idle" } },
  } });
  const items = itemsOf(s, [conn("a"), conn("b")], NOW);
  it("a server forces it only when it's the connection in use", () => {
    expect(forceOf(items, "a", {}, "L", NOW)?.kind).toBe("server");
    expect(forceOf(items, "b", {}, "L", NOW)).toBeNull();
  });
  it("gone while 'continue anyway' holds", () => {
    const f = forceOf(items, "a", {}, "L", NOW)!;
    expect(forceOf(items, "a", { [f.key]: { key: f.key, at: NOW, launchId: "L" } }, "L", NOW + 1000)).toBeNull();
    expect(forceOf(items, "a", { [f.key]: { key: f.key, at: NOW, launchId: "L" } }, "L2", NOW + 1000)).not.toBeNull();
  });
  it("the desktop's own minimum, from a verified manifest only", () => {
    const m = { manifest: { schema: 1, issuedAt: "x", desktop: { minimum: { version: "0.2.0", severity: "required" as const } } }, checkedAt: NOW, error: null };
    expect(forceOf(itemsOf(snap({ manifest: { ...m, verified: true } }), [], NOW), null, {}, "L", NOW)?.kind).toBe("desktop");
    expect(forceOf(itemsOf(snap({ manifest: { ...m, verified: false } }), [], NOW), null, {}, "L", NOW)).toBeNull();
  });
});
