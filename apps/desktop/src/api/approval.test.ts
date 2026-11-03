import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, configureApi, http, setApprovalHandler } from "./client";
import { insecureRemote } from "~/shell/AddRemote";

vi.mock("~/shell/tauri", () => ({ desktop: {} }));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => { setApprovalHandler(null); vi.unstubAllGlobals(); });

describe("a remote Mercury that asks its owner first", () => {
  it("waits for the approval, then repeats the request once with it", async () => {
    configureApi({ baseUrl: "https://m.example", token: "mdt_x" });
    const calls: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push(headers);
      return headers["X-Mercury-Approval"] === "ap1" ? json(200, { ok: true }) : json(428, { approvalRequired: true, approvalId: "ap1", code: "K7Q2M", where: "Telegram", error: "Waiting for the owner to approve: Turn on Allow All." });
    }));
    const seen: string[] = [];
    setApprovalHandler(async (n) => { seen.push(`${n.code}@${n.where}`); return true; });
    expect(await http.put("/api/chat/settings", { bypassPermissions: true })).toEqual({ ok: true });
    expect(seen).toEqual(["K7Q2M@Telegram"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]["X-Mercury-Approval"]).toBe("ap1");
  });

  it("a denial is an error that says so, and nothing is repeated", async () => {
    configureApi({ baseUrl: "https://m.example", token: "mdt_x" });
    const fetchMock = vi.fn(async () => json(428, { approvalRequired: true, approvalId: "ap2", code: "AAAAA", where: "this computer", error: "Waiting…" }));
    vi.stubGlobal("fetch", fetchMock);
    setApprovalHandler(async () => false);
    await expect(http.post("/api/terminal/exec", { command: "ls" })).rejects.toMatchObject({ status: 403, message: "The owner didn't approve this." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an expired device is told why", async () => {
    configureApi({ baseUrl: "https://m.example", token: "mdt_x" });
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { expired: true, error: "This device wasn't used for 30 days, so it was signed out." })));
    const err = await http.get("/api/ping").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toMatch(/wasn't used for 30 days/);
  });
});

describe("plain http to another machine", () => {
  it("is flagged, except on this machine and on a tailnet", () => {
    expect(insecureRemote("http://203.0.113.7:6174")).toBe(true);
    expect(insecureRemote("http://home.example.com")).toBe(true);
    expect(insecureRemote("https://home.example.com")).toBe(false);
    expect(insecureRemote("http://127.0.0.1:6174")).toBe(false);
    expect(insecureRemote("http://100.101.2.3:6174")).toBe(false);
    expect(insecureRemote("http://mercury.tail1234.ts.net")).toBe(false);
  });
});
