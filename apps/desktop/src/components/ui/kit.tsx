import { Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "~/lib/cx";
import { Button, type ButtonProps } from "./Button";

/* Shared pieces for list screens (Plugins, Skills, Settings). */

export function SearchField({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) {
  return (
    <label className={cx("flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-ink4 focus-within:border-line-strong", className)}>
      <Search size={15} aria-hidden="true" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="w-full bg-transparent text-sm text-ink placeholder:text-ink4" />
    </label>
  );
}

/** A tile with the item's initial on a tint chosen from its id: same item, same colour. */
export function IconTile({ id, label, size = 40 }: { id: string; label: string; size?: number }) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-xl font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `linear-gradient(135deg, hsl(${hue} 65% 58%), hsl(${(hue + 35) % 360} 70% 42%))` }}
      aria-hidden="true"
    >
      {(label.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/** Destructive action in two clicks: "Remove" → "Remove? Yes". Resets after 4 s. */
export function ConfirmButton({ children, confirmLabel = "Confirm", onConfirm, ...rest }: Omit<ButtonProps, "onClick"> & { confirmLabel?: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <Button
      {...rest}
      variant={armed ? "danger" : rest.variant ?? "ghost"}
      onClick={() => {
        if (armed) { setArmed(false); onConfirm(); return; }
        setArmed(true);
        timer.current = setTimeout(() => setArmed(false), 4000);
      }}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}

/** Page header for list screens: title, count, controls on the right. */
export function PageHeader({ title, meta, children }: { title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-5" data-tauri-drag-region>
      <span className="text-base font-semibold text-ink">{title}</span>
      {meta && <span className="text-sm text-ink3">{meta}</span>}
      <div className="flex-1" />
      {children}
    </header>
  );
}

/** One list row: tile, title + badges, description, actions on the right. */
export function ItemRow({ tile, title, badges, description, footer, actions, tone }: { tile: ReactNode; title: ReactNode; badges?: ReactNode; description?: ReactNode; footer?: ReactNode; actions?: ReactNode; tone?: "warn" }) {
  return (
    <div className={cx("flex items-start gap-4 rounded-xl border bg-surface p-4 transition-colors hover:border-line-strong", tone === "warn" ? "border-amber/40" : "border-line")}>
      {tile}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-medium text-ink">{title}</span>
          {badges}
        </div>
        {description && <p className="mt-1 line-clamp-2 text-sm text-ink3">{description}</p>}
        {footer && <div className="mt-2">{footer}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 self-center">{actions}</div>}
    </div>
  );
}
