import { describe, expect, it } from "vitest";
import { parseTokens } from "./Budgets";

describe("parseTokens", () => {
  it("reads plain numbers, separators and k/m", () => {
    expect(parseTokens("1,500,000")).toBe(1_500_000);
    expect(parseTokens("2M")).toBe(2_000_000);
    expect(parseTokens("750k")).toBe(750_000);
    expect(parseTokens(" 1.5m ")).toBe(1_500_000);
    expect(parseTokens("0")).toBe(0);
  });

  it("refuses what isn't a token count", () => {
    expect(parseTokens("")).toBeNull();
    expect(parseTokens("lots")).toBeNull();
    expect(parseTokens("-5")).toBeNull();
    expect(parseTokens("2g")).toBeNull();
  });
});
