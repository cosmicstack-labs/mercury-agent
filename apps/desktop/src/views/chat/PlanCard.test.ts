import { describe, expect, it } from "vitest";
import { shouldShowPlan } from "./PlanCard";

const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Step ${i + 1}`, status: "pending" as const }));

describe("plan card", () => {
  it("chat shows only real multi-step plans; code shows any plan", () => {
    expect(shouldShowPlan("chat", steps(2))).toBe(false);
    expect(shouldShowPlan("chat", steps(3))).toBe(true);
    expect(shouldShowPlan("code", steps(1))).toBe(true);
    expect(shouldShowPlan("code", [])).toBe(false);
    expect(shouldShowPlan("chat", undefined)).toBe(false);
  });
});
