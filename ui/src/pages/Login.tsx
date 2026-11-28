import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/theme";
import api from "@/lib/api";

export function LoginPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const resolved = useThemeStore((s) => s.resolved);
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const value = token.trim();
    if (!value) return;
    setLoading(true);

    try {
      const res = await api.auth.login(value);

      if (res.ok) {
        navigate("/", { replace: true });
        return;
      }

      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 401) {
        setError(body.error || "That device token wasn't accepted. Check it, or make a new one with /server token <name>.");
      } else if (res.status === 429) {
        const retry = Number(res.headers.get("Retry-After"));
        setError(retry > 0 ? `Too many attempts. Try again in ${Math.ceil(retry / 60)} min.` : "Too many attempts. Try again later.");
      } else {
        setError(body.error || `Sign-in failed (${res.status}). Please try again.`);
      }
    } catch {
      setError("Unable to reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background overflow-hidden">
      {/* Background glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 40%, rgba(0,212,255,0.06) 0%, transparent 70%)",
        }}
      />

      <div className="relative z-10 w-full max-w-sm px-4">
        <div
          className={cn(
            "rounded-2xl border border-border bg-card p-8 shadow-lg",
            "mercury-glow-sm"
          )}
        >
          {/* Logo */}
          <div className="mb-6 flex flex-col items-center gap-3">
            <img
              src={resolved === "dark" ? "/logo-dark.png" : "/logo-light.png"}
              alt="Mercury"
              className="w-16 h-16"
            />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Welcome back
            </h1>
            <p className="text-sm text-muted-foreground">
              Sign in to Mercury
            </p>
            <p className="text-center text-xs leading-relaxed text-muted-foreground">
              On the computer Mercury runs on, run{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">mercury web</code>{" "}
              to open the dashboard. From another device, paste a device token
              (make one there with{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">/server token &lt;name&gt;</code>).
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="token"
                className="text-xs font-medium text-muted-foreground"
              >
                Device token
              </label>
              <Input
                id="token"
                name="token"
                type="password"
                autoComplete="off"
                autoFocus
                required
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="mdt_…"
                className="font-mono"
              />
            </div>

            {error && (
              <p className="text-sm text-destructive leading-snug">{error}</p>
            )}

            <Button
              type="submit"
              size="lg"
              disabled={loading}
              className="mt-1 w-full font-semibold"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Signing in…
                </span>
              ) : (
                "Sign in"
              )}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground/60">
          Mercury Agent Dashboard
        </p>
      </div>
    </div>
  );
}
