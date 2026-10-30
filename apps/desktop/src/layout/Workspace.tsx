import { useEffect } from "react";
import { useUi, type View } from "~/app/store";
import { useRuntimeEvents, refreshBots, refreshThreads } from "~/app/events";
import { usePulsePolling } from "~/app/pulse";
import { useVoiceFeed } from "~/app/voice";
import { useHealthStore } from "~/app/health";
import { registerBuiltinStatusItems } from "~/extensions/builtin-status";
import type { Connection } from "~/shell/connections";
import type { HealthInfo } from "~/api/types";
import { Rail } from "./Rail";
import { EnvironmentBar } from "./EnvironmentBar";
import { StatusBar } from "./StatusBar";
import { ChatView } from "~/views/chat/ChatView";
import { CodeView } from "~/views/code/CodeView";
import { BotsView } from "~/views/bots/BotsView";
import { PluginsView } from "~/views/plugins/PluginsView";
import { SkillsView } from "~/views/skills/SkillsView";
import { SettingsView } from "~/views/settings/SettingsView";
import { BrainView } from "~/views/brain/BrainView";
import { ArtifactsView } from "~/views/artifacts/ArtifactsView";
import { ErrorBoundary } from "~/components/ErrorBoundary";
import { CloudBanner } from "~/views/settings/Cloud";
import { CallLayer } from "~/views/call/Call";
import { useNotifications } from "~/app/notify/notify";
import { Alerts } from "~/components/Alerts";

registerBuiltinStatusItems();

/**
 * Everything after a connection is up:
 *   environment bar   which Mercury, where, who
 *   rail | view       all views mounted; the active one shown
 *   status bar        registered items, user-customisable
 */
export function Workspace({ connection, health, onSwitchConnection }: { connection: Connection; health: HealthInfo; onSwitchConnection: () => void }) {
  const view = useUi((s) => s.view);
  useRuntimeEvents(true);
  useNotifications(true);
  usePulsePolling(connection.id);
  useVoiceFeed(connection.id);

  useEffect(() => { useHealthStore.getState().set(health); }, [health]);

  useEffect(() => {
    void refreshThreads();
    void refreshBots();
  }, [connection.id]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      <EnvironmentBar connection={connection} health={health} />
      <CloudBanner supported={!!health.features?.includes("cloud.signin")} />
      <div className="flex min-h-0 flex-1">
        <Rail connectionName={connection.name} />
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* Each view behind its own crash boundary: one broken view never blanks the window. */}
          <Pane active={view === "chat"}><ErrorBoundary label="Chat"><ChatView /></ErrorBoundary></Pane>
          <Pane active={view === "artifacts"}><ErrorBoundary label="Artifacts"><ArtifactsView /></ErrorBoundary></Pane>
          <Pane active={view === "code"}><ErrorBoundary label="Mercury Code"><CodeView /></ErrorBoundary></Pane>
          <Pane active={view === "bots"}><ErrorBoundary label="Bots"><BotsView /></ErrorBoundary></Pane>
          <Pane active={view === "brain"}><ErrorBoundary label="Brain"><BrainView /></ErrorBoundary></Pane>
          <Pane active={view === "plugins"}><ErrorBoundary label="Plugins"><PluginsView /></ErrorBoundary></Pane>
          <Pane active={view === "skills"}><ErrorBoundary label="Skills"><SkillsView /></ErrorBoundary></Pane>
          <Pane active={view === "settings"}><ErrorBoundary label="Settings"><SettingsView connection={connection} health={health} onSwitchConnection={onSwitchConnection} /></ErrorBoundary></Pane>
        </main>
      </div>
      <StatusBar />
      <CallLayer />
      <Alerts />
    </div>
  );
}

function Pane({ active, children }: { active: boolean; children: React.ReactNode }) {
  // A class, not the `hidden` attribute: Tailwind's preflight gives the
  // attribute zero specificity, so a `flex` class would win and show every
  // pane at once.
  return (
    <div className={active ? "absolute inset-0 flex flex-col" : "hidden"} aria-hidden={!active}>
      {children}
    </div>
  );
}

export type { View };
