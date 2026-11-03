import { Check, ChevronDown, ExternalLink, Mic, MicOff, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { devicesApi, testMicrophone, type DevicePermission, type DevicePlugin, type DeviceReport, type MicTestResult, type PermissionState } from "~/api/devices";
import { ApiError } from "~/api/client";
import * as api from "~/api/mercury";
import { Button } from "~/components/ui/Button";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "~/components/ui/Menu";
import { Switch } from "~/components/ui/Switch";
import { Badge, Spinner } from "~/components/ui/bits";
import { cx } from "~/lib/cx";
import { errorText } from "./Models";

/**
 * Microphone & permissions: for each plugin that uses this computer
 * (Optimus), what the OS lets it use, which microphone it listens with,
 * whether it may use one at all, and a live test.
 *
 * Every line comes from the plugin running on the OS in question, so the
 * steps name the real settings page on this OS and version. Coming back to
 * the app (after flipping a switch in System Settings) checks again.
 */

const TEST_SECONDS = 6;

export function DevicesCard({ pluginId }: { pluginId?: string } = {}) {
  const [plugins, setPlugins] = useState<DevicePlugin[] | null>(null);
  const [remote, setRemote] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await devicesApi.list();
      setPlugins(pluginId ? r.plugins.filter((p) => p.id === pluginId) : r.plugins);
      setRemote(false);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.data.remote) setRemote(true);
      // Mercury before 1.4.3 has no /api/devices.
      else if (e instanceof ApiError && e.status === 404) setError("This version of Mercury doesn't report the microphone and permissions yet. Update Mercury on the computer it runs on (mercury upgrade), then come back.");
      else setError(errorText(e));
    }
  }, [pluginId]);

  useEffect(() => {
    void load();
    // Back from System Settings / Windows Settings: show the new state.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  if (remote) {
    return (
      <Shell>
        <p className="text-sm text-ink3">This app is connected to Mercury on another computer. The microphone and permissions belong to that computer: open Mercury there to set them.</p>
      </Shell>
    );
  }
  if (error) return <Shell><p className="text-sm text-ink3">{error}</p></Shell>;
  if (!plugins) return <Shell><Spinner size={16} /></Shell>;
  if (plugins.length === 0) {
    return (
      <Shell>
        <p className="text-sm text-ink3">{pluginId ? "It isn't running yet. Turn it on above to check its microphone and permissions." : "Optimus isn't running. Turn it on in Plugins to set up its microphone and permissions."}</p>
      </Shell>
    );
  }
  return (
    <>
      {plugins.map((p) => (
        <PluginDevices key={p.id} plugin={p} multiple={plugins.length > 1} onChange={(report) => setPlugins((list) => list?.map((x) => (x.id === p.id ? { ...x, report } : x)) ?? null)} onReload={load} />
      ))}
    </>
  );
}

function Shell({ children, badge, title = "Microphone & permissions" }: { children: React.ReactNode; badge?: React.ReactNode; title?: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center gap-2">
        <span className="text-base font-medium text-ink">{title}</span>
        {badge}
      </div>
      {children}
    </div>
  );
}

function PluginDevices({ plugin, multiple, onChange, onReload }: { plugin: DevicePlugin; multiple: boolean; onChange: (r: DeviceReport) => void; onReload: () => Promise<void> }) {
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const title = multiple ? `${plugin.name}: microphone & permissions` : "Microphone & permissions";

  // Say what happened: an update that found nothing newer, or failed, used to look like a button that did nothing.
  async function update() {
    setUpdating(true);
    setResult(null);
    try {
      const r = await api.plugins.update(plugin.id);
      const mine = r.changed.find((c) => c.id === plugin.id);
      if (mine) { setResult({ text: `Updated ${plugin.name} to ${mine.to}.`, ok: true }); await onReload(); }
      else setResult({ text: `No newer ${plugin.name} is available yet. Mercury checks the catalog again later.`, ok: false });
    } catch (e) {
      setResult({ text: errorText(e), ok: false });
    } finally {
      setUpdating(false);
    }
  }
  if (!plugin.report) {
    const outdated = /update it/i.test(plugin.error ?? "");
    return (
      <Shell title={title} badge={<Badge tone="amber">{outdated ? "update needed" : "unavailable"}</Badge>}>
        <p className="text-sm text-ink3">{plugin.error}</p>
        {outdated && (
          <div>
            <Button size="sm" variant="primary" disabled={updating} onClick={() => void update()}>
              {updating ? <Spinner size={13} /> : null} Update {plugin.name}
            </Button>
            {result && <p className={result.ok ? "mt-2 text-xs text-accent" : "mt-2 text-xs text-amber"}>{result.text}</p>}
          </div>
        )}
      </Shell>
    );
  }
  const report = plugin.report;
  const shown = report.permissions.filter((p) => p.used);
  const needsYou = shown.some((p) => p.state !== "granted") || !report.microphones.on;
  return (
    <Shell title={title} badge={needsYou ? <Badge tone="amber">needs attention</Badge> : <Badge tone="accent">ready</Badge>}>
      <Microphone id={plugin.id} name={plugin.name} report={report} onChange={onChange} />
      <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {shown.map((p) => <PermissionRow key={p.kind} id={plugin.id} platform={report.platform} p={p} onChange={onChange} />)}
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => void onReload()}><RefreshCw size={13} /> Recheck</Button>
      </div>
    </Shell>
  );
}

// ── Microphone: on/off, which one, test ─────────────────────────────

function Microphone({ id, name, report, onChange }: { id: string; name: string; report: DeviceReport; onChange: (r: DeviceReport) => void }) {
  const mics = report.microphones;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const micPermission = report.permissions.find((p) => p.kind === "microphone");

  async function select(patch: { microphone?: string; microphoneOn?: boolean }) {
    setBusy(true);
    setProblem(null);
    try {
      onChange(await devicesApi.select(id, patch));
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const current = mics.selected ?? mics.systemDefault;
  const label = mics.selected ? mics.selected : `System default${mics.systemDefault ? ` (${mics.systemDefault})` : ""}`;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-soft p-3">
      <div className="flex items-center gap-3">
        {mics.on ? <Mic size={16} className="text-ink2" /> : <MicOff size={16} className="text-ink4" />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">Microphone</div>
          <div className="text-xs text-ink3">{mics.on ? `${name} listens with the microphone you pick here.` : `${name} won't open any microphone until you turn this on.`}</div>
        </div>
        <Switch checked={mics.on} disabled={busy} onCheckedChange={(v) => void select({ microphoneOn: v })} label="Let Optimus use the microphone" />
      </div>

      {mics.on && (
        <>
          <div className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-xs text-ink3">Device</span>
            {mics.devices.length === 0 ? (
              <span className="text-sm text-amber">No microphone found on this computer.</span>
            ) : (
              <Menu
                trigger={
                  <button disabled={busy} className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-left text-sm text-ink hover:border-line-strong">
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <ChevronDown size={14} className="shrink-0 text-ink3" />
                  </button>
                }
              >
                <MenuItem selected={!mics.selected} onSelect={() => void select({ microphone: "" })} hint={mics.systemDefault ?? undefined}>System default</MenuItem>
                <MenuSeparator />
                <MenuLabel>Microphones on this computer</MenuLabel>
                {mics.devices.map((d) => (
                  <MenuItem key={d.name} selected={mics.selected === d.name} onSelect={() => void select({ microphone: d.name })} hint={d.default ? "default" : undefined}>{d.name}</MenuItem>
                ))}
              </Menu>
            )}
          </div>
          {mics.selected && !mics.selectedConnected && (
            <p className="text-xs text-amber">"{mics.selected}" isn't connected right now, so {name} uses the system default{mics.systemDefault ? ` (${mics.systemDefault})` : ""} until it's back.</p>
          )}
          <MicTest id={id} device={current} blocked={micPermission ? micPermission.state !== "granted" : false} />
        </>
      )}
      {problem && <p className="text-xs text-red">{problem}</p>}
    </div>
  );
}

function MicTest({ id, device, blocked }: { id: string; device: string | null; blocked: boolean }) {
  const [running, setRunning] = useState(false);
  const [level, setLevel] = useState(0);
  const [result, setResult] = useState<MicTestResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const t = setInterval(() => setLeft(Math.max(0, TEST_SECONDS - Math.floor((Date.now() - started) / 1000))), 250);
    return () => clearInterval(t);
  }, [running]);

  function start() {
    setResult(null);
    setProblem(null);
    setLevel(0);
    setLeft(TEST_SECONDS);
    setRunning(true);
    stop.current = testMicrophone(id, TEST_SECONDS, {
      level: setLevel,
      done: (r) => { setResult(r); setRunning(false); setLevel(0); },
      error: (m) => { setProblem(m); setRunning(false); setLevel(0); },
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-xs text-ink3">Level</span>
        <LevelMeter level={level} active={running} />
        <Button size="sm" variant={running ? "ghost" : "outline"} disabled={!device && !running} onClick={() => (running ? (stop.current?.(), setRunning(false), setLevel(0)) : start())}>
          {running ? `Stop (${left}s)` : "Test"}
        </Button>
      </div>
      {running && <p className="pl-[88px] text-xs text-ink3">Say a few words at your normal volume.</p>}
      {!running && blocked && !result && !problem && <p className="pl-[88px] text-xs text-amber">Allow the microphone below first: until then the test only hears silence.</p>}
      {result && (
        <div className="ml-[88px] flex flex-col gap-1.5">
          <p className={cx("text-xs", result.heard ? "text-ok" : "text-amber")}>{result.text}</p>
          {result.steps.length > 0 && <Steps steps={result.steps} />}
        </div>
      )}
      {problem && <p className="ml-[88px] text-xs text-red">{problem}</p>}
    </div>
  );
}

const SEGMENTS = 24;

/** What the meter says about a level: nothing while idle, then silent, speech or loud. */
export function meterState(level: number, active: boolean): "idle" | "silent" | "speech" | "loud" {
  if (!active) return "idle";
  if (!(level >= 0.03)) return "silent";
  return level > 0.85 ? "loud" : "speech";
}

/** Segment i of the meter at this level: off, green, or orange near the top. */
export function segmentTone(i: number, level: number): "off" | "ok" | "loud" {
  const lit = Math.round(Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0)) * SEGMENTS);
  if (i >= lit) return "off";
  return i >= SEGMENTS * 0.8 ? "loud" : "ok";
}

/**
 * The live input level: grey while silent, green for speech, orange when it's
 * loud enough to distort. 24 segments, so small movements still show.
 */
export function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const state = meterState(level, active);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
      <div className="flex h-3 flex-1 items-center gap-[3px]">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span
            key={i}
            className={cx(
              "h-full flex-1 rounded-[2px] transition-colors duration-75",
              { off: "bg-ink/[0.08]", ok: "bg-ok", loud: "bg-amber" }[segmentTone(i, level)],
            )}
          />
        ))}
      </div>
      <span className={cx("w-14 shrink-0 text-right text-xs", state === "speech" ? "text-ok" : state === "loud" ? "text-amber" : "text-ink4")}>
        {state === "idle" ? "" : state === "silent" ? "silent" : state === "loud" ? "loud" : "hearing"}
      </span>
    </div>
  );
}

// ── Permissions ─────────────────────────────────────────────────────

const DOT: Record<PermissionState, string> = {
  granted: "bg-ok",
  "not-asked": "bg-amber",
  limited: "bg-amber",
  denied: "bg-red",
  restricted: "bg-red",
  unavailable: "bg-red",
};

const WORD: Record<PermissionState, string> = {
  granted: "Allowed",
  "not-asked": "Not asked yet",
  limited: "Limited",
  denied: "Blocked",
  restricted: "Restricted",
  unavailable: "Unavailable",
};

const SETTINGS_NAME: Record<DeviceReport["platform"], string> = {
  macos: "Open System Settings",
  windows: "Open Windows Settings",
  linux: "Open settings",
};

function PermissionRow({ id, platform, p, onChange }: { id: string; platform: DeviceReport["platform"]; p: DevicePermission; onChange: (r: DeviceReport) => void }) {
  const [busy, setBusy] = useState<"allow" | "settings" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(p.state !== "granted");
  useEffect(() => { if (p.state !== "granted") setOpen(true); }, [p.state]);

  async function act(openSettings: boolean) {
    setBusy(openSettings ? "settings" : "allow");
    setProblem(null);
    try {
      onChange(await devicesApi.request(id, p.kind, openSettings));
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const ok = p.state === "granted";
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <button className="flex items-center gap-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={cx("h-2.5 w-2.5 shrink-0 rounded-full", DOT[p.state])} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-ink">{p.label}</span>
          {!open && <span className="block truncate text-xs text-ink3">{p.detail}</span>}
        </span>
        <span className={cx("shrink-0 text-xs", ok ? "text-ok" : p.state === "not-asked" || p.state === "limited" ? "text-amber" : "text-red")}>
          {ok && <Check size={12} className="mr-1 inline" />}{WORD[p.state]}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 pl-[22px]">
          <p className="text-xs text-ink3">{p.detail}</p>
          {!ok && p.steps.length > 0 && <Steps steps={p.steps} />}
          {!ok && (p.canRequest || p.canOpenSettings) && (
            <div className="flex flex-wrap gap-2">
              {p.canRequest && (
                <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void act(false)}>
                  {busy === "allow" ? <Spinner size={13} /> : null} Allow
                </Button>
              )}
              {p.canOpenSettings && (
                <Button size="sm" variant={p.canRequest ? "ghost" : "primary"} disabled={!!busy} onClick={() => void act(true)}>
                  {busy === "settings" ? <Spinner size={13} /> : <ExternalLink size={13} />} {SETTINGS_NAME[platform]}
                </Button>
              )}
            </div>
          )}
          {busy === "allow" && p.kind === "microphone" && platform === "macos" && <p className="text-xs text-ink3">Answer the macOS prompt for Optimus. It may appear behind this window.</p>}
          {problem && <p className="text-xs text-red">{problem}</p>}
        </div>
      )}
    </div>
  );
}

function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="flex list-decimal flex-col gap-1 pl-4 text-xs text-ink2 marker:text-ink4">
      {steps.map((s, i) => <li key={i} className="pl-1">{s}</li>)}
    </ol>
  );
}
