import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  BarChart3,
  Zap,
  TrendingDown,
  Activity,
  Globe,
  Terminal,
  MessageSquare,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn, formatDate, formatTokens } from "@/lib/utils";
import api, { type UsageData } from "@/lib/api";

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.07, duration: 0.35, ease: "easeOut" as const },
  }),
};

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-lg bg-muted", className)}
    />
  );
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: "#10b981",
  anthropic: "#f59e0b",
  google: "#3b82f6",
  groq: "#ef4444",
  ollama: "#8b5cf6",
  openrouter: "#ec4899",
};

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  web: Globe,
  telegram: MessageSquare,
  cli: Terminal,
};

function getProviderColor(provider: string): string {
  return PROVIDER_COLORS[provider.toLowerCase()] ?? "#6b7280";
}

function getChannelIcon(channel: string): React.ElementType {
  return CHANNEL_ICONS[channel.toLowerCase()] ?? Activity;
}

export function UsagePage() {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.usage
      .get()
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6 p-6 lg:p-8">
        <div className="space-y-1">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[130px]" />
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-[240px]" />
          <Skeleton className="h-[240px]" />
        </div>
        <Skeleton className="h-[320px]" />
      </div>
    );
  }

  const budgetPct = data.dailyBudget
    ? Math.min(Math.round((data.dailyUsed / data.dailyBudget) * 100), 100)
    : 0;

  const providerEntries = Object.entries(data.byProvider);
  const providerTotal = providerEntries.reduce((s, [, v]) => s + v, 0) || 1;

  const channelEntries = Object.entries(data.byChannel);
  const channelTotal = channelEntries.reduce((s, [, v]) => s + v, 0) || 1;

  return (
    <div className="space-y-6 p-6 lg:p-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <h1 className="text-2xl font-bold tracking-tight">Usage</h1>
        <p className="text-sm text-muted-foreground">
          Token consumption and budget tracking
        </p>
      </motion.div>

      {/* Hero Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Daily Used / Budget */}
        <motion.div custom={0} variants={fadeUp} initial="hidden" animate="visible">
          <Card className="mercury-glow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Daily Used / Budget
              </CardTitle>
              <Zap className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold tabular-nums">
                {formatTokens(data.dailyUsed)}
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  / {formatTokens(data.dailyBudget)}
                </span>
              </p>
              <Progress value={budgetPct} className="mt-3" />
              <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
                {budgetPct}% consumed
              </p>
            </CardContent>
          </Card>
        </motion.div>

        {/* Remaining */}
        <motion.div custom={1} variants={fadeUp} initial="hidden" animate="visible">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Remaining
              </CardTitle>
              <TrendingDown className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold tabular-nums">
                {formatTokens(data.remaining)}
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                tokens left today
              </p>
            </CardContent>
          </Card>
        </motion.div>

        {/* Total Requests */}
        <motion.div custom={2} variants={fadeUp} initial="hidden" animate="visible">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Requests
              </CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold tabular-nums">
                {data.requestLog.length.toLocaleString()}
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                requests today
              </p>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Breakdown Section */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* By Provider */}
        <motion.div custom={3} variants={fadeUp} initial="hidden" animate="visible">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3 className="h-4 w-4" />
                Usage by Provider
              </CardTitle>
            </CardHeader>
            <CardContent>
              {providerEntries.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No provider usage recorded yet.
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  {providerEntries
                    .sort(([, a], [, b]) => b - a)
                    .map(([provider, tokens]) => {
                      const pct = Math.round((tokens / providerTotal) * 100);
                      const color = getProviderColor(provider);
                      return (
                        <div key={provider} className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Badge variant="secondary" className="capitalize">
                              {provider}
                            </Badge>
                            <span className="text-sm font-medium tabular-nums text-muted-foreground">
                              {formatTokens(tokens)}{" "}
                              <span className="text-xs">({pct}%)</span>
                            </span>
                          </div>
                          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                            <motion.div
                              className="h-full rounded-full"
                              style={{ backgroundColor: color }}
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ duration: 0.6, ease: "easeOut", delay: 0.3 }}
                            />
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* By Channel */}
        <motion.div custom={4} variants={fadeUp} initial="hidden" animate="visible">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Globe className="h-4 w-4" />
                Usage by Channel
              </CardTitle>
            </CardHeader>
            <CardContent>
              {channelEntries.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No channel usage recorded yet.
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  {channelEntries
                    .sort(([, a], [, b]) => b - a)
                    .map(([channel, tokens], idx) => {
                      const pct = Math.round((tokens / channelTotal) * 100);
                      const ChannelIcon = getChannelIcon(channel);
                      const colors = ["#00d4ff", "#8b5cf6", "#f59e0b", "#10b981"];
                      const color = colors[idx % colors.length];
                      return (
                        <div key={channel} className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <ChannelIcon className="h-3.5 w-3.5 text-muted-foreground" />
                              <Badge variant="secondary" className="capitalize">
                                {channel}
                              </Badge>
                            </div>
                            <span className="text-sm font-medium tabular-nums text-muted-foreground">
                              {formatTokens(tokens)}{" "}
                              <span className="text-xs">({pct}%)</span>
                            </span>
                          </div>
                          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                            <motion.div
                              className="h-full rounded-full"
                              style={{ backgroundColor: color }}
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ duration: 0.6, ease: "easeOut", delay: 0.35 }}
                            />
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Request Log */}
      <motion.div custom={5} variants={fadeUp} initial="hidden" animate="visible">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4" />
              Request Log
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.requestLog.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No requests recorded yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="pb-3 pr-4 font-medium text-muted-foreground">
                        Time
                      </th>
                      <th className="pb-3 pr-4 font-medium text-muted-foreground">
                        Provider
                      </th>
                      <th className="pb-3 text-right font-medium text-muted-foreground">
                        Tokens
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.requestLog
                      .slice()
                      .reverse()
                      .slice(0, 50)
                      .map((entry, idx) => (
                        <motion.tr
                          key={`${entry.timestamp}-${idx}`}
                          className="border-b border-border/50 last:border-0"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: 0.4 + idx * 0.02, duration: 0.2 }}
                        >
                          <td className="py-2.5 pr-4 tabular-nums text-muted-foreground">
                            {formatDate(entry.timestamp)}
                          </td>
                          <td className="py-2.5 pr-4">
                            <Badge variant="outline" className="capitalize">
                              {entry.provider}
                            </Badge>
                          </td>
                          <td className="py-2.5 text-right font-medium tabular-nums">
                            {formatTokens(entry.totalTokens)}
                          </td>
                        </motion.tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
