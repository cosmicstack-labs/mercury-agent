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

describe("relevant commands and chips", () => {
  it("keeps the commands that make sense in the app, plus Code's own in Code, plus every plugin command", async () => {
    const { relevantCommands } = await import("./picker");
    const all: CommandEntry[] = ["/help", "/menu", "/ws open ", "/sessions", "/code diff", "/bots send ", "/bots dlq clear"].map((c) => ({ command: c, usage: c, description: "", takesArgument: c.endsWith(" "), source: "mercury" as const }));
    all.push({ command: "/weather ", usage: "/weather …", description: "", takesArgument: true, source: "plugin", plugin: "W" });
    expect(relevantCommands(all, "chat").map((c) => c.command)).toEqual(["/help", "/bots send ", "/weather "]);
    expect(relevantCommands(all, "code").map((c) => c.command)).toEqual(["/help", "/code diff", "/bots send ", "/weather "]);
  });

  it("splits a sent message into its command and the rest", async () => {
    const { splitCommand } = await import("./picker");
    const known = ["/bots", "/bots send ", "/models use "];
    expect(splitCommand("/bots send scout write the brief", known)).toEqual({ token: "/bots send", rest: "scout write the brief" });
    expect(splitCommand("/bots", known)).toEqual({ token: "/bots", rest: "" });
    expect(splitCommand("/unknown thing", known)).toEqual({ token: "/unknown", rest: "thing" });
    expect(splitCommand("#research the oxide raise")).toEqual({ token: "#research", rest: "the oxide raise" });
    expect(splitCommand("hello")).toBeNull();
    expect(splitCommand("/ slash alone")).toBeNull();
  });
});
