import { describe, expect, it, vi } from "vitest";

vi.mock("./tauri", () => ({ desktop: {} }));
const { serviceInstalledFrom } = await import("./updateLocal");
const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });

describe("is Mercury set to start at login?", () => {
  it("macOS: launchd says so", () => {
    expect(serviceInstalledFrom(out("  Service installed and loaded\n  -\t0\tcom.cosmicstack.mercury"))).toBe(true);
    expect(serviceInstalledFrom(out("  Service installed but not loaded"))).toBe(true);
  });
  it("Ubuntu: systemd's own report", () => {
    expect(serviceInstalledFrom(out("● mercury.service - Mercury Agent\n     Loaded: loaded (/home/a/.config/systemd/user/mercury.service; enabled)\n     Active: active (running)"))).toBe(true);
  });
  it("none set up, unsupported, or no answer", () => {
    expect(serviceInstalledFrom(out("  Mercury service is not installed.\n  Run `mercury service install` to set it up."))).toBe(false);
    expect(serviceInstalledFrom(out("  System service is not supported on this platform (freebsd)."))).toBe(false);
    expect(serviceInstalledFrom(out("", 1))).toBe(false);
    expect(serviceInstalledFrom(null)).toBe(false);
  });
});
