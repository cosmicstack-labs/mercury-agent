import { describe, expect, it } from "vitest";
import { denyOption, splitLabel } from "./Approval";

describe("approval card", () => {
  it("splits a skill choice into a name and a description", () => {
    expect(splitLabel("web-search — Search the web and the news")).toEqual({ name: "web-search", detail: "Search the web and the news" });
    expect(splitLabel("None of these — answer normally")).toEqual({ name: "None of these", detail: "answer normally" });
    expect(splitLabel("Allow once")).toEqual({ name: "Allow once", detail: null });
  });

  it("finds the deny answer for N", () => {
    const p = (labels: string[]) => ({ id: "x", kind: "permission" as const, text: "", raisedAt: 0, options: labels.map((l) => ({ value: l, label: l })) });
    expect(denyOption(p(["Allow", "Always allow", "Deny"]))?.label).toBe("Deny");
    expect(denyOption(p(["Yes", "No"]))?.label).toBe("No");
    expect(denyOption(p(["Continue"]))).toBeNull();
  });
});
