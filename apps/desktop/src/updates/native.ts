/* The native half of updates (src-tauri/src/commands/updates.rs). In a
   plain browser (`npm run dev`) there is nothing to update: everything
   answers "no update" so the UI still renders. */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "~/shell/tauri";
import type { DesktopUpdateInfo, DesktopUpdateStatus, DownloadProgress, ManifestResult } from "./types";

export const updatesNative = {
  manifest(force: boolean): Promise<ManifestResult> {
    if (!isTauri) return Promise.resolve({ manifest: null, verified: false, checkedAt: null, error: "browser" });
    return invoke<ManifestResult>("updates_manifest", { force });
  },
  check(): Promise<DesktopUpdateInfo | null> {
    if (!isTauri) return Promise.resolve(null);
    return invoke<DesktopUpdateInfo | null>("desktop_update_check");
  },
  status(): Promise<DesktopUpdateStatus> {
    if (!isTauri) return Promise.resolve({ currentVersion: "dev", pending: null, downloading: false, installOnQuit: true });
    return invoke<DesktopUpdateStatus>("desktop_update_status");
  },
  download(): Promise<DesktopUpdateInfo> {
    if (!isTauri) return Promise.reject(new Error("Not running inside Mercury Desktop"));
    return invoke<DesktopUpdateInfo>("desktop_update_download");
  },
  /** Stop a running download; its bytes stay, so it resumes next time. */
  cancel(): Promise<void> {
    if (!isTauri) return Promise.resolve();
    return invoke<void>("desktop_update_cancel");
  },
  /** Installs and restarts the app (on Windows the installer takes over). */
  install(): Promise<void> {
    if (!isTauri) return Promise.reject(new Error("Not running inside Mercury Desktop"));
    return invoke<void>("desktop_update_install");
  },
  setInstallOnQuit(enabled: boolean): Promise<void> {
    if (!isTauri) return Promise.resolve();
    return invoke<void>("desktop_update_set_install_on_quit", { enabled });
  },
  async onProgress(cb: (p: DownloadProgress) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<DownloadProgress>("desktop-update-progress", (e) => cb(e.payload));
  },
};
