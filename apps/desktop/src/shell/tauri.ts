/* ═══════════════════════════════════════════════════════════════
   The native side, as seen from the webview. Every call here has a
   browser fallback so `npm run dev` in a plain browser still works for
   UI work (with localStorage standing in for the keychain — dev only).
   ═══════════════════════════════════════════════════════════════ */

import { invoke } from "@tauri-apps/api/core";

export const isTauri: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface LocalRuntime {
  mercuryHome: string;
  binaryPath: string | null;
  binaryVersion: string | null;
  port: number;
  attachTokenPresent: boolean;
  serviceInstalled: boolean;
  platform: "macos" | "windows" | "linux" | "unknown";
}

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface InstallProgress {
  phase: "resolve" | "checksums" | "download" | "extract" | "install" | "done";
  message: string;
  percent: number | null;
}

export interface InstalledRuntime {
  version: string;
  binaryPath: string;
}

const DEV_SECRET_PREFIX = "mercury-desktop-dev-secret:";

export const desktop = {
  detectLocalRuntime(): Promise<LocalRuntime> {
    if (!isTauri) {
      return Promise.resolve({
        mercuryHome: "~/.mercury",
        binaryPath: null,
        binaryVersion: null,
        port: 6174,
        attachTokenPresent: false,
        serviceInstalled: false,
        platform: "unknown",
      });
    }
    return invoke<LocalRuntime>("detect_local_runtime");
  },

  /**
   * Loopback health from the native side. Works against runtimes that
   * predate CORS (the webview's own fetch would be blinded by the browser).
   */
  async probeLocalHealth(port: number): Promise<Record<string, unknown>> {
    if (!isTauri) {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    }
    return invoke<Record<string, unknown>>("probe_local_health", { port });
  },

  readAttachToken(): Promise<string | null> {
    if (!isTauri) return Promise.resolve(null);
    return invoke<string | null>("read_attach_token");
  },

  /** Runs the installed `mercury` binary with an allow-listed subcommand. */
  runMercury(args: string[]): Promise<CommandOutput> {
    if (!isTauri) return Promise.reject(new Error("Not running inside Mercury Desktop"));
    return invoke<CommandOutput>("run_mercury", { args });
  },

  /** Download, verify and install the latest runtime into ~/.mercury/bin. */
  installRuntime(): Promise<InstalledRuntime> {
    if (!isTauri) return Promise.reject(new Error("Not running inside Mercury Desktop"));
    return invoke<InstalledRuntime>("install_runtime");
  },

  /** Subscribe to install progress; resolves to an unsubscribe function. */
  async onInstallProgress(cb: (p: InstallProgress) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<InstallProgress>("runtime-install-progress", (e) => cb(e.payload));
  },

  async secretGet(key: string): Promise<string | null> {
    if (!isTauri) {
      try { return localStorage.getItem(DEV_SECRET_PREFIX + key); } catch { return null; }
    }
    return invoke<string | null>("secret_get", { key });
  },

  async secretSet(key: string, value: string): Promise<void> {
    if (!isTauri) {
      try { localStorage.setItem(DEV_SECRET_PREFIX + key, value); } catch { /* private mode */ }
      return;
    }
    await invoke("secret_set", { key, value });
  },

  async secretDelete(key: string): Promise<void> {
    if (!isTauri) {
      try { localStorage.removeItem(DEV_SECRET_PREFIX + key); } catch { /* ignore */ }
      return;
    }
    await invoke("secret_delete", { key });
  },

  async openExternal(url: string): Promise<void> {
    if (!isTauri) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  },

  async platform(): Promise<LocalRuntime["platform"]> {
    if (!isTauri) return "unknown";
    const { platform } = await import("@tauri-apps/plugin-os");
    const p = platform();
    if (p === "macos" || p === "windows" || p === "linux") return p;
    return "unknown";
  },

  async hostname(): Promise<string> {
    if (!isTauri) return "This computer";
    const { hostname } = await import("@tauri-apps/plugin-os");
    return (await hostname()) || "This computer";
  },
};
