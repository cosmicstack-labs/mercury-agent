import { useEffect, useState } from "react";
import { TooltipProvider } from "~/components/ui/Tooltip";
import { useConnections, type Connection } from "~/shell/connections";
import { useRuntime } from "~/shell/useRuntime";
import { Onboarding } from "~/shell/Onboarding";
import { FirstModel } from "~/shell/FirstModel";
import { Workspace } from "~/layout/Workspace";
import { Wordmark } from "~/components/Logo";
import { Button } from "~/components/ui/Button";
import { desktop } from "~/shell/tauri";
import { updateLocalRuntime } from "~/shell/updateLocal";
import { configureApi } from "~/api/client";
import { useRuntimeState } from "./store";

/**
 * What fills the window:
 *  - no connection chosen → first run;
 *  - a connection → bring it up, then the workspace;
 *  - a fresh Mercury with no model yet → connect one first.
 */
export function App() {
  return (
    <TooltipProvider>
      <Root />
    </TooltipProvider>
  );
}

function Root() {
  const loaded = useConnections((s) => s.loaded);
  const connections = useConnections((s) => s.connections);
  const activeId = useConnections((s) => s.activeId);
  const load = useConnections((s) => s.load);
  const [switching, setSwitching] = useState(false);

  useEffect(() => { void load(); }, [load]);

  if (!loaded) return <Centered><Wordmark width={200} /></Centered>;

  const active = connections.find((c) => c.id === activeId) ?? null;
  if (!active || switching) return <Onboarding onDone={() => setSwitching(false)} canCancel={Boolean(active)} />;
  return <Connected key={active.id} connection={active} onSwitch={() => setSwitching(true)} />;
}

function Connected({ connection, onSwitch }: { connection: Connection; onSwitch: () => void }) {
  const setActive = useConnections((s) => s.setActive);
  const { status, retry } = useRuntime(connection, () => {});
  const setConnected = useRuntimeState((s) => s.setConnected);

  useEffect(() => { setConnected(status.phase === "ready"); }, [status.phase, setConnected]);

  if (status.phase === "ready" && status.health.setupRequired) return <FirstModel onReady={retry} onSwitch={onSwitch} />;
  if (status.phase === "ready") return <Workspace connection={connection} health={status.health} onSwitchConnection={onSwitch} />;

  return (
    <Centered>
      <div className="flex w-[420px] flex-col items-center gap-5 text-center">
        <Wordmark width={200} breathe={status.phase === "connecting"} />
        {status.phase === "connecting" && <p className="text-sm text-ink3">Connecting to <span className="text-ink">{connection.name}</span>…</p>}
        {status.phase === "offline" && (
          <>
            <p className="text-sm text-ink3"><span className="text-ink">{connection.name}</span> is not answering at <span className="font-mono text-xs">{connection.baseUrl}</span>.</p>
            <p className="text-xs text-ink4">{status.error}</p>
            {connection.kind === "local" && <StartLocal onStarted={retry} />}
            <div className="flex gap-2">
              <Button variant="primary" onClick={retry}>Try again</Button>
              <Button variant="outline" onClick={onSwitch}>Use another connection</Button>
            </div>
          </>
        )}
        {status.phase === "unauthorized" && (
          <>
            <p className="text-sm text-ink3">
              <span className="text-ink">{connection.name}</span> no longer accepts this device.
              {connection.kind === "remote" ? " The token was revoked or has changed." : " Mercury may have restarted with a new token."}
            </p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={retry}>Try again</Button>
              <Button variant="outline" onClick={onSwitch}>Pair again</Button>
            </div>
          </>
        )}
        {status.phase === "incompatible" && (
          <>
            <p className="text-sm text-ink3">
              {status.compat.reason === "desktop-too-old"
                ? `Mercury ${status.health.version} speaks a newer API (v${status.compat.apiVersion}) than this app. Update Mercury Desktop, or open the dashboard in your browser.`
                : connection.kind === "local"
                  ? `Mercury ${status.health.version || "(unknown)"} on this computer is older than this app. Update it here: the app installs the matching version and restarts Mercury.`
                  : `Mercury ${status.health.version || "(unknown)"} on ${connection.name} is older than this app. Update Mercury on that computer to a version with the desktop API.`}
            </p>
            {status.compat.reason === "runtime-too-old" && connection.kind === "local" && <UpdateLocal onUpdated={retry} />}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void desktop.openExternal(connection.baseUrl)}>Open in browser</Button>
              <Button variant="outline" onClick={onSwitch}>Use another connection</Button>
            </div>
          </>
        )}
        <button className="text-xs text-ink4 hover:text-ink2 hover:underline" onClick={() => { configureApi({ baseUrl: "", token: null }); void setActive(null); }}>
          Forget this connection
        </button>
      </div>
    </Centered>
  );
}

/** An older Mercury on this computer: install the matching one and restart onto it. */
function UpdateLocal({ onUpdated }: { onUpdated: () => void }) {
  const [step, setStep] = useState<"idle" | "download" | "restart" | "wait" | "failed">("idle");
  const [detail, setDetail] = useState("");
  async function update() {
    setDetail("");
    try {
      await updateLocalRuntime(setStep);
      onUpdated();
    } catch (err) {
      setStep("failed");
      setDetail(err instanceof Error ? err.message : String(err));
    }
  }
  const busy = step === "download" || step === "restart" || step === "wait";
  const label = step === "download" ? "Downloading Mercury…" : step === "restart" ? "Restarting Mercury…" : step === "wait" ? "Waiting for Mercury…" : "Update Mercury";
  return (
    <div className="flex flex-col items-center gap-2">
      <Button variant="primary" loading={busy} onClick={() => void update()}>{label}</Button>
      {step === "failed" && <p className="max-w-[380px] text-xs text-red">{detail}</p>}
    </div>
  );
}

function StartLocal({ onStarted }: { onStarted: () => void }) {
  const [state, setState] = useState<"idle" | "starting" | "failed">("idle");
  const [detail, setDetail] = useState("");
  async function start() {
    setState("starting");
    try {
      const out = await desktop.runMercury(["start"]);
      if (out.code !== 0) { setState("failed"); setDetail((out.stderr || out.stdout).trim().slice(0, 400)); return; }
      setTimeout(onStarted, 2500);
    } catch (err) {
      setState("failed");
      setDetail(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <Button variant="outline" loading={state === "starting"} onClick={() => void start()}>Start Mercury on this computer</Button>
      {state === "failed" && <pre className="max-w-[400px] whitespace-pre-wrap text-left font-mono text-2xs text-red">{detail}</pre>}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center bg-bg" data-tauri-drag-region>{children}</div>;
}
