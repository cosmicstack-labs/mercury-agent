import { describe, expect, it } from "vitest";
import { describeCron, slugify, tooFrequent } from "./BotForms";

/** The new-bot form: ids the runtime accepts, schedules in words, and the 15-minute floor said up front. */
describe("bot forms", () => {
  it("makes an id the runtime accepts from any name", () => {
    expect(slugify("Rust Watcher")).toBe("rust-watcher");
    expect(slugify("  Café Daily Brief!! ")).toBe("cafe-daily-brief");
    expect(slugify("42 news")).toBe("bot-42-news");
    expect(slugify("")).toBe("bot-new");
    expect(slugify("x".repeat(80))).toHaveLength(30);
    for (const id of [slugify("Rust Watcher"), slugify("42 news"), slugify("Ünïcode")]) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("says common schedules in words and leaves the rest as cron", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 9");
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("30 7 * * *")).toBe("30 7 * * *");
  });

  it("warns when a schedule asks for more than one run every 15 minutes", () => {
    expect(tooFrequent("*/5 * * * *")).toBe(true);
    expect(tooFrequent("* * * * *")).toBe(true);
    expect(tooFrequent("*/15 * * * *")).toBe(false);
    expect(tooFrequent("0 9 * * *")).toBe(false);
  });
});
