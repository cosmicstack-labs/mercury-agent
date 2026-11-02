/* ═══════════════════════════════════════════════════════════════
   Microphone and permissions of desktop plugins (Optimus): what the OS
   lets them use, which microphone they listen with, and a live test.
   The runtime answers only from the computer it runs on.
   ═══════════════════════════════════════════════════════════════ */

import { http } from "./client";
import { openStream } from "./stream";

export type PermissionState = "granted" | "not-asked" | "denied" | "restricted" | "limited" | "unavailable";
export type PermissionKind = "microphone" | "screen" | "accessibility" | "camera";

export interface DevicePermission {
  kind: PermissionKind;
  label: string;
  state: PermissionState;
  detail: string;
  /** Exactly what to do on this OS and version; empty when nothing is needed. */
  steps: string[];
  /** The OS can show its own prompt (macOS). */
  canRequest: boolean;
  canOpenSettings: boolean;
  /** Something uses it today (the camera row stays hidden until a plugin does). */
  used: boolean;
}

export interface DeviceReport {
  platform: "macos" | "windows" | "linux";
  permissions: DevicePermission[];
  microphones: {
    devices: Array<{ name: string; default: boolean }>;
    systemDefault: string | null;
    /** The owner's pick; null means the system default. */
    selected: string | null;
    selectedConnected: boolean;
    on: boolean;
  };
}

export interface DevicePlugin {
  id: string;
  name: string;
  report?: DeviceReport;
  error?: string;
}

export interface MicTestResult {
  device: string;
  peak: number;
  average: number;
  heard: boolean;
  silent: boolean;
  text: string;
  steps: string[];
}

const enc = encodeURIComponent;

export const devicesApi = {
  list: () => http.get<{ plugins: DevicePlugin[] }>("/api/devices"),
  request: (id: string, kind: PermissionKind, openSettings = false) =>
    http.post<{ report: DeviceReport }>(`/api/devices/${enc(id)}/request`, { kind, openSettings }).then((r) => r.report),
  select: (id: string, patch: { microphone?: string; microphoneOn?: boolean }) =>
    http.post<{ report: DeviceReport }>(`/api/devices/${enc(id)}/select`, patch).then((r) => r.report),
};

/**
 * Listen on the plugin's microphone for `seconds`: `onLevel` gets 0..1 about
 * every 80 ms, then the result (or the reason it couldn't listen). Returns a
 * function that stops listening early.
 */
export function testMicrophone(id: string, seconds: number, on: { level: (n: number) => void; done: (r: MicTestResult) => void; error: (message: string) => void }): () => void {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    handle.close();
  };
  const handle = openStream(`/api/devices/${enc(id)}/test?seconds=${seconds}`, {
    onEvent: (event, data) => {
      if (finished) return;
      if (event === "level") on.level(Number((JSON.parse(data) as { level: number }).level) || 0);
      else if (event === "done") {
        on.done(JSON.parse(data) as MicTestResult);
        finish();
      } else if (event === "error") {
        on.error((JSON.parse(data) as { error: string }).error);
        finish();
      }
    },
    // One test per press: never reconnect (that would start another test).
    onClose: (reason) => {
      if (finished || reason === "closed") return;
      on.error(reason === "unauthorized" ? "Sign in to Mercury again." : "Lost the connection to Mercury during the test.");
      finish();
    },
  });
  return finish;
}
