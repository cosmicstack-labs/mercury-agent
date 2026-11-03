import { useEffect, useMemo, useState } from "react";
import { useConnections } from "~/shell/connections";
import { useUpdates, LAUNCH_ID } from "./store";
import { bannerMessages, buttonOf, forceOf, itemsOf, updatableOf } from "./selectors";

/** A clock that ticks once a minute: the button gets louder with age, an acknowledgement ends after 24 h. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function useUpdateView() {
  const prefs = useUpdates((s) => s.prefs);
  const manifest = useUpdates((s) => s.manifest);
  const desktop = useUpdates((s) => s.desktop);
  const servers = useUpdates((s) => s.servers);
  const acks = useUpdates((s) => s.acks);
  const connections = useConnections((s) => s.connections);
  const activeId = useConnections((s) => s.activeId);
  const now = useMinuteClock();
  return useMemo(() => {
    const snap = { prefs, manifest, desktop, servers };
    const items = itemsOf(snap, connections, now);
    return {
      items,
      updatable: updatableOf(items, snap),
      button: buttonOf(items, desktop.phase === "ready"),
      force: forceOf(items, activeId, acks, LAUNCH_ID, now),
      banners: bannerMessages(snap, now),
      now,
    };
  }, [prefs, manifest, desktop, servers, acks, connections, activeId, now]);
}
