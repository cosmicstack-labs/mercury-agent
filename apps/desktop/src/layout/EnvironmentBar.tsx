import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Cloud, Laptop, Plus, Server, Settings2, UserRound } from "lucide-react";
import type { HealthInfo } from "~/api/types";
import { cx } from "~/lib/cx";
import { usePulse } from "~/app/pulse";
import { useRuntimeState, useUi } from "~/app/store";
import { useConnections, type Connection } from "~/shell/connections";
import { StateOrb } from "~/components/indicators/StateOrb";

/**
 * Where am I? The strip across the top of the window answers it at a
 * glance, every time: which environment (this computer, a remote server,
 * Mercury Cloud), who is signed in, which server this window is talking to,
 * and what that runtime is. Click it to switch.
 */

// macOS draws the traffic lights over this bar (titleBarStyle: Overlay).
export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

export type Environment = "local" | "remote" | "cloud";

export function environmentOf(c: Connection): Environment {
  if (c.kind === "local") return "local";
  try {
    const host = new URL(c.baseUrl).hostname;
    if (/(^|\.)mercury(agent)?\.(sh|cloud|ai)$/i.test(host) || host.includes("mercury-cloud")) return "cloud";
  } catch { /* fall through */ }
  return "remote";
}

const ENV = {
  local: { label: "This computer", icon: Laptop, tone: "text-ink2 bg-ink/[0.06]" },
  remote: { label: "Remote", icon: Server, tone: "text-cyan bg-cyan/10" },
  cloud: { label: "Mercury Cloud", icon: Cloud, tone: "text-accent bg-accent/10" },
} as const;

export function EnvironmentBar({ connection, health }: { connection: Connection; health: HealthInfo }) {
  const owner = usePulse((s) => s.owner);
  const agentName = usePulse((s) => s.agentName);
  const connected = useRuntimeState((s) => s.connected);
  const agent = useRuntimeState((s) => s.agent);
  const env = environmentOf(connection);
  const E = ENV[env];
  const host = hostOf(connection.baseUrl);
  const signedIn = connection.kind === "local" ? owner || "owner" : owner ? `${owner} · this device` : "this device";

  return (
    <div className={cx("flex h-9 shrink-0 items-center gap-3 border-b border-line bg-soft pr-3 text-xs", IS_MAC ? "pl-[84px]" : "pl-3")} data-tauri-drag-region>
      <Switcher current={connection}>
        <button className="flex h-6 items-center gap-2 rounded-md px-1.5 hover:bg-ink/[0.06] data-[state=open]:bg-ink/[0.06]" data-no-drag aria-label="Switch environment">
          <StateOrb state={connected ? agent : "offline"} size={9} />
          <span className="font-medium text-ink">{agentName || "Mercury"}</span>
          <span className="text-ink4">on</span>
          <span className="max-w-[200px] truncate font-medium text-ink">{connection.name}</span>
          <ChevronDown size={12} className="text-ink4" />
        </button>
      </Switcher>

      <span className={cx("flex h-5 items-center gap-1 rounded-full px-2 font-medium", E.tone)}><E.icon size={11} />{E.label}</span>
      <span className="flex items-center gap-1 text-ink3" title="Signed in as"><UserRound size={12} />{signedIn}</span>
      <span className="font-mono text-ink4" title={connection.baseUrl} data-selectable>{host}</span>

      <div className="flex-1" data-tauri-drag-region />

      <span className="font-mono text-ink4" title={`Runtime ${health.version} · API v${health.apiVersion ?? "?"} · pid ${health.pid}`}>
        Mercury {health.version || "?"} · API v{health.apiVersion ?? "?"}
      </span>
    </div>
  );
}

function Switcher({ current, children }: { current: Connection; children: React.ReactNode }) {
  const connections = useConnections((s) => s.connections);
  const setActive = useConnections((s) => s.setActive);
  const setView = useUi((s) => s.setView);
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="start" sideOffset={6} className="z-50 w-[320px] rounded-xl border border-line bg-raised p-1 text-sm text-ink shadow-xl animate-fade-in">
          <div className="px-2 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wider text-ink4">Environments</div>
          {connections.map((c) => {
            const E = ENV[environmentOf(c)];
            return (
              <Dropdown.Item key={c.id} onSelect={() => { if (c.id !== current.id) void setActive(c.id); }} className="flex cursor-default items-center gap-2.5 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-ink/[0.06]">
                <span className={cx("flex h-7 w-7 items-center justify-center rounded-lg", E.tone)}><E.icon size={14} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{c.name}</span>
                  <span className="block truncate font-mono text-2xs text-ink4">{E.label} · {hostOf(c.baseUrl)}</span>
                </span>
                {c.id === current.id && <Check size={14} className="text-accent" />}
              </Dropdown.Item>
            );
          })}
          <Dropdown.Separator className="my-1 h-px bg-line" />
          <Dropdown.Item onSelect={() => setView("settings")} className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-ink/[0.06]"><Plus size={14} className="text-ink3" /> Add a connection…</Dropdown.Item>
          <Dropdown.Item onSelect={() => setView("settings")} className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-ink/[0.06]"><Settings2 size={14} className="text-ink3" /> Manage connections</Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
