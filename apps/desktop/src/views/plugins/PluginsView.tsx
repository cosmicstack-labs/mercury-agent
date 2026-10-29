import { AlertTriangle, ArrowUpCircle, FolderOpen, Plug, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "~/api/mercury";
import type { McpServer, PluginItem } from "~/api/types";
import { useUi } from "~/app/store";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Badge, Mono, Segmented, Spinner } from "~/components/ui/bits";
import { IconTile, SearchField } from "~/components/ui/kit";
import { cx } from "~/lib/cx";
import { CatalogDetail, PluginDetail, StatusDot } from "./PluginDetail";
import { SetupFlow } from "./SetupFlow";

/**
 * Plugins, as a manager: the list on the left (yours, the catalog to
 * discover, MCP servers), the chosen one on the right. Installing goes
 * straight into the plugin's own setup; every setting, account, version
 * and removal lives on its page. A plain dot says on (green) or off (grey).
 */

type Tab = "installed" | "discover" | "mcp";
type Pane = { kind: "plugin"; id: string } | { kind: "catalog"; id: string } | { kind: "setup"; id: string } | { kind: "mcp"; id: string } | { kind: "source" } | null;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The one line under a plugin's name: what matters most about it right now. */
function rowLine(p: PluginItem): { text: string; tone: "amber" | "cyan" | "muted" } {
  if (p.lastError || p.status === "error") return { text: p.lastError ?? "Stopped with an error", tone: "amber" };
  if (p.status === "incompatible") return { text: p.incompatibleReason ?? "Not compatible", tone: "amber" };
  if (p.status === "update-available") return { text: `Update to ${p.latestVersion}`, tone: "cyan" };
  if (p.enabled && (p.missing ?? []).length > 0) return { text: `${p.missing!.length} thing${p.missing!.length === 1 ? "" : "s"} to set up`, tone: "amber" };
  if (p.channel && p.channel.type !== "desktop" && p.enabled && p.channel.state !== "connected") return { text: "Account not linked", tone: "amber" };
  if (p.channel?.account) return { text: `Linked · ${p.channel.account}`, tone: "muted" };
  return { text: p.enabled ? `${p.tools.length} tool${p.tools.length === 1 ? "" : "s"}` : "Off", tone: "muted" };
}

export function PluginsView() {
  const [tab, setTab] = useState<Tab>("installed");
  const [items, setItems] = useState<PluginItem[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [mcpAvailable, setMcpAvailable] = useState(true);
  const [safeMode, setSafeMode] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [pane, setPane] = useState<Pane>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    try {
      const res = await api.plugins.list(refresh);
      setItems(res.items);
      setSafeMode(res.safeMode);
      setCatalogError(res.catalogError ?? null);
    } catch (err) {
      setNote({ text: errorText(err), ok: false });
    }
    try {
      const m = await api.mcp.list();
      setServers(m.servers);
      setMcpAvailable(m.available);
    } catch {
      setMcpAvailable(false);
    }
    setLoaded(true);
    setRefreshing(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const yours = items.filter((p) => !!p.installedVersion);
  const catalog = items.filter((p) => !p.installedVersion);
  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || q.split(/\s+/).every((w) => s.toLowerCase().includes(w));
  const list = useMemo(() => (tab === "installed" ? yours : tab === "discover" ? catalog : []).filter((p) => match(`${p.name} ${p.id} ${p.description} ${p.tools.join(" ")}`)), [tab, items, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const mcpShown = servers.filter((s) => match(`${s.id} ${s.target}`));
  const updates = yours.filter((p) => p.status === "update-available").length;

  // Settings → Channels sends WhatsApp here.
  const focus = useUi((st) => st.pluginFocus);
  const clearFocus = useUi((st) => st.clearPluginFocus);
  useEffect(() => {
    if (!focus || !loaded) return;
    if (yours.some((x) => x.id === focus)) { setTab("installed"); setPane({ kind: "plugin", id: focus }); }
    else if (catalog.some((x) => x.id === focus)) { setTab("discover"); setPane({ kind: "catalog", id: focus }); }
    clearFocus();
  }, [focus, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Something sensible on the right once the list is in.
  useEffect(() => {
    if (!loaded || pane) return;
    const first = yours[0] ?? catalog[0];
    if (first) { setTab(yours[0] ? "installed" : "discover"); setPane(yours[0] ? { kind: "plugin", id: first.id } : { kind: "catalog", id: first.id }); }
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  async function install(source: string, opts: { fromCatalog: boolean }) {
    setInstalling(source);
    setNote(null);
    try {
      const r = await api.plugins.install(source, { enable: true });
      await load();
      setTab("installed");
      setPane({ kind: "setup", id: r.id });
      setNote({ text: r.unchanged ? `${r.name} ${r.version} was already installed.` : `Installed ${r.name} ${r.version}${opts.fromCatalog ? "" : ". It isn't from the catalog, so it hasn't been checked"}.`, ok: true });
    } catch (e) {
      setNote({ text: errorText(e), ok: false });
    } finally {
      setInstalling(null);
    }
  }

  const switchTab = (t: Tab) => {
    setTab(t);
    setNote(null);
    const first = t === "installed" ? yours[0] : t === "discover" ? catalog[0] : undefined;
    setPane(t === "mcp" ? (servers[0] ? { kind: "mcp", id: servers[0].id } : null) : first ? (t === "installed" ? { kind: "plugin", id: first.id } : { kind: "catalog", id: first.id }) : null);
  };

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[330px] shrink-0 flex-col border-r border-line bg-soft">
        <div className="flex h-[52px] shrink-0 items-center gap-2 px-4" data-tauri-drag-region>
          <span className="flex-1 text-base font-semibold text-ink" data-tauri-drag-region>Plugins</span>
          {safeMode && <Badge tone="amber">safe mode</Badge>}
          <Button variant="ghost" size="sm" icon onClick={() => void load(true)} loading={refreshing} aria-label="Refresh the catalog" title="Refresh the catalog"><RefreshCw size={14} /></Button>
        </div>
        <div className="flex flex-col gap-2 px-3 pb-2">
          <Segmented value={tab} onChange={switchTab} options={[
            { value: "installed", label: `Yours · ${yours.length}` },
            { value: "discover", label: `Discover · ${catalog.length}` },
            { value: "mcp", label: `MCP · ${servers.length}` },
          ]} />
          <SearchField value={query} onChange={setQuery} placeholder={tab === "discover" ? "Search the catalog" : tab === "mcp" ? "Search servers" : "Search your plugins"} />
          {tab === "installed" && updates > 0 && <span className="flex items-center gap-1.5 px-1 text-xs text-cyan"><ArrowUpCircle size={12} /> {updates} update{updates === 1 ? "" : "s"} available</span>}
          {tab === "discover" && catalogError && <span className="flex items-start gap-1.5 px-1 text-xs text-amber"><AlertTriangle size={12} className="mt-0.5 shrink-0" /> Catalog unreachable: {catalogError}</span>}
          {safeMode && <span className="px-1 text-xs text-amber">Safe mode: every plugin is off until Mercury restarts normally.</span>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {!loaded && <div className="p-4"><Spinner size={14} /></div>}
          {loaded && tab !== "mcp" && list.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-ink4">
              {q ? "Nothing matches." : tab === "installed" ? "No plugins yet. Find some in Discover." : "Nothing new in the catalog."}
            </p>
          )}
          {tab !== "mcp" && list.map((p) => {
            const selected = !!pane && (pane.kind === "plugin" || pane.kind === "catalog" || pane.kind === "setup") && pane.id === p.id;
            const line = tab === "installed" ? rowLine(p) : { text: p.description, tone: "muted" as const };
            return (
              <button key={p.id} onClick={() => { setNote(null); setPane(tab === "installed" ? { kind: "plugin", id: p.id } : { kind: "catalog", id: p.id }); }}
                className={cx("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left", selected ? "bg-ink/[0.07]" : "hover:bg-ink/[0.04]")} aria-current={selected ? "true" : undefined}>
                <IconTile id={p.id} label={p.name} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-ink">{p.name}</span>
                    {tab === "discover" && p.tier === "official" && <Badge tone="accent">official</Badge>}
                  </span>
                  <span className={cx("block truncate text-xs", line.tone === "amber" ? "text-amber" : line.tone === "cyan" ? "text-cyan" : "text-ink3")}>{line.text}</span>
                </span>
                {tab === "installed" && <StatusDot on={p.enabled} />}
                {tab === "discover" && installing === p.id && <Spinner size={12} />}
              </button>
            );
          })}
          {tab === "mcp" && !mcpAvailable && <p className="px-3 py-6 text-center text-sm text-ink4">MCP isn't available on this Mercury.</p>}
          {tab === "mcp" && mcpAvailable && mcpShown.length === 0 && <p className="px-3 py-6 text-center text-sm text-ink4">{q ? "Nothing matches." : "No MCP servers."}</p>}
          {tab === "mcp" && mcpShown.map((s) => (
            <button key={s.id} onClick={() => setPane({ kind: "mcp", id: s.id })}
              className={cx("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left", pane?.kind === "mcp" && pane.id === s.id ? "bg-ink/[0.07]" : "hover:bg-ink/[0.04]")}>
              <IconTile id={s.id} label={s.id} size={32} />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{s.id}</span><span className="block truncate font-mono text-xs text-ink3">{s.target}</span></span>
              <StatusDot on={s.state === "connected"} />
            </button>
          ))}
        </div>
        {tab === "installed" && (
          <div className="border-t border-line p-2">
            <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => { setNote(null); setPane({ kind: "source" }); }}><FolderOpen size={13} /> Install from a file or link…</Button>
          </div>
        )}
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {note && (
          <div className={cx("mx-6 mt-4 rounded-lg border px-3 py-2 text-sm", note.ok ? "border-accent/30 bg-accent/[0.05] text-ink2" : "border-red/30 bg-red/[0.05] text-red")}>
            {note.text}{!note.ok && /from this machine|loopback/i.test(note.text) ? " Plugins can only be changed on the computer Mercury runs on." : ""}
          </div>
        )}
        {pane?.kind === "plugin" && <PluginDetail key={pane.id} id={pane.id} onSetup={() => setPane({ kind: "setup", id: pane.id })} onChanged={() => void load()} onRemoved={() => { setNote({ text: "Removed.", ok: true }); setPane(null); void load(); }} />}
        {pane?.kind === "setup" && <div className="h-full"><SetupFlow key={pane.id} id={pane.id} onClose={() => setPane({ kind: "plugin", id: pane.id })} onChanged={() => void load()} /></div>}
        {pane?.kind === "catalog" && (() => {
          const p = items.find((x) => x.id === pane.id);
          return p ? <CatalogDetail p={p} installing={installing === p.id} onInstall={() => void install(p.id, { fromCatalog: true })} /> : null;
        })()}
        {pane?.kind === "mcp" && (() => {
          const s = servers.find((x) => x.id === pane.id);
          return s ? <McpDetail s={s} /> : null;
        })()}
        {pane?.kind === "source" && <SourceInstall installing={installing !== null} onInstall={(src) => void install(src, { fromCatalog: false })} />}
        {!pane && loaded && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <Plug size={26} className="text-ink4" />
            <p className="max-w-[360px] text-sm text-ink3">{yours.length ? "Pick a plugin to see and change everything about it." : "Plugins add abilities to Mercury: chat apps, your computer, tools. Find one in Discover."}</p>
            {!yours.length && <Button variant="primary" onClick={() => switchTab("discover")}>Discover plugins</Button>}
          </div>
        )}
      </main>
    </div>
  );
}

/** Install a plugin that isn't in the catalog: a folder, a .tgz, a URL or github:owner/repo. */
function SourceInstall({ installing, onInstall }: { installing: boolean; onInstall: (src: string) => void }) {
  const [src, setSrc] = useState("");
  const [trust, setTrust] = useState(false);
  return (
    <div className="mx-auto flex max-w-[560px] flex-col gap-4 px-6 py-8">
      <div><h2 className="text-lg font-semibold text-ink">Install from a file or link</h2><p className="text-sm text-ink3">A plugin folder or .tgz on the computer Mercury runs on, an https:// link to a .tgz, or github:owner/repo.</p></div>
      <Input value={src} onChange={(e) => setSrc(e.target.value)} placeholder="/path/to/plugin.tgz or github:owner/repo" mono autoFocus />
      <div className="flex items-start gap-2.5 rounded-lg border border-amber/40 bg-amber/[0.05] p-3 text-sm text-ink2">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber" />
        <span>This isn't from Mercury's catalog, so it hasn't been checked. A plugin can run code with your permissions. Only install ones from people you trust.</span>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink2"><input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} /> I trust where this comes from</label>
      <div><Button variant="primary" loading={installing} disabled={!src.trim() || !trust} onClick={() => onInstall(src.trim())}>Install and set up</Button></div>
    </div>
  );
}

function McpDetail({ s }: { s: McpServer }) {
  const allowed = s.tools.filter((t) => t.allowed !== false);
  return (
    <div className="flex flex-col gap-5 px-6 py-6">
      <div className="flex items-start gap-4">
        <IconTile id={s.id} label={s.id} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><h2 className="text-lg font-semibold text-ink">{s.id}</h2><Badge>{s.transport}</Badge><Badge tone={s.state === "connected" ? "accent" : s.state === "failed" ? "red" : "neutral"}>{s.state}</Badge></div>
          <Mono className="mt-1 block break-all text-sm">{s.target}</Mono>
          {s.error && <p className="mt-1 text-sm text-red">{s.error}</p>}
        </div>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-ink">{allowed.length} of {s.toolCount} tools allowed</h3>
        <div className="mt-2 flex flex-wrap gap-1.5">{s.tools.map((t) => <span key={t.name} className={cx("rounded-md border px-2 py-0.5 font-mono text-xs", t.allowed === false ? "border-line text-ink4 line-through" : "border-line text-ink2")}>{t.name}</span>)}</div>
      </div>
      <p className="text-xs text-ink4">Add, remove or change MCP servers with <code className="font-mono">mercury mcp</code> on the computer Mercury runs on.</p>
    </div>
  );
}
