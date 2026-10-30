import { Bot, Brain, Code2, MessageSquare, Puzzle, Settings, Sparkles, Layers } from "lucide-react";
import { useEffect, useMemo } from "react";
import { cx } from "~/lib/cx";
import { useChat, useRuntimeState, useUi, type View } from "~/app/store";
import { Mark } from "~/components/Logo";
import { LABELS } from "~/components/indicators/StateOrb";
import { Tooltip } from "~/components/ui/Tooltip";
import { useNotify } from "~/app/notify/store";
import { listOf, useCodeSessions } from "~/app/conversation";

const ITEMS: Array<{ view: View; label: string; icon: typeof MessageSquare; key: string }> = [
  { view: "chat", label: "Chat", icon: MessageSquare, key: "1" },
  { view: "artifacts", label: "Artifacts", icon: Layers, key: "7" },
  { view: "code", label: "Code", icon: Code2, key: "2" },
  { view: "bots", label: "Bots", icon: Bot, key: "3" },
  { view: "brain", label: "Brain", icon: Brain, key: "4" },
  { view: "plugins", label: "Plugins", icon: Puzzle, key: "5" },
  { view: "skills", label: "Skills", icon: Sparkles, key: "6" },
];

/**
 * The left rail: the mark, the places, settings. The agent's state lives
 * in the top bar and status bar, not on the mark.
 * Switching is a store write, so it is instant and keeps every view's
 * scroll position and drafts.
 */
export function Rail({ connectionName }: { connectionName: string }) {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const agent = useRuntimeState((s) => s.agent);
  const prompts = useRuntimeState((s) => s.prompts.length);
  const unread = useNotify((s) => s.unread);
  const waiting = useNotify((s) => s.waiting);
  const codeIds = useCodeSessions((s) => s.sessions);
  const threads = useChat((s) => s.threads);
  // Count only conversations that are in that list, so every dot here has a dot to find there.
  const dots = useMemo(() => {
    const code = new Set(codeIds.map((c) => c.id));
    const where = new Map(threads.map((t) => [t.id, listOf(t, code)]));
    const of = (ids: string[], surface: "chat" | "code") => ids.filter((id) => where.get(id) === surface).length;
    return {
      chat: { waiting: of(Object.keys(waiting), "chat"), unread: of(Object.keys(unread), "chat") },
      code: { waiting: of(Object.keys(waiting), "code"), unread: of(Object.keys(unread), "code") },
    };
  }, [unread, waiting, codeIds, threads]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const hit = ITEMS.find((i) => i.key === e.key);
      if (hit) { e.preventDefault(); setView(hit.view); }
      if (e.key === ",") { e.preventDefault(); setView("settings"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);

  return (
    <nav className="flex h-full w-[56px] shrink-0 flex-col items-center border-r border-line bg-soft pb-3 pt-[14px]" data-tauri-drag-region aria-label="Primary">
      <Tooltip label={`${LABELS[agent]} · ${connectionName}`}>
        <button onClick={() => setView("chat")} className="mb-4 flex h-9 w-9 items-center justify-center rounded-md" aria-label="Mercury">
          <Mark size={26} />
        </button>
      </Tooltip>

      <div className="flex flex-col gap-1">
        {ITEMS.map(({ view: v, label, icon: Icon, key }) => (
          <Tooltip key={v} label={label} shortcut={`⌘${key}`}>
            <button
              onClick={() => setView(v)}
              aria-current={view === v ? "page" : undefined}
              className={cx("relative flex h-9 w-9 items-center justify-center rounded-md transition-colors", view === v ? "bg-ink/[0.08] text-ink" : "text-ink3 hover:bg-ink/[0.05] hover:text-ink")}
            >
              <Icon size={18} strokeWidth={1.75} />
              {(v === "chat" || v === "code") && (() => {
                const d = dots[v];
                const wait = d.waiting + (v === "chat" ? prompts : 0);
                if (wait > 0) return <span className="absolute right-1.5 top-1.5 block h-1.5 w-1.5 rounded-full bg-amber" aria-label={`${wait} waiting for you`} />;
                if (d.unread > 0) return <span className="absolute right-1.5 top-1.5 block h-1.5 w-1.5 rounded-full bg-blue" aria-label={`${d.unread} with something new`} />;
                return null;
              })()}
            </button>
          </Tooltip>
        ))}
      </div>

      <div className="flex-1" />

      <Tooltip label="Settings" shortcut="⌘,">
        <button
          onClick={() => setView("settings")}
          aria-current={view === "settings" ? "page" : undefined}
          className={cx("flex h-9 w-9 items-center justify-center rounded-md transition-colors", view === "settings" ? "bg-ink/[0.08] text-ink" : "text-ink3 hover:bg-ink/[0.05] hover:text-ink")}
        >
          <Settings size={18} strokeWidth={1.75} />
        </button>
      </Tooltip>
    </nav>
  );
}
