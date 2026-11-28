import { describe, expect, it } from "vitest";
import { ApiError } from "~/api/client";
import { asksForAddress, canPairHere, minutesLeft, refusedView, statusView } from "./PairPhone";

describe("Pair a phone", () => {
  it("is offered only for the Mercury on this computer, and only when it can pair with a code", () => {
    expect(canPairHere("local", ["auth.devices", "auth.pairCode"])).toBe(true);
    expect(canPairHere("remote", ["auth.pairCode"])).toBe(false);
    expect(canPairHere("local", ["auth.devices"])).toBe(false);
    expect(canPairHere("local", undefined)).toBe(false);
  });

  it("shows why no code was made, from the runtime's answer", () => {
    const insecure = new ApiError("Request failed (409)", 409, null, { ok: false, reason: "insecure", message: "Plain http to the internet." });
    expect(refusedView(insecure)).toEqual({ kind: "refused", reason: "insecure", message: "Plain http to the internet." });
    expect(refusedView(new ApiError("Request failed (409)", 409, null, { ok: false, reason: "remote-off", message: "Remote access is off." }))).toMatchObject({ kind: "refused", reason: "remote-off" });
  });

  it("treats anything else as an error, with its message", () => {
    expect(refusedView(new ApiError("Request failed (409)", 409, null, { reason: "something-new" }))).toEqual({ kind: "error", message: "Request failed (409)" });
    expect(refusedView(new ApiError("Only on this computer.", 403, null, { thisComputerOnly: true }))).toEqual({ kind: "error", message: "Only on this computer." });
    expect(refusedView(new Error("offline"))).toEqual({ kind: "error", message: "offline" });
  });

  it("asks for an address only when the address was the problem", () => {
    expect((["none", "insecure", "loopback", "invalid"] as const).every(asksForAddress)).toBe(true);
    expect((["remote-off", "limit", "not-running"] as const).some(asksForAddress)).toBe(false);
  });

  it("follows the code until a phone uses it or it ends", () => {
    expect(statusView({ status: "waiting" })).toBeNull();
    expect(statusView({ status: "paired", device: { name: "Pixel 9", platform: "android" } })).toEqual({ kind: "paired", device: { name: "Pixel 9", platform: "android" } });
    expect(statusView({ status: "expired" })).toEqual({ kind: "ended", status: "expired" });
    expect(statusView({ status: "replaced" })).toEqual({ kind: "ended", status: "replaced" });
    expect(statusView({ status: "cancelled" })).toEqual({ kind: "ended", status: "cancelled" });
  });

  it("counts the minutes left, rounding up and never below zero", () => {
    const now = 1_000_000;
    expect(minutesLeft(now + 5 * 60_000, now)).toBe(5);
    expect(minutesLeft(now + 61_000, now)).toBe(2);
    expect(minutesLeft(now - 1, now)).toBe(0);
  });
});
