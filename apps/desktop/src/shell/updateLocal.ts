import { checkCompat } from "./compat";
import { desktop } from "./tauri";

/**
 * Bring the Mercury on this computer up to what this app needs.
 *
 * Installs the runtime this build is made for (the latest stable, or the
 * release a tester build is pinned to; `mercury upgrade` would only ever
 * fetch stable), then stops whatever Mercury is running (an older copy,
 * perhaps installed another way) and starts the new one, and waits until
 * it answers with the desktop API. Installing alone isn't enough: a
 * running Mercury keeps running the old code.
 */
export async function updateLocalRuntime(onStep?: (step: "download" | "restart" | "wait") => void): Promise<void> {
  onStep?.("download");
  await desktop.installRuntime();
  await restartLocalRuntime(onStep);
}

/** Stop the running Mercury (whichever copy) and start the installed one. */
export async function restartLocalRuntime(onStep?: (step: "restart" | "wait") => void): Promise<void> {
  onStep?.("restart");
  if (await hasLoginService()) {
    // A login service runs Mercury and would bring the old copy straight
    // back: install it again from the new copy, which points it there and
    // restarts it.
    const svc = await desktop.runMercury(["service", "install"]);
    if (svc.code !== 0) throw new Error(firstLine(svc.stderr || svc.stdout) || "mercury service install failed");
  } else {
    // Not running is fine: stop is only there to clear an old copy.
    await desktop.runMercury(["stop"]).catch(() => null);
    const start = await desktop.runMercury(["start"]);
    if (start.code !== 0) throw new Error(firstLine(start.stderr || start.stdout) || "mercury start failed");
  }
  onStep?.("wait");
  const { port } = await desktop.detectLocalRuntime();
  const deadline = Date.now() + 30_000;
  for (;;) {
    const health = await desktop.probeLocalHealth(port).catch(() => null);
    if (health && checkCompat(health.apiVersion as number | undefined).ok) return;
    if (Date.now() > deadline) {
      throw new Error(health
        ? "Mercury restarted but still runs an older copy. Another install may be starting it (check `which mercury`)."
        : "Mercury didn't come back within 30 seconds. Check `mercury logs`.");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Is Mercury set to start at login? `mercury service status` says "not
 * installed" (or "not supported") when it isn't; otherwise it prints the
 * platform's own report (launchd, systemd, Task Scheduler), so anything
 * else means there is one.
 */
export async function hasLoginService(): Promise<boolean> {
  const out = await desktop.runMercury(["service", "status"]).catch(() => null);
  return serviceInstalledFrom(out);
}

export function serviceInstalledFrom(out: { code: number; stdout: string; stderr: string } | null): boolean {
  if (!out || out.code !== 0) return false;
  const text = `${out.stdout}\n${out.stderr}`;
  if (!text.trim()) return false;
  return !/not installed|not supported|could not get service status/i.test(text);
}

/** Does a running Mercury on this port predate the desktop API? */
export async function localIsOutdated(port: number): Promise<boolean> {
  const health = await desktop.probeLocalHealth(port).catch(() => null);
  return !!health && !checkCompat(health.apiVersion as number | undefined).ok;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.slice(0, 300) ?? "";
}
