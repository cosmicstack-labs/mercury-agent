import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/api/mercury", () => ({ chat: {} }));
const played: string[] = [];
vi.mock("./sounds", () => ({ playSound: (id: string) => played.push(id), SOUNDS: [], CUSTOM_MAX_BYTES: 1 }));

const { handleActivity } = await import("./notify");
const { useNotify, DEFAULT_PREFS, worthTelling } = await import("./store");
const { conversations } = await import("../conversation");
const { useUi } = await import("../store");
const { useVoice } = await import("../voice");

function reset() {
  useNotify.setState({ prefs: { ...DEFAULT_PREFS, asked: true }, unread: {}, waiting: {}, alerts: [] });
  conversations.chat.setState({ activeId: "open" });
  useUi.setState({ view: "chat" });
  useVoice.setState({ active: false });
  played.length = 0;
}

describe("notifications", () => {
  beforeEach(reset);

  it("only long tasks are worth telling; failures always", () => {
    expect(worthTelling("done", 5_000, DEFAULT_PREFS)).toBe(false);
    expect(worthTelling("done", 31_000, DEFAULT_PREFS)).toBe(true);
    expect(worthTelling("failed", 1_000, DEFAULT_PREFS)).toBe(true);
    expect(worthTelling("done", 31_000, { ...DEFAULT_PREFS, done: false })).toBe(false);
  });

  it("a long task finishing elsewhere gets a blue dot and a sound", () => {
    handleActivity({ kind: "done", sessionId: "other", title: "Research", ms: 45_000, preview: "Report ready" });
    expect(useNotify.getState().unread.other).toBeTruthy();
    expect(played).toEqual(["pop"]);
  });

  it("a quick reply elsewhere is marked new but stays quiet", () => {
    handleActivity({ kind: "done", sessionId: "other", ms: 3_000 });
    expect(useNotify.getState().unread.other).toBeTruthy();
    expect(played).toEqual([]);
  });

  it("the conversation on screen is never marked new", () => {
    handleActivity({ kind: "done", sessionId: "open", ms: 60_000 });
    expect(useNotify.getState().unread.open).toBeUndefined();
  });

  it("needs-you marks the conversation until it's answered", () => {
    handleActivity({ kind: "needs_you", sessionId: "other", id: "perm_1", prompt: "Run deploy?" });
    expect(useNotify.getState().waiting.other).toBe("perm_1");
    expect(played).toEqual(["pop"]);
    handleActivity({ kind: "resolved", sessionId: "other", id: "perm_1" });
    expect(useNotify.getState().waiting.other).toBeUndefined();
  });

  it("muted: no sound, but the dot still shows", () => {
    useNotify.getState().setPrefs({ muted: true });
    handleActivity({ kind: "done", sessionId: "other", ms: 90_000 });
    expect(played).toEqual([]);
    expect(useNotify.getState().unread.other).toBeTruthy();
  });

  it("stays quiet during a voice call", () => {
    useVoice.setState({ active: true });
    handleActivity({ kind: "needs_you", sessionId: "other", id: "p" });
    expect(played).toEqual([]);
  });

  it("opening the conversation clears its dot", () => {
    useNotify.getState().markUnread("x");
    useNotify.getState().seen("x");
    expect(useNotify.getState().unread.x).toBeUndefined();
  });

  it("forgets marks on deleted conversations", () => {
    useNotify.getState().markUnread("kept");
    useNotify.getState().markUnread("deleted");
    useNotify.getState().markWaiting("gone", "p1");
    useNotify.getState().keepOnly(new Set(["kept"]));
    expect(Object.keys(useNotify.getState().unread)).toEqual(["kept"]);
    expect(useNotify.getState().waiting).toEqual({});
  });
});

describe("which list a conversation shows in", async () => {
  const { listOf } = await import("../conversation");
  it("Code sessions and Code-titled ones go to Code, the rest to Chat", () => {
    const code = new Set(["c1"]);
    expect(listOf({ id: "c1", title: "Fix the build" }, code)).toBe("code");
    expect(listOf({ id: "x", title: "Code · refactor" }, code)).toBe("code");
    expect(listOf({ id: "y", title: "Srinagar news" }, code)).toBe("chat");
  });
});
