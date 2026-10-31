import { useCallback, useEffect, useRef, useState } from "react";
import { configureApi } from "~/api/client";
import * as api from "~/api/mercury";
import type { HealthInfo } from "~/api/types";
import { checkCompat, type Compat } from "./compat";
import { credentialFor, type Connection } from "./connections";
import { desktop } from "./tauri";

/**
 * Bring one connection to life: resolve its credential, point the API
 * client at it, prove the runtime answers, and keep checking while down.
 */

export type RuntimeStatus =
  | { phase: "connecting" }
  | { phase: "ready"; health: HealthInfo }
  | { phase: "offline"; error: string }
  | { phase: "unauthorized" }
  | { phase: "incompatible"; compat: Extract<Compat, { ok: false }>; health: HealthInfo };

const RECHECK_MS = 15_000;

export function useRuntime(connection: Connection, onUnauthorized: () => void): { status: RuntimeStatus; retry: () => void } {
  const [status, setStatus] = useState<RuntimeStatus>({ phase: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function bringUp(): Promise<void> {
      setStatus({ phase: "connecting" });
      const token = await credentialFor(connection);
      if (cancelled) return;
      if (connection.kind === "remote" && !token) {
        setStatus({ phase: "unauthorized" });
        return;
      }
      configureApi({
        baseUrl: connection.baseUrl,
        token,
        onUnauthorized: () => {
          // A local runtime rotates its attach token at every boot; one re-read fixes that.
          if (connection.kind === "local") {
            void credentialFor(connection).then((fresh) => {
              if (fresh && fresh !== token) { configureApi({ token: fresh }); retry(); }
              else { setStatus({ phase: "unauthorized" }); unauthorizedRef.current(); }
            });
            return;
          }
          setStatus({ phase: "unauthorized" });
          unauthorizedRef.current();
        },
      });
      try {
        // Local runtimes are asked from the native side: works even before CORS existed.
        const health: HealthInfo = connection.kind === "local"
          ? ((await desktop.probeLocalHealth(portOf(connection.baseUrl))) as unknown as HealthInfo)
          : await api.health.probe(connection.baseUrl, token);
        if (cancelled) return;
        const compat = checkCompat(health.apiVersion);
        if (!compat.ok) { setStatus({ phase: "incompatible", compat, health }); return; }
        setStatus({ phase: "ready", health });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        if (message === "Unauthorized") { setStatus({ phase: "unauthorized" }); return; }
        setStatus({ phase: "offline", error: message });
        timer = setTimeout(() => { if (!cancelled) void bringUp(); }, RECHECK_MS);
      }
    }

    void bringUp();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [connection, attempt, retry]);

  return { status, retry };
}

function portOf(baseUrl: string): number {
  try {
    const port = Number(new URL(baseUrl).port);
    return Number.isInteger(port) && port > 0 ? port : 6174;
  } catch {
    return 6174;
  }
}
