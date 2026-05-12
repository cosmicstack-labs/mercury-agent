import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, Eye, EyeOff, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import api, { type ProviderInfo, type ProviderTestResult } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

/* ── Per-provider local form state ── */
interface ProviderForm {
  apiKey: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  showKey: boolean;
  saving: boolean;
  testing: boolean;
  feedback: { type: "success" | "error"; message: string } | null;
  testResult: ProviderTestResult | null;
}

const emptyForm = (p: ProviderInfo): ProviderForm => ({
  apiKey: "",
  baseUrl: p.baseUrl,
  model: p.model,
  enabled: p.enabled,
  showKey: false,
  saving: false,
  testing: false,
  feedback: null,
  testResult: null,
});

/* ── Skeleton ── */
function ProviderSkeleton() {
  return (
    <Card className="border-border/50 bg-card/60 backdrop-blur">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 animate-pulse rounded-lg bg-muted" />
            <div className="h-5 w-28 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-5 w-9 animate-pulse rounded-full bg-muted" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-3.5 w-16 animate-pulse rounded bg-muted" />
            <div className="h-9 w-full animate-pulse rounded-md bg-muted" />
          </div>
        ))}
        <div className="flex gap-2 pt-2">
          <div className="h-9 w-20 animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-32 animate-pulse rounded-md bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

export function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [forms, setForms] = useState<Record<string, ProviderForm>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const feedbackTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const fetchProviders = useCallback(async () => {
    try {
      const data = await api.providers.list();
      setProviders(data);
      setForms((prev) => {
        const next: Record<string, ProviderForm> = {};
        for (const p of data) {
          next[p.name] = prev[p.name]
            ? { ...prev[p.name], enabled: p.enabled }
            : emptyForm(p);
        }
        return next;
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load providers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
    return () => {
      Object.values(feedbackTimers.current).forEach(clearTimeout);
    };
  }, [fetchProviders]);

  /* helpers */
  const updateForm = (name: string, patch: Partial<ProviderForm>) => {
    setForms((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));
  };

  const showFeedback = (
    name: string,
    type: "success" | "error",
    message: string
  ) => {
    if (feedbackTimers.current[name]) clearTimeout(feedbackTimers.current[name]);
    updateForm(name, { feedback: { type, message } });
    feedbackTimers.current[name] = setTimeout(() => {
      updateForm(name, { feedback: null });
    }, 4000);
  };

  const handleSave = async (name: string) => {
    const f = forms[name];
    if (!f) return;
    updateForm(name, { saving: true });
    try {
      await api.providers.update(name, {
        ...(f.apiKey ? { apiKey: f.apiKey } : {}),
        baseUrl: f.baseUrl,
        model: f.model,
        enabled: f.enabled,
      });
      showFeedback(name, "success", "Configuration saved");
      updateForm(name, { apiKey: "", saving: false });
      fetchProviders();
    } catch (e) {
      showFeedback(name, "error", e instanceof Error ? e.message : "Save failed");
      updateForm(name, { saving: false });
    }
  };

  const handleTest = async (name: string) => {
    updateForm(name, { testing: true, testResult: null });
    try {
      const result = await api.providers.test(name);
      updateForm(name, { testing: false, testResult: result });
      showFeedback(
        name,
        result.success ? "success" : "error",
        result.success ? "Connection successful" : "Connection failed"
      );
    } catch (e) {
      updateForm(name, { testing: false });
      showFeedback(name, "error", e instanceof Error ? e.message : "Test failed");
    }
  };

  const handleToggle = async (name: string, enabled: boolean) => {
    updateForm(name, { enabled });
    try {
      await api.providers.update(name, { enabled });
      fetchProviders();
    } catch (e) {
      showFeedback(name, "error", "Failed to toggle provider");
      updateForm(name, { enabled: !enabled });
    }
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#00d4ff]/20 to-[#a78bfa]/20 ring-1 ring-[#00d4ff]/30">
            <Cpu className="h-5 w-5 text-[#00d4ff]" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Providers</h1>
            <p className="text-sm text-muted-foreground">
              Configure your AI model providers
            </p>
          </div>
        </div>
      </div>

      {/* Error state */}
      {error && !loading && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-center gap-3 py-4">
            <XCircle className="h-5 w-5 text-destructive" />
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" className="ml-auto" onClick={fetchProviders}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Loading */}
      {loading && (
        <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <ProviderSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Provider Grid */}
      {!loading && providers.length > 0 && (
        <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2">
          <AnimatePresence mode="popLayout">
            {providers.map((provider, idx) => {
              const f = forms[provider.name];
              if (!f) return null;
              return (
                <motion.div
                  key={provider.name}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.3, delay: idx * 0.05 }}
                >
                  <Card
                    className={cn(
                      "border-border/50 bg-card/60 backdrop-blur transition-all duration-300",
                      f.enabled && "ring-1 ring-[#00d4ff]/20"
                    )}
                  >
                    <CardHeader className="pb-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div
                            className={cn(
                              "flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
                              f.enabled
                                ? "bg-gradient-to-br from-[#00d4ff]/20 to-[#a78bfa]/20"
                                : "bg-muted"
                            )}
                          >
                            <Cpu
                              className={cn(
                                "h-4.5 w-4.5 transition-colors",
                                f.enabled ? "text-[#00d4ff]" : "text-muted-foreground"
                              )}
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-base font-medium text-foreground">
                              {provider.name}
                            </span>
                            <Badge
                              variant={f.enabled ? "default" : "secondary"}
                              className={cn(
                                "text-[10px] px-1.5 py-0",
                                f.enabled &&
                                  "bg-[#00d4ff]/15 text-[#00d4ff] border-[#00d4ff]/30 hover:bg-[#00d4ff]/20"
                              )}
                            >
                              {f.enabled ? "Active" : "Disabled"}
                            </Badge>
                          </div>
                        </div>
                        <Switch
                          checked={f.enabled}
                          onCheckedChange={(val) => handleToggle(provider.name, val)}
                        />
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-4">
                      {/* API Key */}
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">
                          API Key
                        </label>
                        <div className="relative">
                          <Input
                            type={f.showKey ? "text" : "password"}
                            placeholder={provider.maskedKey || "Enter API key"}
                            value={f.apiKey}
                            onChange={(e) =>
                              updateForm(provider.name, { apiKey: e.target.value })
                            }
                            className="pr-9 bg-background/50"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              updateForm(provider.name, { showKey: !f.showKey })
                            }
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {f.showKey ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Base URL */}
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">
                          Base URL{" "}
                          <span className="text-muted-foreground/60">(optional)</span>
                        </label>
                        <Input
                          placeholder="https://api.openai.com/v1"
                          value={f.baseUrl}
                          onChange={(e) =>
                            updateForm(provider.name, { baseUrl: e.target.value })
                          }
                          className="bg-background/50"
                        />
                      </div>

                      {/* Model */}
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">
                          Model
                        </label>
                        <Input
                          placeholder="gpt-4o"
                          value={f.model}
                          onChange={(e) =>
                            updateForm(provider.name, { model: e.target.value })
                          }
                          className="bg-background/50"
                        />
                      </div>

                      {/* Feedback */}
                      <AnimatePresence>
                        {f.feedback && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            className="overflow-hidden"
                          >
                            <div
                              className={cn(
                                "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
                                f.feedback.type === "success"
                                  ? "bg-emerald-500/10 text-emerald-400"
                                  : "bg-destructive/10 text-destructive"
                              )}
                            >
                              {f.feedback.type === "success" ? (
                                <CheckCircle2 className="h-4 w-4 shrink-0" />
                              ) : (
                                <XCircle className="h-4 w-4 shrink-0" />
                              )}
                              {f.feedback.message}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      {/* Test result details */}
                      <AnimatePresence>
                        {f.testResult?.success && f.testResult.models && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="rounded-md border border-border/50 bg-background/30 p-3 space-y-2">
                              {f.testResult.recommendedModel && (
                                <p className="text-xs text-muted-foreground">
                                  Recommended:{" "}
                                  <span className="font-medium text-[#00d4ff]">
                                    {f.testResult.recommendedModel}
                                  </span>
                                </p>
                              )}
                              <div className="flex flex-wrap gap-1.5">
                                {f.testResult.models.slice(0, 12).map((m) => (
                                  <Badge
                                    key={m}
                                    variant="secondary"
                                    className="text-[10px] cursor-pointer hover:bg-[#00d4ff]/15 hover:text-[#00d4ff] transition-colors"
                                    onClick={() =>
                                      updateForm(provider.name, { model: m })
                                    }
                                  >
                                    {m}
                                  </Badge>
                                ))}
                                {f.testResult.models.length > 12 && (
                                  <Badge variant="secondary" className="text-[10px]">
                                    +{f.testResult.models.length - 12} more
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      {/* Actions */}
                      <div className="flex gap-2 pt-1">
                        <Button
                          size="sm"
                          onClick={() => handleSave(provider.name)}
                          disabled={f.saving}
                          className="bg-gradient-to-r from-[#00d4ff] to-[#a78bfa] text-white hover:opacity-90 transition-opacity"
                        >
                          {f.saving && (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          )}
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleTest(provider.name)}
                          disabled={f.testing}
                        >
                          {f.testing && (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          )}
                          Test Connection
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && providers.length === 0 && (
        <Card className="border-border/50 bg-card/60">
          <CardContent className="py-12 text-center">
            <Cpu className="mx-auto h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground">No providers configured yet.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
