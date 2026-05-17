import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Radio,
  Wifi,
  WifiOff,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  UserPlus,
  Trash2,
  Settings2,
  Link2,
  Link2Off,
  Eye,
  EyeOff,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { relay } from "@/lib/api";
import type { RelayStatus } from "@/lib/api";

const ACCENT = "#a855f7";

interface Toast { id: number; type: "success" | "error" | "warning"; message: string }

function ToastBar({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div key={t.id} initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur-sm",
              t.type === "success" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
              t.type === "error" && "border-destructive/30 bg-destructive/10 text-destructive",
              t.type === "warning" && "border-amber-500/30 bg-amber-500/10 text-amber-400",
            )}>
            {t.type === "success" ? <CheckCircle2 className="h-4 w-4" /> : t.type === "warning" ? <AlertTriangle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export default function Relay() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Registration form
  const [regUsername, setRegUsername] = useState("");
  const [regDisplayName, setRegDisplayName] = useState("");
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null);
  const [usernameChecking, setUsernameChecking] = useState(false);
  const [usernameError, setUsernameError] = useState("");

  // Recovery form
  const [showRecover, setShowRecover] = useState(false);
  const [recoverUsername, setRecoverUsername] = useState("");

  // Config form
  const [showConfig, setShowConfig] = useState(false);
  const [configUrl, setConfigUrl] = useState("");

  // Deregister confirm
  const [confirmDeregister, setConfirmDeregister] = useState(false);

  const toast = useCallback((type: "success" | "error" | "warning", message: string) => {
    const id = Date.now();
    setToasts((p) => [...p, { id, type, message }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 4000);
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await relay.status();
      setStatus(s);
      if (!configUrl && s.url) setConfigUrl(s.url);
    } catch (err) {
      console.error("Failed to fetch relay status", err);
    } finally {
      setLoading(false);
    }
  }, [configUrl]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // Debounced username check
  useEffect(() => {
    if (!regUsername || regUsername.length < 3) {
      setUsernameAvailable(null);
      setUsernameError("");
      return;
    }
    const re = /^[a-z0-9_]+$/;
    if (!re.test(regUsername)) {
      setUsernameAvailable(false);
      setUsernameError("Only lowercase letters, numbers, and underscores");
      return;
    }
    if (regUsername.length > 20) {
      setUsernameAvailable(false);
      setUsernameError("Max 20 characters");
      return;
    }

    setUsernameChecking(true);
    const timer = setTimeout(async () => {
      try {
        const res = await relay.checkUsername(regUsername);
        setUsernameAvailable(res.available);
        setUsernameError(res.error || (res.available ? "" : "Username taken"));
      } catch {
        setUsernameError("Could not check username");
        setUsernameAvailable(null);
      } finally {
        setUsernameChecking(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [regUsername]);

  const handleConnect = async () => {
    setActionLoading("connect");
    try {
      const res = await relay.connect();
      toast(res.connected ? "success" : "error", res.message);
      await fetchStatus();
    } catch (err: any) {
      toast("error", err.message || "Failed to connect");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDisconnect = async () => {
    setActionLoading("disconnect");
    try {
      await relay.disconnect();
      toast("success", "Disconnected from relay");
      await fetchStatus();
    } catch (err: any) {
      toast("error", err.message || "Failed to disconnect");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRegister = async () => {
    if (!regUsername || usernameAvailable === false) return;
    setActionLoading("register");
    try {
      const res = await relay.register(regUsername, regDisplayName || undefined);
      if (res.recovered) {
        toast("warning", `Recovered existing account @${res.username}`);
      } else {
        toast("success", `Registered as @${res.username}${res.connected ? " and connected" : ""}`);
      }
      setRegUsername("");
      setRegDisplayName("");
      await fetchStatus();
    } catch (err: any) {
      toast("error", err.message || "Registration failed");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRecover = async () => {
    if (!recoverUsername) return;
    setActionLoading("recover");
    try {
      const res = await relay.recover(recoverUsername);
      toast("success", `Recovered account @${res.username}${res.connected ? " and connected" : ""}`);
      setRecoverUsername("");
      setShowRecover(false);
      await fetchStatus();
    } catch (err: any) {
      toast("error", err.message || "Recovery failed");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeregister = async () => {
    setActionLoading("deregister");
    try {
      await relay.deregister();
      toast("success", "Account deleted and registration cleared");
      setConfirmDeregister(false);
      await fetchStatus();
    } catch (err: any) {
      toast("error", err.message || "Deregister failed");
    } finally {
      setActionLoading(null);
    }
  };

  const handleUpdateConfig = async () => {
    setActionLoading("config");
    try {
      const res = await relay.updateConfig({ url: configUrl });
      if (res.restartRequired) {
        toast("warning", "Config saved. Restart Mercury for changes to take effect.");
      } else {
        toast("success", "Config saved");
      }
      await fetchStatus();
    } catch (err: any) {
      toast("error", err.message || "Failed to update config");
    } finally {
      setActionLoading(null);
    }
  };

  const handleToggleEnabled = async (enabled: boolean) => {
    setActionLoading("toggle");
    try {
      const res = await relay.updateConfig({ enabled });
      if (res.restartRequired) {
        toast("warning", `Relay ${enabled ? "enabled" : "disabled"}. Restart Mercury for changes to take effect.`);
      }
      await fetchStatus();
    } catch (err: any) {
      toast("error", err.message || "Failed to toggle relay");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" style={{ color: ACCENT }} />
      </div>
    );
  }

  const s = status!;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <ToastBar toasts={toasts} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Radio className="h-6 w-6" style={{ color: ACCENT }} />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Relay</h1>
            <p className="text-sm text-muted-foreground">
              Connect to the Mercury relay network for friend messaging and shared memory.
            </p>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={fetchStatus} disabled={!!actionLoading}>
          <RefreshCw className={cn("h-4 w-4", actionLoading && "animate-spin")} />
        </Button>
      </div>

      {/* Connection Status Card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Connection Status</CardTitle>
            <div className="flex items-center gap-2">
              {s.connected ? (
                <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                  <Wifi className="mr-1 h-3 w-3" /> Connected
                </Badge>
              ) : s.reconnecting ? (
                <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30">
                  <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> Reconnecting
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-muted text-muted-foreground">
                  <WifiOff className="mr-1 h-3 w-3" /> Disconnected
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Info grid */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Enabled</span>
              <div className="flex items-center gap-2 mt-1">
                <Switch
                  checked={s.enabled}
                  onCheckedChange={handleToggleEnabled}
                  disabled={!!actionLoading}
                />
                <span>{s.enabled ? "Yes" : "No"}</span>
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Registered</span>
              <p className="font-medium mt-1">{s.registered ? `@${s.username}` : "Not registered"}</p>
            </div>
            <div className="col-span-2">
              <span className="text-muted-foreground">Relay Server</span>
              <p className="font-mono text-xs mt-1 break-all">{s.url}</p>
            </div>
            {s.telegram && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Linked Telegram</span>
                <p className="font-medium mt-1">
                  {s.telegram.firstName || "Unknown"}
                  {s.telegram.username && <span className="text-muted-foreground ml-1">@{s.telegram.username}</span>}
                  <span className="text-muted-foreground/60 text-xs ml-2">ID: {s.telegram.userId}</span>
                </p>
              </div>
            )}
            {s.ownerName && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Owner</span>
                <p className="font-medium mt-1">{s.ownerName}</p>
              </div>
            )}
          </div>

          {/* Action buttons */}
          {s.registered && (
            <div className="flex gap-2 pt-2 border-t">
              {s.connected ? (
                <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={!!actionLoading}>
                  {actionLoading === "disconnect" ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Link2Off className="mr-2 h-3 w-3" />}
                  Disconnect
                </Button>
              ) : (
                <Button size="sm" onClick={handleConnect} disabled={!!actionLoading}
                  style={{ backgroundColor: ACCENT }}>
                  {actionLoading === "connect" ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Link2 className="mr-2 h-3 w-3" />}
                  Connect
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Registration Card — only if NOT registered */}
      {!s.registered && s.available && (
        <Card className="border-[#a855f7]/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <UserPlus className="h-5 w-5" style={{ color: ACCENT }} />
              Register
            </CardTitle>
            <CardDescription>Create a new relay account or recover an existing one.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!showRecover ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="reg-username">Username</Label>
                  <div className="relative">
                    <Input
                      id="reg-username"
                      placeholder="my_username"
                      value={regUsername}
                      onChange={(e) => setRegUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                      maxLength={20}
                      className={cn(
                        usernameAvailable === true && "border-emerald-500/50",
                        usernameAvailable === false && "border-destructive/50",
                      )}
                    />
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      {usernameChecking && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      {!usernameChecking && usernameAvailable === true && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
                      {!usernameChecking && usernameAvailable === false && <XCircle className="h-4 w-4 text-destructive" />}
                    </div>
                  </div>
                  {usernameError && <p className="text-xs text-destructive">{usernameError}</p>}
                  <p className="text-xs text-muted-foreground">3-20 chars, lowercase letters, numbers, underscores</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="reg-display">Display Name (optional)</Label>
                  <Input
                    id="reg-display"
                    placeholder={s.ownerName || s.telegram?.firstName || "My Display Name"}
                    value={regDisplayName}
                    onChange={(e) => setRegDisplayName(e.target.value)}
                    maxLength={50}
                  />
                  {(s.ownerName || s.telegram?.firstName) && !regDisplayName && (
                    <p className="text-xs text-muted-foreground">
                      Will use "{s.ownerName || s.telegram?.firstName}" if left empty
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Button onClick={handleRegister} disabled={!regUsername || usernameAvailable !== true || !!actionLoading}
                    style={{ backgroundColor: ACCENT }}>
                    {actionLoading === "register" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
                    Register
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setShowRecover(true)}>
                    Recover existing account
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="recover-username">Recovery Username</Label>
                  <Input
                    id="recover-username"
                    placeholder="your_existing_username"
                    value={recoverUsername}
                    onChange={(e) => setRecoverUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                    maxLength={20}
                  />
                  <p className="text-xs text-muted-foreground">Enter the username of your existing relay account to recover it on this device.</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button onClick={handleRecover} disabled={!recoverUsername || !!actionLoading}
                    style={{ backgroundColor: ACCENT }}>
                    {actionLoading === "recover" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Recover Account
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setShowRecover(false)}>
                    Back to registration
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Not available — relay disabled or no client */}
      {!s.available && (
        <Card className="border-amber-500/20">
          <CardContent className="flex items-center gap-3 py-6">
            <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0" />
            <div>
              <p className="text-sm font-medium">Relay client not initialised</p>
              <p className="text-xs text-muted-foreground">
                {s.enabled
                  ? "Relay is enabled but the client failed to initialise. Check the relay URL and restart Mercury."
                  : "Enable relay above and restart Mercury to use relay features."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Server Configuration */}
      <Card>
        <CardHeader className="pb-3 cursor-pointer" onClick={() => setShowConfig(!showConfig)}>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <Settings2 className="h-5 w-5 text-muted-foreground" />
              Server Configuration
            </CardTitle>
            <motion.div animate={{ rotate: showConfig ? 180 : 0 }} transition={{ duration: 0.2 }}>
              <Settings2 className="h-4 w-4 text-muted-foreground" />
            </motion.div>
          </div>
        </CardHeader>
        <AnimatePresence>
          {showConfig && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
              <CardContent className="space-y-4 pt-0">
                <div className="space-y-2">
                  <Label htmlFor="relay-url">Relay Server URL</Label>
                  <Input
                    id="relay-url"
                    value={configUrl}
                    onChange={(e) => setConfigUrl(e.target.value)}
                    placeholder="wss://relay.cosmicstack.org/v1/ws"
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Change requires a Mercury restart to take effect.
                  </p>
                </div>
                <Button size="sm" onClick={handleUpdateConfig} disabled={!!actionLoading || configUrl === s.url}>
                  {actionLoading === "config" ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
                  Save URL
                </Button>
              </CardContent>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      {/* Danger Zone — deregister */}
      {s.registered && (
        <Card className="border-destructive/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg text-destructive flex items-center gap-2">
              <Trash2 className="h-5 w-5" />
              Danger Zone
            </CardTitle>
            <CardDescription>
              Permanently delete your relay account and clear local registration.
              This removes all friend connections and cannot be undone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!confirmDeregister ? (
              <Button variant="destructive" size="sm" onClick={() => setConfirmDeregister(true)}>
                Delete Relay Account
              </Button>
            ) : (
              <div className="flex items-center gap-3">
                <p className="text-sm text-destructive">Are you sure? This cannot be undone.</p>
                <Button variant="destructive" size="sm" onClick={handleDeregister} disabled={!!actionLoading}>
                  {actionLoading === "deregister" ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
                  Yes, Delete
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDeregister(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
