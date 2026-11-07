import { useTheme } from "~/app/theme";
import { cx } from "~/lib/cx";

/** The Mercury mark (cat + ☿) from website/static/img; white on dark, black on light. */
export function Mark({ size = 24, className }: { size?: number; className?: string }) {
  const resolved = useTheme((s) => s.resolved);
  return <img src={resolved === "dark" ? "/logo-dark.png" : "/logo-light.png"} alt="Mercury" width={size} height={size} className={cx("select-none", className)} draggable={false} />;
}

/** The "mercury agent" wordmark with its slow breathing glow (first run only). */
export function Wordmark({ width = 240, breathe = true }: { width?: number; breathe?: boolean }) {
  const resolved = useTheme((s) => s.resolved);
  return (
    <div className="relative flex items-center justify-center" style={{ width: width * 1.5, height: width * 0.5 }}>
      <div
        aria-hidden="true"
        className={cx("pointer-events-none absolute rounded-full", breathe && "animate-breathe")}
        style={{ width: width * 1.5, height: width * 0.7, background: "radial-gradient(closest-side, rgb(var(--glow) / 0.22), rgb(var(--glow) / 0))" }}
      />
      <img
        src={resolved === "dark" ? "/logo-full-dark.png" : "/logo-full-light.png"}
        alt="Mercury Agent"
        className="relative select-none"
        style={{ width, height: "auto", filter: "drop-shadow(0 0 22px rgb(var(--glow) / 0.35))" }}
        draggable={false}
      />
    </div>
  );
}
