import { useState } from "react";
import { Plus, Trash2, Download, MessageSquare, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ChatThread } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface ThreadListProps {
  threads: ChatThread[];
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onNew: () => void;
  onExport: (id: string) => void;
}

export function ThreadList({
  threads,
  activeThreadId,
  onSelect,
  onDelete,
  onRename,
  onNew,
  onExport,
}: ThreadListProps) {
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ChatThread | null>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const normalizedTitle = title.replace(/\s+/g, " ").trim();
  const titleLength = Array.from(normalizedTitle).length;

  async function saveTitle(event: React.FormEvent) {
    event.preventDefault();
    if (!renameTarget || saving || !titleLength || titleLength > 120) return;
    setSaving(true);
    setRenameError(null);
    try {
      await onRename(renameTarget.id, normalizedTitle);
      setRenameTarget(null);
    } catch (error) { setRenameError(error instanceof Error ? error.message : "Could not save the chat name."); }
    finally { setSaving(false); }
  }

  function formatDate(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Conversations</h2>
        <Button size="sm" onClick={onNew} className="h-7 gap-1 px-2 text-xs">
          <Plus className="h-3.5 w-3.5" />
          New Chat
        </Button>
      </div>

      {/* Thread list */}
      <ScrollArea className="flex-1">
        {threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
            <MessageSquare className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No conversations yet
            </p>
          </div>
        ) : (
          <div className="p-2">
            {threads.map((thread) => {
              const isActive = thread.id === activeThreadId;
              return (
                <ThreadItem
                  key={thread.id}
                  thread={thread}
                  isActive={isActive}
                  formatDate={formatDate}
                  onSelect={() => onSelect(thread.id)}
                  onDelete={() => setDeleteTarget(thread.id)}
                  onRename={() => { setRenameTarget(thread); setTitle(thread.title ?? ""); setRenameError(null); }}
                  onExport={() => onExport(thread.id)}
                />
              );
            })}
          </div>
        )}
      </ScrollArea>

      <Dialog open={renameTarget !== null} onOpenChange={open => { if (!open && !saving) setRenameTarget(null); }}>
        <DialogContent>
          <form onSubmit={saveTitle}>
            <DialogHeader>
              <DialogTitle>Rename chat</DialogTitle>
              <DialogDescription>Choose a name up to 120 characters. Mercury will keep the name you choose.</DialogDescription>
            </DialogHeader>
            <div className="my-4 space-y-2">
              <label htmlFor="chat-title" className="text-sm font-medium">Chat name</label>
              <Input id="chat-title" value={title} disabled={saving} autoFocus onFocus={event => event.target.select()} onChange={event => setTitle(event.target.value)} aria-describedby="chat-title-length" />
              <p id="chat-title-length" className={cn("text-xs", titleLength > 120 ? "text-destructive" : "text-muted-foreground")}>{titleLength}/120 characters</p>
              {renameError && <p role="alert" className="text-sm text-destructive">{renameError}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={saving} onClick={() => setRenameTarget(null)}>Cancel</Button>
              <Button type="submit" disabled={saving || !titleLength || titleLength > 120}>{saving ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove this conversation and all its
              messages. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) {
                  onDelete(deleteTarget);
                  setDeleteTarget(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ThreadItem({
  thread,
  isActive,
  formatDate,
  onSelect,
  onDelete,
  onRename,
  onExport,
}: {
  thread: ChatThread;
  isActive: boolean;
  formatDate: (iso: string) => string;
  onSelect: () => void;
  onDelete: () => void;
  onRename: () => void;
  onExport: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={cn(
        "group flex w-full cursor-pointer items-center rounded-lg pl-2 pr-1 py-2 text-left transition-all duration-150",
        isActive
          ? "border-l-2 border-l-primary bg-primary/10 text-foreground"
          : "border-l-2 border-l-transparent hover:bg-muted/60 text-foreground/80"
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-snug text-left">
          {thread.title || "New conversation"}
        </div>
        <div className="text-xs text-muted-foreground text-left">
          {formatDate(thread.createdAt)}
        </div>
      </div>

      <button
        onClick={event => { event.stopPropagation(); onRename(); }}
        className={cn("shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-opacity focus-visible:opacity-100", isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100")}
        aria-label={`Rename ${thread.title || "chat"}`} title="Rename chat">
        <Pencil className="h-3.5 w-3.5" />
      </button>

      {/* Delete button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className={cn(
          "shrink-0 rounded-md p-1 text-red-500 hover:bg-red-500/10 hover:text-red-600 transition-opacity",
          isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        )}
        title="Delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
