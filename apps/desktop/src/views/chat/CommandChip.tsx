import { Hash, Slash, X } from "lucide-react";
import { cx } from "~/lib/cx";

/**
 * A command or skill as a chip, not as text: in the composer once picked,
 * and at the start of a sent message. Commands wear the accent, skills cyan.
 */
export function CommandChip({ label, kind, onRemove, className }: { label: string; kind: "command" | "skill"; onRemove?: () => void; className?: string }) {
  const skill = kind === "skill";
  const text = label.replace(/^[/#]/, "");
  return (
    <span className={cx(
      "inline-flex h-[26px] shrink-0 select-none items-center gap-1 rounded-lg px-2 align-middle font-mono text-[13px] ring-1",
      skill ? "bg-cyan/10 text-cyan ring-cyan/30" : "bg-accent/10 text-accent ring-accent/30",
      className,
    )}>
      {skill ? <Hash size={12} strokeWidth={2.25} aria-hidden="true" /> : <Slash size={12} strokeWidth={2.25} aria-hidden="true" />}
      <span>{text}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} className="-mr-1 ml-0.5 rounded p-0.5 opacity-60 hover:opacity-100" aria-label={`Remove ${label}`}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}
