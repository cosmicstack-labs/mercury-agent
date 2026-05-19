import { useCallback, useEffect, useState } from "react";
import {
  Settings,
  Loader2,
  CheckCircle2,
  XCircle,
  Sun,
  Moon,
  Monitor,
  User,
  Lock,
  Sparkles,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import api, { type AppConfig } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useThemeStore } from "@/stores/theme";

/* ── Feedback toast inline ── */
interface Feedback {
  type: "success" | "error";
  message: string;
}

function FeedbackBanner({ feedback }: { feedback: Feedback | null }) {
  return (
    <AnimatePresence>
      {feedback && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="overflow-hidden"
        >
          <div
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
              feedback.type === "success"
                ? "bg-emerald-500/10 text-emerald-400"
                : "bg-destructive/10 text-destructive"
            )}
          >
            {feedback.type === "success" ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            ) : (
              <XCircle className="h-4 w-4 shrink-0" />
            )}
            {feedback.message}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ── Skeleton ── */
function SectionSkeleton() {
  return (
    <Card className="border-border/50 bg-card/60 backdrop-blur">
      <CardHeader>
        <div className="h-5 w-32 animate-pulse rounded bg-muted" />
        <div className="h-3.5 w-56 animate-pulse rounded bg-muted mt-1" />
      </CardHeader>
      <CardContent className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-3.5 w-20 animate-pulse rounded bg-muted" />
            <div className="h-9 w-full animate-pulse rounded-md bg-muted" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ── Hook: auto-dismiss feedback ── */
function useFeedback(): [Feedback | null, (f: Feedback) => void] {
  const [fb, setFb] = useState<Feedback | null>(null);
  const show = useCallback((f: Feedback) => {
    setFb(f);
    setTimeout(() => setFb(null), 4000);
  }, []);
  return [fb, show];
}

/* ── Fade wrapper ── */
const fadeIn = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35 },
};

export function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* Identity state */
  const [identity, setIdentity] = useState("");
  const [defaultProvider, setDefaultProvider] = useState("");
  const [tokenBudget, setTokenBudget] = useState(0);
  const [identitySaving, setIdentitySaving] = useState(false);
  const [identityFb, showIdentityFb] = useFeedback();

  /* Account state */
  const [unCurrent, setUnCurrent] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [unSaving, setUnSaving] = useState(false);
  const [unFb, showUnFb] = useFeedback();

  const [pwCurrent, setPwCurrent] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwFb, showPwFb] = useFeedback();

  /* Theme */
  const { theme, setTheme } = useThemeStore();

  const fetchConfig = useCallback(async () => {
    try {
      const cfg: AppConfig = await api.config.get();
      setIdentity(cfg.identity);
      setDefaultProvider(cfg.defaultProvider);
      setTokenBudget(cfg.tokenBudget);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  /* Handlers */
  const saveIdentity = async () => {
    setIdentitySaving(true);
    try {
      await api.config.update({ identity, defaultProvider, tokenBudget });
      showIdentityFb({ type: "success", message: "Settings saved" });
    } catch (e) {
      showIdentityFb({
        type: "error",
        message: e instanceof Error ? e.message : "Save failed",
      });
    } finally {
      setIdentitySaving(false);
    }
  };

  const changeUsername = async () => {
    if (!unCurrent || !newUsername) {
      showUnFb({ type: "error", message: "Both fields are required" });
      return;
    }
    setUnSaving(true);
    try {
      await api.auth.changeUsername(unCurrent, newUsername);
      showUnFb({ type: "success", message: "Username updated" });
      setUnCurrent("");
      setNewUsername("");
    } catch (e) {
      showUnFb({
        type: "error",
        message: e instanceof Error ? e.message : "Update failed",
      });
    } finally {
      setUnSaving(false);
    }
  };

  const changePassword = async () => {
    if (!pwCurrent || !newPassword) {
      showPwFb({ type: "error", message: "All fields are required" });
      return;
    }
    if (newPassword !== confirmPassword) {
      showPwFb({ type: "error", message: "Passwords do not match" });
      return;
    }
    setPwSaving(true);
    try {
      await api.auth.changePassword(pwCurrent, newPassword);
      showPwFb({ type: "success", message: "Password updated" });
      setPwCurrent("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (e) {
      showPwFb({
        type: "error",
        message: e instanceof Error ? e.message : "Update failed",
      });
    } finally {
      setPwSaving(false);
    }
  };

  const themeOptions: { value: "dark" | "light" | "system"; label: string; icon: typeof Sun }[] = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ];

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 animate-pulse rounded-xl bg-muted" />
          <div>
            <div className="h-6 w-24 animate-pulse rounded bg-muted" />
            <div className="h-4 w-48 animate-pulse rounded bg-muted mt-1" />
          </div>
        </div>
        <SectionSkeleton />
        <SectionSkeleton />
        <SectionSkeleton />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#00d4ff]/20 to-[#a78bfa]/20 ring-1 ring-[#00d4ff]/30">
          <Settings className="h-5 w-5 text-[#00d4ff]" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Manage agent identity, credentials, and preferences
          </p>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-center gap-3 py-4">
            <XCircle className="h-5 w-5 text-destructive" />
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" className="ml-auto" onClick={fetchConfig}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Defaults Section ── */}
      <motion.div {...fadeIn} transition={{ ...fadeIn.transition, delay: 0 }}>
        <Card className="border-border/50 bg-card/60 backdrop-blur">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-[#a78bfa]" />
              <h2 className="text-lg font-medium text-foreground">Defaults</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Default provider and daily token budget
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Default Provider
                </label>
                <Input
                  placeholder="openai"
                  value={defaultProvider}
                  onChange={(e) => setDefaultProvider(e.target.value)}
                  className="bg-background/50"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Daily Token Budget
                </label>
                <Input
                  type="number"
                  min={0}
                  placeholder="100000"
                  value={tokenBudget || ""}
                  onChange={(e) => setTokenBudget(Number(e.target.value))}
                  className="bg-background/50"
                />
              </div>
            </div>

            <FeedbackBanner feedback={identityFb} />

            <div className="pt-1">
              <Button
                size="sm"
                onClick={saveIdentity}
                disabled={identitySaving}
                className="bg-gradient-to-r from-[#00d4ff] to-[#a78bfa] text-white hover:opacity-90 transition-opacity"
              >
                {identitySaving && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                Save
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      <Separator className="bg-border/40" />

      {/* ── Account Section ── */}
      <motion.div {...fadeIn} transition={{ ...fadeIn.transition, delay: 0.1 }}>
        <Card className="border-border/50 bg-card/60 backdrop-blur">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-[#00d4ff]" />
              <h2 className="text-lg font-medium text-foreground">Account</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Update your login credentials
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Change Username */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <User className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">
                  Change Username
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Current Password
                  </label>
                  <Input
                    type="password"
                    placeholder="Enter current password"
                    value={unCurrent}
                    onChange={(e) => setUnCurrent(e.target.value)}
                    className="bg-background/50"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    New Username
                  </label>
                  <Input
                    placeholder="Enter new username"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    className="bg-background/50"
                  />
                </div>
              </div>
              <FeedbackBanner feedback={unFb} />
              <Button
                size="sm"
                variant="outline"
                onClick={changeUsername}
                disabled={unSaving}
              >
                {unSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Update Username
              </Button>
            </div>

            <Separator className="bg-border/30" />

            {/* Change Password */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">
                  Change Password
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Current Password
                  </label>
                  <Input
                    type="password"
                    placeholder="Current"
                    value={pwCurrent}
                    onChange={(e) => setPwCurrent(e.target.value)}
                    className="bg-background/50"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    New Password
                  </label>
                  <Input
                    type="password"
                    placeholder="New"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="bg-background/50"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Confirm Password
                  </label>
                  <Input
                    type="password"
                    placeholder="Confirm"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="bg-background/50"
                  />
                </div>
              </div>
              <FeedbackBanner feedback={pwFb} />
              <Button
                size="sm"
                variant="outline"
                onClick={changePassword}
                disabled={pwSaving}
              >
                {pwSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Update Password
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      <Separator className="bg-border/40" />

      {/* ── Appearance Section ── */}
      <motion.div {...fadeIn} transition={{ ...fadeIn.transition, delay: 0.2 }}>
        <Card className="border-border/50 bg-card/60 backdrop-blur">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Sun className="h-4 w-4 text-[#00d4ff]" />
              <h2 className="text-lg font-medium text-foreground">Appearance</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Choose your preferred theme
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              {themeOptions.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => setTheme(value)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-all",
                    theme === value
                      ? "border-[#00d4ff]/50 bg-[#00d4ff]/10 text-[#00d4ff] ring-1 ring-[#00d4ff]/20"
                      : "border-border/50 bg-background/50 text-muted-foreground hover:text-foreground hover:border-border"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
