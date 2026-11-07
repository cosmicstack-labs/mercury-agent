import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Plug, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import api, { type McpServer, type McpTool } from "@/lib/api";

const STATE_STYLES: Record<McpServer["state"], string> = {
  connected: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500",
  connecting: "border-sky-500/30 bg-sky-500/10 text-sky-500",
  reconnecting: "border-amber-500/30 bg-amber-500/10 text-amber-500",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  disabled: "border-border bg-muted text-muted-foreground",
};

function toolState(tool: McpTool): { label: string; className: string } {
  if (tool.skipped) return { label: "skipped", className: "text-amber-500" };
  if (!tool.allowed) return { label: "hidden", className: "text-muted-foreground" };
  if (tool.autoApprove) return { label: "auto-approve", className: "text-emerald-500" };
  return { label: "asks first", className: "text-foreground" };
}

export function McpPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api.mcp
      .list()
      .then((res) => {
        setServers(res.servers);
        setError("");
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex flex-wrap items-start justify-between gap-4"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight">MCP Servers</h1>
          <p className="text-sm text-muted-foreground">
            Read-only. Add or change servers with <code className="font-mono">mercury mcp</code> in a terminal.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </motion.div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!loading && !error && servers.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Plug className="mb-4 h-10 w-10 text-muted-foreground/50" />
            <p className="text-lg font-medium text-muted-foreground">No MCP servers configured</p>
            <p className="mt-1 text-sm text-muted-foreground/70">
              Add one with <code className="font-mono">mercury mcp add</code>, then allow the tools you want.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-4">
        {servers.map((server) => (
          <Card key={server.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
              <div className="min-w-0 space-y-1">
                <CardTitle className="text-base">{server.id}</CardTitle>
                <p className="truncate text-xs text-muted-foreground">
                  {server.transport} · {server.target || "unknown target"}
                </p>
              </div>
              <Badge variant="outline" className={cn("shrink-0 capitalize", STATE_STYLES[server.state])}>
                {server.state}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              {server.error && <p className="break-words text-sm text-destructive">{server.error}</p>}
              {server.tools.length > 0 ? (
                <ul className="divide-y divide-border rounded-md border text-sm">
                  {server.tools.map((tool) => {
                    const state = toolState(tool);
                    return (
                      <li key={tool.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                          <span className="break-all font-mono text-xs">{tool.name}</span>
                          {tool.skipped && <p className="text-xs text-muted-foreground">{tool.skipped}</p>}
                        </div>
                        <span className={cn("text-xs font-medium", state.className)}>{state.label}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {server.state === "connected"
                    ? "This server reports no tools."
                    : "Tools appear once the server is connected."}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
