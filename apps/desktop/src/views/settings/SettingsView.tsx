import { Activity, Info, MessagesSquare, Palette, Server, Sparkles, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { cx } from "~/lib/cx";
import { useUi } from "~/app/store";
import * as api from "~/api/mercury";
import type { DeviceSummary, HealthInfo } from "~/api/types";
import { TINTS, useTheme, type ThemeMode } from "~/app/theme";
import { useConnections, type Connection } from "~/shell/connections";
import { desktop, isTauri } from "~/shell/tauri";
import { Button } from "~/components/ui/Button";
import { Switch } from "~/components/ui/Switch";
import { Badge, Mono, Segmented } from "~/components/ui/bits";
import { Dialog } from "~/components/ui/Dialog";
import { AddRemote } from "~/shell/AddRemote";
import { StateOrb } from "~/components/indicators/StateOrb";
import { Analytics } from "./Analytics";
import { Profile } from "./Profile";
import { ModelsSettings } from "./Models";
import { VoiceSettings } from "./Voice";
import { BudgetsSettings } from "./Budgets";
import { ChannelsSettings } from "./Channels";
import { isVisible, orderedIds, useContributions, type ContributionArea } from "~/extensions/registry";
import { NotificationsSettings } from "./Notifications";

/**
 * Settings: a short list of groups on the left; a group with more than one
 * page shows them as tabs across the top. Everything about the models
 * (which ones, voice, what they may spend) sits together under AI.
 */
type Section = "profile" | "models" | "voice" | "budgets" | "channels" | "notifications" | "appearance" | "statusbar" | "startup" | "connections" | "devices" | "analytics" | "about";

type GroupId = "profile" | "ai" | "messaging" | "app" | "connections" | "analytics" | "about";

const GROUPS: Array<{ id: GroupId; label: string; icon: typeof Palette; tabs: Array<{ id: Section; label: string }> }> = [
  { id: "profile", label: "Profile", icon: UserRound, tabs: [{ id: "profile", label: "Profile" }] },
  { id: "ai", label: "AI", icon: Sparkles, tabs: [{ id: "models", label: "Models" }, { id: "voice", label: "Voice" }, { id: "budgets", label: "Budgets" }] },
  { id: "messaging", label: "Messaging", icon: MessagesSquare, tabs: [{ id: "channels", label: "Channels" }, { id: "notifications", label: "Notifications" }] },
  { id: "app", label: "App", icon: Palette, tabs: [{ id: "appearance", label: "Appearance" }, { id: "statusbar", label: "Status bar" }, { id: "startup", label: "Start-up" }] },
  { id: "connections", label: "Connections", icon: Server, tabs: [{ id: "connections", label: "Runtimes" }, { id: "devices", label: "Paired devices" }] },
  { id: "analytics", label: "Activity", icon: Activity, tabs: [{ id: "analytics", label: "Activity" }] },
  { id: "about", label: "About", icon: Info, tabs: [{ id: "about", label: "About" }] },
];

/** The group a page lives in. */
function groupOf(section: string) {
  return GROUPS.find((g) => g.tabs.some((t) => t.id === section));
}

export function SettingsView({ connection, health, onSwitchConnection }: { connection: Connection; health: HealthInfo; onSwitchConnection: () => void }) {
  const [section, setSection] = useState<Section>("appearance");
  // The page last open in each group, so coming back lands where you were.
  const [lastTab, setLastTab] = useState<Partial<Record<GroupId, Section>>>({});
  const group = groupOf(section) ?? GROUPS[0];
  const wide = section === "analytics" ? "max-w-[960px]" : "max-w-[680px]";
  const go = (next: Section) => {
    const g = groupOf(next);
    if (g) setLastTab((m) => ({ ...m, [g.id]: next }));
    setSection(next);
  };
  // Another screen asked for a page (the Cloud banner opens Models).
  const wanted = useUi((s) => s.settingsSection);
  const clearWanted = useUi((s) => s.clearSettingsSection);
  useEffect(() => {
    if (wanted && groupOf(wanted)) go(wanted as Section);
    if (wanted) clearWanted();
  }, [wanted, clearWanted]);
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-line bg-soft">
        <div className="flex h-[52px] shrink-0 items-center px-5" data-tauri-drag-region>
          <span className="text-base font-semibold text-ink">Settings</span>
        </div>
        <nav className="flex flex-col gap-0.5 px-2" aria-label="Settings">
          {GROUPS.map(({ id, label, icon: Icon, tabs }) => (
            <button key={id} onClick={() => go(lastTab[id] ?? tabs[0].id)} aria-current={group.id === id ? "page" : undefined}
              className={cx("flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-base", group.id === id ? "bg-ink/[0.07] text-ink" : "text-ink2 hover:bg-ink/[0.05] hover:text-ink")}>
              <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-line" data-tauri-drag-region>
          <div className={cx("mx-auto flex items-end gap-1 px-8 pt-5", wide)}>
            <h1 className={cx("mr-5 pb-3 text-xl font-semibold tracking-tight text-ink", group.tabs.length === 1 && "mr-0")}>{group.label}</h1>
            {group.tabs.length > 1 && (
              <div className="flex items-end gap-1" role="tablist" aria-label={group.label}>
                {group.tabs.map((t) => (
                  <button key={t.id} role="tab" aria-selected={section === t.id} onClick={() => go(t.id)}
                    className={cx("-mb-px border-b-2 px-3 pb-3 text-sm transition-colors", section === t.id ? "border-accent font-medium text-ink" : "border-transparent text-ink3 hover:text-ink")}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={cx("mx-auto flex flex-col gap-6 px-8 py-8", wide)}>
            {section === "profile" && <Profile />}
            {section === "models" && <ModelsSettings />}
            {section === "voice" && <VoiceSettings onOpenModels={() => go("models")} />}
            {section === "budgets" && <BudgetsSettings />}
            {section === "notifications" && <NotificationsSettings />}
            {section === "channels" && <ChannelsSettings />}
            {section === "appearance" && <Appearance />}
            {section === "statusbar" && <StatusBarSettings />}
            {section === "analytics" && <Analytics />}
            {section === "connections" && <Connections current={connection} health={health} onSwitchConnection={onSwitchConnection} />}
            {section === "devices" && <Devices current={connection} />}
            {section === "startup" && <Startup />}
            {section === "about" && <About health={health} onAnalytics={() => go("analytics")} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Appearance() {
  const mode = useTheme((s) => s.mode);
  const tint = useTheme((s) => s.tint);
  const resolved = useTheme((s) => s.resolved);
  const setMode = useTheme((s) => s.setMode);
  const setTint = useTheme((s) => s.setTint);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between rounded-lg border border-line bg-surface px-4 py-3">
        <div>
          <div className="text-base text-ink">Theme</div>
          <div className="text-xs text-ink3">Auto follows the system.</div>
        </div>
        <Segmented<ThemeMode> value={mode} onChange={setMode} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "Auto" }]} />
      </div>
      <div className="flex items-center justify-between rounded-lg border border-line bg-surface px-4 py-3">
        <div>
          <div className="text-base text-ink">Tint</div>
          <div className="text-xs text-ink3">Only the accent changes. Amber and red stay what they mean.</div>
        </div>
        <div className="flex items-center gap-2">
          {TINTS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTint(t.id)}
              aria-label={t.label}
              aria-pressed={tint === t.id}
              title={t.label}
              className={cx("h-6 w-6 rounded-full border-2 transition-transform hover:scale-110", tint === t.id ? "border-ink" : "border-transparent")}
              style={{ background: resolved === "dark" ? t.dark : t.light }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function Connections({ current, health, onSwitchConnection }: { current: Connection; health: HealthInfo; onSwitchConnection: () => void }) {
  const connections = useConnections((s) => s.connections);
  const setActive = useConnections((s) => s.setActive);
  const remove = useConnections((s) => s.remove);
  const [adding, setAdding] = useState(false);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex justify-end"><Button size="md" variant="outline" onClick={() => setAdding(true)}>Add connection</Button></div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {connections.map((c) => (
          <div key={c.id} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
            <StateOrb state={c.id === current.id ? "idle" : "offline"} size={10} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm text-ink">
                {c.name}
                {c.id === current.id && <Badge tone="accent">connected</Badge>}
                <Badge>{c.kind === "local" ? "this computer" : "remote"}</Badge>
              </div>
              <Mono className="block truncate">{c.baseUrl}{c.id === current.id ? ` · Mercury ${health.version} · API v${health.apiVersion ?? "?"}` : ""}</Mono>
            </div>
            {c.id !== current.id && <Button size="sm" variant="outline" onClick={() => { void setActive(c.id); }}>Use</Button>}
            <Button size="sm" variant="ghost" onClick={() => { void remove(c.id).then(() => { if (c.id === current.id) onSwitchConnection(); }); }}>Forget</Button>
          </div>
        ))}
      </div>
      <Dialog open={adding} onOpenChange={setAdding} title="Connect to a Mercury elsewhere" description="A server, a home machine, a phone on Termux, or Mercury Cloud.">
        <AddRemote onAdded={() => setAdding(false)} />
      </Dialog>
    </section>
  );
}

function Devices({ current }: { current: Connection }) {
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [self, setSelf] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  async function load() {
    try {
      const res = await api.auth.devices();
      setDevices(res.devices);
      setSelf(res.current);
    } catch {
      setSupported(false);
    }
  }
  useEffect(() => { void load(); }, [current.id]);
  if (!supported) return <p className="text-sm text-ink3">This runtime does not support paired devices yet (needs Mercury 1.5).</p>;
  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-ink3">Devices paired with {current.name}. Revoke one and it is signed out at once.</p>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {devices.length === 0 && <p className="px-4 py-3 text-xs text-ink4">No devices paired. This app attaches with the local token.</p>}
        {devices.map((d) => (
          <div key={d.id} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm text-ink">{d.name}{d.id === self && <Badge tone="accent">this app</Badge>}</div>
              <Mono className="block">{d.platform} · {d.lastSeenAt ? `seen ${new Date(d.lastSeenAt).toLocaleString()}` : "never connected"}</Mono>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void api.auth.revokeDevice(d.id).then(load)}>Revoke</Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function Startup() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!isTauri) return;
    void import("@tauri-apps/plugin-autostart").then((m) => m.isEnabled()).then(setEnabled).catch(() => setEnabled(null));
  }, []);
  async function toggle(v: boolean) {
    const m = await import("@tauri-apps/plugin-autostart");
    try { await (v ? m.enable() : m.disable()); setEnabled(v); } catch { /* keep */ }
  }
  if (enabled === null) return <p className="text-sm text-ink3">Available in the installed app.</p>;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between rounded-lg border border-line bg-surface px-4 py-3">
        <div>
          <div className="text-sm text-ink">Open Mercury Desktop at login</div>
          <div className="text-xs text-ink3">The runtime's own start-up is separate: `mercury service install`.</div>
        </div>
        <Switch id="autostart" checked={enabled} onCheckedChange={(v) => void toggle(v)} />
      </div>
    </section>
  );
}

function About({ health, onAnalytics }: { health: HealthInfo; onAnalytics?: () => void }) {
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    if (!isTauri) return;
    void import("@tauri-apps/api/app").then((m) => m.getVersion()).then(setAppVersion).catch(() => {});
  }, []);
  return (
    <section className="flex flex-col gap-3">
      <div className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink2">
        <div className="flex items-center justify-between"><span>Mercury Desktop</span><Mono>{appVersion || "dev"}</Mono></div>
        <div className="mt-1 flex items-center justify-between"><span>Runtime</span><Mono>{health.version} · API v{health.apiVersion ?? "?"}</Mono></div>
        <button className="mt-3 text-xs text-accent hover:underline" onClick={() => void desktop.openExternal("https://mercuryagent.sh")}>mercuryagent.sh</button>
        {onAnalytics && <button className="ml-4 mt-3 text-xs text-accent hover:underline" onClick={onAnalytics}>Your activity →</button>}
      </div>
    </section>
  );
}

function StatusBarSettings() {
  const items = useContributions((s) => s.items);
  const layout = useContributions((s) => s.layout);
  const setVisible = useContributions((s) => s.setVisible);
  const reset = useContributions((s) => s.reset);
  const areas: Array<[ContributionArea, string]> = [["status.left", "Left side"], ["status.right", "Right side"]];
  return (
    <section className="flex flex-col gap-4">
      <p className="text-sm text-ink3">Choose what the bar at the bottom of the window shows. Right-click the bar for the same list and to reorder items. Plugins can add items here too.</p>
      {areas.map(([area, label]) => (
        <div key={area} className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="border-b border-line px-4 py-2 text-xs font-medium uppercase tracking-wider text-ink4">{label}</div>
          {orderedIds(items, layout, area).map((id) => {
            const item = items[id];
            return (
              <div key={id} className="flex items-center justify-between border-b border-line px-4 py-2.5 last:border-b-0">
                <span className="text-sm text-ink">{item.title}{item.views ? <span className="ml-2 text-xs text-ink4">in {item.views.join(", ")}</span> : null}</span>
                <Switch id={`sb-${id}`} checked={isVisible(item, layout)} onCheckedChange={(v) => setVisible(id, v)} />
              </div>
            );
          })}
        </div>
      ))}
      <div><Button variant="outline" onClick={reset}>Reset to default</Button></div>
    </section>
  );
}
