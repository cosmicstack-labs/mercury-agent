/**
 * The API versions this build of Mercury Desktop understands. The runtime
 * reports its own in /api/health (see src/web/api-contract.ts). A runtime
 * outside this range is not talked to blindly: the user is told which side
 * to update, and can open the runtime's own dashboard in a browser, which
 * always matches it.
 */
export const SUPPORTED_API = Object.freeze({ min: 1, max: 1 });

export type Compat =
  | { ok: true }
  | { ok: false; reason: "runtime-too-old" | "desktop-too-old"; apiVersion: number };

export function checkCompat(apiVersion: number | undefined): Compat {
  // A runtime that does not report apiVersion predates the contract (< 1.5).
  const v = typeof apiVersion === "number" && Number.isFinite(apiVersion) ? apiVersion : 0;
  if (v < SUPPORTED_API.min) return { ok: false, reason: "runtime-too-old", apiVersion: v };
  if (v > SUPPORTED_API.max) return { ok: false, reason: "desktop-too-old", apiVersion: v };
  return { ok: true };
}
