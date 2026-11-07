import type { ReactNode } from "react";
import { cx } from "~/lib/cx";

/* Small, single-purpose pieces used across views. */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-ink/[0.04] px-1.5 py-px font-mono text-2xs text-ink3">{children}</kbd>;
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "amber" | "red" | "cyan"; className?: string }) {
  const tones = {
    neutral: "bg-ink/[0.06] text-ink2",
    accent: "bg-accent/15 text-accent",
    amber: "bg-amber/15 text-amber",
    red: "bg-red/12 text-red",
    cyan: "bg-cyan/15 text-cyan",
  };
  return <span className={cx("inline-flex h-5 items-center rounded-full px-2 font-mono text-2xs font-medium", tones[tone], className)}>{children}</span>;
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <span style={{ width: size, height: size }} className={cx("inline-block animate-ring-spin rounded-full border-[1.5px] border-current border-r-transparent", className)} aria-hidden="true" />;
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="text-md font-medium text-ink">{title}</div>
      {body && <p className="max-w-[380px] text-sm text-ink3">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = "sm" }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; size?: "sm" | "md" }) {
  return (
    <div className={cx("inline-flex rounded-md border border-line bg-ink/[0.03] p-0.5", size === "sm" ? "text-xs" : "text-sm")} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx("rounded-[5px] px-2.5 py-1 transition-colors", value === o.value ? "bg-surface text-ink shadow-sm" : "text-ink3 hover:text-ink")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-2xs font-medium uppercase tracking-wider text-ink3">{children}</h2>
      {right}
    </div>
  );
}

export function Row({ children, className, onClick, active }: { children: ReactNode; className?: string; onClick?: () => void; active?: boolean }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} className={cx("flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm", onClick && "hover:bg-ink/[0.05]", active && "bg-ink/[0.07]", className)}>
      {children}
    </Tag>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-xs text-ink3", className)} data-selectable>{children}</span>;
}
