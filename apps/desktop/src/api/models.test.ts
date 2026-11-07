import { describe, expect, it } from "vitest";
import { fieldApplies, type VoiceField } from "./models";
import { filterModels } from "~/components/ModelPicker";

describe("voice fields", () => {
  const f = (when: VoiceField["when"]): VoiceField => ({ key: "k", type: "string", when });
  it("shows a field only for the engine it belongs to", () => {
    expect(fieldApplies(f({ voiceEngine: ["elevenlabs"], mode: ["voice", "both"] }), { voiceEngine: "elevenlabs", mode: "both" })).toBe(true);
    expect(fieldApplies(f({ voiceEngine: ["elevenlabs"] }), { voiceEngine: "openai" })).toBe(false);
  });
  it("any of several conditions is enough (a key shared by STT and TTS)", () => {
    const shared = f([{ voiceEngine: "mercury", sttProvider: "deepgram" }, { voiceEngine: "mercury", ttsProvider: "deepgram" }]);
    expect(fieldApplies(shared, { voiceEngine: "mercury", sttProvider: "assemblyai", ttsProvider: "deepgram" })).toBe(true);
    expect(fieldApplies(shared, { voiceEngine: "mercury", sttProvider: "assemblyai", ttsProvider: "cartesia" })).toBe(false);
  });
  it("no condition means always", () => expect(fieldApplies(f(undefined), {})).toBe(true));
});

describe("model search", () => {
  const models = ["openai/gpt-5", "anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.6", "gpt-4o-mini", "google/gemini-2.5-pro"];
  it("matches every word in any order", () => {
    expect(filterModels(models, "claude opus")).toEqual(["anthropic/claude-opus-4.6"]);
    expect(filterModels(models, "4.6 anthropic")).toHaveLength(2);
  });
  it("puts ids that start with the query first", () => {
    expect(filterModels(models, "gpt")[0]).toBe("gpt-4o-mini");
  });
  it("an empty query lists everything", () => expect(filterModels(models, " ")).toEqual(models));
});
