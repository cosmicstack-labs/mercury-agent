import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes } from "react";
import { cx } from "~/lib/cx";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input({ className, mono, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cx(
        "h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink4 transition-colors focus:border-accent/60",
        mono && "font-mono text-[12.5px]",
        className,
      )}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      {...rest}
    />
  );
});

export function Label({ className, children, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cx("block text-xs font-medium text-ink2", className)} {...rest}>
      {children}
    </label>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-2xs text-ink3">{hint}</p>}
    </div>
  );
}
