import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  Zap,
  Brain,
  Cpu,
  Clock,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatUptime, formatTokens } from "@/lib/utils";
import api, { type AgentStatus } from "@/lib/api";

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
      className={cn(
        "animate-pulse rounded-lg bg-muted",
        className
      )}
    />
  );
}

function StatCard({
  icon: Icon,
  label,
  children,
  index,
  glow,
}: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
  index: number;
  glow?: boolean;
}) {
  return (
    <motion.div
      custom={index}
      variants={fadeUp}
      initial="hidden"
      animate="visible"
    >
      <Card className={cn(glow && "mercury-glow-sm")}>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {label}
          </CardTitle>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </motion.div>
  );
}

export function DashboardPage() {
  const [data, setData] = useState<AgentStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.status
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
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[120px]" />
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-[200px]" />
          <Skeleton className="h-[200px]" />
        </div>
      </div>
    );
  }

  const tokenPct = data.tokens.dailyBudget
    ? Math.min(
        Math.round((data.tokens.dailyUsed / data.tokens.dailyBudget) * 100),
        100
      )
    : 0;

  const providerEntries = Object.entries(data.providers);
  const activeProviders = providerEntries.filter(([, v]) => v.enabled).length;
  const memoryTypes = Object.entries(data.memory.byType);

  return (
    <div className="space-y-6 p-6 lg:p-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <h1 className="text-2xl font-bold tracking-tight">Status</h1>
        <p className="text-sm text-muted-foreground">
          Agent is{" "}
          <span
            className={cn(
              "font-medium",
              data.running ? "text-emerald-500" : "text-muted-foreground"
            )}
          >
            {data.state}
          </span>
        </p>
      </motion.div>

      {/* Hero Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Clock} label="Uptime" index={0} glow>
          <p className="text-2xl font-bold tabular-nums">
            {formatUptime(data.uptime)}
          </p>
        </StatCard>

        <StatCard icon={Zap} label="Tokens Used" index={1}>
          <p className="text-2xl font-bold tabular-nums">
            {formatTokens(data.tokens.dailyUsed)}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              / {formatTokens(data.tokens.dailyBudget)}
            </span>
          </p>
          <Progress value={tokenPct} className="mt-3" />
        </StatCard>

        <StatCard icon={Brain} label="Total Memories" index={2}>
          <p className="text-2xl font-bold tabular-nums">
            {data.memory.total.toLocaleString()}
          </p>
        </StatCard>

        <StatCard icon={Cpu} label="Active Providers" index={3}>
          <p className="text-2xl font-bold tabular-nums">
            {activeProviders}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              / {providerEntries.length}
            </span>
          </p>
        </StatCard>
      </div>

      {/* Detail Cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Memory by Type */}
        <motion.div
          custom={4}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
        >
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Brain className="h-4 w-4" />
                Memory by Type
              </CardTitle>
            </CardHeader>
            <CardContent>
              {memoryTypes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No memories stored yet.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {memoryTypes.map(([type, count]) => (
                    <div
                      key={type}
                      className="flex items-center justify-between"
                    >
                      <Badge variant="secondary" className="capitalize">
                        {type}
                      </Badge>
                      <span className="text-sm font-medium tabular-nums">
                        {count.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Provider Status */}
        <motion.div
          custom={5}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
        >
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="h-4 w-4" />
                Providers
              </CardTitle>
            </CardHeader>
            <CardContent>
              {providerEntries.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No providers configured.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {providerEntries.map(([name, info]) => (
                    <div
                      key={name}
                      className="flex items-center justify-between"
                    >
                      <span className="text-sm font-medium">{name}</span>
                      {info.enabled ? (
                        <Badge variant="success" className="gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          Enabled
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 text-muted-foreground">
                          <XCircle className="h-3 w-3" />
                          Disabled
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
