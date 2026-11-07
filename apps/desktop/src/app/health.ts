import { create } from "zustand";
import type { HealthInfo } from "~/api/types";

/** The connected runtime's /api/health, set once the connection is up. */
export const useHealthStore = create<{ health: HealthInfo | null; set(h: HealthInfo | null): void }>((set) => ({
  health: null,
  set: (health) => set({ health }),
}));

export function useHealth(): HealthInfo | null {
  return useHealthStore((s) => s.health);
}
