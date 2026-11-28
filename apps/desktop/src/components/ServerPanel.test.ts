import { describe, expect, it } from "vitest";
import { isServerCommand, pairRequest } from "./ServerPanel";

describe("/server typed in Desktop's chat", () => {
  it("opens pairing for /server pair, with the address when one is given", () => {
    expect(pairRequest("/server pair")).toBe("");
    expect(pairRequest("  /Server   PAIR  ")).toBe("");
    expect(pairRequest("/server pair https://mercury.example.com")).toBe("https://mercury.example.com");
    expect(isServerCommand("/server pair")).toBe(true);
  });

  it("leaves every other /server command to the window as before", () => {
    expect(pairRequest("/server")).toBeNull();
    expect(pairRequest("/server devices")).toBeNull();
    expect(pairRequest("/server pairing")).toBeNull();
    expect(pairRequest("/server pair one two")).toBeNull();
    expect(pairRequest("pair")).toBeNull();
  });
});
