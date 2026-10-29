import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cx } from "~/lib/cx";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: boolean;
  loading?: boolean;
}

const base = "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent/90",
  secondary: "bg-ink/[0.06] text-ink hover:bg-ink/[0.1]",
  outline: "border border-line-strong text-ink hover:bg-ink/[0.05]",
  ghost: "text-ink2 hover:bg-ink/[0.06] hover:text-ink",
  danger: "bg-red/10 text-red hover:bg-red/15",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-sm",
  lg: "h-10 px-4 text-sm",
};

const iconSizes: Record<Size, string> = { sm: "h-7 w-7", md: "h-8 w-8", lg: "h-10 w-10" };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon = false, loading = false, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button ref={ref} className={cx(base, variants[variant], icon ? iconSizes[size] : sizes[size], icon && "px-0", className)} disabled={disabled || loading} {...rest}>
      {loading ? <span className="h-3.5 w-3.5 animate-ring-spin rounded-full border-[1.5px] border-current border-r-transparent" aria-hidden="true" /> : children}
    </button>
  );
});
