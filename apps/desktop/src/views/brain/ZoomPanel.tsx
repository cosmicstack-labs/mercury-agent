import { Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { Tooltip } from "~/components/ui/Tooltip";

/** Map-style zoom controls, bottom right: in, level, out, fit, reset layout. */
export function ZoomPanel({ zoomPct, onZoom, onFit, onReset }: { zoomPct: number; onZoom: (factor: number) => void; onFit: () => void; onReset: () => void }) {
  const ctl = "flex h-8 w-8 items-center justify-center rounded-lg text-ink2 hover:bg-ink/[0.07] hover:text-ink";
  return (
    <div className="absolute bottom-3 right-4 flex flex-col items-center gap-1 rounded-xl border border-line bg-surface/90 p-1 shadow-sm backdrop-blur">
      <Tooltip label="Zoom in" shortcut="+" side="left"><button onClick={() => onZoom(1.4)} className={ctl} aria-label="Zoom in"><Plus size={15} /></button></Tooltip>
      <span className="font-mono text-2xs text-ink4">{zoomPct}%</span>
      <Tooltip label="Zoom out" shortcut="−" side="left"><button onClick={() => onZoom(1 / 1.4)} className={ctl} aria-label="Zoom out"><Minus size={15} /></button></Tooltip>
      <div className="my-0.5 h-px w-6 bg-line" />
      <Tooltip label="Fit to screen" shortcut="0" side="left"><button onClick={onFit} className={ctl} aria-label="Fit to screen"><Maximize2 size={14} /></button></Tooltip>
      <Tooltip label="Reset layout (unpin everything)" side="left"><button onClick={onReset} className={ctl} aria-label="Reset layout"><RotateCcw size={14} /></button></Tooltip>
    </div>
  );
}

/** + / - / 0 zoom while a canvas view is on screen (ignored while typing). */
export function zoomKeys(onZoom: (factor: number) => void, onFit: () => void): (e: KeyboardEvent) => void {
  return (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") onZoom(1.4);
    else if (e.key === "-") onZoom(1 / 1.4);
    else if (e.key === "0") onFit();
  };
}
