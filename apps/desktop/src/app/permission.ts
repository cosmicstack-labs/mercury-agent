import { useEffect } from "react";
import * as api from "~/api/mercury";
import { useRuntimeState } from "./store";

/**
 * Ask Me / Allow All, shared by every toggle (the composer's picker, the
 * status bar). Reads the runtime once, flips optimistically, and the
 * runtime's status events keep it in sync with changes made elsewhere.
 */
export function usePermissionMode(): { allowAll: boolean | null; setAllowAll: (next: boolean) => Promise<void> } {
  const allowAll = useRuntimeState((s) => s.allowAll);
  useEffect(() => {
    if (useRuntimeState.getState().allowAll === null) void refreshPermissionMode();
  }, []);
  return { allowAll, setAllowAll: setPermissionMode };
}

export async function refreshPermissionMode(): Promise<void> {
  try {
    const s = await api.chat.settings();
    useRuntimeState.getState().setAllowAll(s.bypassPermissions === true);
  } catch { /* keep what we have */ }
}

export async function setPermissionMode(next: boolean): Promise<void> {
  const st = useRuntimeState.getState();
  const before = st.allowAll;
  st.setAllowAll(next);
  try {
    const s = await api.chat.updateSettings({ bypassPermissions: next });
    useRuntimeState.getState().setAllowAll(s.bypassPermissions === true);
  } catch {
    if (before !== null) useRuntimeState.getState().setAllowAll(before);
  }
}
