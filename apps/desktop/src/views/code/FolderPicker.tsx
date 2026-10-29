import { useEffect, useState } from "react";
import { Dialog } from "~/components/ui/Dialog";
import { Field, Input } from "~/components/ui/Input";
import { Button } from "~/components/ui/Button";
import { isTauri } from "~/shell/tauri";

/**
 * Pick the project folder. On this computer: the system folder dialog. On a
 * remote runtime the folder lives on that machine, so it's typed as a path
 * there (the runtime checks it exists before the turn starts).
 */
export function FolderPicker({ open, onOpenChange, onPick, initial, local }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (path: string) => void; initial: string; local: boolean }) {
  const [path, setPath] = useState(initial);
  useEffect(() => { if (open) setPath(initial); }, [open, initial]);

  useEffect(() => {
    if (!open || !local || !isTauri) return;
    let cancelled = false;
    void import("@tauri-apps/plugin-dialog")
      .then((m) => m.open({ directory: true, multiple: false, title: "Open a project folder", defaultPath: initial || undefined }))
      .then((picked) => {
        if (cancelled) return;
        if (typeof picked === "string" && picked) onPick(picked);
        else onOpenChange(false);
      })
      .catch(() => { /* fall back to the typed path below */ });
    return () => { cancelled = true; };
  }, [open, local]);

  if (local && isTauri) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Project folder" description={local ? "The folder on this computer to work in." : "A folder on the remote machine running Mercury."}>
      <form onSubmit={(e) => { e.preventDefault(); if (path.trim()) onPick(path.trim()); }} className="flex flex-col gap-3">
        <Field label="Path" htmlFor="code-folder"><Input id="code-folder" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/me/projects/app" mono autoFocus /></Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!path.trim()}>Open</Button>
        </div>
      </form>
    </Dialog>
  );
}
