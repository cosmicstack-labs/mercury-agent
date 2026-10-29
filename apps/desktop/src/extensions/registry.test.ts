import { describe, expect, it } from "vitest";
import { isVisible, orderedIds, type StatusContribution } from "./registry";

const Dummy = () => null;
const item = (id: string, priority: number, extra: Partial<StatusContribution> = {}): StatusContribution => ({ id, title: id, area: "status.left", priority, render: Dummy, ...extra });

describe("status bar contributions", () => {
  it("orders by priority, then by the user's order kept by id", () => {
    const items = { "a.one": item("a.one", 10), "a.two": item("a.two", 30), "a.three": item("a.three", 20) };
    expect(orderedIds(items, { hidden: [], shown: [], order: {} }, "status.left")).toEqual(["a.two", "a.three", "a.one"]);
    const layout = { hidden: [], shown: [], order: { "status.left": ["a.one", "gone.item"] } };
    expect(orderedIds(items, layout, "status.left")).toEqual(["a.one", "a.two", "a.three"]);
  });

  it("respects hidden and default-hidden items", () => {
    const shown = item("a.x", 1);
    const opt = item("a.y", 1, { defaultHidden: true });
    expect(isVisible(shown, { hidden: [], shown: [], order: {} })).toBe(true);
    expect(isVisible(shown, { hidden: ["a.x"], shown: [], order: {} })).toBe(false);
    expect(isVisible(opt, { hidden: [], shown: [], order: {} })).toBe(false);
    expect(isVisible(opt, { hidden: [], shown: ["a.y"], order: {} })).toBe(true);
  });
});
