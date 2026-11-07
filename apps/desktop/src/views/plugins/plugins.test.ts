import { describe, expect, it } from "vitest";
import type { PluginItem, PluginSetting } from "~/api/types";
import { applies, filled } from "./SettingField";
import { needsSetup, setupKeys } from "./SetupFlow";

const s = (key: string, extra: Partial<PluginSetting> = {}): PluginSetting => ({ key, type: "string", ...extra });
const plugin = (settings: PluginSetting[], extra: Partial<PluginItem> = {}): PluginItem => ({
  id: "qa", name: "QA", description: "", kind: "in-process", tier: "local", status: "enabled", enabled: true, running: true, verified: false, tools: [], commands: [], settings, ...extra,
});

describe("plugin setup steps", () => {
  it("asks the setup settings in the plugin's order, only those that apply", () => {
    const p = plugin([
      s("mode", { type: "enum", setup: true, value: "friendly", options: ["friendly", "pirate"] }),
      s("pirateName", { setup: true, when: { mode: ["pirate"] } }),
      s("loud", { type: "boolean", setup: true, value: false }),
      s("greeting", { value: "Hello" }),
    ]);
    expect(setupKeys(p)).toEqual(["mode", "loud"]);
    p.settings![0].value = "pirate";
    expect(setupKeys(p)).toEqual(["mode", "pirateName", "loud"]);
  });

  it("asks a setupWhenMissing setting only while that requirement is missing", () => {
    const voice = s("voiceEngine", { type: "enum", setup: true, setupWhenMissing: "provider:openai", value: "openai" });
    expect(setupKeys(plugin([voice], { missing: [{ key: "provider:openai", unlocks: "Talking", needs: "an OpenAI key", fix: "add it" }] }))).toEqual(["voiceEngine"]);
    expect(setupKeys(plugin([voice], { missing: [] }))).toEqual([]);
  });

  it("needs setup when a required setting that applies is empty, or a section isn't ready", () => {
    expect(needsSetup(plugin([s("token", { type: "secret", required: true, isSet: false })]))).toBe(true);
    expect(needsSetup(plugin([s("token", { type: "secret", required: true, isSet: true })]))).toBe(false);
    expect(needsSetup(plugin([s("key", { required: true, when: { mode: ["x"] } }), s("mode", { value: "y" })]))).toBe(false);
    expect(needsSetup(plugin([], { settingGroups: [{ id: "voice", label: "Voice", ready: false }] }))).toBe(true);
  });

  it("when-conditions: any of several, and filled-ness by type", () => {
    const all = [s("a", { value: "1" }), s("b", { value: "2" })];
    expect(applies(s("x", { when: [{ a: "9" }, { b: ["2", "3"] }] }), all)).toBe(true);
    expect(applies(s("x", { when: { a: "9" } }), all)).toBe(false);
    expect(filled(s("x", { value: "" }))).toBe(false);
    expect(filled(s("x", { type: "number", value: 0 }))).toBe(true);
  });
});
