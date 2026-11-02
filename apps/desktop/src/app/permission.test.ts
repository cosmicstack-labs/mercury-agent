import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ask Me / Allow All is one setting with two toggles on screen (the
 * composer's picker and the status bar). Flipping either, or changing it in
 * a terminal, must show the same mode everywhere.
 */

const updateSettings = vi.fn(async (p: { bypassPermissions: boolean }) => ({ bypassPermissions: p.bypassPermissions, restrictUser: false, workspace: "" }));
const settings = vi.fn(async () => ({ bypassPermissions: false, restrictUser: false, workspace: "" }));
vi.mock("~/api/mercury", () => ({ chat: { settings: () => settings(), updateSettings: (p: { bypassPermissions: boolean }) => updateSettings(p) } }));

const { useRuntimeState } = await import("./store");
const { setPermissionMode, refreshPermissionMode } = await import("./permission");
const { conversations } = await import("./conversation");
const { handleEvent } = await import("./events");

describe("permission mode", () => {
  beforeEach(() => {
    useRuntimeState.setState({ allowAll: null });
    updateSettings.mockClear();
  });

  it("reads the runtime's mode once", async () => {
    await refreshPermissionMode();
    expect(useRuntimeState.getState().allowAll).toBe(false);
  });

  it("a flip from one toggle is what every toggle reads", async () => {
    useRuntimeState.setState({ allowAll: false });
    await setPermissionMode(true);
    expect(updateSettings).toHaveBeenCalledWith({ bypassPermissions: true });
    expect(useRuntimeState.getState().allowAll).toBe(true);
  });

  it("goes back if the runtime refuses the change", async () => {
    useRuntimeState.setState({ allowAll: false });
    updateSettings.mockRejectedValueOnce(new Error("offline"));
    await setPermissionMode(true);
    expect(useRuntimeState.getState().allowAll).toBe(false);
  });

  it("follows a change made elsewhere (terminal /permissions, another device) through the status event", () => {
    useRuntimeState.setState({ allowAll: false });
    handleEvent(conversations.chat, "status", JSON.stringify({ permission: "allow-all", provider: "Anthropic" }));
    expect(useRuntimeState.getState().allowAll).toBe(true);
    handleEvent(conversations.chat, "status", JSON.stringify({ permission: "ask-me" }));
    expect(useRuntimeState.getState().allowAll).toBe(false);
    handleEvent(conversations.chat, "status", JSON.stringify({ provider: "OpenAI" }));
    expect(useRuntimeState.getState().allowAll).toBe(false);
  });
});
