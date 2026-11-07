import { useEffect, useRef, useState } from "react";
import * as api from "~/api/mercury";
import { Button } from "~/components/ui/Button";
import { Field, Input } from "~/components/ui/Input";
import { Switch } from "~/components/ui/Switch";
import { Mono } from "~/components/ui/bits";
import { desktop, isTauri, type InstallProgress } from "./tauri";
import { LOCAL_CONNECTION_ID, useConnections } from "./connections";
import { localIsOutdated, restartLocalRuntime } from "./updateLocal";

/**
 * "Install Mercury here": download the matching release, verify it, put it
 * in ~/.mercury/bin, write the minimum config, register the service, start
 * it, attach. The user types a name and clicks once.
 */

type Step = "idle" | "download" | "setup" | "service" | "start" | "done" | "failed";

export function InstallRuntime({ platform, onInstalled }: { platform: string; onInstalled: () => void }) {
  const [owner, setOwner] = useState("");
  const [autostart, setAutostart] = useState(true);
  const [step, setStep] = useState<Step>("idle");
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<{ username: string; password: string } | null>(null);
  const unlisten = useRef<(() => void) | null>(null);
  const add = useConnections((s) => s.add);
  const setActive = useConnections((s) => s.setActive);

  useEffect(() => () => { unlisten.current?.(); }, []);

  async function run() {
    setError(null);
    setStep("download");
    try {
      unlisten.current = await desktop.onInstallProgress(setProgress);
      await desktop.installRuntime();
      unlisten.current?.();
      unlisten.current = null;

      setStep("setup");
      const setup = await desktop.runMercury(["setup", "--headless", "--owner", owner.trim() || "Owner", "--json"]);
      if (setup.code !== 0) throw new Error(firstLine(setup.stderr || setup.stdout) || "mercury setup failed");
      try {
        const parsed = JSON.parse(lastJsonLine(setup.stdout)) as { username?: string; password?: string | null };
        if (parsed.username && parsed.password) setCredentials({ username: parsed.username, password: parsed.password });
      } catch { /* courtesy only */ }

      if (autostart) {
        setStep("service");
        const svc = await desktop.runMercury(["service", "install"]);
        if (svc.code !== 0) throw new Error(firstLine(svc.stderr || svc.stdout) || "mercury service install failed");
      }

      setStep("start");
      const runtime = await desktop.detectLocalRuntime();
      const baseUrl = `http://127.0.0.1:${runtime.port}`;
      if (!(await isUp(baseUrl))) {
        const start = await desktop.runMercury(["start"]);
        if (start.code !== 0) throw new Error(firstLine(start.stderr || start.stdout) || "mercury start failed");
      } else if (await localIsOutdated(runtime.port)) {
        // An older Mercury was already running: it would keep running the old code.
        await restartLocalRuntime();
      }
      const deadline = Date.now() + 30_000;
      while (!(await isUp(baseUrl))) {
        if (Date.now() > deadline) throw new Error("Mercury was installed but did not come up within 30 seconds. Check `mercury logs`.");
        await new Promise((r) => setTimeout(r, 1000));
      }
      const name = await desktop.hostname();
      await add({ id: LOCAL_CONNECTION_ID, kind: "local", name, baseUrl });
      await setActive(LOCAL_CONNECTION_ID);
      setStep("done");
      onInstalled();
    } catch (err) {
      unlisten.current?.();
      unlisten.current = null;
      setStep("failed");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const busy = step !== "idle" && step !== "failed" && step !== "done";

  return (
    <div className="flex flex-col gap-3">
      <Field label="Your name" htmlFor="install-owner" hint="How Mercury should address you.">
        <Input id="install-owner" value={owner} onChange={(e) => setOwner(e.target.value)} disabled={busy} />
      </Field>
      <Switch id="install-autostart" checked={autostart} onCheckedChange={setAutostart} disabled={busy} label="Start Mercury when I log in" />
      {busy && (
        <div className="rounded-md border border-line bg-raised px-3 py-2 text-xs text-ink2">
          {stepLabel(step, progress)}
          {step === "download" && progress?.percent != null && (
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-ink/[0.1]"><div className="h-full bg-accent transition-[width]" style={{ width: `${progress.percent}%` }} /></div>
          )}
        </div>
      )}
      {error && <div className="rounded-md border border-red/30 bg-red/[0.06] px-2.5 py-1.5 text-xs text-red">{error}</div>}
      {credentials && <Mono className="block">Browser login (shown once): {credentials.username} / {credentials.password}</Mono>}
      <Button variant="primary" size="lg" onClick={() => void run()} disabled={busy || !isTauri} loading={busy} title={isTauri ? undefined : "Available inside the desktop app"}>
        {step === "failed" ? "Try again" : `Install Mercury on ${platform}`}
      </Button>
    </div>
  );
}

async function isUp(baseUrl: string): Promise<boolean> {
  try { return (await api.health.probe(baseUrl, null, 1500)).ok; } catch { return false; }
}

function stepLabel(step: Step, progress: InstallProgress | null): string {
  switch (step) {
    case "download": return progress?.message ?? "Downloading Mercury…";
    case "setup": return "Writing the configuration…";
    case "service": return "Registering Mercury as a service…";
    case "start": return "Starting Mercury…";
    default: return "";
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? "";
}

function lastJsonLine(text: string): string {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  return lines[lines.length - 1] ?? "{}";
}
