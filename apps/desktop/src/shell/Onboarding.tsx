import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { cx } from "~/lib/cx";
import type { HealthInfo } from "~/api/types";
import { Wordmark } from "~/components/Logo";
import { Button } from "~/components/ui/Button";
import { Mono } from "~/components/ui/bits";
import { AddRemote } from "./AddRemote";
import { InstallRuntime } from "./InstallRuntime";
import { desktop, type LocalRuntime } from "./tauri";
import { LOCAL_CONNECTION_ID, useConnections } from "./connections";
import { checkCompat } from "./compat";
import { updateLocalRuntime } from "./updateLocal";

/**
 * First run: where should Mercury run? Three short cards, one action each.
 * Install and pairing open in place of the cards; nothing scrolls.
 */

type LocalProbe =
  | { state: "probing" }
  | { state: "running"; runtime: LocalRuntime; health: HealthInfo }
  | { state: "outdated"; runtime: LocalRuntime; health: HealthInfo }
  | { state: "installed"; runtime: LocalRuntime }
  | { state: "missing"; runtime: LocalRuntime };

export function Onboarding({ onDone, canCancel }: { onDone: () => void; canCancel: boolean }) {
  const [local, setLocal] = useState<LocalProbe>({ state: "probing" });
  const [view, setView] = useState<"choose" | "install" | "remote">("choose");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = useConnections((s) => s.add);
  const setActive = useConnections((s) => s.setActive);
  const connections = useConnections((s) => s.connections);

  async function probe() {
    setLocal({ state: "probing" });
    const runtime = await desktop.detectLocalRuntime();
    try {
      const health = (await desktop.probeLocalHealth(runtime.port)) as unknown as HealthInfo;
      const compat = checkCompat(health.apiVersion);
      setLocal(!compat.ok && compat.reason === "runtime-too-old" ? { state: "outdated", runtime, health } : { state: "running", runtime, health });
    } catch {
      setLocal(runtime.binaryPath ? { state: "installed", runtime } : { state: "missing", runtime });
    }
  }
  useEffect(() => { void probe(); }, []);

  async function run(kind: string, fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try { await fn(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(null); }
  }

  const useLocal = () => run("local", async () => {
    if (local.state !== "running") return;
    const name = await desktop.hostname();
    await add({ id: LOCAL_CONNECTION_ID, kind: "local", name, baseUrl: `http://127.0.0.1:${local.runtime.port}` });
    await setActive(LOCAL_CONNECTION_ID);
    onDone();
  });
  // Install the runtime this app is built for and restart onto it
  // (`mercury upgrade` only knows stable, and a running copy keeps old code).
  const upgradeLocal = () => run("upgrade", async () => {
    await updateLocalRuntime();
    await probe();
  });
  const startLocal = () => run("start", async () => {
    const out = await desktop.runMercury(["start"]);
    if (out.code !== 0) throw new Error(firstLine(out.stderr || out.stdout) || `mercury start exited with ${out.code}`);
    await new Promise((r) => setTimeout(r, 2500));
    await probe();
  });

  const platform = local.state === "probing" ? "this computer" : platformName(local.runtime.platform);
  const version = local.state === "running" || local.state === "outdated" ? local.health.version || local.runtime.binaryVersion || "" : local.state === "installed" ? local.runtime.binaryVersion ?? "" : "";
  const found = local.state === "running" || local.state === "outdated";

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-bg" data-tauri-drag-region>
      <div className="relative mx-auto flex w-full max-w-[920px] flex-1 flex-col items-center justify-center gap-7 px-8">
        <div className="flex flex-col items-center gap-1 text-center">
          <Wordmark width={220} />
          <h1 className="sr-only">Mercury Agent</h1>
          <p className="max-w-[440px] text-sm text-ink3">
            {view === "choose" ? `Where should Mercury run? We checked ${platform} first.` : view === "install" ? `Install Mercury on ${platform}.` : "Connect to a Mercury elsewhere."}
          </p>
        </div>

        {error && <div className="w-full max-w-[600px] rounded-md border border-red/30 bg-red/[0.06] px-3 py-2 text-xs text-red">{error}</div>}

        {view === "choose" && (
          <div className="grid w-full grid-cols-3 gap-3">
            <Card highlighted={found} badge={found ? `Found on ${platform}` : undefined}>
              <CardTitle>Use the Mercury here</CardTitle>
              {local.state === "probing" && <CardBody>Looking for a running Mercury…</CardBody>}
              {local.state === "running" && <CardBody>Mercury {version} is running{local.runtime.serviceInstalled ? " as a service" : ""}. The app attaches to it; nothing moves.</CardBody>}
              {local.state === "outdated" && <CardBody>Mercury {version} is running, but it's older than this app. Update it here: the app installs the matching version and restarts Mercury.</CardBody>}
              {local.state === "installed" && <CardBody>Mercury {version} is installed but not running.</CardBody>}
              {local.state === "missing" && <CardBody>No Mercury on {platform} yet.</CardBody>}
              {found && <Mono className="block truncate">127.0.0.1:{local.runtime.port} · API v{local.health.apiVersion ?? 0} · pid {local.health.pid}</Mono>}
              <div className="flex-1" />
              {local.state === "running" && <Button variant="primary" size="lg" loading={busy === "local"} onClick={() => void useLocal()}>Connect</Button>}
              {local.state === "outdated" && <Button variant="primary" size="lg" loading={busy === "upgrade"} onClick={() => void upgradeLocal()}>Update Mercury</Button>}
              {local.state === "installed" && <Button variant="primary" size="lg" loading={busy === "start"} onClick={() => void startLocal()}>Start Mercury</Button>}
              {(local.state === "missing" || local.state === "probing") && <Button variant="outline" size="lg" disabled={local.state === "probing"} onClick={() => void probe()}>Check again</Button>}
            </Card>

            <Card>
              <CardTitle>Install Mercury here</CardTitle>
              <CardBody>Downloads the matching release, verifies it and runs it as a service. No terminal.</CardBody>
              <div className="flex-1" />
              <Button variant="outline" size="lg" onClick={() => setView("install")}>Install here…</Button>
            </Card>

            <Card>
              <CardTitle>Connect elsewhere</CardTitle>
              <CardBody>A server, a home machine, a phone on Termux, or Mercury Cloud. Several at once if you like.</CardBody>
              <div className="flex-1" />
              <Button variant="outline" size="lg" onClick={() => setView("remote")}>Add a connection…</Button>
            </Card>
          </div>
        )}

        {view === "install" && <Panel onBack={() => setView("choose")}><InstallRuntime platform={platform} onInstalled={onDone} /></Panel>}
        {view === "remote" && <Panel onBack={() => setView("choose")}><AddRemote onAdded={onDone} /></Panel>}

        {(connections.length > 0 || canCancel) && view === "choose" && (
          <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-ink3">
            {connections.length > 0 && <span>Saved:</span>}
            {connections.map((c) => (
              <button key={c.id} className="rounded-full border border-line px-3 py-1 hover:bg-ink/[0.05]" onClick={() => { void setActive(c.id).then(onDone); }}>{c.name}</button>
            ))}
            {canCancel && <button className="ml-2 hover:underline" onClick={onDone}>Cancel</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function platformName(p: LocalRuntime["platform"]): string {
  switch (p) {
    case "macos": return "this Mac";
    case "windows": return "this PC";
    case "linux": return "this machine";
    default: return "this computer";
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? "";
}

function Card({ children, highlighted, badge }: { children: React.ReactNode; highlighted?: boolean; badge?: string }) {
  return (
    <div className={cx("relative flex h-[184px] flex-col gap-2 rounded-xl border bg-surface p-5", highlighted ? "border-accent/60 shadow-[0_0_32px_rgb(var(--glow)/0.12)]" : "border-line")} data-no-drag>
      {badge && <span className="absolute -top-2.5 left-4 rounded-full bg-accent px-2 py-0.5 text-2xs font-medium text-on-accent">{badge}</span>}
      {children}
    </div>
  );
}

function Panel({ children, onBack }: { children: React.ReactNode; onBack: () => void }) {
  return (
    <div className="flex w-full max-w-[440px] flex-col gap-3 rounded-xl border border-line bg-surface p-5" data-no-drag>
      <button onClick={onBack} className="flex w-fit items-center gap-1 text-xs text-ink3 hover:text-ink"><ArrowLeft size={14} aria-hidden="true" /> Back</button>
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 text-md font-medium text-ink">{children}</div>;
}

function CardBody({ children }: { children: React.ReactNode }) {
  return <div className="text-xs leading-relaxed text-ink3">{children}</div>;
}
