import { useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/theme";
import api from "@/lib/api";

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const resolved = useThemeStore((s) => s.resolved);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await api.auth.login(username, password);

      if (res.type === "opaqueredirect" || res.status === 0 || res.ok || res.status === 302) {
        window.location.href = "/";
        return;
      }

      if (res.status === 401) {
        setError("Invalid username or password.");
      } else {
        setError(`Login failed (${res.status}). Please try again.`);
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
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="username"
                className="text-xs font-medium text-muted-foreground"
              >
                Username
              </label>
              <Input
                id="username"
                type="text"
                autoComplete="username"
                autoFocus
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter username"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="password"
                className="text-xs font-medium text-muted-foreground"
              >
                Password
              </label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
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
