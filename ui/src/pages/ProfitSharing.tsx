import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import {
  DollarSign,
  TrendingUp,
  Users,
  PieChart,
  Percent,
  BarChart3,
  Calculator,
  RefreshCcw,
  Target,
  ArrowUpRight,
  Banknote,
  Gem,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
    <div className={cn("animate-pulse rounded-lg bg-muted", className)} />
  );
}

interface ProjectionYear {
  year: number;
  revenue: number;
  profit: number;
  sharedPool: number;
  perParticipant: number;
  cumulativeRevenue: number;
  cumulativeProfit: number;
  cumulativeShared: number;
}

interface CalcParams {
  initialRevenue: number;
  growthRate: number;
  profitMargin: number;
  profitSharePct: number;
  participants: number;
  years: number;
  investment: number;
}

function calculateProjection(params: CalcParams): ProjectionYear[] {
  const {
    initialRevenue,
    growthRate,
    profitMargin,
    profitSharePct,
    participants,
    years,
  } = params;

  const results: ProjectionYear[] = [];
  let cumRevenue = 0;
  let cumProfit = 0;
  let cumShared = 0;

  for (let y = 1; y <= years; y++) {
    const revenue = initialRevenue * Math.pow(1 + growthRate / 100, y);
    const profit = revenue * (profitMargin / 100);
    const sharedPool = profit * (profitSharePct / 100);
    const perPerson = participants > 0 ? sharedPool / participants : 0;

    cumRevenue += revenue;
    cumProfit += profit;
    cumShared += sharedPool;

    results.push({
      year: y,
      revenue: Math.round(revenue),
      profit: Math.round(profit),
      sharedPool: Math.round(sharedPool),
      perParticipant: Math.round(perPerson),
      cumulativeRevenue: Math.round(cumRevenue),
      cumulativeProfit: Math.round(cumProfit),
      cumulativeShared: Math.round(cumShared),
    });
  }

  return results;
}

function formatCurrency(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toLocaleString()}`;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
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
      <Card className={cn("h-full", glow && "mercury-glow-sm")}>
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

function InputField({
  label,
  value,
  onChange,
  suffix,
  prefix,
  step,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  prefix?: string;
  step?: string;
  min?: number;
  max?: number;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            {prefix}
          </span>
        )}
        <Input
          type="number"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          step={step}
          min={min}
          max={max}
          className={cn(
            "h-9 text-sm tabular-nums",
            prefix && "pl-7",
            suffix && "pr-8"
          )}
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Horizontal Bar Chart Component ────────────────────────────

function HorizontalBarChart({
  data,
  maxValue,
  color = "from-cyan-500 to-cyan-400",
  format = formatCompact,
}: {
  data: { label: string; value: number }[];
  maxValue: number;
  color?: string;
  format?: (n: number) => string;
}) {
  const effectiveMax = maxValue || Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="space-y-3">
      {data.map((item) => {
        const pct = (item.value / effectiveMax) * 100;
        return (
          <div key={item.label} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{item.label}</span>
              <span className="font-medium tabular-nums">
                {format(item.value)}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <motion.div
                className={`h-full rounded-full bg-gradient-to-r ${color}`}
                initial={{ width: 0 }}
                animate={{ width: `${Math.max(pct, 2)}%` }}
                transition={{ duration: 0.6, ease: "easeOut" }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Vertical Bar for Year-over-Year ───────────────────────────

function YearBarChart({
  data,
  valueKey,
  label,
  color = "bg-cyan-500",
  format = formatCompact,
}: {
  data: ProjectionYear[];
  valueKey: keyof ProjectionYear;
  label: string;
  color?: string;
  format?: (n: number) => string;
}) {
  const values = data.map((d) => Number(d[valueKey]));
  const maxVal = Math.max(...values, 1);

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-1.5 h-32">
        {data.map((d) => {
          const val = Number(d[valueKey]);
          const pct = (val / maxVal) * 100;
          return (
            <div
              key={d.year}
              className="flex-1 flex flex-col items-center gap-1 h-full justify-end"
            >
              <motion.div
                className={`w-full rounded-t ${color} opacity-80 hover:opacity-100 transition-opacity`}
                initial={{ height: 0 }}
                animate={{ height: `${Math.max(pct, 4)}%` }}
                transition={{ duration: 0.5, ease: "easeOut" }}
                style={{ minHeight: pct > 0 ? "4px" : "0px" }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between px-0.5">
        {data.map((d) => (
          <span
            key={d.year}
            className="text-[10px] text-muted-foreground tabular-nums"
          >
            Y{d.year}
          </span>
        ))}
      </div>
      <div className="flex justify-between px-0.5">
        {data.map((d) => (
          <span
            key={d.year}
            className="text-[9px] text-muted-foreground/60 tabular-nums"
          >
            {format(Number(d[valueKey]))}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Presets ───────────────────────────────────────────────────

const PRESETS: { label: string; params: Partial<CalcParams> }[] = [
  {
    label: "Startup",
    params: {
      initialRevenue: 500000,
      growthRate: 80,
      profitMargin: 15,
      profitSharePct: 10,
      participants: 3,
      years: 5,
      investment: 2000000,
    },
  },
  {
    label: "Scale-up",
    params: {
      initialRevenue: 5000000,
      growthRate: 40,
      profitMargin: 25,
      profitSharePct: 8,
      participants: 10,
      years: 5,
      investment: 10000000,
    },
  },
  {
    label: "Enterprise",
    params: {
      initialRevenue: 50000000,
      growthRate: 15,
      profitMargin: 35,
      profitSharePct: 5,
      participants: 50,
      years: 5,
      investment: 50000000,
    },
  },
  {
    label: "SaaS",
    params: {
      initialRevenue: 2000000,
      growthRate: 60,
      profitMargin: 30,
      profitSharePct: 12,
      participants: 5,
      years: 5,
      investment: 5000000,
    },
  },
];

// ─── Main Page ─────────────────────────────────────────────────

export function ProfitSharingPage() {
  const [params, setParams] = useState<CalcParams>({
    initialRevenue: 1000000,
    growthRate: 30,
    profitMargin: 20,
    profitSharePct: 10,
    participants: 5,
    years: 5,
    investment: 3000000,
  });

  const projection = useMemo(() => calculateProjection(params), [params]);

  // Derived metrics
  const totalRevenue = projection[projection.length - 1]?.cumulativeRevenue ?? 0;
  const totalProfit = projection[projection.length - 1]?.cumulativeProfit ?? 0;
  const totalShared = projection[projection.length - 1]?.cumulativeShared ?? 0;
  const lastYear = projection[projection.length - 1];
  const finalYearRevenue = lastYear?.revenue ?? 0;
  const finalYearProfit = lastYear?.profit ?? 0;

  // ROI
  const netReturn = totalProfit - params.investment;
  const roiPct =
    params.investment > 0
      ? ((totalProfit - params.investment) / params.investment) * 100
      : 0;

  // Per participant total
  const perPersonTotal =
    params.participants > 0 ? totalShared / params.participants : 0;

  // Year-over-year growth of shared pool
  const sharedGrowthRate =
    projection.length >= 2
      ? ((projection[projection.length - 1].sharedPool -
          projection[0].sharedPool) /
          projection[0].sharedPool) *
        100
      : 0;

  const updateParam = (key: keyof CalcParams, value: number) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  };

  const applyPreset = (preset: (typeof PRESETS)[0]) => {
    setParams((prev) => ({ ...prev, ...preset.params }));
  };

  const resetDefaults = () => {
    setParams({
      initialRevenue: 1000000,
      growthRate: 30,
      profitMargin: 20,
      profitSharePct: 10,
      participants: 5,
      years: 5,
      investment: 3000000,
    });
  };

  return (
    <div className="space-y-6 p-6 lg:p-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Calculator className="h-6 w-6 text-cyan-500" />
              Profit-Sharing Calculator
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Model how growth and funding shape profitability and
              participant payouts
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={resetDefaults}>
            <RefreshCcw className="h-3.5 w-3.5 mr-1" />
            Reset
          </Button>
        </div>
      </motion.div>

      {/* Presets */}
      <motion.div
        custom={0}
        variants={fadeUp}
        initial="hidden"
        animate="visible"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-muted-foreground mr-1">
            Presets:
          </span>
          {PRESETS.map((preset) => (
            <Button
              key={preset.label}
              variant="secondary"
              size="sm"
              onClick={() => applyPreset(preset)}
              className="text-xs"
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </motion.div>

      {/* ══════════════════════════════════════════════════
         Input Section
         ══════════════════════════════════════════════════ */}
      <motion.div
        custom={1}
        variants={fadeUp}
        initial="hidden"
        animate="visible"
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-4 w-4" />
              Parameters
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <InputField
                label="Initial Annual Revenue"
                value={params.initialRevenue}
                onChange={(v) => updateParam("initialRevenue", v)}
                prefix="$"
                min={0}
              />
              <InputField
                label="Annual Growth Rate"
                value={params.growthRate}
                onChange={(v) => updateParam("growthRate", v)}
                suffix="%"
                min={0}
                max={1000}
                step="1"
              />
              <InputField
                label="Profit Margin"
                value={params.profitMargin}
                onChange={(v) => updateParam("profitMargin", v)}
                suffix="%"
                min={0}
                max={100}
                step="0.5"
              />
              <InputField
                label="Profit Share %"
                value={params.profitSharePct}
                onChange={(v) => updateParam("profitSharePct", v)}
                suffix="%"
                min={0}
                max={100}
                step="0.5"
              />
              <InputField
                label="Participants"
                value={params.participants}
                onChange={(v) => updateParam("participants", Math.max(1, v))}
                min={1}
              />
              <InputField
                label="Projection Period"
                value={params.years}
                onChange={(v) => updateParam("years", Math.max(1, Math.min(20, v)))}
                suffix="years"
                min={1}
                max={20}
              />
              <InputField
                label="Total Investment / Funding"
                value={params.investment}
                onChange={(v) => updateParam("investment", v)}
                prefix="$"
                min={0}
              />
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* ══════════════════════════════════════════════════
         Key Metrics
         ══════════════════════════════════════════════════ */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={TrendingUp}
          label="Total Revenue (Cumulative)"
          index={2}
          glow
        >
          <p className="text-2xl font-bold tabular-nums text-cyan-500">
            {formatCurrency(totalRevenue)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Year {params.years} final: {formatCurrency(finalYearRevenue)}
          </p>
        </StatCard>

        <StatCard icon={DollarSign} label="Total Profit" index={3}>
          <p className="text-2xl font-bold tabular-nums text-emerald-500">
            {formatCurrency(totalProfit)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Year {params.years} final: {formatCurrency(finalYearProfit)}
          </p>
        </StatCard>

        <StatCard icon={Users} label="Profit Share Pool" index={4}>
          <p className="text-2xl font-bold tabular-nums text-purple-500">
            {formatCurrency(totalShared)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {formatCurrency(perPersonTotal)} per participant
          </p>
        </StatCard>

        <StatCard icon={Target} label="ROI on Investment" index={5}>
          <p
            className={cn(
              "text-2xl font-bold tabular-nums",
              roiPct >= 0 ? "text-emerald-500" : "text-red-500"
            )}
          >
            {roiPct >= 0 ? "+" : ""}
            {roiPct.toFixed(1)}%
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Net return: {netReturn >= 0 ? "+" : ""}
            {formatCurrency(netReturn)}
          </p>
        </StatCard>
      </div>

      {/* ══════════════════════════════════════════════════
         Detailed Breakdown — Two Columns
         ══════════════════════════════════════════════════ */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Year Over Year Growth */}
        <motion.div
          custom={6}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
        >
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4" />
                Revenue & Profit Trajectory
              </CardTitle>
            </CardHeader>
            <CardContent>
              {projection.length > 0 ? (
                <div className="space-y-4">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">
                      Revenue (cyan) · Profit (emerald)
                    </p>
                    <div className="flex items-end gap-1.5 h-40">
                      {projection.map((d, i) => {
                        const revPct =
                          (d.revenue / Math.max(...projection.map((p) => p.revenue))) *
                          100;
                        const profPct =
                          (d.profit /
                            Math.max(...projection.map((p) => p.revenue))) *
                          100;
                        return (
                          <div
                            key={d.year}
                            className="flex-1 flex flex-col items-center gap-0.5 h-full justify-end"
                          >
                            <motion.div
                              className="w-full rounded-t bg-emerald-500/70"
                              initial={{ height: 0 }}
                              animate={{
                                height: `${Math.max(profPct, 2)}%`,
                              }}
                              transition={{
                                duration: 0.5,
                                delay: i * 0.05,
                                ease: "easeOut",
                              }}
                            />
                            <motion.div
                              className="w-full rounded-t bg-cyan-500/70"
                              initial={{ height: 0 }}
                              animate={{
                                height: `${Math.max(revPct - profPct, 2)}%`,
                              }}
                              transition={{
                                duration: 0.5,
                                delay: i * 0.05 + 0.1,
                                ease: "easeOut",
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between mt-1">
                      {projection.map((d) => (
                        <span
                          key={d.year}
                          className="text-[10px] text-muted-foreground tabular-nums"
                        >
                          Y{d.year}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Revenue Growth
                      </p>
                      <p className="text-sm font-semibold tabular-nums text-cyan-500">
                        +{params.growthRate}% CAGR
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Avg. Profit Margin
                      </p>
                      <p className="text-sm font-semibold tabular-nums text-emerald-500">
                        {params.profitMargin}%
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Adjust parameters to see projections.
                </p>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Profit Share Distribution */}
        <motion.div
          custom={7}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
        >
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <PieChart className="h-4 w-4" />
                Profit Share Distribution
              </CardTitle>
            </CardHeader>
            <CardContent>
              {projection.length > 0 && totalShared > 0 ? (
                <div className="space-y-4">
                  <HorizontalBarChart
                    data={[
                      {
                        label: "Total Profit",
                        value: totalProfit,
                      },
                      {
                        label: "Profit Share Pool",
                        value: totalShared,
                      },
                      {
                        label: `Per Participant (${params.participants} people)`,
                        value: perPersonTotal,
                      },
                      {
                        label: "Retained Earnings",
                        value: totalProfit - totalShared,
                      },
                    ]}
                    maxValue={totalProfit}
                    color="from-purple-500 to-purple-400"
                  />

                  <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Share of Profit Distributed
                      </p>
                      <p className="text-sm font-semibold tabular-nums text-purple-500">
                        {params.profitSharePct}%
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Shared Pool Growth (Y1→Y{params.years})
                      </p>
                      <p className="text-sm font-semibold tabular-nums text-purple-500">
                        +{sharedGrowthRate.toFixed(0)}%
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {params.profitSharePct === 0
                    ? "Profit share is set to 0%. Increase it to see distribution."
                    : "Adjust parameters to see distribution."}
                </p>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* ══════════════════════════════════════════════════
         Year-by-Year Table
         ══════════════════════════════════════════════════ */}
      <motion.div
        custom={8}
        variants={fadeUp}
        initial="hidden"
        animate="visible"
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-4 w-4" />
              Year-by-Year Projection
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="pb-3 pr-4 font-medium text-muted-foreground">
                    Year
                  </th>
                  <th className="pb-3 pr-4 font-medium text-muted-foreground text-right">
                    Revenue
                  </th>
                  <th className="pb-3 pr-4 font-medium text-muted-foreground text-right">
                    Profit
                  </th>
                  <th className="pb-3 pr-4 font-medium text-muted-foreground text-right">
                    Shared Pool
                  </th>
                  <th className="pb-3 pr-4 font-medium text-muted-foreground text-right">
                    Per Participant
                  </th>
                  <th className="pb-3 pr-2 font-medium text-muted-foreground text-right">
                    Margin %
                  </th>
                </tr>
              </thead>
              <tbody>
                {projection.map((row, idx) => (
                  <motion.tr
                    key={row.year}
                    className="border-b border-border/50 last:border-0"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{
                      delay: 0.2 + idx * 0.03,
                      duration: 0.2,
                    }}
                  >
                    <td className="py-2.5 pr-4 font-medium">Year {row.year}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums text-cyan-500">
                      {formatCurrency(row.revenue)}
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums text-emerald-500">
                      {formatCurrency(row.profit)}
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums text-purple-500">
                      {formatCurrency(row.sharedPool)}
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums font-medium">
                      {formatCurrency(row.perParticipant)}
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                      {row.revenue > 0
                        ? ((row.profit / row.revenue) * 100).toFixed(1)
                        : "0.0"}
                      %
                    </td>
                  </motion.tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-medium">
                  <td className="pt-3 pr-4">Total</td>
                  <td className="pt-3 pr-4 text-right tabular-nums text-cyan-500">
                    {formatCurrency(totalRevenue)}
                  </td>
                  <td className="pt-3 pr-4 text-right tabular-nums text-emerald-500">
                    {formatCurrency(totalProfit)}
                  </td>
                  <td className="pt-3 pr-4 text-right tabular-nums text-purple-500">
                    {formatCurrency(totalShared)}
                  </td>
                  <td className="pt-3 pr-4 text-right tabular-nums">
                    {formatCurrency(perPersonTotal)}
                  </td>
                  <td className="pt-3 text-right tabular-nums text-muted-foreground">
                    {totalRevenue > 0
                      ? ((totalProfit / totalRevenue) * 100).toFixed(1)
                      : "0.0"}
                    %
                  </td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      </motion.div>

      {/* ══════════════════════════════════════════════════
         Insights Section
         ══════════════════════════════════════════════════ */}
      <motion.div
        custom={9}
        variants={fadeUp}
        initial="hidden"
        animate="visible"
      >
        <Card className="border-cyan-500/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gem className="h-4 w-4 text-cyan-500" />
              Key Insights
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1 rounded-lg bg-muted/50 p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ArrowUpRight className="h-3 w-3" />
                  Revenue Multiple
                </div>
                <p className="text-lg font-bold tabular-nums">
                  {params.initialRevenue > 0
                    ? (finalYearRevenue / params.initialRevenue).toFixed(1)
                    : "—"}x
                </p>
                <p className="text-xs text-muted-foreground">
                  From {formatCurrency(params.initialRevenue)} →{" "}
                  {formatCurrency(finalYearRevenue)}
                </p>
              </div>

              <div className="space-y-1 rounded-lg bg-muted/50 p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Users className="h-3 w-3" />
                  Avg. Annual Payout
                </div>
                <p className="text-lg font-bold tabular-nums text-purple-500">
                  {params.years > 0
                    ? formatCurrency(perPersonTotal / params.years)
                    : "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Per participant per year
                </p>
              </div>

              <div className="space-y-1 rounded-lg bg-muted/50 p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Banknote className="h-3 w-3" />
                  Investment Efficiency
                </div>
                <p className="text-lg font-bold tabular-nums text-emerald-500">
                  {params.investment > 0
                    ? (totalRevenue / params.investment).toFixed(2)
                    : "—"}x
                </p>
                <p className="text-xs text-muted-foreground">
                  Revenue generated per $1 invested
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
