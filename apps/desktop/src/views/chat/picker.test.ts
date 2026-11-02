import { describe, expect, it } from "vitest";
import { matchCommands, matchSkills, pickerMode, type CommandEntry } from "./picker";

const catalog: CommandEntry[] = [
  { command: "/help", usage: "/help", description: "Show this manual", takesArgument: false, source: "mercury" },
  { command: "/bots", usage: "/bots", description: "List your bots and fleets", takesArgument: false, source: "mercury" },
  { command: "/bots open ", usage: "/bots open <id>", description: "Open a bot's own chat", takesArgument: true, source: "mercury" },
  { command: "/models use ", usage: "/models use <provider>", description: "Switch the chat model", takesArgument: true, source: "mercury" },
  { command: "/weather ", usage: "/weather …", description: "Forecast for a city", takesArgument: true, source: "plugin", plugin: "Weather" },
];

describe("composer pickers", () => {
  it("opens the command picker on a leading slash and the skill picker on a #word still being typed", () => {
    expect(pickerMode("/")).toBe("command");
    expect(pickerMode("/bots open sc")).toBe("command");
    expect(pickerMode("#rese")).toBe("skill");
    expect(pickerMode("#research do this")).toBeNull();
    expect(pickerMode("hello /help")).toBeNull();
    expect(pickerMode("/help\nmore")).toBeNull();
  });

  it("lists commands that start with the text first, then ones whose words or description match", () => {
    expect(matchCommands("/", catalog).map((i) => i.label)).toEqual(["/help", "/bots", "/bots open", "/models use", "/weather"]);
    expect(matchCommands("/bo", catalog).map((i) => i.label)).toEqual(["/bots", "/bots open"]);
    expect(matchCommands("/forecast", catalog).map((i) => i.label)).toEqual(["/weather"]);
    const use = matchCommands("/models", catalog)[0];
    expect(use).toMatchObject({ label: "/models use", hint: "<provider>", fill: "/models use ", runs: false });
    expect(matchCommands("/help", catalog)[0]).toMatchObject({ runs: true, fill: "/help" });
    expect(matchCommands("/w", catalog)[0]).toMatchObject({ plugin: "Weather" });
  });

  it("completes a bot id where the command takes one", () => {
    const bots = [{ id: "scout", name: "Scout" }, { id: "writer", name: "Writer" }];
    const items = matchCommands("/bots open sc", catalog, bots);
    expect(items[0]).toMatchObject({ label: "/bots open scout", fill: "/bots open scout ", description: "Scout" });
  });

  it("finds skills by name, then by description, and skips turned-off ones", () => {
    const skills = [
      { name: "web-search", description: "Search the web", active: true },
      { name: "pptx", description: "Make slides from research", active: true },
      { name: "old", description: "research", active: false },
    ];
    expect(matchSkills("#", skills).map((i) => i.label)).toEqual(["#web-search", "#pptx"]);
    expect(matchSkills("#research", skills).map((i) => i.label)).toEqual(["#pptx"]);
    expect(matchSkills("#web", skills)[0]).toMatchObject({ fill: "#web-search " });
  });
});
