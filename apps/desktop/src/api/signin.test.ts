import { afterEach, describe, expect, it, vi } from "vitest";
import { configureApi } from "./client";
import * as api from "./mercury";

vi.mock("~/shell/tauri", () => ({ desktop: {} }));

afterEach(() => { vi.unstubAllGlobals(); });

describe("sign-in without passwords", () => {
  it("has no password pairing left in the client", () => {
    expect("pair" in api.auth).toBe(false);
    expect("pollPair" in api.auth).toBe(false);
  });

  it("opens the browser dashboard with a one-time link from this computer", async () => {
    configureApi({ baseUrl: "http://127.0.0.1:7777", token: null });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ url: "http://127.0.0.1:7777/login/once?c=abc" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await api.server.browserLink()).toEqual({ url: "http://127.0.0.1:7777/login/once?c=abc" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:7777/api/security/browser-link");
    expect(init.method).toBe("POST");
  });
});
