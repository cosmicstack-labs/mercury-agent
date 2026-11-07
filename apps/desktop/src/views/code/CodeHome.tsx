import { Check, FolderOpen, GitBranch } from "lucide-react";
import type { ChatThread } from "~/api/types";
import { PixelWordmark } from "~/components/PixelWordmark";
import { shortPath } from "./CodeView";
import { cx } from "~/lib/cx";

/**
 * The Mercury Code start screen, in the shape of the terminal coding agents
 * (Claude Code's welcome box, OpenCode's centred wordmark): monospace, the
 * pixel wordmark, a bordered welcome card with the working directory,
 * numbered first steps that tick themselves off, recent sessions in this
 * folder, and only shortcuts that actually work.
 */
export function CodeHome({ folder, branch, version, model, mode, recent, onPickFolder, onOpenSession, onSuggest }: {
  folder: string | null;
  branch: string;
  version: string;
  model: string;
  mode: string;
  recent: ChatThread[];
  onPickFolder: () => void;
  onOpenSession: (id: string) => void;
  onSuggest: (text: string) => void;
}) {
  const steps = [
    { done: Boolean(folder), text: folder ? <>Working in <span className="text-ink">{shortPath(folder)}</span></> : <><button onClick={onPickFolder} className="text-accent underline-offset-2 hover:underline">Open a project folder</button> to work in</> },
    { done: false, text: <>Ask for a change, a fix, a review, or an explanation of the code</> },
    { done: false, text: <>Be specific: name files, paste the error, say what "done" looks like</> },
    { done: false, text: <>Press <Key>shift+tab</Key> to switch mode: <span className="text-ink">auto</span> builds in one go, <span className="text-ink">plan</span> waits for your go-ahead</> },
  ];
  const suggestions = [
    "explain how this project is structured",
    "find and fix the failing tests",
    "review my uncommitted changes",
  ];

  return (
    <div className="flex w-full max-w-[760px] flex-col gap-6 px-8 pb-16 font-mono text-[13.5px] leading-relaxed text-ink2">
      <div className="flex flex-col items-center gap-2">
        <PixelWordmark cell={8} />
        <div className="text-xs text-ink4">v{version || "?"}{model ? ` · ${model}` : ""} · {mode}</div>
      </div>

      <div className="rounded-xl border border-accent/40 px-5 py-4">
        <div className="text-ink"><span className="text-accent">✻</span> Welcome to <span className="font-semibold">Mercury Code</span></div>
        <div className="mt-3 text-ink3">Mercury reads, edits, runs and checks its work in your project, and asks before anything that can't be undone.</div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-ink3">
          <span className="flex items-center gap-1.5"><FolderOpen size={13} />cwd: {folder ? <span className="text-ink">{shortPath(folder)}</span> : <button onClick={onPickFolder} className="text-accent hover:underline">not set</button>}</span>
          {branch && <span className="flex items-center gap-1.5"><GitBranch size={13} />{branch}</span>}
        </div>
      </div>

      <div>
        <div className="mb-2 text-ink">Tips for getting started:</div>
        <ol className="flex flex-col gap-1.5">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-3">
              <span className={cx("w-5 shrink-0 text-right", s.done ? "text-accent" : "text-ink4")}>{s.done ? <Check size={14} className="ml-auto mt-[3px]" /> : `${i + 1}.`}</span>
              <span className={cx(s.done && "text-ink3")}>{s.text}</span>
            </li>
          ))}
        </ol>
      </div>

      {folder && (
        <div>
          <div className="mb-2 text-ink">Try:</div>
          <div className="flex flex-col gap-1">
            {suggestions.map((t) => (
              <button key={t} onClick={() => onSuggest(t)} className="w-fit text-left text-ink3 hover:text-ink">
                <span className="text-ink4">&gt;</span> {t}
              </button>
            ))}
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div>
          <div className="mb-2 text-ink">Recent sessions{folder ? " in this folder" : ""}:</div>
          <div className="flex flex-col gap-1">
            {recent.slice(0, 4).map((t) => (
              <button key={t.id} onClick={() => onOpenSession(t.id)} className="flex w-full items-center gap-3 text-left text-ink3 hover:text-ink">
                <span className="text-ink4">↻</span>
                <span className="min-w-0 flex-1 truncate">{(t.title || "Untitled").replace(/^Code · /, "")}</span>
                <span className="shrink-0 text-xs text-ink4">{ago(t.updatedAt || t.createdAt)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink4">
        <span><Key>enter</Key> send</span>
        <span><Key>shift+enter</Key> new line</span>
        <span><Key>shift+tab</Key> mode</span>
        <span><Key>⌘n</Key> new session</span>
        <span><Key>esc</Key> clear</span>
      </div>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-line px-1 py-px text-[11.5px] text-ink3">{children}</kbd>;
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
